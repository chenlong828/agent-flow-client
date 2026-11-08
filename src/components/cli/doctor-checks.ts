import { statSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "./config.ts";
import { isUserDshPath } from "./config.ts";
import type { CheckResult } from "../observability/doctor.ts";
import { resolveDshCommand, dshCommandExists, probeDshVersion } from "../runtime/dsh.ts";
import { findProjectRoot } from "../workspace/project-root.ts";
import { FileStore } from "../store/store.ts";
import { StoreAdmin } from "../store/admin.ts";
import { RuntimeAdmin } from "../runtime/admin.ts";

export type DoctorOptions = {
  config: AppConfig;
  env: Record<string, string | undefined>;
  workspacePath?: string;
  homeDir?: string;
};

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await Bun.file(path).stat();
    return info.isDirectory();
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function credentialsConfigured(config: AppConfig, env: Record<string, string | undefined>): Promise<boolean> {
  for (const key of ["HUNDSUN_PUBLIC_API_KEY", "DEEPSEEK_API_KEY"]) {
    if ((env[key] ?? "").trim() !== "") return true;
  }
  return fileExists(join(config.acp.dshHome, ".credentials.yaml"));
}

function configChecks(config: AppConfig, homeDir: string): CheckResult[] {
  const homeIsUserDsh = isUserDshPath(config.acp.dshHome, homeDir);
  return [
    { id: "config.run_dir", title: "运行目录", status: "pass", detail: config.runDir },
    {
      id: "config.dsh_home",
      title: "DSH_HOME",
      status: homeIsUserDsh ? "fail" : "pass",
      detail: `${config.acp.dshHome}（来源 ${config.acp.dshHomeSource}）`,
      ...(homeIsUserDsh ? { remediation: "改用不位于 ~/.dsh 的目录；检查 DSH_HOME 或 [acp].dsh_home" } : {}),
    },
    {
      id: "config.permission",
      title: "ACP 权限策略",
      status: config.acp.permission === "allow" ? "warn" : "pass",
      detail: `${config.acp.permission}（来源 ${config.acp.permissionSource}）`,
      ...(config.acp.permission === "allow" ? { remediation: "allow 会放行工具调用；仅本地调试使用" } : {}),
    },
    {
      id: "config.logging",
      title: "日志级别",
      status: "pass",
      detail: `${config.logging.level}（来源 ${config.logging.source}）`,
    },
    {
      id: "config.scheduler",
      title: "调度器地址",
      status: config.scheduler.url === null ? "warn" : "pass",
      detail: config.scheduler.url ?? "未配置（serve 需要）",
    },
    {
      id: "scheduler.token",
      title: "调度器 token",
      status: config.scheduler.token === null ? "warn" : "pass",
      detail: config.scheduler.token === null ? "未配置（仅 loopback 开发可用）" : `已配置（来源 ${config.scheduler.tokenSource}）`,
    },
  ];
}

async function pathChecks(config: AppConfig): Promise<CheckResult[]> {
  const stateWritable = await writable(config.state.root);
  const homeExists = await isDirectory(config.acp.dshHome);
  const homeWritable = homeExists ? await writable(config.acp.dshHome) : false;
  return [
    {
      id: "state.root",
      title: "state.root",
      status: stateWritable ? "pass" : "fail",
      detail: `${config.state.root}（来源 ${config.state.source}）`,
      ...(stateWritable ? {} : { remediation: "目录不可写；用 --state-root 指向可写目录" }),
    },
    ...(homeExists && homeWritable
      ? []
      : [
          {
            id: "config.home_writable",
            title: "DSH_HOME 可写",
            status: "fail" as const,
            detail: config.acp.dshHome,
            remediation: "目录不存在或不可写；修正权限或换路径",
          },
        ]),
  ];
}

function workspaceChecks(workspacePath: string): CheckResult[] {
  const root = findProjectRoot(workspacePath);
  const hasGit = fileExists(join(workspacePath, ".git"));
  return [
    {
      id: "workspace.project_root",
      title: "project root 不上浮",
      status: root !== workspacePath || hasGit ? "fail" : "pass",
      detail: `findProjectRoot=${root}${hasGit ? "，容器根存在 .git" : ""}`,
      remediation:
        root !== workspacePath || hasGit
          ? "容器根必须位于任何 git 仓库之外且自身没有 .git，否则 DSH 看不到 .dsh/skills"
          : undefined,
    },
  ];
}

async function dshChecks(env: Record<string, string | undefined>): Promise<CheckResult[]> {
  const dsh = resolveDshCommand(env);
  if (dsh === null) {
    return [
      {
        id: "dsh.binary",
        title: "DSH 入口",
        status: "fail",
        detail: "DSH_BIN 未设置且 PATH 中没有 dsh",
        remediation: "设置 DSH_BIN 指向 dsh 入口（如 apps/cli/lib/bin.js）",
      },
      { id: "dsh.version", title: "DSH 版本", status: "none", detail: "未找到 DSH 入口，跳过" },
    ];
  }
  const exists = dshCommandExists(dsh);
  const version = exists ? await probeDshVersion(dsh) : null;
  return [
    {
      id: "dsh.binary",
      title: "DSH 入口",
      status: exists ? "pass" : "fail",
      detail: `${dsh.command}${dsh.args.length > 0 ? ` ${dsh.args.join(" ")}` : ""}`,
      ...(exists ? {} : { remediation: "DSH_BIN 指向的路径不存在" }),
    },
    {
      id: "dsh.version",
      title: "DSH 版本",
      status: version === null ? "fail" : "pass",
      detail: version ?? "无法执行 dsh -V",
      ...(version === null ? { remediation: "确认 DSH_BIN 可执行且依赖完整" } : {}),
    },
  ];
}

function authChecks(hasCredentials: boolean): CheckResult[] {
  return [
    {
      id: "auth.credentials",
      title: "模型凭据",
      status: hasCredentials ? "pass" : "fail",
      detail: hasCredentials ? "已配置" : "未配置",
      ...(hasCredentials ? {} : { remediation: "在 .env 或 DSH_HOME/.credentials.yaml 提供 API Key" }),
    },
  ];
}

async function storeChecks(config: AppConfig): Promise<CheckResult[]> {
  const store = new FileStore({ stateRoot: config.state.root });
  return await new StoreAdmin({ stateRoot: config.state.root, store }).diagnose();
}

/** 收集 S0 的 `doctor` 检查项；只读，不启动执行（CMP-cli §2.6）。 */
export async function collectDoctorChecks(options: DoctorOptions): Promise<CheckResult[]> {
  const { config, env } = options;
  const homeDir = options.homeDir ?? homedir();
  const hasCredentials = await credentialsConfigured(config, env);

  const checks = [
    ...configChecks(config, homeDir),
    ...(await pathChecks(config)),
    ...authChecks(hasCredentials),
    ...(await dshChecks(env)),
    ...(await storeChecks(config)),
    ...(await new RuntimeAdmin().diagnose(config.acp.dshHome)),
  ];
  if (options.workspacePath !== undefined) {
    checks.push(...workspaceChecks(options.workspacePath));
  }
  checks.push({
    id: "scheduler.connectivity",
    title: "调度器连通性",
    status: "none",
    detail: "S0 不接调度器；S1 接入",
  });
  return checks;
}
