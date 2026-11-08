import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PackageFetchOptions = {
  baseUrl: string;
  token: string | null;
  maxBytes: number;
  etag?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type FetchedPackage = {
  bytes: Uint8Array;
  sha256: string;
  etag: string | null;
  notModified: boolean;
};

export class PackageDownloadError extends Error {
  readonly code: "download_failed" | "checksum_mismatch" | "payload_too_large" | "unauthorized";
  constructor(code: PackageDownloadError["code"], message: string) {
    super(message);
    this.name = "PackageDownloadError";
    this.code = code;
  }
}

function absolute(url: string, baseUrl: string): string {
  return new URL(url, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/**
 * `C-05` 下载：跨 host 不带 token；`304` 视为缓存命中；按 `Content-Length`
 * 与 `limits.maxSkillPackageBytes` 预检（契约 §5.5）。
 */
function buildHeaders(target: string, options: PackageFetchOptions): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/zip" };
  if (options.token !== null && sameHost(target, options.baseUrl)) headers.Authorization = `Bearer ${options.token}`;
  if (options.etag !== undefined) headers["If-None-Match"] = options.etag;
  return headers;
}

async function readResponse(response: Response, options: PackageFetchOptions): Promise<FetchedPackage> {
  if (response.status === 304) return { bytes: new Uint8Array(), sha256: "", etag: options.etag ?? null, notModified: true };
  if (response.status === 401 || response.status === 403) {
    throw new PackageDownloadError("unauthorized", `技能包下载鉴权失败：HTTP ${response.status}`);
  }
  if (!response.ok) throw new PackageDownloadError("download_failed", `技能包下载失败：HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > options.maxBytes) {
    throw new PackageDownloadError("payload_too_large", `技能包超过大小上限：${length} > ${options.maxBytes}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > options.maxBytes) {
    throw new PackageDownloadError("payload_too_large", `技能包超过大小上限：${bytes.byteLength} > ${options.maxBytes}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = response.headers.get("x-checksum-sha256");
  if (expected !== null && expected !== sha256) {
    throw new PackageDownloadError("checksum_mismatch", "技能包摘要与 X-Checksum-Sha256 不一致");
  }
  return { bytes, sha256, etag: response.headers.get("etag") ?? null, notModified: false };
}

/** `C-05` 下载：跨 host 不带 token；`304` 视为缓存命中；按 `Content-Length` 与上限预检。 */
export async function fetchPackage(url: string, options: PackageFetchOptions): Promise<FetchedPackage> {
  const target = absolute(url, options.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(target, {
      headers: buildHeaders(target, options),
      signal: controller.signal,
    });
    return await readResponse(response, options);
  } catch (error) {
    if (error instanceof PackageDownloadError) throw error;
    throw new PackageDownloadError("download_failed", `技能包下载失败：${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 把下载内容写入缓存文件（`<cacheRoot>/<digest>.zip`）。 */
export async function writeCachedPackage(cacheRoot: string, digest: string, bytes: Uint8Array): Promise<string> {
  const path = `${cacheRoot}/${digest.replaceAll(/[^0-9a-zA-Z]/g, "-")}.zip`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}
