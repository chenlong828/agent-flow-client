import { describe, expect, test } from "bun:test";
import { parsePollResponse } from "../../../src/components/gateway/wire.ts";
import { assertInputDownloadPath, parseRunInputs } from "../../../src/components/gateway/run-input-wire.ts";
import { reviewConfirmationContract, reviewVerdictContract } from "../../support/signal-contract.ts";

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

  test("review 任务同时带 resultSignal 与 confirmation：两个契约都解析进 TaskRequest", () => {
    const response = parsePollResponse(
      pollBody({ ...baseTask, resultSignal: reviewVerdictContract, confirmation: reviewConfirmationContract }),
    );
    expect(response.tasks[0]?.resultSignal?.kind).toBe("review_verdict");
    expect(response.tasks[0]?.confirmation).toMatchObject({ version: 1, kind: "confirmation_request", required: false });
    expect(response.tasks[0]?.confirmation?.schema.required).toEqual(["question"]);
  });

  test("没有 confirmation 时字段缺省（旧 orchestrator 兼容）", () => {
    const response = parsePollResponse(pollBody({ ...baseTask, resultSignal: reviewVerdictContract }));
    expect(response.tasks[0]?.confirmation).toBeUndefined();
  });

  test("空的 confirmation 对象视为不存在，不报协议错", () => {
    const response = parsePollResponse(pollBody({ ...baseTask, confirmation: {} }));
    expect(response.tasks[0]?.confirmation).toBeUndefined();
  });
});

describe("EXE-06 初始资料解析", () => {
  const runId = "run-1";
  const sha = "a".repeat(64);
  const item = (overrides: Record<string, unknown> = {}) => ({
    inputId: "in-1",
    name: "01-界面截图.png",
    mediaType: "image/png",
    sizeBytes: 3,
    sha256: sha,
    downloadPath: `/runs/${runId}/inputs/in-1`,
    ...overrides,
  });

  test("合法列表逐字段透传", () => {
    const refs = parseRunInputs({ items: [item()] }, runId);
    expect(refs).toEqual([
      {
        inputId: "in-1",
        name: "01-界面截图.png",
        mediaType: "image/png",
        sizeBytes: 3,
        sha256: sha,
        downloadPath: `/runs/${runId}/inputs/in-1`,
      },
    ]);
  });

  test("空列表合法", () => {
    expect(parseRunInputs({ items: [] }, runId)).toEqual([]);
  });

  test("downloadPath 指向别的 run 或别的 input：protocol_error", () => {
    expect(() => parseRunInputs({ items: [item({ downloadPath: "/runs/other/inputs/in-1" })] }, runId)).toThrow(
      /不匹配/,
    );
    expect(() => parseRunInputs({ items: [item({ downloadPath: `/runs/${runId}/inputs/in-9` })] }, runId)).toThrow(
      /不匹配/,
    );
  });

  test("非法类型、摘要、大小：protocol_error", () => {
    expect(() => parseRunInputs({ items: [item({ mediaType: "application/pdf" })] }, runId)).toThrow(
      /类型不受支持/,
    );
    expect(() => parseRunInputs({ items: [item({ sha256: "ABC" })] }, runId)).toThrow(/摘要非法/);
    expect(() => parseRunInputs({ items: [item({ sizeBytes: 0 })] }, runId)).toThrow(/大小非法/);
    expect(() => parseRunInputs({ items: [item({ sizeBytes: 1.5 })] }, runId)).toThrow(/大小非法/);
  });

  test("下载路径拒绝穿越、绝对 URL 与多余路径段", () => {
    expect(() => assertInputDownloadPath("/runs/r/inputs/../../etc/passwd")).toThrow(/下载路径非法/);
    expect(() => assertInputDownloadPath("http://evil.example/runs/r/inputs/i")).toThrow(/下载路径非法/);
    expect(() => assertInputDownloadPath("/runs/r/inputs/i/extra")).toThrow(/下载路径非法/);
    expect(() => assertInputDownloadPath("/skill-packages/p")).toThrow(/下载路径非法/);
    expect(() => assertInputDownloadPath("/runs/r/inputs/i", { runId: "r", inputId: "i" })).not.toThrow();
    expect(() => assertInputDownloadPath("/runs/r/inputs/i", { inputId: "x" })).toThrow(/不匹配/);
  });
});
