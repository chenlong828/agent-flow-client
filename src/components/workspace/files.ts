import { open, lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RunFileEntry, RunFilePort, RunFileRoot } from "../observer/http-types.ts";

export class RunFileError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RunFileError";
    this.code = code;
    this.status = status;
  }
}

/** CMP-workspace 的只读运行文件访问；调用方只传相对路径，根由 run 注册表提供。 */
export class WorkspaceFileReader implements RunFilePort {
  async list(input: { root: RunFileRoot; rootPath: string; path: string; limit: number }): Promise<{ entries: RunFileEntry[]; truncated: boolean }> {
    const target = await resolveInside(input.rootPath, input.path);
    const info = await lstat(target).catch(() => null);
    if (info === null) throw new RunFileError(404, "file_not_found", `目录不存在：${input.path}`);
    if (!info.isDirectory()) throw new RunFileError(415, "unsupported_file", `不是目录：${input.path}`);
    const real = await realpath(target).catch(() => target);
    if (!inside(real, await realpath(input.rootPath).catch(() => resolve(input.rootPath)))) {
      throw new RunFileError(400, "path_escape", `路径越界：${input.path}`);
    }
    const limit = Math.max(1, Math.min(2000, Math.trunc(input.limit)));
    const entries: RunFileEntry[] = [];
    let truncated = false;
    const directory = await opendir(real).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES") throw new RunFileError(403, "file_permission_denied", `无读权限：${input.path}`);
      throw error;
    });
    try {
      for await (const item of directory) {
        const child = join(real, item.name);
        const childInfo = await lstat(child).catch(() => null);
        if (childInfo === null) continue;
        entries.push({
          name: item.name,
          type: childInfo.isDirectory() ? "dir" : childInfo.isFile() ? "file" : childInfo.isSymbolicLink() ? "symlink" : "other",
          sizeBytes: childInfo.isFile() ? childInfo.size : null,
          modifiedAt: childInfo.mtime.toISOString(),
        });
        if (entries.length > limit) {
          truncated = true;
          break;
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    entries.sort((left, right) => {
      const dir = Number(right.type === "dir") - Number(left.type === "dir");
      return dir !== 0 ? dir : left.name.localeCompare(right.name);
    });
    return { entries: entries.slice(0, limit), truncated };
  }

  async read(input: { root: RunFileRoot; rootPath: string; path: string; maxBytes: number }): Promise<{
    name: string;
    sizeBytes: number;
    modifiedAt: string;
    content: string | null;
    encoding: "utf-8" | null;
    binary: boolean;
    truncated: boolean;
  }> {
    const target = await resolveInside(input.rootPath, input.path);
    const info = await lstat(target).catch(() => null);
    if (info === null) throw new RunFileError(404, "file_not_found", `文件不存在：${input.path}`);
    if (info.isDirectory() || info.isSymbolicLink()) {
      throw new RunFileError(415, "unsupported_file", `不是普通文件：${input.path}`);
    }
    if (!info.isFile()) throw new RunFileError(415, "unsupported_file", `不支持的文件类型：${input.path}`);
    const real = await realpath(target).catch(() => target);
    if (!inside(real, await realpath(input.rootPath).catch(() => resolve(input.rootPath)))) {
      throw new RunFileError(400, "path_escape", `符号链接逃逸：${input.path}`);
    }
    const maxBytes = Math.max(1, Math.min(1048576, Math.trunc(input.maxBytes)));
    const handle = await open(real, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES") throw new RunFileError(403, "file_permission_denied", `无读权限：${input.path}`);
      throw error;
    });
    try {
      const length = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const truncated = info.size > maxBytes;
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        return {
          name: target.split("/").at(-1) ?? "",
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          content,
          encoding: "utf-8",
          binary: false,
          truncated,
        };
      } catch {
        return {
          name: target.split("/").at(-1) ?? "",
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          content: null,
          encoding: null,
          binary: true,
          truncated,
        };
      }
    } finally {
      await handle.close();
    }
  }
}

async function resolveInside(rootPath: string, relPath: string): Promise<string> {
  if (!isAbsolute(rootPath)) throw new RunFileError(500, "internal", "run 根不是绝对路径");
  assertRelPath(relPath);
  const root = resolve(rootPath);
  const target = resolve(root, relPath === "" ? "." : relPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new RunFileError(400, "path_escape", `路径越界：${relPath}`);
  return target;
}

function assertRelPath(value: string): void {
  if (value === "") return;
  if (value.length > 1024) throw new RunFileError(400, "validation_error", "路径过长");
  if (value.includes("\0") || value.includes("\\")) throw new RunFileError(400, "validation_error", "路径含非法字符");
  if (value.startsWith("/")) throw new RunFileError(400, "path_escape", "不接受绝对路径");
  const parts = value.split("/");
  if (parts.length > 64) throw new RunFileError(400, "validation_error", "路径段过多");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") throw new RunFileError(400, "path_escape", "路径含非法段");
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
