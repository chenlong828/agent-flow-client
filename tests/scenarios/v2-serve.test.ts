import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digestDirectory } from "../../src/components/assets/digest.ts";
import { StubScheduler } from "../support/stub-scheduler.ts";
import type { SkillSet, TaskRequest } from "../../src/components/executor/types.ts";

const fakeAcp = join(import.meta.dir, "../fixtures/fake-acp.mjs");
const repoRoot = join(import.meta.dir, "../..");

async function packageFor(name: string): Promise<SkillSet> {
  const dir = await mkdtemp(join(tmpdir(), `afc-v2-${name}-`));
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  const digest = await digestDirectory(dir);
  return {
    digest,
    packages: [{ packageId: `p-${name}`, name, version: "1", digest, sizeBytes: 0, downloadUrl: pathToFileURL(dir).href }],
  };
}

function task(id: string, prompt: string, container: string, skillSet: SkillSet): TaskRequest {
  return {
    taskId: id,
    instanceId: "01930000-0000-7000-8000-000000000601",
    nodeId: `n-${id}`,
    attempt: 1,
    prompt,
    workspacePath: container,
    timeoutMs: 30_000,
    skillSet,
  };
}

async function fixture(options: { tasks: number } = { tasks: 1 }) {
  const runDir = await mkdtemp(join(tmpdir(), "afc-v2-serve-"));
  const container = join(runDir, "workspace");
  const procLog = join(runDir, "acp-procs.log");
  await mkdir(join(container, "repo-a"), { recursive: true });
  await writeFile(join(container, "repo-a", "artifact.txt"), "from-node-1\n");
  const skill = await packageFor("alpha");
  const stub = new StubScheduler({ token: "stub-token" });
  await writeFile(
    join(runDir, ".config"),
    `[acp]\ndsh_home = "${join(runDir, "dsh-home")}"\npermission = "allow"\n[state]\nroot = "${join(runDir, "state")}"\n[logging]\nlevel = "error"\n[capacity]\nmax_concurrent = 4\n[scheduler]\nurl = "${stub.url}"\ntoken = "stub-token"\n`,
  );
  const tasks = Array.from({ length: options.tasks }, (_, index) =>
    task(`01930000-0000-7000-8000-00000000070${index}`, `NODE-${index + 1}`, container, skill),
  );
  for (const item of tasks) stub.enqueueTask(item);
  const env = { ...process.env, DSH_BIN: fakeAcp, AF_NODE_BIN: process.execPath, HUNDSUN_PUBLIC_API_KEY: "k", FAKE_ACP_PROC_LOG: procLog } as Record<string, string>;
  delete (env as Record<string, string | undefined>).DSH_HOME;
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "serve", "--config", join(runDir, ".config"), "--state-root", join(runDir, "state")],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  return { runDir, container, procLog, stub, tasks, child };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(25);
}

describe("v2 serve：poll 单循环", () => {
  test("TC-EXEC-002 并发两任务：同一 DSH 进程、各自结果、running 如实上报", async () => {
    const { container, procLog, stub, child } = await fixture({ tasks: 2 });
    await waitFor(() => stub.results().length >= 2);
    expect(stub.results().map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
    const poll = stub.requests.find((request) => request.path.endsWith("/poll") && Array.isArray(request.body.running) && (request.body.running as unknown[]).length === 2);
    expect((poll?.body.running as { taskId: string }[]).map((item) => item.taskId).sort()).toEqual(
      ["01930000-0000-7000-8000-000000000700", "01930000-0000-7000-8000-000000000701"],
    );
    expect(await readFile(join(container, "repo-a", "artifact.txt"), "utf8")).toBe("from-node-1\n");
    expect((await readFile(procLog, "utf8")).trim().split("\n")).toHaveLength(1);

    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 40_000);

  test("stop=true：跑完手上任务后退出 0", async () => {
    const { stub, child } = await fixture({ tasks: 1 });
    await waitFor(() => stub.results().length >= 1);
    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 30_000);

  test("cancelInstances：中止并上报 cancelled", async () => {
    const { stub, child, tasks } = await fixture({ tasks: 1 });
    const slow = { ...tasks[0]!, taskId: "01930000-0000-7000-8000-000000000799", prompt: "SLOW", timeoutMs: 30_000 };
    stub.enqueueTask(slow);
    await waitFor(() => stub.results().length >= 1);
    await waitFor(() => stub.requests.some((request) => Array.isArray(request.body.running) && (request.body.running as unknown[]).length > 0));
    stub.cancelInstance(slow.instanceId);
    await waitFor(() => stub.results().some((result) => result.status === "cancelled"));
    expect(stub.results().find((result) => result.taskId === slow.taskId)?.status).toBe("cancelled");
    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 40_000);

  test("结果上报失败时，poll 的 finished[] 携带未确认任务", async () => {
    const { stub, child, tasks } = await fixture({ tasks: 1 });
    stub.failNext(`POST /api/v1/executor/tasks/${tasks[0]!.taskId}/result`, { status: 503, code: "service_unavailable", times: 3 });
    await waitFor(() =>
      stub.requests.some(
        (request) => request.path.endsWith("/poll") && Array.isArray(request.body.finished) && (request.body.finished as unknown[]).length > 0,
      ),
    );
    const poll = stub.requests.find((request) => Array.isArray(request.body.finished) && (request.body.finished as unknown[]).length > 0);
    expect((poll?.body.finished as { taskId: string }[])[0]?.taskId).toBe(tasks[0]!.taskId);
    await waitFor(() => stub.results().length >= 1);
    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 40_000);

  test("鉴权失败退出 3", async () => {
    const { stub, child } = await fixture({ tasks: 0 });
    stub.server.stop(true);
    const wrong = new StubScheduler({ token: "expected" });
    const runDir = await mkdtemp(join(tmpdir(), "afc-v2-auth-"));
    await writeFile(
      join(runDir, ".config"),
      `[acp]\ndsh_home = "${join(runDir, "dsh-home")}"\npermission = "allow"\n[state]\nroot = "${join(runDir, "state")}"\n[logging]\nlevel = "error"\n[scheduler]\nurl = "${wrong.url}"\ntoken = "wrong"\n`,
    );
    const env = { ...process.env, DSH_BIN: fakeAcp, AF_NODE_BIN: process.execPath, HUNDSUN_PUBLIC_API_KEY: "k" } as Record<string, string>;
    delete (env as Record<string, string | undefined>).DSH_HOME;
    const authChild = Bun.spawn(
      [process.execPath, "src/cli.ts", "serve", "--config", join(runDir, ".config"), "--state-root", join(runDir, "state")],
      { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await authChild.exited).toBe(3);
    wrong.server.stop(true);
    void child;
  }, 30_000);
});

describe("v2 恢复", () => {
  test("启动时 journal 中 settled 结果补报", async () => {
    const { FileStore } = await import("../../src/components/store/store.ts");
    const runDir = await mkdtemp(join(tmpdir(), "afc-v2-recover-"));
    const container = join(runDir, "workspace");
    await mkdir(container, { recursive: true });
    const stub = new StubScheduler({ token: "stub-token" });
    await writeFile(
      join(runDir, ".config"),
      `[acp]\ndsh_home = "${join(runDir, "dsh-home")}"\npermission = "allow"\n[state]\nroot = "${join(runDir, "state")}"\n[logging]\nlevel = "error"\n[scheduler]\nurl = "${stub.url}"\ntoken = "stub-token"\n`,
    );
    const store = new FileStore({ stateRoot: join(runDir, "state") });
    await store.init();
    const taskId = "01930000-0000-7000-8000-000000000801";
    await store.append({
      v: 2,
      ts: "2026-11-10T00:00:00.000Z",
      taskId,
      attempt: 1,
      instanceId: "01930000-0000-7000-8000-000000000802",
      nodeId: "n",
      state: "settled",
      result: {
        taskId,
        attempt: 1,
        status: "succeeded",
        message: "RECOVERED",
        truncated: false,
        stopReason: "end_turn",
        usage: null,
        error: null,
      },
    });
    const env = { ...process.env, DSH_BIN: fakeAcp, AF_NODE_BIN: process.execPath, HUNDSUN_PUBLIC_API_KEY: "k" } as Record<string, string>;
    delete (env as Record<string, string | undefined>).DSH_HOME;
    const child = Bun.spawn(
      [process.execPath, "src/cli.ts", "serve", "--config", join(runDir, ".config"), "--state-root", join(runDir, "state")],
      { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
    );
    await waitFor(() => stub.results().some((result) => result.taskId === taskId));
    expect(stub.results().find((result) => result.taskId === taskId)?.message).toBe("RECOVERED");
    stub.setStop(true);
    expect(await child.exited).toBe(0);
    stub.server.stop(true);
  }, 30_000);
});
