import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRunRegistry } from "../../../src/components/store/runs.ts";

const roots: string[] = [];

async function setup(nowMs = Date.parse("2026-11-17T10:00:00Z")) {
  const stateRoot = await mkdtemp(join(tmpdir(), "afc-runs-"));
  roots.push(stateRoot);
  const clock = { now: nowMs };
  const registry = new FileRunRegistry({ stateRoot, now: () => new Date(clock.now) });
  return { stateRoot, clock, registry };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("run 注册表", () => {
  test("upsert 保留 firstSeenAt，并按归档/更新刷新", async () => {
    const { registry, clock } = await setup();
    const first = await registry.upsert({
      runId: "01a1-run",
      instanceId: "inst-1",
      workspacePath: "/ws",
      taskSpacePath: "/ws/task",
    });
    expect(first.firstSeenAt).toBe("2026-11-17T10:00:00.000Z");
    expect(first.updatedAt).toBe("2026-11-17T10:00:00.000Z");
    expect(first.archivedAt).toBeUndefined();

    clock.now = Date.parse("2026-11-17T11:00:00Z");
    const second = await registry.upsert({
      runId: "01a1-run",
      instanceId: "inst-1",
      workspacePath: "/ws",
      taskSpacePath: "/ws/task",
    });
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.updatedAt).toBe("2026-11-17T11:00:00.000Z");
    expect(second.archivedAt).toBeUndefined();

    const archived = await registry.upsert({
      runId: "01a1-run",
      instanceId: "inst-1",
      workspacePath: "/ws",
      taskSpacePath: "/ws/task",
      archivedAt: "2026-11-17T11:30:00.000Z",
    });
    expect(archived.archivedAt).toBe("2026-11-17T11:30:00.000Z");
    expect(archived.firstSeenAt).toBe(first.firstSeenAt);
  });

  test("get/list 从磁盘重建，损坏文件跳过", async () => {
    const { registry, stateRoot } = await setup();
    await registry.upsert({ runId: "run-a", instanceId: "i", workspacePath: "/a", taskSpacePath: "/a/t" });
    await registry.upsert({ runId: "run-b", instanceId: "i", workspacePath: "/b", taskSpacePath: "/b/t" });
    await writeFile(join(stateRoot, "runs", "broken.json"), "{not-json");

    const rebuilt = new FileRunRegistry({ stateRoot });
    expect(await rebuilt.get("run-a")).toMatchObject({ workspacePath: "/a" });
    expect(await rebuilt.get("run-b")).toMatchObject({ workspacePath: "/b" });
    expect(await rebuilt.get("missing")).toBeNull();
    expect((await rebuilt.list()).map((item) => item.runId).sort()).toEqual(["run-a", "run-b"]);
  });

  test("prune 只清过期且非活跃的 run", async () => {
    const { registry, clock, stateRoot } = await setup(Date.parse("2026-11-01T00:00:00Z"));
    await registry.upsert({ runId: "archived-old", instanceId: "i", workspacePath: "/a", taskSpacePath: "/a/t", archivedAt: "2026-11-01T00:00:00.000Z" });
    await registry.upsert({ runId: "archived-active", instanceId: "i", workspacePath: "/b", taskSpacePath: "/b/t", archivedAt: "2026-11-01T00:00:00.000Z" });
    clock.now = Date.parse("2026-10-01T00:00:00Z");
    await registry.upsert({ runId: "unarchived-old", instanceId: "i", workspacePath: "/c", taskSpacePath: "/c/t" });
    clock.now = Date.parse("2026-11-17T10:00:00Z");

    const removed = await registry.prune({ activeRunIds: ["archived-active"] });
    expect(removed).toBe(1);
    expect(await registry.get("archived-active")).not.toBeNull();
    expect(await registry.get("archived-old")).toMatchObject({ goneAt: expect.any(String) });
    expect(await registry.get("unarchived-old")).toMatchObject({ workspacePath: "/c" });
    expect((await readdir(join(stateRoot, "runs"))).sort()).toEqual([
      "archived-active.json",
      "archived-old.json",
      "unarchived-old.json",
    ]);
  });

  test("非法 runId 不会越出 runs 目录", async () => {
    const { registry, stateRoot } = await setup();
    await registry.upsert({ runId: "../escape", instanceId: "i", workspacePath: "/a", taskSpacePath: "/a/t" });
    const names = await readdir(join(stateRoot, "runs"));
    expect(names).toEqual([".._escape.json"]);
  });
});
