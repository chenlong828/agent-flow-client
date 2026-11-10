import { describe, expect, test } from "bun:test";
import { assemble, classify, mapStopReason, truncate } from "../../../src/components/result/result.ts";
import type { SessionOutcome } from "../../../src/components/executor/ports.ts";

const outcome = (overrides: Partial<SessionOutcome> = {}): SessionOutcome => ({
  sessionId: "s-1",
  finalText: "OK",
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 2 },
  ...overrides,
});

describe("错误分类", () => {
  test("映射表覆盖资产/运行时/调度器/超时", () => {
    expect(classify({ code: "download_failed", message: "" })).toEqual({ class: "asset", code: "download_failed" });
    expect(classify({ code: "prompt_failed", message: "" })).toEqual({ class: "runtime", code: "prompt_failed" });
    expect(classify({ code: "task_not_found", message: "" })).toEqual({ class: "scheduler", code: "task_not_found" });
    expect(classify({ code: "idle_timeout", message: "" })).toEqual({ class: "timeout", code: "idle_timeout" });
    expect(classify({ code: "weird", message: "" })).toEqual({ class: "internal", code: "weird" });
  });
});

describe("UTF-8 截断", () => {
  test("刚好等于上限不截断", () => {
    expect(truncate("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  test("超上限按码点截断，含标记不超限", () => {
    const result = truncate("a".repeat(30), 20);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(20);
    expect(result.text.endsWith("…[truncated]")).toBe(true);
  });

  test("上限小于标记字节返回空串", () => {
    expect(truncate("abcdefghijk", 10)).toEqual({ text: "", truncated: true });
  });
});

describe("TaskResult 组装", () => {
  test("成功：taskId/attempt/status/usage", () => {
    const result = assemble(outcome(), { taskId: "t-1", attempt: 2, maxResultBytes: 1024 });
    expect(result).toMatchObject({
      taskId: "t-1",
      attempt: 2,
      status: "succeeded",
      sessionId: "s-1",
      message: "OK",
      truncated: false,
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
      error: null,
    });
    expect("retryable" in (result.error ?? {})).toBe(false);
  });

  test("失败/取消/超时", () => {
    const failed = assemble(outcome({ finalText: "partial", error: { code: "prompt_failed", message: "boom", class: "runtime" } }), {
      taskId: "t-1",
      attempt: 1,
      maxResultBytes: 1024,
    });
    expect(failed.status).toBe("failed");
    expect(failed.stopReason).toBeNull();
    expect(failed.message).toBe("partial");
    expect(failed.error).toEqual({ class: "runtime", code: "prompt_failed", message: "boom" });

    const cancelled = assemble(outcome({ finalText: "", error: { code: "cancelled", message: "c", class: "cancelled" } }), { taskId: "t", attempt: 1, maxResultBytes: 1024 });
    expect(cancelled.status).toBe("cancelled");
    const timeout = assemble(outcome({ finalText: "", error: { code: "idle_timeout", message: "i", class: "timeout" } }), { taskId: "t", attempt: 1, maxResultBytes: 1024 });
    expect(timeout.status).toBe("timeout");
    expect(timeout.error?.class).toBe("timeout");
  });

  test("未知 stopReason 原样保留", () => {
    expect(mapStopReason("weird")).toEqual({ value: "weird", unknown: true });
  });
});
