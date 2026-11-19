import type { SessionOutcome } from "./ports.ts";

export function cancelledOutcome(sessionId: string): SessionOutcome {
  return {
    sessionId,
    finalText: "",
    stopReason: null,
    usage: null,
    error: { code: "cancelled", message: "任务被取消", class: "cancelled" },
  };
}

export function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "internal_error";
}

/** L1 自己的稳定错误：码进入 `TaskResult.error.code`，由 `CMP-result` 映射为 class。 */
export class ExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
  }
}
