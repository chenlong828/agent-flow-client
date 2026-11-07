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
    return [
      {
        id: "workspace.container",
        title: "容器布局",
        status: report.ok ? "pass" : "fail",
        detail: report.ok ? `repos=${report.repos.length}` : report.issues.join("；"),
        ...(report.ok ? {} : { remediation: "修正容器布局：根无 .git、位于任何仓库之外、.dsh 不是符号链接" }),
      },
      {
        id: "workspace.project_root",
        title: "project root 不上浮",
        status: projectRoot === root ? "pass" : "fail",
        detail: `findProjectRoot=${projectRoot}`,
        ...(projectRoot === root ? {} : { remediation: "把容器移到任何 git 仓库之外" }),
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
    ];
  }
}
