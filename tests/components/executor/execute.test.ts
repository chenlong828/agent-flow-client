import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NodeExecutor } from "../../../src/components/executor/executor.ts";
import type { ExecutorRunInput, TaskRequest } from "../../../src/components/executor/types.ts";
import { WorkspaceError } from "../../../src/components/workspace/errors.ts";
import { FakeAssets, FakeRunInputs, FakeRuntime, FakeSessionLogs, FakeWorkspace, MemoryJournal } from "./fakes.ts";

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

function setup(options: { runInputs?: FakeRunInputs } = {}) {
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
    ...(options.runInputs === undefined ? {} : { runInputs: options.runInputs }),
  });
  return { journal, runtime, assets, workspace, sessionLogs, runInputs: options.runInputs, executor };
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


describe("初始资料（EXE-06/07）", () => {
  const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  const ref = (inputId: string, name: string, bytes: Uint8Array): ExecutorRunInput => ({
    inputId,
    name,
    mediaType: "image/png",
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
    downloadPath: `/runs/run-1/inputs/${inputId}`,
  });
  const runInputsWith = (items: { ref: ExecutorRunInput; bytes: Uint8Array }[]): FakeRunInputs => {
    const port = new FakeRunInputs();
    port.refs = items.map((item) => item.ref);
    for (const item of items) port.bytes.set(item.ref.inputId, item.bytes);
    return port;
  };
  const withRun = (overrides: Partial<TaskRequest> = {}): TaskRequest => task({ runId: "run-1", ...overrides });

  test("无 runId：不拉取、不建 inputs", async () => {
    const port = runInputsWith([{ ref: ref("in-1", "a.png", new Uint8Array([1])), bytes: new Uint8Array([1]) }]);
    const { workspace, executor } = setup({ runInputs: port });
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(port.listCalls).toEqual([]);
    expect(workspace.inputs.dirs).toEqual([]);
  });

  test("空列表：不建 inputs、照常执行", async () => {
    const port = runInputsWith([]);
    const { workspace, runtime, executor } = setup({ runInputs: port });
    const result = await executor.executeTask(withRun(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(port.listCalls).toEqual(["run-1"]);
    expect(workspace.inputs.dirs).toEqual([]);
    expect(runtime.prompts).toEqual(["HELLO"]);
  });

  test("有资料：建 inputs、逐张写入并校验摘要", async () => {
    const one = new Uint8Array([1, 2, 3]);
    const two = new Uint8Array([4, 5]);
    const port = runInputsWith([
      { ref: ref("in-1", "01-界面截图.png", one), bytes: one },
      { ref: ref("in-2", "02.png", two), bytes: two },
    ]);
    const { workspace, runtime, executor } = setup({ runInputs: port });
    const result = await executor.executeTask(withRun(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(workspace.inputs.dirs).toEqual(["/tmp/afc-v2-container/.agent-flow/task/task-1"]);
    expect(workspace.inputs.writes).toEqual([
      { name: "01-界面截图.png", bytes: 3 },
      { name: "02.png", bytes: 2 },
    ]);
    expect(port.downloadCalls).toEqual(["in-1", "in-2"]);
    expect(runtime.prompts).toHaveLength(1);
  });

  test("已存在且大小相同：跳过下载", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const port = runInputsWith([{ ref: ref("in-1", "a.png", bytes), bytes }]);
    const { workspace, executor } = setup({ runInputs: port });
    workspace.inputs.files.set("a.png", { size: 3 });
    const result = await executor.executeTask(withRun(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(port.downloadCalls).toEqual([]);
    expect(workspace.inputs.writes).toEqual([]);
  });

  test("摘要不符：failed(asset) input_checksum_mismatch，不写文件", async () => {
    const expected = new Uint8Array([1, 2, 3]);
    const port = runInputsWith([{ ref: ref("in-1", "a.png", expected), bytes: new Uint8Array([9, 9, 9]) }]);
    const { workspace, runtime, executor } = setup({ runInputs: port });
    const result = await executor.executeTask(withRun(), { signal: signal() });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "input_checksum_mismatch", class: "asset" });
    expect(workspace.inputs.writes).toEqual([]);
    expect(runtime.prompts).toEqual([]);
  });

  test("下载失败：failed(asset) input_fetch_failed，不建 session", async () => {
    const bytes = new Uint8Array([1]);
    const port = runInputsWith([{ ref: ref("in-1", "a.png", bytes), bytes }]);
    port.downloadError = new Error("boom");
    const { runtime, executor } = setup({ runInputs: port });
    const result = await executor.executeTask(withRun(), { signal: signal() });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "input_fetch_failed", class: "asset" });
    expect(runtime.prompts).toEqual([]);
  });

  test("列表失败：failed(asset) input_fetch_failed", async () => {
    const port = runInputsWith([]);
    port.listError = new Error("503");
    const { executor } = setup({ runInputs: port });
    const result = await executor.executeTask(withRun(), { signal: signal() });
    expect(result.error).toMatchObject({ code: "input_fetch_failed", class: "asset" });
  });

  test("文件名越界（符号链接/异常名）：failed(asset) input_path_invalid", async () => {
    const bytes = new Uint8Array([1]);
    const port = runInputsWith([{ ref: ref("in-1", "evil.png", bytes), bytes }]);
    const { workspace, executor } = setup({ runInputs: port });
    workspace.inputs.symlinkNames.add("evil.png");
    const result = await executor.executeTask(withRun(), { signal: signal() });
    expect(result.error).toMatchObject({ code: "input_path_invalid", class: "asset" });
  });

  test("磁盘/权限错误原样抛出：归 workspace，不伪装成下载失败", async () => {
    const bytes = new Uint8Array([1]);
    const port = runInputsWith([{ ref: ref("in-1", "a.png", bytes), bytes }]);
    const { workspace, executor } = setup({ runInputs: port });
    workspace.inputs.writeError = new WorkspaceError("permission_denied", "只读");
    const result = await executor.executeTask(withRun(), { signal: signal() });
    expect(result.error).toMatchObject({ code: "permission_denied", class: "workspace" });
  });
});
