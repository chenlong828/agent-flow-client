export type GatewayErrorCode =
  | "unsupported_protocol"
  | "unauthorized"
  | "task_not_found"
  | "run_not_found"
  | "package_not_found"
  | "session_log_missing"
  | "invalid_state"
  | "invalid_archive"
  | "validation_error"
  | "payload_too_large"
  | "unreachable"
  | "timeout"
  | "protocol_error";

const RETRYABLE: readonly GatewayErrorCode[] = ["unreachable", "timeout"];

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number | null;

  constructor(code: GatewayErrorCode, message: string, options: { status?: number } = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = options.status ?? null;
  }

  get retryable(): boolean {
    return RETRYABLE.includes(this.code);
  }

  /** 凭据失效或协议不匹配：停止领取并退出（非 0）。 */
  get terminal(): boolean {
    return this.code === "unauthorized" || this.code === "unsupported_protocol";
  }

  /** 需要先补传日志再重试结果（`P-02` 前置未满足）。 */
  get logMissing(): boolean {
    return this.code === "session_log_missing";
  }
}

const STATUS_TO_CODE: Record<number, GatewayErrorCode> = {
  400: "validation_error",
  401: "unauthorized",
  404: "task_not_found",
  413: "payload_too_large",
  500: "unreachable",
  503: "unreachable",
};

const ENVELOPE_TO_CODE: Record<string, GatewayErrorCode> = {
  unsupported_protocol: "unsupported_protocol",
  unauthorized: "unauthorized",
  task_not_found: "task_not_found",
  run_not_found: "run_not_found",
  package_not_found: "package_not_found",
  session_log_missing: "session_log_missing",
  invalid_state: "invalid_state",
  invalid_archive: "invalid_archive",
  validation_error: "validation_error",
  payload_too_large: "payload_too_large",
  internal: "unreachable",
  service_unavailable: "unreachable",
};

/** HTTP 状态 + 错误信封 → 端口错误码（v2 只有 6 个 HTTP 码）。 */
export function mapHttpError(status: number, body: unknown, path: string): GatewayError {
  const envelope = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const envelopeCode = typeof envelope?.code === "string" ? envelope.code : undefined;
  const code =
    (envelopeCode === undefined ? undefined : ENVELOPE_TO_CODE[envelopeCode]) ??
    (status === 404 && path.includes("/skill-packages/") ? "package_not_found" : undefined) ??
    (status === 400 ? "unsupported_protocol" : STATUS_TO_CODE[status]) ??
    "unreachable";
  const message =
    typeof envelope?.message === "string" && envelope.message !== "" ? envelope.message : `调度器返回 HTTP ${status}`;
  return new GatewayError(code, message, { status });
}

/** 传输层失败（连接/DNS/TLS/解析/超时）归一为稳定端口错误。 */
export function transportError(error: unknown, timedOut: boolean): GatewayError {
  if (error instanceof GatewayError) return error;
  if (timedOut) return new GatewayError("timeout", "请求超时");
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") return new GatewayError("timeout", "请求超时");
  return new GatewayError("unreachable", `调度器不可达：${(error as Error).message}`);
}
