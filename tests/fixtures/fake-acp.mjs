#!/usr/bin/env node
// 测试用 ACP 服务器：覆盖 initialize/session/new/prompt/update/permission/cancel/close。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const sessions = new Map();
let buffer = "";
let nextServerRequestId = 1000;
let counter = 0;

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
      sessions.delete(message.params.sessionId);
      result(message.id, {});
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
