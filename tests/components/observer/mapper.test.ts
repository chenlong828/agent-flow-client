import { describe, expect, test } from "bun:test";
import { AcpObservationMapper } from "../../../src/components/observer/mapper.ts";

describe("ACP 观测映射", () => {
  test("message/thought 生成 preview 与 rich", () => {
    const mapper = new AcpObservationMapper();
    const result = mapper.handle("s1", "session/update", {
      update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hello" } },
    });
    expect(result.preview).toMatchObject({ kind: "acp", event: "agent_message_chunk", message: "hello" });
    expect(result.preview?.data).toMatchObject({ acpType: "agent_message_chunk", bytes: 5 });
    expect(result.rich).toMatchObject({ kind: "message", messageId: "m1", text: "hello" });
  });

  test("thought preview 保留正文，超过 16 KiB 截断", () => {
    const mapper = new AcpObservationMapper();
    const text = "思考".repeat(100);
    const result = mapper.handle("s1", "session/update", {
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
    });
    expect(result.preview?.message).toBe(text);
    expect(result.preview?.data).toMatchObject({ acpType: "agent_thought_chunk", bytes: 600 });
    expect(result.rich).toMatchObject({ kind: "thought", text });

    const long = "字".repeat(6000);
    const clipped = mapper.handle("s1", "session/update", {
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: long } },
    });
    expect(clipped.preview?.message?.endsWith("…")).toBe(true);
    expect(clipped.preview?.data).toMatchObject({ acpType: "agent_thought_chunk", bytes: 18000, truncated: true, originalBytes: 18000 });
  });

  test("tool_call/tool_result 关联并计算耗时", () => {
    let now = 1000;
    const mapper = new AcpObservationMapper({ now: () => now });
    const start = mapper.handle("s1", "session/update", {
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", status: "in_progress", rawInput: { command: "echo hi" } },
    });
    expect(start.rich).toMatchObject({ kind: "tool_call", toolCallId: "t1", tool: { name: "bash" } });
    now = 1250;
    const end = mapper.handle("s1", "session/update", {
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] },
    });
    expect(end.rich).toMatchObject({ kind: "tool_result", toolCallId: "t1", tool: { name: "bash", status: "completed", output: "hi", durationMs: 250 } });
  });

  test("permission 关联 tool 名称", () => {
    const mapper = new AcpObservationMapper();
    mapper.handle("s1", "session/update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", rawInput: { command: "sleep 1" } } });
    const permission = mapper.permission("s1", { toolCall: { toolCallId: "t1" }, options: [{ kind: "allow_once", name: "Allow" }] }, "allow");
    expect(permission.rich).toMatchObject({ kind: "permission", toolCallId: "t1", permission: { tool: { name: "bash" }, decision: "allow" } });
  });

  test("未知 update 归 other，不丢", () => {
    const mapper = new AcpObservationMapper();
    const result = mapper.handle("s1", "session/update", { update: { sessionUpdate: "plan", entries: [] } });
    expect(result.rich).toMatchObject({ kind: "other", acpType: "plan" });
  });
});
