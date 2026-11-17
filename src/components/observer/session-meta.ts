import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMetaFile } from "./archive.ts";

function safe(value: string): string {
  return value.replaceAll(/[^0-9a-zA-Z._-]/g, "_");
}

export async function writeSessionMeta(stateRoot: string, patch: SessionMetaFile): Promise<void> {
  const dir = join(stateRoot, "observability", "sessions", safe(patch.sessionId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "meta.json");
  let existing: SessionMetaFile = { sessionId: patch.sessionId };
  try {
    existing = JSON.parse(await readFile(path, "utf8")) as SessionMetaFile;
  } catch {
    // 首次写入。
  }
  const merged: SessionMetaFile = { ...existing, ...patch, sessionId: patch.sessionId };
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

