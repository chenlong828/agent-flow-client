import { statSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "./config.ts";
import { isUserDshPath } from "./config.ts";
import { isValidClientId } from "./client-identity.ts";
import type { CheckResult } from "../observability/doctor.ts";
import { resolveDshCommand, dshCommandExists, probeDshVersion } from "../runtime/dsh.ts";
import { WorkspaceAdmin } from "../workspace/admin.ts";
import { FileStore } from "../store/store.ts";
import { StoreAdmin } from "../store/admin.ts";
import { RuntimeAdmin } from "../runtime/admin.ts";
import { defaultSignalServerEntry } from "../signal/signal.ts";
import { SIGNAL_SUPPORTED_KINDS } from "../signal/contract.ts";
import { signalRoot } from "../signal/directory.ts";

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
      id: "scheduler.client_id",
      title: "调度器客户端身份",
      status: isValidClientId(config.scheduler.clientId) ? "pass" : "fail",
      detail: `${config.scheduler.clientId}（来源 ${config.scheduler.clientIdSource}）`,
      ...(isValidClientId(config.scheduler.clientId)
        ? {}
        : { remediation: "改为 1–64 个不含空白/控制字符的稳定值（AF_CLIENT_ID 或 [scheduler].client_id）" }),
    },
    {
      id: "scheduler.token",
      title: "调度器 token",
      status: config.scheduler.token === null ? "warn" : "pass",
      detail:
        config.scheduler.token === null
          ? `未配置${config.scheduler.allowUnauthenticated ? "（allow_unauthenticated=true，靠 X-Client-Id 自报身份）" : "（仅 loopback 可用，或开发期设 allow_unauthenticated = true）"}`
          : `已配置（来源 ${config.scheduler.tokenSource}）`,
    },
    {
      id: "scheduler.identity",
      title: "调度器身份方式",
      status: config.scheduler.token === null ? "warn" : "pass",
      detail:
        config.scheduler.token === null
          ? "以 X-Client-Id 自报身份（开发期）；服务端 EXECUTOR_AUTH=on 时会返回 401"
          : `Bearer（X-Client-Id 同时附带：${config.scheduler.clientId}）`,
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

/** signal.* 检查：目录、server 入口、`--check`、支持的 kind（只读 + 临时目录）。 */
async function signalChecks(config: AppConfig): Promise<CheckResult[]> {
  const root = signalRoot(config.state.root);
  const rootExists = await isDirectory(root);
  const dirOk = rootExists ? await writable(root) : await writable(config.state.root);
  const entry = defaultSignalServerEntry();
  const entryExists = fileExists(entry);
  const checks: CheckResult[] = [
    {
      id: "signal.dir",
      title: "信号目录",
      status: dirOk ? "pass" : "fail",
      detail: rootExists ? root : `${root}（尚未创建，首个带信号的任務时建）`,
      ...(dirOk ? {} : { remediation: "state.root 不可写；检查目录权限或换 --state-root" }),
    },
    {
      id: "signal.server",
      title: "signal server",
      status: entryExists ? "pass" : "fail",
      detail: entry,
      ...(entryExists ? {} : { remediation: "安装不完整：src/mcp/signal-server.ts 不存在" }),
    },
    {
      id: "signal.kinds",
      title: "支持的信号 kind",
      status: "pass",
      detail: SIGNAL_SUPPORTED_KINDS.join(", "),
    },
  ];
  if (entryExists) checks.push(await signalCheckCheck(entry));
  return checks;
}

async function signalCheckCheck(entry: string): Promise<CheckResult> {
  const dir = await mkdtemp(join(tmpdir(), "afc-doctor-signal-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        kind: "review_verdict",
        taskId: "doctor",
        attempt: 1,
        output: join(dir, "signals.jsonl"),
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "reason"],
          properties: { verdict: { type: "string", enum: ["pass", "fail", "needs_human"] }, reason: { type: "string" } },
        },
        limits: { maxSignals: 8, maxBytes: 16384 },
      }),
    );
    const result = await runServerCheck(entry, configPath);
    return {
      id: "signal.check",
      title: "signal server --check",
      status: result.ok ? "pass" : "fail",
      detail: result.ok ? "预检通过" : result.detail,
      ...(result.ok ? {} : { remediation: "运行 `AF_SIGNAL_CONFIG=<config> <bun> src/mcp/signal-server.ts --check` 看完整错误" }),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runServerCheck(entry: string, configPath: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, "--check"], {
      env: { ...process.env, AF_SIGNAL_CONFIG: configPath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, detail: "预检超时（5s）" });
    }, 5000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, detail: "" } : { ok: false, detail: `退出码 ${String(code)}${stderr.trim() === "" ? "" : `：${stderr.trim()}`}` });
    });
  });
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
    ...(await signalChecks(config)),
    ...(await dshChecks(env)),
    ...(await storeChecks(config)),
    ...(await new RuntimeAdmin().diagnose(config.acp.dshHome)),
  ];
  if (options.workspacePath !== undefined) {
    checks.push(...(await new WorkspaceAdmin().diagnose(options.workspacePath)));
  }
  checks.push({
    id: "scheduler.connectivity",
    title: "调度器连通性",
    status: "none",
    detail: "S0 不接调度器；S1 接入",
  });
  return checks;
}
