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
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
        version: 1,
        kind: "review_verdict",
        taskId,
        attempt,
        output: join(dir, "signals.jsonl"),
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "reason"],
          properties: { verdict: { type: "string", enum: ["pass", "fail"] }, reason: { type: "string" } },
        },
        limits: { maxSignals: 8, maxBytes: 16384 },
      }),
    );
    await writeFile(
      join(dir, "signals.jsonl"),
      `${JSON.stringify({ seq: 1, at: "2026-11-18T00:00:00.000Z", kind: "review_verdict", data: { verdict: "pass", reason: `attempt-${attempt}` } })}\n`,
    );
  }
  return { runDir, stateRoot, taskId };
}

async function configFor(runDir: string, stateRoot: string) {
  return await loadConfig({ runDir, env: {}, flags: { stateRoot } });
}

describe("signals 命令", () => {
  test("默认取最新 attempt；文本输出带 kind 与计数", async () => {
    const { runDir, stateRoot, taskId } = await fixture();
    const lines: string[] = [];
    const code = await signalsCommand(await configFor(runDir, stateRoot), { out: (line) => lines.push(line), err: () => undefined }, { taskId, json: false });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("attempt 2");
    expect(text).toContain("kind review_verdict");
    expect(text).toContain("signals 1 条合法，0 行被忽略");
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
