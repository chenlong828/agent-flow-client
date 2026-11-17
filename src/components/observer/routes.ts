import type { AttemptStatus, AttemptSummary, ObservationEvent, SessionSummary } from "./types.ts";
import { OBSERVABILITY_VERSION } from "./types.ts";
import type { ObserverDeps, RunFileRoot } from "./http-types.ts";
import { ObserverError } from "./http-types.ts";
import { json } from "./http.ts";
import { attemptStats } from "./attempt-query.ts";
import { join } from "node:path";

const BASE = "/api/v1/observability";

export async function attempts(deps: ObserverDeps): Promise<AttemptSummary[]> {
  return (await deps.attempts.list({ limit: 200 })).items;
}

export async function health(deps: ObserverDeps, startedAt: number, activeStreams: number): Promise<unknown> {
  const stats = await attemptStats(join(deps.stateRoot, "observability", "attempts"));
  return {
    status: deps.health?.degraded === true ? "degraded" : "ok",
    observabilityVersion: OBSERVABILITY_VERSION,
    clientVersion: "0.1.0",
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Math.max(0, Date.now() - startedAt),
    activeAttempts: stats.active,
    retainedAttempts: stats.total,
    activeSessions: stats.active,
    retainedSessions: stats.sessions,
    registeredRuns: deps.runs.count === undefined ? 0 : await deps.runs.count(),
    filesEnabled: deps.config.enabled,
    richStreamEnabled: deps.config.richStreamEnabled,
    authRequired: deps.config.token !== null && deps.config.token !== "",
    activeStreams,
  };
}

export async function listAttempts(deps: ObserverDeps, url: URL): Promise<unknown> {
  const result = await deps.attempts.list({
    ...(url.searchParams.get("instanceId") === null ? {} : { instanceId: url.searchParams.get("instanceId") as string }),
    ...(url.searchParams.get("nodeId") === null ? {} : { nodeId: url.searchParams.get("nodeId") as string }),
    ...(url.searchParams.get("runId") === null ? {} : { runId: url.searchParams.get("runId") as string }),
    ...(url.searchParams.get("taskId") === null ? {} : { taskId: url.searchParams.get("taskId") as string }),
    ...(url.searchParams.get("sessionId") === null ? {} : { sessionId: url.searchParams.get("sessionId") as string }),
    ...(url.searchParams.get("status") === null ? {} : { status: url.searchParams.get("status") as AttemptStatus }),
    ...(url.searchParams.get("from") === null ? {} : { from: url.searchParams.get("from") as string }),
    ...(url.searchParams.get("to") === null ? {} : { to: url.searchParams.get("to") as string }),
    ...(url.searchParams.get("limit") === null ? {} : { limit: Number(url.searchParams.get("limit")) }),
    ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor") as string }),
  });
  return result;
}

export async function attemptDetail(deps: ObserverDeps, attemptId: string): Promise<unknown> {
  const attempt = await requireAttempt(deps, attemptId);
  const session = attempt.sessionId === undefined || attempt.cwd === undefined ? null : await sessionSummary(deps, attempt);
  const firstSeq = (await deps.attempts.events(attemptId, { limit: 1 })).items[0]?.seq ?? 0;
  return {
    attempt,
    session,
    logRange: { firstSeq, lastSeq: attempt.logCount },
  } satisfies Record<string, unknown>;
}

export async function attemptLogs(deps: ObserverDeps, attemptId: string, url: URL): Promise<unknown> {
  await requireAttempt(deps, attemptId);
  const result = await deps.attempts.events(attemptId, {
    ...(url.searchParams.get("cursor") === null ? {} : { afterCursor: url.searchParams.get("cursor") as string }),
    ...(url.searchParams.get("limit") === null ? {} : { limit: Number(url.searchParams.get("limit")) }),
    ...(url.searchParams.get("kind") === null ? {} : { kind: url.searchParams.get("kind") as ObservationEvent["kind"] }),
    ...(url.searchParams.get("level") === null ? {} : { level: url.searchParams.get("level") as ObservationEvent["level"] }),
  });
  return { items: result.items, nextCursor: String(result.items.at(-1)?.seq ?? 0), ...(result.truncatedBefore === undefined ? {} : { truncatedBefore: result.truncatedBefore }) };
}

export async function sessionDetail(deps: ObserverDeps, sessionId: string): Promise<unknown> {
  const attempt = await deps.attempts.findBySession(sessionId);
  if (attempt === null) throw new ObserverError(404, "session_not_found", `session 不存在：${sessionId}`);
  if (attempt.goneAt !== undefined || (await deps.archive.isGone?.(sessionId)) === true) {
    throw new ObserverError(410, "observation_gone", "session 已按保留策略清理");
  }
  return sessionSummary(deps, attempt);
}

export async function sessionSummary(deps: ObserverDeps, attempt: AttemptSummary): Promise<SessionSummary> {
  const sessionId = attempt.sessionId as string;
  const archive = await deps.archive.resolve(sessionId);
  return {
    sessionId,
    attemptId: attempt.attemptId,
    instanceId: attempt.instanceId,
    nodeId: attempt.nodeId,
    ...(attempt.runId === undefined ? {} : { runId: attempt.runId }),
    cwd: attempt.cwd ?? "",
    status: attempt.status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    eventCount: attempt.logCount,
    archive: {
      status: archive === null ? attempt.archiveStatus : "stored",
      sizeBytes: archive?.sizeBytes ?? attempt.archive?.sizeBytes ?? null,
      sha256: archive?.sha256 ?? attempt.archive?.sha256 ?? null,
      downloadUrl: archive === null ? null : `${BASE}/sessions/${sessionId}/raw`,
    },
  };
}

export async function sessionEvents(deps: ObserverDeps, sessionId: string, url: URL): Promise<unknown> {
  const attempt = await deps.attempts.findBySession(sessionId);
  if (attempt === null) throw new ObserverError(404, "session_not_found", `session 不存在：${sessionId}`);
  if (attempt.goneAt !== undefined || (await deps.archive.isGone?.(sessionId)) === true) {
    throw new ObserverError(410, "observation_gone", "session 已按保留策略清理");
  }
  const result = await deps.attempts.eventsBySession(sessionId, {
    ...(url.searchParams.get("cursor") === null ? {} : { afterCursor: url.searchParams.get("cursor") as string }),
    ...(url.searchParams.get("limit") === null ? {} : { limit: Number(url.searchParams.get("limit")) }),
  });
  return { items: result.items, nextCursor: String(result.items.at(-1)?.seq ?? 0), ...(result.truncatedBefore === undefined ? {} : { truncatedBefore: result.truncatedBefore }) };
}

export async function raw(deps: ObserverDeps, sessionId: string): Promise<Response> {
  if (!deps.config.rawEnabled) throw new ObserverError(403, "raw_disabled", "raw 下载已关闭");
  const attempt = await deps.attempts.findBySession(sessionId);
  if (attempt === null) throw new ObserverError(404, "session_not_found", `session 不存在：${sessionId}`);
  if (attempt.goneAt !== undefined || (await deps.archive.isGone?.(sessionId)) === true) {
    throw new ObserverError(410, "observation_gone", "session 已按保留策略清理");
  }
  const archive = await deps.archive.resolve(sessionId);
  if (archive === null) throw new ObserverError(409, "archive_not_ready", "session 归档尚未完成");
  const file = Bun.file(archive.path);
  return new Response(file, {
    headers: {
      "content-type": "application/zstd",
      "content-disposition": `attachment; filename="${sessionId}.jsonl.zstd"`,
      "content-length": String(archive.sizeBytes),
      "accept-ranges": "bytes",
      etag: `"sha256-${archive.sha256}"`,
      "x-checksum-sha256": archive.sha256,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function runFiles(deps: ObserverDeps, runId: string, url: URL): Promise<unknown> {
  const run = await deps.runs.get(runId);
  if (run === null) throw new ObserverError(404, "run_not_found", `run 不存在：${runId}`);
  if (run.goneAt !== undefined) throw new ObserverError(410, "run_gone", "run 已按保留策略清理");
  const root = parseRoot(url.searchParams.get("root"));
  const path = url.searchParams.get("path") ?? "";
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 2000;
  const result = await deps.files.list({ root, rootPath: root === "task-space" ? run.taskSpacePath : run.workspacePath, path, limit: Number.isFinite(limit) ? limit : 2000 });
  return { runId, root, path, entries: result.entries, truncated: result.truncated, fetchedAt: new Date().toISOString() };
}

export async function runFileContent(deps: ObserverDeps, runId: string, url: URL): Promise<unknown> {
  const run = await deps.runs.get(runId);
  if (run === null) throw new ObserverError(404, "run_not_found", `run 不存在：${runId}`);
  if (run.goneAt !== undefined) throw new ObserverError(410, "run_gone", "run 已按保留策略清理");
  const root = parseRoot(url.searchParams.get("root"));
  const path = url.searchParams.get("path");
  if (path === null || path === "") throw new ObserverError(400, "validation_error", "path 必填");
  const result = await deps.files.read({ root, rootPath: root === "task-space" ? run.taskSpacePath : run.workspacePath, path, maxBytes: 1048576 });
  return { runId, root, path, ...result, fetchedAt: new Date().toISOString() };
}

function parseRoot(value: string | null): RunFileRoot {
  if (value === null || value === "" || value === "task-space") return "task-space";
  if (value === "workspace") return "workspace";
  throw new ObserverError(400, "validation_error", "root 只能是 task-space 或 workspace");
}

export async function requireAttempt(deps: ObserverDeps, attemptId: string): Promise<AttemptSummary> {
  const attempt = await deps.attempts.get(attemptId);
  if (attempt === null) throw new ObserverError(404, "attempt_not_found", `attempt 不存在：${attemptId}`);
  if (attempt.goneAt !== undefined) throw new ObserverError(410, "observation_gone", "attempt 已按保留策略清理");
  return attempt;
}
