import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { GatewayError } from "../gateway/errors.ts";
import { ExitCode } from "./exit-codes.ts";
import { MAX_UNREACHABLE, POLL_FLOOR_MS, buildPollRequest, delay, stop, type ServeContext } from "./serve-context.ts";
import type { PollResponse, TaskRequest, TaskResult } from "../executor/types.ts";

const MAX_PROMPT_BYTES = 1048576;
const MAX_SESSION_LOG_BYTES = 67108864;
const MAX_ARCHIVE_BYTES = 536870912;

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
  for (const request of response.archiveRequests) startArchive(ctx, request);
  // 服务端不再下发即视为已确认，可以移除本地记录。
  if (ctx.archivedRuns.size > 0) {
    const pending = new Set(response.archiveRequests.map((item) => item.runId));
    for (const runId of [...ctx.archivedRuns]) if (!pending.has(runId)) ctx.archivedRuns.delete(runId);
  }
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

/** `P-05`：归档是冷路径，后台打包上传，不阻塞 poll。 */
function startArchive(ctx: ServeContext, request: import("../executor/types.ts").ArchiveRequest): void {
  if (ctx.archivedRuns.has(request.runId) || ctx.archives.has(request.runId)) return;
  const job = archiveRun(ctx, request).finally(() => ctx.archives.delete(request.runId));
  ctx.archives.set(request.runId, job);
  void job;
}

async function archiveRun(ctx: ServeContext, request: import("../executor/types.ts").ArchiveRequest): Promise<void> {
  const { logger, gateway, workspace, config } = ctx.deps;
  const target = join(config.state.root, "archives", `${request.runId}.tar.gz`);
  try {
    await workspace.assertInsideWorkspace(request.workspacePath, request.taskSpacePath);
    // 本地没有 task-space（run 从未落到本机、或已被运维清理）时没有可归档内容，不再重试。
    if ((await stat(request.taskSpacePath).catch(() => null))?.isDirectory() !== true) {
      ctx.archivesDone.add(request.runId);
      logger.log({ level: "warn", event: "archive.skipped", msg: `runId=${request.runId} 本地无 task-space` });
      return;
    }
    const packed = await workspace.packTaskSpace(request.taskSpacePath, target);
    if (packed.bytes > MAX_ARCHIVE_BYTES) {
      logger.log({ level: "warn", event: "archive.too_large", msg: `runId=${request.runId} bytes=${packed.bytes}` });
      return;
    }
    const payload = new Uint8Array(await Bun.file(target).arrayBuffer());
    const ack = await gateway.uploadArchive({ runId: request.runId, payload });
    ctx.archivedRuns.add(request.runId);
    logger.log({ level: "info", event: "archive.uploaded", msg: `runId=${request.runId} stored=${ack.stored} bytes=${ack.bytes}` });
  } catch (error) {
    if (error instanceof GatewayError) {
      if (error.code === "payload_too_large") {
        logger.log({ level: "warn", event: "archive.too_large", msg: `runId=${request.runId}` });
        return;
      }
      if (error.code === "run_not_found") {
        logger.log({ level: "warn", event: "archive.dropped", msg: `runId=${request.runId}` });
        return;
      }
    }
    logger.log({ level: "warn", event: "archive.retry", msg: `runId=${request.runId}：${(error as Error).message}` });
  } finally {
    await rm(target, { force: true }).catch(() => undefined);
  }
}

/** `P-04`：报结果前先确保该 attempt 的日志已上传（0 行也传）。 */
async function ensureSessionLog(ctx: ServeContext, entry: { result: TaskResult }): Promise<"ok" | "drop" | "retry"> {
  const { taskId, attempt } = entry.result;
  const key = `${taskId}#${attempt}`;
  if (ctx.logReady.has(key)) return "ok";
  try {
    const raw = (await ctx.deps.sessionLogs.read(taskId, attempt)) ?? new Uint8Array();
    await ctx.deps.gateway.uploadSessionLog({ taskId, attempt, payload: new Uint8Array(gzipSync(raw)) });
    ctx.logReady.add(key);
    return "ok";
  } catch (error) {
    if (error instanceof GatewayError && error.code === "task_not_found") {
      await ctx.deps.store.mark(taskId, "reported").catch(() => undefined);
      ctx.finished.delete(taskId);
      return "drop";
    }
    if (error instanceof GatewayError && error.code === "payload_too_large") {
      try {
        await ctx.deps.gateway.uploadSessionLog({ taskId, attempt, payload: new Uint8Array(gzipSync(new Uint8Array())) });
      } catch (emptyError) {
        ctx.deps.logger.log({ level: "warn", event: "session_log.empty_failed", attemptId: taskId, msg: (emptyError as Error).message });
        return "retry";
      }
      const failed: TaskResult = {
        ...entry.result,
        status: "failed",
        stopReason: null,
        error: { class: "runtime", code: "session_log_too_large", message: `会话日志超过 ${MAX_SESSION_LOG_BYTES} 字节` },
      };
      entry.result = failed;
      await ctx.deps.store.mark(taskId, "settled", { result: failed });
      ctx.logReady.add(key);
      return "ok";
    }
    ctx.deps.logger.log({ level: "warn", event: "session_log.retry", attemptId: taskId, msg: (error as Error).message });
    return "retry";
  }
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
    const gate = await ensureSessionLog(ctx, entry);
    if (gate !== "ok") return;
    const ack = await ctx.deps.gateway.reportResult(entry.result);
    if (ack.accepted) {
      await ctx.deps.store.mark(taskId, "reported");
      ctx.finished.delete(taskId);
      await ctx.deps.sessionLogs.clear(taskId, entry.result.attempt).catch(() => undefined);
      ctx.logReady.delete(`${taskId}#${entry.result.attempt}`);
      ctx.deps.logger.log({ level: "info", event: "task.reported", attemptId: taskId, msg: `status=${entry.result.status}` });
      return;
    }
    await ctx.deps.store.mark(taskId, "reported");
    ctx.finished.delete(taskId);
    await ctx.deps.sessionLogs.clear(taskId, entry.result.attempt).catch(() => undefined);
    ctx.logReady.delete(`${taskId}#${entry.result.attempt}`);
    ctx.deps.logger.log({ level: "info", event: "task.rejected", attemptId: taskId, msg: "accepted=false，丢弃本地副本" });
  } catch (error) {
    if (error instanceof GatewayError && error.terminal) {
      stop(ctx, ExitCode.auth);
      return;
    }
    if (error instanceof GatewayError && error.logMissing) {
      ctx.logReady.delete(`${taskId}#${entry.result.attempt}`);
      ctx.deps.logger.log({ level: "warn", event: "result.log_missing", attemptId: taskId, msg: error.message });
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
