import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SerialQueue } from "./journal-io.ts";

export type RunRecord = {
  runId: string;
  instanceId: string;
  workspacePath: string;
  taskSpacePath: string;
  firstSeenAt: string;
  updatedAt: string;
  archivedAt?: string;
  goneAt?: string;
};

export type RunUpsert = {
  runId: string;
  instanceId: string;
  workspacePath: string;
  taskSpacePath: string;
  archivedAt?: string;
};

export type RunRegistryOptions = {
  stateRoot: string;
  now?: () => Date;
};

const DEFAULT_ARCHIVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_UNARCHIVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * run 注册表（CMP-store）：`<stateRoot>/runs/<runId>.json`。
 * 只记录 run → workspace/task-space 的映射，供观测面 O-09/O-10 定位文件根；
 * 不是任务/归档的真相，任务与归档仍是输入（见 contract-v1 §15）。
 */
export class FileRunRegistry {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #queue = new SerialQueue();
  #records: Map<string, RunRecord> | null = null;
  #tempSeq = 0;

  constructor(options: RunRegistryOptions) {
    this.#dir = join(options.stateRoot, "runs");
    this.#now = options.now ?? (() => new Date());
  }

  get dir(): string {
    return this.#dir;
  }

  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
  }

  async upsert(input: RunUpsert): Promise<RunRecord> {
    return await this.#queue.run(async () => {
      await this.init();
      const records = await loadRecords(this.#dir);
      const existing = records.get(input.runId);
      const now = this.#now().toISOString();
      const record: RunRecord = {
        runId: input.runId,
        instanceId: input.instanceId,
        workspacePath: input.workspacePath,
        taskSpacePath: input.taskSpacePath,
        firstSeenAt: existing?.firstSeenAt ?? now,
        updatedAt: now,
        ...(input.archivedAt === undefined
          ? existing?.archivedAt === undefined
            ? {}
            : { archivedAt: existing.archivedAt }
          : { archivedAt: input.archivedAt }),
      };
      await writeRecord(this.#dir, record, this.#tempSeq++);
      records.set(record.runId, record);
      return { ...record };
    });
  }

  async get(runId: string): Promise<RunRecord | null> {
    const records = await loadRecords(this.#dir);
    const record = records.get(runId);
    return record === undefined ? null : { ...record };
  }

  async count(): Promise<number> {
    return (await loadRecords(this.#dir)).size;
  }

  async list(): Promise<RunRecord[]> {
    const records = await loadRecords(this.#dir);
    return [...records.values()]
      .map((record) => ({ ...record }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** 清理已归档/长期未更新的 run；活跃 run 由调用方显式保护。 */
  async prune(options: {
    activeRunIds?: readonly string[];
    archivedRetentionMs?: number;
    unarchivedRetentionMs?: number;
  } = {}): Promise<number> {
    return await this.#queue.run(async () => {
      const active = new Set(options.activeRunIds ?? []);
      const archivedRetention = options.archivedRetentionMs ?? DEFAULT_ARCHIVED_RETENTION_MS;
      const unarchivedRetention = options.unarchivedRetentionMs ?? DEFAULT_UNARCHIVED_RETENTION_MS;
      const now = this.#now().getTime();
      const records = await loadRecords(this.#dir);
      let removed = 0;
      for (const [runId, record] of records) {
        if (active.has(runId)) continue;
        const archivedAt = record.archivedAt === undefined ? null : Date.parse(record.archivedAt);
        const updatedAt = Date.parse(record.updatedAt);
        const expired =
          archivedAt !== null
            ? Number.isFinite(archivedAt) && now - archivedAt > archivedRetention
            : Number.isFinite(updatedAt) && now - updatedAt > unarchivedRetention;
        if (!expired) continue;
        // 保留 tombstone：O-09/O-10 需要区分 404（从未存在）与 410（已清理）。
        const tombstone = { ...record, goneAt: new Date(now).toISOString() };
        await writeRecord(this.#dir, tombstone, this.#tempSeq++).catch(() => undefined);
        records.set(runId, tombstone);
        removed += 1;
      }
      return removed;
    });
  }


}


async function loadRecords(dir: string): Promise<Map<string, RunRecord>> {
  const records = new Map<string, RunRecord>();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return records;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readRecord(join(dir, name));
    if (record !== null) records.set(record.runId, record);
  }
  return records;
}

async function readRecord(path: string): Promise<RunRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RunRecord>;
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.instanceId !== "string" ||
      typeof parsed.workspacePath !== "string" ||
      typeof parsed.taskSpacePath !== "string" ||
      typeof parsed.firstSeenAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) return null;
    return parsed as RunRecord;
  } catch {
    return null;
  }
}

async function writeRecord(dir: string, record: RunRecord, seq: number): Promise<void> {
  const target = runPath(dir, record.runId);
  const temp = `${target}.${process.pid}.${seq}.tmp`;
  await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

function runPath(dir: string, runId: string): string {
  return join(dir, `${runId.replaceAll(/[^0-9a-zA-Z._-]/g, "_")}.json`);
}
