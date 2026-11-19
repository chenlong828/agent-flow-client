import { readFile } from "node:fs/promises";
import { SIGNAL_LIMITS, byteLength, type ResultSignalContract, type TaskSignal } from "./contract.ts";
import { validateTaskSignal } from "./validate.ts";

/** 采集上限：server 只会写 16 KiB，超过这个量说明文件被改写，直接放弃。 */
const MAX_READ_BYTES = 1024 * 1024;

export type CollectedSignals = {
  signals: TaskSignal[];
  /** 被忽略的行数（损坏 JSON、字段非法、kind 不匹配）。 */
  invalid: number;
};

/**
 * 读 `signals.jsonl`：忽略损坏行（含崩溃留下的半行），按 seq 升序，
 * 只保留最后一个合法窗口（≤ 8 条、≤ 16 KiB）。proposal §3.2/§4.3。
 */
export async function collectSignals(contract: ResultSignalContract, filePath: string): Promise<CollectedSignals> {
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (byteLength(raw) > MAX_READ_BYTES) throw new Error(`signals.jsonl 超过 ${MAX_READ_BYTES} 字节，拒绝采集`);

  const valid: TaskSignal[] = [];
  let invalid = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid += 1;
      continue;
    }
    if (validateTaskSignal(contract, parsed).length > 0) {
      invalid += 1;
      continue;
    }
    valid.push(parsed as TaskSignal);
  }
  valid.sort((left, right) => left.seq - right.seq);

  const window = valid.slice(-SIGNAL_LIMITS.maxCount);
  const signals: TaskSignal[] = [];
  let bytes = 0;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const candidate = window[index] as TaskSignal;
    const size = byteLength(JSON.stringify(candidate));
    if (bytes + size > SIGNAL_LIMITS.maxBytes) break;
    bytes += size;
    signals.unshift(candidate);
  }
  return { signals, invalid };
}
