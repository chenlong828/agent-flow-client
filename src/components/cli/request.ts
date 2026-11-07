import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { NodeRequest, SkillPackage, SkillSet } from "../executor/ports.ts";

export type LocalRunRequest = {
  request: NodeRequest;
  skillSet: SkillSet;
};

export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(`${label} 必须是非空字符串`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RequestError(`${key} 必须是字符串`);
  return value;
}

function parseLease(value: unknown): NodeRequest["lease"] {
  const lease = asRecord(value, "lease");
  const expiresAt = requiredString(lease, "expiresAt", "lease.expiresAt");
  const ttlMs = lease.ttlMs;
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new RequestError("lease.ttlMs 必须是正整数");
  }
  return { expiresAt, ttlMs };
}

function parseSkillSet(value: unknown): SkillSet {
  const skillSet = asRecord(value, "skillSet");
  const digest = requiredString(skillSet, "digest", "skillSet.digest");
  const rawPackages = skillSet.packages;
  if (!Array.isArray(rawPackages)) throw new RequestError("skillSet.packages 必须是数组");
  const packages: SkillPackage[] = rawPackages.map((raw, index) => {
    const item = asRecord(raw, `skillSet.packages[${index}]`);
    const sizeBytes = item.sizeBytes;
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
      throw new RequestError(`skillSet.packages[${index}].sizeBytes 必须是非负整数`);
    }
    return {
      packageId: requiredString(item, "packageId", `skillSet.packages[${index}].packageId`),
      name: requiredString(item, "name", `skillSet.packages[${index}].name`),
      version: requiredString(item, "version", `skillSet.packages[${index}].version`),
      digest: requiredString(item, "digest", `skillSet.packages[${index}].digest`),
      sizeBytes,
      downloadUrl: requiredString(item, "downloadUrl", `skillSet.packages[${index}].downloadUrl`),
      ...(optionalString(item, "etag") === undefined ? {} : { etag: optionalString(item, "etag") }),
    };
  });
  return { digest, packages };
}

/** 读取并校验本地 `run --request` 文件（SCN-0001 S0 替身触发）。 */
export async function loadLocalRequest(path: string): Promise<LocalRunRequest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new RequestError(`读取请求文件失败：${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RequestError(`请求文件不是合法 JSON：${(error as Error).message}`);
  }
  const root = asRecord(parsed, "请求");
  const attemptNo = root.attemptNo;
  if (typeof attemptNo !== "number" || !Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new RequestError("attemptNo 必须是 ≥1 的整数");
  }
  const timeoutMs = root.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RequestError("timeoutMs 必须是正整数");
  }
  const workspacePath = requiredString(root, "workspacePath", "workspacePath");
  if (!isAbsolute(workspacePath)) {
    throw new RequestError("workspacePath 必须是绝对路径");
  }
  const request: NodeRequest = {
    attemptId: requiredString(root, "attemptId", "attemptId"),
    attemptNo,
    instanceId: requiredString(root, "instanceId", "instanceId"),
    nodeId: requiredString(root, "nodeId", "nodeId"),
    workspacePath,
    prompt: requiredString(root, "prompt", "prompt"),
    timeoutMs,
    claimedAt: requiredString(root, "claimedAt", "claimedAt"),
    lease: parseLease(root.lease),
  };
  return { request, skillSet: parseSkillSet(root.skillSet) };
}
