#!/usr/bin/env bun
// 最小 stdio MCP server：行分隔 JSON-RPC；只做 spike 观测，不做校验。
import { appendFileSync } from "node:fs";

const LOG = process.env.AF_SPIKE_LOG ?? "/tmp/af-spike-mcp.log";

function log(event, extra = {}) {
  appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...extra })}\n`);
}

log("start", {
  argv: process.argv.slice(0, 4),
  execPath: process.execPath,
  cwd: process.cwd(),
  ppid: process.ppid,
  envNames: Object.keys(process.env).sort(),
});

const TOOLS = [
  {
    name: "signal",
    description: "提交结构化节点结果（spike 版）。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { const: "review_verdict" },
        verdict: { type: "string", enum: ["pass", "fail", "needs_human"] },
        reason: { type: "string" },
      },
      required: ["kind", "verdict", "reason"],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") handle(line);
  }
});
process.stdin.on("end", () => {
  log("stdin-end");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("sigterm");
  process.exit(0);
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log("bad-json", { line: line.slice(0, 200) });
    return;
  }
  log("recv", { method: message.method, id: message.id ?? null });
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "spike-signal", version: "0.0.1" },
        },
      });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      const args = message.params?.arguments ?? {};
      log("tool-call", { name: message.params?.name, args });
      const verdicts = ["pass", "fail", "needs_human"];
      if (!verdicts.includes(args.verdict) || typeof args.reason !== "string" || args.reason === "" || args.kind !== "review_verdict") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "invalid: verdict must be pass|fail|needs_human; reason required" }], isError: true },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `ok:${args.verdict ?? "?"}` }], isError: false },
      });
      return;
    }
    case "ping":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } });
  }
}
