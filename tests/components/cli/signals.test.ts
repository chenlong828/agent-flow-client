import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/components/cli/config.ts";
import { signalsCommand } from "../../../src/components/cli/signals.ts";

async function fixture(): Promise<{ runDir: string; stateRoot: string; taskId: string }> {
  const runDir = await mkdtemp(join(tmpdir(), "afc-signals-cli-"));
  const stateRoot = join(runDir, "state");
  const taskId = "task-signals-1";
  for (const attempt of [1, 2]) {
    const dir = join(stateRoot, "signals", taskId, String(attempt));
    await mkdir(dir, { recursive: true });
    const tools = [
      {
        kind: "review_verdict",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "reason"],
          properties: { verdict: { type: "string", enum: ["pass", "fail"] }, reason: { type: "string" } },
        },
      },
      ...(attempt === 2
        ? [
            {
              kind: "confirmation_request",
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["question"],
                properties: { question: { type: "string" } },
              },
            },
          ]
        : []),
    ];
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
        version: 1,
        taskId,
        attempt,
        output: join(dir, "signals.jsonl"),
        tools,
        limits: { maxSignals: 8, maxBytes: 16384 },
      }),
    );
    const records = [
      { seq: 1, at: "2026-11-18T00:00:00.000Z", kind: "review_verdict", data: { verdict: "pass", reason: `attempt-${attempt}` } },
      ...(attempt === 2
        ? [{ seq: 2, at: "2026-11-18T00:00:01.000Z", kind: "confirmation_request", data: { question: "继续吗？" } }]
        : []),
    ];
    await writeFile(join(dir, "signals.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }
  return { runDir, stateRoot, taskId };
}

async function configFor(runDir: string, stateRoot: string) {
  return await loadConfig({ runDir, env: {}, flags: { stateRoot } });
}

describe("signals 命令", () => {
  test("默认取最新 attempt；文本输出带 kinds 与计数", async () => {
    const { runDir, stateRoot, taskId } = await fixture();
    const lines: string[] = [];
    const code = await signalsCommand(await configFor(runDir, stateRoot), { out: (line) => lines.push(line), err: () => undefined }, { taskId, json: false });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("attempt 2");
    expect(text).toContain("kinds review_verdict, confirmation_request");
    expect(text).toContain("signals 2 条合法，0 行被忽略");
    expect(text).toContain("attempt-2");
  });

  test("--json 输出完整记录；--attempt 指定旧尝试", async () => {
    const { runDir, stateRoot, taskId } = await fixture();
    const lines: string[] = [];
    const code = await signalsCommand(
      await configFor(runDir, stateRoot),
      { out: (line) => lines.push(line), err: () => undefined },
      { taskId, attempt: 1, json: true },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { attempt: number; signals: Array<{ data: { reason: string } }> };
    expect(parsed.attempt).toBe(1);
    expect(parsed.signals[0]?.data.reason).toBe("attempt-1");
  });

  test("任务不存在返回非 0 并给出目录", async () => {
    const { runDir, stateRoot } = await fixture();
    const errors: string[] = [];
    const code = await signalsCommand(await configFor(runDir, stateRoot), { out: () => undefined, err: (line) => errors.push(line) }, { taskId: "missing", json: false });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("没有该任务的信号目录");
  });
});
