import { rm } from "node:fs/promises";
import type { AssetOptions } from "./assets.ts";
import { AssetError } from "./errors.ts";
import { writeCachedPackage } from "./download.ts";
import { unpackZip } from "./unpack.ts";
import type { SourcePackage } from "./package-source.ts";
import type { CopyLimits } from "./copy.ts";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

async function tryCache(cachePath: string, staging: string, limits: CopyLimits): Promise<boolean> {
  if (!(await Bun.file(cachePath).exists())) return false;
  try {
    await unpackZip(cachePath, staging, limits);
    return true;
  } catch {
    await rm(cachePath, { force: true }).catch(() => undefined);
    return false;
  }
}

/** 远端 zip：命中缓存直接解包；否则经注入的 P-03 下载器取包。 */
export async function installRemotePackage(
  pkg: SourcePackage,
  staging: string,
  limits: CopyLimits,
  options: AssetOptions,
): Promise<void> {
  const cachePath =
    options.cacheRoot === undefined ? null : `${options.cacheRoot}/${pkg.digest.replaceAll(/[^0-9a-zA-Z]/g, "-")}.zip`;
  if (cachePath !== null && (await tryCache(cachePath, staging, limits))) return;
  if (options.download === undefined) throw new AssetError("download_failed", `未配置技能包下载器：${pkg.name}`);
  if (pkg.sizeBytes > limits.maxBytes) throw new AssetError("download_failed", `技能包超过大小上限：${pkg.name}`);

  // 走到这里说明本地没有该 digest 的副本：任务里的 etag 描述的是目标版本，
  // 拿它发条件请求必然 304，而本地无包可用。缓存未命中时不做条件请求。
  const fetched = await options.download({ ...pkg, etag: undefined });
  // 防御：中间层若擅自返回 304，仍按失败处理，不静默成功。
  if (fetched.notModified) throw new AssetError("download_failed", `技能包 304 但本地无缓存：${pkg.name}`);
  if (fetched.bytes === undefined) throw new AssetError("download_failed", `技能包响应为空：${pkg.name}`);
  if (DIGEST_PATTERN.test(pkg.digest) && fetched.sha256 !== undefined && `sha256:${fetched.sha256}` !== pkg.digest) {
    throw new AssetError("checksum_mismatch", `技能包摘要不符：${pkg.name}`);
  }
  const zipPath = cachePath ?? `${staging}.zip`;
  if (options.cacheRoot !== undefined) await writeCachedPackage(options.cacheRoot, pkg.digest, fetched.bytes);
  else await Bun.write(zipPath, fetched.bytes);
  await unpackZip(zipPath, staging, limits);
}
