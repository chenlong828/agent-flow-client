import type {
  InstanceHandle,
  InstanceSpec,
  PromptOptions,
  RuntimePort,
  SessionOutcome,
  SessionRef,
  ShutdownMode,
} from "../executor/ports.ts";
import { RuntimeError } from "./errors.ts";
import { RuntimeState, type SessionState } from "./runtime-state.ts";
import { startInstance } from "./runtime-instance.ts";
import type { RuntimeOptions } from "./runtime-options.ts";

export type { RuntimeOptions } from "./runtime-options.ts";

const PROMPT_TIMEOUT_SLACK_MS = 5_000;
const CLOSE_TIMEOUT_MS = 10_000;
const CANCEL_CLOSE_MS = 500;
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * DSH 进程与 ACP 会话（CMP-runtime）：一实例一进程；一 session 同时一个 prompt；
 * 取消立即关 session 并回收进程组；结果只保留控制信息。
 */
export class AcpRuntime implements RuntimePort {
  readonly #options: RuntimeOptions;
  readonly #state: RuntimeState;

  constructor(options: RuntimeOptions) {
    this.#options = options;
    this.#state = new RuntimeState(options.onEvent);
  }

  async ensureInstance(instance: InstanceSpec): Promise<InstanceHandle> {
    const existing = this.#state.connection(instance.instanceId);
    if (existing !== undefined) {
      return { instanceId: instance.instanceId, pid: existing.pid, ...(process.platform === "win32" ? {} : { pgid: existing.pid }) };
    }
    return await startInstance(this.#options, instance, this.#state);
  }

  async newSession(instance: InstanceHandle, cwd: string): Promise<SessionRef> {
    const acp = this.#state.connection(instance.instanceId);
    if (acp === undefined) throw new RuntimeError("spawn_failed", `实例没有活跃 DSH 进程：${instance.instanceId}`);
    let result: { sessionId?: unknown };
    try {
      result = (await acp.request("session/new", { cwd, mcpServers: [] }, 10_000)) as { sessionId?: unknown };
    } catch (error) {
      throw asRuntimeError(error, "protocol_error", "session/new 失败");
    }
    if (typeof result.sessionId !== "string" || result.sessionId === "") {
      throw new RuntimeError("protocol_error", "session/new 没有返回 sessionId");
    }
    const ref: SessionRef = { sessionId: result.sessionId, instanceId: instance.instanceId };
    this.#state.addSession(ref);
    return ref;
  }

  async prompt(session: SessionRef, text: string, opts: PromptOptions): Promise<SessionOutcome> {
    const state = this.#state.session(session.sessionId);
    const acp = this.#state.connection(session.instanceId);
    if (acp === undefined) throw new RuntimeError("spawn_failed", `实例没有活跃 DSH 进程：${session.instanceId}`);
    state.finalText = "";
    state.usage = null;
    state.stopReason = null;
    state.error = undefined;
    state.timedOut = false;
    state.cancelRequested = false;

    const cancelPrompt = (): void => acp.notify("session/cancel", { sessionId: session.sessionId });
    const timer = setTimeout(() => {
      state.timedOut = true;
      cancelPrompt();
    }, opts.timeoutMs);
    opts.signal.addEventListener("abort", cancelPrompt, { once: true });

    try {
      const result = (await acp.request(
        "session/prompt",
        { sessionId: session.sessionId, prompt: [{ type: "text", text }] },
        opts.timeoutMs + PROMPT_TIMEOUT_SLACK_MS,
      )) as { stopReason?: unknown };
      state.stopReason = typeof result.stopReason === "string" ? result.stopReason : null;
    } catch (error) {
      if (!state.timedOut && !opts.signal.aborted && !state.cancelRequested) {
        const failure = asRuntimeError(error, "prompt_failed", "prompt 失败");
        state.error = { code: failure.code, message: failure.message, class: failure.code === "timeout" ? "timeout" : "runtime" };
      }
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", cancelPrompt);
    }

    if (state.timedOut) {
      state.error = { code: "timeout", message: `prompt 超时（${opts.timeoutMs}ms）`, class: "timeout" };
      const outcome = outcomeOf(state);
      await this.cancel(session).catch(() => undefined);
      return outcome;
    }
    if (opts.signal.aborted || state.cancelRequested) {
      state.error = { code: "cancelled", message: "prompt 被取消", class: "cancelled" };
    }
    return outcomeOf(state);
  }

  async cancel(session: SessionRef): Promise<void> {
    const state = this.#state.connection(session.instanceId) === undefined ? undefined : safeSession(this.#state, session.sessionId);
    if (state !== undefined) state.cancelRequested = true;
    const acp = this.#state.connection(session.instanceId);
    if (acp === undefined) return;
    acp.notify("session/cancel", { sessionId: session.sessionId });
    await acp.request("session/close", { sessionId: session.sessionId }, CANCEL_CLOSE_MS).catch(() => undefined);
    acp.kill("SIGKILL");
    await acp.waitExit(2_000);
    this.#state.removeInstance(session.instanceId);
  }

  async closeSession(session: SessionRef): Promise<void> {
    const acp = this.#state.connection(session.instanceId);
    if (acp === undefined) return;
    try {
      await acp.request("session/close", { sessionId: session.sessionId }, CLOSE_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof RuntimeError) || !/unknown session/.test(error.message)) {
        this.#options.onStderr?.(`session/close 失败：${(error as Error).message}`);
      }
    }
    this.#state.deleteSession(session.sessionId);
  }

  async shutdownInstance(instance: InstanceHandle, mode: ShutdownMode): Promise<void> {
    const acp = this.#state.connection(instance.instanceId);
    if (acp === undefined) return;
    if (mode === "force") {
      acp.kill("SIGKILL");
      await acp.waitExit(SHUTDOWN_GRACE_MS);
    } else {
      await acp.close(SHUTDOWN_GRACE_MS);
    }
    this.#state.removeInstance(instance.instanceId);
  }

  /** 回收孤儿进程组（CLI 启动恢复时调用；不进入 RuntimePort）。 */
  async reapOrphan(orphan: { pid: number; pgid?: number }): Promise<boolean> {
    const target = orphan.pgid ?? orphan.pid;
    try {
      process.kill(process.platform === "win32" ? target : -target, "SIGKILL");
      return true;
    } catch {
      try {
        process.kill(orphan.pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    }
  }
}

function safeSession(state: RuntimeState, sessionId: string): SessionState | undefined {
  try {
    return state.session(sessionId);
  } catch {
    return undefined;
  }
}

function outcomeOf(state: SessionState): SessionOutcome {
  return {
    sessionId: state.ref.sessionId,
    finalText: state.finalText,
    stopReason: state.stopReason,
    usage: state.usage,
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

function asRuntimeError(error: unknown, fallback: "protocol_error" | "prompt_failed", prefix: string): RuntimeError {
  return error instanceof RuntimeError ? error : new RuntimeError(fallback, `${prefix}：${(error as Error).message}`);
}
