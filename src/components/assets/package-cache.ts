import { rm } from "node:fs/promises";
import type { AssetOptions } from "./assets.ts";
import { AssetError } from "./errors.ts";
import { fetchPackage, writeCachedPackage } from "./download.ts";
import { unpackZip, type UnpackLimits } from "./unpack.ts";
import type { SourcePackage } from "./package-source.ts";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

async function tryCache(cachePath: string, staging: string, limits: UnpackLimits): Promise<boolean> {
  if (!(await Bun.file(cachePath).exists())) return false;
  try {
    await unpackZip(cachePath, staging, limits);
    return true;
  } catch {
    await rm(cachePath, { force: true }).catch(() => undefined);
    return false;
  }
}

/** 下载/缓存 zip 并解包到 staging；命中缓存时不发请求。 */
export async function installRemotePackage(
  pkg: SourcePackage,
  staging: string,
  limits: UnpackLimits,
  options: AssetOptions & { baseUrl: string },
): Promise<void> {
  const cachePath =
    options.cacheRoot === undefined ? null : `${options.cacheRoot}/${pkg.digest.replaceAll(/[^0-9a-zA-Z]/g, "-")}.zip`;
  if (cachePath !== null && (await tryCache(cachePath, staging, limits))) return;

  const fetched = await fetchPackage(pkg.downloadUrl, {
    baseUrl: options.baseUrl,
    token: options.token ?? null,
    maxBytes: limits.maxBytes,
    ...(pkg.etag === undefined ? {} : { etag: pkg.etag }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (fetched.notModified) throw new AssetError("download_failed", `技能包 304 但本地无缓存：${pkg.name}`);
  if (DIGEST_PATTERN.test(pkg.digest) && `sha256:${fetched.sha256}` !== pkg.digest) {
    throw new AssetError("checksum_mismatch", `技能包摘要不符：${pkg.name}`);
  }
  if (fetched.bytes.byteLength === 0) throw new AssetError("download_failed", `技能包为空：${pkg.name}`);

  const zipPath = cachePath ?? `${staging}.zip`;
  if (options.cacheRoot !== undefined) await writeCachedPackage(options.cacheRoot, pkg.digest, fetched.bytes);
  else await Bun.write(zipPath, fetched.bytes);
  await unpackZip(zipPath, staging, limits);
}
