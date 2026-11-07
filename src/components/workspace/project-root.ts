import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 找到最近的含 `.git` 的祖先（`.git` 可以是目录或文件），否则返回入参目录。
 *
 * 与 DSH 的 projectRoot 规则一致（OQ-002 实测）；容器根必须满足
 * `findProjectRoot(容器根) === 容器根`（architecture.md 不变量 10）。
 */
export function findProjectRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (hasGitEntry(current)) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function hasGitEntry(directory: string): boolean {
  try {
    const info = statSync(join(directory, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}
