import { ExitCode } from "./exit-codes.ts";
import type { AppConfig } from "./config.ts";
import type { CliIo } from "./main.ts";
import { composeForServe, type ServeDeps } from "./serve-compose.ts";
import { createContext, stop, type ServeContext } from "./serve-context.ts";
import { pollLoop } from "./serve-loops.ts";

/** `serve` 主循环（v2）：一条 poll 长轮询兼领取与判活。 */
export class ServeRunner {
  readonly #ctx: ServeContext;

  constructor(deps: ServeDeps) {
    this.#ctx = createContext(deps);
  }

  attachSignals(): void {
    process.on("SIGINT", () => stop(this.#ctx, ExitCode.sigint));
    process.on("SIGTERM", () => stop(this.#ctx, ExitCode.sigterm));
  }

  async run(): Promise<number> {
    await this.#bootstrap();
    await pollLoop(this.#ctx);
    // 收口：等待在飞任务结算/上报（最多 5s），再回收实例进程。
    await Promise.race([
      Promise.allSettled([...this.#ctx.inflight]),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    await this.#ctx.deps.executor.shutdownInstances().catch(() => undefined);
    return this.#ctx.stopCode ?? ExitCode.ok;
  }

  async #bootstrap(): Promise<void> {
    const { store, runtime, logger, config } = this.#ctx.deps;
    for (const orphan of await store.listOrphans()) {
      await runtime.reapOrphan(orphan).catch(() => false);
      await store.clearOrphan(orphan.pid);
    }
    for (const record of await store.settled()) {
      if (record.result === undefined) continue;
      this.#ctx.finished.set(record.taskId, { result: record.result, finishedAt: record.ts });
    }
    logger.log({
      level: "info",
      event: "serve.started",
      msg: `maxConcurrent=${config.capacity.maxConcurrent} settled=${this.#ctx.finished.size}`,
    });
  }
}

export async function serveCommand(config: AppConfig, env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  let deps: ServeDeps;
  try {
    deps = await composeForServe(config, env, io);
  } catch (error) {
    io.err(`serve 装配失败：${(error as Error).message}`);
    return ExitCode.runtime;
  }
  const runner = new ServeRunner(deps);
  runner.attachSignals();
  return await runner.run();
}
