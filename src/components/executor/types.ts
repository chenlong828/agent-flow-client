/**
 * CMP-executor 值类型（executor-http-v2 §5）。
 * 端口接口在 `ports.ts`，调度器端口在 `scheduler-port.ts`。
 */

export type TaskId = string;
export type InstanceId = string;
export type NodeId = string;
export type SessionId = string;

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

export type SkillPackage = {
  packageId: string;
  name: string;
  version: string;
  digest: string;
  sizeBytes: number;
  downloadUrl: string;
  etag?: string;
};

export type SkillSet = {
  digest: string;
  packages: SkillPackage[];
};

export type TaskRequest = {
  taskId: TaskId;
  instanceId: InstanceId;
  nodeId: NodeId;
  attempt: number;
  prompt: string;
  workspacePath: string;
  timeoutMs: number;
  skillSet: SkillSet;
};

export type RunningTask = {
  taskId: TaskId;
  instanceId: InstanceId;
  startedAt: string;
  lastEventAt?: string;
};

export type FinishedTask = {
  taskId: TaskId;
  attempt: number;
  finishedAt: string;
};

export type PollRequest = {
  capacity: { free: number };
  running: RunningTask[];
  finished: FinishedTask[];
};

export type PollResponse = {
  tasks: TaskRequest[];
  stop: boolean;
  cancelInstances: InstanceId[];
  nextPollAfterMs: number;
};

export type ResultAck = {
  taskId: TaskId;
  accepted: boolean;
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
