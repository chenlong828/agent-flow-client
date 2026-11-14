import type { InstanceId, SessionId, Usage } from "./types.ts";

export type ContainerPaths = {
  root: string;
  skillRoot: string;
  stagingRoot: string;
};

export type LayoutReport = {
  ok: boolean;
  root: string;
  /** 容器形态：根自身是 git 超项目，或普通目录容器。 */
  layout: "superproject" | "container";
  repos: string[];
  issues: string[];
  /** 不阻断任务的布局问题（如子模块未初始化）；`ok` 只由 `issues` 决定。 */
  warnings: string[];
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

/** `P-04` 会话日志的一行：原始 ACP 通知/请求，未脱敏（契约 C-11）。 */
export type RawAcpEvent = {
  ts: string;
  sessionId: SessionId;
  method: string;
  params: unknown;
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
  idleTimeoutMs?: number;
  onEvent?: (event: SessionEvent) => void;
  /** 原始 ACP 事件出口（`P-04` 日志用）；与 `onEvent` 并存，互不影响。 */
  onRawEvent?: (event: RawAcpEvent) => void;
};

export type ShutdownMode = "graceful" | "force";

export type PermissionDecision = "allow" | "deny";
