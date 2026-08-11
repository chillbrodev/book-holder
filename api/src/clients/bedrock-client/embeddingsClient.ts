/**
 * Titan Text Embeddings V2, through Bedrock's `InvokeModel`.
 *
 * Not Converse. Converse is a *chat* API — it takes messages and returns
 * messages, and an embedding model has neither. `InvokeModel` is the only way
 * to reach Titan, which is why this sits beside `bedrockClient.ts` rather than
 * inside it: they share a vendor and nothing else.
 *
 * ## The two numbers that must not drift
 *
 * **1024 dimensions.** `lines.embedding` and `mistake_log.embedding` are
 * `VECTOR(1024)` (migration 004), which is Titan **V2**'s default. Migration
 * 004 exists partly to move them off `VECTOR(1536)` — Titan **G1**'s width.
 * The column and the model must agree exactly or every insert fails, so the
 * dimension is requested explicitly here rather than left to the model's
 * default, and asserted on the way out.
 *
 * **`normalize: true`**, Titan V2's default, kept deliberately. Embedding
 * models are trained for *cosine* distance, which compares only the angle
 * between two vectors. Normalizing makes every vector unit-length, and for unit
 * vectors L2 and cosine rank identically — so the stored vectors are correct
 * under whichever operator the query uses, and switching operators later cannot
 * silently degrade results.
 *
 * `docs/OPEN_ITEMS.md` §2 called normalization load-bearing on the grounds that
 * L2 was the only distance CockroachDB offered. That is no longer true —
 * verified against the live v26.2.5 cluster, `<->` (L2), `<=>` (cosine) and
 * `<#>` (inner product) all evaluate. Normalizing is still right, but it is now
 * belt and braces rather than the one thing holding the design up.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { ConfigClient } from "../config-client/configClient.ts";

/** Must equal `VECTOR(1024)` in migration 004. */
export const EMBEDDING_DIMENSION = 1024;

let client: BedrockRuntimeClient | undefined;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({
      region: ConfigClient.Aws.region,
      // Closer to PollyClient's warming setup than to the live comparison call:
      // embedding runs as a bulk backfill over a whole play, where being
      // throttled is expected and a retried beat costs nothing extra. The live
      // path (embedding one mistake as it is written) is a single call and is
      // well served by the same ladder.
      retryMode: "adaptive",
      maxAttempts: 6,
      requestHandler: { requestTimeout: 15_000 },
    });
  }
  return client;
}

export const EmbeddingsClient = {
  /**
   * Embed one piece of text. Returns a unit-length 1024-vector.
   *
   * One call per text because Titan V2's `InvokeModel` body takes a single
   * `inputText` — there is no batch form. Callers that need many should run
   * these concurrently with a bounded pool rather than looking for a batch API
   * that does not exist.
   */
  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error("Refusing to embed empty text");
    }

    const response = await getClient().send(
      new InvokeModelCommand({
        modelId: ConfigClient.Bedrock.embeddingModelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          inputText: trimmed,
          dimensions: EMBEDDING_DIMENSION,
          normalize: true,
        }),
      }),
    );

    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      embedding?: number[];
      inputTextTokenCount?: number;
    };

    const embedding = parsed.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("Titan returned no embedding array");
    }
    // Checked rather than trusted: a model swap or a changed default would
    // otherwise surface as a Postgres type error on insert, hundreds of rows
    // into a backfill, naming neither the model nor the dimension.
    if (embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSION} dimensions, got ${embedding.length} — ` +
          `model and VECTOR() column have drifted apart`,
      );
    }

    return embedding;
  },

  /**
   * CockroachDB's `VECTOR` literal form: `[0.1,0.2,...]`.
   *
   * A plain array parameter arrives as a Postgres array and is rejected — the
   * cast target is a vector, and the two are not interchangeable. Passing the
   * string and casting with `$n::VECTOR` is what works.
   */
  toVectorLiteral(embedding: number[]): string {
    return `[${embedding.join(",")}]`;
  },
};
