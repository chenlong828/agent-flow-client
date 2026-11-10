import type { PromptOptions } from "../executor/ports.ts";
import type { SessionState } from "./runtime-state.ts";

/** 总超时 + 可选 idle 看门狗；只负责触发 cancel 通知，不等待结算。 */
export function startPromptTimers(state: SessionState, opts: PromptOptions, cancel: () => void): () => void {
  const timer = setTimeout(() => {
    state.timedOut = true;
    cancel();
  }, opts.timeoutMs);

  const idleTimeoutMs = opts.idleTimeoutMs ?? 0;
  const idleTimer =
    idleTimeoutMs > 0
      ? setInterval(() => {
          if (Date.now() - state.lastEventAt > idleTimeoutMs) {
            state.timedOut = true;
            state.idleTimedOut = true;
            cancel();
          }
        }, Math.min(1000, Math.max(50, idleTimeoutMs / 2)))
      : null;

  return () => {
    clearTimeout(timer);
    if (idleTimer !== null) clearInterval(idleTimer);
  };
}
