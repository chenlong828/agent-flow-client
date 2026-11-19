import { join } from "node:path";
import { NodeExecutor } from "../executor/executor.ts";
import { FileStore } from "../store/store.ts";
import { FileSessionLogStore } from "../store/session-logs.ts";
import { FileWorkspace } from "../workspace/workspace.ts";
import { LocalAssets } from "../assets/assets.ts";
import { AcpRuntime } from "../runtime/runtime.ts";
import { resolveDshCommand } from "../runtime/dsh.ts";
import { HttpScheduler } from "../gateway/gateway.ts";
import { HttpTransport } from "../gateway/transport.ts";
import { JsonLogger } from "../observability/logger.ts";
import { S0_MODEL } from "../runtime/profile.ts";
import { FileRunRegistry } from "../store/runs.ts";
import { FileSignal } from "../signal/signal.ts";
import { setupObserver, type ObserverSetup } from "./observer-setup.ts";
import type { ObservationPort } from "../executor/ports.ts";
import type { AppConfig } from "./config.ts";
import type { CliIo } from "./main.ts";

export type ServeDeps = {
  config: AppConfig;
  env: Record<string, string | undefined>;
  io: CliIo;
  store: FileStore;
  workspace: FileWorkspace;
  sessionLogs: FileSessionLogStore;
  executor: NodeExecutor;
  runtime: AcpRuntime;
  gateway: HttpScheduler;
  logger: JsonLogger;
  runs: FileRunRegistry;
  signals: FileSignal;
  observer?: NonNullable<ObserverSetup["observer"]>;
};

function modelFromEnv(env: Record<string, string | undefined>) {
  return {
    ...S0_MODEL,
    model: env.AF_MODEL?.trim() || S0_MODEL.model,
    baseUrl: env.AF_LLM_BASE_URL?.trim() || S0_MODEL.baseUrl,
  };
}

function createRuntime(
  config: AppConfig,
  env: Record<string, string | undefined>,
  logger: JsonLogger,
  onPermission: (sessionId: string, params: unknown, decision: "allow" | "deny") => void,
): AcpRuntime {
  const dsh = resolveDshCommand(env);
  if (dsh === null) throw new Error("未找到 DSH 入口：设置 DSH_BIN 或把 dsh 放到 PATH");
  return new AcpRuntime({
    command: { command: dsh.command, args: dsh.args },
    env,
    permission: config.acp.permission,
    model: modelFromEnv(env),
    credentialsSource: env.DSH_CREDENTIALS_SOURCE,
    onStderr: (line) => logger.log({ level: "debug", event: "dsh.stderr", msg: line }),
    onPermission,
  });
}

/** `serve` 的执行内核装配（组合根内的一段，避免 `composeForServe` 过长）。 */
function createExecutor(input: {
  config: AppConfig;
  runtime: AcpRuntime;
  workspace: FileWorkspace;
  assets: LocalAssets;
  sessionLogs: FileSessionLogStore;
  store: FileStore;
  runs: FileRunRegistry;
  signals: FileSignal;
  logger: JsonLogger;
  observation?: ObservationPort;
}): NodeExecutor {
  const { config, logger } = input;
  return new NodeExecutor({
    runtime: input.runtime,
    workspace: input.workspace,
    assets: input.assets,
    sessionLogs: input.sessionLogs,
    journal: input.store,
    dshHome: config.acp.dshHome,
    ...(input.observation === undefined ? {} : { observation: input.observation }),
    runs: input.runs,
    signals: input.signals,
    sessionNewTimeoutMs: config.acp.sessionNewTimeoutMs,
    log: (event, detail) =>
      logger.log({
        level: "info",
        event,
        ...(detail === undefined ? {} : { msg: JSON.stringify(detail) }),
      }),
    maxResultBytes: 262144,
    ...(config.executor.idleTimeoutMs > 0 ? { idleTimeoutMs: config.executor.idleTimeoutMs } : {}),
  });
}

/** `serve` 的组合根：所有 L0 具体实现只在这里装配（v2 无 clientId/runId）。 */
export async function composeForServe(
  config: AppConfig,
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<ServeDeps> {
  const stateRoot = config.state.root;
  const logger = new JsonLogger({
    level: config.logging.level,
    stderr: (line) => process.stderr.write(`${line}\n`),
    filePath: join(stateRoot, "logs", "client.jsonl"),
  });
  const store = new FileStore({ stateRoot });
  await store.init();
  const workspace = new FileWorkspace();
  const sessionLogs = new FileSessionLogStore(stateRoot);
  const runs = new FileRunRegistry({ stateRoot });
  await runs.init();
  const setup = await setupObserver({ config, stateRoot, runs, logger });
  const schedulerUrl = config.scheduler.url;
  if (schedulerUrl === null) throw new Error("serve 需要 [scheduler].url");
  const transport = new HttpTransport({
    baseUrl: schedulerUrl,
    token: config.scheduler.token,
    clientId: config.scheduler.clientId,
    clientAddress: config.scheduler.clientAddress,
    ...(setup.advertiseUrl === undefined ? {} : { observabilityUrl: setup.advertiseUrl }),
  });
  const gateway = new HttpScheduler({
    transport,
    audit: (event, detail) =>
      logger.log({ level: "info", event, ...(detail === undefined ? {} : { msg: JSON.stringify(detail) }) }),
  });
  const assets = new LocalAssets({}, {
    cacheRoot: join(stateRoot, "cache", "skills"),
    download: async (pkg) => {
      const downloaded = await gateway.downloadPackage({
        packageId: pkg.packageId,
        name: "",
        version: "",
        digest: pkg.digest,
        sizeBytes: pkg.sizeBytes,
        downloadUrl: "",
        ...(pkg.etag === undefined ? {} : { etag: pkg.etag }),
      });
      return downloaded;
    },
  });
  const signals = new FileSignal({ stateRoot, env });
  const runtime = createRuntime(config, env, logger, (sessionId, params, decision) => {
    void setup.recorder.permission(sessionId, params, decision).catch(() => undefined);
  });
  const executor = createExecutor({
    config,
    runtime,
    workspace,
    assets,
    sessionLogs,
    store,
    runs,
    signals,
    logger,
    ...(setup.record ? { observation: setup.recorder } : {}),
  });
  return {
    config,
    env,
    io,
    store,
    workspace,
    sessionLogs,
    executor,
    runtime,
    gateway,
    logger,
    runs,
    signals,
    ...(setup.observer === undefined ? {} : { observer: setup.observer }),
  };
}
