#!/usr/bin/env node
// 测试用 ACP 服务器：覆盖 initialize/session/new/prompt/update/permission/cancel/close。
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

if (process.argv.includes("-V")) {
  process.stdout.write("0.2.2-alpha.2\n");
  process.exit(0);
}

const sessions = new Map();
const closed = new Set();
let buffer = "";
let nextServerRequestId = 1000;
let counter = 0;

if (process.env.FAKE_ACP_PROC_LOG) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.FAKE_ACP_PROC_LOG, `${process.pid}\n`);
}

if (process.env.FAKE_ACP_PID_FILE) {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_ACP_PID_FILE, String(child.pid));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function chunk(sessionId, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
}

function usage(sessionId) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "usage_update", inputTokens: 3, outputTokens: 2 } },
  });
}

function finish(sessionId, promptId, stopReason = "end_turn") {
  usage(sessionId);
  result(promptId, { stopReason, usage: { inputTokens: 3, outputTokens: 2 } });
}

function handlePrompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt?.[0]?.text ?? "";
  if (text.includes("CRASH")) {
    setTimeout(() => process.exit(3), 10);
    return;
  }
  if (text.includes("SLOW")) {
    if (process.env.FAKE_ACP_PROMPT_FILE) {
      const { writeFileSync } = require("node:fs");
      writeFileSync(process.env.FAKE_ACP_PROMPT_FILE, text);
    }
    sessions.set(sessionId, { pending: { id, cancelled: false } });
    return;
  }
  if (text.includes("PERMISSION")) {
    const requestId = nextServerRequestId++;
    sessions.set(sessionId, { permission: { promptId: id, requestId } });
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { title: null, kind: null },
        options: [
          { optionId: "allow-1", kind: "allow_once", name: "Allow" },
          { optionId: "reject-1", kind: "reject_once", name: "Reject" },
        ],
      },
    });
    return;
  }
  chunk(sessionId, `OK-${text}`);
  finish(sessionId, id);
}

function handleResponse(message) {
  const session = [...sessions.values()].find((item) => item.permission?.requestId === message.id);
  if (!session) return;
  const sessionId = [...sessions.entries()].find(([, item]) => item === session)?.[0];
  if (!sessionId) return;
  const allowed = message.result?.outcome?.outcome === "selected";
  chunk(sessionId, allowed ? "ALLOWED" : "DENIED");
  finish(sessionId, session.permission.promptId);
  sessions.set(sessionId, {});
}

function onLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    handleResponse(message);
    return;
  }
  switch (message.method) {
    case "initialize":
      result(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      return;
    case "session/new": {
      const mcpServers = message.params?.mcpServers ?? [];
      if (process.env.FAKE_ACP_MCP_FILE) {
        appendFileSync(process.env.FAKE_ACP_MCP_FILE, `${JSON.stringify(mcpServers)}\n`);
      }
      if (process.env.FAKE_ACP_MCP_FAIL_ALWAYS && mcpServers.length > 0) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: "Internal error",
            data: { details: "mcp-client(agentflow): initial connection or tool synchronization failed" },
          },
        });
        return;
      }
      // 模拟 DSH 挂载失败：第一次带 mcpServers 的 session/new 返回 -32603 + details（Q-07/Q-09 用）。
      if (process.env.FAKE_ACP_MCP_FAIL_ONCE && mcpServers.length > 0) {
        const stateFile = `${process.env.FAKE_ACP_MCP_FAIL_ONCE}-${process.pid}.state`;
        if (!existsSync(stateFile)) {
          writeFileSync(stateFile, "failed");
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: "Internal error",
              data: { details: "mcp-client(agentflow): initial connection or tool synchronization failed" },
            },
          });
          return;
        }
      }
      // 模拟模型调用 `mcp__agentflow__signal`：直接往信号文件追加一行合法记录。
      if (process.env.FAKE_ACP_EMIT_SIGNAL && mcpServers.length > 0) {
        const configPath = (mcpServers[0]?.env ?? []).find((item) => item.name === "AF_SIGNAL_CONFIG")?.value;
        if (typeof configPath === "string" && existsSync(configPath)) {
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          const data = config.kind === "confirmation_request"
            ? { question: "继续吗？", context: "stub-confirm" }
            : { verdict: "pass", reason: "from-fake-acp" };
          appendFileSync(
            config.output,
            `${JSON.stringify({ seq: 1, at: new Date().toISOString(), kind: config.kind, data })}\n`,
          );
        }
      }
      const sessionId = `s-${++counter}`;
      sessions.set(sessionId, {});
      result(message.id, {
        sessionId,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "hs-deepseek-flash-latest",
            options: [{ value: "hs-deepseek-flash-latest", name: "hs-deepseek-flash-latest" }],
          },
        ],
      });
      return;
    }
    case "session/prompt":
      handlePrompt(message.id, message.params);
      return;
    case "session/cancel": {
      const session = sessions.get(message.params.sessionId);
      if (session?.pending) {
        result(session.pending.id, { stopReason: "cancelled", usage: null });
        sessions.set(message.params.sessionId, {});
      }
      return;
    }
    case "session/close": {
      if (!sessions.has(message.params.sessionId)) {
        fail(message.id, -32602, "unknown session");
        return;
      }
      closed.add(message.params.sessionId);
      sessions.delete(message.params.sessionId);
      result(message.id, {});
      return;
    }
    case "session/resume": {
      const sessionId = message.params.sessionId;
      if (process.env.FAKE_ACP_RESUME_LOG) {
        appendFileSync(process.env.FAKE_ACP_RESUME_LOG, `${sessionId}\n`);
      }
      if (!closed.has(sessionId)) {
        fail(message.id, -32602, `session is not resumable: ${sessionId}`);
        return;
      }
      closed.delete(sessionId);
      sessions.set(sessionId, {});
      result(message.id, { configOptions: [] });
      return;
    }
    case "session/set_config_option":
      result(message.id, { configOptions: [] });
      return;
    default:
      fail(message.id, -32601, `unsupported ${message.method}`);
  }
}

process.stdin.on("data", (data) => {
  buffer += data.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== "") onLine(line);
    index = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => process.exit(0));

// 记录子进程实际收到的 DSH_HOME（TC-CONFIG-002 的端到端断言）。
if (process.env.FAKE_ACP_HOME_FILE) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.FAKE_ACP_HOME_FILE, String(process.env.DSH_HOME ?? ""));
}
