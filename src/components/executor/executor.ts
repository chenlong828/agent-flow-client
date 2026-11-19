import { hostname } from "node:os";
import type {
  AssetPort,
  ContainerPaths,
  InstanceHandle,
  JournalPort,
  PromptOptions,
  SessionLogPort,
  RuntimeFailure,
  RuntimePort,
  SessionRef,
  SignalPort,
  WorkspacePort,
  ObservationPort,
  RunRegistryPort,
} from "./ports.ts";
import { SignalRunner, type SignalContext } from "./signal-runner.ts";
import type { SchedulerPort } from "./scheduler-port.ts";
import type { SessionOutcome } from "./ports.ts";
import type { TaskRequest, TaskResult } from "./types.ts";
import type { TaskSignal } from "../signal/contract.ts";
import { assemble, classify } from "../result/result.ts";
import { cancelledOutcome, codeOf } from "./executor-helpers.ts";

export type ExecutionContext = {
  signal: AbortSignal;
  idleTimeoutMs?: number;
};

export type RunningSnapshot = {
  taskId: string;
  instanceId: string;
  startedAt: string;
  lastEventAt?: string;
};

export type NodeExecutorOptions = {
  runtime: RuntimePort;
  workspace: WorkspacePort;
  assets: AssetPort;
  sessionLogs: SessionLogPort;
  journal: JournalPort;
  dshHome: string;
  maxResultBytes?: number;
  idleTimeoutMs?: number;
  /** 信号能力；未注入时即使任务带 `resultSignal` 也不挂 MCP（按不支持处理）。 */
  signals?: SignalPort;
  /** `session/new` 超时（A-07）；默认由 runtime 决定。 */
  sessionNewTimeoutMs?: number;
  /** 结构化事件出口（signal.*）；不参与执行语义。 */
  log?: (event: string, detail?: Record<string, unknown>) => void;
  observation?: ObservationPort;
  runs?: RunRegistryPort;
  now?: () => Date;
  host?: string;
};

type ActiveTask = {
  promise: Promise<TaskResult>;
  controller: AbortController;
  instanceId: string;
  session?: SessionRef;
  attemptId?: string;
  startedAt: string;
};

const MAX_RESULT_BYTES = 262144;
const ignore = (): undefined => undefined;
const ignoreNull = (): null => null;

/** 任务执行内核（v2）：received → running → settled；结果先落盘再交给 serve 上报。 */
export class NodeExecutor {
  readonly #options: NodeExecutorOptions;
  readonly #now: () => Date;
  readonly #host: string;
  readonly #active = new Map<string, ActiveTask>();
  readonly #instances = new Map<string, InstanceHandle>();
  readonly #signal: SignalRunner;

  constructor(options: NodeExecutorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#host = options.host ?? hostname();
    this.#signal = new SignalRunner({
      runtime: options.runtime,
      ...(options.signals === undefined ? {} : { signals: options.signals }),
      ...(options.sessionNewTimeoutMs === undefined ? {} : { sessionNewTimeoutMs: options.sessionNewTimeoutMs }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  }

  async executeTask(task: TaskRequest, ctx: ExecutionContext): Promise<TaskResult> {
    const active = this.#active.get(task.taskId);
    if (active !== undefined) return await active.promise;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const startedAt = this.#now().toISOString();
    const promise = this.#runTask(task, controller, startedAt)
      .finally(() => {
        this.#active.delete(task.taskId);
        ctx.signal.removeEventListener("abort", onAbort);
      });
    this.#active.set(task.taskId, { promise, controller, instanceId: task.instanceId, startedAt });
    return await promise;
  }

  async cancelInstance(instanceId: string): Promise<void> {
    for (const active of this.#active.values()) {
      if (active.instanceId !== instanceId) continue;
      active.controller.abort();
      if (active.session !== undefined) await this.#options.runtime.cancel(active.session).catch(ignore);
    }
  }

  async cancelAll(): Promise<void> {
    for (const active of this.#active.values()) {
      active.controller.abort();
      if (active.session !== undefined) await this.#options.runtime.cancel(active.session).catch(ignore);
    }
  }

  snapshotRunning(): RunningSnapshot[] {
    return [...this.#active.entries()].map(([taskId, active]) => ({
      taskId,
      instanceId: active.instanceId,
      startedAt: active.startedAt,
    }));
  }

  async shutdownInstances(): Promise<void> {
    for (const handle of this.#instances.values()) {
      await this.#options.runtime.shutdownInstance(handle, "force").catch(ignore);
      await this.#options.journal.clearOrphan(handle.pid).catch(ignore);
    }
    this.#instances.clear();
  }

  async #runTask(task: TaskRequest, controller: AbortController, startedAt: string): Promise<TaskResult> {
    let session: SessionRef | undefined;
    let outcome: SessionOutcome | undefined;
    let attemptId: string | null = null;
    let signalContext: SignalContext | undefined;
    try {
      const prepared = await this.#prepareTask(task, startedAt);
      session = prepared.session;
      attemptId = prepared.attemptId;
      signalContext = prepared.signalContext;
      outcome = controller.signal.aborted
        ? cancelledOutcome(session.sessionId)
        : await this.#prompt(session, task, controller, attemptId);
    } catch (error) {
      const code = codeOf(error);
      const failure: RuntimeFailure = {
        code,
        message: (error as Error).message,
        class: classify({ code, message: (error as Error).message }).class as RuntimeFailure["class"],
      };
      outcome = { sessionId: session?.sessionId ?? "", finalText: "", stopReason: null, usage: null, error: failure };
    }
    const signals = await this.#signal.collect(task, signalContext, outcome);
    const result = assemble(outcome, {
      taskId: task.taskId,
      attempt: task.attempt,
      maxResultBytes: this.#options.maxResultBytes ?? MAX_RESULT_BYTES,
      ...(signals === undefined ? {} : { signals }),
      startedAt,
      finishedAt: this.#now().toISOString(),
    });
    await this.#options.journal.mark(task.taskId, "settled", { result });
    if (attemptId !== null) await this.#options.observation?.settle(attemptId, result).catch(ignore);
    if (session !== undefined) await this.#options.runtime.closeSession(session).catch(ignore);
    if (attemptId !== null && session !== undefined) {
      await this.#options.observation?.archive(attemptId, session.sessionId, this.#options.dshHome).catch(ignore);
    }
    return result;
  }

  async #prepareTask(
    task: TaskRequest,
    startedAt: string,
  ): Promise<{ attemptId: string | null; session: SessionRef; signalContext?: SignalContext }> {
    const attemptId = await this.#options.observation?.startAttempt({
      taskId: task.taskId,
      attemptNo: task.attempt,
      instanceId: task.instanceId,
      nodeId: task.nodeId,
      ...(task.runId === undefined ? {} : { runId: task.runId }),
      startedAt,
    }).catch(ignoreNull) ?? null;
    const current = this.#active.get(task.taskId);
    if (current !== undefined && attemptId !== null) current.attemptId = attemptId;
    if (task.runId !== undefined) {
      await this.#options.runs?.upsert({
        runId: task.runId,
        instanceId: task.instanceId,
        workspacePath: task.workspacePath,
        taskSpacePath: task.taskSpacePath,
      }).catch(ignore);
    }
    await this.#options.journal.append({
      v: 2,
      ts: startedAt,
      taskId: task.taskId,
      attempt: task.attempt,
      instanceId: task.instanceId,
      nodeId: task.nodeId,
      state: "received",
    });
    const container = await this.#options.workspace.ensureContainer({ instanceId: task.instanceId, pid: 0 }, task.workspacePath);
    await this.#options.workspace.ensureTaskSpace(task.workspacePath, task.taskSpacePath);
    const handle = await this.#options.runtime.ensureInstance({
      instanceId: task.instanceId,
      dshHome: this.#options.dshHome,
      containerRoot: container.root,
    });
    this.#instances.set(task.instanceId, handle);
    await this.#options.journal.recordOrphan({
      pid: handle.pid,
      ...(handle.pgid === undefined ? {} : { pgid: handle.pgid }),
      instanceId: task.instanceId,
      taskId: task.taskId,
      createdAt: this.#now().toISOString(),
      host: this.#host,
    });
    const signalContext = await this.#signal.prepare(task);
    const session = await this.#signal.openSession({
      handle,
      cwd: container.root,
      ...(signalContext === undefined ? {} : { context: signalContext }),
      ...(task.resumeSessionId === undefined ? {} : { resumeSessionId: task.resumeSessionId }),
      taskId: task.taskId,
    });
    const active = this.#active.get(task.taskId);
    if (active !== undefined) active.session = session;
    if (attemptId !== null) await this.#options.observation?.session(attemptId, session.sessionId, container.root).catch(ignore);
    await this.#options.journal.mark(task.taskId, "running", { sessionId: session.sessionId });
    await this.#options.assets.install(task.skillSet, container);
    await this.#options.sessionLogs.clear(task.taskId, task.attempt);
    return { attemptId, session, ...(signalContext === undefined ? {} : { signalContext }) };
  }

  async #prompt(session: SessionRef, task: TaskRequest, controller: AbortController, attemptId: string | null): Promise<SessionOutcome> {
    if (attemptId !== null) await this.#options.observation?.prompt(attemptId, session.sessionId, task.prompt).catch(ignore);
    // 原始 ACP 事件按到达顺序落盘为 JSONL；`P-04` 由 CLI 在报结果前上传。
    let appends = Promise.resolve();
    const onRawEvent = (event: { ts: string; method: string; params: unknown }): void => {
      if (attemptId !== null) {
        void this.#options.observation?.observe(attemptId, session.sessionId, event.method, event.params).catch(ignore);
      }
      appends = appends.then(() =>
        this.#options.sessionLogs.append(task.taskId, task.attempt, JSON.stringify({ ...event, sessionId: session.sessionId })),
      );
    };
    const options: PromptOptions = {
      signal: controller.signal,
      timeoutMs: task.timeoutMs,
      onRawEvent,
      ...(this.#options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.#options.idleTimeoutMs }),
    };
    try {
      return await this.#options.runtime.prompt(session, task.prompt, options);
    } finally {
      await appends;
    }
  }
}
