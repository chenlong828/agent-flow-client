import type { InstanceId, SessionId, Usage } from "./types.ts";

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
  idleTimeoutMs?: number;
  onEvent?: (event: SessionEvent) => void;
};

export type ShutdownMode = "graceful" | "force";

export type PermissionDecision = "allow" | "deny";
