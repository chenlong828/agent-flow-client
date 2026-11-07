import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../../src/version.ts";
import { main } from "../../../src/components/cli/main.ts";

type Result = { code: number; out: string; err: string };

async function run(argv: string[], options: { runDir?: string; env?: Record<string, string | undefined> } = {}): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const runDir = options.runDir ?? (await mkdtemp(join(tmpdir(), "afc-cli-")));
  const code = await main(argv, {
    env: options.env ?? {},
    execPath: join(runDir, "agent-flow-client"),
    moduleDir: join(runDir, "src"),
    io: { out: (message) => out.push(message), err: (message) => err.push(message) },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli 命令面", () => {
  test("--version 打印版本", async () => {
    const result = await run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(VERSION);
  });

  test("version --json 输出协议与基线", async () => {
    const result = await run(["version", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      client: VERSION,
      acpProtocol: 1,
      dshBaseline: "0.2.2-alpha.2",
    });
  });

  test("--help 打印命令", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("serve");
    expect(result.out).toContain("doctor");
  });

  test("未知命令返回 2", async () => {
    const result = await run(["nope"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("未知命令");
  });

  test("未知选项返回 2", async () => {
    const result = await run(["run", "--nope", "x"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("未知选项");
  });

  test("serve 校验配置后返回 S1 未实现", async () => {
    const result = await run(["serve"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("S1");
  });

  test("run 缺 --request 返回 2", async () => {
    const result = await run(["run"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--request");
  });

  test("run 接受合法请求但内核未接入时返回 4", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-run-"));
    const request = {
      attemptId: "01930000-0000-7000-8000-000000000001",
      attemptNo: 1,
      instanceId: "01930000-0000-7000-8000-000000000002",
      nodeId: "01930000-0000-7000-8000-000000000003",
      workspacePath: join(runDir, "workspace"),
      prompt: "Reply with exactly: OK",
      timeoutMs: 60000,
      claimedAt: "2026-11-08T00:00:00.000Z",
      lease: { expiresAt: "2026-11-08T00:02:00.000Z", ttlMs: 120000 },
      skillSet: { digest: "sha256:abc", packages: [] },
    };
    const file = join(runDir, "request.json");
    await writeFile(file, JSON.stringify(request));
    const result = await run(["run", "--request", file], { runDir });
    expect(result.code).toBe(4);
    expect(result.err).toContain("执行内核尚未接入");
  });

  test("run 请求文件非法返回 2", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-run-"));
    const file = join(runDir, "request.json");
    await writeFile(file, JSON.stringify({ attemptId: "x" }));
    const result = await run(["run", "--request", file], { runDir });
    expect(result.code).toBe(2);
    expect(result.err).toContain("请求文件错误");
  });

  test("doctor 全部可判定项通过时退出 0", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-doc-"));
    const bin = join(runDir, "fake-dsh");
    await writeFile(bin, "#!/bin/sh\necho 0.2.2-alpha.2\n", { mode: 0o755 });
    const result = await run(["doctor"], {
      runDir,
      env: { DSH_BIN: bin, HUNDSUN_PUBLIC_API_KEY: "test-key" },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("[PASS] config.dsh_home");
    expect(result.out).toContain("[PASS] auth.credentials");
    expect(result.out).toContain("[PASS] dsh.version");
    expect(result.out).toContain("scheduler.connectivity");
  });

  test("doctor --json 只输出 JSON 报告", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-doc-"));
    const bin = join(runDir, "fake-dsh");
    await writeFile(bin, "#!/bin/sh\necho 0.2.2-alpha.2\n", { mode: 0o755 });
    const result = await run(["doctor", "--json"], {
      runDir,
      env: { DSH_BIN: bin, HUNDSUN_PUBLIC_API_KEY: "test-key" },
    });
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    const start = lines.findIndex((line) => line.startsWith("{"));
    const report = JSON.parse(lines.slice(start).join("\n"));
    expect(report.summary.fail).toBe(0);
    expect(report.checks.some((check: { id: string }) => check.id === "dsh.binary")).toBe(true);
  });

  test("doctor 缺 DSH 返回 4", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-doc-"));
    const result = await run(["doctor"], {
      runDir,
      env: { DSH_BIN: join(runDir, "missing"), HUNDSUN_PUBLIC_API_KEY: "test-key" },
    });
    expect(result.code).toBe(4);
    expect(result.out).toContain("[FAIL] dsh.binary");
  });

  test("doctor 缺凭据返回 3", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-doc-"));
    const bin = join(runDir, "fake-dsh");
    await writeFile(bin, "#!/bin/sh\necho 0.2.2-alpha.2\n", { mode: 0o755 });
    const result = await run(["doctor"], { runDir, env: { DSH_BIN: bin } });
    expect(result.code).toBe(3);
    expect(result.out).toContain("[FAIL] auth.credentials");
  });
});
