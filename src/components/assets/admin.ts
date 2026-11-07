import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerPaths } from "../executor/ports.ts";
import type { CheckResult } from "../observability/doctor.ts";

/** L0 管理面：缓存/锁/暂存残留检查（CMP-assets §3.5）。 */
export class AssetAdmin {
  async diagnose(container?: ContainerPaths): Promise<CheckResult[]> {
    if (container === undefined) {
      return [{ id: "asset.container", title: "技能安装点", status: "none", detail: "未指定容器，跳过" }];
    }
    const digest = await stat(join(container.root, ".dsh", ".skills-digest"))
      .then(() => true)
      .catch(() => false);
    const lock = await stat(join(container.root, ".dsh", ".install.lock"))
      .then(() => true)
      .catch(() => false);
    return [
      {
        id: "asset.skills",
        title: "技能安装点",
        status: digest ? "pass" : "warn",
        detail: digest ? "已安装技能集" : "尚未安装技能集",
      },
      {
        id: "asset.lock",
        title: "技能安装锁",
        status: lock ? "warn" : "pass",
        detail: lock ? "存在 .install.lock（可能是残留）" : "无锁",
        ...(lock ? { remediation: "确认无安装进行后删除 .dsh/.install.lock" } : {}),
      },
    ];
  }
}
