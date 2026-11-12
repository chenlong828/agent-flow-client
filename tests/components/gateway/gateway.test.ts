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
  const gateway = new HttpScheduler({ transport, audit: (event) => audits.push(event) });
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
