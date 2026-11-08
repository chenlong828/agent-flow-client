import { join } from "node:path";
import { NodeExecutor } from "../executor/executor.ts";
import { FileStore } from "../store/store.ts";
import { FileWorkspace } from "../workspace/workspace.ts";
import { LocalAssets } from "../assets/assets.ts";
import { AcpRuntime } from "../runtime/runtime.ts";
import { resolveDshCommand } from "../runtime/dsh.ts";
import { HttpScheduler } from "../gateway/gateway.ts";
import { HttpTransport } from "../gateway/transport.ts";
import { loadClientId, newRunId } from "../gateway/identity.ts";
import { JsonLogger } from "../observability/logger.ts";
import { S0_MODEL } from "../runtime/profile.ts";
import type { AppConfig } from "./config.ts";
import type { CliIo } from "./main.ts";

export type ServeDeps = {
  config: AppConfig;
  env: Record<string, string | undefined>;
  io: CliIo;
  store: FileStore;
  executor: NodeExecutor;
  runtime: AcpRuntime;
  gateway: HttpScheduler;
  logger: JsonLogger;
  clientId: string;
  runId: string;
};

function modelFromEnv(env: Record<string, string | undefined>) {
  return {
    ...S0_MODEL,
    model: env.AF_MODEL?.trim() || S0_MODEL.model,
    baseUrl: env.AF_LLM_BASE_URL?.trim() || S0_MODEL.baseUrl,
  };
}

/** `serve` 的组合根：所有 L0 具体实现只在这里装配。 */
export async function composeForServe(
  config: AppConfig,
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<ServeDeps> {
  const stateRoot = config.state.root;
  const clientId = await loadClientId(stateRoot);
  const runId = newRunId();
  const logger = new JsonLogger({
    level: config.logging.level,
    stderr: (line) => process.stderr.write(`${line}\n`),
    filePath: join(stateRoot, "logs", "client.jsonl"),
  });
  const store = new FileStore({ stateRoot });
  await store.init();
  const workspace = new FileWorkspace();
  const schedulerUrl = config.scheduler.url;
  if (schedulerUrl === null) throw new Error("serve 需要 [scheduler].url");
  const assets = new LocalAssets({}, {
    cacheRoot: join(stateRoot, "cache", "skills"),
    baseUrl: schedulerUrl,
    token: config.scheduler.token,
  });
  const dsh = resolveDshCommand(env);
  if (dsh === null) throw new Error("未找到 DSH 入口：设置 DSH_BIN 或把 dsh 放到 PATH");
  const runtime = new AcpRuntime({
    command: { command: dsh.command, args: dsh.args },
    env,
    permission: config.acp.permission,
    model: modelFromEnv(env),
    credentialsSource: env.DSH_CREDENTIALS_SOURCE,
    onStderr: (line) => logger.log({ level: "debug", event: "dsh.stderr", msg: line }),
  });
  const transport = new HttpTransport({
    baseUrl: schedulerUrl,
    clientId,
    runId,
    token: config.scheduler.token,
  });
  const gateway = new HttpScheduler(clientId, runId, {
    transport,
    clientVersion: "0.0.1",
    audit: (event, detail) => logger.log({ level: "info", event, ...(detail === undefined ? {} : { msg: JSON.stringify(detail) }) }),
  });
  const executor = new NodeExecutor({
    scheduler: gateway,
    runtime,
    workspace,
    assets,
    journal: store,
    dshHome: config.acp.dshHome,
    maxResultBytes: gateway.limits.maxResultBytes,
    cleanupPolicy: "keep",
  });
  return { config, env, io, store, executor, runtime, gateway, logger, clientId, runId };
}

