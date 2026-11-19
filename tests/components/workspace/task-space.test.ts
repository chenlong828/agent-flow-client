import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWorkspace } from "../../../src/components/workspace/workspace.ts";

async function workspaceWithRoot(): Promise<{ root: string; workspace: FileWorkspace }> {
  const root = await mkdtemp(join(tmpdir(), "afc-task-space-"));
  return { root, workspace: new FileWorkspace() };
}

describe("task-space（C-10）", () => {
  test("位于工作区内：创建目录、不写内容", async () => {
    const { root, workspace } = await workspaceWithRoot();
    const target = join(root, ".agent-flow", "task", "run-1");
    const created = await workspace.ensureTaskSpace(root, target);
    expect(created.endsWith("run-1")).toBe(true);
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  test("工作区之外：拒绝并报 path_escape", async () => {
    const { root, workspace } = await workspaceWithRoot();
    const outside = join(tmpdir(), "afc-outside", "task");
    await expect(workspace.ensureTaskSpace(root, outside)).rejects.toMatchObject({ code: "path_escape" });
  });

  test("符号链接父目录逃逸：拒绝", async () => {
    const { root, workspace } = await workspaceWithRoot();
    const outside = await mkdtemp(join(tmpdir(), "afc-outside-"));
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(root, "link"));
    await expect(workspace.ensureTaskSpace(root, join(root, "link", "task"))).rejects.toMatchObject({ code: "path_escape" });
  });

  test("packTaskSpace 产出 tar.gz，条目相对根", async () => {
    const { root, workspace } = await workspaceWithRoot();
    const space = join(root, ".agent-flow", "task", "run-2");
    await mkdir(space, { recursive: true });
    await writeFile(join(space, "intent.md"), "hello\n");
    const target = join(root, "out.tar.gz");
    const packed = await workspace.packTaskSpace(space, target);
    expect(packed.bytes).toBeGreaterThan(0);
    const list = Bun.spawn(["tar", "tzf", target], { stdout: "pipe" });
    const entries = (await new Response(list.stdout).text()).split("\n").filter((line) => line !== "");
    expect(entries.some((entry) => entry.includes("intent.md"))).toBe(true);
    expect(entries.every((entry) => !entry.startsWith("/"))).toBe(true);
  });
});

describe("task-space 初始资料（EXE-06/07）", () => {
  async function space(): Promise<{ root: string; path: string; workspace: FileWorkspace }> {
    const root = await mkdtemp(join(tmpdir(), "afc-inputs-"));
    const path = join(root, ".agent-flow", "task", "run-1");
    const workspace = new FileWorkspace();
    await workspace.ensureTaskSpace(root, path);
    return { root, path, workspace };
  }

  test("ensureInputsDir：创建 inputs/（0700）并清理中断残留的 .part", async () => {
    const { path, workspace } = await space();
    const first = await workspace.inputs.ensureDir(path);
    await writeFile(join(first, ".a.png.123.part"), "partial");
    const dir = await workspace.inputs.ensureDir(path);
    expect(dir).toBe(await realpath(join(path, "inputs")));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual([]);
  });

  test("writeInput：内容落盘、只读 0400、无残留临时文件；inputStat 返回大小", async () => {
    const { path, workspace } = await space();
    await workspace.inputs.write(path, "01-界面截图.png", new Uint8Array([1, 2, 3]));
    const file = join(path, "inputs", "01-界面截图.png");
    expect(new Uint8Array(await Bun.file(file).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await stat(file)).mode & 0o777).toBe(0o400);
    expect(await readdir(join(path, "inputs"))).toEqual(["01-界面截图.png"]);
    expect(await workspace.inputs.stat(path, "01-界面截图.png")).toEqual({ size: 3 });
    expect(await workspace.inputs.stat(path, "缺失.png")).toBeNull();
  });

  test("writeInput：覆盖已有只读文件，大小随新内容更新", async () => {
    const { path, workspace } = await space();
    await workspace.inputs.write(path, "a.png", new Uint8Array([1]));
    await workspace.inputs.write(path, "a.png", new Uint8Array([1, 2, 3]));
    expect(await workspace.inputs.stat(path, "a.png")).toEqual({ size: 3 });
  });

  test("错误名：路径穿越、分隔符、绝对路径、隐藏名一律 path_escape", async () => {
    const { path, workspace } = await space();
    for (const name of ["../x.png", "a/b.png", "a\\b.png", "/tmp/x.png", ".hidden.png", ".."]) {
      await expect(workspace.inputs.write(path, name, new Uint8Array([1]))).rejects.toMatchObject({ code: "path_escape" });
    }
  });

  test("目标已是符号链接：inputStat / writeInput 拒绝（防止把图片引到工作区外）", async () => {
    const { root, path, workspace } = await space();
    const outside = join(root, "outside.png");
    await writeFile(outside, "outside");
    await workspace.inputs.ensureDir(path);
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(path, "inputs", "evil.png"));
    await expect(workspace.inputs.stat(path, "evil.png")).rejects.toMatchObject({ code: "path_escape" });
    await expect(workspace.inputs.write(path, "evil.png", new Uint8Array([1]))).rejects.toMatchObject({ code: "path_escape" });
  });

  test("inputs 目录本身是符号链接：拒绝", async () => {
    const { root, path } = await space();
    const outside = await mkdtemp(join(tmpdir(), "afc-inputs-outside-"));
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(path, "inputs"));
    await expect(new FileWorkspace().inputs.ensureDir(path)).rejects.toMatchObject({ code: "path_escape" });
    expect(await readdir(outside)).toEqual([]);
  });
});
