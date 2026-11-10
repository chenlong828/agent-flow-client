import type { JournalPort } from "../executor/ports.ts";
import type { InstanceId, OrphanRecord, TaskId, TaskRecord as RecordType, TaskState } from "../executor/types.ts";
import { FileJournal, type JournalOptions } from "./journal.ts";
import { OrphanStore } from "./orphans.ts";

/** 组合 journal 与孤儿记录，实现 `JournalPort`（v2 无实例锁、无清理回执）。 */
export class FileStore extends FileJournal implements JournalPort {
  readonly #orphans: OrphanStore;

  constructor(options: JournalOptions) {
    super(options);
    this.#orphans = new OrphanStore(options.stateRoot);
  }

  async recordOrphan(orphan: OrphanRecord): Promise<void> {
    await this.#orphans.record(orphan);
  }

  async listOrphans(instanceId?: InstanceId): Promise<OrphanRecord[]> {
    return await this.#orphans.list(instanceId);
  }

  async clearOrphan(pid: number): Promise<void> {
    await this.#orphans.clear(pid);
  }

  async findLatest(taskId: TaskId): Promise<RecordType | undefined> {
    const { findLatest } = await import("./journal-query.ts");
    return findLatest(await this.load(), taskId);
  }

  async statesOf(taskId: TaskId): Promise<TaskState[]> {
    const { collapse } = await import("./journal-query.ts");
    return collapse(await this.load())
      .filter((record: RecordType) => record.taskId === taskId)
      .map((record: RecordType) => record.state as TaskState);
  }
}
