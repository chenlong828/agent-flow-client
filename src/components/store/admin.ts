import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "../observability/doctor.ts";
import { FileStore } from "./store.ts";

/** L0 管理面：`doctor` 与维护命令使用，executor 不依赖。 */
export class StoreAdmin {
  readonly #stateRoot: string;
  readonly #store: FileStore;

  constructor(options: { stateRoot: string; store: FileStore }) {
    this.#stateRoot = options.stateRoot;
    this.#store = options.store;
  }

  stateRoot(): string {
    return this.#stateRoot;
  }

  async diagnose(): Promise<CheckResult[]> {
    const journalPath = join(this.#stateRoot, "journal.jsonl");
    const size = await stat(journalPath).then((info) => info.size).catch(() => 0);
    const settled = await this.#store.settled();
    const orphans = await this.#store.listOrphans();
    return [
      { id: "state.journal", title: "journal", status: "pass", detail: `${journalPath}（${size} 字节）` },
      {
        id: "state.settled",
        title: "未确认结果",
        status: settled.length === 0 ? "pass" : "warn",
        detail: settled.length === 0 ? "0 条" : `${settled.length} 条（重启后补报）`,
      },
      {
        id: "state.orphans",
        title: "孤儿进程记录",
        status: orphans.length === 0 ? "pass" : "warn",
        detail: orphans.length === 0 ? "无" : `${orphans.length} 条（pid: ${orphans.map((item) => item.pid).join(", ")}）`,
        ...(orphans.length === 0 ? {} : { remediation: "启动恢复会按 pid/pgid 回收；也可手动确认后清理" }),
      },
      {
        id: "state.dirs",
        title: "state 目录",
        status: (await hasDir(this.#stateRoot)) ? "pass" : "warn",
        detail: this.#stateRoot,
      },
    ];
  }
}

async function hasDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length >= 0;
  } catch {
    return false;
  }
}
