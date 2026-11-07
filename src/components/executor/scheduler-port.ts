import type { AttemptId, Lease, NodeRequest, NodeResult, SessionId, SkillSet } from "./types.ts";

export type Capacity = { maxInstances: number; activeInstances: number; activeAttempts: number };

export type ClientInfo = {
  clientId: string;
  version: string;
  protocolVersion: string;
  capacity: Capacity;
};

export type Limits = {
  maxResultBytes: number;
  maxPromptBytes: number;
  maxRequestBytes: number;
  maxSkillPackageBytes: number;
  maxSkillPackages: number;
};

export type Assignment = { instanceId: string; workspacePath: string; state: "active" | "waiting" };

export type CleanupPending = {
  releaseId: string;
  instanceId: string;
  workspacePath?: string;
  cleanup: "keep" | "clean-skills" | "clean-client";
  releasedAt: string;
};

export type CleanupAck = {
  releaseId: string;
  status: "done" | "failed";
  completedAt: string;
  errorClass?: string;
  retryable?: boolean;
};

export type RegistrationOutcome = {
  serverTime: string;
  limits: Limits;
  assignmentsVersion: number;
  assignments?: Assignment[];
  cleanupPending: CleanupPending[];
};

export type ControlEvent =
  | { type: "cancel"; instanceId: string; reason: "user_cancel"; issuedAt: string }
  | { type: "pause"; instanceId: string; issuedAt: string }
  | { type: "resume"; instanceId: string; issuedAt: string }
  | { type: "shutdown"; instanceId?: string; cleanup?: CleanupPending["cleanup"]; releaseId?: string; issuedAt: string };

export type ControlBatch = { seq: number; events: ControlEvent[] };

export type ClientState = {
  capacity: Capacity;
  pausedInstances: string[];
  activeAttempts: { attemptId: string; instanceId: string; phase: string; sessionId?: string }[];
  assignmentsVersion: number;
};

export type HeartbeatOutcome = {
  serverTime: string;
  control: ControlBatch;
  cleanupPending: CleanupPending[];
  assignmentsVersion: number;
  assignments?: Assignment[];
  nextPollAfterMs: number;
};

export type Ack = {
  attemptId: string;
  disposition: "accepted" | "duplicate";
  attemptState: string;
  recordedAt: string;
};

/** 调度器协议防腐层（CMP-executor 定义，CMP-gateway 实现；S0 用本地适配器）。 */
export interface SchedulerPort {
  register(info: ClientInfo): Promise<RegistrationOutcome>;
  heartbeat(state: ClientState, acks?: CleanupAck[]): Promise<HeartbeatOutcome>;
  claim(capacity: Capacity): Promise<NodeRequest | null>;
  renew(attemptId: AttemptId): Promise<Lease>;
  bindSession(attemptId: AttemptId, sessionId: SessionId): Promise<SkillSet>;
  reportResult(attemptId: AttemptId, result: NodeResult): Promise<Ack>;
}
