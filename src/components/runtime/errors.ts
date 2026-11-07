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

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}
