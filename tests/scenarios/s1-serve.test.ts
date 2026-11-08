import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digestDirectory } from "../../src/components/assets/digest.ts";
import { StubScheduler } from "../support/stub-scheduler.ts";
import type { NodeRequest } from "../../src/components/executor/types.ts";

const fakeAcp = join(import.meta.dir, "../fixtures/fake-acp.mjs");
const repoRoot = join(import.meta.dir, "../..");

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fixture(options: { stubToken?: string; configToken?: string } = {}) {
  const runDir = await mkdtemp(join(tmpdir(), "afc-serve-"));
  const container = join(runDir, "workspace");
  const pkg = join(runDir, "pkg");
  const pidFile = join(runDir, "child.pid");
  await mkdir(join(container, "repo-a"), { recursive: true });
  await mkdir(join(pkg, "alpha", "scripts"), { recursive: true });
  await writeFile(join(pkg, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: ALPHA\n---\n");
  await writeFile(join(pkg, "alpha", "scripts", "run.sh"), "#!/bin/sh\necho ALPHA\n");
  const digest = await digestDirectory(pkg);
  const stubToken = options.stubToken ?? "stub-token";
  const configToken = options.configToken ?? stubToken;
  const stub = new StubScheduler({ token: stubToken });
  await writeFile(
    join(runDir, ".config"),
    `[acp]\ndsh_home = "${join(runDir, "dsh-home")}"\npermission = "allow"\n[state]\nroot = "${join(runDir, "state")}"\n[logging]\nlevel = "error"\n[scheduler]\nurl = "${stub.url}"\ntoken = "${configToken}"\n`,
  );
  const request: NodeRequest = {
    attemptId: "01930000-0000-7000-8000-000000000401",
    attemptNo: 1,
    instanceId: "01930000-0000-7000-8000-000000000402",
    nodeId: "01930000-0000-7000-8000-000000000403",
    workspacePath: container,
    prompt: "HELLO",
    timeoutMs: 30_000,
    claimedAt: "2026-11-08T00:00:00.000Z",
    lease: { expiresAt: "2026-11-08T00:02:00.000Z", ttlMs: 120000 },
  };
  stub.skillSet.packages.splice(0, stub.skillSet.packages.length, {
    packageId: "p-1",
    name: "alpha",
    version: "1",
    digest,
    sizeBytes: 0,
    downloadUrl: pathToFileURL(pkg).href,
  });
  stub.skillSet.digest = digest;
  return { runDir, container, digest, stub, request, pidFile };
}

function spawnServe(runDir: string, env: Record<string, string | undefined>) {
  const childEnv = { ...process.env, ...env } as Record<string, string>;
  delete (childEnv as Record<string, string | undefined>).DSH_HOME;
  return Bun.spawn(
    [
      process.execPath,
      "src/cli.ts",
      "serve",
      "--config",
      join(runDir, ".config"),
      "--state-root",
      join(runDir, "state"),
    ],
    {
    cwd: repoRoot,
    env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(25);
}

describe("S1 serve 主循环（桩调度器）", () => {
  test("注册 → 领取 → 执行 → 上报 → shutdown 退出 0", async () => {
    const { runDir, stub, request, pidFile } = await fixture();
    stub.enqueueRequest(request);
    const child = spawnServe(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      FAKE_ACP_PID_FILE: pidFile,
      HUNDSUN_PUBLIC_API_KEY: "k",
    });
    await waitFor(() => stub.requests.some((item) => item.path.endsWith("/result")));
    const report = stub.requests.find((item) => item.path.endsWith("/result"));
    const body = report?.body.result as { status: string; message: string; sessionId: string } | undefined;
    expect(body?.status).toBe("succeeded");
    expect(body?.message).toContain("OK-HELLO");
    expect(body?.sessionId).toBe("s-1");

    const journal = await readFile(join(runDir, "state", "journal.jsonl"), "utf8");
    const states = journal.trim().split("\n").map((line) => JSON.parse(line).state);
    expect(states.at(-1)).toBe("closed");

    stub.enqueueEvent({ type: "shutdown", issuedAt: new Date().toISOString() });
    const code = await child.exited;
    expect(code).toBe(0);
    expect(await alive(Number((await Bun.file(pidFile).text()).trim()))).toBe(false);
    stub.server.stop(true);
  }, 30_000);

  test("register 鉴权失败退出 3", async () => {
    const { runDir, stub } = await fixture({ stubToken: "stub-token", configToken: "wrong-token" });
    const child = spawnServe(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      HUNDSUN_PUBLIC_API_KEY: "k",
    });
    const code = await child.exited;
    expect(code).toBe(3);
    stub.server.stop(true);
  }, 20_000);

  test("register run_superseded 退出 7", async () => {
    const { runDir, stub } = await fixture();
    stub.failNext("POST /api/v1/executor/register", { status: 409, code: "run_superseded", times: 1 });
    const child = spawnServe(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      HUNDSUN_PUBLIC_API_KEY: "k",
    });
    expect(await child.exited).toBe(7);
    stub.server.stop(true);
  }, 20_000);

  test("register 版本不兼容退出 3", async () => {
    const { runDir, stub } = await fixture();
    stub.setCompatibility("incompatible");
    const child = spawnServe(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      HUNDSUN_PUBLIC_API_KEY: "k",
    });
    expect(await child.exited).toBe(3);
    stub.server.stop(true);
  }, 20_000);

  test("心跳 run_superseded 退出 7", async () => {
    const { runDir, stub } = await fixture();
    stub.failNext("POST /api/v1/executor/heartbeat", { status: 409, code: "run_superseded", times: 1 });
    const child = spawnServe(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      HUNDSUN_PUBLIC_API_KEY: "k",
    });
    expect(await child.exited).toBe(7);
    stub.server.stop(true);
  }, 20_000);

  test("cancel 控制事件终止活跃 prompt 并上报 cancelled", async () => {
    const { runDir, stub, request } = await fixture();
    stub.enqueueRequest({ ...request, prompt: "SLOW", timeoutMs: 30_000 });
    const child = spawnServe(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      HUNDSUN_PUBLIC_API_KEY: "k",
    });
    await waitFor(() => stub.requests.some((item) => item.path.endsWith("/session")));
    stub.enqueueEvent({ type: "cancel", instanceId: request.instanceId, reason: "user_cancel", issuedAt: new Date().toISOString() });
    await waitFor(() =>
      stub.requests.some(
        (item) => item.path.endsWith("/result") && (item.body.result as { status?: string } | undefined)?.status === "cancelled",
      ),
    );
    const report = stub.requests.find(
      (item) => item.path.endsWith("/result") && (item.body.result as { status?: string } | undefined)?.status === "cancelled",
    );
    expect((report?.body.result as { status: string } | undefined)?.status).toBe("cancelled");
    stub.enqueueEvent({ type: "shutdown", issuedAt: new Date().toISOString() });
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 30_000);

  test("register 清理意图在心跳中回执", async () => {
    const { runDir, stub } = await fixture();
    stub.setCleanupPending([
      { releaseId: "release-1", instanceId: "01930000-0000-7000-8000-000000000499", cleanup: "keep", releasedAt: new Date().toISOString() },
    ]);
    const child = spawnServe(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      HUNDSUN_PUBLIC_API_KEY: "k",
    });
    await waitFor(() => stub.requests.some((item) => Array.isArray(item.body.cleanupAcks) && (item.body.cleanupAcks as unknown[]).length > 0));
    const heartbeat = stub.requests.find((item) => Array.isArray(item.body.cleanupAcks) && (item.body.cleanupAcks as unknown[]).length > 0);
    expect((heartbeat?.body.cleanupAcks as { releaseId: string }[])[0]?.releaseId).toBe("release-1");
    stub.enqueueEvent({ type: "shutdown", issuedAt: new Date().toISOString() });
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 30_000);
});

describe("S1 恢复与重报", () => {
  test("server 已有 settled 未上报：重启后 recover 重报 accepted", async () => {
    const { runDir, stub, request } = await fixture();
    const { FileStore } = await import("../../src/components/store/store.ts");
    const store = new FileStore({ stateRoot: join(runDir, "state") });
    await store.init();
    await store.append({
      v: 1,
      ts: "2026-11-08T00:00:00.000Z",
      attemptId: request.attemptId,
      instanceId: request.instanceId,
      nodeId: request.nodeId,
      state: "settled",
      result: {
        attemptId: request.attemptId,
        status: "succeeded",
        message: "RECOVERED",
        truncated: false,
        stopReason: "end_turn",
        usage: null,
        error: null,
      },
    });
    const child = spawnServe(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      HUNDSUN_PUBLIC_API_KEY: "k",
    });
    await waitFor(() => stub.requests.some((item) => item.path.endsWith("/result")));
    const report = stub.requests.find((item) => item.path.endsWith("/result"));
    expect((report?.body.result as { message: string } | undefined)?.message).toBe("RECOVERED");
    await waitFor(async () => {
      const journal = await readFile(join(runDir, "state", "journal.jsonl"), "utf8").catch(() => "");
      return journal.includes('"state":"reported"');
    });
    const journal = await readFile(join(runDir, "state", "journal.jsonl"), "utf8");
    expect(journal).toContain('"state":"reported"');
    stub.enqueueEvent({ type: "shutdown", issuedAt: new Date().toISOString() });
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 30_000);
});
