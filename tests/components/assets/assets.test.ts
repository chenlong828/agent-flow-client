import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalAssets } from "../../../src/components/assets/assets.ts";
import { FileWorkspace } from "../../../src/components/workspace/workspace.ts";
import { digestDirectory } from "../../../src/components/assets/digest.ts";
import type { InstanceHandle, SkillSet } from "../../../src/components/executor/ports.ts";

const instance: InstanceHandle = { instanceId: "i-1", pid: process.pid };

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function makeContainer(): Promise<{ root: string; container: Awaited<ReturnType<FileWorkspace["ensureContainer"]>> }> {
  const root = await mkdtemp(join(tmpdir(), "afc-assets-"));
  const workspace = new FileWorkspace();
  const container = await workspace.ensureContainer(instance, root);
  return { root, container };
}

async function makePackage(name: string): Promise<{ dir: string; digest: string; skillSet: SkillSet }> {
  const dir = await mkdtemp(join(tmpdir(), "afc-pkg-"));
  await mkdir(join(dir, "alpha", "scripts"), { recursive: true });
  await writeFile(join(dir, "alpha", "SKILL.md"), skill(name, "Outputs ALPHA."));
  await writeFile(join(dir, "alpha", "scripts", "run.sh"), "#!/bin/sh\necho ALPHA\n");
  await writeFile(join(dir, "alpha", "notes.txt"), "notes\n");
  await writeFile(join(dir, "flat.md"), skill("flat", "Outputs FLAT."));
  const digest = await digestDirectory(dir);
  return {
    dir,
    digest,
    skillSet: {
      digest,
      packages: [
        {
          packageId: "01930000-0000-7000-8000-000000000010",
          name,
          version: "1.0.0",
          digest,
          sizeBytes: 0,
          downloadUrl: pathToFileURL(dir).href,
        },
      ],
    },
  };
}

describe("技能安装", () => {
  test("首次安装：替换式落地、digest、脚本 0755、其他 0644", async () => {
    const { container } = await makeContainer();
    const pkg = await makePackage("alpha");
    const assets = new LocalAssets();
    const installed = await assets.install(pkg.skillSet, container);

    expect(installed.changed).toBe(true);
    expect(installed.skills.sort()).toEqual(["alpha", "flat"]);
    expect(await assets.currentDigest(container)).toBe(pkg.digest);
    expect((await lstat(join(container.skillRoot, "alpha", "scripts", "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(container.skillRoot, "alpha", "notes.txt"))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(container.skillRoot, "flat.md"), "utf8")).toContain("name: flat");
  });

  test("同 digest 重装是空操作", async () => {
    const { container } = await makeContainer();
    const pkg = await makePackage("alpha");
    const assets = new LocalAssets();
    await assets.install(pkg.skillSet, container);
    const again = await assets.install(pkg.skillSet, container);
    expect(again.changed).toBe(false);
    expect(again.skills.sort()).toEqual(["alpha", "flat"]);
  });

  test("切换技能集是替换不叠加", async () => {
    const { container } = await makeContainer();
    const first = await makePackage("alpha");
    const assets = new LocalAssets();
    await assets.install(first.skillSet, container);

    const second = await makePackage("beta");
    await assets.install(second.skillSet, container);
    const names = (await readdir(container.skillRoot)).sort();
    expect(names).toEqual(["alpha", "flat.md"]);
    expect(await readFile(join(container.skillRoot, "alpha", "SKILL.md"), "utf8")).toContain("name: beta");
  });

  test("缺 description 判 invalid_skill_format，旧技能集不被破坏", async () => {
    const { container } = await makeContainer();
    const good = await makePackage("alpha");
    const assets = new LocalAssets();
    await assets.install(good.skillSet, container);

    const badDir = await mkdtemp(join(tmpdir(), "afc-bad-"));
    await mkdir(join(badDir, "bad"));
    await writeFile(join(badDir, "bad", "SKILL.md"), "---\nname: bad\n---\n");
    const badDigest = await digestDirectory(badDir);
    const bad: SkillSet = {
      digest: badDigest,
      packages: [
        { packageId: "2", name: "bad", version: "1", digest: badDigest, sizeBytes: 0, downloadUrl: pathToFileURL(badDir).href },
      ],
    };
    await expect(assets.install(bad, container)).rejects.toMatchObject({ code: "invalid_skill_format" });
    expect(await assets.currentDigest(container)).toBe(good.digest);
    expect(await readFile(join(container.skillRoot, "alpha", "SKILL.md"), "utf8")).toContain("name: alpha");
  });

  test("嵌套 SKILL.md 判 invalid_skill_format", async () => {
    const { container } = await makeContainer();
    const dir = await mkdtemp(join(tmpdir(), "afc-nested-"));
    await mkdir(join(dir, "group", "nested"), { recursive: true });
    await writeFile(join(dir, "group", "nested", "SKILL.md"), skill("nested", "nested"));
    const digest = await digestDirectory(dir);
    const set: SkillSet = {
      digest,
      packages: [{ packageId: "3", name: "n", version: "1", digest, sizeBytes: 0, downloadUrl: pathToFileURL(dir).href }],
    };
    await expect(new LocalAssets().install(set, container)).rejects.toMatchObject({ code: "invalid_skill_format" });
  });

  test("包摘要不符判 checksum_mismatch", async () => {
    const { container } = await makeContainer();
    const pkg = await makePackage("alpha");
    const set: SkillSet = {
      ...pkg.skillSet,
      packages: [{ ...pkg.skillSet.packages[0]!, digest: `sha256:${"0".repeat(64)}` }],
    };
    await expect(new LocalAssets().install(set, container)).rejects.toMatchObject({ code: "checksum_mismatch" });
  });

  test("旧布局（平铺 SKILL.md）在缺少布局标记时重装为目录布局", async () => {
    const { container } = await makeContainer();
    const pkg = await makePackage("alpha");
    const assets = new LocalAssets();
    await assets.install(pkg.skillSet, container);
    expect(await readFile(join(container.root, ".dsh", ".skills-layout"), "utf8")).toBe("dir-v1");

    // 模拟旧客户端产物：平铺 SKILL.md + 相同 digest，但没有布局标记。
    await rm(container.skillRoot, { recursive: true, force: true });
    await mkdir(container.skillRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(container.skillRoot, "SKILL.md"), skill("alpha", "旧平铺"));
    await rm(join(container.root, ".dsh", ".skills-layout"));

    const again = await assets.install(pkg.skillSet, container);
    expect(again.changed).toBe(true);
    expect((await readdir(container.skillRoot)).sort()).toEqual(["alpha", "flat.md"]);
  });

  test("包内符号链接判 unpack_failed", async () => {
    const { container } = await makeContainer();
    const dir = await mkdtemp(join(tmpdir(), "afc-link-"));
    await mkdir(join(dir, "alpha"));
    await writeFile(join(dir, "alpha", "SKILL.md"), skill("alpha", "a"));
    await symlink("/etc/hosts", join(dir, "alpha", "link"));
    const digest = await digestDirectory(dir);
    const set: SkillSet = {
      digest,
      packages: [{ packageId: "4", name: "a", version: "1", digest, sizeBytes: 0, downloadUrl: pathToFileURL(dir).href }],
    };
    await expect(new LocalAssets().install(set, container)).rejects.toMatchObject({ code: "unpack_failed" });
  });
});
