import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { SignalServerConfig } from "./plan.ts";

/** 信号目录：`<state.root>/signals/<taskId>/<attempt>/`，不放进 task-space（proposal §4.3）。 */
export function signalRoot(stateRoot: string): string {
  return join(stateRoot, "signals");
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/** taskId 是调度器给的不透明字符串；不安全的字符回落到稳定摘要，避免路径穿越。 */
export function taskDirName(taskId: string): string {
  if (SAFE_SEGMENT.test(taskId) && taskId !== "." && taskId !== "..") return taskId;
  return `t-${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`;
}

export function attemptDir(stateRoot: string, taskId: string, attempt: number): string {
  return join(signalRoot(stateRoot), taskDirName(taskId), String(attempt));
}

export function configPathOf(dir: string): string {
  return join(dir, "config.json");
}

export function outputPathOf(dir: string): string {
  return join(dir, "signals.jsonl");
}

/** 目录 `0700`、文件 `0600`；重复 prepare 不清空既有文件（server 可能被启动两次）。 */
export async function ensureAttemptDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const output = outputPathOf(dir);
  await writeFile(output, "", { flag: "a", mode: 0o600 });
}

export async function writeServerConfig(dir: string, config: SignalServerConfig): Promise<string> {
  const path = configPathOf(dir);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function readServerConfig(path: string): Promise<SignalServerConfig> {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as SignalServerConfig;
  if (typeof parsed !== "object" || parsed === null) throw new Error("config 必须是对象");
  if (typeof parsed.output !== "string" || parsed.output === "") throw new Error("config.output 缺失");
  if (typeof parsed.version !== "number") throw new Error("config.version 缺失");
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) throw new Error("config.tools 缺失");
  for (const tool of parsed.tools) {
    if (typeof tool?.kind !== "string" || tool.kind === "") throw new Error("config.tools[].kind 缺失");
    if (typeof tool.schema !== "object" || tool.schema === null) throw new Error(`config.tools[].schema 缺失（${tool.kind}）`);
  }
  if (typeof parsed.limits?.maxSignals !== "number" || typeof parsed.limits?.maxBytes !== "number") {
    throw new Error("config.limits 缺失");
  }
  return parsed;
}

function inside(root: string, target: string): boolean {
  const rel = resolve(target).startsWith(resolve(root) + sep) || resolve(target) === resolve(root);
  return rel;
}

/**
 * 清理超过保留期的信号目录（proposal §4.3）：
 * 逐 attempt 目录判断 mtime，删空 task 目录；只删 `signals/` 之下，路径先校验。
 */
export async function cleanupSignals(stateRoot: string, retentionDays: number, now = Date.now()): Promise<number> {
  const root = signalRoot(stateRoot);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  const tasks = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const task of tasks) {
    if (!task.isDirectory()) continue;
    const taskPath = join(root, task.name);
    if (!inside(root, taskPath)) continue;
    const attempts = await readdir(taskPath, { withFileTypes: true }).catch(() => []);
    for (const attempt of attempts) {
      if (!attempt.isDirectory()) continue;
      const path = join(taskPath, attempt.name);
      if (!inside(root, path)) continue;
      const info = await stat(path).catch(() => null);
      if (info === null || info.mtimeMs >= cutoff) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
    const rest = await readdir(taskPath).catch(() => []);
    if (rest.length === 0) await rm(taskPath, { recursive: true, force: true }).catch(() => undefined);
  }
  return removed;
}
