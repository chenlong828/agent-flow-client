import { describe, expect, test } from "bun:test";
import { NodeExecutor } from "../../../src/components/executor/executor.ts";
import type { NodeRequest } from "../../../src/components/executor/ports.ts";
import { FakeAssets, FakeRuntime, FakeScheduler, FakeWorkspace, MemoryJournal } from "./fakes.ts";

const request: NodeRequest = {
  attemptId: "a-1",
  attemptNo: 1,
  instanceId: "i-1",
  nodeId: "n-1",
  workspacePath: "/tmp/afc-exec-container",
  prompt: "HELLO",
  timeoutMs: 5000,
  claimedAt: "2026-11-08T00:00:00.000Z",
  lease: { expiresAt: "2026-11-08T00:02:00.000Z", ttlMs: 120000 },
};

function setup() {
  const journal = new MemoryJournal();
  const runtime = new FakeRuntime();
  const workspace = new FakeWorkspace();
  const assets = new FakeAssets();
  const scheduler = new FakeScheduler();
  const executor = new NodeExecutor({
    scheduler,
    runtime,
    workspace,
    assets,
    journal,
    dshHome: "/tmp/afc-home",
    maxResultBytes: 1024,
    now: () => new Date("2026-11-08T00:00:00.000Z"),
  });
  return { journal, runtime, workspace, assets, scheduler, executor };
}

const signal = () => new AbortController().signal;

describe("执行序列", () => {
  test("状态按 claimed→bound→ready→running→settled→reported→closed 前进", async () => {
    const { journal, runtime, assets, scheduler, executor } = setup();
    const result = await executor.executeNode(request, { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(journal.states).toEqual(["claimed", "bound", "ready", "running", "settled", "reported", "closed"]);
    expect(runtime.prompts).toEqual(["HELLO"]);
    expect(assets.installed[0]?.digest).toBe("sha256:test");
    expect(scheduler.reported).toHaveLength(1);
    expect(runtime.closed).toEqual(["s-1"]);
  });

  test("同一 attempt 并发调用只执行一次", async () => {
    const { runtime, executor } = setup();
    const [first, second] = await Promise.all([
      executor.executeNode(request, { signal: signal() }),
      executor.executeNode(request, { signal: signal() }),
    ]);
    expect(first).toBe(second);
    expect(runtime.prompts).toHaveLength(1);
  });

  test("技能安装失败不 prompt，结果分类 asset", async () => {
    const { assets, runtime, journal, executor } = setup();
    assets.failWith = { code: "invalid_skill_format", message: "bad" };
    const result = await executor.executeNode(request, { signal: signal() });
    expect(runtime.prompts).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ class: "asset", code: "invalid_skill_format", retryable: false });
    expect(journal.states.at(-1)).toBe("closed");
  });

  test("取消把 prompt 结算为 cancelled 并 close session", async () => {
    const { runtime, executor } = setup();
    runtime.behavior = "hang";
    const pending = executor.executeNode(request, { signal: signal() });
    await Bun.sleep(10);
    await executor.cancelInstance("i-1");
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(runtime.cancelled).toEqual(["s-1"]);
  });
});

describe("恢复与清理", () => {
  test("有结果的 settled 重报并 closed；无结果的 running 标 abandoned", async () => {
    const { journal, scheduler, executor } = setup();
    const result = { ...(await (await import("../../../src/components/result/result.ts")).assemble(
      { sessionId: "s-1", finalText: "OK", stopReason: "end_turn", usage: null },
      { attemptId: "a-2", maxResultBytes: 1024 },
    )) };
    await journal.append({ v: 1, ts: "", attemptId: "a-2", instanceId: "i-1", nodeId: "n-1", state: "settled", result });
    await journal.append({ v: 1, ts: "", attemptId: "a-3", instanceId: "i-1", nodeId: "n-1", state: "running" });
    const report = await executor.recover("i-1");
    expect(report.reReported).toEqual(["a-2"]);
    expect(report.abandoned).toEqual(["a-3"]);
    expect(scheduler.reported).toHaveLength(1);
    expect(journal.states).toContain("abandoned");
  });

  test("reconcileCleanup 释放实例并回执", async () => {
    const { runtime, workspace, journal, executor } = setup();
    await executor.executeNode(request, { signal: signal() });
    const acks = await executor.reconcileCleanup([
      { releaseId: "r-1", instanceId: "i-1", cleanup: "clean-skills", releasedAt: "" },
    ]);
    expect(acks).toEqual([
      { releaseId: "r-1", status: "done", completedAt: "2026-11-08T00:00:00.000Z" },
    ]);
    expect(runtime.shutdowns).toEqual(["i-1"]);
    expect(workspace.cleaned).toEqual(["clean-skills"]);
    expect(journal.orphans).toHaveLength(0);
  });
});
