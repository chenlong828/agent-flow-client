import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digestDirectory } from "../../src/components/assets/digest.ts";
import { StubScheduler } from "../support/stub-scheduler.ts";
import type { NodeRequest, SkillSet } from "../../src/components/executor/types.ts";

const fakeAcp = join(import.meta.dir, "../fixtures/fake-acp.mjs");
const repoRoot = join(import.meta.dir, "../..");

async function packageFor(name: string): Promise<SkillSet> {
  const dir = await mkdtemp(join(tmpdir(), `afc-s2-${name}-`));
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  const digest = await digestDirectory(dir);
  return {
    digest,
    packages: [{ packageId: `p-${name}`, name, version: "1", digest, sizeBytes: 0, downloadUrl: pathToFileURL(dir).href }],
  };
}

function request(attemptId: string, prompt: string, container: string): NodeRequest {
  return {
    attemptId,
    attemptNo: 1,
    instanceId: "01930000-0000-7000-8000-000000000501",
    nodeId: `n-${attemptId}`,
    workspacePath: container,
    prompt,
    timeoutMs: 30_000,
    claimedAt: "2026-11-09T00:00:00.000Z",
    lease: { expiresAt: "2026-11-09T00:02:00.000Z", ttlMs: 120000 },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(25);
}

describe("S2 线性多节点（serve + 桩调度器）", () => {
  test("两节点顺序执行：各自技能集、同一 DSH 进程复用、产物保留", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-s2-serve-"));
    const container = join(runDir, "workspace");
    const procLog = join(runDir, "acp-procs.log");
    await mkdir(join(container, "repo-a"), { recursive: true });
    await writeFile(join(container, "repo-a", "artifact.txt"), "from-node-1\n");

    const alpha = await packageFor("alpha");
    const beta = await packageFor("beta");
    const stub = new StubScheduler({ token: "stub-token" });
    await writeFile(
      join(runDir, ".config"),
      `[acp]\ndsh_home = "${join(runDir, "dsh-home")}"\npermission = "allow"\n[state]\nroot = "${join(runDir, "state")}"\n[logging]\nlevel = "error"\n[scheduler]\nurl = "${stub.url}"\ntoken = "stub-token"\n`,
    );
    const first = request("01930000-0000-7000-8000-000000000502", "NODE-1", container);
    const second = request("01930000-0000-7000-8000-000000000503", "NODE-2", container);
    stub.setSkillSetFor(first.attemptId, alpha);
    stub.setSkillSetFor(second.attemptId, beta);
    stub.enqueueRequest(first);
    stub.enqueueRequest(second);

    const childEnv = { ...process.env, DSH_BIN: fakeAcp, AF_NODE_BIN: process.execPath, HUNDSUN_PUBLIC_API_KEY: "k", FAKE_ACP_PROC_LOG: procLog } as Record<string, string>;
    delete (childEnv as Record<string, string | undefined>).DSH_HOME;
    const child = Bun.spawn(
      [process.execPath, "src/cli.ts", "serve", "--config", join(runDir, ".config"), "--state-root", join(runDir, "state")],
      { cwd: repoRoot, env: childEnv, stdout: "pipe", stderr: "pipe" },
    );

    await waitFor(() => stub.requests.filter((item) => item.path.endsWith("/result")).length >= 2);
    const reports = stub.requests.filter((item) => item.path.endsWith("/result"));
    expect(reports.map((item) => (item.body.result as { status: string }).status)).toEqual(["succeeded", "succeeded"]);

    const journal = await readFile(join(runDir, "state", "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n").filter((line) => line.includes('"state":"closed"'))).toHaveLength(2);
    expect(await readFile(join(container, "repo-a", "artifact.txt"), "utf8")).toBe("from-node-1\n");
    expect(await readFile(join(container, ".dsh", "skills", "beta", "SKILL.md"), "utf8")).toContain("name: beta");
    await expect(Bun.file(join(container, ".dsh", "skills", "alpha", "SKILL.md")).exists()).resolves.toBe(false);
    expect((await readFile(procLog, "utf8")).trim().split("\n")).toHaveLength(1);

    stub.enqueueEvent({ type: "shutdown", issuedAt: new Date().toISOString() });
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 40_000);
});
