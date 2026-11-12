import type { SkillSet } from "./contract-types.ts";

/**
 * CMP-executor 值类型（executor-http-v2 §5）。
 * 端口接口在 `ports.ts`，调度器端口在 `scheduler-port.ts`。
 */

export type TaskId = string;
export type InstanceId = string;
export type NodeId = string;
export type SessionId = string;

export type {
  ArchiveAck,
  ArchiveRequest,
  FinishedTask,
  PollRequest,
  PollResponse,
  ResultAck,
  RunningTask,
  SessionLogAck,
  SkillPackage,
  SkillSet,
  StoredStatus,
} from "./contract-types.ts";

/** 本地状态：received → running → settled（结果落盘） → reported（已 accepted）。 */
export type TaskState = "received" | "running" | "settled" | "reported";

export type ResultStatus = "succeeded" | "failed" | "cancelled" | "timeout";

export type ErrorClass =
  | "workspace"
  | "asset"
  | "runtime"
  | "protocol"
  | "cancelled"
  | "timeout"
  | "scheduler"
  | "internal";

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type TaskError = {
  class: ErrorClass;
  code: string;
  message: string;
};

export type TaskResult = {
  taskId: TaskId;
  attempt: number;
  status: ResultStatus;
  sessionId?: SessionId;
  message: string;
  truncated: boolean;
  stopReason: string | null;
  usage: Usage | null;
  error: TaskError | null;
  startedAt?: string;
  finishedAt?: string;
};

export type TaskRequest = {
  taskId: TaskId;
  instanceId: InstanceId;
  nodeId: NodeId;
  attempt: number;
  prompt: string;
  workspacePath: string;
  taskSpacePath: string;
  timeoutMs: number;
  skillSet: SkillSet;
};

export type TaskRecord = {
  v: 2;
  ts: string;
  taskId: TaskId;
  attempt: number;
  instanceId: InstanceId;
  nodeId: NodeId;
  state: TaskState;
  sessionId?: SessionId;
  result?: TaskResult;
};

export type OrphanRecord = {
  pid: number;
  pgid?: number;
  instanceId: InstanceId;
  taskId?: TaskId;
  createdAt: string;
  host: string;
};
