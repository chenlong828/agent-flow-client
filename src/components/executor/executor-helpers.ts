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
