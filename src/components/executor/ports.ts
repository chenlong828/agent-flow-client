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
  RawAcpEvent,
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
  /** `C-10`：校验绝对路径且位于工作区之下，不存在则建目录；只建目录、不写内容。 */
  ensureTaskSpace(workspaceRoot: string, taskSpacePath: string): Promise<string>;
  /** `P-05`：把 task-space 打成 tar.gz（条目相对根），返回临时文件路径与字节数。 */
  packTaskSpace(taskSpacePath: string, targetPath: string): Promise<{ path: string; bytes: number }>;
}

/** `P-04` 会话日志的本地持久化（CMP-store 实现）：按 `taskId+attempt` 存原始 JSONL 行。 */
export interface SessionLogPort {
  append(taskId: TaskId, attempt: number, line: string): Promise<void>;
  read(taskId: TaskId, attempt: number): Promise<Uint8Array | null>;
  clear(taskId: TaskId, attempt: number): Promise<void>;
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
