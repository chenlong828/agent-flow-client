/**
 * CMP-executor 值类型（字段权威见契约 §6）。端口接口在 `ports.ts`。
 *
 * 字段级权威见 docs/design/contracts/executor-http-v1.md §6；本文件只落 client
 * 侧需要的领域类型，不扩展契约字段。
 */

export type AttemptId = string;
export type InstanceId = string;
export type NodeId = string;
export type SessionId = string;

export type AttemptState =
  | "claimed"
  | "bound"
  | "ready"
  | "running"
  | "settled"
  | "reported"
  | "closed"
  | "abandoned";

export type ResultStatus = "succeeded" | "failed" | "cancelled" | "timeout";

export type ErrorClass =
  | "workspace"
  | "asset"
  | "runtime"
  | "timeout"
  | "cancelled"
  | "protocol"
  | "scheduler"
  | "internal";

export type CancelReason =
  | "user_cancel"
  | "paused"
  | "shutdown"
  | "lease_expired"
  | "superseded"
  | "signal"
  | "prompt_timeout";

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type NodeError = {
  class: ErrorClass;
  code: string;
  message: string;
  retryable: boolean;
  reason?: CancelReason;
};

export type NodeResult = {
  attemptId: AttemptId;
  status: ResultStatus;
  sessionId?: SessionId;
  message: string;
  truncated: boolean;
  stopReason: string | null;
  usage: Usage | null;
  error: NodeError | null;
  startedAt?: string;
  finishedAt?: string;
};

export type Lease = {
  expiresAt: string;
  ttlMs: number;
};

export type NodeRequest = {
  attemptId: AttemptId;
  attemptNo: number;
  instanceId: InstanceId;
  nodeId: NodeId;
  workspacePath: string;
  prompt: string;
  timeoutMs: number;
  claimedAt: string;
  lease: Lease;
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

export type SessionBinding = {
  serverTime: string;
  skillSet: SkillSet;
};

export type AttemptRecord = {
  v: 1;
  ts: string;
  attemptId: AttemptId;
  instanceId: InstanceId;
  nodeId: NodeId;
  state: AttemptState;
  sessionId?: SessionId;
  result?: NodeResult;
  error?: { code: string; class: ErrorClass; message: string };
};

export type OrphanRecord = {
  pid: number;
  pgid?: number;
  instanceId: InstanceId;
  attemptId?: AttemptId;
  createdAt: string;
  host: string;
};

export type Unlock = () => Promise<void>;

