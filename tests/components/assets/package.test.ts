import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAssets, type AssetOptions } from "../../../src/components/assets/assets.ts";
import { FileWorkspace } from "../../../src/components/workspace/workspace.ts";
import type { InstanceHandle } from "../../../src/components/executor/ports.ts";
import type { SkillSet } from "../../../src/components/executor/types.ts";

const instance: InstanceHandle = { instanceId: "i-pkg", pid: process.pid };

async function makeZip(): Promise<{ bytes: Uint8Array; sha256: string; digest: string }> {
  const dir = await mkdtemp(join(tmpdir(), "afc-v2-zip-"));
  await mkdir(join(dir, "alpha", "scripts"), { recursive: true });
  await writeFile(join(dir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: ALPHA\n---\n");
  await writeFile(join(dir, "alpha", "scripts", "run.sh"), "#!/bin/sh\necho ALPHA\n");
  await writeFile(join(dir, "flat.md"), "---\nname: flat\ndescription: FLAT\n---\n");
  const zipPath = join(dir, "pkg.zip");
  const proc = Bun.spawn(["zip", "-qr", zipPath, "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  const bytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, digest: `sha256:${sha256}` };
}

async function container(): Promise<Awaited<ReturnType<FileWorkspace["ensureContainer"]>>> {
  const root = await mkdtemp(join(tmpdir(), "afc-v2-c05-"));
  return await new FileWorkspace().ensureContainer(instance, root);
}

function skillSet(digest: string): SkillSet {
  return {
    digest,
    packages: [{ packageId: "p-1", name: "alpha", version: "1", digest, sizeBytes: 0, downloadUrl: "/api/v1/executor/skill-packages/p-1" }],
  };
}

function downloader(bytes: Uint8Array, sha256: string, calls: { count: number }): NonNullable<AssetOptions["download"]> {
  return async () => {
    calls.count += 1;
    return { bytes, notModified: false, sha256 };
  };
}

describe("P-03 技能包落地", () => {
  test("下载 zip、解包、脚本权限、digest 记录", async () => {
    const { bytes, sha256, digest } = await makeZip();
    const calls = { count: 0 };
    const assets = new LocalAssets({}, { download: downloader(bytes, sha256, calls) });
    const target = await container();
    const installed = await assets.install(skillSet(digest), target);
    expect(installed.skills.sort()).toEqual(["alpha", "flat"]);
    expect(await assets.currentDigest(target)).toBe(digest);
    expect(calls.count).toBe(1);
  });

  test("同 digest 缓存命中，不再下载", async () => {
    const { bytes, sha256, digest } = await makeZip();
    const calls = { count: 0 };
    const cacheRoot = await mkdtemp(join(tmpdir(), "afc-v2-cache-"));
    const assets = new LocalAssets({}, { cacheRoot, download: downloader(bytes, sha256, calls) });
    await assets.install(skillSet(digest), await container());
    await assets.install(skillSet(digest), await container());
    expect(calls.count).toBe(1);
  });

  test("摘要不符判 checksum_mismatch", async () => {
    const { bytes, sha256 } = await makeZip();
    const assets = new LocalAssets({}, { download: downloader(bytes, sha256, { count: 0 }) });
    await expect(assets.install(skillSet(`sha256:${"0".repeat(64)}`), await container())).rejects.toMatchObject({
      code: "checksum_mismatch",
    });
  });

  test("304 但无缓存判 download_failed", async () => {
    const assets = new LocalAssets({}, { download: async () => ({ notModified: true }) });
    await expect(assets.install(skillSet("sha256:x"), await container())).rejects.toMatchObject({ code: "download_failed" });
  });
});
