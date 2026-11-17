import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { SessionMetaFile } from "./archive.ts";

export class FileSessionArchive {
  readonly #stateRoot: string;

  constructor(options: { stateRoot: string }) {
    this.#stateRoot = options.stateRoot;
  }

  async isGone(sessionId: string): Promise<boolean> {
    const gone = join(this.#stateRoot, "observability", "sessions", safe(sessionId), "gone");
    return (await stat(gone).catch(() => null)) !== null;
  }

  /** 按保留期/总字节清理已结束 session；保留 meta/gone tombstone，删除 raw。 */
  async prune(options: { retentionDays?: number; maxBytes?: number; activeSessionIds?: readonly string[] } = {}): Promise<number> {
    const retentionDays = options.retentionDays ?? 7;
    const maxBytes = options.maxBytes ?? 1073741824;
    const active = new Set(options.activeSessionIds ?? []);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const root = join(this.#stateRoot, "observability", "sessions");
    const names = await readdir(root).catch(() => []);
    const entries: { sessionId: string; sizeBytes: number; endedAt: number }[] = [];
    for (const name of names) {
      if (active.has(name)) continue;
      const dir = join(root, name);
      const info = await stat(dir).catch(() => null);
      if (info === null || !info.isDirectory()) continue;
      const meta = await readFile(join(dir, "meta.json"), "utf8").then((text) => JSON.parse(text) as SessionMetaFile).catch(() => null);
      const endedAt = Date.parse(meta?.finishedAt ?? meta?.startedAt ?? "") || info.mtimeMs;
      const size = await stat(join(dir, "session.v4.jsonl.zstd")).then((item) => item.size).catch(() => 0);
      entries.push({ sessionId: name, sizeBytes: size, endedAt });
    }
    entries.sort((left, right) => left.endedAt - right.endedAt);
    let total = entries.reduce((sum, item) => sum + item.sizeBytes, 0);
    let removed = 0;
    for (const entry of entries) {
      if (entry.endedAt >= cutoff && total <= maxBytes) continue;
      const dir = join(root, entry.sessionId);
      await writeFile(join(dir, "gone"), new Date().toISOString(), { mode: 0o600 }).catch(() => undefined);
      await rm(join(dir, "session.v4.jsonl.zstd"), { force: true }).catch(() => undefined);
      total -= entry.sizeBytes;
      removed += 1;
    }
    return removed;
  }

  async resolve(sessionId: string): Promise<{ path: string; sizeBytes: number; sha256: string } | null> {
    const dir = join(this.#stateRoot, "observability", "sessions", safe(sessionId));
    const path = join(dir, "session.v4.jsonl.zstd");
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) return null;
    try {
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as SessionMetaFile;
      if (meta.archive?.sha256 !== null && meta.archive?.sha256 !== undefined && meta.archive.sizeBytes !== null) {
        return { path, sizeBytes: meta.archive.sizeBytes, sha256: meta.archive.sha256 };
      }
    } catch {
      // 没有 meta 时回退到重算。
    }
    const bytes = await readFile(path);
    return { path, sizeBytes: info.size, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
}

function safe(value: string): string {
  return value.replaceAll(/[^0-9a-zA-Z._-]/g, "_");
}
