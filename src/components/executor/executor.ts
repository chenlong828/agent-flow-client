import { hostname } from "node:os";
import type {
  AssetPort,
  ContainerPaths,
  InstanceHandle,
  JournalPort,
  PromptOptions,
  RuntimeFailure,
  RuntimePort,
  SessionRef,
  WorkspacePort,
} from "./ports.ts";
import type { SchedulerPort } from "./scheduler-port.ts";
import type { SessionOutcome } from "./ports.ts";
import type { TaskRequest, TaskResult } from "./types.ts";
import { assemble, classify } from "../result/result.ts";

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
  journal: JournalPort;
  dshHome: string;
  maxResultBytes?: number;
  idleTimeoutMs?: number;
  now?: () => Date;
  host?: string;
};

type ActiveTask = {
  promise: Promise<TaskResult>;
  controller: AbortController;
  instanceId: string;
  session?: SessionRef;
  startedAt: string;
};

const MAX_RESULT_BYTES = 262144;

/** 任务执行内核（v2）：received → running → settled；结果先落盘再交给 serve 上报。 */
export class NodeExecutor {
  readonly #options: NodeExecutorOptions;
  readonly #now: () => Date;
  readonly #host: string;
  readonly #active = new Map<string, ActiveTask>();
  readonly #instances = new Map<string, InstanceHandle>();

  constructor(options: NodeExecutorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#host = options.host ?? hostname();
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
      if (active.session !== undefined) await this.#options.runtime.cancel(active.session).catch(() => undefined);
    }
  }

  async cancelAll(): Promise<void> {
    for (const active of this.#active.values()) {
      active.controller.abort();
      if (active.session !== undefined) await this.#options.runtime.cancel(active.session).catch(() => undefined);
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
      await this.#options.runtime.shutdownInstance(handle, "force").catch(() => undefined);
      await this.#options.journal.clearOrphan(handle.pid).catch(() => undefined);
    }
    this.#instances.clear();
  }

  async #runTask(task: TaskRequest, controller: AbortController, startedAt: string): Promise<TaskResult> {
    let session: SessionRef | undefined;
    let outcome: SessionOutcome | undefined;
    try {
      await this.#options.journal.append({
        v: 2,
        ts: startedAt,
        taskId: task.taskId,
        attempt: task.attempt,
        instanceId: task.instanceId,
        nodeId: task.nodeId,
        state: "received",
      });
      const container = await this.#options.workspace.ensureContainer(
        { instanceId: task.instanceId, pid: 0 },
        task.workspacePath,
      );
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
      session = await this.#options.runtime.newSession(handle, container.root);
      const active = this.#active.get(task.taskId);
      if (active !== undefined) active.session = session;
      await this.#options.journal.mark(task.taskId, "running", { sessionId: session.sessionId });
      await this.#options.assets.install(task.skillSet, container);
      outcome = controller.signal.aborted
        ? cancelledOutcome(session.sessionId)
        : await this.#prompt(session, task, controller);
    } catch (error) {
      const failure: RuntimeFailure = {
        code: codeOf(error),
        message: (error as Error).message,
        class: classify({ code: codeOf(error), message: (error as Error).message }).class as RuntimeFailure["class"],
      };
      outcome = { sessionId: session?.sessionId ?? "", finalText: "", stopReason: null, usage: null, error: failure };
    }
    const result = assemble(outcome, {
      taskId: task.taskId,
      attempt: task.attempt,
      maxResultBytes: this.#options.maxResultBytes ?? MAX_RESULT_BYTES,
      startedAt,
      finishedAt: this.#now().toISOString(),
    });
    await this.#options.journal.mark(task.taskId, "settled", { result });
    if (session !== undefined) await this.#options.runtime.closeSession(session).catch(() => undefined);
    return result;
  }

  async #prompt(session: SessionRef, task: TaskRequest, controller: AbortController): Promise<SessionOutcome> {
    const options: PromptOptions = {
      signal: controller.signal,
      timeoutMs: task.timeoutMs,
      ...(this.#options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.#options.idleTimeoutMs }),
    };
    return await this.#options.runtime.prompt(session, task.prompt, options);
  }
}

function cancelledOutcome(sessionId: string): SessionOutcome {
  return {
    sessionId,
    finalText: "",
    stopReason: null,
    usage: null,
    error: { code: "cancelled", message: "任务被取消", class: "cancelled" },
  };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "internal_error";
}

export type { ContainerPaths };
