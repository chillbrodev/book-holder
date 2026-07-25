import type { JSONObject } from "hono/utils/types";

export type BaseErrorOptions = {
  cause?: unknown;
  context?: JSONObject;
  statusCode?: number;
  skipReporting?: boolean;
};

export class BaseError<T extends string> extends Error {
  override name: T;
  public override readonly cause?: unknown;
  public readonly context?: JSONObject;
  private readonly _statusCode?: number;
  public nameToErrorCodeLookup: Map<T, number> = new Map();
  public defaultStatusCode = 500;
  public readonly skipReporting: boolean = false;

  constructor(name: T, message: string, options: BaseErrorOptions = {}) {
    super(message, options);
    this.name = name;

    this.cause = options.cause;
    this.context = options.context;
    this._statusCode = options.statusCode;
    this.skipReporting = options.skipReporting ?? false;
  }

  public get statusCode(): number {
    return this._statusCode ?? this.nameToErrorCodeLookup.get(this.name) ??
      this.defaultStatusCode;
  }
}

export function isBaseError(err: unknown): err is BaseError<string> {
  return err instanceof BaseError;
}

export function baseErrorToResponse<T extends string>(
  error: BaseError<T>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        name: error.name,
        msg: error.message,
      },
    }),
    {
      status: error.statusCode,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}
