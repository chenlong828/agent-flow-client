import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrphanStore } from "../../../src/components/store/orphans.ts";

describe("孤儿进程记录", () => {
  test("记录、按实例列出、清理幂等", async () => {
    const root = await mkdtemp(join(tmpdir(), "afc-orphan-"));
    const store = new OrphanStore(root);
    await store.record({ pid: 101, pgid: 101, instanceId: "i-1", taskId: "t-1", createdAt: "2026-11-08T00:00:00Z", host: "h" });
    await store.record({ pid: 202, instanceId: "i-2", createdAt: "2026-11-08T00:00:00Z", host: "h" });

    expect((await store.list()).map((item) => item.pid).sort()).toEqual([101, 202]);
    expect((await store.list("i-1")).map((item) => item.pid)).toEqual([101]);

    await store.clear(101);
    await store.clear(101);
    expect((await store.list()).map((item) => item.pid)).toEqual([202]);
  });
});
