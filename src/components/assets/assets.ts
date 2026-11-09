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
import { resolveLocalSource } from "./local-source.ts";

const DEFAULT_LIMITS: CopyLimits = { maxBytes: 64 * 1024 * 1024, maxFiles: 10_000 };

export type AssetOptions = {
  cacheRoot?: string;
  baseUrl?: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
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

  constructor(limits: Partial<CopyLimits> = {}, options: AssetOptions = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#options = options;
  }

  async install(skillSet: SkillSet, container: ContainerPaths): Promise<InstalledSkills> {
    const current = await this.currentDigest(container);
    if (current === skillSet.digest && (await exists(container.skillRoot))) {
      return { digest: skillSet.digest, skills: await installedNames(container.skillRoot), changed: false };
    }

    const unlock = await this.#acquire(container, skillSet.digest);
    const staging = join(container.stagingRoot, digestSlug(skillSet.digest));
    try {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      for (const pkg of skillSet.packages) {
        await materializePackage(pkg, staging, this.#limits, this.#options);
      }
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
      await writeFile(join(container.root, ".dsh", ".skills-digest"), digest, { mode: 0o600 });
      await rm(previous, { recursive: true, force: true });
    } catch (error) {
      await rm(container.skillRoot, { recursive: true, force: true }).catch(() => undefined);
      if (hadSkills) await rename(previous, container.skillRoot).catch(() => undefined);
      throw new AssetError("io_error", `技能集替换失败：${(error as Error).message}`);
    }
  }
}
