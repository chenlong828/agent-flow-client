import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAssets } from "../../../src/components/assets/assets.ts";
import { assertSafeZipEntries } from "../../../src/components/assets/unpack.ts";
import { FileWorkspace } from "../../../src/components/workspace/workspace.ts";
import type { InstanceHandle } from "../../../src/components/executor/ports.ts";
import type { SkillSet } from "../../../src/components/executor/types.ts";

const instance: InstanceHandle = { instanceId: "i-c05", pid: process.pid };

async function makeZip(name: string): Promise<{ zip: Uint8Array; sha256: string; digest: string }> {
  const dir = await mkdtemp(join(tmpdir(), "afc-zip-"));
  await mkdir(join(dir, "alpha", "scripts"), { recursive: true });
  await writeFile(join(dir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: ALPHA\n---\n");
  await writeFile(join(dir, "alpha", "scripts", "run.sh"), "#!/bin/sh\necho ALPHA\n");
  await writeFile(join(dir, "flat.md"), "---\nname: flat\ndescription: FLAT\n---\n");
  const zipPath = join(dir, `${name}.zip`);
  const proc = Bun.spawn(["zip", "-qr", zipPath, "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  const zip = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
  const sha256 = createHash("sha256").update(zip).digest("hex");
  return { zip, sha256, digest: `sha256:${sha256}` };
}

function serveZip(zip: Uint8Array, sha256: string) {
  const seen: { authorization: string | null; ifNoneMatch: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      seen.push({
        authorization: request.headers.get("authorization"),
        ifNoneMatch: request.headers.get("if-none-match"),
      });
      return new Response(new Blob([new Uint8Array(zip)]), {
        headers: { "content-type": "application/zip", etag: '"v1"', "x-checksum-sha256": sha256 },
      });
    },
  });
  return { server, seen, url: `http://127.0.0.1:${server.port}` };
}

async function makeContainer(): Promise<Awaited<ReturnType<FileWorkspace["ensureContainer"]>>> {
  const root = await mkdtemp(join(tmpdir(), "afc-c05-"));
  return await new FileWorkspace().ensureContainer(instance, root);
}

function skillSet(digest: string, url: string, etag?: string): SkillSet {
  return {
    digest,
    packages: [
      { packageId: "p-1", name: "alpha", version: "1", digest, sizeBytes: 0, downloadUrl: url, ...(etag === undefined ? {} : { etag }) },
    ],
  };
}

describe("C-05 HTTP 下载与缓存", () => {
  test("下载 zip、校验、解包、脚本权限", async () => {
    const { zip, sha256, digest } = await makeZip("pkg");
    const { server, url } = serveZip(zip, sha256);
    const assets = new LocalAssets({}, { baseUrl: url, token: "scheduler-token", cacheRoot: join(tmpdir(), "afc-cache-1") });
    const container = await makeContainer();
    const installed = await assets.install(skillSet(digest, "/api/v1/executor/skill-packages/p-1/download"), container);
    expect(installed.skills.sort()).toEqual(["alpha", "flat"]);
    expect(await assets.currentDigest(container)).toBe(digest);
    server.stop(true);
  });

  test("同 digest 第二次安装命中本地缓存，不再下载", async () => {
    const { zip, sha256, digest } = await makeZip("pkg2");
    const { server, seen, url } = serveZip(zip, sha256);
    const cacheRoot = await mkdtemp(join(tmpdir(), "afc-cache-"));
    const assets = new LocalAssets({}, { baseUrl: url, token: "t", cacheRoot });
    const first = await makeContainer();
    await assets.install(skillSet(digest, "/api/v1/executor/skill-packages/p/download"), first);
    expect(seen).toHaveLength(1);
    const second = await makeContainer();
    await assets.install(skillSet(digest, "/api/v1/executor/skill-packages/p/download"), second);
    expect(seen).toHaveLength(1);
    expect((await readdir(join(second.skillRoot))).sort()).toEqual(["alpha", "flat.md"]);
    server.stop(true);
  });

  test("摘要不符判 checksum_mismatch", async () => {
    const { zip, sha256 } = await makeZip("pkg3");
    const { server, url } = serveZip(zip, sha256);
    const assets = new LocalAssets({}, { baseUrl: url, token: "t" });
    const container = await makeContainer();
    await expect(
      assets.install(skillSet(`sha256:${"0".repeat(64)}`, "/api/v1/executor/skill-packages/p/download"), container),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });
    server.stop(true);
  });

  test("跨 host 不带 Authorization", async () => {
    const { zip, sha256, digest } = await makeZip("pkg4");
    const { server, seen, url } = serveZip(zip, sha256);
    const assets = new LocalAssets({}, { baseUrl: url, token: "t" });
    const container = await makeContainer();
    // 127.0.0.1 与 localhost 在 URL host 上不同，构造跨 host 下载。
    await assets.install(skillSet(digest, `http://localhost:${server.port}/api/v1/executor/skill-packages/p/download`), container);
    expect(seen[0]?.authorization).toBeNull();
    server.stop(true);
  });

  test("超过大小上限判 download_failed", async () => {
    const { zip, sha256 } = await makeZip("pkg5");
    const { server, url } = serveZip(zip, sha256);
    const assets = new LocalAssets({ maxBytes: 16 }, { baseUrl: url, token: "t" });
    const container = await makeContainer();
    await expect(
      assets.install(skillSet(`sha256:${sha256}`, "/api/v1/executor/skill-packages/p/download"), container),
    ).rejects.toMatchObject({ code: "download_failed" });
    server.stop(true);
  });
});

describe("zip 条目安全", () => {
  test("拒绝绝对路径、.. 与盘符", () => {
    expect(() => assertSafeZipEntries(["alpha/SKILL.md"])).not.toThrow();
    expect(() => assertSafeZipEntries(["/etc/passwd"])).toThrow();
    expect(() => assertSafeZipEntries(["../evil.sh"])).toThrow();
    expect(() => assertSafeZipEntries(["a/../../evil"])).toThrow();
    expect(() => assertSafeZipEntries(["C:/evil"])).toThrow();
  });
});
