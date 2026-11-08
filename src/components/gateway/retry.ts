import { GatewayError } from "./errors.ts";

export type RetryOptions = {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  retryOn?: (error: GatewayError) => boolean;
};

const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 退避重试：只重试 `unreachable`/`timeout`/`rate_limited`；4xx 不重试（契约 §4.5）。 */
export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 250;
  const maxMs = options.maxMs ?? 5000;
  const sleep = options.sleep ?? DEFAULT_SLEEP;

  let lastError: GatewayError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted === true) throw new GatewayError("timeout", "重试被取消");
    try {
      return await operation(attempt);
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError("unreachable", (error as Error).message);
      lastError = gatewayError;
      const retryable = options.retryOn === undefined ? gatewayError.retryable : options.retryOn(gatewayError);
      if (!retryable || attempt === maxAttempts) throw gatewayError;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jitter = backoff * (Math.random() * (options.jitterRatio ?? 0.2));
      await sleep(Math.max(0, gatewayError.retryAfterMs ?? backoff + jitter));
    }
  }
  throw lastError ?? new GatewayError("unreachable", "重试失败");
}
