import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAttemptStore } from "../../../src/components/observer/attempt-store.ts";

const roots: string[] = [];
async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "afc-attempts-"));
  roots.push(stateRoot);
  let now = Date.parse("2026-11-17T10:00:00Z");
  const store = new FileAttemptStore({ stateRoot, now: () => new Date(now) });
  return { stateRoot, store, tick: (ms: number) => { now += ms; } };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("attempt 观测存储", () => {
  test("create/append/update/list 与 session 过滤", async () => {
    const { store, tick } = await setup();
    const attempt = await store.create({ taskId: "task-1", attemptNo: 1, instanceId: "inst", nodeId: "n3", runId: "run-1" });
    expect(attempt.status).toBe("running");
    expect(attempt.phase).toBe("claimed");
    expect(attempt.attemptId).toMatch(/^[0-9a-f-]{36}$/);

    tick(1000);
    await store.append(attempt.attemptId, { kind: "phase", phase: "bound", event: "session.started" });
    await store.update(attempt.attemptId, { sessionId: "session-1", cwd: "/ws", phase: "running" });
    tick(1000);
    await store.append(attempt.attemptId, { kind: "acp", event: "agent_message_chunk", message: "hello" });

    const events = await store.events(attempt.attemptId, { limit: 10 });
    expect(events.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(events.items[1]).toMatchObject({ kind: "acp", sessionId: "session-1", message: "hello" });

    const bySession = await store.eventsBySession("session-1", { limit: 10 });
    expect(bySession.items).toHaveLength(1);

    const summary = await store.get(attempt.attemptId);
    expect(summary).toMatchObject({ logCount: 2, sessionId: "session-1" });
    const list = await store.list({ sessionId: "session-1" });
    expect(list.items.map((item) => item.attemptId)).toEqual([attempt.attemptId]);
  });

  test("更新结束时间计算 duration", async () => {
    const { store, tick } = await setup();
    const attempt = await store.create({ taskId: "task", attemptNo: 1, instanceId: "i", nodeId: "n" });
    tick(5000);
    const updated = await store.update(attempt.attemptId, { status: "completed", phase: "settled", finishedAt: new Date(Date.parse("2026-11-17T10:00:05Z")).toISOString() });
    expect(updated.durationMs).toBe(5000);
  });
});
