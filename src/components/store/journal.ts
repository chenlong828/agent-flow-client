import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { TaskId, TaskRecord, TaskState } from "../executor/types.ts";
import { appendRecord, readJournal, SerialQueue } from "./journal-io.ts";
import { findLatest, settledResults } from "./journal-query.ts";

export type JournalOptions = {
  stateRoot: string;
  now?: () => Date;
};

/**
 * 本地任务 journal（v2）：追加写、按 `taskId` 折叠、损坏行降级跳过。
 * 只保留「任务 → 状态 + 结果」，不做多态状态机与压缩。
 */
export class FileJournal {
  readonly #stateRoot: string;
  readonly #journalPath: string;
  readonly #now: () => Date;
  readonly #queue = new SerialQueue();
  #records: TaskRecord[] | null = null;

  constructor(options: JournalOptions) {
    this.#stateRoot = options.stateRoot;
    this.#journalPath = join(options.stateRoot, "journal.jsonl");
    this.#now = options.now ?? (() => new Date());
  }

  get journalPath(): string {
    return this.#journalPath;
  }

  async init(): Promise<void> {
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(this.#stateRoot, "orphans"), { recursive: true, mode: 0o700 });
    const handle = await open(this.#journalPath, "a", 0o600);
    await handle.close();
  }

  async load(): Promise<TaskRecord[]> {
    if (this.#records === null) this.#records = await readJournal(this.#journalPath);
    return this.#records;
  }

  async append(record: TaskRecord): Promise<void> {
    await this.#queue.run(async () => {
      await appendRecord(this.#journalPath, record);
      this.#records = null;
    });
  }

  async mark(taskId: TaskId, state: TaskState, patch?: Partial<TaskRecord>): Promise<void> {
    await this.#queue.run(async () => {
      const latest = findLatest(await this.load(), taskId);
      if (latest === undefined) throw new Error(`journal 中不存在任务：${taskId}`);
      await appendRecord(this.#journalPath, {
        ...latest,
        ...patch,
        v: 2,
        ts: this.#now().toISOString(),
        taskId,
        state,
      });
      this.#records = null;
    });
  }

  async settled(): Promise<TaskRecord[]> {
    return settledResults(await this.load());
  }
}
