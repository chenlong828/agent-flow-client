import type { TaskResult } from "../executor/types.ts";
import type { AppConfig } from "./config.ts";
import { composeForRun } from "./compose.ts";
import type { LocalRunRequest } from "./request.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CliIo } from "./main.ts";

export type RunOptions = {
  config: AppConfig;
  env: Record<string, string | undefined>;
  io: CliIo;
  local: LocalRunRequest;
};

/** `run` 单次执行：清孤儿 → 执行 → 输出 TaskResult；不做实例锁/清理对账。 */
export async function runOnce(options: RunOptions): Promise<number> {
  const { config, env, io, local } = options;
  let bundle;
  try {
    bundle = await composeForRun(config, env, local);
  } catch (error) {
    io.err(`运行时装配失败：${(error as Error).message}`);
    return ExitCode.runtime;
  }
  const { store, runtime, executor, scheduler, sessionLogs } = bundle;
  await reapOrphans(store, runtime);

  const controller = new AbortController();
  let signalCode: number | undefined;
  const onSignal = (code: number) => () => {
    if (signalCode !== undefined) process.exit(code);
    signalCode = code;
    controller.abort();
    void executor.cancelInstance(local.task.instanceId);
  };
  const sigint = onSignal(ExitCode.sigint);
  const sigterm = onSignal(ExitCode.sigterm);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  let result: TaskResult;
  try {
    result = await executor.executeTask(local.task, { signal: controller.signal, ...(config.executor.idleTimeoutMs > 0 ? { idleTimeoutMs: config.executor.idleTimeoutMs } : {}) });
    await scheduler.reportResult(result).catch(() => undefined);
    await sessionLogs.clear(local.task.taskId, local.task.attempt).catch(() => undefined);
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    await executor.shutdownInstances().catch(() => undefined);
  }

  io.out(JSON.stringify(result));
  if (signalCode !== undefined) return signalCode;
  return result.status === "succeeded" ? ExitCode.ok : ExitCode.nodeFailed;
}

async function reapOrphans(store: import("../store/store.ts").FileStore, runtime: import("../runtime/runtime.ts").AcpRuntime): Promise<void> {
  for (const orphan of await store.listOrphans()) {
    await runtime.reapOrphan(orphan).catch(() => false);
    await store.clearOrphan(orphan.pid);
  }
}
