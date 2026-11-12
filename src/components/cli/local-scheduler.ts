import type { PackageDownload, SchedulerPort } from "../executor/scheduler-port.ts";
import type {
  ArchiveAck,
  PollRequest,
  PollResponse,
  ResultAck,
  SessionLogAck,
  SkillPackage,
  TaskRequest,
  TaskResult,
} from "../executor/types.ts";
import { createHash } from "node:crypto";

/** `run` 的本地调度器替身：只发一次任务，结果只捕获不外发。 */
export class LocalScheduler implements SchedulerPort {
  readonly #task: TaskRequest;
  #dispatched = false;
  #result: TaskResult | null = null;

  constructor(task: TaskRequest) {
    this.#task = task;
  }

  get result(): TaskResult | null {
    return this.#result;
  }

  async poll(request: PollRequest): Promise<PollResponse> {
    void request;
    if (this.#dispatched) return { tasks: [], stop: false, cancelInstances: [], archiveRequests: [], nextPollAfterMs: 0 };
    this.#dispatched = true;
    return { tasks: [this.#task], stop: false, cancelInstances: [], archiveRequests: [], nextPollAfterMs: 0 };
  }

  async reportResult(result: TaskResult): Promise<ResultAck> {
    this.#result = result;
    return { taskId: result.taskId, accepted: true };
  }

  async downloadPackage(_pkg: SkillPackage): Promise<PackageDownload> {
    throw new Error("run 模式不支持远程技能包；使用 file:// 或本地目录");
  }

  async uploadSessionLog(input: { taskId: string; attempt: number; payload: Uint8Array }): Promise<SessionLogAck> {
    return {
      taskId: input.taskId,
      attempt: input.attempt,
      bytes: input.payload.byteLength,
      sha256: createHash("sha256").update(input.payload).digest("hex"),
      stored: "created",
    };
  }

  async uploadArchive(input: { runId: string; payload: Uint8Array }): Promise<ArchiveAck> {
    return {
      runId: input.runId,
      bytes: input.payload.byteLength,
      sha256: createHash("sha256").update(input.payload).digest("hex"),
      stored: "created",
    };
  }
}
