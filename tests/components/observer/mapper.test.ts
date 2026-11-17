import { describe, expect, test } from "bun:test";
import { AcpObservationMapper } from "../../../src/components/observer/mapper.ts";

describe("ACP 观测映射", () => {
  test("message/thought 生成 preview 与 rich", () => {
    const mapper = new AcpObservationMapper();
    const result = mapper.handle("s1", "session/update", {
      update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hello" } },
    });
    expect(result.preview).toMatchObject({ kind: "acp", event: "agent_message_chunk" });
    expect(result.preview?.message).toContain("hello");
    expect(result.rich).toMatchObject({ kind: "message", messageId: "m1", text: "hello" });
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
