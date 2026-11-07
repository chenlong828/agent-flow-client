import type {
  AttemptId,
  AttemptRecord,
  AttemptState,
  InstanceId,
  NodeResult,
  OrphanRecord,
  SessionId,
  SkillSet,
  Unlock,
  Usage,
} from "./types.ts";

export type {
  AttemptId,
  AttemptRecord,
  AttemptState,
  CancelReason,
  ErrorClass,
  InstanceId,
  Lease,
  NodeError,
  NodeId,
  NodeRequest,
  NodeResult,
  OrphanRecord,
  ResultStatus,
  SessionBinding,
  SessionId,
  SkillPackage,
  SkillSet,
  Unlock,
  Usage,
} from "./types.ts";

export type ContainerPaths = {
  root: string;
  skillRoot: string;
  stagingRoot: string;
};

export type LayoutReport = {
  ok: boolean;
  root: string;
  repos: string[];
  issues: string[];
};

export type CleanupPolicy = "keep" | "clean-skills" | "clean-client";

export type InstalledSkills = {
  digest: string;
  skills: string[];
  changed: boolean;
};

export type SkillPackageRef = {
  name: string;
  source: string;
  checksum: string;
};

export type ChecksumResult = {
  ok: boolean;
  digest: string;
};

export type InstanceSpec = {
  instanceId: InstanceId;
  dshHome: string;
  containerRoot: string;
};

export type InstanceHandle = {
  instanceId: InstanceId;
  pid: number;
  pgid?: number;
};

export type SessionRef = {
  sessionId: SessionId;
  instanceId: InstanceId;
};

export type SessionEvent = {
  kind: "text" | "tool" | "usage" | "permission";
  sessionId: SessionId;
  detail?: string;
};

export type RuntimeFailure = {
  code: string;
  message: string;
  class: "runtime" | "protocol" | "cancelled" | "timeout";
};

export type SessionOutcome = {
  finalText: string;
  stopReason: string | null;
  usage: Usage | null;
  sessionId: SessionId;
  error?: RuntimeFailure;
};

export type PromptOptions = {
  signal: AbortSignal;
  timeoutMs: number;
  onEvent?: (event: SessionEvent) => void;
};

export type ShutdownMode = "graceful" | "force";

export type PermissionDecision = "allow" | "deny";

/** DSH 进程与 ACP 会话（CMP-runtime 实现）。 */
export interface RuntimePort {
  ensureInstance(instance: InstanceSpec): Promise<InstanceHandle>;
  newSession(instance: InstanceHandle, cwd: string): Promise<SessionRef>;
  prompt(session: SessionRef, text: string, opts: PromptOptions): Promise<SessionOutcome>;
  cancel(session: SessionRef): Promise<void>;
  closeSession(session: SessionRef): Promise<void>;
  shutdownInstance(instance: InstanceHandle, mode: ShutdownMode): Promise<void>;
}

/** 容器校验、路径约束与清理（CMP-workspace 实现）。 */
export interface WorkspacePort {
  ensureContainer(instance: InstanceHandle, path: string): Promise<ContainerPaths>;
  validate(container: ContainerPaths): Promise<LayoutReport>;
  resolve(container: ContainerPaths, relPath: string): Promise<string>;
  cleanup(instance: InstanceHandle, policy: CleanupPolicy): Promise<void>;
}

/** 技能集安装（CMP-assets 实现）。 */
export interface AssetPort {
  install(skillSet: SkillSet, container: ContainerPaths): Promise<InstalledSkills>;
  verify(pkg: SkillPackageRef): Promise<ChecksumResult>;
  currentDigest(container: ContainerPaths): Promise<string | null>;
}

/** 本地恢复事实端口（CMP-store 实现；executor/CLI 消费）。 */
export interface JournalPort {
  append(record: AttemptRecord): Promise<void>;
  pending(instanceId: InstanceId): Promise<AttemptRecord[]>;
  pendingAll(): Promise<AttemptRecord[]>;
  listInstances(): Promise<InstanceId[]>;
  mark(attemptId: AttemptId, state: AttemptState, patch?: Partial<AttemptRecord>): Promise<void>;
  lockInstance(instanceId: InstanceId): Promise<Unlock>;
  recordOrphan(record: OrphanRecord): Promise<void>;
  listOrphans(instanceId?: InstanceId): Promise<OrphanRecord[]>;
  clearOrphan(pid: number): Promise<void>;
}
