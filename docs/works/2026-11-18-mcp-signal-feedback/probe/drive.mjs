#!/usr/bin/env bun
// DSH ACP MCP spike 驱动：挂载、调用、权限、启动失败、进程回收。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname);
const LOG_DIR = join(ROOT, "logs");
const MCP_LOG = join(LOG_DIR, "mcp.jsonl");
const DSH_LOG = join(LOG_DIR, "dsh-stderr.log");
const REPORT = join(LOG_DIR, "report.json");
const SERVER = join(ROOT, "mcp", "signal.mjs");
const WORKSPACE = join(ROOT, "workspace");
const DSH_HOME = join(ROOT, "dsh-home");
const PATCH = join(ROOT, "patch.json");
const ENTRY = "/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js";

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(DSH_HOME, { recursive: true });
writeFileSync(MCP_LOG, "");

function envFile() {
  const map = {};
  for (const line of readFileSync("/Users/chenlong/harness/agent-flow-client/.env", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) map[match[1]] = match[2];
  }
  return map;
}
const dotenv = envFile();

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

const report = { phases: {}, serverPids: [] };

/** ACP 客户端最小实现（行分隔 JSON-RPC）。 */
class Acp {
  #child;
  #pending = new Map();
  #nextId = 1;
  requests = [];
  notifications = [];
  stderr = [];
  exited = null;

  constructor() {
    this.#child = spawn("node", [ENTRY, "--profile", "acp", "--patch", PATCH], {
      cwd: WORKSPACE,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DSH_HOME,
        DSH_TELEMETRY_DISABLED: "1",
        HUNDSUN_PUBLIC_API_KEY: dotenv.HUNDSUN_PUBLIC_API_KEY ?? "",
      },
    });
    this.pid = this.#child.pid;
    let buffer = "";
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== "") this.#onLine(line);
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => this.stderr.push(chunk));
    this.#child.on("exit", (code) => {
      this.exited = code;
      for (const pending of this.#pending.values()) pending.reject(new Error(`dsh exited: ${code}`));
      this.#pending.clear();
    });
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr.push(`non-json: ${line}\n`);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      this.requests.push({ method: message.method, params: message.params });
      this.#reply(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
      else pending.resolve(message.result);
      return;
    }
    this.notifications.push({ method: message.method, params: message.params });
  }

  #reply(message) {
    // 权限请求：一律选第一个 allow 选项，并记录完整 params。
    if (message.method === "session/request_permission") {
      const options = message.params?.options ?? [];
      const allow = options.find((option) => option.kind === "allow_once") ?? options[0];
      this.#send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId } } });
      return;
    }
    this.#send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
  }

  #send(message) {
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {}
  }

  request(method, params, timeoutMs) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  killGroup() {
    try {
      process.kill(-this.pid, "SIGKILL");
    } catch (error) {
      this.stderr.push(`killGroup: ${error.message}\n`);
    }
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function toolCalls(acp) {
  return acp.notifications
    .filter((item) => item.params?.update !== undefined)
    .map((item) => item.params.update)
    .filter((update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
    .map((update) => ({
      sessionUpdate: update.sessionUpdate,
      title: update.title,
      toolCallId: update.toolCallId,
      status: update.status,
      rawInput: update.rawInput,
      content: update.content,
    }));
}

function mcpLog() {
  return readFileSync(MCP_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

async function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const mcpServersFor = (logPath) => [
  {
    name: "agentflow",
    command: process.execPath,
    args: [SERVER],
    env: [{ name: "AF_SPIKE_LOG", value: logPath }],
  },
];

const PROMPT =
  "请调用来自 MCP 服务器 agentflow 的工具（工具名以 mcp__agentflow__ 开头）：第一步故意传 verdict=maybe、reason=try-invalid，kind=review_verdict；如果工具返回错误，第二步按错误提示改成 verdict=pass、reason=spike-ok 重试一次。完成后简短结束。";

const acp = new Acp();
await new Promise((done) => setTimeout(done, 300));

try {
  const init = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "spike", version: "0.0.1" } }, 30_000);
  report.phases.initialize = { ok: true, agentInfo: init?.agentInfo, agentCapabilities: init?.agentCapabilities };

  // A. 正常挂载 + 工具调用
  const phaseA = { startedAt: new Date().toISOString() };
  try {
    const session = await acp.request("session/new", { cwd: WORKSPACE, mcpServers: mcpServersFor(MCP_LOG) }, 60_000);
    phaseA.sessionId = session?.sessionId;
    phaseA.newSessionOk = typeof session?.sessionId === "string";
    try {
      const promptResult = await acp.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: PROMPT }] }, 180_000);
      phaseA.prompt = promptResult;
    } catch (error) {
      phaseA.promptError = { message: error.message, rpc: error.rpc };
    }
    phaseA.toolCalls = toolCalls(acp);
    phaseA.permissionRequests = acp.requests.filter((item) => item.method === "session/request_permission");
    phaseA.otherServerRequests = acp.requests.filter((item) => item.method !== "session/request_permission").map((item) => item.method);
    phaseA.mcpLog = mcpLog();
    phaseA.serverPid = phaseA.mcpLog.find((entry) => entry.event === "start")?.pid ?? null;
    if (phaseA.serverPid !== null) report.serverPids.push(phaseA.serverPid);
    await acp.request("session/close", { sessionId: session.sessionId }, 20_000).catch((error) => {
      phaseA.closeError = error.message;
    });
    await sleep(500);
    phaseA.serverAliveAfterSessionClose = phaseA.serverPid === null ? null : await alive(phaseA.serverPid);
  } catch (error) {
    phaseA.error = { message: error.message, rpc: error.rpc };
  }
  phaseA.finishedAt = new Date().toISOString();
  report.phases.mountAndCall = phaseA;

  if (process.env.SKIP_EXTRA === "1") {
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(DSH_LOG, acp.stderr.join(""));
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // B. 启动失败：command 存在但不可执行 / 直接不存在
  for (const [label, command] of [
    ["missing-command", "/nonexistent/agentflow-signal"],
    ["broken-script", process.execPath],
  ]) {
    const phase = { label, command };
    try {
      const session = await acp.request(
        "session/new",
        {
          cwd: WORKSPACE,
          mcpServers: [
            {
              name: "agentflow",
              command,
              args: label === "broken-script" ? ["/nonexistent/agentflow-signal.mjs"] : [],
              env: [{ name: "AF_SPIKE_LOG", value: join(LOG_DIR, `${label}.jsonl`) }],
            },
          ],
        },
        60_000,
      );
      phase.sessionId = session?.sessionId ?? null;
      phase.ok = true;
      if (phase.sessionId !== null) await acp.request("session/close", { sessionId: phase.sessionId }, 20_000).catch(() => {});
    } catch (error) {
      phase.ok = false;
      phase.error = { message: error.message, code: error.rpc?.code, data: error.rpc?.data };
    }
    report.phases[label] = phase;
  }

  // C. 进程组回收：建立带 MCP 的 session 后强杀 DSH 进程组
  const phaseC = {};
  try {
    const session = await acp.request("session/new", { cwd: WORKSPACE, mcpServers: mcpServersFor(MCP_LOG) }, 60_000);
    phaseC.sessionId = session?.sessionId;
    await sleep(500);
    const entries = mcpLog().filter((entry) => entry.event === "start");
    const pid = entries.at(-1)?.pid ?? null;
    phaseC.serverPid = pid;
    if (pid !== null) report.serverPids.push(pid);
    acp.killGroup();
    await sleep(1_000);
    phaseC.dshExited = acp.exited;
    phaseC.serverAliveAfterKillGroup = pid === null ? null : await alive(pid);
  } catch (error) {
    phaseC.error = { message: error.message, rpc: error.rpc };
  }
  report.phases.killGroupReap = phaseC;
} finally {
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(DSH_LOG, acp.stderr.join(""));
  try {
    process.kill(-acp.pid, "SIGKILL");
  } catch {}
  for (const pid of report.serverPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
