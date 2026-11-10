import { createHash } from "node:crypto";
import type { SchedulerPort, PackageDownload } from "../executor/scheduler-port.ts";
import type {
  PollRequest,
  PollResponse,
  ResultAck,
  SkillPackage,
  TaskRequest,
  TaskResult,
} from "../executor/types.ts";
import { GatewayError } from "./errors.ts";
import { HttpTransport } from "./transport.ts";
import { withRetry, type RetryOptions } from "./retry.ts";
import { parsePollResponse, parseResultAck, serializePollRequest } from "./wire.ts";

export type GatewayOptions = {
  transport: HttpTransport;
  pollTimeoutMs?: number;
  retry?: RetryOptions;
  audit?: (event: string, detail?: Record<string, unknown>) => void;
};

const POLL_TIMEOUT_MS = 40_000;
const RESULT_TIMEOUT_MS = 30_000;
const PACKAGE_TIMEOUT_MS = 60_000;

/** 调度器 HTTP 防腐层（CMP-gateway，v2）：poll / result / skill-packages。 */
export class HttpScheduler implements SchedulerPort {
  readonly #transport: HttpTransport;
  readonly #options: GatewayOptions;
  readonly #pollTimeoutMs: number;

  constructor(options: GatewayOptions) {
    this.#options = options;
    this.#transport = options.transport;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  }

  async poll(request: PollRequest): Promise<PollResponse> {
    const result = await this.#transport.post("/poll", serializePollRequest(request), this.#pollTimeoutMs);
    return parsePollResponse(result.body);
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
}

/** `run` 兼容：把本地任务包装成只返回一次的任务。 */
export function nextPollAfterMsOf(response: PollResponse): number {
  return Math.max(0, response.nextPollAfterMs);
}

export type { TaskRequest };
