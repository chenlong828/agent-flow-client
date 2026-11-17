import type { TaskResult } from "../executor/types.ts";
import type {
  AttemptStatus,
  AttemptSummary,
  ObservationEvent,
  ObservationEventInput,
  ObservationKind,
  SessionRichEvent,
  SessionRichEventInput,
} from "./types.ts";

export type RunFileRoot = "task-space" | "workspace";

export type RunFileEntry = {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  sizeBytes: number | null;
  modifiedAt: string;
};

export type RunFileListing = {
  runId: string;
  root: RunFileRoot;
  path: string;
  entries: RunFileEntry[];
  truncated: boolean;
  fetchedAt: string;
};

export type RunFileContent = {
  runId: string;
  root: RunFileRoot;
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  content: string | null;
  encoding: "utf-8" | null;
  binary: boolean;
  truncated: boolean;
  fetchedAt: string;
};

export type ObserverConfig = {
  enabled: boolean;
  required: boolean;
  bind: string;
  port: number;
  advertiseUrl: string;
  token: string | null;
  maxStreams: number;
  rawEnabled: boolean;
  richStreamEnabled: boolean;
  retentionDays: number;
  maxBytes: number;
  maxAttemptEventBytes: number;
};

export type ObserverDeps = {
  config: ObserverConfig;
  stateRoot: string;
  attempts: AttemptStorePort;
  rich: RichStreamPort;
  runs: RunRegistryPort;
  files: RunFilePort;
  archive: SessionArchivePort;
  now?: () => Date;
  logger?: (event: string, detail?: Record<string, unknown>) => void;
  health?: { readonly degraded: boolean };
};

export interface AttemptStorePort {
  create(input: CreateAttemptInput): Promise<AttemptSummary>;
  update(attemptId: string, patch: Partial<AttemptSummary>): Promise<AttemptSummary>;
  get(attemptId: string): Promise<AttemptSummary | null>;
  list(query: AttemptQuery): Promise<{ items: AttemptSummary[]; nextCursor?: string }>;
  append(attemptId: string, event: ObservationEventInput): Promise<ObservationEvent>;
  events(attemptId: string, query: EventQuery): Promise<{ items: ObservationEvent[]; truncatedBefore?: number }>;
  findBySession(sessionId: string): Promise<AttemptSummary | null>;
  eventsBySession(sessionId: string, query: EventQuery): Promise<{ items: ObservationEvent[]; truncatedBefore?: number }>;
}

export interface RichStreamPort {
  publish(sessionId: string, event: SessionRichEventInput): SessionRichEvent;
  snapshot(sessionId: string, limit: number): SessionRichEvent[];
  subscribe(sessionId: string, listener: (event: SessionRichEvent) => void): () => void;
  onClose(sessionId: string, listener: (status: AttemptStatus) => void): () => void;
  close(sessionId: string, status: AttemptStatus): void;
}

export interface RunRegistryPort {
  get(runId: string): Promise<{ runId: string; workspacePath: string; taskSpacePath: string; goneAt?: string } | null>;
  count?(): Promise<number>;
  prune?(options: { activeRunIds?: readonly string[]; retentionDays?: number; maxBytes?: number }): Promise<number>;
}

export interface RunFilePort {
  list(input: { root: RunFileRoot; rootPath: string; path: string; limit: number }): Promise<{
    entries: RunFileEntry[];
    truncated: boolean;
  }>;
  read(input: { root: RunFileRoot; rootPath: string; path: string; maxBytes: number }): Promise<{
    name: string;
    sizeBytes: number;
    modifiedAt: string;
    content: string | null;
    encoding: "utf-8" | null;
    binary: boolean;
    truncated: boolean;
  }>;
}

export interface SessionArchivePort {
  resolve(sessionId: string): Promise<{ path: string; sizeBytes: number; sha256: string } | null>;
}

export type CreateAttemptInput = {
  taskId: string;
  attemptNo: number;
  instanceId: string;
  nodeId: string;
  runId?: string;
  startedAt?: string;
};

export type AttemptQuery = {
  instanceId?: string;
  nodeId?: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  status?: AttemptStatus;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

export type EventQuery = {
  afterCursor?: string;
  limit?: number;
  kind?: ObservationKind;
  level?: "debug" | "info" | "warn" | "error";
};

export class ObserverError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ObserverError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type AttemptResultPatch = {
  status: AttemptStatus;
  finishedAt?: string;
  errorClass?: string | null;
  result?: TaskResult;
};
