import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptId, AttemptRecord, InstanceId } from "../executor/ports.ts";
import { appendRecord, compactJournal, journalSize, readJournal, SerialQueue } from "./journal-io.ts";
import { findLatest, instancesOf, pendingAllOf, pendingFor } from "./journal-query.ts";

export type JournalOptions = {
  stateRoot: string;
  compactBytes?: number;
  compactLines?: number;
  now?: () => Date;
};

const DEFAULT_COMPACT_BYTES = 10 * 1024 * 1024;
const DEFAULT_COMPACT_LINES = 10_000;

/**
 * 本地 attempt journal（CMP-store §2.2）：追加写、按 attemptId 折叠、
 * 损坏行降级跳过；`stateRoot` 由组合根注入。
 */
export class FileJournal {
  readonly #stateRoot: string;
  readonly #journalPath: string;
  readonly #compactBytes: number;
  readonly #compactLines: number;
  readonly #now: () => Date;
  readonly #queue = new SerialQueue();
  #records: AttemptRecord[] | null = null;

  constructor(options: JournalOptions) {
    this.#stateRoot = options.stateRoot;
    this.#journalPath = join(options.stateRoot, "journal.jsonl");
    this.#compactBytes = options.compactBytes ?? DEFAULT_COMPACT_BYTES;
    this.#compactLines = options.compactLines ?? DEFAULT_COMPACT_LINES;
    this.#now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(this.#stateRoot, "locks"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#stateRoot, "orphans"), { recursive: true, mode: 0o700 });
    const handle = await open(this.#journalPath, "a", 0o600);
    await handle.close();
  }

  async load(): Promise<AttemptRecord[]> {
    if (this.#records === null) this.#records = await readJournal(this.#journalPath);
    return this.#records;
  }

  async append(record: AttemptRecord): Promise<void> {
    await this.#queue.run(async () => {
      await appendRecord(this.#journalPath, record);
      this.#records = null;
      await this.#compactIfNeeded();
    });
  }

  async mark(attemptId: AttemptId, state: AttemptRecord["state"], patch?: Partial<AttemptRecord>): Promise<void> {
    await this.#queue.run(async () => {
      const latest = findLatest(await this.load(), attemptId);
      if (latest === undefined) throw new Error(`journal 中不存在 attempt：${attemptId}`);
      await appendRecord(this.#journalPath, {
        ...latest,
        ...patch,
        v: 1,
        ts: this.#now().toISOString(),
        attemptId,
        state,
      });
      this.#records = null;
      await this.#compactIfNeeded();
    });
  }

  async pending(instanceId: InstanceId): Promise<AttemptRecord[]> {
    return pendingFor(await this.load(), instanceId);
  }

  async pendingAll(): Promise<AttemptRecord[]> {
    return pendingAllOf(await this.load());
  }

  async listInstances(): Promise<InstanceId[]> {
    return instancesOf(await this.load());
  }

  async compact(): Promise<void> {
    await this.#queue.run(async () => {
      await compactJournal(this.#journalPath, await this.load());
      this.#records = null;
    });
  }

  async #compactIfNeeded(): Promise<void> {
    const records = await this.load();
    if ((await journalSize(this.#journalPath)) < this.#compactBytes && records.length < this.#compactLines) return;
    await compactJournal(this.#journalPath, records);
    this.#records = null;
  }
}
