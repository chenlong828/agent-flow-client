import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubScheduler } from "../support/stub-scheduler.ts";
import type { TaskRequest } from "../../src/components/executor/types.ts";

const fakeAcp = join(import.meta.dir, "../fixtures/fake-acp.mjs");
const repoRoot = join(import.meta.dir, "../..");

function task(id: string, prompt: string, container: string): TaskRequest {
  return {
    taskId: id,
    instanceId: "01930000-0000-7000-8000-000000000801",
    nodeId: `n-${id}`,
    attempt: 1,
    prompt,
    workspacePath: container,
    taskSpacePath: join(container, ".agent-flow", "task", id),
    timeoutMs: 30_000,
    skillSet: { digest: "sha256:empty", packages: [] },
  };
}

async function fixture(options: { workspace?: boolean; protocol?: string; sessionLogLimit?: number } = {}) {
  const runDir = await mkdtemp(join(tmpdir(), "afc-v3-serve-"));
  const container = join(runDir, "workspace");
  if (options.workspace !== false) await mkdir(container, { recursive: true });
  const stub = new StubScheduler({ token: "stub-token" });
  stub.setProtocol(options.protocol ?? "3");
  if (options.sessionLogLimit !== undefined) stub.setSessionLogLimit(options.sessionLogLimit);
  await writeFile(
    join(runDir, ".config"),
    `[acp]\ndsh_home = "${join(runDir, "dsh-home")}"\npermission = "allow"\n[state]\nroot = "${join(runDir, "state")}"\n[logging]\nlevel = "error"\n[capacity]\nmax_concurrent = 2\n[scheduler]\nurl = "${stub.url}"\ntoken = "stub-token"\n`,
  );
  const item = task("01930000-0000-7000-8000-000000000811", "NODE-V3", container);
  stub.enqueueTask(item);
  const env = { ...process.env, DSH_BIN: fakeAcp, AF_NODE_BIN: process.execPath, HUNDSUN_PUBLIC_API_KEY: "k" } as Record<string, string>;
  delete (env as Record<string, string | undefined>).DSH_HOME;
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "serve", "--config", join(runDir, ".config"), "--state-root", join(runDir, "state")],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  return { runDir, container, stub, task: item, child };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
}

describe("v3 serve：task-space / 日志 / 归档", () => {
  test("正常任务：建 task-space（不写内容）、日志先于结果", async () => {
    const { container, stub, task, child } = await fixture();
    await waitFor(() => stub.results().length >= 1);
    const result = stub.results()[0]!;
    expect(result.status).toBe("succeeded");
    const space = task.taskSpacePath;
    expect(existsSync(space)).toBe(true);
    expect(existsSync(join(space, "intent.md"))).toBe(false);
    expect(stub.sessionLog(task.taskId, 1)).not.toBeNull();
    const poll = stub.requests.find((request) => request.path.endsWith("/poll"));
    expect(poll?.headers["x-executor-protocol"]).toBe("3");
    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 40_000);

  test("早失败（工作区不存在）：上传 0 行空日志后仍可结算", async () => {
    const { stub, task, child } = await fixture({ workspace: false });
    await waitFor(() => stub.results().length >= 1);
    const result = stub.results()[0]!;
    expect(result.status).toBe("failed");
    expect(result.error?.class).toBe("workspace");
    expect(stub.sessionLog(task.taskId, 1)).not.toBeNull();
    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 40_000);

  test("日志 413：传空日志并报 failed(session_log_too_large)", async () => {
    const { stub, task, child } = await fixture({ sessionLogLimit: 100 });
    await waitFor(() => stub.results().length >= 1);
    const result = stub.results()[0]!;
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "session_log_too_large", class: "runtime" });
    expect(stub.sessionLog(task.taskId, 1)).not.toBeNull();
    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 40_000);

  test("归档：后台打包上传，下一轮 poll 回报 archivedRuns，本地目录保留", async () => {
    const { container, stub, task, child } = await fixture();
    await waitFor(() => stub.results().length >= 1);
    const runId = "01930000-0000-7000-8000-000000000899";
    const space = join(container, ".agent-flow", "task", runId);
    await mkdir(space, { recursive: true });
    await writeFile(join(space, "note.md"), "evidence\n");
    stub.requestArchive({ runId, instanceId: task.instanceId, workspacePath: container, taskSpacePath: space });
    await waitFor(() => stub.archive(runId) !== null);
    expect(stub.archive(runId)).not.toBeNull();
    await waitFor(() => stub.requests.some((request) => Array.isArray(request.body.archivedRuns) && (request.body.archivedRuns as string[]).includes(runId)));
    const confirm = stub.requests.find((request) => Array.isArray(request.body.archivedRuns) && (request.body.archivedRuns as string[]).includes(runId));
    expect(confirm?.body.archivedRuns).toContain(runId);
    expect(existsSync(space)).toBe(true);
    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 40_000);

  test("协议 2：被 400 拒绝并以 3 退出", async () => {
    const { stub, child } = await fixture({ protocol: "2" });
    expect(await child.exited).toBe(3);
    stub.server.stop(true);
  }, 30_000);
});
