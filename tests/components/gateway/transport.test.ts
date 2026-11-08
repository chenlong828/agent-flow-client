import { describe, expect, test } from "bun:test";
import { GatewayError, mapHttpError, transportError } from "../../../src/components/gateway/errors.ts";
import { HttpTransport, sameHost } from "../../../src/components/gateway/transport.ts";
import { withRetry } from "../../../src/components/gateway/retry.ts";
import { StubScheduler } from "../../support/stub-scheduler.ts";

function transportFor(stub: StubScheduler, token = "test-token", fetchImpl?: typeof fetch): HttpTransport {
  return new HttpTransport({
    baseUrl: stub.url,
    clientId: "client-1",
    runId: "run-1",
    token,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

describe("HTTP 传输", () => {
  test("公共头：Bearer、X-Client-Run-Id、X-Request-Id、JSON", async () => {
    const stub = new StubScheduler({ token: "test-token" });
    const transport = transportFor(stub);
    await transport.post("/register", { clientId: "client-1" }, { timeoutMs: 5000 });
    const request = stub.requests[0];
    expect(request?.headers.authorization).toBe("Bearer test-token");
    expect(request?.headers["x-client-run-id"]).toBe("run-1");
    expect(request?.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.headers["content-type"]).toContain("application/json");
    await stub.close();
  });

  test("401/403 → unauthorized；426 → version_incompatible；409 → run_superseded", async () => {
    const stub = new StubScheduler({ token: "test-token" });
    const transport = transportFor(stub, "wrong-token");
    const unauthorized = await transport.post("/register", {}, { timeoutMs: 5000 }).catch((error: unknown) => error);
    expect(unauthorized).toBeInstanceOf(GatewayError);
    expect((unauthorized as GatewayError).code).toBe("unauthorized");
    expect((unauthorized as GatewayError).retryable).toBe(false);

    const version = mapHttpError(426, { error: { code: "version_incompatible" } }, new Headers());
    expect(version.code).toBe("version_incompatible");
    expect(version.terminalAuthFailure).toBe(true);
    const superseded = mapHttpError(409, { error: { code: "run_superseded" } }, new Headers());
    expect(superseded.code).toBe("run_superseded");
    const expired = mapHttpError(409, { error: { code: "lease_expired" } }, new Headers());
    expect(expired.code).toBe("lease_expired");
    expect(expired.retryable).toBe(false);
    await stub.close();
  });

  test("429 带 Retry-After；500 → unreachable 可重试", async () => {
    const stub = new StubScheduler({ token: "test-token" });
    stub.failNext("POST /api/v1/executor/register", { status: 429, code: "rate_limited", times: 1 });
    const transport = transportFor(stub);
    const limited = await transport.post("/register", {}, { timeoutMs: 5000 }).catch((error: unknown) => error);
    expect((limited as GatewayError).code).toBe("rate_limited");
    expect((limited as GatewayError).retryAfterMs).toBe(2000);

    stub.failNext("POST /api/v1/executor/register", { status: 500, code: "internal", times: 1 });
    const failure = await transport.post("/register", {}, { timeoutMs: 5000 }).catch((error: unknown) => error);
    expect((failure as GatewayError).code).toBe("unreachable");
    expect((failure as GatewayError).retryable).toBe(true);
    await stub.close();
  });

  test("超时归一为 timeout", async () => {
    const stub = new StubScheduler({ token: "test-token", heartbeatHoldMs: 200 });
    const transport = transportFor(stub);
    const started = Date.now();
    const error = await transport.post("/heartbeat", { state: {} }, { timeoutMs: 20 }).catch((caught: unknown) => caught);
    expect((error as GatewayError).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    await stub.close();
  });

  test("连接失败归一为 unreachable", async () => {
    const transport = new HttpTransport({ baseUrl: "http://127.0.0.1:1", clientId: "c", runId: "r", token: null });
    const error = await transport.post("/register", {}, { timeoutMs: 500 }).catch((caught: unknown) => caught);
    expect((error as GatewayError).code).toBe("unreachable");
  });

  test("sameHost 只在同 host 带 token", () => {
    expect(sameHost("https://a.example.com/x", "https://a.example.com")).toBe(true);
    expect(sameHost("https://b.example.com/x", "https://a.example.com")).toBe(false);
    const transport = new HttpTransport({ baseUrl: "https://a.example.com", clientId: "c", runId: "r", token: "t" });
    expect(transport.headersFor("https://a.example.com/api").Authorization).toBe("Bearer t");
    expect(transport.headersFor("https://b.example.com/api").Authorization).toBeUndefined();
  });

  test("withRetry 重试 5xx 后成功；4xx 不重试", async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new GatewayError("unreachable", "boom");
        return "ok";
      },
      { baseMs: 1, sleep: async () => undefined },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(3);

    let authAttempts = 0;
    await expect(
      withRetry(
        async () => {
          authAttempts += 1;
          throw new GatewayError("unauthorized", "no");
        },
        { baseMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(authAttempts).toBe(1);
  });

  test("transportError 保留 GatewayError，AbortError 归 timeout", () => {
    const original = new GatewayError("stale_attempt", "x");
    expect(transportError(original)).toBe(original);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(transportError(abort).code).toBe("timeout");
  });
});
