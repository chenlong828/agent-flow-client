import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "../observability/doctor.ts";
import { listSessionDirs } from "./runtime-instance.ts";

/** L0 管理面：实例 home、profile 补丁与残留 session（CMP-runtime §3.4）。 */
export class RuntimeAdmin {
  async diagnose(homeDir: string): Promise<CheckResult[]> {
    const patch = await stat(join(homeDir, "af", "profile.skill-patch.yml"))
      .then(() => true)
      .catch(() => false);
    const sessions = await listSessionDirs(homeDir);
    return [
      {
        id: "session.residue",
        title: "残留 session",
        status: sessions.length === 0 ? "pass" : "warn",
        detail: sessions.length === 0 ? "无" : `${sessions.length} 个持久化 session（只报告，不删除）`,
        ...(sessions.length === 0 ? {} : { remediation: "确认不再需要后清理实例 DSH_HOME 下的 sessions" }),
      },
      {
        id: "runtime.patch",
        title: "profile 补丁",
        status: patch ? "pass" : "warn",
        detail: patch ? join(homeDir, "af", "profile.skill-patch.yml") : "尚未生成（首次执行时创建）",
      },
    ];
  }
}
