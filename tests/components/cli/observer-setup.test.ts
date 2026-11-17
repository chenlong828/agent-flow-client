import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupObserver } from "../../../src/components/cli/observer-setup.ts";
import type { AppConfig } from "../../../src/components/cli/config.ts";
import type { Logger } from "../../../src/components/observability/logger.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown>): AppConfig {
  return {
    observability: {
      enabled: true,
      required: false,
      bind: "127.0.0.1",
      port: 0,
      advertiseUrl: "http://127.0.0.1:17890/api/v1/observability",
      token: null,
      maxStreams: 20,
      rawEnabled: true,
      richStreamEnabled: true,
      retentionDays: 7,
      maxBytes: 1024 * 1024,
      maxAttemptEventBytes: 1024 * 1024,
      ...overrides,
    },
  } as unknown as AppConfig;
}

const logger = { log: (): undefined => undefined } as unknown as Logger;
const runs = {
  get: async (): Promise<null> => null,
  count: async (): Promise<number> => 0,
  prune: async (): Promise<number> => 0,
};

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "afc-observer-setup-"));
  roots.push(root);
  return root;
}

describe("observer setup", () => {
  test("enabled=false 时不记录、不广告 URL", async () => {
    const root = await stateRoot();
    const setup = await setupObserver({ config: config({ enabled: false }), stateRoot: root, runs, logger });
    expect(setup.record).toBe(false);
    expect(setup.observer).toBeUndefined();
    expect(setup.advertiseUrl).toBeUndefined();
  });

  test("bind 失败（required=false）时仍记录事件，但不广告 URL", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    const port = blocker.port;
    if (port === undefined) throw new Error("blocker 没有端口");
    const root = await stateRoot();
    const setup = await setupObserver({ config: config({ port }), stateRoot: root, runs, logger });
    expect(setup.observer).toBeUndefined();
    expect(setup.advertiseUrl).toBeUndefined();
    expect(setup.record).toBe(true);
    const attemptId = await setup.recorder.startAttempt({
      taskId: "t1",
      attemptNo: 1,
      instanceId: "i1",
      nodeId: "n1",
      startedAt: "2026-11-17T00:00:00Z",
    });
    expect(attemptId).not.toBeNull();
    expect(await Bun.file(join(root, "observability", "attempts", String(attemptId), "meta.json")).exists()).toBe(true);
    blocker.stop(true);
  });

  test("启动成功时记录并广告 URL", async () => {
    const root = await stateRoot();
    const setup = await setupObserver({ config: config({ port: 0 }), stateRoot: root, runs, logger });
    expect(setup.record).toBe(true);
    expect(setup.observer?.handle.port).toBeGreaterThan(0);
    expect(setup.advertiseUrl).toBe("http://127.0.0.1:17890/api/v1/observability");
    setup.observer?.cleanup();
    setup.observer?.handle.stop();
  });
});
