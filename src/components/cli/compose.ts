import { JsonLogger, type Logger } from "../observability/logger.ts";
import { FileStore } from "../store/store.ts";
import { FileWorkspace } from "../workspace/workspace.ts";
import { LocalAssets } from "../assets/assets.ts";
import { AcpRuntime } from "../runtime/runtime.ts";
import { S0_MODEL, type ProfileModel } from "../runtime/profile.ts";
import { resolveDshCommand } from "../runtime/dsh.ts";
import { NodeExecutor } from "../executor/executor.ts";
import { LocalScheduler } from "./local-scheduler.ts";
import type { AppConfig } from "./config.ts";
import type { LocalRunRequest } from "./request.ts";

export type RunBundle = {
  logger: Logger;
  store: FileStore;
  workspace: FileWorkspace;
  assets: LocalAssets;
  runtime: AcpRuntime;
  scheduler: LocalScheduler;
  executor: NodeExecutor;
};

function modelFromEnv(env: Record<string, string | undefined>): ProfileModel {
  return {
    ...S0_MODEL,
    model: env.AF_MODEL?.trim() || S0_MODEL.model,
    baseUrl: env.AF_LLM_BASE_URL?.trim() || S0_MODEL.baseUrl,
  };
}

/** 组合根：`run` 的装配（L0 具体实现只在这里出现）。 */
export async function composeForRun(
  config: AppConfig,
  env: Record<string, string | undefined>,
  request: LocalRunRequest,
): Promise<RunBundle> {
  const logger = new JsonLogger({ level: config.logging.level, stderr: (line) => process.stderr.write(`${line}\n`) });
  const store = new FileStore({ stateRoot: config.state.root });
  await store.init();
  const workspace = new FileWorkspace();
  const assets = new LocalAssets({}, {});
  const scheduler = new LocalScheduler(request.task);
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
  const executor = new NodeExecutor({
    runtime,
    workspace,
    assets,
    journal: store,
    dshHome: config.acp.dshHome,
    maxResultBytes: 262144,
    ...(config.executor.idleTimeoutMs > 0 ? { idleTimeoutMs: config.executor.idleTimeoutMs } : {}),
  });
  return { logger, store, workspace, assets, runtime, scheduler, executor };
}
