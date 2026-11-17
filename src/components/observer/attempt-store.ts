import { uuidv7 } from "../shared/uuid.ts";
import type { AttemptStorePort, AttemptQuery, CreateAttemptInput, EventQuery } from "./http-types.ts";
import { ObserverError } from "./http-types.ts";
import type { AttemptSummary, ObservationEvent, ObservationEventInput } from "./types.ts";
import type { ObserverHealth } from "./health.ts";
import {
  appendAttemptEvent,
  attemptEventsSize,
  compactAttemptEvents,
  pruneAttempts,
  writeAttempt,
} from "./attempt-files.ts";
import { matchAttempt, readAllAttempts, readAttempt, readAttemptEvents } from "./attempt-query.ts";
import { attemptDir, clamp, decodeCursor, encodeCursor, type StoredAttempt } from "./attempt-paths.ts";
import { join } from "node:path";

/** O-02–O-05/O-07 的持久化：attempts/<attemptId>/{meta.json,events.jsonl}。 */
export class FileAttemptStore implements AttemptStorePort {
  readonly #base: string;
  readonly #now: () => Date;
  readonly #maxEventBytes: number;
  readonly #health: ObserverHealth | undefined;

  constructor(options: { stateRoot: string; now?: () => Date; maxEventBytes?: number; health?: ObserverHealth }) {
    this.#base = join(options.stateRoot, "observability", "attempts");
    this.#now = options.now ?? (() => new Date());
    this.#maxEventBytes = options.maxEventBytes ?? 10 * 1024 * 1024;
    this.#health = options.health;
  }

  async create(input: CreateAttemptInput): Promise<AttemptSummary> {
    const now = this.#now();
    const attemptId = uuidv7(now.getTime());
    const record: StoredAttempt = {
      attemptId,
      instanceId: input.instanceId,
      nodeId: input.nodeId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      taskId: input.taskId,
      attemptNo: input.attemptNo,
      status: "running",
      phase: "claimed",
      startedAt: input.startedAt ?? now.toISOString(),
      finishedAt: null,
      durationMs: null,
      errorClass: null,
      logCount: 0,
      archiveStatus: "pending",
      archive: { status: "pending", sizeBytes: null, sha256: null },
      updatedAt: now.toISOString(),
    };
    await writeAttempt(this.#base, record, this.#health);
    return strip(record);
  }

  async update(attemptId: string, patch: Partial<AttemptSummary>): Promise<AttemptSummary> {
    const record = await readAttempt(this.#base, attemptId);
    if (record === null) throw new ObserverError(404, "attempt_not_found", `attempt 不存在：${attemptId}`);
    const merged: StoredAttempt = { ...record, ...patch, attemptId: record.attemptId, updatedAt: this.#now().toISOString() };
    if (merged.finishedAt !== null) {
      const started = Date.parse(merged.startedAt);
      const finished = Date.parse(merged.finishedAt);
      merged.durationMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null;
    }
    if (merged.archive !== undefined) merged.archiveStatus = merged.archive.status;
    await writeAttempt(this.#base, merged, this.#health);
    return strip(merged);
  }

  async get(attemptId: string): Promise<AttemptSummary | null> {
    const record = await readAttempt(this.#base, attemptId);
    return record === null ? null : strip(record);
  }

  async list(query: AttemptQuery): Promise<{ items: AttemptSummary[]; nextCursor?: string }> {
    const all = await readAllAttempts(this.#base);
    const filtered = all.filter((item) => item.goneAt === undefined).filter((item) => matchAttempt(item, query)).sort((left, right) => {
      const running = Number(right.status === "running") - Number(left.status === "running");
      return running !== 0 ? running : right.startedAt.localeCompare(left.startedAt);
    });
    const limit = clamp(query.limit ?? 50, 1, 200);
    const offset = decodeCursor(query.cursor);
    const items = filtered.slice(offset, offset + limit).map(strip);
    const next = offset + limit < filtered.length ? encodeCursor(offset + limit) : undefined;
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  async append(attemptId: string, event: ObservationEventInput): Promise<ObservationEvent> {
    const record = await readAttempt(this.#base, attemptId);
    if (record === null) throw new ObserverError(404, "attempt_not_found", `attempt 不存在：${attemptId}`);
    const seq = record.logCount + 1;
    const item: ObservationEvent = {
      ...event,
      seq,
      ts: event.ts ?? this.#now().toISOString(),
      attemptId: record.attemptId,
      instanceId: record.instanceId,
      nodeId: record.nodeId,
      ...(record.runId === undefined ? {} : { runId: record.runId }),
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    };
    const line = `${JSON.stringify(item)}\n`;
    const currentSize = await attemptEventsSize(this.#base, attemptId);
    let truncatedBefore = record.truncatedBefore;
    if (currentSize + Buffer.byteLength(line, "utf8") > this.#maxEventBytes) {
      const compacted = await compactAttemptEvents(this.#base, attemptId);
      if (compacted !== null) truncatedBefore = compacted;
    }
    await appendAttemptEvent(this.#base, attemptId, line);
    await writeAttempt(this.#base, { ...record, ...(truncatedBefore === undefined ? {} : { truncatedBefore }), logCount: seq, updatedAt: this.#now().toISOString() }, this.#health);
    return item;
  }

  async events(attemptId: string, query: EventQuery): Promise<{ items: ObservationEvent[]; truncatedBefore?: number }> {
    const record = await readAttempt(this.#base, attemptId);
    if (record === null) throw new ObserverError(404, "attempt_not_found", `attempt 不存在：${attemptId}`);
    const all = await readAttemptEvents(this.#base, attemptId);
    const after = query.afterCursor === undefined ? 0 : Number(query.afterCursor);
    const startAt = Number.isFinite(after) ? Math.max(0, after) : 0;
    const filtered = all.filter((item) => item.seq > startAt && (query.kind === undefined || item.kind === query.kind) && (query.level === undefined || item.level === query.level));
    const limit = clamp(query.limit ?? 200, 1, 1000);
    const first = all[0]?.seq;
    return { items: filtered.slice(0, limit), ...(first !== undefined && first > 1 ? { truncatedBefore: first } : {}) };
  }

  async prune(options: { retentionDays?: number; maxBytes?: number } = {}): Promise<number> {
    return await pruneAttempts(this.#base, this.#now(), options);
  }

  async findBySession(sessionId: string): Promise<AttemptSummary | null> {
    const all = await readAllAttempts(this.#base);
    const found = all.find((item) => item.sessionId === sessionId);
    return found === undefined ? null : strip(found);
  }

  async eventsBySession(sessionId: string, query: EventQuery): Promise<{ items: ObservationEvent[]; truncatedBefore?: number }> {
    const attempt = await this.findBySession(sessionId);
    if (attempt === null) throw new ObserverError(404, "session_not_found", `session 不存在：${sessionId}`);
    const result = await this.events(attempt.attemptId, query);
    return { ...result, items: result.items.filter((item) => item.sessionId === sessionId) };
  }
}



function strip(record: StoredAttempt): AttemptSummary {
  const { updatedAt: _updatedAt, ...rest } = record;
  return rest;
}


