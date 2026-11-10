import { GatewayError } from "../gateway/errors.ts";
import { ExitCode } from "./exit-codes.ts";
import { MAX_UNREACHABLE, POLL_FLOOR_MS, buildPollRequest, delay, stop, type ServeContext } from "./serve-context.ts";
import type { PollResponse, TaskRequest, TaskResult } from "../executor/types.ts";

const MAX_PROMPT_BYTES = 1048576;

/** 单条 poll 循环：取任务、上报 running/finished、收 stop/cancelInstances。 */
export async function pollLoop(ctx: ServeContext): Promise<void> {
  const { gateway, logger } = ctx.deps;
  while (!ctx.controller.signal.aborted) {
    await flushFinished(ctx);
    if (ctx.controller.signal.aborted) return;
    try {
      const response = await gateway.poll(buildPollRequest(ctx));
      ctx.unreachable = 0;
      await applyResponse(ctx, response);
      if (ctx.stopRequested && ctx.running.size === 0) {
        await flushFinished(ctx);
        return;
      }
      await delay(Math.max(POLL_FLOOR_MS, response.nextPollAfterMs), ctx.controller.signal);
    } catch (error) {
      if (ctx.controller.signal.aborted) return;
      if (error instanceof GatewayError && error.terminal) {
        stop(ctx, ExitCode.auth);
        return;
      }
      ctx.unreachable += 1;
      logger.log({ level: "warn", event: "poll.failed", msg: (error as Error).message });
      if (ctx.unreachable >= MAX_UNREACHABLE) {
        stop(ctx, ExitCode.scheduler);
        return;
      }
      await delay(Math.min(30_000, 1000 * 2 ** Math.min(ctx.unreachable, 5)), ctx.controller.signal);
    }
  }
}

async function applyResponse(ctx: ServeContext, response: PollResponse): Promise<void> {
  if (response.cancelInstances.length > 0) {
    for (const instanceId of response.cancelInstances) await ctx.deps.executor.cancelInstance(instanceId);
  }
  if (response.stop) ctx.stopRequested = true;
  for (const task of response.tasks) {
    if (ctx.stopRequested || ctx.running.has(task.taskId) || ctx.finished.has(task.taskId)) continue;
    if (response.cancelInstances.includes(task.instanceId)) continue;
    launchTask(ctx, task);
  }
}

function launchTask(ctx: ServeContext, task: TaskRequest): void {
  const startedAt = new Date().toISOString();
  ctx.running.set(task.taskId, { task, startedAt });
  ctx.deps.logger.log({
    level: "info",
    event: "task.received",
    attemptId: task.taskId,
    instanceId: task.instanceId,
    msg: `attempt=${task.attempt} timeoutMs=${task.timeoutMs} skill=${task.skillSet.digest}`,
  });
  const taskPromise = runTask(ctx, task)
    .then((result) => {
      ctx.running.delete(task.taskId);
      ctx.finished.set(task.taskId, { result, finishedAt: new Date().toISOString() });
      return reportOne(ctx, task.taskId);
    })
    .catch((error: unknown) => {
      ctx.deps.logger.log({ level: "error", event: "task.crashed", attemptId: task.taskId, msg: (error as Error).message });
      ctx.running.delete(task.taskId);
    });
  ctx.inflight.add(taskPromise);
  void taskPromise.finally(() => ctx.inflight.delete(taskPromise));
}

async function runTask(ctx: ServeContext, task: TaskRequest): Promise<TaskResult> {
  if (Buffer.byteLength(task.prompt, "utf8") > MAX_PROMPT_BYTES) {
    const result: TaskResult = {
      taskId: task.taskId,
      attempt: task.attempt,
      status: "failed",
      message: "",
      truncated: false,
      stopReason: null,
      usage: null,
      error: { class: "scheduler", code: "payload_too_large", message: `prompt 超过 ${MAX_PROMPT_BYTES} 字节` },
    };
    await ctx.deps.store.append({ v: 2, ts: new Date().toISOString(), taskId: task.taskId, attempt: task.attempt, instanceId: task.instanceId, nodeId: task.nodeId, state: "settled", result });
    return result;
  }
  return await ctx.deps.executor.executeTask(task, {
    signal: ctx.controller.signal,
    ...(ctx.deps.config.executor.idleTimeoutMs > 0 ? { idleTimeoutMs: ctx.deps.config.executor.idleTimeoutMs } : {}),
  });
}

/** 已落盘未 accepted 的结果重报；accepted=false / 404 丢弃。 */
export async function flushFinished(ctx: ServeContext): Promise<void> {
  for (const taskId of [...ctx.finished.keys()]) await reportOne(ctx, taskId);
}

async function reportOne(ctx: ServeContext, taskId: string): Promise<void> {
  if (ctx.reporting.has(taskId)) return;
  const entry = ctx.finished.get(taskId);
  if (entry === undefined) return;
  ctx.reporting.add(taskId);
  try {
    const ack = await ctx.deps.gateway.reportResult(entry.result);
    if (ack.accepted) {
      await ctx.deps.store.mark(taskId, "reported");
      ctx.finished.delete(taskId);
      ctx.deps.logger.log({ level: "info", event: "task.reported", attemptId: taskId, msg: `status=${entry.result.status}` });
      return;
    }
    await ctx.deps.store.mark(taskId, "reported");
    ctx.finished.delete(taskId);
    ctx.deps.logger.log({ level: "info", event: "task.rejected", attemptId: taskId, msg: "accepted=false，丢弃本地副本" });
  } catch (error) {
    if (error instanceof GatewayError && error.terminal) {
      stop(ctx, ExitCode.auth);
      return;
    }
    if (error instanceof GatewayError && (error.code === "payload_too_large" || error.code === "protocol_error")) {
      ctx.deps.logger.log({ level: "warn", event: "result.rejected", attemptId: taskId, msg: error.message });
      await ctx.deps.store.mark(taskId, "reported").catch(() => undefined);
      ctx.finished.delete(taskId);
      return;
    }
    ctx.deps.logger.log({ level: "warn", event: "result.retry", attemptId: taskId, msg: (error as Error).message });
  } finally {
    ctx.reporting.delete(taskId);
  }
}
