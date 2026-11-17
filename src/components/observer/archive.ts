import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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


