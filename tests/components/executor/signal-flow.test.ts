import { describe, expect, test } from "bun:test";
import { NodeExecutor } from "../../../src/components/executor/executor.ts";
import type {
  InstanceHandle,
  PromptOptions,
  RuntimePort,
  SessionOutcome,
  SessionRef,
  SignalPort,
  SignalPrepareResult,
} from "../../../src/components/executor/ports.ts";
import { RuntimeError } from "../../../src/components/runtime/errors.ts";
import { SignalError } from "../../../src/components/signal/signal.ts";
import type { ResultSignalContract, TaskSignal } from "../../../src/components/signal/contract.ts";
import type { SignalPlan } from "../../../src/components/signal/plan.ts";
import type { TaskRequest } from "../../../src/components/executor/types.ts";
import { reviewVerdictContract } from "../../support/signal-contract.ts";
import { FakeAssets, FakeSessionLogs, FakeWorkspace, MemoryJournal } from "./fakes.ts";

const mountError = (): RuntimeError =>
  new RuntimeError("prompt_failed", "-32603: Internal error", {
    details: "mcp-client(agentflow): initial connection or tool synchronization failed",
  });

class MountRuntime implements RuntimePort {
  calls: Array<{ cwd: string; mcpServers?: unknown }> = [];
  resumed: string[] = [];
  prompts: string[] = [];
  closed: string[] = [];
  readonly #failures: Array<Error | undefined>;
  #session = 0;

  constructor(failures: Array<Error | undefined> = []) {
    this.#failures = [...failures];
  }

  async ensureInstance(instance: { instanceId: string }): Promise<InstanceHandle> {
    return { instanceId: instance.instanceId, pid: 1 };
  }

  async newSession(instance: InstanceHandle, cwd: string, opts?: { mcpServers?: unknown[] }): Promise<SessionRef> {
    this.calls.push({ cwd, ...(opts?.mcpServers === undefined ? {} : { mcpServers: opts.mcpServers }) });
    const failure = this.#failures.shift();
    if (failure !== undefined) throw failure;
    this.#session += 1;
    return { sessionId: `s-${this.#session}`, instanceId: instance.instanceId };
  }

  async resumeSession(instance: InstanceHandle, sessionId: string): Promise<SessionRef> {
    this.resumed.push(sessionId);
    return { sessionId, instanceId: instance.instanceId };
  }

  async prompt(session: SessionRef, text: string, _opts: PromptOptions): Promise<SessionOutcome> {
    this.prompts.push(text);
    return { sessionId: session.sessionId, finalText: "OK", stopReason: "end_turn", usage: null };
  }

  async cancel(): Promise<void> {}
  async closeSession(session: SessionRef): Promise<void> {
    this.closed.push(session.sessionId);
  }
  async shutdownInstance(): Promise<void> {}
  activeSessions(): number {
    return 0;
  }
}

const plan: SignalPlan = {
  taskId: "task-1",
  attempt: 1,
  kind: "review_verdict",
  dir: "/tmp/signals/task-1/1",
  configPath: "/tmp/signals/task-1/1/config.json",
  outputPath: "/tmp/signals/task-1/1/signals.jsonl",
  mcpServers: [{ name: "agentflow", command: "/bin/bun", args: ["/srv/signal-server.ts"], env: [{ name: "AF_SIGNAL_CONFIG", value: "/tmp/signals/task-1/1/config.json" }] }],
};

class FakeSignal implements SignalPort {
  order: string[] = [];
  prepared = 0;
  collected = 0;
  result: TaskSignal[] | undefined = [
    { seq: 1, at: "2026-11-18T00:00:00.000Z", kind: "review_verdict", data: { verdict: "pass", reason: "ok" } },
  ];
  prepareResult: SignalPrepareResult = { status: "ok", plan };
  prepareError?: Error;
  collectError?: Error;

  async prepare(): Promise<SignalPrepareResult> {
    this.prepared += 1;
    this.order.push("prepare");
    if (this.prepareError !== undefined) throw this.prepareError;
    return this.prepareResult;
  }

  async collect(): Promise<TaskSignal[] | undefined> {
    this.collected += 1;
    this.order.push("collect");
    if (this.collectError !== undefined) throw this.collectError;
    return this.result;
  }

  async cleanup(): Promise<number> {
    return 0;
  }
}

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
    resultSignal: reviewVerdictContract,
    ...overrides,
  };
}

function setup(options: { failures?: Array<Error | undefined>; signals?: SignalPort; contract?: ResultSignalContract } = {}) {
  const runtime = new MountRuntime(options.failures);
  const signal = new FakeSignal();
  const events: string[] = [];
  const executor = new NodeExecutor({
    runtime,
    workspace: new FakeWorkspace(),
    assets: new FakeAssets(),
    sessionLogs: new FakeSessionLogs(),
    journal: new MemoryJournal(),
    dshHome: "/tmp/afc-home",
    maxResultBytes: 4096,
    ...(options.signals === undefined ? (options.contract === undefined ? { signals: signal } : { signals: signal }) : { signals: options.signals }),
    log: (event) => events.push(event),
    now: () => new Date("2026-11-18T00:00:00.000Z"),
  });
  return { executor, runtime, signal, events };
}

const signal = () => new AbortController().signal;

describe("executor × CMP-signal", () => {
  test("挂载失败后用相同 mcpServers 重建一次（Q-07），不降级", async () => {
    const { executor, runtime, signal: signals } = setup({ failures: [mountError()] });
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[0]?.mcpServers).toEqual(plan.mcpServers);
    expect(runtime.calls[1]?.mcpServers).toEqual(plan.mcpServers);
    expect(signals.collected).toBe(1);
    expect(result.signals).toHaveLength(1);
  });

  test("两次都失败：failed(signal_mount_failed)，不 prompt", async () => {
    const { executor, runtime } = setup({ failures: [mountError(), mountError()] });
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("signal_mount_failed");
    expect(result.error?.class).toBe("protocol");
    expect(runtime.prompts).toHaveLength(0);
    expect(result.signals).toBeUndefined();
  });

  test("非 MCP 失败不重试、不归因 signal（Q-09）", async () => {
    const { executor, runtime } = setup({ failures: [new RuntimeError("spawn_failed", "DSH 启动失败")] });
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(runtime.calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("spawn_failed");
  });

  test("collect 在 closeSession 之前（A-05）", async () => {
    const { executor, runtime, signal: signals } = setup();
    const original = runtime.closeSession.bind(runtime);
    runtime.closeSession = async (session) => {
      signals.order.push("close");
      await original(session);
    };
    await executor.executeTask(task(), { signal: signal() });
    expect(signals.order).toEqual(["prepare", "collect", "close"]);
  });

  test("不支持的契约：不挂 MCP、不采集、任务照常执行", async () => {
    const { executor, runtime, signal: signals } = setup();
    signals.prepareResult = { status: "unsupported", reason: "不支持 version=2" };
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(runtime.calls[0]?.mcpServers).toBeUndefined();
    expect(signals.collected).toBe(0);
  });

  test("prepare 失败：任务 failed(signal_prepare_failed)，不建 session", async () => {
    const { executor, runtime, signal: signals } = setup();
    signals.prepareError = new SignalError("signal_prepare_failed", "磁盘满");
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "signal_prepare_failed", class: "protocol" });
    expect(runtime.calls).toHaveLength(0);
  });

  test("collect 异常只记日志，不影响任务结果", async () => {
    const { executor, events, signal: signals } = setup();
    signals.collectError = new SignalError("signal_invalid", "文件损坏");
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(result.signals).toBeUndefined();
    expect(events).toContain("signal.invalid");
  });

  test("模型没调用工具：记 signal.missing，结果不带 signals", async () => {
    const { executor, events, signal: signals } = setup();
    signals.result = undefined;
    const result = await executor.executeTask(task(), { signal: signal() });
    expect(result.status).toBe("succeeded");
    expect(result.signals).toBeUndefined();
    expect(events).toContain("signal.missing");
  });

  test("任务没有 resultSignal：不准备、不挂 MCP", async () => {
    const { executor, runtime, signal: signals } = setup();
    await executor.executeTask(task({ resultSignal: undefined }), { signal: signal() });
    expect(signals.prepared).toBe(0);
    expect(runtime.calls[0]?.mcpServers).toBeUndefined();
  });
});

const confirmationContract: ResultSignalContract = {
  version: 1,
  kind: "confirmation_request",
  required: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: { question: { type: "string", maxLength: 2048 }, context: { type: "string", maxLength: 8192 } },
  },
};

describe("§5.5 续跑（client 能力预留）", () => {
  test("带 resumeSessionId 时走 session/resume，并重新挂载 mcpServers", async () => {
    const { executor, runtime } = setup();
    await executor.executeTask(task({ resumeSessionId: "s-old" }), { signal: signal() });
    expect(runtime.resumed).toEqual(["s-old"]);
    expect(runtime.calls).toHaveLength(0);
  });
});

describe("续跑与信号语义", () => {
  test("确认点续跑不报 signal.missing，改报 signal.not_expected", async () => {
    const { executor, events, signal: signals } = setup();
    signals.result = undefined;
    await executor.executeTask(task({ resumeSessionId: "s-old", resultSignal: confirmationContract }), {
      signal: signal(),
    });
    expect(events).toContain("signal.not_expected");
    expect(events).not.toContain("signal.missing");
  });

  test("review 续跑没交判决仍报 signal.missing（带 reason=continuation）", async () => {
    const { executor, events, signal: signals } = setup();
    signals.result = undefined;
    await executor.executeTask(task({ resumeSessionId: "s-old" }), { signal: signal() });
    expect(events).toContain("signal.missing");
  });
});
