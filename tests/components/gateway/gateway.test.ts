import { describe, expect, test } from "bun:test";
import { HttpScheduler } from "../../../src/components/gateway/gateway.ts";
import { HttpTransport } from "../../../src/components/gateway/transport.ts";
import { GatewayError } from "../../../src/components/gateway/errors.ts";
import { StubScheduler } from "../../support/stub-scheduler.ts";
import type { PollRequest, TaskRequest, TaskResult } from "../../../src/components/executor/types.ts";

function task(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    taskId: "task-1",
    instanceId: "instance-1",
    nodeId: "node-1",
    attempt: 1,
    prompt: "HELLO",
    workspacePath: "/tmp/v2/ws",
    taskSpacePath: "/tmp/v2/ws/.agent-flow/task/task-1",
    timeoutMs: 30000,
    skillSet: { digest: "sha256:d", packages: [] },
    ...overrides,
  };
}

const result: TaskResult = {
  taskId: "task-1",
  attempt: 1,
  status: "succeeded",
  message: "OK",
  truncated: false,
  stopReason: "end_turn",
  usage: null,
  error: null,
};

const emptyPoll: PollRequest = { capacity: { free: 1 }, running: [], finished: [] };

function setup() {
  const stub = new StubScheduler({ token: "t" });
  const transport = new HttpTransport({ baseUrl: stub.url, token: "t" });
  const audits: string[] = [];
  const gateway = new HttpScheduler({
    transport,
    audit: (event) => audits.push(event),
    retry: { baseMs: 1, sleep: async () => undefined },
  });
  return { stub, gateway, audits };
}

describe("poll", () => {
  test("请求带上 free/running/finished", async () => {
    const { stub, gateway } = setup();
    await gateway.poll({
      capacity: { free: 2 },
      running: [{ taskId: "t-run", instanceId: "i-1", startedAt: "2026-11-10T00:00:00Z" }],
      finished: [{ taskId: "t-fin", attempt: 1, finishedAt: "2026-11-10T00:01:00Z" }],
    });
    const body = stub.requests[0]?.body;
    expect(stub.requests[0]?.headers["x-executor-capabilities"]).toBe("run-inputs");
    expect(body?.capacity).toEqual({ free: 2 });
    expect((body?.running as unknown[])[0]).toMatchObject({ taskId: "t-run", instanceId: "i-1" });
    expect((body?.finished as unknown[])[0]).toEqual({ taskId: "t-fin", attempt: 1, finishedAt: "2026-11-10T00:01:00Z" });
    await stub.close();
  });

  test("解析任务、stop、cancelInstances、nextPollAfterMs", async () => {
    const { stub, gateway } = setup();
    stub.enqueueTask(task());
    stub.setStop(true);
    stub.cancelInstance("instance-9");
    const response = await gateway.poll(emptyPoll);
    expect(response.tasks).toHaveLength(1);
    expect(response.tasks[0]).toMatchObject({ taskId: "task-1", attempt: 1, workspacePath: "/tmp/v2/ws" });
    expect(response.stop).toBe(true);
    expect(response.cancelInstances).toEqual(["instance-9"]);
    expect(response.nextPollAfterMs).toBe(10);
    await stub.close();
  });
});

describe("result", () => {
  test("首份 accepted=true，重复 accepted=false", async () => {
    const { stub, gateway } = setup();
    // v3 前置：先上传该 attempt 的会话日志（0 行也算）。
    await gateway.uploadSessionLog({ taskId: "task-1", attempt: 1, payload: new Uint8Array([31, 139]) });
    expect((await gateway.reportResult(result)).accepted).toBe(true);
    expect((await gateway.reportResult(result)).accepted).toBe(false);
    await stub.close();
  });

  test("404 task_not_found 返回 accepted=false 并审计", async () => {
    const { stub, gateway, audits } = setup();
    stub.failNext("POST /api/v1/executor/tasks/task-1/result", { status: 404, code: "task_not_found", times: 1 });
    const ack = await gateway.reportResult(result);
    expect(ack.accepted).toBe(false);
    expect(audits).toContain("result.task_not_found");
    await stub.close();
  });
});

describe("session log / archive", () => {
  test("uploadSessionLog：gzip 头、stored、重传覆盖", async () => {
    const { stub, gateway } = setup();
    const first = await gateway.uploadSessionLog({ taskId: "task-1", attempt: 1, payload: new Uint8Array([1, 2, 3]) });
    expect(first.stored).toBe("created");
    const again = await gateway.uploadSessionLog({ taskId: "task-1", attempt: 1, payload: new Uint8Array([4, 5]) });
    expect(again.stored).toBe("replaced");
    const sent = stub.requests.find((request) => request.path.includes("/session-log"));
    expect(sent?.headers["content-type"]).toBe("application/x-ndjson");
    expect(sent?.headers["content-encoding"]).toBe("gzip");
    await stub.close();
  });

  test("uploadArchive：后到覆盖；超过上限映射 payload_too_large", async () => {
    const { stub, gateway } = setup();
    stub.setArchiveLimit(4);
    const ok = await gateway.uploadArchive({ runId: "run-1", payload: new Uint8Array([1, 2]) });
    expect(ok.stored).toBe("created");
    await expect(gateway.uploadArchive({ runId: "run-1", payload: new Uint8Array([1, 2, 3, 4, 5]) })).rejects.toMatchObject({
      code: "payload_too_large",
    });
    await stub.close();
  });

  test("poll：发送 archivedRuns、解析 archiveRequests", async () => {
    const { stub, gateway } = setup();
    stub.requestArchive({ runId: "run-1", instanceId: "instance-1", workspacePath: "/tmp/v2/ws", taskSpacePath: "/tmp/v2/ws/.agent-flow/task/run-1" });
    const response = await gateway.poll({ ...emptyPoll, archivedRuns: ["run-old"] });
    expect(response.archiveRequests).toEqual([
      { runId: "run-1", instanceId: "instance-1", workspacePath: "/tmp/v2/ws", taskSpacePath: "/tmp/v2/ws/.agent-flow/task/run-1" },
    ]);
    const poll = stub.requests.find((request) => request.path.endsWith("/poll"));
    expect(poll?.body.archivedRuns).toEqual(["run-old"]);
    await stub.close();
  });
});

describe("skill package", () => {
  test("下载返回 bytes/sha256；304 返回 notModified", async () => {
    const { stub, gateway } = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    stub.setPackage(bytes, '"v1"', sha256);
    const pkg = { packageId: "p-1", name: "a", version: "1", digest: "sha256:x", sizeBytes: 3, downloadUrl: "/api/v1/executor/skill-packages/p-1" };
    const downloaded = await gateway.downloadPackage(pkg);
    expect(downloaded.bytes).toEqual(bytes);
    expect(downloaded.sha256).toBe(sha256);
    const cached = await gateway.downloadPackage({ ...pkg, etag: '"v1"' });
    expect(cached.notModified).toBe(true);
    await stub.close();
  });

  test("404 → package_not_found", async () => {
    const { stub, gateway } = setup();
    const error = await gateway.downloadPackage({ packageId: "missing", name: "a", version: "1", digest: "sha256:x", sizeBytes: 0, downloadUrl: "/x" }).catch((caught: unknown) => caught);
    expect((error as GatewayError).code).toBe("package_not_found");
    await stub.close();
  });
});


describe("EXE-06/07 初始资料", () => {
  const runId = "run-1";
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  test("列表：返回服务端顺序与元数据", async () => {
    const { stub, gateway } = setup();
    stub.setRunInputs(runId, [{ inputId: "in-1", name: "01-界面截图.png", bytes: png }]);
    const refs = await gateway.listRunInputs(runId);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ inputId: "in-1", name: "01-界面截图.png", mediaType: "image/png", sizeBytes: png.byteLength });
    expect(refs[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await stub.close();
  });

  test("旧服务端 404（无该端点）：按无初始资料继续，并记审计", async () => {
    const { stub, gateway, audits } = setup();
    stub.failNext("GET /api/v1/executor/runs/run-old/inputs", { status: 404, code: "not_found" });
    expect(await gateway.listRunInputs("run-old")).toEqual([]);
    expect(audits).toContain("run_inputs.unavailable");
    await stub.close();
  });

  test("run 不存在：不当作兼容路径，原样失败", async () => {
    const { stub, gateway } = setup();
    await expect(gateway.listRunInputs("run-missing")).rejects.toMatchObject({ code: "run_not_found" });
    await stub.close();
  });

  test("下载：返回原始字节", async () => {
    const { stub, gateway } = setup();
    stub.setRunInputs(runId, [{ inputId: "in-1", name: "a.png", bytes: png }]);
    const ref = stub.runInputsOf(runId)[0]!;
    expect(await gateway.downloadRunInput(ref)).toEqual(png);
    await stub.close();
  });

  test("下载路径与 inputId 不匹配：protocol_error，不发请求", async () => {
    const { stub, gateway } = setup();
    const ref = {
      inputId: "in-1",
      name: "a.png",
      mediaType: "image/png" as const,
      sizeBytes: png.byteLength,
      sha256: "a".repeat(64),
      downloadPath: "/runs/run-1/inputs/in-9",
    };
    await expect(gateway.downloadRunInput(ref)).rejects.toMatchObject({ code: "protocol_error" });
    expect(stub.requests).toHaveLength(0);
    await stub.close();
  });

  test("下载 5xx 重试后成功；401 不重试", async () => {
    const { stub, gateway } = setup();
    stub.setRunInputs(runId, [{ inputId: "in-1", name: "a.png", bytes: png }]);
    const ref = stub.runInputsOf(runId)[0]!;
    stub.failNext("GET /api/v1/executor/runs/run-1/inputs/in-1", { status: 503, code: "service_unavailable" });
    expect(await gateway.downloadRunInput(ref)).toEqual(png);
    expect(stub.requests.filter((request) => request.path.endsWith("/inputs/in-1"))).toHaveLength(2);

    stub.failNext("GET /api/v1/executor/runs/run-1/inputs/in-1", { status: 401, code: "unauthorized" });
    await expect(gateway.downloadRunInput(ref)).rejects.toMatchObject({ code: "unauthorized" });
    await stub.close();
  });
});
