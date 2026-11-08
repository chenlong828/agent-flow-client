import type { CleanupAck } from "../executor/scheduler-port.ts";
import type { ServeDeps } from "./serve-compose.ts";

export const HEARTBEAT_FLOOR_MS = 250;
export const MAX_UNREACHABLE = 10;
export const STOP_WAIT_MS = 10_000;

export type ServeContext = {
  deps: ServeDeps;
  controller: AbortController;
  paused: Set<string>;
  instances: Set<string>;
  inflight: Set<Promise<void>>;
  acks: CleanupAck[];
  assignmentsVersion: number;
  stopCode: number | null;
  unreachable: number;
};

export function createContext(deps: ServeDeps): ServeContext {
  return {
    deps,
    controller: new AbortController(),
    paused: new Set(),
    instances: new Set(),
    inflight: new Set(),
    acks: [],
    assignmentsVersion: 0,
    stopCode: null,
    unreachable: 0,
  };
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

/** 停领 + 取消所有活跃实例；第二次调用直接强退。 */
export function stop(ctx: ServeContext, code: number): void {
  if (ctx.stopCode !== null) process.exit(code);
  ctx.stopCode = code;
  ctx.controller.abort();
  for (const instanceId of ctx.instances) {
    void ctx.deps.executor.cancelInstance(instanceId, code === 130 ? "signal" : "shutdown");
  }
}

export function buildState(ctx: ServeContext): {
  capacity: { maxInstances: number; activeInstances: number; activeAttempts: number };
  pausedInstances: string[];
  activeAttempts: { attemptId: string; instanceId: string; phase: string; sessionId?: string }[];
  assignmentsVersion: number;
} {
  const attempts = ctx.deps.executor.snapshotAttempts();
  return {
    capacity: {
      maxInstances: ctx.deps.config.capacity.maxInstances,
      activeInstances: new Set(attempts.map((attempt) => attempt.instanceId)).size,
      activeAttempts: attempts.length,
    },
    pausedInstances: [...ctx.paused],
    activeAttempts: attempts,
    assignmentsVersion: ctx.assignmentsVersion,
  };
}
