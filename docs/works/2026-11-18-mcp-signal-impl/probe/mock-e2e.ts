// 联调 smoke：桩调度器 → client serve → 真实 DSH → mcp__agentflow__signal → P-02.signals
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubScheduler } from "../tests/support/stub-scheduler.ts";
import { reviewVerdictContract } from "../tests/support/signal-contract.ts";

const repo = join(import.meta.dir, "..");
const base = await mkdtemp(join(tmpdir(), "afc-mock-e2e-"));
const ws = join(base, "ws");
await mkdir(ws, { recursive: true });
const state = join(base, "state");
const dshHome = join(base, "dsh-home");
const stub = new StubScheduler({ token: "dev-token", pollHoldMs: 1000 });
const taskId = "0193e2e0-0000-7000-8000-0000000000aa";
const task = {
  taskId,
  instanceId: "0193e2e0-0000-7000-8000-0000000000bb",
  nodeId: "review-mock",
  attempt: 1,
  prompt: "请调用 MCP 工具 mcp__agentflow__signal：kind=review_verdict、verdict=pass、reason=mock-e2e。调用完成后只输出 DONE。",
  workspacePath: ws,
  taskSpacePath: join(ws, ".agent-flow", "task", taskId),
  timeoutMs: 180000,
  skillSet: { digest: "sha256:mock", packages: [] },
  resultSignal: reviewVerdictContract,
};
await writeFile(
  join(base, ".config"),
  `[acp]\ndsh_home = "${dshHome}"\npermission = "allow"\n[state]\nroot = "${state}"\n[logging]\nlevel = "info"\n[scheduler]\nurl = "${stub.url}"\ntoken = "dev-token"\n`,
);
const env = { ...process.env } as Record<string, string>;
delete env.DSH_HOME;
const child = Bun.spawn(
  [process.execPath, "src/cli.ts", "serve", "--config", join(base, ".config")],
  { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
);
stub.enqueueTask(task);
const deadline = Date.now() + 240_000;
while (stub.results().length === 0 && Date.now() < deadline) await Bun.sleep(100);
const result = stub.results()[0];
console.log(JSON.stringify({ status: result?.status ?? null, error: result?.error ?? null, signals: result?.signals ?? null }, null, 2));
stub.setStop(true);
const code = await child.exited;
console.log(`serve-exit=${code}`);
stub.server.stop(true);
await child.kill();
process.exit(0);
