import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "../../src/components/cli/main.ts";
import { digestDirectory } from "../../src/components/assets/digest.ts";

const fakeAcp = join(import.meta.dir, "../fixtures/fake-acp.mjs");

type RunResult = { code: number; out: string; err: string };

async function setup(options: { prompt: string; timeoutMs?: number; skill?: boolean }): Promise<{
  runDir: string;
  requestPath: string;
  container: string;
  env: Record<string, string | undefined>;
}> {
  const runDir = await mkdtemp(join(tmpdir(), "afc-s0-"));
  const container = join(runDir, "workspace");
  const pkg = join(runDir, "pkg");
  await mkdir(join(container, "repo-a"), { recursive: true });
  await writeFile(join(container, "repo-a", "README.md"), "hello\n");
  await mkdir(join(pkg, "alpha", "scripts"), { recursive: true });
  await writeFile(join(pkg, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Outputs ALPHA.\n---\n\n# alpha\n");
  await writeFile(join(pkg, "alpha", "scripts", "run.sh"), "#!/bin/sh\necho ALPHA\n");
  const digest = await digestDirectory(pkg);
  await writeFile(
    join(runDir, ".config"),
    `[acp]\ndsh_home = "dsh-home"\npermission = "allow"\n[state]\nroot = "state"\n[logging]\nlevel = "error"\n`,
  );
  const skillSet = {
    digest,
    packages: [
      { packageId: "p-1", name: "alpha", version: "1", digest, sizeBytes: 0, downloadUrl: pathToFileURL(pkg).href },
    ],
  };
  const request = {
    taskId: "01930000-0000-7000-8000-000000000001",
    attempt: 1,
    instanceId: "01930000-0000-7000-8000-000000000002",
    nodeId: "01930000-0000-7000-8000-000000000003",
    workspacePath: container,
    prompt: options.prompt,
    timeoutMs: options.timeoutMs ?? 5000,
    skillSet,
  };
  const requestPath = join(runDir, "request.json");
  await writeFile(requestPath, JSON.stringify(request));
  const env = {
    DSH_BIN: fakeAcp,
    AF_NODE_BIN: process.execPath,
    HUNDSUN_PUBLIC_API_KEY: "test-key",
  };
  return { runDir, requestPath, container, env };
}

async function run(requestPath: string, runDir: string, env: Record<string, string | undefined>): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["run", "--request", requestPath], {
    env,
    execPath: join(runDir, "agent-flow-client"),
    moduleDir: join(runDir, "src"),
    io: { out: (message) => out.push(message), err: (message) => err.push(message) },
    homeDir: runDir,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("SCN-0001 S0 端到端（ACP 桩）", () => {
  test("TC-EXEC-001 单节点成功：结果 JSON、技能落地、journal 收口", async () => {
    const { runDir, requestPath, container, env } = await setup({ prompt: "HELLO" });
    const result = await run(requestPath, runDir, env);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.status).toBe("succeeded");
    expect(payload.message).toContain("OK-HELLO");
    expect(payload.sessionId).toBe("s-1");

    const skill = await readFile(join(container, ".dsh", "skills", "alpha", "SKILL.md"), "utf8");
    expect(skill).toContain("name: alpha");
    const journal = await readFile(join(runDir, "state", "journal.jsonl"), "utf8");
    const states = journal.trim().split("\n").map((line) => JSON.parse(line).state);
    expect(states).toEqual(["received", "running", "settled"]);
    expect((await readdir(join(runDir, "state", "orphans"))).length).toBe(0);
  });

  test("TC-EXEC-003 prompt 超时：退出 1、结果 timeout", async () => {
    const { runDir, requestPath, env } = await setup({ prompt: "SLOW", timeoutMs: 150 });
    const result = await run(requestPath, runDir, env);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.status).toBe("timeout");
    expect(payload.error).toMatchObject({ class: "timeout", code: "timeout" });
  });

  test("TC-EXEC-004 技能包非法：不 prompt、退出 1、结果 asset 类", async () => {
    const { runDir, requestPath, env } = await setup({ prompt: "HELLO" });
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    request.skillSet.packages[0].digest = `sha256:${"0".repeat(64)}`;
    await writeFile(requestPath, JSON.stringify(request));
    const result = await run(requestPath, runDir, env);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.status).toBe("failed");
    expect(payload.error).toMatchObject({ class: "asset", code: "checksum_mismatch" });
  });
});
