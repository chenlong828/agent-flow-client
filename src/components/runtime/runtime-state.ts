import type { InstanceHandle, SessionEvent, SessionOutcome, SessionRef } from "../executor/ports.ts";
import type { AcpConnection } from "./acp-client.ts";

export type SessionState = {
  ref: SessionRef;
  finalText: string;
  usage: SessionOutcome["usage"];
  stopReason: string | null;
  error?: SessionOutcome["error"];
  timedOut: boolean;
  idleTimedOut: boolean;
  cancelRequested: boolean;
  lastEventAt: number;
};

/** 运行期注册表：连接、实例、session 与事件累积；不持久化。 */
export class RuntimeState {
  readonly #instances = new Map<string, InstanceHandle>();
  readonly #connections = new Map<string, AcpConnection>();
  readonly #sessions = new Map<string, SessionState>();
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;
  #rawSink: ((method: string, params: unknown) => void) | undefined;

  constructor(onEvent?: (event: SessionEvent) => void) {
    this.#onEvent = onEvent;
  }

  /** 原始 ACP 事件出口（`P-04`）；只在该 session 的 prompt 期间生效。 */
  setRawSink(sink: ((method: string, params: unknown) => void) | undefined): void {
    this.#rawSink = sink;
  }

  connection(instanceId: string): AcpConnection | undefined {
    return this.#connections.get(instanceId);
  }

  session(sessionId: string): SessionState {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) throw new Error(`未知 session：${sessionId}`);
    return state;
  }

  addConnection(instanceId: string, handle: InstanceHandle, connection: AcpConnection): void {
    this.#instances.set(instanceId, handle);
    this.#connections.set(instanceId, connection);
  }

  addSession(ref: SessionRef): SessionState {
    const state: SessionState = {
      ref,
      finalText: "",
      usage: null,
      stopReason: null,
      timedOut: false,
      idleTimedOut: false,
      cancelRequested: false,
      lastEventAt: Date.now(),
    };
    this.#sessions.set(ref.sessionId, state);
    return state;
  }

  deleteSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  removeInstance(instanceId: string): void {
    this.#connections.delete(instanceId);
    this.#instances.delete(instanceId);
    for (const [sessionId, state] of this.#sessions) {
      if (state.ref.instanceId === instanceId) this.#sessions.delete(sessionId);
    }
  }

  applyNotification(method: string, params: unknown): void {
    this.#rawSink?.(method, params);
    if (method !== "session/update") return;
    const sessionId = String((params as { sessionId?: unknown } | undefined)?.sessionId ?? "");
    const update = (params as { update?: Record<string, unknown> } | undefined)?.update ?? {};
    const state = this.#sessions.get(sessionId);
    if (state !== undefined) state.lastEventAt = Date.now();
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (state !== undefined && content?.type === "text" && typeof content.text === "string") {
        state.finalText += content.text;
      }
      this.#onEvent?.({ kind: "text", sessionId });
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      if (state !== undefined) state.usage = normalizeUsage(update);
      this.#onEvent?.({ kind: "usage", sessionId });
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.#onEvent?.({ kind: "tool", sessionId, detail: String(update.title ?? "") });
    }
  }

  countSessions(instanceId: string): number {
    let count = 0;
    for (const state of this.#sessions.values()) if (state.ref.instanceId === instanceId) count += 1;
    return count;
  }


}

function normalizeUsage(update: Record<string, unknown>): SessionOutcome["usage"] {
  const pick = (key: string): number | undefined => (typeof update[key] === "number" ? (update[key] as number) : undefined);
  const inputTokens = pick("inputTokens");
  const outputTokens = pick("outputTokens");
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}
