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
  test("映射表覆盖可重试与不可重试", () => {
    expect(classify({ code: "download_failed", message: "" })).toEqual({ class: "asset", code: "download_failed", retryable: true });
    expect(classify({ code: "invalid_skill_format", message: "" })).toEqual({
      class: "asset",
      code: "invalid_skill_format",
      retryable: false,
    });
    expect(classify({ code: "locked", message: "" })).toEqual({ class: "workspace", code: "locked", retryable: false });
    expect(classify({ code: "process_exited", message: "" })).toEqual({ class: "runtime", code: "process_exited", retryable: true });
    expect(classify({ code: "protocol_error", message: "" })).toEqual({ class: "protocol", code: "protocol_error", retryable: false });
  });

  test("未知错误归 internal 且不抛", () => {
    expect(classify({ code: "weird", message: "" })).toEqual({ class: "internal", code: "weird", retryable: false });
  });
});

describe("UTF-8 截断", () => {
  test("刚好等于上限不截断", () => {
    expect(truncate("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  test("超上限按码点截断并带标记，字节数不超限", () => {
    const result = truncate("a".repeat(30), 20);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(20);
    expect(result.text.endsWith("…[truncated]")).toBe(true);
  });

  test("上限小于标记字节时返回空串并标记", () => {
    expect(truncate("abcdefghijk", 10)).toEqual({ text: "", truncated: true });
  });

  test("不切断多字节码点", () => {
    const result = truncate(`${"a".repeat(20)}😀b`, 20);
    expect(result.truncated).toBe(true);
    expect([...result.text].every((char) => char !== "�")).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(20);
  });
});

describe("结果组装", () => {
  test("成功：status/stopReason/usage/sessionId", () => {
    const result = assemble(outcome(), { attemptId: "a-1", maxResultBytes: 1024 });
    expect(result).toMatchObject({
      attemptId: "a-1",
      status: "succeeded",
      sessionId: "s-1",
      message: "OK",
      truncated: false,
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
      error: null,
    });
  });

  test("失败：error 映射，stopReason 为 null，保留已有输出", () => {
    const result = assemble(
      outcome({ finalText: "partial", error: { code: "prompt_failed", message: "boom", class: "runtime" } }),
      { attemptId: "a-1", maxResultBytes: 1024 },
    );
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBeNull();
    expect(result.message).toBe("partial");
    expect(result.error).toEqual({ class: "runtime", code: "prompt_failed", message: "boom", retryable: true });
  });

  test("取消与超时状态", () => {
    const cancelled = assemble(
      outcome({ finalText: "", error: { code: "cancelled", message: "c", class: "cancelled" } }),
      { attemptId: "a-1", maxResultBytes: 1024 },
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error?.class).toBe("cancelled");
    const timeout = assemble(
      outcome({ finalText: "", error: { code: "timeout", message: "t", class: "timeout" } }),
      { attemptId: "a-1", maxResultBytes: 1024 },
    );
    expect(timeout.status).toBe("timeout");
    expect(timeout.error?.retryable).toBe(true);
  });

  test("未知 stopReason 原样保留", () => {
    expect(mapStopReason("weird")).toEqual({ value: "weird", unknown: true });
  });
});
