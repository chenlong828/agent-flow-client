import type { AttemptId, AttemptRecord, InstanceId } from "../executor/ports.ts";

/** journal 记录的折叠与查询（纯函数，不做 I/O）。 */

export function collapse(records: readonly AttemptRecord[]): AttemptRecord[] {
  const latest = new Map<AttemptId, AttemptRecord>();
  for (const record of records) latest.set(record.attemptId, record);
  return [...latest.values()];
}

export function pendingFor(records: readonly AttemptRecord[], instanceId: InstanceId): AttemptRecord[] {
  return collapse(records).filter((record) => record.instanceId === instanceId && !isTerminal(record.state));
}

export function pendingAllOf(records: readonly AttemptRecord[]): AttemptRecord[] {
  return collapse(records).filter((record) => !isTerminal(record.state));
}

export function instancesOf(records: readonly AttemptRecord[]): InstanceId[] {
  return [...new Set(records.map((record) => record.instanceId))];
}

export function findLatest(records: readonly AttemptRecord[], attemptId: AttemptId): AttemptRecord | undefined {
  return collapse(records).find((record) => record.attemptId === attemptId);
}

export function isTerminal(state: AttemptRecord["state"]): boolean {
  return state === "closed" || state === "abandoned";
}
