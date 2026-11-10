import type { PollRequest, PollResponse, ResultAck, SkillPackage, TaskResult } from "./types.ts";

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
}
