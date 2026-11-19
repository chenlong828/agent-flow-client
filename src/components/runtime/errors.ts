export type RuntimeErrorCode =
  | "spawn_failed"
  | "protocol_error"
  | "prompt_failed"
  | "cancelled"
  | "timeout"
  | "process_exited"
  | "permission_denied";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  /** JSON-RPC 错误的 `error.data`（`session/new` 挂载失败的真实原因在 `data.details`）。 */
  readonly data?: unknown;

  constructor(code: RuntimeErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.data = data;
  }
}
