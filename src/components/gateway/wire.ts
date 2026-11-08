import type {
  CleanupAck,
  ControlBatch,
  ControlEvent,
  HeartbeatOutcome,
  Limits,
  RegistrationOutcome,
} from "../executor/scheduler-port.ts";
import type { Lease, NodeRequest, SkillPackage, SkillSet } from "../executor/types.ts";
import type { Ack } from "../executor/scheduler-port.ts";
import { GatewayError } from "./errors.ts";

export type WireRecord = Record<string, unknown>;

export function asRecord(value: unknown, label: string): WireRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError("unreachable", `调度器响应字段非法：${label}`);
  }
  return value as WireRecord;
}

export function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new GatewayError("unreachable", `调度器响应字段非法：${label}`);
  return value;
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GatewayError("unreachable", `调度器响应字段非法：${label}`);
  return value;
}

export function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GatewayError("unreachable", `调度器响应字段非法：${label}`);
  }
  return value;
}

export function parseLease(value: unknown): Lease {
  const lease = asRecord(value, "lease");
  return { expiresAt: asString(lease.expiresAt, "lease.expiresAt"), ttlMs: asNumber(lease.ttlMs, "lease.ttlMs") };
}

export function parseNodeRequest(value: unknown): NodeRequest {
  const body = asRecord(value, "claim");
  return {
    attemptId: asString(body.attemptId, "attemptId"),
    attemptNo: asNumber(body.attemptNo, "attemptNo"),
    instanceId: asString(body.instanceId, "instanceId"),
    nodeId: asString(body.nodeId, "nodeId"),
    workspacePath: asString(body.workspacePath, "workspacePath"),
    prompt: asString(body.prompt, "prompt"),
    timeoutMs: asNumber(body.timeoutMs, "timeoutMs"),
    claimedAt: asString(body.claimedAt, "claimedAt"),
    lease: parseLease(body.lease),
  };
}

export function parseSkillSet(value: unknown): SkillSet {
  const set = asRecord(value, "skillSet");
  const packages = asArray(set.packages, "skillSet.packages").map((raw, index) => {
    const item = asRecord(raw, `skillSet.packages[${index}]`);
    const pkg: SkillPackage = {
      packageId: asString(item.packageId, "packageId"),
      name: asString(item.name, "name"),
      version: asString(item.version, "version"),
      digest: asString(item.digest, "digest"),
      sizeBytes: asNumber(item.sizeBytes, "sizeBytes"),
      downloadUrl: asString(item.downloadUrl, "downloadUrl"),
      ...(typeof item.etag === "string" ? { etag: item.etag } : {}),
    };
    return pkg;
  });
  return { digest: asString(set.digest, "skillSet.digest"), packages };
}

export function parseAck(body: unknown): Ack {
  const ack = asRecord(body, "ack");
  const disposition = ack.disposition;
  if (disposition !== "accepted" && disposition !== "duplicate") {
    throw new GatewayError("unreachable", "ack.disposition 非法");
  }
  return {
    attemptId: asString(ack.attemptId, "ack.attemptId"),
    disposition,
    attemptState: asString(ack.attemptState, "ack.attemptState"),
    recordedAt: asString(ack.recordedAt, "ack.recordedAt"),
  };
}

export function parseRegistration(body: unknown): RegistrationOutcome & {
  protocolVersion: string;
  compatibility: string;
  heartbeat: { pollTimeoutMs: number; clientTimeoutMs: number; nextPollAfterMs: number };
} {
  const root = asRecord(body, "register");
  const limitsRaw = asRecord(root.limits, "limits");
  const limits: Limits = {
    maxResultBytes: asNumber(limitsRaw.maxResultBytes, "limits.maxResultBytes"),
    maxPromptBytes: asNumber(limitsRaw.maxPromptBytes, "limits.maxPromptBytes"),
    maxRequestBytes: asNumber(limitsRaw.maxRequestBytes, "limits.maxRequestBytes"),
    maxSkillPackageBytes: asNumber(limitsRaw.maxSkillPackageBytes, "limits.maxSkillPackageBytes"),
    maxSkillPackages: asNumber(limitsRaw.maxSkillPackages, "limits.maxSkillPackages"),
  };
  const heartbeatRaw = asRecord(root.heartbeat, "heartbeat");
  const cleanupPending = parseCleanupPending(root.cleanupPending);
  return {
    serverTime: asString(root.serverTime, "serverTime"),
    protocolVersion: asString(root.protocolVersion, "protocolVersion"),
    compatibility: typeof root.compatibility === "string" ? root.compatibility : "compatible",
    limits,
    heartbeat: {
      pollTimeoutMs: asNumber(heartbeatRaw.pollTimeoutMs, "heartbeat.pollTimeoutMs"),
      clientTimeoutMs: asNumber(heartbeatRaw.clientTimeoutMs, "heartbeat.clientTimeoutMs"),
      nextPollAfterMs: asNumber(heartbeatRaw.nextPollAfterMs, "heartbeat.nextPollAfterMs"),
    },
    assignmentsVersion: asNumber(root.assignmentsVersion, "assignmentsVersion"),
    ...(root.assignments === undefined ? {} : { assignments: parseAssignments(root.assignments) }),
    cleanupPending,
  };
}

export function parseHeartbeat(body: unknown): HeartbeatOutcome {
  const root = asRecord(body, "heartbeat");
  const controlRaw = asRecord(root.control, "control");
  const events = asArray(controlRaw.events, "control.events").map((raw) => parseControlEvent(raw));
  const control: ControlBatch = { seq: asNumber(controlRaw.seq, "control.seq"), events };
  return {
    serverTime: asString(root.serverTime, "serverTime"),
    control,
    cleanupPending: parseCleanupPending(root.cleanupPending),
    assignmentsVersion: asNumber(root.assignmentsVersion, "assignmentsVersion"),
    ...(root.assignments === undefined ? {} : { assignments: parseAssignments(root.assignments) }),
    nextPollAfterMs: asNumber(root.nextPollAfterMs, "nextPollAfterMs"),
  };
}

export function parseCleanupPending(value: unknown): {
  releaseId: string;
  instanceId: string;
  workspacePath?: string;
  cleanup: "keep" | "clean-skills" | "clean-client";
  releasedAt: string;
}[] {
  return asArray(value ?? [], "cleanupPending").map((raw) => {
    const item = asRecord(raw, "cleanupPending[]");
    const cleanup = item.cleanup;
    if (cleanup !== "keep" && cleanup !== "clean-skills" && cleanup !== "clean-client") {
      throw new GatewayError("unreachable", "cleanupPending.cleanup 非法");
    }
    return {
      releaseId: asString(item.releaseId, "releaseId"),
      instanceId: asString(item.instanceId, "instanceId"),
      ...(typeof item.workspacePath === "string" ? { workspacePath: item.workspacePath } : {}),
      cleanup,
      releasedAt: asString(item.releasedAt, "releasedAt"),
    };
  });
}

function parseAssignments(value: unknown): { instanceId: string; workspacePath: string; state: "active" | "waiting" }[] {
  return asArray(value, "assignments").map((raw) => {
    const item = asRecord(raw, "assignments[]");
    const state = item.state;
    if (state !== "active" && state !== "waiting") throw new GatewayError("unreachable", "assignments.state 非法");
    return {
      instanceId: asString(item.instanceId, "instanceId"),
      workspacePath: asString(item.workspacePath, "workspacePath"),
      state,
    };
  });
}

function parseControlEvent(value: unknown): ControlEvent {
  const event = asRecord(value, "control.events[]");
  const type = event.type;
  const issuedAt = asString(event.issuedAt, "issuedAt");
  if (type === "cancel") {
    if (event.reason !== "user_cancel") throw new GatewayError("unreachable", "cancel.reason 非法");
    return { type, instanceId: asString(event.instanceId, "instanceId"), issuedAt, reason: "user_cancel" };
  }
  if (type === "pause" || type === "resume") {
    return { type, instanceId: asString(event.instanceId, "instanceId"), issuedAt };
  }
  if (type === "shutdown") {
    return {
      type,
      ...(typeof event.instanceId === "string" ? { instanceId: event.instanceId } : {}),
      ...(event.cleanup === "keep" || event.cleanup === "clean-skills" || event.cleanup === "clean-client"
        ? { cleanup: event.cleanup }
        : {}),
      ...(typeof event.releaseId === "string" ? { releaseId: event.releaseId } : {}),
      issuedAt,
    };
  }
  throw new GatewayError("unreachable", `未知控制事件类型：${String(type)}`);
}

export function parseCleanupAck(value: unknown): CleanupAck {
  const ack = asRecord(value, "cleanupAck");
  const status = ack.status;
  if (status !== "done" && status !== "failed") throw new GatewayError("unreachable", "cleanupAck.status 非法");
  return {
    releaseId: asString(ack.releaseId, "releaseId"),
    status,
    completedAt: asString(ack.completedAt, "completedAt"),
  };
}
