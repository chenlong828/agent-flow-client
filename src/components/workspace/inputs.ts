import { chmod, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceInputsPort } from "../executor/ports.ts";
import { WorkspaceError } from "./errors.ts";
import { inside, pathKind } from "./fs-path.ts";

const TEMP_FILE = /^\..+\.part$/;

/**
 * task-space 内的初始资料写入（`EXE-06/07`，CMP-workspace 的 `inputs` 子能力）。
 * 只接受已由 `ensureTaskSpace` 创建的 task-space；所有写入落在 `<task-space>/inputs/`。
 */
export class TaskSpaceInputs implements WorkspaceInputsPort {
  /** 创建 `<task-space>/inputs`（0700），返回真实路径；清理上次中断留下的临时文件。 */
  async ensureDir(taskSpacePath: string): Promise<string> {
    const space = await realpath(taskSpacePath).catch(() => null);
    if (space === null) throw new WorkspaceError("not_prepared", `task-space 不存在：${taskSpacePath}`);
    const inputs = join(space, "inputs");
    const kind = await pathKind(inputs);
    if (kind === "symlink" || kind === "file") {
      throw new WorkspaceError("path_escape", `初始资料目录必须是普通目录：${inputs}`);
    }
    try {
      await mkdir(inputs, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new WorkspaceError("permission_denied", `创建初始资料目录失败：${(error as Error).message}`);
    }
    const real = await realpath(inputs);
    if (!inside(real, space)) throw new WorkspaceError("path_escape", `初始资料目录逃逸 task-space：${inputs}`);
    for (const entry of await readdir(real).catch(() => [] as string[])) {
      if (TEMP_FILE.test(entry)) await rm(join(real, entry), { force: true }).catch(() => undefined);
    }
    return real;
  }

  /** 已存在且是普通文件时返回 size；不存在返回 null；符号链接/目录报 `path_escape`。 */
  async stat(taskSpacePath: string, name: string): Promise<{ size: number } | null> {
    assertInputName(name);
    const inputs = await existingInputsDir(taskSpacePath);
    if (inputs === null) return null;
    const target = join(inputs, name);
    if (dirname(target) !== inputs) throw new WorkspaceError("path_escape", `初始资料路径非法：${name}`);
    const info = await lstat(target).catch(() => null);
    if (info === null) return null;
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new WorkspaceError("path_escape", `初始资料路径非法：${name}`);
    }
    return { size: info.size };
  }

  /** 原子写入 `inputs/<name>`：同目录临时文件 → rename；只读 0400。 */
  async write(taskSpacePath: string, name: string, bytes: Uint8Array): Promise<void> {
    assertInputName(name);
    const inputs = await this.ensureDir(taskSpacePath);
    const target = join(inputs, name);
    if (dirname(target) !== inputs) throw new WorkspaceError("path_escape", `初始资料路径非法：${name}`);
    const existing = await lstat(target).catch(() => null);
    if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new WorkspaceError("path_escape", `初始资料路径非法：${name}`);
    }
    const temp = join(inputs, `.${name}.${randomUUID()}.part`);
    try {
      await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
      await replaceFile(temp, target);
      await chmod(target, 0o400);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw mapIoError(error, `写入初始资料失败：${name}`);
    }
  }
}

async function existingInputsDir(taskSpacePath: string): Promise<string | null> {
  const space = await realpath(taskSpacePath).catch(() => null);
  if (space === null) return null;
  const inputs = join(space, "inputs");
  const kind = await pathKind(inputs);
  if (kind === "missing") return null;
  if (kind === "symlink" || kind === "file") {
    throw new WorkspaceError("path_escape", `初始资料目录必须是普通目录：${inputs}`);
  }
  const real = await realpath(inputs);
  if (!inside(real, space)) throw new WorkspaceError("path_escape", `初始资料目录逃逸 task-space：${inputs}`);
  return real;
}

/** 初始资料名二次校验：只允许一个普通文件名，且不得以点开头（避开临时文件与隐藏文件）。 */
function assertInputName(name: string): void {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    isAbsolute(name) ||
    basename(name) !== name ||
    name.length > 255
  ) {
    throw new WorkspaceError("path_escape", `初始资料名非法：${name}`);
  }
}

function mapIoError(error: unknown, message: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = (error as { code?: unknown }).code;
  return new WorkspaceError(code === "ENOSPC" ? "disk_full" : "permission_denied", `${message}：${(error as Error).message}`);
}

async function replaceFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    await rm(to, { force: true });
    await rename(from, to);
  }
}
