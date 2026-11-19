/** 执行流程里的信号编排（prepare → 挂载重试 → collect），把文件/进程细节挡在 executor 之外。 */
import type { InstanceHandle, RuntimePort, SessionOutcome, SessionRef, SignalPort } from "./ports.ts";
import {
  SIGNAL_KIND_CONFIRMATION_REQUEST,
  isSupportedContract,
  type ResultSignalContract,
  type TaskSignal,
} from "../signal/contract.ts";
import type { SignalPlan } from "../signal/plan.ts";
import { isSignalMountError } from "../signal/mcp.ts";
import { SignalError } from "../signal/signal.ts";
import type { TaskRequest } from "./types.ts";
import { ExecutorError } from "./executor-helpers.ts";

/**
 * 一次 attempt 的信号上下文：`resultSignalKind` 是必需结果契约的 kind（只有 `confirmation` 时为
 * undefined，用于续跑时区分「本来就不预期」与「该交没交」）。
 */
export type SignalContext = { resultSignalKind?: string; plan: SignalPlan };

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

  /**
   * 收集 `[resultSignal, confirmation]` 里的契约，一次 attempt 挂一个 server、每契约一个工具。
   * - 两个都缺省：不建目录、不挂 server，按旧行为执行；
   * - `resultSignal` 不支持：沿用旧降级（`signal.disabled`，整个 attempt 无信号）；
   * - `confirmation` 不支持：只跳过它并记 `signal.partial`（可选契约，不判失败）；
   * - `confirmation.kind` 不是 `confirmation_request`：`signal_prepare_failed`，不静默改 kind。
   */
  async prepare(task: TaskRequest): Promise<SignalContext | undefined> {
    const { resultSignal, confirmation } = task;
    if (resultSignal === undefined && confirmation === undefined) return undefined;
    if (this.#options.signals === undefined) {
      this.log("signal.disabled", { taskId: task.taskId, reason: "signal_component_missing" });
      return undefined;
    }
    if (confirmation !== undefined && confirmation.kind !== SIGNAL_KIND_CONFIRMATION_REQUEST) {
      throw new SignalError(
        "signal_prepare_failed",
        `confirmation.kind 必须是 ${SIGNAL_KIND_CONFIRMATION_REQUEST}，收到 ${confirmation.kind}`,
      );
    }
    if (resultSignal !== undefined && !isSupportedContract(resultSignal)) {
      this.log("signal.disabled", {
        taskId: task.taskId,
        reason: `不支持 version=${resultSignal.version} kind=${resultSignal.kind}`,
      });
      return undefined;
    }
    const contracts: ResultSignalContract[] = resultSignal === undefined ? [] : [resultSignal];
    if (confirmation !== undefined) {
      if (isSupportedContract(confirmation)) {
        contracts.push(confirmation);
      } else {
        this.log("signal.partial", {
          taskId: task.taskId,
          attempt: task.attempt,
          kind: confirmation.kind,
          reason: `不支持 version=${confirmation.version}`,
        });
      }
    }
    if (contracts.length === 0) return undefined;
    const prepared = await this.#options.signals.prepare({
      taskId: task.taskId,
      attempt: task.attempt,
      contracts: contracts.map((contract) => ({ kind: contract.kind, schema: contract.schema })),
    });
    if (prepared.status === "unsupported") {
      this.log("signal.disabled", { taskId: task.taskId, reason: prepared.reason });
      return undefined;
    }
    this.log("signal.prepared", {
      taskId: task.taskId,
      attempt: task.attempt,
      kinds: prepared.plan.contracts.map((contract) => contract.kind),
    });
    return {
      ...(resultSignal === undefined ? {} : { resultSignalKind: resultSignal.kind }),
      plan: prepared.plan,
    };
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
        plan: context.plan,
      });
    } catch (error) {
      this.log("signal.invalid", { taskId: task.taskId, reason: (error as Error).message });
      return undefined;
    }
    if (signals === undefined) {
      if (outcome.error !== undefined) return undefined;
      const continuation = task.resumeSessionId !== undefined;
      // 续跑任务的默认前提是「本来就不该再交一次信号」；只有必需结果契约（review 的 verdict）
      // 仍必须在续跑后交付，缺了要记 signal.missing，让 orchestrator 按 verdict_invalid 暴露。
      const requiredAfterResume =
        context.resultSignalKind !== undefined && context.resultSignalKind !== SIGNAL_KIND_CONFIRMATION_REQUEST;
      if (continuation && !requiredAfterResume) {
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
    this.log("signal.collected", {
      taskId: task.taskId,
      count: signals.length,
      kinds: [...new Set(signals.map((signal) => signal.kind))],
    });
    return signals;
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.#options.log?.(event, detail);
  }
}
