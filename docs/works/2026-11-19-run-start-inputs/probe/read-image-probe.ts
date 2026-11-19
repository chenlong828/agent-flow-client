/**
 * 读图能力探针（T-CLI-IMG-01）：用 client 真实生成的 profile 补丁启动 `dsh --profile acp`，
 * 检查 initialize 的 promptCapabilities.image，并让模型用 read_image 读一张 PNG。
 *
 * 用法（在仓库根目录）：
 *   set -a; . ./.env; set +a
 *   bun docs/works/2026-11-19-run-start-inputs/probe/read-image-probe.ts
 *
 * 依赖：DSH_BIN、HUNDSUN_PUBLIC_API_KEY；可选 AF_MODEL / AF_LLM_BASE_URL。
 * 输出：probe/read-image-evidence.json 与 stdout 摘要。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDshCommand } from "../../../../src/components/runtime/dsh.ts";
import { S0_MODEL, writeProfilePatch } from "../../../../src/components/runtime/profile.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const PROBE_DIR = import.meta.dir;
const IMAGE = join(PROBE_DIR, "read-image-probe.png");
const PROMPT_TIMEOUT_MS = 180_000;
const INIT_TIMEOUT_MS = 20_000;

class LineRpc {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = "";
  readonly #texts: string[] = [];
  readonly #toolCalls: string[] = [];
  stderr = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      for (const entry of this.#pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`DSH 退出（code=${String(code)}）`));
      }
      this.#pending.clear();
    });
  }

  get text(): string {
    return this.#texts.join("");
  }

  get toolCalls(): string[] {
    return this.#toolCalls;
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === "") continue;
      this.#onMessage(JSON.parse(line) as Record<string, unknown>);
    }
  }

  #onMessage(message: Record<string, unknown>): void {
    if (message.id !== undefined && typeof message.method === "string") {
      this.#answerServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id as number);
      if (entry === undefined) return;
      clearTimeout(entry.timer);
      this.#pending.delete(message.id as number);
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method !== "session/update") return;
    const update = (message.params as { update?: Record<string, unknown> } | undefined)?.update ?? {};
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && typeof content.text === "string") this.#texts.push(content.text);
      return;
    }
    if (update.sessionUpdate === "tool_call") this.#toolCalls.push(String(update.title ?? ""));
  }

  #answerServerRequest(message: Record<string, unknown>): void {
    const params = message.params as { options?: { optionId?: string; kind?: string }[] } | undefined;
    if (message.method === "session/request_permission") {
      const allow = params?.options?.find((option) => option.kind === "allow_once" || option.kind === "allow_always");
      const result =
        allow?.optionId === undefined
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected", optionId: allow.optionId } };
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      return;
    }
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported: ${String(message.method)}` } })}\n`,
    );
  }
}

async function main(): Promise<void> {
  const dsh = resolveDshCommand(process.env);
  if (dsh === null) throw new Error("未找到 DSH 入口：设置 DSH_BIN");
  const apiKey = process.env.HUNDSUN_PUBLIC_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") throw new Error("缺少 HUNDSUN_PUBLIC_API_KEY");

  const imageBytes = await readFile(IMAGE);
  const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");

  const base = await mkdtemp(join(tmpdir(), "afc-read-image-"));
  const home = join(base, "home");
  const cwd = join(base, "workspace");
  await mkdir(cwd, { recursive: true });
  const imagePath = join(cwd, "read-image-probe.png");
  await copyFile(IMAGE, imagePath);

  const model = {
    ...S0_MODEL,
    model: process.env.AF_MODEL?.trim() || S0_MODEL.model,
    baseUrl: process.env.AF_LLM_BASE_URL?.trim() || S0_MODEL.baseUrl,
  };
  const patchPath = await writeProfilePatch(home, model);

  const child = spawn(dsh.command, [...dsh.args, "--profile", "acp", "--patch", patchPath], {
    cwd,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const rpc = new LineRpc(child);

  try {
    const initialize = (await rpc.request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "afc-read-image-probe", version: "0.0.1" } },
      INIT_TIMEOUT_MS,
    )) as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } };
    const imageCapability = initialize.agentCapabilities?.promptCapabilities?.image === true;

    const session = (await rpc.request("session/new", { cwd, mcpServers: [] }, INIT_TIMEOUT_MS)) as { sessionId?: string };
    const sessionId = session.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") throw new Error("session/new 没有返回 sessionId");

    const prompt = [
      `请调用 read_image 工具读取图片：${imagePath}`,
      "然后只回答两点：1) 图中出现的英文字样与数字；2) 图中是否有蓝色矩形。",
    ].join("\n");
    const result = (await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }, PROMPT_TIMEOUT_MS)) as {
      stopReason?: unknown;
    };

    const evidence = {
      at: new Date().toISOString(),
      dsh: { command: dsh.command, args: dsh.args, source: dsh.source },
      model,
      image: { path: imagePath, sha256: imageSha256, bytes: imageBytes.byteLength },
      initialize: { promptCapabilities: initialize.agentCapabilities?.promptCapabilities ?? null },
      prompt,
      toolCalls: rpc.toolCalls,
      stopReason: result.stopReason ?? null,
      finalText: rpc.text,
      assertions: {
        imageCapability,
        textReported: rpc.text.includes("AF IMG 7319"),
        shapeReported: /蓝色|blue|矩形|square/i.test(rpc.text),
        readImageCalled: rpc.toolCalls.some((title) => title.includes("read_image")),
      },
    };
    await writeFile(join(PROBE_DIR, "read-image-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
    const failed = Object.entries(evidence.assertions).filter(([, ok]) => !ok);
    if (failed.length > 0) throw new Error(`读图验证未通过：${failed.map(([key]) => key).join(", ")}`);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

await main();
