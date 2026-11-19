import { describe, expect, test } from "bun:test";
import { parsePollResponse } from "../../../src/components/gateway/wire.ts";
import { reviewVerdictContract } from "../../support/signal-contract.ts";

function pollBody(task: Record<string, unknown>) {
  return {
    tasks: [task],
    stop: false,
    cancelInstances: [],
    nextPollAfterMs: 0,
  };
}

const baseTask = {
  taskId: "t-1",
  instanceId: "i-1",
  nodeId: "n-1",
  attempt: 1,
  prompt: "HELLO",
  workspacePath: "/tmp/ws",
  taskSpacePath: "/tmp/ws/.agent-flow/task/t-1",
  timeoutMs: 1000,
  skillSet: { digest: "sha256:d", packages: [] },
};

describe("P-01 结果信号解析（C-13）", () => {
  test("resultSignal 透传为契约对象", () => {
    const response = parsePollResponse(pollBody({ ...baseTask, resultSignal: reviewVerdictContract }));
    expect(response.tasks[0]?.resultSignal).toMatchObject({
      version: 1,
      kind: "review_verdict",
      required: true,
    });
    expect(response.tasks[0]?.resultSignal?.schema.required).toEqual(["verdict", "reason"]);
  });

  test("无 resultSignal 时字段缺省（旧 orchestrator 兼容）", () => {
    const response = parsePollResponse(pollBody(baseTask));
    expect(response.tasks[0]?.resultSignal).toBeUndefined();
  });

  test("形状不合法的 resultSignal 被忽略而不是让整批任务失败", () => {
    const response = parsePollResponse(pollBody({ ...baseTask, resultSignal: { version: "1", kind: 2 } }));
    expect(response.tasks[0]?.resultSignal).toBeUndefined();
  });
});
