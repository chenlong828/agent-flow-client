import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSignal } from "../../../src/components/signal/signal.ts";
import { confirmationRequestContract, reviewVerdictContract } from "../../support/signal-contract.ts";
import type { ResultSignalContract } from "../../../src/components/signal/contract.ts";

const entry = join(import.meta.dir, "../../../src/mcp/signal-server.ts");

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

class Server {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = "";

  constructor(configPath: string) {
    this.#child = spawn(process.execPath, [entry], {
      env: { ...process.env, AF_SIGNAL_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim() !== "") this.#onLine(line);
        index = this.#buffer.indexOf("\n");
      }
    });
  }

  #onLine(line: string): void {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) pending.resolve({ error: message.error });
    else pending.resolve(message.result);
  }

  request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  kill(): void {
    this.#child.kill("SIGKILL");
  }
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
});

async function prepare(contracts: ResultSignalContract[] = [reviewVerdictContract]) {
  const stateRoot = await mkdtemp(join(tmpdir(), "afc-signal-server-"));
  const signal = new FileSignal({ stateRoot });
  const prepared = await signal.prepare({ taskId: "t", attempt: 1, contracts });
  if (prepared.status !== "ok") throw new Error("prepare 失败");
  return prepared.plan;
}

async function start(plan: Awaited<ReturnType<typeof prepare>>): Promise<Server> {
  const server = new Server(plan.configPath);
  servers.push(server);
  return server;
}

async function init(server: Server): Promise<void> {
  await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
}

describe("stdio signal server", () => {
  test("server/discover 立即回 -32601（A-11），不静默等待", async () => {
    const plan = await prepare();
    const server = await start(plan);
    const started = Date.now();
    const response = (await server.request("server/discover", {})) as { error?: { code?: number } };
    expect(response.error?.code).toBe(-32601);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("initialize + tools/list：单契约一个工具、schema 投影后无执行关键字", async () => {
    const plan = await prepare();
    const server = await start(plan);
    const started = await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }) as {
      protocolVersion?: string;
      capabilities?: unknown;
    };
    expect(started.protocolVersion).toBe("2025-06-18");
    const list = (await server.request("tools/list", {})) as { tools?: Array<{ name: string; inputSchema: unknown }> };
    expect(list.tools).toHaveLength(1);
    expect(list.tools?.[0]?.name).toBe("signal");
    const schema = JSON.stringify(list.tools?.[0]?.inputSchema);
    expect(schema).toContain('"kind":{"const":"review_verdict"');
    expect(schema).not.toContain("maxLength");
    expect(schema).not.toContain("maxItems");
  });

  test("两个契约：tools/list 同时有 signal 与 confirm（review 应急确认）", async () => {
    const plan = await prepare([reviewVerdictContract, { ...confirmationRequestContract, required: false }]);
    const server = await start(plan);
    await init(server);
    const list = (await server.request("tools/list", {})) as { tools?: Array<{ name: string; inputSchema: unknown }> };
    expect(list.tools?.map((tool) => tool.name)).toEqual(["signal", "confirm"]);
    expect(JSON.stringify(list.tools?.[0]?.inputSchema)).toContain('"const":"review_verdict"');
    expect(JSON.stringify(list.tools?.[1]?.inputSchema)).toContain('"const":"confirmation_request"');
  });

  test("合法调用写入并 ack；非法 enum 不写；重启后 seq 续号", async () => {
    const plan = await prepare();
    const first = await start(plan);
    const ok = (await first.request("tools/call", {
      name: "signal",
      arguments: { kind: "review_verdict", verdict: "pass", reason: "ok" },
    })) as { content?: Array<{ text?: string }>; isError?: boolean };
    expect(ok.isError).toBe(false);
    expect(ok.content?.[0]?.text).toBe(JSON.stringify({ ok: true, seq: 1 }));

    const bad = (await first.request("tools/call", {
      name: "signal",
      arguments: { kind: "review_verdict", verdict: "maybe", reason: "x" },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    expect(await readFile(plan.outputPath, "utf8")).toContain('"seq":1');
    expect((await readFile(plan.outputPath, "utf8")).trim().split("\n")).toHaveLength(1);

    first.kill();
    const second = await start(plan);
    const again = (await second.request("tools/call", {
      name: "signal",
      arguments: { kind: "review_verdict", verdict: "fail", reason: "second" },
    })) as { content?: Array<{ text?: string }> };
    expect(again.content?.[0]?.text).toBe(JSON.stringify({ ok: true, seq: 2 }));
    expect((await readFile(plan.outputPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  test("多余字段与超长 reason 返回 isError", async () => {
    const plan = await prepare();
    const server = await start(plan);
    const extra = (await server.request("tools/call", {
      name: "signal",
      arguments: { kind: "review_verdict", verdict: "pass", reason: "ok", extra: 1 },
    })) as { isError?: boolean };
    expect(extra.isError).toBe(true);
    const long = (await server.request("tools/call", {
      name: "signal",
      arguments: { kind: "review_verdict", verdict: "pass", reason: "中".repeat(3000) },
    })) as { isError?: boolean };
    expect(long.isError).toBe(true);
    expect((await readFile(plan.outputPath, "utf8")).trim()).toBe("");
  });

  test("--check：合法 config 退出 0，缺 config 退出非 0", async () => {
    const plan = await prepare();
    const good = spawn(process.execPath, [entry, "--check"], { env: { ...process.env, AF_SIGNAL_CONFIG: plan.configPath } });
    const goodCode = await new Promise<number | null>((resolve) => good.on("exit", (code) => resolve(code)));
    expect(goodCode).toBe(0);
    const bad = spawn(process.execPath, [entry, "--check"], { env: { ...process.env, AF_SIGNAL_CONFIG: "/nonexistent.json" } });
    const badCode = await new Promise<number | null>((resolve) => bad.on("exit", (code) => resolve(code)));
    expect(badCode).not.toBe(0);
  });

  test("--check：重复工具名（重复 kind）退出非 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afc-signal-dup-"));
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        taskId: "t",
        attempt: 1,
        output: join(dir, "signals.jsonl"),
        tools: [
          { kind: "review_verdict", schema: reviewVerdictContract.schema },
          { kind: "review_verdict", schema: reviewVerdictContract.schema },
        ],
        limits: { maxSignals: 8, maxBytes: 16384 },
      }),
    );
    const child = spawn(process.execPath, [entry, "--check"], { env: { ...process.env, AF_SIGNAL_CONFIG: configPath } });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).not.toBe(0);
  });
});

describe("confirm 工具（§5.5）", () => {
  test("review 两契约：tools/call 按工具名分派，写同一 signals.jsonl", async () => {
    const plan = await prepare([reviewVerdictContract, { ...confirmationRequestContract, required: false }]);
    const server = await start(plan);
    await init(server);

    const confirm = (await server.request("tools/call", {
      name: "confirm",
      arguments: { kind: "confirmation_request", question: "选择哪个方案？", options: ["A", "B"] },
    })) as { content?: Array<{ text?: string }>; isError?: boolean };
    expect(confirm.isError).toBe(false);
    expect(confirm.content?.[0]?.text).toBe(JSON.stringify({ ok: true, seq: 1 }));

    const verdict = (await server.request("tools/call", {
      name: "signal",
      arguments: { kind: "review_verdict", verdict: "fail", reason: "等人答复后仍不通过" },
    })) as { content?: Array<{ text?: string }> };
    expect(verdict.content?.[0]?.text).toBe(JSON.stringify({ ok: true, seq: 2 }));

    const lines = (await readFile(plan.outputPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; kind: string; data: Record<string, unknown> });
    expect(lines.map((line) => line.kind)).toEqual(["confirmation_request", "review_verdict"]);
    expect(lines[0]?.data).toMatchObject({ question: "选择哪个方案？", options: ["A", "B"] });

    const wrongTool = (await server.request("tools/call", {
      name: "unknown",
      arguments: { kind: "confirmation_request", question: "x" },
    })) as { error?: { code?: number } };
    expect(wrongTool.error?.code).toBe(-32602);

    const wrongKind = (await server.request("tools/call", {
      name: "confirm",
      arguments: { kind: "review_verdict", question: "x" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(wrongKind.isError).toBe(true);
    expect(wrongKind.content?.[0]?.text).toBe("kind 必须是 confirmation_request");
  });
});
