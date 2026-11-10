import type { InstanceId, OrphanRecord, SkillSet, TaskId, TaskRecord, TaskState } from "./types.ts";

export type { InstanceId, OrphanRecord, SkillSet, TaskId, TaskRecord, TaskState } from "./types.ts";
import type {
  ChecksumResult,
  ContainerPaths,
  InstanceHandle,
  InstanceSpec,
  LayoutReport,
  PromptOptions,
  SessionOutcome,
  SessionRef,
  ShutdownMode,
  SkillPackageRef,
  InstalledSkills,
} from "./domain-types.ts";

export type {
  ChecksumResult,
  CleanupPolicy,
  ContainerPaths,
  InstalledSkills,
  InstanceHandle,
  InstanceSpec,
  LayoutReport,
  PermissionDecision,
  PromptOptions,
  RuntimeFailure,
  SessionEvent,
  SessionOutcome,
  SessionRef,
  ShutdownMode,
  SkillPackageRef,
} from "./domain-types.ts";

/** DSH 进程与 ACP 会话（CMP-runtime 实现）。 */
export interface RuntimePort {
  ensureInstance(instance: InstanceSpec): Promise<InstanceHandle>;
  newSession(instance: InstanceHandle, cwd: string): Promise<SessionRef>;
  prompt(session: SessionRef, text: string, opts: PromptOptions): Promise<SessionOutcome>;
  cancel(session: SessionRef): Promise<void>;
  closeSession(session: SessionRef): Promise<void>;
  shutdownInstance(instance: InstanceHandle, mode: ShutdownMode): Promise<void>;
  activeSessions(instanceId: InstanceId): number;
}

/** 容器校验与路径约束（CMP-workspace 实现）。 */
export interface WorkspacePort {
  ensureContainer(instance: InstanceHandle, path: string): Promise<ContainerPaths>;
  validate(container: ContainerPaths): Promise<LayoutReport>;
  resolve(container: ContainerPaths, relPath: string): Promise<string>;
}

/** 技能集安装（CMP-assets 实现）。 */
export interface AssetPort {
  install(skillSet: SkillSet, container: ContainerPaths): Promise<InstalledSkills>;
  verify(pkg: SkillPackageRef): Promise<ChecksumResult>;
  currentDigest(container: ContainerPaths): Promise<string | null>;
}

/** 本地恢复事实端口（CMP-store 实现；executor/CLI 消费）。 */
export interface JournalPort {
  append(record: TaskRecord): Promise<void>;
  mark(taskId: TaskId, state: TaskState, patch?: Partial<TaskRecord>): Promise<void>;
  settled(): Promise<TaskRecord[]>;
  recordOrphan(record: OrphanRecord): Promise<void>;
  listOrphans(instanceId?: InstanceId): Promise<OrphanRecord[]>;
  clearOrphan(pid: number): Promise<void>;
}
