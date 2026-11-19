import { basename } from "node:path";
import { SIGNAL_SERVER_NAME, type McpServerSpec } from "./contract.ts";

/** 编译为单二进制时 CLI 的隐藏子命令（与 `src/cli.ts` 分派一致）。 */
export const SIGNAL_CLI_SUBCOMMAND = "signal-server";

/** 挂载失败的可见文本：DSH 把 MCP 失败包成 `-32603 Internal error`，真实原因在 `data.details`。 */
export function isSignalMountError(error: unknown): boolean {
  const details = (error as { data?: unknown } | undefined)?.data;
  if (typeof details === "object" && details !== null) {
    const text = (details as { details?: unknown }).details;
    if (typeof text === "string") return text.includes(`mcp-client(${SIGNAL_SERVER_NAME})`);
  }
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message.includes(`mcp-client(${SIGNAL_SERVER_NAME})`);
}

/**
 * 选择 server 启动方式（T-RVM-02）：
 * - Bun 运行时（`process.execPath` 是 bun）：绝对脚本路径；
 * - 编译后的单二进制：把自身当入口，用隐藏子命令 `signal-server`。
 */
export function resolveSignalServerCommand(input: { execPath: string; entryPath: string }): {
  command: string;
  args: string[];
} {
  const isBunRuntime = /^bun(\.exe)?$/i.test(basename(input.execPath));
  return isBunRuntime
    ? { command: input.execPath, args: [input.entryPath] }
    : { command: input.execPath, args: [SIGNAL_CLI_SUBCOMMAND] };
}

/** 构造 `session/new.mcpServers`：绝对 command + 绝对参数 + 只带 `AF_SIGNAL_CONFIG`。 */
export function signalMcpServers(input: {
  execPath: string;
  entryPath: string;
  configPath: string;
}): McpServerSpec[] {
  const resolved = resolveSignalServerCommand(input);
  return [
    {
      name: SIGNAL_SERVER_NAME,
      command: resolved.command,
      args: resolved.args,
      env: [{ name: "AF_SIGNAL_CONFIG", value: input.configPath }],
    },
  ];
}
