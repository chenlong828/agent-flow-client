import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** 目录内容摘要：按相对路径排序，逐个文件做 sha256 后汇总。 */
export async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(root)) {
    const rel = relative(root, file).split("\\").join("/");
    const fileHash = createHash("sha256").update(await readFile(file)).digest("hex");
    hash.update(`${rel}\0${fileHash}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
