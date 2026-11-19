#!/usr/bin/env bun
// server/discover 探针：server 静默忽略未知方法时，session/new 会怎样。
// 对照 drive.mjs 里的 signal-server.mjs（对未知方法立即回 -32601）。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 运行产物写到临时目录，不在文档树里留文件；证据已复制到 probe/ 根目录。
const ROOT = process.env.AF_SPIKE_RUN ?? join(tmpdir(), "af-mcp-spike-discover");
mkdirSync(ROOT, { recursive: true });
const LOG = join(ROOT, "discover-ignore.jsonl");
const DSH_ENTRY = "/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js";
const WORKSPACE = join(ROOT, "workspace");
const DSH_HOME = join(ROOT, "dsh-home-discover");
const PATCH = join(ROOT, "patch.json");

mkdirSync(DSH_HOME, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });
writeFileSync(LOG, "");
writeFileSync(
  PATCH,
  JSON.stringify(
    [
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "hundsun-public": {
              displayName: "hundsun-public",
              apiKeyEnv: "HUNDSUN_PUBLIC_API_KEY",
              api: "openai-completions",
              baseURL: "http://47.93.127.129:10088/v1",
              models: [{ id: "hs-deepseek-flash-latest", name: "hs-deepseek-flash-latest" }],
            },
          },
        },
      },
      { id: "agent-default-model", config: { provider: "hundsun-public", model: "hs-deepseek-flash-latest" } },
      { id: "acp", config: { provider: "hundsun-public", model: "hs-deepseek-flash-latest" } },
    ],
    null,
    2,
  ),
);

const env = {};
for (const line of readFileSync("/Users/chenlong/harness/agent-flow-client/.env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

// 变体 server：未知方法（含 server/discover）不回应。
const serverPath = join(ROOT, "server-ignore.mjs");
writeFileSync(
  serverPath,
  `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const LOG = process.env.AF_SPIKE_LOG;
const log = (e, extra = {}) => appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event: e, ...extra }) + "\\n");
log("start");
const TOOLS = [{ name: "signal", description: "x", inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false } }];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    log("recv", { method: msg.method, id: msg.id ?? null });
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ignore", version: "0.0.0" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    else if (msg.method === "ping") send({ jsonrpc: "2.0", id: msg.id, result: {} });
    // 其余方法（含 server/discover）故意不回。
  }
});
process.stdin.on("end", () => process.exit(0));
`,
);

const child = spawn("node", [DSH_ENTRY, "--profile", "acp", "--patch", PATCH], {
  cwd: WORKSPACE,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME, DSH_TELEMETRY_DISABLED: "1", HUNDSUN_PUBLIC_API_KEY: env.HUNDSUN_PUBLIC_API_KEY ?? "" },
});

let buffer = "";
const pending = new Map();
let nextId = 1;
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

const request = (method, params, timeoutMs) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout"));
    }, timeoutMs);
    pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const mcpServers = [{ name: "agentflow", command: process.execPath, args: [serverPath], env: [{ name: "AF_SPIKE_LOG", value: LOG }] }];
const out = {};
await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "spike", version: "0.0.1" } }, 30_000);
const started = Date.now();
try {
  const session = await request("session/new", { cwd: WORKSPACE, mcpServers }, 90_000);
  out.ok = typeof session?.sessionId === "string";
  await request("session/close", { sessionId: session.sessionId }, 20_000).catch(() => undefined);
} catch (error) {
  out.ok = false;
  out.error = { message: error.message, rpc: error.rpc };
}
out.elapsedMs = Date.now() - started;
out.serverLog = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
console.log(JSON.stringify(out, null, 2));
try { process.kill(-child.pid, "SIGKILL"); } catch {}
process.exit(0);
