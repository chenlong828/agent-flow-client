import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AssetPort,
  ChecksumResult,
  ContainerPaths,
  InstalledSkills,
  SkillPackageRef,
  SkillSet,
} from "../executor/ports.ts";
import { AssetError } from "./errors.ts";
import { digestDirectory } from "./digest.ts";
import { copyTree, type CopyLimits } from "./copy.ts";
import { validateSkillsTree } from "./format.ts";
import { digestSlug, exists, installedNames } from "./installed.ts";
import { materializePackage } from "./package-source.ts";
import { mergePackageRoot } from "./skill-layout.ts";
import { resolveLocalSource } from "./local-source.ts";

const DEFAULT_LIMITS: CopyLimits = { maxBytes: 64 * 1024 * 1024, maxFiles: 10_000 };
/** 暂存区内「每包独立解包」的临时目录名；合并后立即删除，不进最终技能根。 */
const PACKAGES_DIRNAME = ".packages";
/** 技能目录布局版本：`<skills>/<name>/SKILL.md`。旧容器（平铺）靠它触发一次重装。 */
const SKILLS_LAYOUT = "dir-v1";

export type AssetOptions = {
  cacheRoot?: string;
  /** `P-03` 下载器；由组合根注入（serve 用 gateway，run 不提供）。 */
  download?: (pkg: { packageId: string; etag?: string; digest: string; sizeBytes: number }) => Promise<{
    bytes?: Uint8Array;
    notModified: boolean;
    sha256?: string;
  }>;
};
const LOCK_STALE_MS = 60_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * 技能集安装（CMP-assets）：S0 支持本地目录来源；替换不叠加、原子生效、
 * 失败回滚、同 digest 幂等、脚本落地即可执行。
 */
export class LocalAssets implements AssetPort {
  readonly #limits: CopyLimits;
  readonly #options: AssetOptions;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(limits: Partial<CopyLimits> = {}, options: AssetOptions = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#options = options;
  }

  async install(skillSet: SkillSet, container: ContainerPaths): Promise<InstalledSkills> {
    // 同一容器同一时刻只有一个安装临界区（C-03）；并发任务串行进入。
    const previous = this.#queues.get(container.root) ?? Promise.resolve();
    const run = previous.then(
      async () => await this.#installExclusive(skillSet, container),
      async () => await this.#installExclusive(skillSet, container),
    );
    this.#queues.set(container.root, run.catch(() => undefined));
    return await run;
  }

  async #installExclusive(skillSet: SkillSet, container: ContainerPaths): Promise<InstalledSkills> {
    const current = await this.currentDigest(container);
    if (current === skillSet.digest && (await this.#layoutCurrent(container)) && (await exists(container.skillRoot))) {
      return { digest: skillSet.digest, skills: await installedNames(container.skillRoot), changed: false };
    }

    const unlock = await this.#acquire(container, skillSet.digest);
    const staging = join(container.stagingRoot, digestSlug(skillSet.digest));
    try {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      // 每包先解到独立临时目录，再按技能名并入技能根：多个包不再共写同一个根，
      // 重名技能报冲突而不是静默覆盖（OQ-33）。
      const packagesRoot = join(staging, PACKAGES_DIRNAME);
      for (const [index, pkg] of skillSet.packages.entries()) {
        const packageRoot = join(packagesRoot, `${index}-${digestSlug(pkg.digest)}`);
        await mkdir(packageRoot, { recursive: true, mode: 0o700 });
        await materializePackage(pkg, packageRoot, this.#limits, this.#options);
        await mergePackageRoot(packageRoot, staging);
      }
      await rm(packagesRoot, { recursive: true, force: true });
      const report = await validateSkillsTree(staging);
      await this.#swap(container, staging, skillSet.digest);
      return { digest: skillSet.digest, skills: report.skills, changed: true };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await unlock();
    }
  }

  async verify(pkg: SkillPackageRef): Promise<ChecksumResult> {
    const source = await resolveLocalSource(pkg.source);
    const digest = await digestDirectory(source);
    return { ok: digest === pkg.checksum, digest };
  }

  async currentDigest(container: ContainerPaths): Promise<string | null> {
    try {
      const text = (await readFile(join(container.root, ".dsh", ".skills-digest"), "utf8")).trim();
      return text === "" ? null : text;
    } catch {
      return null;
    }
  }

  async #layoutCurrent(container: ContainerPaths): Promise<boolean> {
    try {
      const text = (await readFile(join(container.root, ".dsh", ".skills-layout"), "utf8")).trim();
      return text === SKILLS_LAYOUT;
    } catch {
      return false;
    }
  }

  async #acquire(container: ContainerPaths, digest: string): Promise<() => Promise<void>> {
    const path = join(container.root, ".dsh", ".install.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, digest, startedAt: new Date().toISOString() }));
        await handle.close();
        return async () => {
          await unlink(path).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new AssetError("io_error", `创建安装锁失败：${(error as Error).message}`);
        }
        const info = await stat(path).catch(() => null);
        if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        throw new AssetError("io_error", `技能安装锁被占用：${path}`);
      }
    }
    throw new AssetError("io_error", `无法取得技能安装锁：${path}`);
  }

  async #swap(container: ContainerPaths, staging: string, digest: string): Promise<void> {
    const previous = join(container.root, ".dsh", ".skills.previous");
    await rm(previous, { recursive: true, force: true });
    const hadSkills = await exists(container.skillRoot);
    if (hadSkills) await rename(container.skillRoot, previous);
    try {
      await rename(staging, container.skillRoot);
    } catch (error) {
      if (hadSkills) await rename(previous, container.skillRoot).catch(() => undefined);
      throw new AssetError("io_error", `技能集替换失败：${(error as Error).message}`);
    }
    await rm(previous, { recursive: true, force: true }).catch(() => undefined);
    // 标记在技能树就位后写：写失败不回滚已生效的技能，只让下次任务重装（fail-safe）。
    try {
      await writeFile(join(container.root, ".dsh", ".skills-digest"), digest, { mode: 0o600 });
      await writeFile(join(container.root, ".dsh", ".skills-layout"), SKILLS_LAYOUT, { mode: 0o600 });
    } catch (error) {
      throw new AssetError("io_error", `技能集标记写入失败：${(error as Error).message}`);
    }
  }
}
