import type { TaskRequest } from "./types.ts";

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

export type RunningTask = {
  taskId: string;
  instanceId: string;
  startedAt: string;
  lastEventAt?: string;
};

export type FinishedTask = {
  taskId: string;
  attempt: number;
  finishedAt: string;
};

export type ArchiveRequest = {
  runId: string;
  instanceId: string;
  workspacePath: string;
  taskSpacePath: string;
};

export type PollRequest = {
  capacity: { free: number };
  running: RunningTask[];
  finished: FinishedTask[];
  archivedRuns?: string[];
};

export type PollResponse = {
  tasks: TaskRequest[];
  stop: boolean;
  cancelInstances: string[];
  archiveRequests: ArchiveRequest[];
  nextPollAfterMs: number;
};

export type StoredStatus = "created" | "replaced" | "unchanged";

export type SessionLogAck = {
  taskId: string;
  attempt: number;
  bytes: number;
  sha256: string;
  stored: StoredStatus;
};

export type ArchiveAck = {
  runId: string;
  bytes: number;
  sha256: string;
  stored: StoredStatus;
};

export type ResultAck = {
  taskId: string;
  accepted: boolean;
};
