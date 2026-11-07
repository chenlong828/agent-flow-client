import { appendFile, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { AttemptId, AttemptRecord } from "../executor/ports.ts";

/** journal 的底层文件操作与串行队列；FileJournal 只负责折叠与状态推进。 */

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

export async function readJournal(path: string): Promise<AttemptRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: AttemptRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as AttemptRecord;
      if (parsed.v === 1 && typeof parsed.attemptId === "string" && typeof parsed.state === "string") {
        records.push(parsed);
      }
    } catch {
      // 损坏行跳过，不阻塞启动（CMP-store §2.2）。
    }
  }
  return records;
}

export async function appendRecord(path: string, record: AttemptRecord): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (record.state === "settled" || record.state === "closed" || record.state === "abandoned") {
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function journalSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export async function compactJournal(path: string, records: readonly AttemptRecord[]): Promise<void> {
  const latest = new Map<AttemptId, AttemptRecord>();
  for (const record of records) latest.set(record.attemptId, record);
  const snapshot = [...latest.values()]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((record) => JSON.stringify(record))
    .join("\n");
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, snapshot === "" ? "" : `${snapshot}\n`, { mode: 0o600 });
  await rename(temp, path);
}
