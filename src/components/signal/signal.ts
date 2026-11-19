import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  SIGNAL_CONTRACT_VERSION,
  SIGNAL_LIMITS,
  isSupportedContract,
  type ResultSignalContract,
  type TaskSignal,
} from "./contract.ts";
import type { SignalPlan, SignalServerConfig } from "./plan.ts";
import { collectSignals } from "./collect.ts";
import { attemptDir, cleanupSignals, ensureAttemptDir, outputPathOf, writeServerConfig } from "./directory.ts";
import { signalMcpServers } from "./mcp.ts";

export type SignalErrorCode = "signal_prepare_failed" | "signal_invalid";

export class SignalError extends Error {
  readonly code: SignalErrorCode;

  constructor(code: SignalErrorCode, message: string) {
    super(message);
    this.name = "SignalError";
    this.code = code;
  }
}

export type SignalPrepareResult = { status: "ok"; plan: SignalPlan } | { status: "unsupported"; reason: string };

export type SignalComponentOptions = {
  stateRoot: string;
  /** 预检/挂载共用的 server 入口（绝对路径）。 */
  serverEntry?: string;
  /** 启动 server 的解释器；默认当前进程（Bun）。 */
  execPath?: string;
  checkTimeoutMs?: number;
  /** 预检启动的环境；默认继承 `process.env`。 */
  env?: Record<string, string | undefined>;
};

/** 默认入口：仓库内 `src/mcp/signal-server.ts`（随 Bun 直接执行，无需构建）。 */
export function defaultSignalServerEntry(): string {
  return resolve(import.meta.dir, "../../mcp/signal-server.ts");
}

/**
 * `CMP-signal`（L0）：per-attempt 信号目录、config、server 预检、采集与清理。
 * 只碰文件与自身子进程；不解析 run 语义、不决定结果（proposal §4.1）。
 */
export class FileSignal {
  readonly #options: Required<Pick<SignalComponentOptions, "stateRoot">> & SignalComponentOptions;
  readonly #serverEntry: string;
  readonly #execPath: string;
  readonly #checkTimeoutMs: number;

  constructor(options: SignalComponentOptions) {
    this.#options = options;
    this.#serverEntry = options.serverEntry ?? defaultSignalServerEntry();
    this.#execPath = options.execPath ?? process.execPath;
    this.#checkTimeoutMs = options.checkTimeoutMs ?? 5000;
  }

  get serverEntry(): string {
    return this.#serverEntry;
  }

  /**
   * 建目录、写 config、`--check` 预检；不支持契约时明确返回 unsupported（不挂 MCP，不判失败）。
   * 文件或预检失败抛 `signal_prepare_failed`（由 executor 归为任务失败）。
   */
  async prepare(input: { taskId: string; attempt: number; contract: ResultSignalContract }): Promise<SignalPrepareResult> {
    const { contract } = input;
    if (!isSupportedContract(contract)) {
      return { status: "unsupported", reason: `不支持 version=${contract.version} kind=${contract.kind}` };
    }
    const dir = attemptDir(this.#options.stateRoot, input.taskId, input.attempt);
    try {
      await ensureAttemptDir(dir);
      const config: SignalServerConfig = {
        version: SIGNAL_CONTRACT_VERSION,
        kind: contract.kind,
        taskId: input.taskId,
        attempt: input.attempt,
        output: outputPathOf(dir),
        schema: contract.schema,
        limits: { maxSignals: SIGNAL_LIMITS.maxCount, maxBytes: SIGNAL_LIMITS.maxBytes },
      };
      const configPath = await writeServerConfig(dir, config);
      await this.#check(configPath);
      return {
        status: "ok",
        plan: {
          taskId: input.taskId,
          attempt: input.attempt,
          kind: contract.kind,
          dir,
          configPath,
          outputPath: outputPathOf(dir),
          mcpServers: signalMcpServers({ execPath: this.#execPath, entryPath: this.#serverEntry, configPath }),
        },
      };
    } catch (error) {
      throw new SignalError("signal_prepare_failed", `信号准备失败：${(error as Error).message}`);
    }
  }

  /** 采集当前 attempt 的信号；损坏行忽略，整体异常抛 `signal_invalid`（由 executor 吞掉）。 */
  async collect(input: {
    taskId: string;
    attempt: number;
    contract: ResultSignalContract;
    plan: SignalPlan;
  }): Promise<TaskSignal[] | undefined> {
    try {
      const collected = await collectSignals(input.contract, input.plan.outputPath);
      return collected.signals.length === 0 ? undefined : collected.signals;
    } catch (error) {
      throw new SignalError("signal_invalid", `信号采集失败：${(error as Error).message}`);
    }
  }

  /** 清理超过保留期的 attempt 目录（启动与 doctor 用）。 */
  async cleanup(retentionDays: number): Promise<number> {
    return await cleanupSignals(this.#options.stateRoot, retentionDays);
  }

  async #check(configPath: string): Promise<void> {
    await new Promise<void>((done, fail) => {
      const child = spawn(this.#execPath, [this.#serverEntry, "--check"], {
        env: { ...(this.#options.env ?? process.env), AF_SIGNAL_CONFIG: configPath } as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new Error(`预检超时（${this.#checkTimeoutMs}ms）`));
      }, this.#checkTimeoutMs);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) done();
        else fail(new Error(`预检退出码 ${String(code)}${stderr.trim() === "" ? "" : `：${stderr.trim()}`}`));
      });
    });
  }
}
