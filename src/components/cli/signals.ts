import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import type { CliIo } from "./main.ts";
import { ExitCode } from "./exit-codes.ts";
import { FileStore } from "../store/store.ts";
import { collectSignals } from "../signal/collect.ts";
import {
  configPathOf,
  outputPathOf,
  readServerConfig,
  signalRoot,
  taskDirName,
} from "../signal/directory.ts";
import type { ResultSignalContract, TaskSignal } from "../signal/contract.ts";

export type SignalsOptions = {
  taskId: string;
  attempt?: number;
  json: boolean;
};

const REASON_PREVIEW = 120;

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length > REASON_PREVIEW ? `${text.slice(0, REASON_PREVIEW)}…` : text;
}

function summarize(signal: TaskSignal): string {
  const data = signal.data;
  const verdict = typeof data.verdict === "string" ? data.verdict : undefined;
  const question = typeof data.question === "string" ? data.question : undefined;
  const extra = Array.isArray(data.evidence) ? `（evidence ${data.evidence.length} 项）` : "";
  if (verdict !== undefined) return `${signal.seq}  ${signal.kind}  ${verdict}  ${preview(data.reason)}${extra}`;
  if (question !== undefined) return `${signal.seq}  ${signal.kind}  ${preview(question)}`;
  return `${signal.seq}  ${signal.kind}  ${preview(data)}`;
}

async function attemptsOf(dir: string): Promise<number[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);
}

/** 选 attempt：缺省取最新；显式指定的必须存在。 */
function pickAttempt(attempts: number[], requested: number | undefined, io: CliIo): number | null {
  if (requested === undefined) return attempts.at(-1) as number;
  if (attempts.includes(requested)) return requested;
  io.err(`尝试 ${requested} 没有信号目录；已有：${attempts.join(", ")}`);
  return null;
}

type SignalsPayload = {
  taskId: string;
  attempt: number;
  kind: string;
  dir: string;
  sessionId: string | null;
  resultStatus: string | null;
  state: string | null;
  signals: TaskSignal[];
  invalid: number;
};

function renderText(payload: SignalsPayload, io: CliIo): void {
  io.out(`task ${payload.taskId}  attempt ${payload.attempt}  kind ${payload.kind}`);
  io.out(`dir ${payload.dir}`);
  io.out(`session ${payload.sessionId ?? "-"}  result ${payload.resultStatus ?? "-"}  state ${payload.state ?? "-"}`);
  io.out(`signals ${payload.signals.length} 条合法，${payload.invalid} 行被忽略`);
  for (const signal of payload.signals) io.out(`  ${summarize(signal)}`);
}

/** `signals --task <id> [--attempt n] [--json]`：只读，看某任务当前 attempt 的结构化信号。 */
export async function signalsCommand(config: AppConfig, io: CliIo, options: SignalsOptions): Promise<number> {
  const dir = join(signalRoot(config.state.root), taskDirName(options.taskId));
  const attempts = await attemptsOf(dir);
  if (attempts.length === 0) {
    io.err(`没有该任务的信号目录：${dir}`);
    return ExitCode.nodeFailed;
  }
  const attempt = pickAttempt(attempts, options.attempt, io);
  if (attempt === null) return ExitCode.nodeFailed;
  const attemptDir = join(dir, String(attempt));
  const serverConfig = await readServerConfig(configPathOf(attemptDir)).catch((error: Error) => {
    io.err(`读取信号配置失败：${error.message}`);
    return null;
  });
  if (serverConfig === null) return ExitCode.nodeFailed;
  const contract: ResultSignalContract = {
    version: serverConfig.version,
    kind: serverConfig.kind,
    required: true,
    schema: serverConfig.schema,
  };
  const collected = await collectSignals(contract, outputPathOf(attemptDir)).catch((error: Error) => {
    io.err(`读取信号失败：${error.message}`);
    return null;
  });
  if (collected === null) return ExitCode.nodeFailed;

  const store = new FileStore({ stateRoot: config.state.root });
  const record = await store.findLatest(options.taskId).catch(() => undefined);
  const payload: SignalsPayload = {
    taskId: options.taskId,
    attempt,
    kind: serverConfig.kind,
    dir: attemptDir,
    sessionId: record?.sessionId ?? record?.result?.sessionId ?? null,
    resultStatus: record?.result?.status ?? null,
    state: record?.state ?? null,
    signals: collected.signals,
    invalid: collected.invalid,
  };
  if (options.json) io.out(JSON.stringify(payload, null, 2));
  else renderText(payload, io);
  return ExitCode.ok;
}
