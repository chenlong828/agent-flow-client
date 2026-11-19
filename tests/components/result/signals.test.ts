import { describe, expect, test } from "bun:test";
import { assemble, classify } from "../../../src/components/result/result.ts";
import type { SessionOutcome } from "../../../src/components/executor/ports.ts";
import type { TaskSignal } from "../../../src/components/signal/contract.ts";

const outcome = (overrides: Partial<SessionOutcome> = {}): SessionOutcome => ({
  sessionId: "s-1",
  finalText: "OK",
  stopReason: "end_turn",
  usage: null,
  ...overrides,
});

const signal = (seq: number, reason = "ok"): TaskSignal => ({
  seq,
  at: "2026-11-18T00:00:00.000Z",
  kind: "review_verdict",
  data: { verdict: "pass", reason },
});

const ctx = { taskId: "t", attempt: 1, maxResultBytes: 4096 };

describe("TaskResult.signals（A-04）", () => {
  test("succeeded 且采集到信号时写入", () => {
    const result = assemble(outcome(), { ...ctx, signals: [signal(1), signal(2, "second")] });
    expect(result.status).toBe("succeeded");
    expect(result.signals).toHaveLength(2);
    expect(result.signals?.[1]?.data.reason).toBe("second");
  });

  test("失败/超时/取消不带信号", () => {
    const failed = assemble(outcome({ error: { code: "prompt_failed", message: "x", class: "runtime" } }), {
      ...ctx,
      signals: [signal(1)],
    });
    expect(failed.signals).toBeUndefined();
    const timeout = assemble(outcome({ error: { code: "timeout", message: "x", class: "timeout" } }), {
      ...ctx,
      signals: [signal(1)],
    });
    expect(timeout.signals).toBeUndefined();
  });

  test("只保留最后 8 条", () => {
    const result = assemble(outcome(), { ...ctx, signals: Array.from({ length: 12 }, (_, index) => signal(index + 1)) });
    expect(result.signals).toHaveLength(8);
    expect(result.signals?.[0]?.seq).toBe(5);
  });

  test("整段超过 16 KiB 时丢弃，不截断 reason", () => {
    const big = [signal(1, "中".repeat(3000)), signal(2, "中".repeat(3000)), signal(3, "中".repeat(3000))];
    const result = assemble(outcome(), { ...ctx, signals: big });
    expect(result.signals).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  test("message 与 signals 共享 maxResultBytes 预算", () => {
    const withSignals = assemble(outcome({ finalText: "x".repeat(4096) }), { ...ctx, signals: [signal(1)] });
    const signalsBytes = Buffer.byteLength(JSON.stringify(withSignals.signals), "utf8");
    expect(withSignals.truncated).toBe(true);
    expect(signalsBytes + Buffer.byteLength(withSignals.message, "utf8")).toBeLessThanOrEqual(4096);
  });

  test("无信号时 message 预算不变（兼容旧行为）", () => {
    const plain = assemble(outcome({ finalText: "y".repeat(5000) }), ctx);
    expect(plain.truncated).toBe(true);
    expect(Buffer.byteLength(plain.message, "utf8")).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(plain.message, "utf8")).toBeGreaterThan(4070);
  });

  test("signal 错误码映射到 protocol", () => {
    expect(classify({ code: "signal_prepare_failed", message: "" }).class).toBe("protocol");
    expect(classify({ code: "signal_mount_failed", message: "" }).class).toBe("protocol");
  });
});
