import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AssetOptions } from "./assets.ts";
import { AssetError } from "./errors.ts";
import { digestDirectory } from "./digest.ts";
import { copyTree, type CopyLimits } from "./copy.ts";
import { resolveLocalSource } from "./local-source.ts";
import { PackageDownloadError } from "./download.ts";
import { installRemotePackage } from "./package-cache.ts";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type SourcePackage = { name: string; digest: string; downloadUrl: string; etag?: string };

async function isRemotePackage(pkg: SourcePackage, options: AssetOptions): Promise<boolean> {
  if (/^https?:/.test(pkg.downloadUrl)) return true;
  if (pkg.downloadUrl.startsWith("file://")) return false;
  if (!isAbsolute(pkg.downloadUrl)) return true;
  const isLocalDir = await stat(pkg.downloadUrl).then((info) => info.isDirectory()).catch(() => false);
  return !isLocalDir && options.baseUrl !== undefined;
}

/** 包来源分派：本地目录（S0 保留）或 `C-05` HTTP zip。 */
export async function materializePackage(
  pkg: SourcePackage,
  staging: string,
  limits: CopyLimits,
  options: AssetOptions,
): Promise<void> {
  if (await isRemotePackage(pkg, options)) {
    await materializeRemote(pkg, staging, limits, options);
    return;
  }
  const source = await resolveLocalSource(pkg.downloadUrl);
  if (DIGEST_PATTERN.test(pkg.digest)) {
    const actual = await digestDirectory(source);
    if (actual !== pkg.digest) throw new AssetError("checksum_mismatch", `技能包摘要不符：${pkg.name}`);
  }
  await copyTree(source, staging, limits);
}

async function materializeRemote(
  pkg: SourcePackage,
  staging: string,
  limits: CopyLimits,
  options: AssetOptions,
): Promise<void> {
  if (options.baseUrl === undefined) {
    throw new AssetError("download_failed", `未配置调度器地址，无法下载技能包：${pkg.name}`);
  }
  try {
    await installRemotePackage(pkg, staging, limits, { ...options, baseUrl: options.baseUrl });
  } catch (error) {
    if (error instanceof AssetError) throw error;
    if (error instanceof PackageDownloadError) {
      throw new AssetError(error.code === "checksum_mismatch" ? "checksum_mismatch" : "download_failed", error.message);
    }
    throw new AssetError("download_failed", `技能包处理失败：${(error as Error).message}`);
  }
}
