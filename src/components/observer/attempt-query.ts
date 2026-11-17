import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptQuery } from "./http-types.ts";
import type { ObservationEvent } from "./types.ts";
import { attemptDir, type StoredAttempt } from "./attempt-paths.ts";

export async function readAttempt(base: string, attemptId: string): Promise<StoredAttempt | null> {
  try {
    const parsed = JSON.parse(await readFile(join(attemptDir(base, attemptId), "meta.json"), "utf8")) as StoredAttempt;
    return typeof parsed.attemptId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function readAllAttempts(base: string): Promise<StoredAttempt[]> {
  const names = await readdir(base).catch(() => []);
  const records: StoredAttempt[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const record = await readAttempt(base, name).catch(() => null);
    if (record !== null) records.push(record);
  }
  return records;
}

export async function readAttemptEvents(base: string, attemptId: string): Promise<ObservationEvent[]> {
  let text: string;
  try {
    text = await readFile(join(attemptDir(base, attemptId), "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const events: ObservationEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as ObservationEvent;
      if (typeof parsed.seq === "number") events.push(parsed);
    } catch {
      // 损坏行跳过。
    }
  }
  return events;
}

export function matchAttempt(item: StoredAttempt, query: AttemptQuery): boolean {
  return matchIdentity(item, query) && matchTime(item, query);
}

function matchIdentity(item: StoredAttempt, query: AttemptQuery): boolean {
  return (
    (query.instanceId === undefined || item.instanceId === query.instanceId) &&
    (query.nodeId === undefined || item.nodeId === query.nodeId) &&
    (query.runId === undefined || item.runId === query.runId) &&
    (query.taskId === undefined || item.taskId === query.taskId) &&
    (query.sessionId === undefined || item.sessionId === query.sessionId) &&
    (query.status === undefined || item.status === query.status)
  );
}

function matchTime(item: StoredAttempt, query: AttemptQuery): boolean {
  const started = Date.parse(item.startedAt);
  if (query.from !== undefined && Number.isFinite(started) && started < Date.parse(query.from)) return false;
  if (query.to !== undefined && Number.isFinite(started) && started > Date.parse(query.to)) return false;
  return true;
}

export async function attemptStats(base: string): Promise<{ total: number; active: number; sessions: number }> {
  const all = (await readAllAttempts(base)).filter((item) => item.goneAt === undefined);
  return {
    total: all.length,
    active: all.filter((item) => item.status === "running").length,
    sessions: new Set(all.filter((item) => item.sessionId !== undefined).map((item) => item.sessionId)).size,
  };
}

function safe(value: string): string {
  return value.replaceAll(/[^0-9a-zA-Z._-]/g, "_");
}
