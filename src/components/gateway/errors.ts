export type GatewayErrorCode =
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "version_incompatible"
  | "lease_expired"
  | "rate_limited"
  | "invalid_request"
  | "stale_attempt"
  | "late_result"
  | "invalid_session"
  | "run_superseded";

const RETRYABLE: readonly GatewayErrorCode[] = ["unreachable", "timeout", "rate_limited"];

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number | null;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: GatewayErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = options.status ?? null;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE.includes(this.code);
  }

  /** 鉴权或版本不兼容：停止领取并由 CLI 退出 3。 */
  get terminalAuthFailure(): boolean {
    return this.code === "unauthorized" || this.code === "version_incompatible";
  }
}

const STATUS_TO_CODE: Record<number, GatewayErrorCode> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "unauthorized",
  404: "stale_attempt",
  413: "invalid_request",
  426: "version_incompatible",
  429: "rate_limited",
  500: "unreachable",
  503: "unreachable",
};

const CODE_TO_PORT: Record<string, GatewayErrorCode> = {
  validation_error: "invalid_request",
  unauthorized: "unauthorized",
  forbidden: "unauthorized",
  attempt_not_found: "stale_attempt",
  stale_attempt: "stale_attempt",
  invalid_session: "invalid_session",
  lease_expired: "lease_expired",
  late_result: "late_result",
  run_superseded: "run_superseded",
  payload_too_large: "invalid_request",
  version_incompatible: "version_incompatible",
  rate_limited: "rate_limited",
  internal: "unreachable",
  service_unavailable: "unreachable",
};

/** 解析 `Retry-After`（秒或 HTTP-date），返回毫秒。 */
function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** HTTP 状态 + 错误信封 → 端口错误码；HTTP/SDK 类型不出现在端口之外（契约 §4.4）。 */
export function mapHttpError(status: number, body: unknown, headers: Headers): GatewayError {
  const envelope = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  const envelopeCode = typeof envelope?.code === "string" ? envelope.code : undefined;
  const code = (envelopeCode !== undefined ? CODE_TO_PORT[envelopeCode] : undefined) ?? STATUS_TO_CODE[status] ?? "unreachable";
  const message =
    typeof envelope?.message === "string" && envelope.message !== ""
      ? envelope.message
      : `调度器返回 HTTP ${status}`;
  return new GatewayError(code, message, {
    status,
    ...(envelope?.details !== undefined && typeof envelope.details === "object" && envelope.details !== null
      ? { details: envelope.details as Record<string, unknown> }
      : {}),
    ...(parseRetryAfter(headers) === undefined ? {} : { retryAfterMs: parseRetryAfter(headers) }),
  });
}

/** 传输层失败（连接/DNS/TLS/解析/超时）归一为稳定端口错误。 */
export function transportError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") return new GatewayError("timeout", "请求超时");
  return new GatewayError("unreachable", `调度器不可达：${(error as Error).message}`);
}
