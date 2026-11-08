import type { NodeRequest } from "../executor/ports.ts";
import { GatewayError } from "../gateway/errors.ts";
import { ExitCode } from "./exit-codes.ts";
import { HEARTBEAT_FLOOR_MS, MAX_UNREACHABLE, buildState, delay, stop, type ServeContext } from "./serve-context.ts";
import { dispatchEvent, rejectAttempt } from "./serve-events.ts";

/** 心跳长轮询：独立于执行；控制事件分派、清理对账、断线退避。 */
export async function heartbeatLoop(ctx: ServeContext): Promise<void> {
  const { gateway, executor, logger } = ctx.deps;
  while (!ctx.controller.signal.aborted) {
    try {
      const outcome = await gateway.heartbeat(buildState(ctx), ctx.acks.splice(0));
      ctx.unreachable = 0;
      ctx.assignmentsVersion = outcome.assignmentsVersion;
      for (const event of outcome.control.events) await dispatchEvent(ctx, event);
      if (outcome.cleanupPending.length > 0) {
        ctx.acks.push(...(await executor.reconcileCleanup(outcome.cleanupPending)));
      }
      await delay(Math.max(HEARTBEAT_FLOOR_MS, outcome.nextPollAfterMs), ctx.controller.signal);
    } catch (error) {
      if (ctx.controller.signal.aborted) return;
      if (error instanceof GatewayError && error.code === "run_superseded") {
        stop(ctx, ExitCode.runSuperseded);
        return;
      }
      if (error instanceof GatewayError && error.terminalAuthFailure) {
        stop(ctx, ExitCode.auth);
        return;
      }
      ctx.unreachable += 1;
      logger.log({ level: "warn", event: "heartbeat.failed", msg: (error as Error).message });
      if (ctx.unreachable >= MAX_UNREACHABLE) {
        stop(ctx, ExitCode.scheduler);
        return;
      }
      await delay(Math.min(30_000, 1000 * 2 ** Math.min(ctx.unreachable, 5)), ctx.controller.signal);
    }
  }
}

/** 领取循环：有容量就领；领取后交给执行任务，同实例由 journal 锁串行。 */
export async function claimLoop(ctx: ServeContext): Promise<void> {
  const { gateway, config, logger } = ctx.deps;
  while (!ctx.controller.signal.aborted) {
    if (ctx.paused.size >= config.capacity.maxInstances) {
      await delay(HEARTBEAT_FLOOR_MS, ctx.controller.signal);
      continue;
    }
    try {
      const request = await gateway.claim(buildState(ctx).capacity);
      if (request === null) {
        await delay(HEARTBEAT_FLOOR_MS, ctx.controller.signal);
        continue;
      }
      launch(ctx, request);
    } catch (error) {
      if (ctx.controller.signal.aborted) return;
      if (error instanceof GatewayError && error.code === "run_superseded") {
        stop(ctx, ExitCode.runSuperseded);
        return;
      }
      if (error instanceof GatewayError && error.terminalAuthFailure) {
        stop(ctx, ExitCode.auth);
        return;
      }
      logger.log({ level: "warn", event: "claim.failed", msg: (error as Error).message });
      await delay(1000, ctx.controller.signal);
    }
  }
}

function launch(ctx: ServeContext, request: NodeRequest): void {
  const task = runAttempt(ctx, request).finally(() => ctx.inflight.delete(task));
  ctx.inflight.add(task);
}

async function runAttempt(ctx: ServeContext, request: NodeRequest): Promise<void> {
  const { store, executor, logger } = ctx.deps;
  if (ctx.paused.has(request.instanceId) || ctx.controller.signal.aborted) {
    await rejectAttempt(ctx, request, ctx.controller.signal.aborted ? "shutdown" : "paused");
    return;
  }
  ctx.instances.add(request.instanceId);
  let unlock: (() => Promise<void>) | null = null;
  try {
    unlock = await store.lockInstance(request.instanceId);
    await executor.executeNode(request, { signal: ctx.controller.signal });
  } catch (error) {
    if (unlock === null) await rejectAttempt(ctx, request, "workspace");
    logger.log({ level: "warn", event: "attempt.failed", attemptId: request.attemptId, msg: (error as Error).message });
  } finally {
    await unlock?.().catch(() => undefined);
  }
}
