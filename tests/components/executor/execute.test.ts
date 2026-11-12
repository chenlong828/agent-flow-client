import { describe, expect, test } from "bun:test";
import { NodeExecutor } from "../../../src/components/executor/executor.ts";
import type { TaskRequest } from "../../../src/components/executor/types.ts";
import { FakeAssets, FakeRuntime, FakeSessionLogs, FakeWorkspace, MemoryJournal } from "./fakes.ts";

function task(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    taskId: "task-1",
    instanceId: "instance-1",
    nodeId: "node-1",
    attempt: 1,
    prompt: "HELLO",
    workspacePath: "/tmp/afc-v2-container",
    taskSpacePath: "/tmp/afc-v2-container/.agent-flow/task/task-1",
    timeoutMs: 5000,
    skillSet: { digest: "sha256:d", packages: [] },
    ...overrides,
  };
}

function setup() {
  const journal = new MemoryJournal();
  const runtime = new FakeRuntime();
  const workspace = new FakeWorkspace();
  const assets = new FakeAssets();
  const sessionLogs = new FakeSessionLogs();
  const executor = new NodeExecutor({
    runtime,
    workspace,
    assets,
    sessionLogs,
    journal,
    dshHome: "/tmp/afc-home",
    maxResultBytes: 1024,
    now: () => new Date("2026-11-10T00:00:00.000Z"),
  });
  return { journal, runtime, assets, workspace, sessionLogs, executor };
}

const signal = () => new AbortController().signal;

describe("v2 任务执行", () => {
  test("received → running → settled；技能集来自任务", async () => {
    const { journal, runtime, assets, executor } = setup();
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(result.taskId).toBe("task-1");
    expect(result.attempt).toBe(1);
    expect(journal.states).toEqual(["received", "running", "settled"]);
    expect(runtime.prompts).toEqual(["HELLO"]);
    expect(assets.installed).toEqual(["sha256:d"]);
    expect(runtime.closed).toEqual(["s-1"]);
  });

  test("v3：先建 task-space、再执行；原始事件落会话日志", async () => {
    const { workspace, sessionLogs, executor } = setup();
    await executor.executeTask(task(), { signal: signal() });
    expect(workspace.taskSpaces).toEqual(["/tmp/afc-v2-container/.agent-flow/task/task-1"]);
    expect(sessionLogs.lines).toHaveLength(1);
    expect(JSON.parse(sessionLogs.lines[0] as string)).toMatchObject({ method: "session/update" });
  });

  test("同 taskId 并发只执行一次；不同 taskId 可并发", async () => {
    const { runtime, executor } = setup();
    runtime.behavior = "hang";
    const first = executor.executeTask(task({ taskId: "a-1" }), { signal: signal() });
    const duplicate = executor.executeTask(task({ taskId: "a-1" }), { signal: signal() });
    const other = executor.executeTask(task({ taskId: "a-2" }), { signal: signal() });
    await Bun.sleep(20);
    expect(runtime.prompts).toHaveLength(2);
    await executor.cancelAll();
    await Promise.all([first, duplicate, other]);
  });

  test("技能安装失败不 prompt，结果 asset 类", async () => {
    const { runtime, assets, journal, executor } = setup();
    assets.failWith = { code: "invalid_skill_format", message: "bad" };
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(runtime.prompts).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ class: "asset", code: "invalid_skill_format" });
    expect(journal.states.at(-1)).toBe("settled");
  });

  test("超时结果 status=timeout", async () => {
    const { runtime, executor } = setup();
    runtime.behavior = "timeout";
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("timeout");
    expect(result.error?.class).toBe("timeout");
  });

  test("取消把任务结算为 cancelled", async () => {
    const { runtime, executor } = setup();
    runtime.behavior = "hang";
    const pending = executor.executeTask(task(), { signal: signal() });
    await Bun.sleep(10);
    await executor.cancelInstance("instance-1");
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(runtime.cancelled).toHaveLength(1);
  });

  test("结果超 maxResultBytes 截断且可解析", async () => {
    const { runtime, executor } = setup();
    runtime.finalText = "x".repeat(2000);
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.message, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.message.endsWith("…[truncated]")).toBe(true);
  });
});
