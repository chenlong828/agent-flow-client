import { createHash } from "node:crypto";
import type { SchedulerPort, PackageDownload } from "../executor/scheduler-port.ts";
import type { RunInputPort } from "../executor/ports.ts";
import type {
  ArchiveAck,
  ExecutorRunInput,
  PollRequest,
  PollResponse,
  ResultAck,
  SessionLogAck,
  SkillPackage,
  TaskRequest,
  TaskResult,
} from "../executor/types.ts";
import { GatewayError } from "./errors.ts";
import { HttpTransport } from "./transport.ts";
import { withRetry, type RetryOptions } from "./retry.ts";
import { assertInputDownloadPath, parseRunInputs } from "./run-input-wire.ts";
import { parseArchiveAck, parsePollResponse, parseResultAck, parseSessionLogAck, serializePollRequest } from "./wire.ts";

export type GatewayOptions = {
  transport: HttpTransport;
  pollTimeoutMs?: number;
  retry?: RetryOptions;
  audit?: (event: string, detail?: Record<string, unknown>) => void;
};

const POLL_TIMEOUT_MS = 40_000;
const RESULT_TIMEOUT_MS = 30_000;
const PACKAGE_TIMEOUT_MS = 60_000;
const SESSION_LOG_TIMEOUT_MS = 120_000;
const ARCHIVE_TIMEOUT_MS = 300_000;
const RUN_INPUT_TIMEOUT_MS = 120_000;
/** `EXE-01` 能力声明：只随 poll 发送，服务端据此判断可派发带初始资料的 run。 */
const CAPABILITIES: Record<string, string> = { "X-Executor-Capabilities": "run-inputs" };

/** 调度器 HTTP 防腐层（CMP-gateway，v2）：poll / result / skill-packages。 */
export class HttpScheduler implements SchedulerPort, RunInputPort {
  readonly #transport: HttpTransport;
  readonly #options: GatewayOptions;
  readonly #pollTimeoutMs: number;

  constructor(options: GatewayOptions) {
    this.#options = options;
    this.#transport = options.transport;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  }

  async poll(request: PollRequest): Promise<PollResponse> {
    const result = await this.#transport.post("/poll", serializePollRequest(request), this.#pollTimeoutMs, CAPABILITIES);
    return parsePollResponse(result.body);
  }

  async listRunInputs(runId: string): Promise<ExecutorRunInput[]> {
    try {
      const response = await withRetry(
        async () => await this.#transport.get(`/runs/${encodeURIComponent(runId)}/inputs`, RUN_INPUT_TIMEOUT_MS),
        this.#options.retry,
      );
      return parseRunInputs(response.body, runId);
    } catch (error) {
      // 旧服务端没有该端点（404）：按「无初始资料」继续；run 不存在时仍是失败。
      if (error instanceof GatewayError && error.status === 404 && error.code !== "run_not_found") {
        this.#options.audit?.("run_inputs.unavailable", { runId });
        return [];
      }
      throw error;
    }
  }

  async downloadRunInput(ref: ExecutorRunInput): Promise<Uint8Array> {
    assertInputDownloadPath(ref.downloadPath, { inputId: ref.inputId });
    const response = await withRetry(
      async () => await this.#transport.getBytes(ref.downloadPath, RUN_INPUT_TIMEOUT_MS),
      this.#options.retry,
    );
    if (response.bytes === null) throw new GatewayError("protocol_error", "初始资料响应为空");
    return response.bytes;
  }

  async reportResult(result: TaskResult): Promise<ResultAck> {
    try {
      const response = await withRetry(
        async () => await this.#transport.post(`/tasks/${encodeURIComponent(result.taskId)}/result`, result, RESULT_TIMEOUT_MS),
        this.#options.retry,
      );
      return parseResultAck(response.body);
    } catch (error) {
      if (error instanceof GatewayError && error.code === "task_not_found") {
        this.#options.audit?.("result.task_not_found", { taskId: result.taskId });
        return { taskId: result.taskId, accepted: false };
      }
      throw error;
    }
  }

  async downloadPackage(pkg: SkillPackage): Promise<PackageDownload> {
    const path = `/skill-packages/${encodeURIComponent(pkg.packageId)}`;
    const result = await withRetry(
      async () =>
        await this.#transport.getBytes(path, PACKAGE_TIMEOUT_MS, {
          ...(pkg.etag === undefined ? {} : { "If-None-Match": pkg.etag }),
        }),
      this.#options.retry,
    );
    if (result.status === 304) return { notModified: true };
    if (result.bytes === null) throw new GatewayError("protocol_error", "技能包响应为空");
    const sha256 = createHash("sha256").update(result.bytes).digest("hex");
    return { bytes: result.bytes, notModified: false, sha256 };
  }

  async uploadSessionLog(input: { taskId: string; attempt: number; payload: Uint8Array }): Promise<SessionLogAck> {
    const path = `/tasks/${encodeURIComponent(input.taskId)}/session-log?attempt=${input.attempt}`;
    const response = await withRetry(
      async () =>
        await this.#transport.postBytes(path, input.payload, SESSION_LOG_TIMEOUT_MS, {
          "Content-Type": "application/x-ndjson",
          "Content-Encoding": "gzip",
        }),
      this.#options.retry,
    );
    return parseSessionLogAck(response.body);
  }

  async uploadArchive(input: { runId: string; payload: Uint8Array }): Promise<ArchiveAck> {
    const path = `/runs/${encodeURIComponent(input.runId)}/archive`;
    const response = await withRetry(
      async () =>
        await this.#transport.postBytes(path, input.payload, ARCHIVE_TIMEOUT_MS, {
          "Content-Type": "application/gzip",
        }),
      this.#options.retry,
    );
    return parseArchiveAck(response.body);
  }
}

/** `run` 兼容：把本地任务包装成只返回一次的任务。 */
export function nextPollAfterMsOf(response: PollResponse): number {
  return Math.max(0, response.nextPollAfterMs);
}

export type { TaskRequest };
