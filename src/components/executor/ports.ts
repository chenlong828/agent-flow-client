import type { InstanceId, OrphanRecord, SkillSet, TaskId, TaskRecord, TaskResult, TaskState } from "./types.ts";
import type { McpServerSpec, SignalContractSpec, TaskSignal } from "../signal/contract.ts";
import type { SignalPlan } from "../signal/plan.ts";

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
  /** 可选参对象加法（A-03）：`mcpServers` 原样传给 ACP `session/new`。 */
  newSession(instance: InstanceHandle, cwd: string, opts?: { mcpServers?: McpServerSpec[]; timeoutMs?: number }): Promise<SessionRef>;
  /** 续跑同一 session（§5.5 / `T-RVM-09`）：`session/resume`，cwd 必须与会话持久化时一致。 */
  resumeSession(
    instance: InstanceHandle,
    sessionId: string,
    cwd: string,
    opts?: { mcpServers?: McpServerSpec[]; timeoutMs?: number },
  ): Promise<SessionRef>;
  prompt(session: SessionRef, text: string, opts: PromptOptions): Promise<SessionOutcome>;
  cancel(session: SessionRef): Promise<void>;
  closeSession(session: SessionRef): Promise<void>;
  shutdownInstance(instance: InstanceHandle, mode: ShutdownMode): Promise<void>;
  activeSessions(instanceId: InstanceId): number;
}

/** 只读观测（CMP-observer/recorder 实现）：attempt/session 事件与原文归档；失败不得影响执行。 */
export interface ObservationPort {
  startAttempt(input: {
    taskId: string;
    attemptNo: number;
    instanceId: string;
    nodeId: string;
    runId?: string;
    startedAt: string;
  }): Promise<string | null>;
  session(attemptId: string, sessionId: string, cwd: string): Promise<void>;
  prompt(attemptId: string, sessionId: string, text: string): Promise<void>;
  observe(attemptId: string, sessionId: string, method: string, params: unknown): Promise<void>;
  permission(sessionId: string, params: unknown, decision: "allow" | "deny"): Promise<void>;
  settle(attemptId: string, result: TaskResult): Promise<void>;
  archive(attemptId: string, sessionId: string, dshHome: string): Promise<void>;
}

/** run 注册表写入口（CMP-store 实现）；只用于 O-09/O-10 定位文件根。 */
export interface RunRegistryPort {
  upsert(input: {
    runId: string;
    instanceId: string;
    workspacePath: string;
    taskSpacePath: string;
    archivedAt?: string;
  }): Promise<unknown>;
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

/** 信号准备结果：不支持的契约按既有兼容矩阵处理（不挂 MCP、继续任务）。 */
export type SignalPrepareResult = { status: "ok"; plan: SignalPlan } | { status: "unsupported"; reason: string };

/** per-attempt 信号目录与采集（`CMP-signal` 实现；proposal §4.1）。 */
export interface SignalPort {
  /** 一次 attempt 的契约集合：一个 server、每个契约一个工具。 */
  prepare(input: { taskId: TaskId; attempt: number; contracts: SignalContractSpec[] }): Promise<SignalPrepareResult>;
  collect(input: { taskId: TaskId; attempt: number; plan: SignalPlan }): Promise<TaskSignal[] | undefined>;
  cleanup(retentionDays: number): Promise<number>;
}
