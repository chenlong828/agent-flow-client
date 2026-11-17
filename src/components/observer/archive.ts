import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export type SessionArchiveInfo = { path: string; sizeBytes: number; sha256: string; sourceFile: string };

/** 从实例 DSH_HOME 找 session 原始文件；找不到返回 null。 */
export async function findSessionFile(dshHome: string, sessionId: string): Promise<string | null> {
  const sessions = join(dshHome, "sessions");
  const projectDirs = await readdir(sessions, { withFileTypes: true }).catch(() => []);
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue;
    const target = join(sessions, project.name, sessionId);
    const info = await stat(target).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    const names = await readdir(target).catch(() => []);
    const file = names.find((name) => /^session\..+\.(zstd|jsonl)$/.test(name) || name === "session.v4.jsonl.zstd");
    if (file !== undefined) return join(target, file);
  }
  return null;
}

/** 把 DSH 原始 session 复制到观测归档目录，返回元数据。 */
export async function archiveSession(input: {
  stateRoot: string;
  dshHome: string;
  sessionId: string;
}): Promise<SessionArchiveInfo | null> {
  const source = await findSessionFile(input.dshHome, input.sessionId);
  if (source === null) return null;
  const dir = join(input.stateRoot, "observability", "sessions", input.sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, "session.v4.jsonl.zstd");
  await copyFile(source, target);
  const bytes = await readFile(target);
  return {
    path: target,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceFile: source,
  };
}

export type SessionMetaFile = {
  sessionId: string;
  attemptId?: string;
  instanceId?: string;
  nodeId?: string;
  runId?: string;
  taskId?: string;
  cwd?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string | null;
  eventCount?: number;
  archive?: { status: string; sizeBytes: number | null; sha256: string | null };
};

/** sessions/<sessionId>/meta.json 的唯一写入口（合并写、原子写）。 */
/** O-06/O-08 的会话归档读取：优先用 meta 的 size/sha，避免每次重读全文。 */

export class FileSessionArchive {
  readonly #stateRoot: string;

  constructor(options: { stateRoot: string }) {
    this.#stateRoot = options.stateRoot;
  }

  /** 按保留期/总字节清理已结束 session 目录；活跃 session 由调用方保护。 */
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
      await rm(join(root, entry.sessionId), { recursive: true, force: true }).catch(() => undefined);
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
