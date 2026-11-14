import { lstat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

/** 子路径是否位于父路径内（按路径段判断，不做字符串前缀比较）。 */
export function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 只读判断路径类型；不跟随符号链接。 */
export async function pathKind(path: string): Promise<"missing" | "dir" | "file" | "symlink"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    return info.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}
