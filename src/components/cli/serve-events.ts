import type { NodeRequest } from "../executor/ports.ts";
import type { ControlEvent } from "../executor/scheduler-port.ts";
import { assemble } from "../result/result.ts";
import { STOP_WAIT_MS, stop, type ServeContext } from "./serve-context.ts";

/** 控制事件分派：cancel/pause/resume/shutdown（不做业务判定，交给 executor）。 */
export async function dispatchEvent(ctx: ServeContext, event: ControlEvent): Promise<void> {
  const { executor, logger } = ctx.deps;
  if (event.type === "cancel") {
    await executor.cancelInstance(event.instanceId, "user_cancel");
    return;
  }
  if (event.type === "pause") {
    ctx.paused.add(event.instanceId);
    await executor.cancelInstance(event.instanceId, "paused");
    return;
  }
  if (event.type === "resume") {
    ctx.paused.delete(event.instanceId);
    return;
  }
  if (event.instanceId === undefined) {
    stop(ctx, 0);
    return;
  }
  const acks = await executor.reconcileCleanup([
    {
      releaseId: event.releaseId ?? `shutdown-${event.instanceId}-${event.issuedAt}`,
      instanceId: event.instanceId,
      cleanup: event.cleanup ?? "keep",
      releasedAt: event.issuedAt,
    },
  ]);
  ctx.acks.push(...acks);
  logger.log({ level: "info", event: "shutdown.instance", instanceId: event.instanceId });
}

/** 领取后但未执行（暂停/停机/取锁失败）的 attempt：用终态结果表达，不建 session。 */
export async function rejectAttempt(
  ctx: ServeContext,
  request: NodeRequest,
  reason: "paused" | "shutdown" | "workspace",
): Promise<void> {
  const { store, gateway, logger } = ctx.deps;
  const outcome =
    reason === "workspace"
      ? { sessionId: "", finalText: "", stopReason: null, usage: null, error: { code: "locked", message: "实例锁冲突", class: "runtime" as const } }
      : {
          sessionId: "",
          finalText: "",
          stopReason: null,
          usage: null,
          error: {
            code: "cancelled",
            message: reason === "paused" ? "实例已暂停" : "实例已关闭",
            class: "cancelled" as const,
          },
        };
  const result = assemble(outcome, { attemptId: request.attemptId, maxResultBytes: gateway.limits.maxResultBytes });
  await store.append({ v: 1, ts: new Date().toISOString(), attemptId: request.attemptId, instanceId: request.instanceId, nodeId: request.nodeId, state: "claimed" });
  await store.mark(request.attemptId, "settled", { result });
  await gateway.reportResult(request.attemptId, result).catch(() => undefined);
  await store.mark(request.attemptId, "reported");
  await store.mark(request.attemptId, "closed");
  logger.log({ level: "info", event: "attempt.rejected", attemptId: request.attemptId, msg: reason });
}

/** 收口：等待在飞任务，然后按实例释放。 */
export async function shutdownAll(ctx: ServeContext): Promise<void> {
  await Promise.race([
    Promise.allSettled([...ctx.inflight]),
    new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS)),
  ]);
  for (const instanceId of ctx.instances) {
    await ctx.deps.executor
      .reconcileCleanup([{ releaseId: `serve-end-${instanceId}`, instanceId, cleanup: "keep", releasedAt: new Date().toISOString() }])
      .catch(() => undefined);
  }
}
