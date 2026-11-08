import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uuidv7 } from "../shared/uuid.ts";

export const PROTOCOL_VERSION = "2026-11-07.1";
export const ACP_PROTOCOL_VERSION = "1";
export const DSH_BASELINE = "0.2.2-alpha.2";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 读取或生成持久 clientId（`<stateRoot>/client-id`，0600）。 */
export async function loadClientId(stateRoot: string): Promise<string> {
  const path = join(stateRoot, "client-id");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (UUID_PATTERN.test(existing)) return existing;
  } catch {
    // 不存在或不可读，生成新值。
  }
  const clientId = uuidv7();
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(path, clientId, { mode: 0o600 });
  return clientId;
}

export function newRunId(): string {
  return uuidv7();
}

export function newRequestId(): string {
  return uuidv7();
}
