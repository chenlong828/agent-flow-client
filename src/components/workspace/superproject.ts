import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LayoutReport } from "../executor/ports.ts";
import { inside, pathKind } from "./fs-path.ts";

/** 根有 `.git` 且带 `.gitmodules` 时视为 git 超项目；`.git` 目录与文件都接受。 */
export async function readLayout(root: string): Promise<LayoutReport["layout"]> {
  if ((await pathKind(join(root, ".git"))) === "missing") return "container";
  return (await pathKind(join(root, ".gitmodules"))) === "file" ? "superproject" : "container";
}

type SubmoduleEntry = { name: string; path: string };

/** 只解析 `.gitmodules` 的 `path`；不执行 git 命令，不初始化子模块。 */
export async function submoduleWarnings(root: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(join(root, ".gitmodules"), "utf8");
  } catch {
    return ["无法读取 .gitmodules，跳过子模块检查"];
  }
  const warnings: string[] = [];
  for (const entry of parseGitmodules(content)) {
    if (entry.path === "") {
      warnings.push(`子模块配置缺少 path：${entry.name}`);
      continue;
    }
    const dir = resolve(root, entry.path);
    if (!inside(dir, root)) {
      warnings.push(`子模块路径越界：${entry.name}`);
      continue;
    }
    if ((await pathKind(dir)) !== "dir") {
      warnings.push(`子模块未初始化：${entry.name}（目录不存在）`);
      continue;
    }
    const children = await readdir(dir).catch(() => []);
    if (children.length === 0) {
      warnings.push(`子模块未初始化：${entry.name}（目录为空）`);
      continue;
    }
    if ((await pathKind(join(dir, ".git"))) === "missing") {
      warnings.push(`子模块未初始化：${entry.name}（缺少 .git）`);
    }
  }
  return warnings;
}

function parseGitmodules(content: string): SubmoduleEntry[] {
  const entries: SubmoduleEntry[] = [];
  let current: SubmoduleEntry | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[submodule\s+"([^"]+)"\]$/.exec(line);
    if (section !== null) {
      const name = section[1];
      if (name === undefined) continue;
      current = { name, path: "" };
      entries.push(current);
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (current === null) continue;
    const path = /^path\s*=\s*(.+)$/.exec(line);
    const value = path?.[1]?.trim();
    if (value !== undefined && value !== "") current.path = unquote(value);
  }
  return entries;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}
