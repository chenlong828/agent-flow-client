import { VERSION } from "../../version.ts";
import { parseArgs, flagString, UsageError, type ParsedArgs } from "./args.ts";
import { ConfigError, loadConfig, type AppConfig, type ConfigFlags } from "./config.ts";
import { resolveRunDir } from "./run-dir.ts";
import { ExitCode } from "./exit-codes.ts";
import { collectDoctorChecks } from "./doctor-checks.ts";
import { render, collect, exitCode } from "../observability/doctor.ts";
import { loadLocalRequest, RequestError } from "./request.ts";

export type CliIo = {
  out(message: string): void;
  err(message: string): void;
};

export type CliDeps = {
  env: Record<string, string | undefined>;
  io: CliIo;
  execPath?: string;
  moduleDir?: string;
  homeDir?: string;
};

const HELP = `agent-flow-client ${VERSION}

用法：
  agent-flow-client <command> [options]

命令：
  serve      常驻模式：领取并执行节点（S1 接入调度器；S0 只校验配置）
  run        单次模式：执行一个本地任务（--request <file>）
  doctor     本地环境自检（不依赖调度器）
  version    打印版本
  help       打印帮助

选项：
  -h, --help              打印帮助
  -v, --version           打印版本
  --config <path>         指定配置文件（默认 <runDir>/.config）
  --state-root <path>     覆盖 state.root（journal/锁/日志）
  --log-level <level>     debug | info | warn | error
  --permission <mode>     deny | allow（ACP 权限请求的本地策略）
  --workspace <path>      doctor：检查容器布局
  --json                  doctor/version：输出 JSON
`;

const ACP_PROTOCOL_VERSION = 1;
const DSH_BASELINE = "0.2.2-alpha.2";

function configFlags(args: ParsedArgs): ConfigFlags {
  return {
    configPath: flagString(args, "--config"),
    stateRoot: flagString(args, "--state-root"),
    logLevel: flagString(args, "--log-level"),
    permission: flagString(args, "--permission"),
  };
}

function printVersion(args: ParsedArgs, io: CliIo): number {
  if (args.flags["--json"] === true) {
    io.out(JSON.stringify({ client: VERSION, acpProtocol: ACP_PROTOCOL_VERSION, dshBaseline: DSH_BASELINE }, null, 2));
  } else {
    io.out(VERSION);
  }
  return ExitCode.ok;
}

async function doctorCommand(args: ParsedArgs, config: AppConfig, deps: CliDeps): Promise<number> {
  const workspacePath = flagString(args, "--workspace");
  const checks = await collectDoctorChecks({
    config,
    env: deps.env,
    ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
  });
  const report = collect(checks);
  deps.io.out(
    `生效配置：runDir=${config.runDir} DSH_HOME=${config.acp.dshHome}（${config.acp.dshHomeSource}）state.root=${config.state.root}（${config.state.source}）permission=${config.acp.permission}`,
  );
  deps.io.out(render(report, args.flags["--json"] === true ? "json" : "human"));
  return exitCode(report);
}

async function runCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const requestPath = flagString(args, "--request");
  if (requestPath === undefined) throw new UsageError("run 需要 --request <file>");
  const local = await loadLocalRequest(requestPath);
  io.err(
    `执行内核尚未接入（T5）；已校验请求 attemptId=${local.request.attemptId} instanceId=${local.request.instanceId} skillSet=${local.skillSet.digest}`,
  );
  return ExitCode.runtime;
}

/** 进程入口：解析命令、加载配置、分派；返回退出码（CMP-cli §3.1）。 */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { io, env, homeDir } = deps;
  try {
    const args = parseArgs(argv);
    if (args.command === "" || args.command === "help") {
      io.out(HELP);
      return ExitCode.ok;
    }
    if (args.command === "version") return printVersion(args, io);

    const runDir = resolveRunDir({
      execPath: deps.execPath ?? process.execPath,
      moduleDir: deps.moduleDir ?? import.meta.dir,
    });
    const config = await loadConfig({
      runDir,
      env,
      flags: configFlags(args),
      ...(homeDir === undefined ? {} : { homeDir }),
    });

    if (args.command === "doctor") return await doctorCommand(args, config, deps);
    if (args.command === "serve") {
      io.err("serve 尚未实现：S0 只校验配置，S1 接入调度器与租约。");
      return ExitCode.usage;
    }
    if (args.command === "run") return await runCommand(args, io);

    io.err(`未知命令：${args.command}\n\n${HELP}`);
    return ExitCode.usage;
  } catch (error) {
    return reportError(error, io);
  }
}

function reportError(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.err(`${error.message}\n\n${HELP}`);
    return ExitCode.usage;
  }
  if (error instanceof ConfigError) {
    io.err(`配置错误（${error.code}）：${error.message}`);
    return error.exitCode;
  }
  if (error instanceof RequestError) {
    io.err(`请求文件错误：${error.message}`);
    return ExitCode.usage;
  }
  io.err(`未预期错误：${(error as Error).message}`);
  return ExitCode.runtime;
}
