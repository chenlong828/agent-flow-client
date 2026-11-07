import { chmod, copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AssetError } from "./errors.ts";

export type CopyLimits = { maxBytes: number; maxFiles: number };

/** 安全复制目录：拒绝符号链接，限制文件数与字节数；脚本置 0755，其余 0644。 */
export async function copyTree(source: string, destination: string, limits: CopyLimits): Promise<void> {
  const state = { bytes: 0, files: 0 };
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await copyEntries(source, destination, "", limits, state);
}

async function copyEntries(
  source: string,
  destination: string,
  prefix: string,
  limits: CopyLimits,
  state: { bytes: number; files: number },
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new AssetError("unpack_failed", `包内含符号链接：${join(prefix, entry.name)}`);
    if (entry.isDirectory()) {
      const target = join(destination, entry.name);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await copyEntries(join(source, entry.name), target, join(prefix, entry.name), limits, state);
      continue;
    }
    if (!entry.isFile()) throw new AssetError("unpack_failed", `包内含不支持的文件类型：${join(prefix, entry.name)}`);
    state.files += 1;
    if (state.files > limits.maxFiles) throw new AssetError("unpack_failed", "技能包文件数超过上限");
    const sourcePath = join(source, entry.name);
    const targetPath = join(destination, entry.name);
    const size = Bun.file(sourcePath).size;
    state.bytes += size;
    if (state.bytes > limits.maxBytes) throw new AssetError("unpack_failed", "技能包解压后超过大小上限");
    await copyFile(sourcePath, targetPath);
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    await chmod(targetPath, relative.split("/").includes("scripts") ? 0o755 : 0o644);
  }
}
