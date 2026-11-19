import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubScheduler } from "../support/stub-scheduler.ts";
import type { TaskRequest, TaskResult } from "../../src/components/executor/types.ts";
import { confirmationRequestContract, reviewConfirmationContract, reviewVerdictContract } from "../support/signal-contract.ts";

const fakeAcp = join(import.meta.dir, "../fixtures/fake-acp.mjs");
const repoRoot = join(import.meta.dir, "../..");

async function fixture() {
  const runDir = await mkdtemp(join(tmpdir(), "afc-confirm-"));
  const container = join(runDir, "workspace");
  await mkdir(container, { recursive: true });
  const resumeLog = join(runDir, "resume.log");
  const stub = new StubScheduler({ token: "stub-token" });
  await writeFile(
    join(runDir, ".config"),
    `[acp]\ndsh_home = "${join(runDir, "dsh-home")}"\npermission = "allow"\n[state]\nroot = "${join(runDir, "state")}"\n[logging]\nlevel = "info"\n[scheduler]\nurl = "${stub.url}"\ntoken = "stub-token"\n`,
  );
  const env = {
    ...process.env,
    DSH_BIN: fakeAcp,
    AF_NODE_BIN: process.execPath,
    FAKE_ACP_EMIT_SIGNAL: "1",
    FAKE_ACP_RESUME_LOG: resumeLog,
  } as Record<string, string>;
  delete (env as Record<string, string | undefined>).DSH_HOME;
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "serve", "--config", join(runDir, ".config")],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  return { runDir, container, resumeLog, stub, child };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(25);
}

function task(id: string, container: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    taskId: id,
    instanceId: "01930000-0000-7000-8000-0000000009a0",
    nodeId: "design-1",
    attempt: 1,
    prompt: "implement something",
    workspacePath: container,
    taskSpacePath: join(container, ".agent-flow", "task", id),
    timeoutMs: 30_000,
    skillSet: { digest: "sha256:d", packages: [] },
    ...overrides,
  };
}

async function stop(child: { exited: Promise<number> }, stub: StubScheduler): Promise<void> {
  stub.setStop(true);
  expect(await child.exited).toBe(0);
  stub.server.stop(true);
}

describe("§5.5 临时确认点（桩调度器 + 桩 DSH）", () => {
  test("第一次任务回传 confirmation_request + sessionId；续跑任务 resume 同一 session", async () => {
    const { runDir, container, resumeLog, stub, child } = await fixture();

    stub.enqueueTask(task("confirm-1", container, { prompt: "CONFIRM-NEEDED", resultSignal: confirmationRequestContract }));
    await waitFor(() => stub.results().length >= 1);
    const first = stub.results()[0] as TaskResult;
    expect(first.status).toBe("succeeded");
    expect(typeof first.sessionId).toBe("string");
    expect(first.signals).toHaveLength(1);
    expect(first.signals?.[0]).toMatchObject({
      kind: "confirmation_request",
      data: { question: "继续吗？" },
    });

    const sessionId = first.sessionId as string;
    stub.enqueueTask(
      task("confirm-2", container, {
        prompt: "ANSWER: pass",
        resumeSessionId: sessionId,
      }),
    );
    await waitFor(() => stub.results().length >= 2);
    const second = stub.results()[1] as TaskResult;
    expect(second.status).toBe("succeeded");
    expect(second.signals).toBeUndefined();
    expect((await readFile(resumeLog, "utf8")).trim().split("\n")).toEqual([sessionId]);

    await Bun.sleep(150);
    const log = await readFile(join(runDir, "state", "logs", "client.jsonl"), "utf8");
    const records = log
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { event: string; msg?: string });
    const started = records.find((record) => record.event === "serve.started");
    const startedDetail = JSON.parse(started?.msg ?? "{}") as Record<string, unknown>;
    expect(startedDetail.schedulerUrl).toBe(stub.url);
    expect(startedDetail.stateRoot).toBe(join(runDir, "state"));
    expect(JSON.stringify(startedDetail.signalKinds)).toContain("confirmation_request");

    const reported = records
      .filter((record) => record.event === "task.reported")
      .map((record) => JSON.parse(record.msg ?? "{}") as Record<string, unknown>);
    expect(reported).toHaveLength(2);
    expect(reported[0]?.signals).toEqual({ count: 1, kinds: ["confirmation_request"] });
    expect(reported[1]).toMatchObject({ continuation: true, resumeSessionId: sessionId });

    await stop(child, stub);
  }, 40_000);

  test("review 双契约：一个 server 挂 signal + confirm，混采回传；续跑仍挂两工具", async () => {
    const { runDir, container, resumeLog, stub, child } = await fixture();

    stub.enqueueTask(
      task("review-1", container, {
        prompt: "REVIEW",
        resultSignal: reviewVerdictContract,
        confirmation: reviewConfirmationContract,
      }),
    );
    await waitFor(() => stub.results().length >= 1);
    const first = stub.results()[0] as TaskResult;
    expect(first.status).toBe("succeeded");
    expect(first.signals?.map((signal) => signal.kind)).toEqual(["review_verdict", "confirmation_request"]);

    const configPath = join(runDir, "state", "signals", "review-1", "1", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { tools: Array<{ kind: string }> };
    expect(config.tools.map((tool) => tool.kind)).toEqual(["review_verdict", "confirmation_request"]);

    const sessionId = first.sessionId as string;
    stub.enqueueTask(
      task("review-2", container, {
        prompt: "ANSWER: pass",
        resumeSessionId: sessionId,
        resultSignal: reviewVerdictContract,
        confirmation: reviewConfirmationContract,
      }),
    );
    await waitFor(() => stub.results().length >= 2);
    const second = stub.results()[1] as TaskResult;
    expect(second.status).toBe("succeeded");
    expect(second.sessionId).toBe(sessionId);
    expect(second.signals?.map((signal) => signal.kind)).toEqual(["review_verdict", "confirmation_request"]);
    expect((await readFile(resumeLog, "utf8")).trim().split("\n")).toEqual([sessionId]);

    const resumedConfig = JSON.parse(
      await readFile(join(runDir, "state", "signals", "review-2", "1", "config.json"), "utf8"),
    ) as { tools: Array<{ kind: string }> };
    expect(resumedConfig.tools.map((tool) => tool.kind)).toEqual(["review_verdict", "confirmation_request"]);

    await Bun.sleep(150);
    const log = await readFile(join(runDir, "state", "logs", "client.jsonl"), "utf8");
    const reported = log
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { event: string; msg?: string })
      .filter((record) => record.event === "task.reported")
      .map((record) => JSON.parse(record.msg ?? "{}") as Record<string, unknown>);
    expect(reported[0]?.signals).toEqual({ count: 2, kinds: ["review_verdict", "confirmation_request"] });

    await stop(child, stub);
  }, 40_000);
});
