import type {
  AttemptId,
  AttemptRecord,
  AttemptState,
  InstanceId,
  OrphanRecord,
  Unlock,
} from "../executor/ports.ts";
import { FileJournal, type JournalOptions } from "./journal.ts";
import { LockManager, type LockOptions } from "./locks.ts";
import { OrphanStore } from "./orphans.ts";

/** 组合 journal、实例锁与孤儿记录，实现 `JournalPort`。 */
export class FileStore extends FileJournal {
  readonly #locks: LockManager;
  readonly #orphans: OrphanStore;

  constructor(options: JournalOptions & LockOptions) {
    super(options);
    this.#locks = new LockManager(options.stateRoot, options);
    this.#orphans = new OrphanStore(options.stateRoot);
  }

  async lockInstance(instanceId: InstanceId): Promise<Unlock> {
    return await this.#locks.lock(instanceId);
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

  lockDiagnostics(): Promise<{ path: string; stale: boolean }[]> {
    return this.#locks.diagnose();
  }

  /** 供 executor 测试/恢复使用；不进入 JournalPort。 */
  async findLatest(attemptId: AttemptId): Promise<AttemptRecord | undefined> {
    const { findLatest } = await import("./journal-query.ts");
    return findLatest(await this.load(), attemptId);
  }

  async statesOf(attemptId: AttemptId): Promise<AttemptState[]> {
    const { collapse } = await import("./journal-query.ts");
    return collapse(await this.load())
      .filter((record) => record.attemptId === attemptId)
      .map((record) => record.state);
  }
}
