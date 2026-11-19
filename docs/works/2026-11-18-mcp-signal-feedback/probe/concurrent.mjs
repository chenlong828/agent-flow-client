#!/usr/bin/env bun
// 并发同名 MCP server 挂载：同一 DSH 进程内两个 session 同时挂 agentflow。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname);
const LOG = join(ROOT, "logs", "concurrent-mcp.jsonl");
const SERVER = join(ROOT, "mcp", "signal.mjs");
const WORKSPACE = join(ROOT, "workspace");
const PATCH = join(ROOT, "patch.json");
const ENTRY = "/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js";
writeFileSync(LOG, "");

const env = {};
for (const line of readFileSync("/Users/chenlong/harness/agent-flow-client/.env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const child = spawn("node", [ENTRY, "--profile", "acp", "--patch", PATCH], {
  cwd: WORKSPACE,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: join(ROOT, "dsh-home"), DSH_TELEMETRY_DISABLED: "1", HUNDSUN_PUBLIC_API_KEY: env.HUNDSUN_PUBLIC_API_KEY ?? "" },
});

let buffer = "";
const pending = new Map();
let nextId = 1;
let serverRequests = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && msg.method !== undefined) {
      serverRequests.push({ method: msg.method, params: msg.params });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: msg.params?.options?.[0]?.optionId } } })}\n`);
      continue;
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result);
    }
  }
});
child.stderr.on("data", (chunk) => appendFileSync(LOG, `stderr:${chunk}`));

const request = (method, params, timeoutMs) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), timeoutMs);
    pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const mcpServers = [{ name: "agentflow", command: process.execPath, args: [SERVER], env: [{ name: "AF_SPIKE_LOG", value: LOG }] }];
const out = {};
await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "spike", version: "0.0.1" } }, 30_000);
try {
  const [a, b] = await Promise.all([
    request("session/new", { cwd: WORKSPACE, mcpServers }, 60_000),
    request("session/new", { cwd: WORKSPACE, mcpServers }, 60_000),
  ]);
  out.sessions = [a?.sessionId, b?.sessionId];
  out.ok = true;
  const starts = readFileSync(LOG, "utf8").split("\n").filter((l) => l.includes('"event":"start"'));
  out.serverStarts = starts.length;
  await Promise.all(out.sessions.map((sessionId) => request("session/close", { sessionId }, 20_000).catch(() => undefined)));
} catch (error) {
  out.ok = false;
  out.error = { message: error.message, rpc: error.rpc };
}
out.permissionRequests = serverRequests.filter((r) => r.method === "session/request_permission").length;
console.log(JSON.stringify(out, null, 2));
try { process.kill(-child.pid, "SIGKILL"); } catch {}
process.exit(0);
