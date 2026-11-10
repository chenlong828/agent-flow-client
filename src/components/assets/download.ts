import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class PackageDownloadError extends Error {
  readonly code: "download_failed" | "checksum_mismatch" | "payload_too_large" | "unauthorized";
  constructor(code: PackageDownloadError["code"], message: string) {
    super(message);
    this.name = "PackageDownloadError";
    this.code = code;
  }
}

/** 把下载内容写入缓存文件（`<cacheRoot>/<digest>.zip`）。 */
export async function writeCachedPackage(cacheRoot: string, digest: string, bytes: Uint8Array): Promise<string> {
  const path = `${cacheRoot}/${digest.replaceAll(/[^0-9a-zA-Z]/g, "-")}.zip`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}
