import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, stat, writeFile, mkdir } from "node:fs/promises";
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
