import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionLogPort } from "../executor/ports.ts";

/** `P-04` 会话日志的本地持久化：按 `taskId+attempt` 追加原始 JSONL 行。 */
export class FileSessionLogStore implements SessionLogPort {
  readonly #dir: string;

  constructor(stateRoot: string) {
    this.#dir = join(stateRoot, "session-logs");
  }

  async append(taskId: string, attempt: number, line: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await appendFile(this.#path(taskId, attempt), `${line}\n`, { mode: 0o600 });
  }

  async read(taskId: string, attempt: number): Promise<Uint8Array | null> {
    return await Bun.file(this.#path(taskId, attempt)).bytes().catch(() => null);
  }

  async clear(taskId: string, attempt: number): Promise<void> {
    await rm(this.#path(taskId, attempt), { force: true }).catch(() => undefined);
  }

  #path(taskId: string, attempt: number): string {
    const safe = taskId.replaceAll(/[^0-9a-zA-Z._-]/g, "_");
    return join(this.#dir, `${safe}-a${attempt}.jsonl`);
  }
}
