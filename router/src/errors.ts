import type { Alias } from "../../shared/contracts.ts";

export class RouterError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly alias?: Alias;
  readonly retryAfterMs?: number;
  /**
   * Which rule the caller broke, when the code alone does not say. Every
   * rejection looked the same from the app, a bare "The turn failed.", while
   * the one line naming the real reason went to the router log where nobody
   * was reading it. A local app on the loopback is the only caller.
   */
  readonly detail?: string;
  /**
   * The upstream's own refusal, for the router log only: provider, model,
   * status and the provider's error type, code and message, capped, with
   * key-like runs masked. A provider can quote part of the request in its
   * message, so this stays in the local log and is never sent to a caller.
   */
  readonly upstream?: string;

  constructor(input: {
    status: number;
    type: string;
    code: string;
    message: string;
    retryable?: boolean;
    alias?: Alias;
    retryAfterMs?: number;
    detail?: string;
    upstream?: string;
  }) {
    super(input.message);
    this.status = input.status;
    this.type = input.type;
    this.code = input.code;
    this.retryable = input.retryable === true;
    this.alias = input.alias;
    this.retryAfterMs = input.retryAfterMs;
    this.detail = input.detail;
    this.upstream = input.upstream;
  }
}

export function errorBody(err: RouterError, requestId: string) {
  return {
    error: {
      type: err.type,
      code: err.code,
      message: err.message,
      request_id: requestId,
      alias: err.alias,
      retryable: err.retryable,
      ...(err.retryAfterMs !== undefined ? { retry_after_ms: err.retryAfterMs } : {}),
      ...(err.detail ? { detail: err.detail } : {}),
    },
  };
}
