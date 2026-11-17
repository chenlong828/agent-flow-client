import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAttemptStore } from "../../../src/components/observer/attempt-store.ts";
import { SessionRichHub } from "../../../src/components/observer/rich-hub.ts";
import { createObserverHandler, startObserverServer } from "../../../src/components/observer/server.ts";
import type { ObserverConfig, ObserverDeps } from "../../../src/components/observer/http-types.ts";
import { WorkspaceFileReader } from "../../../src/components/workspace/files.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const config: ObserverConfig = {
  enabled: true,
  required: false,
  bind: "127.0.0.1",
  port: 0,
  advertiseUrl: "http://127.0.0.1:17890/api/v1/observability",
  token: null,
  maxStreams: 5,
  rawEnabled: true,
  richStreamEnabled: true,
  retentionDays: 7,
  maxBytes: 1024 * 1024,
  maxAttemptEventBytes: 1024 * 1024,
};

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "afc-observer-"));
  roots.push(stateRoot);
  const taskSpace = join(stateRoot, "task");
  await mkdir(join(taskSpace, "reports"), { recursive: true });
  await writeFile(join(taskSpace, "reports", "a.md"), "# hi\n");
  const attempts = new FileAttemptStore({ stateRoot });
  const rich = new SessionRichHub();
  const deps: ObserverDeps = {
    config,
    stateRoot,
    attempts,
    rich,
    runs: { get: async (runId) => (runId === "run-1" ? { runId, workspacePath: stateRoot, taskSpacePath: taskSpace } : null) },
    files: new WorkspaceFileReader(),
    archive: { resolve: async () => null },
  };
  const handler = createObserverHandler(deps);
  return { deps, handler, taskSpace };
}

describe("observer HTTP", () => {
  test("health 与 attempts 列表", async () => {
    const { deps, handler } = await setup();
    await deps.attempts.create({ taskId: "t1", attemptNo: 1, instanceId: "i", nodeId: "n3" });
    const health = await handler(new Request("http://x/api/v1/observability/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ observabilityVersion: "2026-11-17.1", activeAttempts: 1 });
    const list = await handler(new Request("http://x/api/v1/observability/attempts?status=running"));
    expect(list.status).toBe(200);
    expect((await list.json()).items).toHaveLength(1);
  });

  test("files 列表与内容；未注册 run 404", async () => {
    const { handler } = await setup();
    const list = await handler(new Request("http://x/api/v1/observability/runs/run-1/files?root=task-space&path=reports"));
    expect(list.status).toBe(200);
    expect((await list.json()).entries[0]).toMatchObject({ name: "a.md", type: "file" });
    const content = await handler(new Request("http://x/api/v1/observability/runs/run-1/files/content?root=task-space&path=reports/a.md"));
    expect(content.status).toBe(200);
    expect(await content.json()).toMatchObject({ content: "# hi\n", binary: false });
    const missing = await handler(new Request("http://x/api/v1/observability/runs/nope/files"));
    expect(missing.status).toBe(404);
  });

  test("attempt 日志路由返回 preview 事件", async () => {
    const { deps, handler } = await setup();
    const attempt = await deps.attempts.create({ taskId: "t1", attemptNo: 1, instanceId: "i", nodeId: "n3" });
    await deps.attempts.append(attempt.attemptId, { kind: "acp", event: "agent_message_chunk", message: "hello" });
    const response = await handler(new Request(`http://x/api/v1/observability/attempts/${attempt.attemptId}/logs?limit=10`));
    expect(response.status).toBe(200);
    expect((await response.json()).items[0]).toMatchObject({ kind: "acp", message: "hello" });
  });

  test("attempt SSE：Last-Event-ID 只补新事件，abort 不抛异常", async () => {
    const { deps, handler } = await setup();
    const attempt = await deps.attempts.create({ taskId: "t1", attemptNo: 1, instanceId: "i", nodeId: "n3" });
    await deps.attempts.append(attempt.attemptId, { kind: "phase", phase: "claimed", event: "attempt.claimed" });
    await deps.attempts.append(attempt.attemptId, { kind: "acp", event: "agent_message_chunk", message: "hello" });
    const controller = new AbortController();
    const response = await handler(new Request(`http://x/api/v1/observability/attempts/${attempt.attemptId}/logs/stream`, {
      headers: { "last-event-id": "1" },
      signal: controller.signal,
    }));
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const first = new TextDecoder().decode((await reader?.read())?.value);
    expect(first).toContain("event: snapshot");
    expect(first).toContain("agent_message_chunk");
    expect(first).not.toContain("attempt.claimed");
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  });

  test("attempt SSE：已结束返回 snapshot + end", async () => {
    const { deps, handler } = await setup();
    const attempt = await deps.attempts.create({ taskId: "t1", attemptNo: 1, instanceId: "i", nodeId: "n3" });
    await deps.attempts.update(attempt.attemptId, { status: "completed", phase: "settled", finishedAt: "2026-11-17T10:00:01Z" });
    const response = await handler(new Request(`http://x/api/v1/observability/attempts/${attempt.attemptId}/logs/stream`));
    const text = await new Response(response.body).text();
    expect(text).toContain("event: snapshot");
    expect(text).toContain("event: end");
  });

  test("session 详情与富 SSE snapshot", async () => {
    const { deps, handler } = await setup();
    const attempt = await deps.attempts.create({ taskId: "t1", attemptNo: 1, instanceId: "i", nodeId: "n3" });
    await deps.attempts.update(attempt.attemptId, { sessionId: "s1", cwd: "/ws" });
    deps.rich.publish("s1", { kind: "message", text: "hello" });
    const detail = await handler(new Request("http://x/api/v1/observability/sessions/s1"));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ sessionId: "s1", attemptId: attempt.attemptId });

    const stream = await handler(new Request("http://x/api/v1/observability/sessions/s1/events/stream"));
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("event: snapshot");
    await reader?.cancel();
  });
});

describe("observer HTTP server", () => {
  test("start 后健康检查可达，stop 可关闭", async () => {
    const { deps } = await setup();
    const handle = startObserverServer({ ...deps, config: { ...config, port: 0 } });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/observability/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ observabilityVersion: "2026-11-17.1" });
    } finally {
      handle.stop();
    }
  });
});
