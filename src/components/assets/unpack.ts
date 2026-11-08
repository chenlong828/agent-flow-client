import { mkdir } from "node:fs/promises";
import { PackageDownloadError } from "./download.ts";

export type UnpackLimits = { maxFiles: number; maxBytes: number };

/** 拒绝绝对路径、`..`、盘符与符号链接条目（安全解包，契约 §5.5）。 */
export function assertSafeZipEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized === "" || normalized.endsWith("/")) continue;
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
      throw new PackageDownloadError("download_failed", `技能包含绝对路径：${entry}`);
    }
    const segments = normalized.split("/");
    if (segments.includes("..")) throw new PackageDownloadError("download_failed", `技能包含越界路径：${entry}`);
    if (normalized.includes("\0")) throw new PackageDownloadError("download_failed", "技能包含非法字符");
  }
}

/** 列出 zip 条目（`unzip -Z1`）。 */
export async function listZipEntries(zipPath: string): Promise<string[]> {
  const result = Bun.spawn(["unzip", "-Z1", zipPath], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  if (code !== 0) throw new PackageDownloadError("download_failed", `无法读取技能包：${stderr.trim()}`);
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * 解包到目标目录；解包前校验条目、解包后拒绝符号链接。
 * 依赖系统 `unzip`（macOS/Linux）；Windows 留 S3。
 */
export async function unpackZip(zipPath: string, targetDir: string, limits: UnpackLimits): Promise<void> {
  const entries = await listZipEntries(zipPath);
  assertSafeZipEntries(entries);
  if (entries.length > limits.maxFiles) {
    throw new PackageDownloadError("download_failed", `技能包文件数超过上限：${entries.length} > ${limits.maxFiles}`);
  }
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const result = Bun.spawn(["unzip", "-q", "-o", zipPath, "-d", targetDir], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(result.stderr).text(), result.exited]);
  if (code !== 0) throw new PackageDownloadError("download_failed", `解包失败：${stderr.trim()}`);

  let totalBytes = 0;
  for await (const entry of new Bun.Glob("**/*").scan({ cwd: targetDir, onlyFiles: false })) {
    const path = `${targetDir}/${entry}`;
    const info = await Bun.file(path).stat().catch(() => null);
    if (info === null) continue;
    if (info.isSymbolicLink()) {
      throw new PackageDownloadError("download_failed", `技能包含符号链接：${entry}`);
    }
    if (info.isFile()) totalBytes += info.size;
    if (totalBytes > limits.maxBytes) {
      throw new PackageDownloadError("download_failed", `技能包解压后超过大小上限：${totalBytes} > ${limits.maxBytes}`);
    }
  }
}
