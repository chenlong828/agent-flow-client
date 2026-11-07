import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockManager } from "../../../src/components/store/locks.ts";
import { StoreError } from "../../../src/components/store/errors.ts";

async function fixture(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "afc-lock-"));
}

describe("实例锁", () => {
  test("同实例双跑返回 locked；unlock 后可重取", async () => {
    const root = await fixture();
    const locks = new LockManager(root);
    const unlock = await locks.lock("instance-1");
    await expect(locks.lock("instance-1")).rejects.toBeInstanceOf(StoreError);
    await expect(locks.lock("instance-1")).rejects.toMatchObject({ code: "locked" });
    await unlock();
    const again = await locks.lock("instance-1");
    await again();
  });

  test("unlock 幂等", async () => {
    const root = await fixture();
    const locks = new LockManager(root);
    const unlock = await locks.lock("instance-1");
    await unlock();
    await unlock();
  });

  test("pid 不存在的陈旧锁被接管", async () => {
    const root = await fixture();
    await mkdir(join(root, "locks"), { recursive: true });
    await writeFile(
      join(root, "locks", "instance-1.lock"),
      JSON.stringify({ pid: 999999, host: "h", startedAt: new Date().toISOString(), token: "old" }),
    );
    const locks = new LockManager(root);
    const unlock = await locks.lock("instance-1");
    const content = JSON.parse(await readFile(join(root, "locks", "instance-1.lock"), "utf8"));
    expect(content.pid).toBe(process.pid);
    expect(content.token).not.toBe("old");
    await unlock();
  });

  test("锁年龄超过阈值即使 pid 存活也接管", async () => {
    const root = await fixture();
    await mkdir(join(root, "locks"), { recursive: true });
    await writeFile(
      join(root, "locks", "instance-1.lock"),
      JSON.stringify({ pid: process.pid, host: "h", startedAt: new Date(Date.now() - 3_600_000).toISOString(), token: "old" }),
    );
    const locks = new LockManager(root, { staleMs: 60_000 });
    const unlock = await locks.lock("instance-1");
    await unlock();
  });

  test("诊断列出陈旧锁", async () => {
    const root = await fixture();
    await mkdir(join(root, "locks"), { recursive: true });
    await writeFile(join(root, "locks", "dead.lock"), JSON.stringify({ pid: 999999, host: "h", startedAt: new Date().toISOString(), token: "t" }));
    const locks = new LockManager(root);
    const diagnostics = await locks.diagnose();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.stale).toBe(true);
  });
});
