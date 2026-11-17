import { appendFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObservationEvent } from "./types.ts";
import type { ObserverHealth } from "./health.ts";
import { attemptDir, type StoredAttempt } from "./attempt-paths.ts";
import { readAllAttempts, readAttemptEvents } from "./attempt-query.ts";

export async function writeAttempt(base: string, record: StoredAttempt, health?: ObserverHealth): Promise<void> {
  try {
    const dir = attemptDir(base, record.attemptId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, "meta.json");
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temp, target);
    health?.ok();
  } catch (error) {
    health?.fail();
    throw error;
  }
}

export async function appendAttemptEvent(base: string, attemptId: string, line: string): Promise<void> {
  const dir = attemptDir(base, attemptId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, "events.jsonl"), line, { mode: 0o600 });
}

export async function attemptEventsSize(base: string, attemptId: string): Promise<number> {
  return await stat(join(attemptDir(base, attemptId), "events.jsonl")).then((info) => info.size).catch(() => 0);
}

export async function compactAttemptEvents(base: string, attemptId: string): Promise<number | null> {
  const events = await readAttemptEvents(base, attemptId);
  if (events.length <= 1) return null;
  const keep = events.slice(Math.floor(events.length / 2));
  const firstSeq = keep[0]?.seq;
  if (firstSeq === undefined) return null;
  await writeFile(join(attemptDir(base, attemptId), "events.jsonl"), keep.map((item) => `${JSON.stringify(item)}\n`).join(""), { mode: 0o600 });
  return firstSeq - 1;
}

export async function pruneAttempts(
  base: string,
  now: Date,
  options: { retentionDays?: number; maxBytes?: number } = {},
): Promise<number> {
  const retentionDays = options.retentionDays ?? 7;
  const maxBytes = options.maxBytes ?? 1073741824;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const all = await readAllAttempts(base);
  const live = all.filter((item) => item.goneAt === undefined);
  const sizes = new Map<string, number>();
  let total = 0;
  for (const item of live) {
    const size = await attemptEventsSize(base, item.attemptId);
    sizes.set(item.attemptId, size);
    total += size;
  }
  let removed = 0;
  const candidates = live.filter((item) => item.status !== "running").sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  for (const item of candidates) {
    const started = Date.parse(item.startedAt);
    const expired = Number.isFinite(started) && started < cutoff;
    if (!expired && total <= maxBytes) continue;
    await rm(join(attemptDir(base, item.attemptId), "events.jsonl"), { force: true }).catch(() => undefined);
    await writeAttempt(base, { ...item, goneAt: now.toISOString(), truncatedBefore: item.logCount });
    total -= sizes.get(item.attemptId) ?? 0;
    removed += 1;
  }
  return removed;
}
