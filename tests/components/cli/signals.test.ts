import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digestDirectory } from "../../../src/components/assets/digest.ts";

const fakeAcp = join(import.meta.dir, "../../fixtures/fake-acp.mjs");
const repoRoot = join(import.meta.dir, "../../..");

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("UC-14 信号收口", () => {
  test("SIGINT 取消活跃 prompt、回收进程组并以 130 退出", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-sig-"));
    const container = join(runDir, "workspace");
    const pkg = join(runDir, "pkg");
    const pidFile = join(runDir, "child.pid");
    const promptFile = join(runDir, "prompt-started.txt");
    await mkdir(container, { recursive: true });
    await mkdir(join(pkg, "alpha"), { recursive: true });
    await writeFile(join(pkg, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n");
    const digest = await digestDirectory(pkg);
    await writeFile(
      join(runDir, ".config"),
      `[acp]\ndsh_home = "dsh-home"\npermission = "allow"\n[state]\nroot = "state"\n[logging]\nlevel = "error"\n`,
    );
    const requestPath = join(runDir, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        taskId: "01930000-0000-7000-8000-000000000201",
        attempt: 1,
        instanceId: "01930000-0000-7000-8000-000000000202",
        nodeId: "01930000-0000-7000-8000-000000000203",
        workspacePath: container,
        prompt: "SLOW",
        timeoutMs: 30_000,
        skillSet: {
          digest,
          packages: [{ packageId: "p", name: "alpha", version: "1", digest, sizeBytes: 0, downloadUrl: pathToFileURL(pkg).href }],
        },
      }),
    );

    const env = {
      ...process.env,
      DSH_BIN: fakeAcp,
      AF_NODE_BIN: process.execPath,
      FAKE_ACP_PID_FILE: pidFile,
      FAKE_ACP_PROMPT_FILE: promptFile,
      HUNDSUN_PUBLIC_API_KEY: "k",
    };
    delete (env as Record<string, string | undefined>).DSH_HOME;
    const child = Bun.spawn([process.execPath, "src/cli.ts", "run", "--request", requestPath], {
      cwd: repoRoot,
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 10_000;
    while (!(await Bun.file(promptFile).exists()) && Date.now() < deadline) await Bun.sleep(20);
    const groupPid = Number((await Bun.file(pidFile).text()).trim());
    child.kill("SIGINT");
    const code = await child.exited;
    const stdout = await new Response(child.stdout).text();
    expect(code).toBe(130);
    expect(JSON.parse(stdout.trim()).status).toBe("cancelled");
    await Bun.sleep(200);
    expect(await alive(groupPid)).toBe(false);
  }, 20_000);
});
