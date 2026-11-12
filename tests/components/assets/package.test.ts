import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
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

function skillSet(digest: string, etag?: string): SkillSet {
  return {
    digest,
    packages: [{
      packageId: "p-1",
      name: "alpha",
      version: "1",
      digest,
      sizeBytes: 0,
      downloadUrl: "/api/v1/executor/skill-packages/p-1",
      ...(etag === undefined ? {} : { etag }),
    }],
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

  test("缓存未命中时不做条件请求：先清空任务 etag 再下载", async () => {
    const { bytes, sha256 } = await makeZip();
    const seen: Array<string | undefined> = [];
    const assets = new LocalAssets({}, {
      download: async (pkg) => {
        seen.push(pkg.etag);
        // 模拟 P-03：带 If-None-Match 且命中 → 304；无条件下载 → 200 全文。
        return pkg.etag === undefined ? { bytes, notModified: false, sha256 } : { notModified: true };
      },
    });
    const installed = await assets.install(skillSet(`sha256:${sha256}`, '"sha256-abc"'), await container());
    expect(seen).toEqual([undefined]);
    expect(installed.skills.sort()).toEqual(["alpha", "flat"]);
  });

  test("304 但无缓存判 download_failed", async () => {
    const assets = new LocalAssets({}, { download: async () => ({ notModified: true }) });
    await expect(assets.install(skillSet("sha256:x"), await container())).rejects.toMatchObject({ code: "download_failed" });
  });
});

/** 编排侧真实包形状：zip 根就是 `SKILL.md`（附件在 `scripts/`、`references/`）。 */
async function rootSkillZip(files: Record<string, string>): Promise<{ bytes: Uint8Array; sha256: string }> {
  const dir = await mkdtemp(join(tmpdir(), "afc-root-zip-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
    if (path.startsWith("scripts/")) await chmod(target, 0o755);
  }
  const zipPath = join(dir, "pkg.zip");
  const order = ["SKILL.md", ...Object.keys(files).filter((path) => path !== "SKILL.md")];
  const proc = Bun.spawn(["zip", "-q", "-X", zipPath, ...order], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  const bytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function rootSkill(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} 的说明\n---\n${body}\n`;
}

describe("OQ-33 多包安装布局", () => {
  function multi(packages: { bytes: Uint8Array; sha256: string }[]): { set: SkillSet; downloads: Map<string, { bytes: Uint8Array; sha256: string }> } {
    const refs = packages.map((pkg, index) => ({
      packageId: `p-${index}`,
      name: `展示名 ${index}`,
      version: "1",
      digest: `sha256:${pkg.sha256}`,
      sizeBytes: pkg.bytes.byteLength,
      downloadUrl: `/api/v1/executor/skill-packages/p-${index}`,
    }));
    const digest = `sha256:${createHash("sha256").update(refs.map((item) => item.digest).join("")).digest("hex")}`;
    return { set: { digest, packages: refs }, downloads: new Map(refs.map((ref, index) => [ref.packageId, packages[index]!])) };
  }

  function assetsFor(downloads: Map<string, { bytes: Uint8Array; sha256: string }>): LocalAssets {
    return new LocalAssets({}, {
      download: async (pkg) => {
        const entry = downloads.get(pkg.packageId)!;
        return { bytes: entry.bytes, notModified: false, sha256: entry.sha256 };
      },
    });
  }

  test("两个包各自落到 <name>/ 目录，互不覆盖", async () => {
    const first = await rootSkillZip({ "SKILL.md": rootSkill("req-scenario-spec", "A 正文") });
    const second = await rootSkillZip({ "SKILL.md": rootSkill("design-before-coding", "B 正文") });
    const { set, downloads } = multi([first, second]);
    const target = await container();
    const installed = await assetsFor(downloads).install(set, target);

    expect(installed.skills.sort()).toEqual(["design-before-coding", "req-scenario-spec"]);
    expect((await readdir(target.skillRoot)).sort()).toEqual(["design-before-coding", "req-scenario-spec"]);
    const a = await Bun.file(join(target.skillRoot, "req-scenario-spec", "SKILL.md")).text();
    const b = await Bun.file(join(target.skillRoot, "design-before-coding", "SKILL.md")).text();
    expect(a).toContain("A 正文");
    expect(b).toContain("B 正文");
  });

  test("包内 scripts/references 落在技能目录内，脚本保持可执行", async () => {
    const zip = await rootSkillZip({
      "SKILL.md": rootSkill("with-assets", "正文"),
      "scripts/run.sh": "#!/bin/sh\necho TOKEN\n",
      "references/notes.md": "参考资料",
    });
    const { set, downloads } = multi([zip]);
    const target = await container();
    const installed = await assetsFor(downloads).install(set, target);

    expect(installed.skills).toEqual(["with-assets"]);
    const skillDir = join(target.skillRoot, "with-assets");
    expect(await Bun.file(join(skillDir, "references", "notes.md")).text()).toBe("参考资料");
    const mode = (await lstat(join(skillDir, "scripts", "run.sh"))).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  });

  test("两个包同名技能判 invalid_skill_format，旧技能集不被破坏", async () => {
    const good = await rootSkillZip({ "SKILL.md": rootSkill("alpha", "旧") });
    const target = await container();
    const goodMulti = multi([good]);
    await assetsFor(goodMulti.downloads).install(goodMulti.set, target);

    const dupA = await rootSkillZip({ "SKILL.md": rootSkill("dup", "A") });
    const dupB = await rootSkillZip({ "SKILL.md": rootSkill("dup", "B") });
    const { set, downloads } = multi([dupA, dupB]);
    const error = await assetsFor(downloads).install(set, target).catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe("invalid_skill_format");
    expect((error as Error).message).toContain("技能名冲突：dup");
    expect(await readdir(target.skillRoot)).toEqual(["alpha"]);
  });
});
