import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ContainerPaths } from "../executor/ports.ts";
import type { CheckResult } from "../observability/doctor.ts";
import { findProjectRoot } from "./project-root.ts";
import { FileWorkspace } from "./workspace.ts";

/** L0 管理面：`doctor` 检查容器布局；只读，不创建目录（CMP-workspace §3.4）。 */
export class WorkspaceAdmin {
  async diagnose(target: string | ContainerPaths): Promise<CheckResult[]> {
    const root = typeof target === "string" ? target : target.root;
    const container: ContainerPaths =
      typeof target === "string"
        ? { root, skillRoot: join(root, ".dsh", "skills"), stagingRoot: join(root, ".dsh", ".staging") }
        : target;
    const report = await new FileWorkspace().validate(container);
    const projectRoot = findProjectRoot(root);
    const writable = await access(root, constants.R_OK | constants.W_OK)
      .then(() => true)
      .catch(() => false);
    const checks: CheckResult[] = [
      {
        id: "workspace.container",
        title: "容器布局",
        status: report.ok ? "pass" : "fail",
        detail: report.ok ? `repos=${report.repos.length}，layout=${report.layout}` : report.issues.join("；"),
        ...(report.ok
          ? {}
          : { remediation: "修正容器布局：位于任何仓库之外（工作区根可以是超项目）、.dsh 不是符号链接" }),
      },
    ];
    if (report.warnings.length > 0) {
      checks.push({
        id: "workspace.submodules",
        title: "子模块",
        status: "warn",
        detail: report.warnings.join("；"),
      });
    }
    checks.push(
      {
        id: "workspace.project_root",
        title: "project root 不上浮",
        status: projectRoot === root ? "pass" : "fail",
        detail: `findProjectRoot=${projectRoot}`,
        ...(projectRoot === root ? {} : { remediation: "把容器移出所在 git 仓库（容器根自身可以是仓库或超项目）" }),
      },
      {
        id: "workspace.writable",
        title: "容器可写",
        status: writable ? "pass" : "fail",
        detail: writable ? "可写" : "不可写",
        ...(writable ? {} : { remediation: "修正目录权限" }),
      },
      {
        id: "workspace.staging",
        title: "暂存残留",
        status: "pass",
        detail: container.stagingRoot,
      },
    );
    return checks;
  }
}
