import type {
  ErrorClass,
  NodeError,
  NodeResult,
  ResultStatus,
  RuntimeFailure,
  SessionOutcome,
} from "../executor/ports.ts";

export type ResultContext = {
  attemptId: string;
  maxResultBytes: number;
  startedAt?: string;
  finishedAt?: string;
};

export type ErrorMapping = {
  class: ErrorClass;
  code: string;
  retryable: boolean;
};

export type TruncatedText = { text: string; truncated: boolean };

export const TRUNCATION_MARKER = "\n…[truncated]";

type MappingRule = { codes: readonly string[]; class: ErrorClass; retryable: boolean };

const MAPPING: readonly MappingRule[] = [
  { codes: ["not_prepared", "layout_invalid", "path_escape", "permission_denied", "disk_full", "locked"], class: "workspace", retryable: false },
  { codes: ["download_failed", "checksum_mismatch", "unpack_failed"], class: "asset", retryable: true },
  { codes: ["invalid_skill_format", "asset_skill_set_conflict", "io_error"], class: "asset", retryable: false },
  { codes: ["spawn_failed", "process_exited", "prompt_failed"], class: "runtime", retryable: true },
  { codes: ["protocol_error"], class: "protocol", retryable: false },
  { codes: ["cancelled"], class: "cancelled", retryable: false },
  { codes: ["timeout"], class: "timeout", retryable: true },
  { codes: ["unreachable", "rate_limited"], class: "scheduler", retryable: true },
  { codes: ["unauthorized", "version_incompatible", "invalid_request", "lease_expired", "invalid_session", "run_superseded", "stale_attempt"], class: "scheduler", retryable: false },
  { codes: ["corrupt"], class: "internal", retryable: false },
  { codes: ["internal_error"], class: "internal", retryable: true },
];

/** 组件稳定错误码 → ErrorClass + retryable；未知错误归 internal（CMP-result §2.2）。 */
export function classify(error: RuntimeFailure | { code: string; message: string }): ErrorMapping {
  for (const rule of MAPPING) {
    if (rule.codes.includes(error.code)) return { class: rule.class, code: error.code, retryable: rule.retryable };
  }
  return { class: "internal", code: error.code, retryable: false };
}

/** 按 UTF-8 字节截断；含标记的总字节数不超过 maxBytes（CMP-result §2.3）。 */
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

/** ACP 停止原因归一；未知值原样保留（`unknown=true`）。 */
export function mapStopReason(raw: string | null): { value: string | null; unknown: boolean } {
  if (raw === null) return { value: null, unknown: false };
  const known = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"];
  return { value: raw, unknown: !known.includes(raw) };
}

/** 从 SessionOutcome 组装 NodeResult；纯函数，不抛业务异常（CMP-result §3.1）。 */
export function assemble(outcome: SessionOutcome, ctx: ResultContext): NodeResult {
  const status = statusOf(outcome);
  const truncated = truncate(outcome.finalText, ctx.maxResultBytes);
  const error = outcome.error === undefined ? null : toNodeError(outcome.error);
  return {
    attemptId: ctx.attemptId,
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

function toNodeError(error: RuntimeFailure): NodeError {
  const mapping = classify(error);
  return {
    class: mapping.class,
    code: mapping.code,
    message: error.message,
    retryable: mapping.retryable,
  };
}
