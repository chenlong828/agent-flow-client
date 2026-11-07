import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceId, OrphanRecord } from "../executor/ports.ts";

/** 孤儿进程记录（CMP-store §2.4）：只记录与查询，不探活、不杀进程。 */
export class OrphanStore {
  readonly #dir: string;

  constructor(stateRoot: string) {
    this.#dir = join(stateRoot, "orphans");
  }

  async record(orphan: OrphanRecord): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.#dir, `${orphan.pid}.json`), JSON.stringify(orphan), { mode: 0o600 });
  }

  async list(instanceId?: InstanceId): Promise<OrphanRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const records: OrphanRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.#dir, name), "utf8")) as OrphanRecord;
        if (typeof parsed.pid !== "number" || typeof parsed.instanceId !== "string") continue;
        if (instanceId === undefined || parsed.instanceId === instanceId) records.push(parsed);
      } catch {
        // 损坏记录跳过，不阻塞恢复。
      }
    }
    return records;
  }

  async clear(pid: number): Promise<void> {
    await unlink(join(this.#dir, `${pid}.json`)).catch(() => undefined);
  }
}
