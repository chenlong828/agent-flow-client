import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SkillPackage, SkillSet, TaskRequest } from "../executor/types.ts";

export type LocalRunRequest = { task: TaskRequest };

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
  if (typeof value !== "string" || value.trim() === "") throw new RequestError(`${label} 必须是非空字符串`);
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RequestError(`${key} 必须是字符串`);
  return value;
}

function requiredInt(source: Record<string, unknown>, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RequestError(`${label} 必须是正整数`);
  }
  return value;
}

export function parseSkillSet(value: unknown): SkillSet {
  const skillSet = asRecord(value, "skillSet");
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
  return { digest: requiredString(skillSet, "digest", "skillSet.digest"), packages };
}

/** 读取并校验本地 `run --request` 文件（v2 TaskRequest 形状）。 */
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
  const workspacePath = requiredString(root, "workspacePath", "workspacePath");
  if (!isAbsolute(workspacePath)) throw new RequestError("workspacePath 必须是绝对路径");
  return {
    task: {
      taskId: requiredString(root, "taskId", "taskId"),
      instanceId: requiredString(root, "instanceId", "instanceId"),
      nodeId: requiredString(root, "nodeId", "nodeId"),
      attempt: requiredInt(root, "attempt", "attempt"),
      prompt: requiredString(root, "prompt", "prompt"),
      workspacePath,
      timeoutMs: requiredInt(root, "timeoutMs", "timeoutMs"),
      skillSet: parseSkillSet(root.skillSet),
    },
  };
}
