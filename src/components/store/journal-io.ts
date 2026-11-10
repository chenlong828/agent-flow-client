import { appendFile, open, readFile } from "node:fs/promises";
import type { TaskRecord } from "../executor/types.ts";

/** journal 的底层文件操作：追加写、读取、损坏行降级跳过。 */

export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export async function readJournal(path: string): Promise<TaskRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: TaskRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as TaskRecord;
      if (parsed.v === 2 && typeof parsed.taskId === "string" && typeof parsed.state === "string") {
        records.push(parsed);
      }
    } catch {
      // 损坏行跳过，不阻塞启动。
    }
  }
  return records;
}

export async function appendRecord(path: string, record: TaskRecord): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (record.state === "settled") {
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
