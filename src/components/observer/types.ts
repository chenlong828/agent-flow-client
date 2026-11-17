import type { TaskResult } from "../executor/types.ts";

export const OBSERVABILITY_VERSION = "2026-11-17.1";

export type AttemptStatus = "running" | "interrupted" | "completed" | "failed" | "cancelled" | "timeout";
export type AttemptPhase = "claimed" | "bound" | "ready" | "running" | "settled" | "reported" | "closed";
export type ArchiveStatus = "pending" | "stored" | "partial" | "failed" | "not_applicable";
export type ObservationKind = "phase" | "log" | "acp" | "result";

/** O-02/O-03 的 attempt 摘要；attemptId 由 client 生成（UUIDv7）。 */
export type AttemptSummary = {
  attemptId: string;
  instanceId: string;
  nodeId: string;
  runId?: string;
  taskId: string;
  attemptNo: number;
  status: AttemptStatus;
  phase: AttemptPhase;
  sessionId?: string;
  cwd?: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorClass: string | null;
  logCount: number;
  truncatedBefore?: number;
  goneAt?: string;
  archiveStatus: ArchiveStatus;
  archive?: AttemptArchive;
};

export type AttemptArchive = {
  status: ArchiveStatus;
  sizeBytes: number | null;
  sha256: string | null;
  sourceFile?: string;
};

export type AttemptDetail = {
  attempt: AttemptSummary;
  session: SessionSummary | null;
  logRange: { firstSeq: number; lastSeq: number };
};

export type SessionSummary = {
  sessionId: string;
  attemptId: string;
  instanceId: string;
  nodeId: string;
  runId?: string;
  cwd: string;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  eventCount: number;
  archive: {
    status: ArchiveStatus;
    sizeBytes: number | null;
    sha256: string | null;
    downloadUrl: string | null;
  };
};

/** O-04/O-05/O-07 的规范化事件：preview，不含 prompt/推理/工具完整 I/O。 */
export type ObservationEvent = {
  seq: number;
  ts: string;
  attemptId: string;
  instanceId: string;
  nodeId: string;
  runId?: string;
  sessionId?: string;
  kind: ObservationKind;
  phase?: AttemptPhase;
  level?: "debug" | "info" | "warn" | "error";
  event: string;
  message?: string;
  data?: Record<string, unknown>;
  truncated?: boolean;
};

export type ObservationEventInput = Omit<ObservationEvent, "seq" | "ts" | "attemptId" | "instanceId" | "nodeId"> & {
  ts?: string;
};

/** O-11 的富事件：只在内存 ring 中保留，不落盘。 */
export type SessionRichEventKind =
  | "lifecycle"
  | "prompt"
  | "message"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "permission"
  | "config"
  | "other";

export type SessionRichEvent = {
  seq: number;
  ts: string;
  sessionId: string;
  kind: SessionRichEventKind;
  messageId?: string;
  toolCallId?: string;
  lifecycle?: "session.started" | "prompt.result" | "session.closed";
  acpType?: string;
  text?: string;
  tool?: {
    name: string;
    status: "in_progress" | "completed" | "failed";
    input?: unknown;
    output?: string;
    durationMs?: number;
  };
  usage?: { used: number; size: number };
  permission?: {
    tool?: { name?: string; inputSummary?: string };
    options: { kind: string; name: string }[];
    decision?: "allow" | "reject";
  };
  stopReason?: string;
  error?: { class?: string; code: string; message: string };
  data?: Record<string, unknown>;
  truncated?: boolean;
  originalBytes?: number;
};

export type SessionRichEventInput = Omit<SessionRichEvent, "seq" | "ts" | "sessionId"> & { ts?: string };
