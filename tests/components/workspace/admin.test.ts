import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceAdmin } from "../../../src/components/workspace/admin.ts";

async function container(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "afc-ws-admin-"));
}

async function superproject(submodule: "initialized" | "empty"): Promise<string> {
  const root = await container();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".gitmodules"), `[submodule "uumail"]\n\tpath = uumail\n`);
  await mkdir(join(root, "uumail"));
  if (submodule === "initialized") {
    await writeFile(join(root, "uumail", ".git"), "gitdir: ../.git/modules/uumail\n");
    await writeFile(join(root, "uumail", "README.md"), "uumail\n");
  }
  return root;
}

function check(checks: Awaited<ReturnType<WorkspaceAdmin["diagnose"]>>, id: string) {
  return checks.find((item) => item.id === id);
}

describe("doctor 容器诊断", () => {
  test("superproject：容器通过并标 layout，未初始化子模块 warn", async () => {
    const root = await superproject("empty");
    const checks = await new WorkspaceAdmin().diagnose(root);
    const containerCheck = check(checks, "workspace.container");
    expect(containerCheck?.status).toBe("pass");
    expect(containerCheck?.detail).toBe("repos=0，layout=superproject");
    const submodules = check(checks, "workspace.submodules");
    expect(submodules?.status).toBe("warn");
    expect(submodules?.detail).toBe("子模块未初始化：uumail（目录为空）");
  });

  test("superproject 子模块已初始化：不产生子模块告警", async () => {
    const root = await superproject("initialized");
    const checks = await new WorkspaceAdmin().diagnose(root);
    expect(check(checks, "workspace.container")?.detail).toBe("repos=1，layout=superproject");
    expect(check(checks, "workspace.submodules")).toBeUndefined();
  });

  test("普通容器：layout=container，repos 计数不变", async () => {
    const root = await container();
    await mkdir(join(root, "repo-a", ".git"), { recursive: true });
    const checks = await new WorkspaceAdmin().diagnose(root);
    expect(check(checks, "workspace.container")?.detail).toBe("repos=1，layout=container");
    expect(check(checks, "workspace.submodules")).toBeUndefined();
  });

  test("根位于外层仓库：容器 fail，project root 上浮", async () => {
    const base = await container();
    await mkdir(join(base, ".git"));
    const root = join(base, "container");
    await mkdir(root);
    const checks = await new WorkspaceAdmin().diagnose(root);
    const containerCheck = check(checks, "workspace.container");
    expect(containerCheck?.status).toBe("fail");
    expect(containerCheck?.detail).toBe("容器根位于 git 仓库内，projectRoot 上浮");
    expect(containerCheck?.remediation).toBe("修正容器布局：位于任何仓库之外（工作区根可以是超项目）、.dsh 不是符号链接");
    expect(check(checks, "workspace.project_root")?.status).toBe("fail");
  });

  test(".dsh 是符号链接：容器 fail", async () => {
    const root = await container();
    const outside = await container();
    await symlink(outside, join(root, ".dsh"));
    const checks = await new WorkspaceAdmin().diagnose(root);
    expect(check(checks, "workspace.container")?.status).toBe("fail");
    expect(check(checks, "workspace.container")?.detail).toBe(".dsh 必须是容器内目录，不能是符号链接/文件");
  });
});
