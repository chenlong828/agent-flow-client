import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSignal, SignalError } from "../../../src/components/signal/signal.ts";
import type { SignalServerConfig } from "../../../src/components/signal/plan.ts";
import { confirmationRequestContract, reviewVerdictContract } from "../../support/signal-contract.ts";
import { attemptDir, signalRoot } from "../../../src/components/signal/directory.ts";
import { resolveSignalServerCommand } from "../../../src/components/signal/mcp.ts";
import { spawn } from "node:child_process";
import { collectSignals } from "../../../src/components/signal/collect.ts";

const contract = reviewVerdictContract;
const confirmation = confirmationRequestContract;

async function fixture(): Promise<{ stateRoot: string; signal: FileSignal }> {
  const stateRoot = await mkdtemp(join(tmpdir(), "afc-signal-"));
  return { stateRoot, signal: new FileSignal({ stateRoot }) };
}

describe("CMP-signal.prepare", () => {
  test("单契约：建目录、写 config（tools 一项）、生成 mcpServers（绝对路径 + AF_SIGNAL_CONFIG）", async () => {
    const { stateRoot, signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "task-1", attempt: 1, contracts: [contract] });
    expect(prepared.status).toBe("ok");
    if (prepared.status !== "ok") return;
    const { plan } = prepared;
    expect(plan.outputPath).toBe(join(attemptDir(stateRoot, "task-1", 1), "signals.jsonl"));
    const config = JSON.parse(await readFile(plan.configPath, "utf8")) as SignalServerConfig;
    expect(config).toMatchObject({ version: 1, taskId: "task-1", attempt: 1 });
    expect(config.tools.map((tool) => tool.kind)).toEqual(["review_verdict"]);
    expect(config.tools[0]?.schema).toEqual(contract.schema);
    expect(config.limits).toEqual({ maxSignals: 8, maxBytes: 16384 });
    expect(plan.mcpServers).toHaveLength(1);
    expect(plan.mcpServers[0]?.name).toBe("agentflow");
    expect(plan.mcpServers[0]?.args[0]).toContain("src/mcp/signal-server.ts");
    expect(plan.mcpServers[0]?.env).toEqual([{ name: "AF_SIGNAL_CONFIG", value: plan.configPath }]);
  });

  test("两个契约：一份 config、一个 server、tools 两项（review 同时挂 signal + confirm）", async () => {
    const { signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "task-2", attempt: 1, contracts: [contract, confirmation] });
    expect(prepared.status).toBe("ok");
    if (prepared.status !== "ok") return;
    const config = JSON.parse(await readFile(prepared.plan.configPath, "utf8")) as SignalServerConfig;
    expect(config.tools.map((tool) => tool.kind)).toEqual(["review_verdict", "confirmation_request"]);
    expect(prepared.plan.mcpServers).toHaveLength(1);
    expect(prepared.plan.contracts.map((item) => item.kind)).toEqual(["review_verdict", "confirmation_request"]);
  });

  test("重复 kind 按配置错误失败（不静默覆盖工具）", async () => {
    const { signal } = await fixture();
    const failure = await signal
      .prepare({ taskId: "t", attempt: 1, contracts: [contract, { ...contract }] })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(SignalError);
    expect((failure as SignalError).code).toBe("signal_prepare_failed");
    expect((failure as Error).message).toContain("kind 重复");
  });

  test("不支持的 kind 返回 unsupported（不判失败）", async () => {
    const { signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "t", attempt: 1, contracts: [{ ...contract, kind: "other" }] });
    expect(prepared).toMatchObject({ status: "unsupported" });
  });

  test("schema 非法按配置错误失败", async () => {
    const { signal } = await fixture();
    const failure = await signal
      .prepare({ taskId: "t", attempt: 1, contracts: [
        {
          kind: "review_verdict",
          schema: { type: "object", additionalProperties: true, required: [], properties: {} } as unknown as typeof contract.schema,
        },
      ] })
      .catch((error: Error) => error);
    expect((failure as SignalError).code).toBe("signal_prepare_failed");
    expect((failure as Error).message).toContain("schema 非法");
  });

  test("taskId 含路径分隔符时回落到摘要目录", async () => {
    const { stateRoot, signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "../../etc/passwd", attempt: 1, contracts: [contract] });
    expect(prepared.status).toBe("ok");
    if (prepared.status !== "ok") return;
    expect(prepared.plan.dir.startsWith(signalRoot(stateRoot))).toBe(true);
    expect(prepared.plan.dir.includes("..")).toBe(false);
  });
});

describe("CMP-signal.collect", () => {
  test("取最后窗口、忽略半行与非法行", async () => {
    const { stateRoot, signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "t", attempt: 1, contracts: [contract] });
    if (prepared.status !== "ok") throw new Error("prepare 失败");
    const lines = [
      { seq: 1, at: "2026-11-18T00:00:00.000Z", kind: "review_verdict", data: { verdict: "fail", reason: "first" } },
      { seq: 2, at: "2026-11-18T00:00:01.000Z", kind: "review_verdict", data: { verdict: "pass", reason: "second" } },
      { seq: 3, at: "2026-11-18T00:00:02.000Z", kind: "review_verdict", data: { verdict: "nope", reason: "bad enum" } },
    ];
    await writeFile(
      prepared.plan.outputPath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"seq":4,"at":"2026-11-18T00:00:03`,
    );
    const signals = await signal.collect({ taskId: "t", attempt: 1, plan: prepared.plan });
    expect(signals).toHaveLength(2);
    expect(signals?.[0]?.seq).toBe(1);
    expect(signals?.[1]?.data.reason).toBe("second");
    expect(attemptDir(stateRoot, "t", 1)).toBe(prepared.plan.dir);
  });

  test("两个契约：按 kind 分派校验，未挂 kind 的行记 invalid", async () => {
    const { signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "t", attempt: 1, contracts: [contract, confirmation] });
    if (prepared.status !== "ok") throw new Error("prepare 失败");
    const records = [
      { seq: 1, at: "2026-11-18T00:00:00.000Z", kind: "review_verdict", data: { verdict: "pass", reason: "ok" } },
      { seq: 2, at: "2026-11-18T00:00:01.000Z", kind: "confirmation_request", data: { question: "继续吗？" } },
      { seq: 3, at: "2026-11-18T00:00:02.000Z", kind: "unknown_kind", data: { x: 1 } },
      { seq: 4, at: "2026-11-18T00:00:03.000Z", kind: "confirmation_request", data: { context: "缺 question" } },
    ];
    await writeFile(prepared.plan.outputPath, `${records.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const signals = await signal.collect({ taskId: "t", attempt: 1, plan: prepared.plan });
    expect(signals?.map((item) => item.kind)).toEqual(["review_verdict", "confirmation_request"]);
    expect(signals?.[1]?.data.question).toBe("继续吗？");
    const collected = await collectSignals(prepared.plan.contracts, prepared.plan.outputPath);
    expect(collected.invalid).toBe(2);
  });

  test("超过 8 条只保留最后 8 条；超过 16 KiB 从最旧的丢", async () => {
    const { signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "t", attempt: 1, contracts: [contract] });
    if (prepared.status !== "ok") throw new Error("prepare 失败");
    const records = Array.from({ length: 12 }, (_, index) => ({
      seq: index + 1,
      at: "2026-11-18T00:00:00.000Z",
      kind: "review_verdict",
      data: { verdict: "pass", reason: `r${index}` },
    }));
    await writeFile(prepared.plan.outputPath, `${records.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const signals = await signal.collect({ taskId: "t", attempt: 1, plan: prepared.plan });
    expect(signals).toHaveLength(8);
    expect(signals?.[0]?.seq).toBe(5);
  });

  test("无文件时返回 undefined", async () => {
    const { signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "t", attempt: 1, contracts: [contract] });
    if (prepared.status !== "ok") throw new Error("prepare 失败");
    const signals = await signal.collect({ taskId: "t", attempt: 1, plan: prepared.plan });
    expect(signals).toBeUndefined();
  });
});

describe("CMP-signal.cleanup", () => {
  test("删除超过保留期的 attempt 目录，保留新目录", async () => {
    const { stateRoot, signal } = await fixture();
    const oldDir = attemptDir(stateRoot, "old-task", 1);
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "signals.jsonl"), "");
    const past = new Date("2026-10-01T00:00:00.000Z");
    await utimes(oldDir, past, past);
    const fresh = attemptDir(stateRoot, "new-task", 1);
    await mkdir(fresh, { recursive: true });
    const removed = await signal.cleanup(7);
    expect(removed).toBe(1);
    expect(await stat(oldDir).catch(() => null)).toBeNull();
    expect((await stat(fresh)).isDirectory()).toBe(true);
  });
});

describe("T-RVM-02 分发形态", () => {
  test("Bun 运行时用绝对脚本；编译后的单二进制用隐藏子命令", () => {
    expect(resolveSignalServerCommand({ execPath: "/Users/x/.bun/bin/bun", entryPath: "/srv/signal-server.ts" })).toEqual({
      command: "/Users/x/.bun/bin/bun",
      args: ["/srv/signal-server.ts"],
    });
    expect(resolveSignalServerCommand({ execPath: "C:\\tools\\agent-flow-client.exe", entryPath: "C:\\srv\\signal-server.ts" })).toEqual({
      command: "C:\\tools\\agent-flow-client.exe",
      args: ["signal-server"],
    });
  });

  test("CLI 子命令 signal-server --check 与直接执行同语义", async () => {
    const { signal } = await fixture();
    const prepared = await signal.prepare({ taskId: "cli-1", attempt: 1, contracts: [contract] });
    if (prepared.status !== "ok") throw new Error("prepare 失败");
    const child = spawn(process.execPath, [join(import.meta.dir, "../../../src/cli.ts"), "signal-server", "--check"], {
      env: { ...process.env, AF_SIGNAL_CONFIG: prepared.plan.configPath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
  });
});
