import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWorkspace } from "../../../src/components/workspace/workspace.ts";
import { WorkspaceError } from "../../../src/components/workspace/errors.ts";
import type { InstanceHandle } from "../../../src/components/executor/ports.ts";

const instance: InstanceHandle = { instanceId: "i-1", pid: process.pid };

async function container(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "afc-ws-"));
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

  test("TC-EXEC-004 容器根有 .git 判 layout_invalid 且不创建 .dsh", async () => {
    const root = await container();
    await mkdir(join(root, ".git"));
    const workspace = new FileWorkspace();
    await expect(workspace.ensureContainer(instance, root)).rejects.toMatchObject({ code: "layout_invalid" });
    await expect(lstat(join(root, ".dsh"))).rejects.toThrow();
  });

  test("容器根位于外层仓库下判 layout_invalid", async () => {
    const base = await container();
    await mkdir(join(base, ".git"));
    const root = join(base, "container");
    await mkdir(root);
    const workspace = new FileWorkspace();
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
