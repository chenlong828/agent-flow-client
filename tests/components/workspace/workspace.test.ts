import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWorkspace } from "../../../src/components/workspace/workspace.ts";
import { WorkspaceError } from "../../../src/components/workspace/errors.ts";
import type { ContainerPaths, InstanceHandle } from "../../../src/components/executor/ports.ts";

const instance: InstanceHandle = { instanceId: "i-1", pid: process.pid };

async function container(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "afc-ws-"));
}

function paths(root: string): ContainerPaths {
  return { root, skillRoot: join(root, ".dsh", "skills"), stagingRoot: join(root, ".dsh", ".staging") };
}

/** 夹具：根是 git 超项目，`.gitmodules` 声明子模块 uumail。 */
async function superproject(submodule: "initialized" | "empty" | "no-git" | "missing"): Promise<string> {
  const root = await container();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".gitmodules"), `[submodule "uumail"]\n\tpath = uumail\n\turl = https://example.com/uumail.git\n`);
  if (submodule !== "missing") await mkdir(join(root, "uumail"));
  if (submodule === "initialized") {
    await writeFile(join(root, "uumail", ".git"), "gitdir: ../.git/modules/uumail\n");
    await writeFile(join(root, "uumail", "README.md"), "uumail\n");
  } else if (submodule === "no-git") {
    await writeFile(join(root, "uumail", "README.md"), "uumail\n");
  }
  return root;
}

describe("容器校验", () => {
  test("合法容器创建 .dsh 与暂存目录", async () => {
    const root = await container();
    const workspace = new FileWorkspace();
    const paths = await workspace.ensureContainer(instance, root);
    expect(paths.root).toBe(await realpath(root));
    expect(paths.skillRoot).toBe(join(await realpath(root), ".dsh", "skills"));
    expect((await lstat(join(await realpath(root), ".dsh"))).isDirectory()).toBe(true);
    expect((await lstat(paths.stagingRoot)).isDirectory()).toBe(true);
    expect((await workspace.validate(paths)).ok).toBe(true);
  });

  test("根是 superproject（.git 目录 + .gitmodules + 已初始化子模块）通过且无告警", async () => {
    const root = await superproject("initialized");
    const workspace = new FileWorkspace();
    const report = await workspace.validate(paths(root));
    expect(report.ok).toBe(true);
    expect(report.layout).toBe("superproject");
    expect(report.warnings).toEqual([]);
    const created = await workspace.ensureContainer(instance, root);
    expect(created.root).toBe(await realpath(root));
    expect((await lstat(join(await realpath(root), ".dsh"))).isDirectory()).toBe(true);
  });

  test("superproject 子模块目录为空：ok=true，warnings 报子模块未初始化", async () => {
    const root = await superproject("empty");
    const workspace = new FileWorkspace();
    const report = await workspace.validate(paths(root));
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(["子模块未初始化：uumail（目录为空）"]);
    const created = await workspace.ensureContainer(instance, root);
    expect(created.root).toBe(await realpath(root));
  });

  test("superproject 子模块缺 .git：ok=true，warnings 报子模块未初始化", async () => {
    const root = await superproject("no-git");
    const report = await new FileWorkspace().validate(paths(root));
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(["子模块未初始化：uumail（缺少 .git）"]);
  });

  test("superproject 子模块目录不存在：ok=true，warnings 报子模块未初始化", async () => {
    const root = await superproject("missing");
    const report = await new FileWorkspace().validate(paths(root));
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(["子模块未初始化：uumail（目录不存在）"]);
  });

  test("根 .git 是文件（worktree/子模块指针）也接受", async () => {
    const root = await container();
    await writeFile(join(root, ".git"), "gitdir: ../.git/worktrees/container\n");
    const report = await new FileWorkspace().validate(paths(root));
    expect(report.ok).toBe(true);
    expect(report.layout).toBe("container");
    expect(report.warnings).toEqual([]);
  });

  test("根不是仓库、子目录是仓库：通过且 repos 列出子仓库", async () => {
    const root = await container();
    await mkdir(join(root, "repo-a", ".git"), { recursive: true });
    const report = await new FileWorkspace().validate(paths(root));
    expect(report.ok).toBe(true);
    expect(report.layout).toBe("container");
    expect(report.repos).toEqual(["repo-a"]);
    expect(report.warnings).toEqual([]);
  });

  test("容器根位于外层仓库下仍判 layout_invalid，文案不变", async () => {
    const base = await container();
    await mkdir(join(base, ".git"));
    const root = join(base, "container");
    await mkdir(root);
    const workspace = new FileWorkspace();
    const error = await workspace.ensureContainer(instance, root).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error).toMatchObject({ code: "layout_invalid" });
    expect((error as WorkspaceError).message).toBe("容器根位于 git 仓库内，projectRoot 上浮");
  });

  test(".dsh 是符号链接仍判 layout_invalid", async () => {
    const root = await container();
    const outside = await container();
    await symlink(outside, join(root, ".dsh"));
    const workspace = new FileWorkspace();
    const report = await workspace.validate(paths(root));
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([".dsh 必须是容器内目录，不能是符号链接/文件"]);
    await expect(workspace.ensureContainer(instance, root)).rejects.toMatchObject({ code: "layout_invalid" });
  });

  test("不存在或非绝对路径判 not_prepared", async () => {
    const workspace = new FileWorkspace();
    await expect(workspace.ensureContainer(instance, "relative")).rejects.toMatchObject({ code: "not_prepared" });
    await expect(workspace.ensureContainer(instance, join(tmpdir(), "afc-missing-container"))).rejects.toMatchObject({
      code: "not_prepared",
    });
  });
});

describe("路径约束", () => {
  test("容器内路径可解析，.. 与符号链接逃逸被拒绝", async () => {
    const root = await container();
    const workspace = new FileWorkspace();
    const paths = await workspace.ensureContainer(instance, root);
    await mkdir(join(root, "repo-a"));
    await writeFile(join(root, "repo-a", "file.txt"), "x");
    expect(await workspace.resolve(paths, "repo-a/file.txt")).toBe(await realpath(join(root, "repo-a", "file.txt")));
    await expect(workspace.resolve(paths, "../outside")).rejects.toBeInstanceOf(WorkspaceError);

    const outside = await container();
    await symlink(outside, join(root, "escape"));
    await expect(workspace.resolve(paths, "escape")).rejects.toMatchObject({ code: "path_escape" });
  });
});

describe("清理", () => {
  test("clean-skills 删除安装点与暂存，保留预置仓库；幂等", async () => {
    const root = await container();
    const workspace = new FileWorkspace();
    const paths = await workspace.ensureContainer(instance, root);
    await mkdir(paths.skillRoot, { recursive: true });
    await writeFile(join(paths.skillRoot, "x.md"), "x");
    await writeFile(join(root, ".dsh", ".skills-digest"), "sha256:x");
    await mkdir(join(root, "repo-a"));
    await writeFile(join(root, "repo-a", "keep.txt"), "keep");

    await workspace.cleanup(instance, "clean-skills");
    await expect(lstat(paths.skillRoot)).rejects.toThrow();
    await expect(lstat(paths.stagingRoot)).rejects.toThrow();
    expect(await readFile(join(root, "repo-a", "keep.txt"), "utf8")).toBe("keep");
    await workspace.cleanup(instance, "clean-skills");
  });

  test("keep 策略不动容器", async () => {
    const root = await container();
    const workspace = new FileWorkspace();
    const paths = await workspace.ensureContainer(instance, root);
    await mkdir(paths.skillRoot);
    await workspace.cleanup(instance, "keep");
    expect((await lstat(paths.skillRoot)).isDirectory()).toBe(true);
  });
});

describe("不可写容器", () => {
  test("容器不可写判 permission_denied", async () => {
    const root = await container();
    const workspace = new FileWorkspace();
    await chmod(root, 0o500);
    await expect(workspace.ensureContainer(instance, root)).rejects.toMatchObject({ code: "permission_denied" });
    await chmod(root, 0o700);
  });
});
