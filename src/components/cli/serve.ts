import { GatewayError } from "../gateway/errors.ts";
import { PROTOCOL_VERSION } from "../gateway/identity.ts";
import { ExitCode } from "./exit-codes.ts";
import type { AppConfig } from "./config.ts";
import type { CliIo } from "./main.ts";
import { composeForServe, type ServeDeps } from "./serve-compose.ts";
import { createContext, stop, type ServeContext } from "./serve-context.ts";
import { heartbeatLoop, claimLoop } from "./serve-loops.ts";
import { shutdownAll } from "./serve-events.ts";

/** `serve` 主循环：注册 → 清理对账 → 恢复 → 心跳 + 领取；信号/控制事件收口。 */
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
    try {
      await this.#bootstrap();
    } catch (error) {
      return registerFailure(error, this.#ctx.deps.io);
    }
    const heartbeat = heartbeatLoop(this.#ctx);
    const claim = claimLoop(this.#ctx);
    await Promise.race([heartbeat, claim]);
    await Promise.race([Promise.allSettled([heartbeat, claim]), new Promise((resolve) => setTimeout(resolve, 3000))]);
    await shutdownAll(this.#ctx);
    return this.#ctx.stopCode ?? ExitCode.ok;
  }

  async #bootstrap(): Promise<void> {
    const { gateway, executor, store, runtime, config, clientId, runId, logger } = this.#ctx.deps;
    const registration = await gateway.register({
      clientId,
      version: "0.0.1",
      protocolVersion: PROTOCOL_VERSION,
      capacity: { maxInstances: config.capacity.maxInstances, activeInstances: 0, activeAttempts: 0 },
    });
    this.#ctx.assignmentsVersion = registration.assignmentsVersion;
    executor.setMaxResultBytes(registration.limits.maxResultBytes);
    for (const orphan of await store.listOrphans()) {
      await runtime.reapOrphan(orphan).catch(() => false);
      await store.clearOrphan(orphan.pid);
    }
    this.#ctx.acks.push(...(await executor.reconcileCleanup(registration.cleanupPending)));
    await executor.recover();
    logger.log({ level: "info", event: "serve.registered", msg: `runId=${runId}` });
  }
}

function registerFailure(error: unknown, io: CliIo): number {
  if (error instanceof GatewayError) {
    if (error.code === "run_superseded") return ExitCode.runSuperseded;
    if (error.terminalAuthFailure) return ExitCode.auth;
  }
  io.err(`注册失败：${(error as Error).message}`);
  return ExitCode.scheduler;
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
