import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "../observability/doctor.ts";
import { FileStore } from "./store.ts";

/** L0 管理面：`doctor` 与维护命令使用，executor 不依赖（CMP-store §3.4）。 */
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

  async compact(): Promise<void> {
    await this.#store.compact();
  }

  async diagnose(): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    const journalPath = join(this.#stateRoot, "journal.jsonl");
    const size = await stat(journalPath).then((info) => info.size).catch(() => 0);
    checks.push({
      id: "state.journal",
      title: "journal",
      status: "pass",
      detail: `${journalPath}（${size} 字节）`,
    });

    const pending = await this.#store.pendingAll();
    checks.push({
      id: "state.pending",
      title: "未收口 attempt",
      status: pending.length === 0 ? "pass" : "warn",
      detail: pending.length === 0 ? "0 条" : `${pending.length} 条（重启后按恢复规则处理）`,
    });

    const staleLocks = (await this.#store.lockDiagnostics()).filter((lock) => lock.stale);
    checks.push({
      id: "state.locks",
      title: "实例锁",
      status: staleLocks.length === 0 ? "pass" : "warn",
      detail: staleLocks.length === 0 ? "无陈旧锁" : `${staleLocks.length} 个陈旧锁`,
      ...(staleLocks.length === 0 ? {} : { remediation: "确认无同实例运行后删除对应 .lock 文件，或等待下次接管" }),
    });

    const orphans = await this.#store.listOrphans();
    checks.push({
      id: "state.orphans",
      title: "孤儿进程记录",
      status: orphans.length === 0 ? "pass" : "warn",
      detail: orphans.length === 0 ? "无" : `${orphans.length} 条（pid: ${orphans.map((item) => item.pid).join(", ")}）`,
      ...(orphans.length === 0 ? {} : { remediation: "启动恢复会按 pid/pgid 回收；也可手动确认后清理" }),
    });

    checks.push({
      id: "state.dirs",
      title: "state 目录",
      status: (await hasDir(this.#stateRoot)) ? "pass" : "warn",
      detail: this.#stateRoot,
    });
    return checks;
  }
}

async function hasDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length >= 0;
  } catch {
    return false;
  }
}
