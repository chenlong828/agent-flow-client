import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const INTERPRETERS = new Set(["bun", "node", "nodejs"]);

/**
 * 解析 `<runDir>`（REQ-0001 §4.1）。
 *
 * - 打包态：可执行文件所在目录；
 * - 源码态：可执行文件是 bun/node 时，从模块目录向上找最近的 package.json 目录；
 * - 不使用 process.cwd()，不从解释器安装目录推导。
 */
export function resolveRunDir(options: {
  execPath: string;
  moduleDir: string;
  hasFile?: (path: string) => boolean;
}): string {
  const hasFile = options.hasFile ?? existsSync;
  if (!INTERPRETERS.has(basename(options.execPath))) {
    return dirname(options.execPath);
  }

  let current = resolve(options.moduleDir);
  for (;;) {
    if (hasFile(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`无法从 ${options.moduleDir} 向上找到 package.json`);
    }
    current = parent;
  }
}
