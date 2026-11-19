#!/usr/bin/env bun
/**
 * agentflow 信号 server（stdio MCP，v1：一个 server 暴露本次 attempt 的全部工具）。
 *
 * 由 client 通过 `session/new.mcpServers` 以绝对路径启动，配置来自 `AF_SIGNAL_CONFIG`。
 * 工具名与契约 kind 的映射见 `SIGNAL_TOOL_NAME_BY_KIND`（`review_verdict` → `signal`，
 * `confirmation_request` → `confirm`）；`tools/list` 为每个契约列一项，`tools/call` 按工具名分派。
 * 行为约束（proposal §4.2）：
 * - 启动幂等：不清空 `signals.jsonl`、不持独占锁；`seq` 从文件最大行续号（server 可能被启动两次）。
 * - 对未知方法（含 MCP SDK 的 `server/discover` 探针）立即回 `-32601`；静默忽略会让 DSH 等满 60s。
 * - 参数非法返回 MCP `isError: true`，不写文件；合法则追加一行并 `fsync` 后 ack。
 * - 只写 `config.output`；不读 task-space、不访问网络、不执行 shell。
 */
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  SIGNAL_KIND_CONFIRMATION_REQUEST,
  SIGNAL_LIMITS,
  byteLength,
  toMcpInputSchema,
  toolNameForKind,
  type SignalContractSpec,
} from "../components/signal/contract.ts";
import type { SignalServerConfig } from "../components/signal/plan.ts";
import { validateSchema, validateSignalData } from "../components/signal/validate.ts";
import { readServerConfig } from "../components/signal/directory.ts";

const PROTOCOL_FALLBACK = "2024-11-05";

function fail(message: string): never {
  process.stderr.write(`signal-server: ${message}\n`);
  process.exit(1);
}

async function loadConfig(): Promise<SignalServerConfig> {
  const path = process.env.AF_SIGNAL_CONFIG;
  if (path === undefined || path === "") fail("缺少 AF_SIGNAL_CONFIG");
  let config: SignalServerConfig;
  try {
    config = await readServerConfig(path);
  } catch (error) {
    fail(`读取 config 失败：${(error as Error).message}`);
  }
  const names = new Set<string>();
  for (const tool of config.tools) {
    const schemaErrors = validateSchema(tool.schema);
    if (schemaErrors.length > 0) fail(`config.tools[${tool.kind}].schema 非法：${schemaErrors.join("; ")}`);
    const name = toolNameForKind(tool.kind);
    if (names.has(name)) fail(`config.tools 工具名重复：${name}（kind=${tool.kind}）`);
    names.add(name);
  }
  return config;
}

function check(config: SignalServerConfig): void {
  const dir = dirname(config.output);
  try {
    const fd = openSync(config.output, "a", 0o600);
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    fail(`输出文件不可写：${dir}（${(error as Error).message}）`);
  }
}

/** 已有行数 + 最大 seq：文件是唯一真值，避免第二次启动从 1 重新计数。 */
function nextSeq(output: string): { seq: number; count: number; bytes: number } {
  const raw = readFileSync(output, "utf8");
  let max = 0;
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as { seq?: unknown };
      if (typeof parsed.seq === "number" && Number.isInteger(parsed.seq)) {
        max = Math.max(max, parsed.seq);
        count += 1;
      }
    } catch {
      // 崩溃留下的半行：忽略，不当作已有记录。
    }
  }
  return { seq: max + 1, count, bytes: byteLength(raw) };
}

type JsonRpcId = number | string | null;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcId, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function describeTool(kind: string): string {
  if (kind === SIGNAL_KIND_CONFIRMATION_REQUEST) {
    return `提交一个执行中临时确认点（${kind}），然后停止本轮。参数错误时按错误提示修正后重试；调用后不要继续猜测人的决定。`;
  }
  return `提交本节点的结构化结果（${kind}）。review 节点必须调用一次；参数错误时按错误提示修正后重试。`;
}

function toolResult(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], isError };
}

function callSignal(config: SignalServerConfig, tool: SignalContractSpec, args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return toolResult("参数必须是对象", true);
  }
  const record = args as Record<string, unknown>;
  if (record.kind !== tool.kind) return toolResult(`kind 必须是 ${tool.kind}`, true);
  const data: Record<string, unknown> = { ...record };
  delete data.kind;
  const errors = validateSignalData(tool.schema, data);
  if (errors.length > 0) return toolResult(`参数非法：${errors.join("; ")}`, true);

  const state = nextSeq(config.output);
  if (state.count >= config.limits.maxSignals) {
    return toolResult(`信号数量超过上限 ${config.limits.maxSignals}`, true);
  }
  const signal = { seq: state.seq, at: new Date().toISOString(), kind: tool.kind, data };
  const line = `${JSON.stringify(signal)}\n`;
  if (state.bytes + byteLength(line) > Math.min(config.limits.maxBytes, SIGNAL_LIMITS.maxBytes)) {
    return toolResult(`信号文件超过上限 ${config.limits.maxBytes} 字节`, true);
  }
  let fd: number | undefined;
  try {
    fd = openSync(config.output, "a", 0o600);
    appendFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } catch (writeError) {
    return toolResult(`写入失败：${(writeError as Error).message}`, true);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return toolResult(JSON.stringify({ ok: true, seq: signal.seq }));
}

function toolNamed(config: SignalServerConfig, name: unknown): SignalContractSpec | undefined {
  return config.tools.find((tool) => toolNameForKind(tool.kind) === name);
}

function handleMessage(config: SignalServerConfig, message: Record<string, unknown>): void {
  const id = (message.id ?? null) as JsonRpcId;
  const method = message.method;
  if (typeof method !== "string") {
    if (message.id !== undefined) error(id, -32600, "缺少 method");
    return;
  }
  // 通知（无 id）一律忽略：包括 notifications/initialized。
  if (message.id === undefined) return;
  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: (message.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "agentflow-signal", version: "1.0.0" },
      });
      return;
    case "ping":
      result(id, {});
      return;
    case "tools/list":
      result(id, {
        tools: config.tools.map((tool) => ({
          name: toolNameForKind(tool.kind),
          description: describeTool(tool.kind),
          inputSchema: toMcpInputSchema({ version: config.version, kind: tool.kind, required: true, schema: tool.schema }),
        })),
      });
      return;
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = toolNamed(config, params.name);
      if (tool === undefined) {
        error(id, -32602, `未知工具：${String(params.name)}`);
        return;
      }
      result(id, callSignal(config, tool, params.arguments));
      return;
    }
    default:
      // 含 server/discover：必须立即回错，DSH 才能毫秒级回落 legacy initialize。
      error(id, -32601, `未知方法：${method}`);
  }
}

/** 入口：`--check` 只校验并退出；否则跑 stdio MCP 循环。供 CLI 子命令与直接执行共用。 */
export async function runSignalServer(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const checkMode = argv.includes("--check");
  const config = await loadConfig();
  if (checkMode) {
    check(config);
    return 0;
  }
  check(config);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          error(null, -32700, "JSON 解析失败");
          index = buffer.indexOf("\n");
          continue;
        }
        handleMessage(config, message);
      }
      index = buffer.indexOf("\n");
    }
  });
  // stdio 模式下由 stdin/信号决定退出；返回的 Promise 只在 end 时结算。
  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => process.exit(0));
    }
  });
  return 0;
}

if (import.meta.main) await runSignalServer();
