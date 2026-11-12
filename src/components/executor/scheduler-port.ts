import type {
  ArchiveAck,
  PollRequest,
  PollResponse,
  ResultAck,
  SessionLogAck,
  SkillPackage,
  TaskResult,
} from "./types.ts";

export type PackageDownload = {
  bytes?: Uint8Array;
  notModified: boolean;
  sha256?: string;
  etag?: string | null;
};

/** 调度器协议防腐层（CMP-executor 定义，CMP-gateway 实现；run 用本地适配器）。 */
export interface SchedulerPort {
  poll(request: PollRequest): Promise<PollResponse>;
  reportResult(result: TaskResult): Promise<ResultAck>;
  /** `P-03`：按 packageId 取 zip；304 时 `notModified=true`。 */
  downloadPackage(pkg: SkillPackage): Promise<PackageDownload>;
  /** `P-04`：上传单次尝试的会话日志（gzip JSONL）；同键后到覆盖。 */
  uploadSessionLog(input: { taskId: string; attempt: number; payload: Uint8Array }): Promise<SessionLogAck>;
  /** `P-05`：上传运行归档（task-space 的 tar.gz）；同 run 后到覆盖。 */
  uploadArchive(input: { runId: string; payload: Uint8Array }): Promise<ArchiveAck>;
}
