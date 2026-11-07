import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/components/cli/main.ts";

const fakeAcp = join(import.meta.dir, "../fixtures/fake-acp.mjs");

async function runDoctor(runDir: string, env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await main(["doctor", "--json"], {
    env,
    execPath: join(runDir, "agent-flow-client"),
    moduleDir: join(runDir, "src"),
    io: { out: (message) => out.push(message), err: () => undefined },
    homeDir: runDir,
  });
  return { code, out: out.join("\n") };
}

describe("SCN-0002 配置与自检", () => {
  test("场景：默认 home 下 doctor 全绿", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-cfg-"));
    const { code, out } = await runDoctor(runDir, { DSH_BIN: fakeAcp, AF_NODE_BIN: process.execPath, HUNDSUN_PUBLIC_API_KEY: "k" });
    expect(code).toBe(0);
    const lines = out.split("\n");
    const report = JSON.parse(lines.slice(lines.findIndex((line) => line.startsWith("{"))).join("\n"));
    expect(report.checks.find((check: { id: string }) => check.id === "config.dsh_home").detail).toContain(
      join(runDir, "AF_DSH_HOME"),
    );
    expect(report.summary.fail).toBe(0);
  });

  test("场景：配置的 home 原样传给 DSH 子进程", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-cfg-"));
    const home = join(runDir, "custom-home");
    const homeFile = join(runDir, "child-home.txt");
    await writeFile(join(runDir, ".config"), `[acp]\ndsh_home = "custom-home"\npermission = "allow"\n`);
    await mkdir(join(runDir, "workspace"), { recursive: true });
    const pkg = join(runDir, "pkg");
    await mkdir(join(pkg, "alpha"), { recursive: true });
    await writeFile(join(pkg, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n");
    const digest = await digestOf(pkg);
    const requestPath = join(runDir, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        attemptId: "01930000-0000-7000-8000-000000000011",
        attemptNo: 1,
        instanceId: "01930000-0000-7000-8000-000000000012",
        nodeId: "01930000-0000-7000-8000-000000000013",
        workspacePath: join(runDir, "workspace"),
        prompt: "HELLO",
        timeoutMs: 5000,
        claimedAt: "2026-11-08T00:00:00.000Z",
        lease: { expiresAt: "2026-11-08T00:02:00.000Z", ttlMs: 120000 },
        skillSet: {
          digest,
          packages: [{ packageId: "p", name: "alpha", version: "1", digest, sizeBytes: 0, downloadUrl: `file://${pkg}` }],
        },
      }),
    );
    const code = await main(["run", "--request", requestPath], {
      env: {
        DSH_BIN: fakeAcp,
        AF_NODE_BIN: process.execPath,
        HUNDSUN_PUBLIC_API_KEY: "k",
        FAKE_ACP_HOME_FILE: homeFile,
      },
      execPath: join(runDir, "agent-flow-client"),
      moduleDir: join(runDir, "src"),
      io: { out: () => undefined, err: () => undefined },
      homeDir: runDir,
    });
    expect(code).toBe(0);
    expect((await readFile(homeFile, "utf8")).trim()).toBe(home);
  });

  test("场景：DSH_HOME 环境变量覆盖配置并传给子进程", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-cfg-"));
    const envHome = join(runDir, "env-home");
    await writeFile(join(runDir, ".config"), `[acp]\ndsh_home = "config-home"\n`);
    const { out } = await runDoctor(runDir, {
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      HUNDSUN_PUBLIC_API_KEY: "k",
      DSH_HOME: envHome,
    });
    expect(out).toContain(`DSH_HOME=${envHome}（env）`);
  });

  test("场景：非法配置退出 2 且不产出报告", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-cfg-"));
    await writeFile(join(runDir, ".config"), `[acp]\ndsh_home = 3\n`);
    const { code, out } = await runDoctor(runDir, {});
    expect(code).toBe(2);
    expect(out).toBe("");
  });
});

async function digestOf(path: string): Promise<string> {
  const { digestDirectory } = await import("../../src/components/assets/digest.ts");
  return await digestDirectory(path);
}
