import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { InstanceId, Unlock } from "../executor/ports.ts";
import { StoreError } from "./errors.ts";

type LockContent = { pid: number; host: string; startedAt: string; token: string };

export type LockOptions = {
  staleMs?: number;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  host?: string;
};

const DEFAULT_STALE_MS = 10 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 实例单写锁（CMP-store §2.3）：`wx` 创建；同实例双跑返回 locked；陈旧锁可接管。 */
export class LockManager {
  readonly #dir: string;
  readonly #staleMs: number;
  readonly #now: () => Date;
  readonly #isAlive: (pid: number) => boolean;
  readonly #host: string;

  constructor(stateRoot: string, options: LockOptions = {}) {
    this.#dir = join(stateRoot, "locks");
    this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.#now = options.now ?? (() => new Date());
    this.#isAlive = options.isAlive ?? alive;
    this.#host = options.host ?? hostname();
  }

  async lock(instanceId: InstanceId): Promise<Unlock> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const path = join(this.#dir, `${instanceId.replaceAll(/[^\w.-]/g, "_")}.lock`);
    const token = crypto.randomUUID();
    const content: LockContent = { pid: process.pid, host: this.#host, startedAt: this.#now().toISOString(), token };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const created = await this.#tryCreate(path, content);
      if (created) return this.#unlocker(path, token);
      const existing = await this.#read(path);
      if (existing !== null && this.#isActive(existing)) {
        throw new StoreError("locked", `实例已有活跃锁：${instanceId}（pid ${existing.pid}）`);
      }
      await unlink(path).catch(() => undefined);
    }
    throw new StoreError("locked", `无法取得实例锁：${instanceId}`);
  }

  async #tryCreate(path: string, content: LockContent): Promise<boolean> {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify(content));
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new StoreError("io_error", `创建实例锁失败：${(error as Error).message}`);
    }
  }

  async #read(path: string): Promise<LockContent | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockContent>;
      if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
      return { pid: parsed.pid, host: String(parsed.host ?? ""), startedAt: String(parsed.startedAt ?? ""), token: parsed.token };
    } catch {
      return null;
    }
  }

  #isActive(content: LockContent): boolean {
    if (!this.#isAlive(content.pid)) return false;
    const started = Date.parse(content.startedAt);
    if (Number.isNaN(started)) return true;
    return this.#now().getTime() - started < this.#staleMs;
  }

  #unlocker(path: string, token: string): Unlock {
    return async () => {
      const existing = await this.#read(path);
      if (existing === null || existing.token !== token) return;
      await unlink(path).catch(() => undefined);
    };
  }

  async diagnose(): Promise<{ path: string; stale: boolean }[]> {
    const { readdir } = await import("node:fs/promises");
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const out: { path: string; stale: boolean }[] = [];
    for (const name of names) {
      if (!name.endsWith(".lock")) continue;
      const path = join(this.#dir, name);
      const content = await this.#read(path);
      const info = await stat(path).catch(() => null);
      const age = info === null ? 0 : this.#now().getTime() - info.mtimeMs;
      out.push({ path, stale: content === null || !this.#isActive(content) || age > this.#staleMs });
    }
    return out;
  }
}
