import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CleanupPolicy,
  ContainerPaths,
  InstanceHandle,
  InstanceId,
  LayoutReport,
  WorkspacePort,
} from "../executor/ports.ts";
import { findProjectRoot } from "./project-root.ts";
import { WorkspaceError } from "./errors.ts";

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function pathKind(path: string): Promise<"missing" | "dir" | "file" | "symlink"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    return info.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

const CLEAN_TARGETS = [".dsh/skills", ".dsh/.staging", ".dsh/.skills.previous", ".dsh/.skills-digest", ".dsh/.install.lock"];

/**
 * 工作区容器（CMP-workspace）：校验预置容器、约束路径、安装点与清理。
 * client 只写 `.dsh` 下自己生成的内容（不 clone、不检出、不建仓库）。
 */
export class FileWorkspace implements WorkspacePort {
  readonly #containers = new Map<InstanceId, ContainerPaths>();

  async ensureContainer(instance: InstanceHandle, path: string): Promise<ContainerPaths> {
    const root = await this.#root(path);
    const container: ContainerPaths = {
      root,
      skillRoot: join(root, ".dsh", "skills"),
      stagingRoot: join(root, ".dsh", ".staging"),
    };
    const report = await this.validate(container);
    if (!report.ok) throw new WorkspaceError("layout_invalid", report.issues.join("；"));
    try {
      await mkdir(join(root, ".dsh"), { recursive: true, mode: 0o700 });
      await mkdir(container.stagingRoot, { recursive: true, mode: 0o700 });
      await access(root, constants.W_OK);
    } catch (error) {
      throw new WorkspaceError("permission_denied", `容器不可写：${(error as Error).message}`);
    }
    this.#containers.set(instance.instanceId, container);
    return container;
  }

  async validate(container: ContainerPaths): Promise<LayoutReport> {
    const issues: string[] = [];
    if ((await pathKind(container.root)) !== "dir") {
      issues.push(`容器根不存在或不是目录：${container.root}`);
    } else {
      if (findProjectRoot(container.root) !== container.root) {
        issues.push("容器根位于 git 仓库内，projectRoot 上浮");
      }
      if ((await pathKind(join(container.root, ".git"))) !== "missing") {
        issues.push("容器根不应有 .git");
      }
      const dshKind = await pathKind(join(container.root, ".dsh"));
      if (dshKind === "symlink" || dshKind === "file") issues.push(".dsh 必须是容器内目录，不能是符号链接/文件");
    }
    const repos = await readRepos(container.root);
    return { ok: issues.length === 0, root: container.root, repos, issues };
  }

  /** 绝对路径 + 位于工作区之下（含符号链接逃逸检查）；不创建。 */
  async assertInsideWorkspace(workspaceRoot: string, path: string): Promise<string> {
    if (!isAbsolute(path)) throw new WorkspaceError("not_prepared", `必须是绝对路径：${path}`);
    const root = resolve(workspaceRoot);
    const target = resolve(path);
    const lexical = relative(root, target);
    if (lexical.startsWith("..") || isAbsolute(lexical)) {
      throw new WorkspaceError("path_escape", `路径越界：${path}`);
    }
    // `/var` → `/private/var` 这类系统符号链接：两侧都用「最近存在祖先的真实路径」比较，避免误判。
    const realRoot = await this.#realAncestor(root);
    const realAncestor = await this.#realAncestor(target);
    if (!inside(realAncestor, realRoot)) {
      throw new WorkspaceError("path_escape", `符号链接逃逸：${path}`);
    }
    return target;
  }

  async #realAncestor(path: string): Promise<string> {
    let ancestor = path;
    while ((await lstat(ancestor).catch(() => null)) === null) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return await realpath(ancestor).catch(() => ancestor);
  }

  /** `C-10`：校验后确保目录存在；只建目录、不写内容。 */
  async ensureTaskSpace(workspaceRoot: string, taskSpacePath: string): Promise<string> {
    const target = await this.assertInsideWorkspace(workspaceRoot, taskSpacePath);
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new WorkspaceError("permission_denied", `创建 task-space 失败：${(error as Error).message}`);
    }
    const real = await realpath(target).catch(() => target);
    if (!inside(real, await realpath(workspaceRoot).catch(() => resolve(workspaceRoot)))) {
      throw new WorkspaceError("path_escape", `task-space 逃逸工作区：${taskSpacePath}`);
    }
    return real;
  }

  /** `P-05`：tar.gz 打包 task-space，条目相对根。 */
  async packTaskSpace(taskSpacePath: string, targetPath: string): Promise<{ path: string; bytes: number }> {
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    const child = Bun.spawn(["tar", "czf", targetPath, "-C", taskSpacePath, "."], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new WorkspaceError("pack_failed", `打包 task-space 失败：${stderr.trim()}`);
    const info = await stat(targetPath);
    return { path: targetPath, bytes: info.size };
  }

  async resolve(container: ContainerPaths, relPath: string): Promise<string> {
    const target = resolve(container.root, relPath);
    if (!inside(target, container.root)) throw new WorkspaceError("path_escape", `路径越界：${relPath}`);
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      const parent = await realpath(dirname(target)).catch(() => dirname(target));
      real = join(parent, basename(target));
    }
    if (!inside(real, container.root)) throw new WorkspaceError("path_escape", `符号链接逃逸：${relPath}`);
    return real;
  }

  async cleanup(instance: InstanceHandle, policy: CleanupPolicy): Promise<void> {
    if (policy === "keep") return;
    const container = this.#containers.get(instance.instanceId);
    if (container === undefined) return;
    for (const rel of CLEAN_TARGETS) {
      await rm(join(container.root, rel), { recursive: true, force: true }).catch(() => undefined);
    }
    if (policy === "clean-client") this.#containers.delete(instance.instanceId);
  }

  async #root(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new WorkspaceError("not_prepared", `容器路径必须是绝对路径：${path}`);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new WorkspaceError("not_prepared", `容器不存在或不是目录：${path}`);
    }
    return await realpath(path);
  }
}

async function readRepos(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if ((await pathKind(join(root, entry.name, ".git"))) !== "missing") repos.push(entry.name);
  }
  return repos;
}
