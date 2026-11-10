import type { TaskId, TaskRecord } from "../executor/types.ts";

/** journal 记录的折叠与查询（纯函数，不做 I/O）。 */

export function collapse(records: readonly TaskRecord[]): TaskRecord[] {
  const latest = new Map<TaskId, TaskRecord>();
  for (const record of records) latest.set(record.taskId, record);
  return [...latest.values()];
}

/** 已落盘、尚未 accepted 的结果（进 `finished[]`）。 */
export function settledResults(records: readonly TaskRecord[]): TaskRecord[] {
  return collapse(records).filter((record) => record.state === "settled" && record.result !== undefined);
}

export function findLatest(records: readonly TaskRecord[], taskId: TaskId): TaskRecord | undefined {
  return collapse(records).find((record) => record.taskId === taskId);
}
