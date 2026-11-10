import { describe, expect, test } from "bun:test";
import { GatewayError, mapHttpError } from "../../../src/components/gateway/errors.ts";
import { HttpTransport } from "../../../src/components/gateway/transport.ts";
import { withRetry } from "../../../src/components/gateway/retry.ts";
import { StubScheduler } from "../../support/stub-scheduler.ts";

function transportFor(stub: StubScheduler, token = "t"): HttpTransport {
  return new HttpTransport({ baseUrl: stub.url, token });
}

describe("v2 HTTP 传输", () => {
  test("公共头：Bearer、X-Executor-Protocol、X-Request-Id", async () => {
    const stub = new StubScheduler({ token: "t" });
    await transportFor(stub).post("/poll", { capacity: { free: 0 }, running: [], finished: [] }, 1000);
    const request = stub.requests[0];
    expect(request?.headers.authorization).toBe("Bearer t");
    expect(request?.headers["x-executor-protocol"]).toBe("2");
    expect(request?.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.headers["x-client-run-id"]).toBeUndefined();
    await stub.close();
  });

  test("401 → unauthorized 并终止；400 → unsupported_protocol", async () => {
    const stub = new StubScheduler({ token: "expected" });
    const unauthorized = await transportFor(stub, "wrong").post("/poll", {}, 1000).catch((error: unknown) => error);
    expect((unauthorized as GatewayError).code).toBe("unauthorized");
    expect((unauthorized as GatewayError).terminal).toBe(true);
    expect(mapHttpError(400, { error: { code: "unsupported_protocol" } }, "/poll").code).toBe("unsupported_protocol");
    await stub.close();
  });

  test("404/413/500 映射", () => {
    expect(mapHttpError(404, { error: { code: "task_not_found" } }, "/tasks/x/result").code).toBe("task_not_found");
    expect(mapHttpError(404, null, "/skill-packages/p").code).toBe("package_not_found");
    expect(mapHttpError(413, { error: { code: "payload_too_large" } }, "/tasks/x/result").code).toBe("payload_too_large");
    const internal = mapHttpError(500, { error: { code: "internal" } }, "/poll");
    expect(internal.code).toBe("unreachable");
    expect(internal.retryable).toBe(true);
  });

  test("超时归一为 timeout；连接失败为 unreachable", async () => {
    const slow = new StubScheduler({ pollHoldMs: 300 });
    const timed = await transportFor(slow).post("/poll", { capacity: { free: 0 }, running: [], finished: [] }, 20).catch((error: unknown) => error);
    expect((timed as GatewayError).code).toBe("timeout");
    await slow.close();

    const offline = new HttpTransport({ baseUrl: "http://127.0.0.1:1", token: null });
    const unreachable = await offline.post("/poll", {}, 300).catch((error: unknown) => error);
    expect((unreachable as GatewayError).code).toBe("unreachable");
  });

  test("withRetry 重试 5xx，4xx 不重试", async () => {
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

    let unauthorizedAttempts = 0;
    await expect(
      withRetry(
        async () => {
          unauthorizedAttempts += 1;
          throw new GatewayError("unauthorized", "no");
        },
        { baseMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(unauthorizedAttempts).toBe(1);
  });
});
