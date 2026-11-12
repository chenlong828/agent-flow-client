import type {
  ArchiveAck,
  ArchiveRequest,
  PollRequest,
  PollResponse,
  ResultAck,
  SessionLogAck,
  SkillPackage,
  StoredStatus,
  TaskRequest,
} from "../executor/types.ts";
import { GatewayError } from "./errors.ts";

export type WireRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): WireRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError("protocol_error", `调度器响应字段非法：${label}`);
  }
  return value as WireRecord;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new GatewayError("protocol_error", `调度器响应字段非法：${label}`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new GatewayError("protocol_error", `调度器响应字段非法：${label}`);
  return value;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GatewayError("protocol_error", `调度器响应字段非法：${label}`);
  return value;
}

export function serializePollRequest(request: PollRequest): unknown {
  return {
    capacity: { free: request.capacity.free },
    running: request.running.map((task) => ({
      taskId: task.taskId,
      instanceId: task.instanceId,
      startedAt: task.startedAt,
      ...(task.lastEventAt === undefined ? {} : { lastEventAt: task.lastEventAt }),
    })),
    finished: request.finished.map((task) => ({
      taskId: task.taskId,
      attempt: task.attempt,
      finishedAt: task.finishedAt,
    })),
    ...(request.archivedRuns === undefined ? {} : { archivedRuns: request.archivedRuns }),
  };
}

export function parsePollResponse(body: unknown): PollResponse {
  const root = asRecord(body, "poll");
  const tasks = asArray(root.tasks, "tasks").map((raw) => parseTask(raw));
  const stop = root.stop;
  if (typeof stop !== "boolean") throw new GatewayError("protocol_error", "stop 必须是布尔值");
  const cancelInstances = asArray(root.cancelInstances, "cancelInstances").map((raw) => asString(raw, "cancelInstances[]"));
  const nextPollAfterMs = typeof root.nextPollAfterMs === "number" ? root.nextPollAfterMs : 0;
  const archiveRequests =
    root.archiveRequests === undefined
      ? []
      : asArray(root.archiveRequests, "archiveRequests").map((raw) => parseArchiveRequest(raw));
  return { tasks, stop, cancelInstances, archiveRequests, nextPollAfterMs };
}

function parseTask(raw: unknown): TaskRequest {
  const task = asRecord(raw, "tasks[]");
  return {
    taskId: asString(task.taskId, "taskId"),
    instanceId: asString(task.instanceId, "instanceId"),
    nodeId: asString(task.nodeId, "nodeId"),
    attempt: asNumber(task.attempt, "attempt"),
    prompt: asString(task.prompt, "prompt"),
    workspacePath: asString(task.workspacePath, "workspacePath"),
    taskSpacePath: asString(task.taskSpacePath, "taskSpacePath"),
    timeoutMs: asNumber(task.timeoutMs, "timeoutMs"),
    skillSet: parseSkillSet(task.skillSet),
  };
}

export function parseSkillSet(value: unknown): TaskRequest["skillSet"] {
  const set = asRecord(value, "skillSet");
  return {
    digest: asString(set.digest, "skillSet.digest"),
    packages: asArray(set.packages, "skillSet.packages").map((raw, index) => {
      const item = asRecord(raw, `skillSet.packages[${index}]`);
      return {
        packageId: asString(item.packageId, "packageId"),
        name: asString(item.name, "name"),
        version: asString(item.version, "version"),
        digest: asString(item.digest, "digest"),
        sizeBytes: asNumber(item.sizeBytes, "sizeBytes"),
        downloadUrl: asString(item.downloadUrl, "downloadUrl"),
        ...(typeof item.etag === "string" ? { etag: item.etag } : {}),
      };
    }),
  };
}

export function parseResultAck(body: unknown): ResultAck {
  const ack = asRecord(body, "result");
  return { taskId: asString(ack.taskId, "taskId"), accepted: ack.accepted === true };
}

function parseArchiveRequest(raw: unknown): ArchiveRequest {
  const item = asRecord(raw, "archiveRequests[]");
  return {
    runId: asString(item.runId, "archiveRequests[].runId"),
    instanceId: asString(item.instanceId, "archiveRequests[].instanceId"),
    workspacePath: asString(item.workspacePath, "archiveRequests[].workspacePath"),
    taskSpacePath: asString(item.taskSpacePath, "archiveRequests[].taskSpacePath"),
  };
}

function parseStored(value: unknown, label: string): StoredStatus {
  if (value === "created" || value === "replaced" || value === "unchanged") return value;
  throw new GatewayError("protocol_error", `${label}.stored 非法`);
}

export function parseSessionLogAck(body: unknown): SessionLogAck {
  const ack = asRecord(body, "sessionLog");
  return {
    taskId: asString(ack.taskId, "sessionLog.taskId"),
    attempt: asNumber(ack.attempt, "sessionLog.attempt"),
    bytes: asNumber(ack.bytes, "sessionLog.bytes"),
    sha256: asString(ack.sha256, "sessionLog.sha256"),
    stored: parseStored(ack.stored, "sessionLog"),
  };
}

export function parseArchiveAck(body: unknown): ArchiveAck {
  const ack = asRecord(body, "archive");
  return {
    runId: asString(ack.runId, "archive.runId"),
    bytes: asNumber(ack.bytes, "archive.bytes"),
    sha256: asString(ack.sha256, "archive.sha256"),
    stored: parseStored(ack.stored, "archive"),
  };
}

export function parsePackage(pkg: SkillPackage): SkillPackage {
  return pkg;
}
