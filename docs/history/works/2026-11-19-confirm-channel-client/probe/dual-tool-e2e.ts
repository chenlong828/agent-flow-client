// 联调 smoke：桩调度器 → client serve → 真实 DSH → review 双工具（signal + confirm）
// 只用于本工序验证：不写仓库、只在临时目录里跑一条任务。
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubScheduler } from "../../../../../tests/support/stub-scheduler.ts";
import { reviewConfirmationContract, reviewVerdictContract } from "../../../../../tests/support/signal-contract.ts";

const repo = join(import.meta.dir, "../../../../..");
const base = await mkdtemp(join(tmpdir(), "afc-confirm-e2e-"));
const ws = join(base, "ws");
await mkdir(ws, { recursive: true });
const state = join(base, "state");
const stub = new StubScheduler({ token: "dev-token", pollHoldMs: 1000 });
const taskId = "0193e2e0-0000-7000-8000-0000000000c1";
const task = {
  taskId,
  instanceId: "0193e2e0-0000-7000-8000-0000000000c2",
  nodeId: "review-confirm-e2e",
  attempt: 1,
  prompt:
    "你是评审节点。请先后调用两个 MCP 工具：先调 mcp__agentflow__confirm（kind=confirmation_request、" +
    "question=是否接受当前实现？、options=[接受, 拒绝]）；再调 mcp__agentflow__signal" +
    "（kind=review_verdict、verdict=pass、reason=confirm-e2e）。两次调用完成后只输出 DONE。",
  workspacePath: ws,
  taskSpacePath: join(ws, ".agent-flow", "task", taskId),
  timeoutMs: 180000,
  skillSet: { digest: "sha256:mock", packages: [] },
  resultSignal: reviewVerdictContract,
  confirmation: reviewConfirmationContract,
};
await writeFile(
  join(base, ".config"),
  `[acp]\ndsh_home = "${join(base, "dsh-home")}"\npermission = "allow"\n[state]\nroot = "${state}"\n[logging]\nlevel = "info"\n[scheduler]\nurl = "${stub.url}"\ntoken = "dev-token"\n`,
);
const env = { ...process.env } as Record<string, string>;
delete env.DSH_HOME;
const child = Bun.spawn([process.execPath, "src/cli.ts", "serve", "--config", join(base, ".config")], {
  cwd: repo,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
stub.enqueueTask(task);
const deadline = Date.now() + 240_000;
while (stub.results().length === 0 && Date.now() < deadline) await Bun.sleep(100);
const result = stub.results()[0];
const config = await readFile(join(state, "signals", taskId, "1", "config.json"), "utf8").catch(() => null);
console.log(
  JSON.stringify(
    {
      status: result?.status ?? null,
      error: result?.error ?? null,
      sessionId: result?.sessionId ?? null,
      signals: result?.signals ?? null,
      tools: config === null ? null : (JSON.parse(config) as { tools?: Array<{ kind: string }> }).tools?.map((tool) => tool.kind),
    },
    null,
    2,
  ),
);
stub.setStop(true);
console.log(`serve-exit=${await child.exited}`);
stub.server.stop(true);
await child.kill();
process.exit(0);
