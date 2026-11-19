import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutor } from "../../src/components/executor/executor.ts";
import { AcpRuntime } from "../../src/components/runtime/runtime.ts";
import { FileSignal } from "../../src/components/signal/signal.ts";
import type { TaskRequest } from "../../src/components/executor/types.ts";
import { reviewVerdictContract } from "../support/signal-contract.ts";
import { FakeAssets, FakeSessionLogs, FakeWorkspace, MemoryJournal } from "../components/executor/fakes.ts";

const fakeAcp = join(import.meta.dir, "../fixtures/fake-acp.mjs");

async function fixture(extraEnv: Record<string, string> = {}) {
  const base = await mkdtemp(join(tmpdir(), "afc-signal-e2e-"));
  const stateRoot = join(base, "state");
  // FakeWorkspace 固定返回该容器根；AcpRuntime 以它为 cwd 启动 fake DSH。
  await mkdir("/tmp/afc-v2-container", { recursive: true });
  const mcpFile = join(base, "mcp.jsonl");
  const runtime = new AcpRuntime({
    command: { command: process.execPath, args: [fakeAcp] },
    env: {
      ...(process.env as Record<string, string>),
      FAKE_ACP_MCP_FILE: mcpFile,
      ...extraEnv,
    },
    permission: "allow",
  });
  const journal = new MemoryJournal();
  const executor = new NodeExecutor({
    runtime,
    workspace: new FakeWorkspace(),
    assets: new FakeAssets(),
    sessionLogs: new FakeSessionLogs(),
    journal,
    dshHome: join(base, "home"),
    maxResultBytes: 4096,
    signals: new FileSignal({ stateRoot }),
  });
  const execute = async (task: TaskRequest) => await executor.executeTask(task, { signal: new AbortController().signal });
  return { base, stateRoot, mcpFile, execute, executor };
}

function task(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    taskId: "task-signal-1",
    instanceId: "instance-1",
    nodeId: "review-1",
    attempt: 1,
    prompt: "REVIEW",
    workspacePath: "/tmp/afc-signal-container",
    taskSpacePath: "/tmp/afc-signal-container/.agent-flow/task/task-signal-1",
    timeoutMs: 10_000,
    skillSet: { digest: "sha256:d", packages: [] },
    resultSignal: reviewVerdictContract,
    ...overrides,
  };
}

describe("信号链路（executor + ACP + CMP-signal）", () => {
  test("session/new 带 agentflow server，采集到信号后随结果回传", async () => {
    const { mcpFile, stateRoot, execute } = await fixture({ FAKE_ACP_EMIT_SIGNAL: "1" });
    const result = await execute(task());
    expect(result.status).toBe("succeeded");
    expect(result.signals).toHaveLength(1);
    expect(result.signals?.[0]?.data).toMatchObject({ verdict: "pass", reason: "from-fake-acp" });

    const mcpServers = JSON.parse((await readFile(mcpFile, "utf8")).trim().split("\n")[0] as string) as Array<{
      name: string;
      command: string;
      env: Array<{ name: string; value: string }>;
    }>;
    expect(mcpServers[0]?.name).toBe("agentflow");
    expect(mcpServers[0]?.env[0]?.name).toBe("AF_SIGNAL_CONFIG");
    expect(mcpServers[0]?.env[0]?.value).toBe(join(stateRoot, "signals", "task-signal-1", "1", "config.json"));
    const lines = (await readFile(join(stateRoot, "signals", "task-signal-1", "1", "signals.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("首次挂载失败 → 同参重建一次成功（Q-07）", async () => {
    const { mcpFile, execute } = await fixture({ FAKE_ACP_EMIT_SIGNAL: "1", FAKE_ACP_MCP_FAIL_ONCE: "1" });
    const result = await execute(task());
    expect(result.status).toBe("succeeded");
    const calls = (await readFile(mcpFile, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(JSON.parse(call)[0].name).toBe("agentflow");
    }
  });

  test("挂载持续失败：failed(signal_mount_failed)，不带 signals", async () => {
    const { execute } = await fixture({ FAKE_ACP_MCP_FAIL_ALWAYS: "1" });
    const result = await execute(task());
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("signal_mount_failed");
    expect(result.signals).toBeUndefined();
  });
});
