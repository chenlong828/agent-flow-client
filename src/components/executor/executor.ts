import { hostname } from "node:os";
import { join } from "node:path";
import type {
  AssetPort,
  AttemptState,
  CleanupPolicy,
  ContainerPaths,
  InstanceHandle,
  JournalPort,
  NodeRequest,
  NodeResult,
  RuntimeFailure,
  RuntimePort,
  SessionRef,
  WorkspacePort,
} from "./ports.ts";
import type { CleanupAck, CleanupPending, SchedulerPort } from "./scheduler-port.ts";
import { assemble, classify } from "../result/result.ts";

export type ExecutionContext = {
  signal: AbortSignal;
};

export type RecoveryReport = {
  abandoned: string[];
  reReported: string[];
  pendingReports: string[];
};

export type NodeExecutorOptions = {
  scheduler: SchedulerPort;
  runtime: RuntimePort;
  workspace: WorkspacePort;
  assets: AssetPort;
  journal: JournalPort;
  dshHome: string;
  maxResultBytes?: number;
  cleanupPolicy?: CleanupPolicy;
  now?: () => Date;
  host?: string;
};

type ActiveAttempt = {
  promise: Promise<NodeResult>;
  controller: AbortController;
  instanceId: string;
  phase: AttemptState;
  sessionId?: string;
};

const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const RESULT_CACHE_LIMIT = 128;

/** 节点尝试状态机与执行序列（CMP-executor）；对预期失败返回 NodeResult。 */
export class NodeExecutor {
  readonly #options: NodeExecutorOptions;
  readonly #now: () => Date;
  readonly #host: string;
  readonly #active = new Map<string, ActiveAttempt>();
  readonly #results = new Map<string, NodeResult>();
  readonly #handles = new Map<string, InstanceHandle>();

  constructor(options: NodeExecutorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#host = options.host ?? hostname();
  }

  async executeNode(request: NodeRequest, ctx: ExecutionContext): Promise<NodeResult> {
    const active = this.#active.get(request.attemptId);
    if (active !== undefined) return await active.promise;
    const cached = this.#results.get(request.attemptId);
    if (cached !== undefined) return cached;

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const promise = this.#runAttempt(request, controller)
      .then((result) => {
        this.#remember(request.attemptId, result);
        return result;
      })
      .finally(() => {
        this.#active.delete(request.attemptId);
        ctx.signal.removeEventListener("abort", onAbort);
      });
    this.#active.set(request.attemptId, { promise, controller, instanceId: request.instanceId, phase: "claimed" });
    return await promise;
  }

  setMaxResultBytes(maxResultBytes: number): void {
    this.#options.maxResultBytes = maxResultBytes;
  }

  async cancelInstance(instanceId: string, _reason = "user_cancel"): Promise<void> {
    for (const [attemptId, active] of this.#active) {
      if (active.instanceId !== instanceId) continue;
      active.controller.abort();
      if (active.sessionId !== undefined) {
        await this.#options.runtime.cancel({ sessionId: active.sessionId, instanceId }).catch(() => undefined);
      }
      void attemptId;
    }
  }

  async recover(instanceId?: string): Promise<RecoveryReport> {
    const pending = instanceId === undefined ? await this.#options.journal.pendingAll() : await this.#options.journal.pending(instanceId);
    const report: RecoveryReport = { abandoned: [], reReported: [], pendingReports: [] };
    for (const record of pending) {
      if (record.result !== undefined && (record.state === "settled" || record.state === "reported")) {
        try {
          await this.#options.scheduler.reportResult(record.attemptId, record.result);
          await this.#options.journal.mark(record.attemptId, "reported");
          await this.#options.journal.mark(record.attemptId, "closed");
          report.reReported.push(record.attemptId);
        } catch {
          report.pendingReports.push(record.attemptId);
        }
        continue;
      }
      await this.#options.journal.mark(record.attemptId, "abandoned");
      report.abandoned.push(record.attemptId);
    }
    return report;
  }

  snapshotAttempts(): { attemptId: string; instanceId: string; phase: string; sessionId?: string }[] {
    return [...this.#active.entries()].map(([attemptId, active]) => ({
      attemptId,
      instanceId: active.instanceId,
      phase: active.phase,
      ...(active.sessionId === undefined ? {} : { sessionId: active.sessionId }),
    }));
  }

  async reconcileCleanup(pending: CleanupPending[]): Promise<CleanupAck[]> {
    const acks: CleanupAck[] = [];
    for (const item of pending) {
      try {
        await this.cancelInstance(item.instanceId);
        const handle = this.#handles.get(item.instanceId);
        if (handle !== undefined) {
          await this.#options.runtime.shutdownInstance(handle, "force");
          await this.#options.workspace.cleanup(handle, item.cleanup ?? this.#options.cleanupPolicy ?? "keep");
          this.#handles.delete(item.instanceId);
        }
        for (const orphan of await this.#options.journal.listOrphans(item.instanceId)) {
          await this.#options.journal.clearOrphan(orphan.pid);
        }
        acks.push({ releaseId: item.releaseId, status: "done", completedAt: this.#now().toISOString() });
      } catch (error) {
        acks.push({
          releaseId: item.releaseId,
          status: "failed",
          completedAt: this.#now().toISOString(),
          errorClass: classify({ code: codeOf(error), message: (error as Error).message }).class,
          retryable: false,
        });
      }
    }
    return acks;
  }

  async #runAttempt(request: NodeRequest, controller: AbortController): Promise<NodeResult> {
    const startedAt = this.#now().toISOString();
    let session: SessionRef | undefined;
    let outcome: Parameters<typeof assemble>[0];
    try {
      await this.#options.journal.append({
        v: 1,
        ts: startedAt,
        attemptId: request.attemptId,
        instanceId: request.instanceId,
        nodeId: request.nodeId,
        state: "claimed",
      });
      const container = await this.#options.workspace.ensureContainer(
        { instanceId: request.instanceId, pid: 0 },
        request.workspacePath,
      );
      const handle = await this.#options.runtime.ensureInstance({
        instanceId: request.instanceId,
        dshHome: this.#options.dshHome,
        containerRoot: container.root,
      });
      this.#handles.set(request.instanceId, handle);
      await this.#options.journal.recordOrphan({
        pid: handle.pid,
        ...(handle.pgid === undefined ? {} : { pgid: handle.pgid }),
        instanceId: request.instanceId,
        attemptId: request.attemptId,
        createdAt: this.#now().toISOString(),
        host: this.#host,
      });
      session = await this.#options.runtime.newSession(handle, container.root);
      const boundActive = this.#active.get(request.attemptId);
      if (boundActive !== undefined) {
        boundActive.phase = "bound";
        boundActive.sessionId = session.sessionId;
      }
      await this.#options.journal.mark(request.attemptId, "bound", { sessionId: session.sessionId });

      const skillSet = await this.#options.scheduler.bindSession(request.attemptId, session.sessionId);
      await this.#options.assets.install(skillSet, container);
      const readyActive = this.#active.get(request.attemptId);
      if (readyActive !== undefined) readyActive.phase = "ready";
      await this.#options.journal.mark(request.attemptId, "ready");

      const runningActive = this.#active.get(request.attemptId);
      if (runningActive !== undefined) runningActive.phase = "running";
      await this.#options.journal.mark(request.attemptId, "running");
      outcome = controller.signal.aborted
        ? { sessionId: session.sessionId, finalText: "", stopReason: null, usage: null, error: { code: "cancelled", message: "prompt 被取消", class: "cancelled" } }
        : await this.#options.runtime.prompt(session, request.prompt, {
            signal: controller.signal,
            timeoutMs: request.timeoutMs,
          });
    } catch (error) {
      const failure: RuntimeFailure = {
        code: codeOf(error),
        message: (error as Error).message,
        class: classify({ code: codeOf(error), message: (error as Error).message }).class as RuntimeFailure["class"],
      };
      outcome = { sessionId: session?.sessionId ?? "", finalText: "", stopReason: null, usage: null, error: failure };
    }
    return await this.#finish(request, session, outcome, startedAt);
  }

  async #finish(
    request: NodeRequest,
    session: SessionRef | undefined,
    outcome: Parameters<typeof assemble>[0],
    startedAt: string,
  ): Promise<NodeResult> {
    const result = assemble(outcome, {
      attemptId: request.attemptId,
      maxResultBytes: this.#options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
      startedAt,
      finishedAt: this.#now().toISOString(),
    });
    await this.#options.journal.mark(request.attemptId, "settled", { result });
    try {
      await this.#options.scheduler.reportResult(request.attemptId, result);
      await this.#options.journal.mark(request.attemptId, "reported");
    } catch {
      // 上报失败保留 settled，下次启动重报（R-02）。
    }
    if (session !== undefined) await this.#options.runtime.closeSession(session).catch(() => undefined);
    await this.#options.journal.mark(request.attemptId, "closed");
    return result;
  }

  #remember(attemptId: string, result: NodeResult): void {
    this.#results.set(attemptId, result);
    if (this.#results.size > RESULT_CACHE_LIMIT) {
      const oldest = this.#results.keys().next().value;
      if (oldest !== undefined) this.#results.delete(oldest);
    }
  }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "internal_error";
}

/** 供测试/诊断：把容器路径拼到实例 home 下（S1 多实例派生用）。 */
export function instanceHome(base: string, instanceId: string): string {
  return join(base, "instances", instanceId);
}
