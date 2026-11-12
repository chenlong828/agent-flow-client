import type { RuntimeFailure, SessionOutcome } from "../executor/ports.ts";
import type { ErrorClass, ResultStatus, TaskError, TaskResult } from "../executor/types.ts";

export type ResultContext = {
  taskId: string;
  attempt: number;
  maxResultBytes: number;
  startedAt?: string;
  finishedAt?: string;
};

export type ErrorMapping = {
  class: ErrorClass;
  code: string;
};

export type TruncatedText = { text: string; truncated: boolean };

export const TRUNCATION_MARKER = "\n…[truncated]";

type MappingRule = { codes: readonly string[]; class: ErrorClass };

const MAPPING: readonly MappingRule[] = [
  { codes: ["not_prepared", "layout_invalid", "path_escape", "permission_denied", "disk_full"], class: "workspace" },
  { codes: ["download_failed", "checksum_mismatch", "unpack_failed", "invalid_skill_format", "io_error", "package_not_found"], class: "asset" },
  { codes: ["spawn_failed", "process_exited", "prompt_failed", "session_log_too_large"], class: "runtime" },
  { codes: ["protocol_error"], class: "protocol" },
  { codes: ["cancelled"], class: "cancelled" },
  { codes: ["timeout", "prompt_timeout", "idle_timeout"], class: "timeout" },
  { codes: ["unsupported_protocol", "unauthorized", "task_not_found", "payload_too_large"], class: "scheduler" },
  { codes: ["internal_error"], class: "internal" },
];

/** 组件稳定错误码 → ErrorClass；未知错误归 internal（CMP-result）。 */
export function classify(error: RuntimeFailure | { code: string; message: string }): ErrorMapping {
  for (const rule of MAPPING) {
    if (rule.codes.includes(error.code)) return { class: rule.class, code: error.code };
  }
  return { class: "internal", code: error.code };
}

/** 按 UTF-8 字节截断；含标记的总字节数不超过 maxBytes。 */
export function truncate(text: string, maxBytes: number): TruncatedText {
  if (maxBytes < 0) throw new RangeError("maxBytes 不能为负");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (maxBytes < markerBytes) return { text: "", truncated: true };
  let budget = maxBytes - markerBytes;
  let out = "";
  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (bytes > budget) break;
    out += char;
    budget -= bytes;
  }
  return { text: `${out}${TRUNCATION_MARKER}`, truncated: true };
}

/** ACP 停止原因归一；未知值原样保留。 */
export function mapStopReason(raw: string | null): { value: string | null; unknown: boolean } {
  if (raw === null) return { value: null, unknown: false };
  const known = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"];
  return { value: raw, unknown: !known.includes(raw) };
}

/** 从 SessionOutcome 组装 TaskResult；纯函数，不抛业务异常。 */
export function assemble(outcome: SessionOutcome, ctx: ResultContext): TaskResult {
  const status = statusOf(outcome);
  const truncated = truncate(outcome.finalText, ctx.maxResultBytes);
  const error = outcome.error === undefined ? null : toTaskError(outcome.error);
  return {
    taskId: ctx.taskId,
    attempt: ctx.attempt,
    status,
    ...(outcome.sessionId === "" ? {} : { sessionId: outcome.sessionId }),
    message: truncated.text,
    truncated: truncated.truncated,
    stopReason: status === "succeeded" ? mapStopReason(outcome.stopReason).value : null,
    usage: outcome.usage ?? null,
    error,
    ...(ctx.startedAt === undefined ? {} : { startedAt: ctx.startedAt }),
    ...(ctx.finishedAt === undefined ? {} : { finishedAt: ctx.finishedAt }),
  };
}

function statusOf(outcome: SessionOutcome): ResultStatus {
  if (outcome.error === undefined) return "succeeded";
  if (outcome.error.class === "cancelled") return "cancelled";
  if (outcome.error.class === "timeout") return "timeout";
  return "failed";
}

function toTaskError(error: RuntimeFailure): TaskError {
  const mapping = classify(error);
  return { class: mapping.class, code: mapping.code, message: error.message };
}
