/** 执行流程里的信号编排（prepare → 挂载重试 → collect），把文件/进程细节挡在 executor 之外。 */
import type { InstanceHandle, RuntimePort, SessionOutcome, SessionRef, SignalPort } from "./ports.ts";
import { SIGNAL_KIND_CONFIRMATION_REQUEST, type ResultSignalContract, type TaskSignal } from "../signal/contract.ts";
import type { SignalPlan } from "../signal/plan.ts";
import { isSignalMountError } from "../signal/mcp.ts";
import type { TaskRequest } from "./types.ts";
import { ExecutorError } from "./executor-helpers.ts";

export type SignalContext = { contract: ResultSignalContract; plan: SignalPlan };

export type SignalRunnerOptions = {
  runtime: RuntimePort;
  signals?: SignalPort;
  sessionNewTimeoutMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

export class SignalRunner {
  readonly #options: SignalRunnerOptions;

  constructor(options: SignalRunnerOptions) {
    this.#options = options;
  }

  /** 只有任务带 `resultSignal` 且 client 支持该契约时才准备；其余返回 undefined（按旧行为执行）。 */
  async prepare(task: TaskRequest): Promise<SignalContext | undefined> {
    const contract = task.resultSignal;
    if (contract === undefined) return undefined;
    if (this.#options.signals === undefined) {
      this.log("signal.disabled", { taskId: task.taskId, reason: "signal_component_missing" });
      return undefined;
    }
    const prepared = await this.#options.signals.prepare({ taskId: task.taskId, attempt: task.attempt, contract });
    if (prepared.status === "unsupported") {
      this.log("signal.disabled", { taskId: task.taskId, reason: prepared.reason });
      return undefined;
    }
    this.log("signal.prepared", { taskId: task.taskId, attempt: task.attempt, kind: contract.kind });
    return { contract, plan: prepared.plan };
  }

  /**
   * 建/续 session：`resumeSessionId` 存在时走 `session/resume`（§5.5）；
   * 挂载失败按 Q-07 用相同 `mcpServers` 重建一次，仍失败归 `signal_mount_failed`（Q-09 归因）。
   */
  async openSession(input: {
    handle: InstanceHandle;
    cwd: string;
    context?: SignalContext;
    resumeSessionId?: string;
    taskId: string;
  }): Promise<SessionRef> {
    const { handle, cwd, context, resumeSessionId } = input;
    const opts = {
      ...(context === undefined ? {} : { mcpServers: context.plan.mcpServers }),
      ...(this.#options.sessionNewTimeoutMs === undefined ? {} : { timeoutMs: this.#options.sessionNewTimeoutMs }),
    };
    const open = async (): Promise<SessionRef> => {
      if (resumeSessionId === undefined) return await this.#options.runtime.newSession(handle, cwd, opts);
      try {
        return await this.#options.runtime.resumeSession(handle, resumeSessionId, cwd, opts);
      } catch (error) {
        // 只补诊断信息，不改错误码（仍是 protocol_error）。
        this.log("signal.resume_failed", {
          taskId: input.taskId,
          sessionId: resumeSessionId,
          cwd,
          mcpServers: context?.plan.mcpServers.length ?? 0,
          cause: (error as Error).message,
        });
        throw error;
      }
    };
    if (context === undefined) return await open();
    try {
      return await open();
    } catch (error) {
      if (!isSignalMountError(error)) throw error;
      this.log("signal.mount_retry", { taskId: context.plan.taskId, reason: (error as Error).message });
      try {
        return await open();
      } catch (second) {
        if (!isSignalMountError(second)) throw second;
        throw new ExecutorError("signal_mount_failed", `MCP 信号挂载失败：${(second as Error).message}`);
      }
    }
  }

  /** collect 在 closeSession 之前（A-05）；异常只记日志，不把任务判失败。 */
  async collect(task: TaskRequest, context: SignalContext | undefined, outcome: SessionOutcome): Promise<TaskSignal[] | undefined> {
    if (context === undefined || this.#options.signals === undefined) return undefined;
    let signals: TaskSignal[] | undefined;
    try {
      signals = await this.#options.signals.collect({
        taskId: task.taskId,
        attempt: task.attempt,
        contract: context.contract,
        plan: context.plan,
      });
    } catch (error) {
      this.log("signal.invalid", { taskId: task.taskId, reason: (error as Error).message });
      return undefined;
    }
    if (signals === undefined) {
      if (outcome.error !== undefined) return undefined;
      const continuation = task.resumeSessionId !== undefined;
      if (continuation && context.contract.kind === SIGNAL_KIND_CONFIRMATION_REQUEST) {
        // 确认点的续跑任务本来就不预期再调一次 confirm（续跑不阻塞、不重复确认）。
        this.log("signal.not_expected", {
          taskId: task.taskId,
          attempt: task.attempt,
          reason: "continuation",
          resumeSessionId: task.resumeSessionId,
        });
        return undefined;
      }
      this.log("signal.missing", {
        taskId: task.taskId,
        attempt: task.attempt,
        ...(continuation ? { reason: "continuation", resumeSessionId: task.resumeSessionId } : {}),
      });
      return undefined;
    }
    this.log("signal.collected", { taskId: task.taskId, count: signals.length, kind: context.contract.kind });
    return signals;
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.#options.log?.(event, detail);
  }
}
