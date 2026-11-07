import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  ts: string;
  level: LogLevel;
  event: string;
  msg?: string;
  pid?: number;
  instanceId?: string;
  nodeId?: string;
  attemptId?: string;
  sessionId?: string;
  phase?: string;
  errorClass?: string;
  code?: string;
  retryable?: boolean;
  durationMs?: number;
};

export type LoggerBindings = Partial<Pick<LogRecord, "instanceId" | "nodeId" | "attemptId" | "sessionId" | "phase">>;

export interface Logger {
  log(record: Omit<LogRecord, "ts" | "pid">): void;
  child(bindings: LoggerBindings): Logger;
}

export type LoggerOptions = {
  level: LogLevel;
  stderr?: (line: string) => void;
  filePath?: string;
  maxBytes?: number;
  keep?: number;
  now?: () => Date;
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|passwd|api[-_]?key|credential|private[-_]?key/i;
const TEXT_KEYS = new Set(["prompt", "finalText", "message"]);

function hashText(text: string): { bytes: number; sha256: string } {
  return { bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text).digest("hex") };
}

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (TEXT_KEYS.has(key) && typeof value === "string") return hashText(value);
  return value;
}

/** 脱敏：凭据键置 `[redacted]`；prompt/结果原文替换为长度与摘要。 */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = redactValue(key, value);
  return out;
}

/** 结构化日志：stderr 同步、文件异步；失败不反压主流程（CMP-observability §3.1）。 */
export class JsonLogger implements Logger {
  readonly #level: number;
  readonly #stderr: (line: string) => void;
  readonly #filePath: string | undefined;
  readonly #maxBytes: number;
  readonly #keep: number;
  readonly #now: () => Date;
  readonly #bindings: LoggerBindings;
  #queue: Promise<void> = Promise.resolve();
  #size: number | null = null;
  #dropped = 0;

  constructor(options: LoggerOptions, bindings: LoggerBindings = {}) {
    this.#level = LEVEL_ORDER[options.level];
    this.#stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
    this.#filePath = options.filePath;
    this.#maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.#keep = options.keep ?? 5;
    this.#now = options.now ?? (() => new Date());
    this.#bindings = bindings;
  }

  log(record: Omit<LogRecord, "ts" | "pid">): void {
    if (LEVEL_ORDER[record.level] < this.#level) return;
    const full: Record<string, unknown> = {
      ...this.#bindings,
      ...record,
      ts: this.#now().toISOString(),
      pid: process.pid,
    };
    const line = JSON.stringify(redactRecord(full));
    this.#stderr(line);
    if (this.#filePath !== undefined) {
      this.#queue = this.#queue
        .then(async () => await this.#append(line))
        .catch(() => {
          this.#dropped += 1;
        });
    }
  }

  child(bindings: LoggerBindings): Logger {
    return new JsonLogger(
      {
        level: levelOf(this.#level),
        stderr: this.#stderr,
        ...(this.#filePath === undefined ? {} : { filePath: this.#filePath }),
        maxBytes: this.#maxBytes,
        keep: this.#keep,
        now: this.#now,
      },
      { ...this.#bindings, ...bindings },
    );
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  get dropped(): number {
    return this.#dropped;
  }

  async #append(line: string): Promise<void> {
    const path = this.#filePath as string;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (this.#size === null) {
      this.#size = await stat(path).then((info) => info.size).catch(() => 0);
    }
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (this.#size + bytes > this.#maxBytes) {
      await this.#rotate(path);
      this.#size = 0;
    }
    await appendFile(path, `${line}\n`, { mode: 0o600 });
    this.#size += bytes;
  }

  async #rotate(path: string): Promise<void> {
    for (let index = this.#keep - 1; index >= 1; index -= 1) {
      await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => undefined);
    }
    await rename(path, `${path}.1`).catch(() => undefined);
  }
}

function levelOf(threshold: number): LogLevel {
  if (threshold <= LEVEL_ORDER.debug) return "debug";
  if (threshold <= LEVEL_ORDER.info) return "info";
  if (threshold <= LEVEL_ORDER.warn) return "warn";
  return "error";
}
