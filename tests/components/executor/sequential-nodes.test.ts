import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutor } from "../../../src/components/executor/executor.ts";
import { LocalAssets } from "../../../src/components/assets/assets.ts";
import { FileWorkspace } from "../../../src/components/workspace/workspace.ts";
import { digestDirectory } from "../../../src/components/assets/digest.ts";
import { pathToFileURL } from "node:url";
import type { NodeRequest } from "../../../src/components/executor/types.ts";
import { FakeRuntime, FakeScheduler, MemoryJournal } from "./fakes.ts";

const instance = { instanceId: "i-linear", pid: process.pid };

async function makePackage(name: string, description: string): Promise<{ dir: string; digest: string; skillSet: import("../../../src/components/executor/types.ts").SkillSet }> {
  const dir = await mkdtemp(join(tmpdir(), `afc-${name}-`));
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  const digest = await digestDirectory(dir);
  return {
    dir,
    digest,
    skillSet: {
      digest,
      packages: [{ packageId: `p-${name}`, name, version: "1", digest, sizeBytes: 0, downloadUrl: pathToFileURL(dir).href }],
    },
  };
}

function request(attemptId: string, prompt: string, workspacePath: string): NodeRequest {
  return {
    attemptId,
    attemptNo: 1,
    instanceId: "i-linear",
    nodeId: `n-${attemptId}`,
    workspacePath,
    prompt,
    timeoutMs: 5000,
    claimedAt: "2026-11-09T00:00:00.000Z",
    lease: { expiresAt: "2026-11-09T00:02:00.000Z", ttlMs: 120000 },
  };
}

describe("TC-EXEC-002 顺序多节点", () => {
  test("两节点顺序执行：各自技能集、替换不叠加、进程复用", async () => {
    const container = await mkdtemp(join(tmpdir(), "afc-linear-ws-"));
    await mkdir(join(container, "repo-a"), { recursive: true });
    await writeFile(join(container, "repo-a", "artifact.txt"), "from-node-1\n");
    const alpha = await makePackage("alpha", "ALPHA");
    const beta = await makePackage("beta", "BETA");

    const journal = new MemoryJournal();
    const runtime = new FakeRuntime();
    const scheduler = new FakeScheduler();
    const workspace = new FileWorkspace();
    const assets = new LocalAssets();
    const executor = new NodeExecutor({ scheduler, runtime, workspace, assets, journal, dshHome: "/tmp/unused" });

    scheduler.bindSkillSets.set("a-1", alpha.skillSet);
    const first = await executor.executeNode(request("a-1", "NODE-1", container), { signal: new AbortController().signal });
    expect(first.status).toBe("succeeded");
    expect((await readdir(join(container, ".dsh", "skills"))).sort()).toEqual(["alpha"]);

    scheduler.bindSkillSets.set("a-2", beta.skillSet);
    const second = await executor.executeNode(request("a-2", "NODE-2", container), { signal: new AbortController().signal });
    expect(second.status).toBe("succeeded");
    expect((await readdir(join(container, ".dsh", "skills"))).sort()).toEqual(["beta"]);
    expect(await readFile(join(container, "repo-a", "artifact.txt"), "utf8")).toBe("from-node-1\n");
    expect(runtime.ensureCalls).toBeGreaterThanOrEqual(2);
  });

  test("技能切换 A→B→A：每次只见当前集，digest 幂等", async () => {
    const container = await mkdtemp(join(tmpdir(), "afc-switch-ws-"));
    const alpha = await makePackage("alpha", "ALPHA");
    const beta = await makePackage("beta", "BETA");
    const journal = new MemoryJournal();
    const runtime = new FakeRuntime();
    const scheduler = new FakeScheduler();
    const executor = new NodeExecutor({
      scheduler,
      runtime,
      workspace: new FileWorkspace(),
      assets: new LocalAssets(),
      journal,
      dshHome: "/tmp/unused",
    });

    for (const [attemptId, pkg] of [["a-1", alpha], ["a-2", beta], ["a-3", alpha]] as const) {
      scheduler.bindSkillSets.set(attemptId, pkg.skillSet);
      const result = await executor.executeNode(request(attemptId, attemptId, container), { signal: new AbortController().signal });
      expect(result.status).toBe("succeeded");
      const names = (await readdir(join(container, ".dsh", "skills"))).sort();
      expect(names).toEqual([pkg === alpha ? "alpha" : "beta"]);
    }
    expect(journal.states.filter((state) => state === "closed")).toHaveLength(3);
  });

  test("同一 attemptId 完成后重复调用返回缓存结果，不重复执行", async () => {
    const container = await mkdtemp(join(tmpdir(), "afc-idem-ws-"));
    const alpha = await makePackage("alpha", "ALPHA");
    const journal = new MemoryJournal();
    const runtime = new FakeRuntime();
    const scheduler = new FakeScheduler();
    const executor = new NodeExecutor({
      scheduler,
      runtime,
      workspace: new FileWorkspace(),
      assets: new LocalAssets(),
      journal,
      dshHome: "/tmp/unused",
    });
    scheduler.bindSkillSets.set("a-1", alpha.skillSet);
    await executor.executeNode(request("a-1", "ONCE", container), { signal: new AbortController().signal });
    const again = await executor.executeNode(request("a-1", "ONCE", container), { signal: new AbortController().signal });
    expect(again.status).toBe("succeeded");
    expect(runtime.prompts).toHaveLength(1);
    void container;
  });
});
