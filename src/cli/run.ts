import { VERSION } from "../version.ts";

export interface CliIO {
  out(message: string): void;
  err(message: string): void;
}

const DEFAULT_IO: CliIO = {
  out: (message) => console.log(message),
  err: (message) => console.error(message),
};

const HELP = `agent-flow-client ${VERSION}

用法：
  agent-flow-client <command> [options]

命令：
  serve      常驻模式：领取并执行节点（待实现）
  run        单次模式：执行一个本地任务（待实现）
  doctor     本地环境自检（待实现）
  version    打印版本
  help       打印帮助

选项：
  -h, --help     打印帮助
  -v, --version  打印版本
`;

const NOT_IMPLEMENTED: Record<string, string> = {
  serve: "常驻模式尚未实现：S0 后接入租约与执行内核。",
  run: "单次模式尚未实现：S0 后接入本地执行内核。",
  doctor: "环境自检尚未实现：S0 后接入 DSH 与工作区检查。",
};

export function runCli(args: string[], io: CliIO = DEFAULT_IO): number {
  const [command] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    io.out(VERSION);
    return 0;
  }

  const notImplemented = NOT_IMPLEMENTED[command];
  if (notImplemented !== undefined) {
    io.err(notImplemented);
    return 2;
  }

  io.err(`未知命令：${command}\n\n${HELP}`);
  return 2;
}
