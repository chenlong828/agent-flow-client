import type { PollRequest, TaskRequest, TaskResult } from "../executor/types.ts";
import type { ServeDeps } from "./serve-compose.ts";

export const POLL_FLOOR_MS = 10;
export const MAX_UNREACHABLE = 10;

export type RunningEntry = { task: TaskRequest; startedAt: string };
export type FinishedEntry = { result: TaskResult; finishedAt: string };

export type ServeContext = {
  deps: ServeDeps;
  controller: AbortController;
  running: Map<string, RunningEntry>;
  finished: Map<string, FinishedEntry>;
  reporting: Set<string>;
  stopRequested: boolean;
  stopCode: number | null;
  unreachable: number;
};

export function createContext(deps: ServeDeps): ServeContext {
  return {
    deps,
    controller: new AbortController(),
    running: new Map(),
    finished: new Map(),
    reporting: new Set(),
    stopRequested: false,
    stopCode: null,
    unreachable: 0,
  };
}

export function buildPollRequest(ctx: ServeContext): PollRequest {
  const running = [...ctx.running.entries()].map(([taskId, entry]) => ({
    taskId,
    instanceId: entry.task.instanceId,
    startedAt: entry.startedAt,
  }));
  const finished = [...ctx.finished.entries()].map(([taskId, entry]) => ({
    taskId,
    attempt: entry.result.attempt,
    finishedAt: entry.finishedAt,
  }));
  return {
    capacity: { free: Math.max(0, ctx.deps.config.capacity.maxConcurrent - running.length) },
    running,
    finished,
  };
}

/** 停领并取消活跃任务；第二次调用直接强退。 */
export function stop(ctx: ServeContext, code: number): void {
  if (ctx.stopCode !== null) process.exit(code);
  ctx.stopCode = code;
  ctx.stopRequested = true;
  ctx.controller.abort();
  void ctx.deps.executor.cancelAll();
}

export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
