import { describe, expect, test } from "bun:test";
import { HttpScheduler } from "../../../src/components/gateway/gateway.ts";
import { HttpTransport } from "../../../src/components/gateway/transport.ts";
import { GatewayError } from "../../../src/components/gateway/errors.ts";
import { StubScheduler } from "../../support/stub-scheduler.ts";
import type { ClientInfo, ClientState } from "../../../src/components/executor/scheduler-port.ts";
import type { NodeRequest, NodeResult } from "../../../src/components/executor/types.ts";

const clientInfo: ClientInfo = {
  clientId: "client-1",
  version: "0.0.1",
  protocolVersion: "2026-11-07.1",
  capacity: { maxInstances: 4, activeInstances: 0, activeAttempts: 0 },
};

const state: ClientState = {
  capacity: { maxInstances: 4, activeInstances: 0, activeAttempts: 0 },
  pausedInstances: [],
  activeAttempts: [],
  assignmentsVersion: 1,
};

function nodeRequest(overrides: Partial<NodeRequest> = {}): NodeRequest {
  return {
    attemptId: "01930000-0000-7000-8000-000000000301",
    attemptNo: 1,
    instanceId: "01930000-0000-7000-8000-000000000302",
    nodeId: "01930000-0000-7000-8000-000000000303",
    workspacePath: "/tmp/afc-s1/ws",
    prompt: "HELLO",
    timeoutMs: 30000,
    claimedAt: "2026-11-08T00:00:00.000Z",
    lease: { expiresAt: "2026-11-08T00:02:00.000Z", ttlMs: 120000 },
    ...overrides,
  };
}

const result: NodeResult = {
  attemptId: "01930000-0000-7000-8000-000000000301",
  status: "succeeded",
  message: "OK",
  truncated: false,
  stopReason: "end_turn",
  usage: null,
  error: null,
};

function setup(stubOptions: ConstructorParameters<typeof StubScheduler>[0] = {}) {
  const stub = new StubScheduler({ token: "test-token", ...stubOptions });
  const transport = new HttpTransport({ baseUrl: stub.url, clientId: "client-1", runId: "run-1", token: "test-token" });
  const audits: string[] = [];
  const gateway = new HttpScheduler("client-1", "run-1", {
    transport,
    clientVersion: "0.0.1",
    audit: (event) => audits.push(event),
  });
  return { stub, gateway, audits };
}

describe("注册与版本", () => {
  test("解析 limits/cleanupPending/assignments 并保存", async () => {
    const { stub, gateway } = setup();
    stub.setCleanupPending([
      { releaseId: "r-1", instanceId: "i-1", cleanup: "clean-skills", releasedAt: "2026-11-08T00:00:00Z" },
    ]);
    const outcome = await gateway.register(clientInfo);
    expect(outcome.limits.maxResultBytes).toBe(262144);
    expect(outcome.cleanupPending).toHaveLength(1);
    expect(gateway.limits.maxSkillPackages).toBe(64);
    expect(gateway.heartbeatConfig.clientTimeoutMs).toBe(35000);
    await stub.close();
  });

  test("deprecated 只审计；incompatible 抛 version_incompatible", async () => {
    const deprecated = setup();
    deprecated.stub.setCompatibility("deprecated");
    await deprecated.gateway.register(clientInfo);
    expect(deprecated.audits).toContain("version.deprecated");
    await deprecated.stub.close();

    const incompatible = setup();
    incompatible.stub.setCompatibility("incompatible");
    const error = await incompatible.gateway.register(clientInfo).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("version_incompatible");
    await incompatible.stub.close();
  });
});

describe("心跳与控制", () => {
  test("返回事件并推进 ackSeq；下一跳带已处理序号", async () => {
    const { stub, gateway } = setup({ heartbeatHoldMs: 5 });
    await gateway.register(clientInfo);
    stub.enqueueEvent({ type: "cancel", instanceId: "i-1", reason: "user_cancel", issuedAt: "2026-11-08T00:00:00Z" });
    const outcome = await gateway.heartbeat(state);
    expect(outcome.control.events).toHaveLength(1);
    expect(outcome.control.seq).toBe(1);

    await gateway.heartbeat(state);
    const second = stub.requests.filter((request) => request.path === "/api/v1/executor/heartbeat")[1];
    expect(second?.body.ackSeq).toBe(1);
    await stub.close();
  });

  test("控制 seq 去重：重复批不再应用", async () => {
    const { ControlSeq } = await import("../../../src/components/gateway/state.ts");
    const seq = new ControlSeq();
    const event = { type: "cancel" as const, instanceId: "i-1", reason: "user_cancel" as const, issuedAt: "2026-11-08T00:00:00Z" };
    expect(seq.accept(1, [event])).toEqual([event]);
    expect(seq.accept(1, [event])).toEqual([]);
    expect(seq.ackSeq).toBe(1);
    expect(seq.accept(0, [])).toEqual([]);
  });

  test("心跳失败时 cleanupAcks 重发", async () => {
    const { stub, gateway } = setup({ heartbeatHoldMs: 5 });
    await gateway.register(clientInfo);
    stub.failNext("POST /api/v1/executor/heartbeat", { status: 500, code: "internal", times: 1 });
    const ack = { releaseId: "r-1", status: "done" as const, completedAt: "2026-11-08T00:00:00Z" };
    await gateway.heartbeat(state, [ack]).catch(() => undefined);
    await gateway.heartbeat(state);
    const last = stub.requests.filter((request) => request.path === "/api/v1/executor/heartbeat").at(-1);
    expect(last?.body.cleanupAcks).toEqual([ack]);
    await stub.close();
  });
});

describe("领取与绑定", () => {
  test("claim 重试复用 claimRequestId，成功后换新", async () => {
    const { stub, gateway } = setup();
    await gateway.register(clientInfo);
    stub.failNext("POST /api/v1/executor/claim", { status: 500, code: "internal", times: 1 });
    stub.enqueueRequest(nodeRequest());
    const first = await gateway.claim(state.capacity);
    expect(first?.attemptId).toBe("01930000-0000-7000-8000-000000000301");
    const claimRequests = stub.requests.filter((request) => request.path === "/api/v1/executor/claim");
    expect(claimRequests).toHaveLength(2);
    expect(claimRequests[0]?.body.claimRequestId).toBe(claimRequests[1]?.body.claimRequestId);

    stub.enqueueRequest(nodeRequest({ attemptId: "01930000-0000-7000-8000-000000000304" }));
    await gateway.claim(state.capacity);
    const third = stub.requests.filter((request) => request.path === "/api/v1/executor/claim").at(-1);
    expect(third?.body.claimRequestId).not.toBe(claimRequests[0]?.body.claimRequestId);
    await stub.close();
  });

  test("204 返回 null 并换新 requestId", async () => {
    const { stub, gateway } = setup({ claimHoldMs: 1 });
    await gateway.register(clientInfo);
    expect(await gateway.claim(state.capacity)).toBeNull();
    stub.enqueueRequest(nodeRequest());
    await gateway.claim(state.capacity);
    const requests = stub.requests.filter((request) => request.path === "/api/v1/executor/claim");
    expect(requests[1]?.body.claimRequestId).not.toBe(requests[0]?.body.claimRequestId);
    await stub.close();
  });

  test("bindSession 发送 claim 的 workspacePath 并返回技能集", async () => {
    const { stub, gateway } = setup();
    await gateway.register(clientInfo);
    stub.enqueueRequest(nodeRequest());
    const request = (await gateway.claim(state.capacity)) as NodeRequest;
    const skillSet = await gateway.bindSession(request.attemptId, "s-1");
    expect(skillSet.digest).toBe("sha256:stub");
    const bind = stub.requests.find((item) => item.path.endsWith("/session"));
    expect(bind?.body).toEqual({ sessionId: "s-1", cwd: "/tmp/afc-s1/ws" });
    await stub.close();
  });

  test("bindSession 返回 attemptId 不一致时报错", async () => {
    const { stub, gateway } = setup();
    await gateway.register(clientInfo);
    stub.enqueueRequest(nodeRequest());
    const request = (await gateway.claim(state.capacity)) as NodeRequest;
    stub.setBindAttemptId("other-attempt");
    await expect(gateway.bindSession(request.attemptId, "s-1")).rejects.toMatchObject({ code: "unreachable" });
    await stub.close();
  });
});

describe("续租与上报", () => {
  test("renew 返回并记录租约", async () => {
    const { stub, gateway } = setup();
    await gateway.register(clientInfo);
    const lease = await gateway.renew("attempt-1");
    expect(lease.ttlMs).toBe(120000);
    expect(gateway.leases.remainingMs("attempt-1")).not.toBeNull();
    await stub.close();
  });

  test("reportResult 首次 accepted，重复走本地幂等缓存", async () => {
    const { stub, gateway } = setup();
    await gateway.register(clientInfo);
    const first = await gateway.reportResult(result.attemptId, result);
    expect(first.disposition).toBe("accepted");
    const second = await gateway.reportResult(result.attemptId, result);
    expect(second.disposition).toBe("duplicate");
    expect(stub.requests.filter((request) => request.path.endsWith("/result"))).toHaveLength(1);
    await stub.close();
  });

  test("上报 5xx 退避重试后 accepted", async () => {
    const { stub, gateway } = setup();
    await gateway.register(clientInfo);
    stub.failNext(`POST /api/v1/executor/attempts/${result.attemptId}/result`, { status: 500, code: "internal", times: 1 });
    const ack = await gateway.reportResult(result.attemptId, result);
    expect(ack.disposition).toBe("accepted");
    await stub.close();
  });

  test("late_result 返回 closed 并审计，不抛错", async () => {
    const { stub, gateway, audits } = setup();
    await gateway.register(clientInfo);
    stub.setReportLate(true);
    const ack = await gateway.reportResult(result.attemptId, result);
    expect(ack).toMatchObject({ attemptState: "closed", disposition: "duplicate" });
    expect(audits).toContain("result.late");
    await stub.close();
  });
});
