import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpRuntime } from "../../../src/components/runtime/runtime.ts";
import type { InstanceHandle } from "../../../src/components/executor/ports.ts";

const fakeAcp = join(import.meta.dir, "../../../tests/fixtures/fake-acp.mjs");

async function fixture(permission: "allow" | "deny" = "allow"): Promise<{
  runtime: AcpRuntime;
  handle: InstanceHandle;
  cwd: string;
  pidFile: string;
  home: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "afc-runtime-"));
  const cwd = join(base, "container");
  const home = join(base, "home");
  const pidFile = join(base, "child.pid");
  await Bun.write(join(cwd, ".keep"), "");
  const runtime = new AcpRuntime({
    command: { command: process.execPath, args: [fakeAcp] },
    env: { ...process.env, FAKE_ACP_PID_FILE: pidFile },
    permission,
  });
  const handle = await runtime.ensureInstance({ instanceId: "i-1", dshHome: home, containerRoot: cwd });
  return { runtime, handle, cwd, pidFile, home };
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ACP 会话", () => {
  test("建 session、prompt、累积文本与 usage", async () => {
    const { runtime, handle, cwd } = await fixture();
    const session = await runtime.newSession(handle, cwd);
    const outcome = await runtime.prompt(session, "HELLO", { signal: new AbortController().signal, timeoutMs: 5000 });
    expect(outcome.finalText).toContain("OK-HELLO");
    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(outcome.error).toBeUndefined();
    await runtime.closeSession(session);
    await runtime.shutdownInstance(handle, "graceful");
  });

  test("closeSession 幂等（第二次忽略 unknown session）", async () => {
    const { runtime, handle, cwd } = await fixture();
    const session = await runtime.newSession(handle, cwd);
    await runtime.closeSession(session);
    await runtime.closeSession(session);
    await runtime.shutdownInstance(handle, "graceful");
  });

  test("进程崩溃时 prompt 返回 process_exited，重启后可用", async () => {
    const { runtime, handle, cwd } = await fixture();
    const session = await runtime.newSession(handle, cwd);
    const outcome = await runtime.prompt(session, "CRASH", { signal: new AbortController().signal, timeoutMs: 5000 });
    expect(outcome.error?.code).toBe("process_exited");
    expect(outcome.error?.class).toBe("runtime");

    const again = await runtime.ensureInstance({ instanceId: "i-1", dshHome: join(cwd, "..", "home"), containerRoot: cwd });
    const fresh = await runtime.newSession(again, cwd);
    const ok = await runtime.prompt(fresh, "AGAIN", { signal: new AbortController().signal, timeoutMs: 5000 });
    expect(ok.finalText).toContain("OK-AGAIN");
    await runtime.shutdownInstance(again, "graceful");
  });
});

describe("取消与超时", () => {
  test("cancel 立即结束 prompt 并回收进程组与子进程", async () => {
    const { runtime, handle, cwd, pidFile } = await fixture();
    const session = await runtime.newSession(handle, cwd);
    const pending = runtime.prompt(session, "SLOW", { signal: new AbortController().signal, timeoutMs: 30_000 });
    await Bun.sleep(100);
    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(await alive(childPid)).toBe(true);

    await runtime.cancel(session);
    const outcome = await pending;
    expect(outcome.error?.code).toBe("cancelled");
    expect(await alive(handle.pid)).toBe(false);
    expect(await alive(childPid)).toBe(false);
  });

  test("prompt 超时返回 timeout 并回收进程", async () => {
    const { runtime, handle, cwd } = await fixture();
    const session = await runtime.newSession(handle, cwd);
    const started = Date.now();
    const outcome = await runtime.prompt(session, "SLOW", { signal: new AbortController().signal, timeoutMs: 150 });
    expect(outcome.error?.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await alive(handle.pid)).toBe(false);
  });
});

describe("权限策略", () => {
  test("allow 选择 allow_once，deny 返回 cancelled", async () => {
    for (const [permission, expected] of [["allow", "ALLOWED"], ["deny", "DENIED"]] as const) {
      const { runtime, handle, cwd } = await fixture(permission);
      const session = await runtime.newSession(handle, cwd);
      const outcome = await runtime.prompt(session, "PERMISSION", { signal: new AbortController().signal, timeoutMs: 5000 });
      expect(outcome.finalText).toContain(expected);
      await runtime.shutdownInstance(handle, "force");
    }
  });
});
