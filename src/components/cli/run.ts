import type { NodeResult } from "../executor/ports.ts";
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

/** `run` 单次执行：恢复 → 取锁 → 执行 → 收尾；stdout 只输出 NodeResult JSON。 */
export async function runOnce(options: RunOptions): Promise<number> {
  const { config, env, io, local } = options;
  let bundle;
  try {
    bundle = await composeForRun(config, env, local);
  } catch (error) {
    io.err(`运行时装配失败：${(error as Error).message}`);
    return ExitCode.runtime;
  }
  const { store, runtime, executor } = bundle;

  await reapOrphans(store, runtime);
  await executor.recover();

  let unlock;
  try {
    unlock = await store.lockInstance(local.request.instanceId);
  } catch (error) {
    io.err(`实例锁冲突：${(error as Error).message}`);
    return ExitCode.workspace;
  }

  const controller = new AbortController();
  let signalCode: number | undefined;
  const onSignal = (code: number) => () => {
    if (signalCode !== undefined) process.exit(code);
    signalCode = code;
    controller.abort();
    void executor.cancelInstance(local.request.instanceId, "signal");
  };
  const sigint = onSignal(ExitCode.sigint);
  const sigterm = onSignal(ExitCode.sigterm);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  let result: NodeResult;
  try {
    result = await executor.executeNode(local.request, { signal: controller.signal });
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    await executor
      .reconcileCleanup([
        {
          releaseId: `run-end-${local.request.attemptId}`,
          instanceId: local.request.instanceId,
          workspacePath: local.request.workspacePath,
          cleanup: "keep",
          releasedAt: new Date().toISOString(),
        },
      ])
      .catch(() => undefined);
    await unlock().catch(() => undefined);
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
