import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";

/**
 * The JSON-schema document a tool's input schema accepts.
 *
 * Pulled off `ToolInputSchema` rather than imported: the underlying type is
 * `@smithy/types`' `DocumentType`, which `client-bedrock-runtime` uses but does
 * not re-export, and adding a direct dependency on a transitive package to name
 * one type would be a worse trade than this line.
 */
type ToolJsonSchema = Extract<ToolInputSchema, { json: unknown }>["json"];
import { ConfigClient } from "../config-client/configClient.ts";

/**
 * Bedrock, via the **Converse** API on the `bedrock-runtime` endpoint.
 *
 * Not `bedrock-mantle`, even though AWS recommends it for some models: mantle's
 * documented auth is a long-term Bedrock API key
 * (`AWS_BEARER_TOKEN_BEDROCK`/`OPENAI_API_KEY`). That is a static credential
 * that would have to be minted, stored in Secrets Manager, and rotated by hand
 * — a step down from what this service already has, where the ECS task role
 * supplies credentials that nothing persists. `bedrock-runtime` goes through
 * the SDK's default provider chain exactly like PollyClient and S3Client, so
 * the same code path works locally (env keys from create-dev-user.sh) and
 * deployed (task role), with no new secret in either place.
 *
 * Converse rather than InvokeModel because Converse normalizes the request and
 * response shape across vendors. Nova and Kimi take different raw bodies under
 * InvokeModel; under Converse they take the same one, so swapping the model id
 * stays a config change instead of a rewrite.
 */

let client: BedrockRuntimeClient | undefined;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({
      region: ConfigClient.Aws.region,
      // Deliberately NOT PollyClient's `adaptive`/8-attempt setup. That exists
      // for cache warming, where being throttled is the expected steady state
      // and a block that takes six tries still costs one synthesis. This call
      // sits inside a live rehearsal: she says a beat and the next one is
      // seconds behind it, so a long backoff ladder is worse than a fast
      // failure that BE_PLAN §8's fuzzy-match fallback can cover.
      retryMode: "standard",
      maxAttempts: 2,
      // BE_PLAN §7 asks for request timeouts on every Bedrock/Polly/Transcribe
      // call. Without one the SDK will wait on a hung socket far past the point
      // where the answer is still useful to someone mid-scene.
      requestHandler: { requestTimeout: 8000 },
    });
  }
  return client;
}

/** What a Converse call cost, for the budget tracking BE_PLAN §7 wants. */
export interface ConverseUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ConverseJsonResult<T> {
  value: T;
  usage: ConverseUsage;
  /** True when the model answered in prose and the JSON had to be scraped out
   * of the text rather than arriving as a tool call. Worth logging: it means
   * the forced tool call didn't take, and the parse is doing more work than it
   * should be. */
  recoveredFromText: boolean;
}

/**
 * Ask a model for one JSON object matching `schema`.
 *
 * Uses a single-tool `toolConfig` rather than Bedrock's structured-outputs
 * feature, because **Nova Micro and Nova Lite do not support structured
 * outputs** — both model cards list it explicitly under "Not Supported" — while
 * client-side tool calling is supported on both. A forced call to a tool whose
 * input schema *is* the response schema is the way to get a guaranteed shape
 * out of Nova.
 *
 * The text fallback is not defensive padding. Forced `toolChoice` support
 * varies by model and is not stated on Nova's card either way; if a model
 * ignores the forcing and replies in prose, scraping the JSON out is far better
 * than failing a beat mid-scene. If `recoveredFromText` ever comes back true in
 * practice, that's the signal to revisit the toolChoice shape — not to widen
 * the parser.
 */
export const BedrockClient = {
  async converseJson<T>(input: {
    modelId: string;
    system: string;
    userMessage: string;
    toolName: string;
    toolDescription: string;
    schema: ToolJsonSchema;
    maxTokens: number;
    /** Scoring wants the same verdict for the same delivery. Comparison callers
     * should leave this at 0; a coaching note can afford to be warmer. */
    temperature?: number;
    /** Marks the system prompt as a prompt-cache checkpoint. Nova supports
     * caching on `system` and `messages` with a 5-minute TTL and a 1K-token
     * minimum, which fits the per-beat call exactly: the rubric is identical
     * for every beat in a scene and beats land seconds apart. Below 1K tokens
     * the checkpoint is ignored, so this is opt-in per caller rather than
     * always-on. */
    cacheSystemPrompt?: boolean;
  }): Promise<ConverseJsonResult<T>> {
    const tool: Tool = {
      toolSpec: {
        name: input.toolName,
        description: input.toolDescription,
        inputSchema: { json: input.schema },
      },
    };

    const system: SystemContentBlock[] = [{ text: input.system }];
    if (input.cacheSystemPrompt) {
      system.push({ cachePoint: { type: "default" } });
    }

    const messages: Message[] = [
      { role: "user", content: [{ text: input.userMessage }] },
    ];

    const response = await getClient().send(
      new ConverseCommand({
        modelId: input.modelId,
        system,
        messages,
        inferenceConfig: {
          maxTokens: input.maxTokens,
          temperature: input.temperature ?? 0,
        },
        toolConfig: {
          tools: [tool],
          toolChoice: { tool: { name: input.toolName } },
        },
      }),
    );

    const usage: ConverseUsage = {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
    const content = response.output?.message?.content ?? [];

    const toolUse = content.find((block) => block.toolUse)?.toolUse;
    if (toolUse?.input) {
      return { value: toolUse.input as T, usage, recoveredFromText: false };
    }

    const text = content.map((block) => block.text ?? "").join("").trim();
    const recovered = parseJsonFromText<T>(text);
    if (recovered === undefined) {
      throw new Error(
        `Bedrock returned neither a ${input.toolName} tool call nor parseable JSON: ${
          text.slice(0, 200)
        }`,
      );
    }
    return { value: recovered, usage, recoveredFromText: true };
  },
};

/**
 * Pull a JSON object out of a prose reply.
 *
 * Handles the two shapes a model actually produces when it answers in text: a
 * bare object, or one inside a ``` fence with or without a language tag. Takes
 * the outermost braces rather than the first `{` to the first `}` so a nested
 * object doesn't truncate the parse.
 */
function parseJsonFromText<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
