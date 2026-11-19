import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isValidClientId, resolveClientIdentity, type ClientIdSource } from "./client-identity.ts";
import { resolveObservability } from "./observability-config.ts";
import { ConfigError } from "./config-error.ts";
import { resolveScheduler } from "./scheduler.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type PermissionMode = "deny" | "allow";

export type ConfigSource = "cli" | "config" | "default" | "env";

export type AppConfig = Readonly<{
  runDir: string;
  configPath: string;
  acp: Readonly<{
    dshHome: string;
    dshHomeSource: Extract<ConfigSource, "env" | "config" | "default">;
    permission: PermissionMode;
    permissionSource: Extract<ConfigSource, "cli" | "config" | "default">;
    /** `session/new` 超时（A-07）；默认 10000。 */
    sessionNewTimeoutMs: number;
    sessionNewTimeoutSource: Extract<ConfigSource, "config" | "default">;
  }>;
  state: Readonly<{ root: string; source: Extract<ConfigSource, "cli" | "config" | "default"> }>;
  logging: Readonly<{ level: LogLevel; source: Extract<ConfigSource, "cli" | "config" | "default"> }>;
  capacity: Readonly<{ maxConcurrent: number; source: "config" | "default" }>;
  executor: Readonly<{ idleTimeoutMs: number; source: "config" | "default" }>;
  signal: Readonly<{ retentionDays: number; source: "config" | "default" }>;
  observability: Readonly<{
    enabled: boolean;
    required: boolean;
    bind: string;
    port: number;
    advertiseUrl: string;
    token: string | null;
    maxStreams: number;
    rawEnabled: boolean;
    richStreamEnabled: boolean;
    retentionDays: number;
    maxBytes: number;
    maxAttemptEventBytes: number;
  }>;
  scheduler: Readonly<{
    url: string | null;
    token: string | null;
    tokenSource: "env" | "config" | "none";
    /** 开发期自报身份：`X-Client-Id` 的取值，跨重启稳定。 */
    clientId: string;
    clientIdSource: ClientIdSource;
    /** 仅供服务端展示的接入地址（`X-Client-Address`）；取本机 hostname。 */
    clientAddress: string | null;
    /** 允许「非 loopback + 无 token」的调度器地址；开发期自注册用，默认 false。 */
    allowUnauthenticated: boolean;
    protocolVersion: string;
  }>;
}>;

export type ConfigFlags = {
  configPath?: string;
  stateRoot?: string;
  logLevel?: string;
  permission?: string;
};

export { ConfigError } from "./config-error.ts";

export type RawTable = Record<string, unknown>;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const PERMISSIONS: readonly PermissionMode[] = ["deny", "allow"];
const DEFAULT_HOME_DIRNAME = "AF_DSH_HOME";
const DEFAULT_STATE_DIRNAME = ".agent-flow-client";

function isRecord(value: unknown): value is RawTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTable(value: unknown, label: string): RawTable {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError("config_invalid", `${label} 必须是表`, 2);
  return value;
}

export function readString(table: RawTable, key: string, label: string): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("config_invalid", `${label} 必须是非空字符串`, 2);
  }
  return value;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveFrom(runDir: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(runDir, value);
}

async function readConfigFile(path: string): Promise<RawTable> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError("config_invalid", `读取 ${path} 失败：${(error as Error).message}`, 2);
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new ConfigError("config_invalid", `${path} TOML 解析失败：${(error as Error).message}`, 2);
  }
  if (!isRecord(parsed)) throw new ConfigError("config_invalid", `${path} 顶层必须是表`, 2);
  return parsed;
}

async function ensureDirectory(path: string, code: string, label: string): Promise<void> {
  try {
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    } else if (!info.isDirectory()) {
      throw new ConfigError(code, `${label} 不是目录：${path}`, 4);
    }
    await access(path, constants.R_OK | constants.W_OK);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(code, `${label} 不可写：${path}（${(error as Error).message}）`, 4);
  }
}

function resolveHome(
  table: RawTable,
  env: Record<string, string | undefined>,
  runDir: string,
  flagPermission?: PermissionMode,
): AppConfig["acp"] {
  const configHome = readString(table, "dsh_home", "[acp].dsh_home");
  const envHome = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : undefined;
  const source = envHome !== undefined ? "env" : configHome !== undefined ? "config" : "default";
  const raw = envHome ?? configHome ?? join(runDir, DEFAULT_HOME_DIRNAME);

  const rawPermission = table.permission;
  if (rawPermission !== undefined && !PERMISSIONS.includes(rawPermission as PermissionMode)) {
    throw new ConfigError("config_invalid", "[acp].permission 只能是 deny 或 allow", 2);
  }
  const permission = flagPermission ?? (rawPermission ?? "deny") as PermissionMode;
  const permissionSource = flagPermission !== undefined
    ? "cli"
    : rawPermission !== undefined
      ? "config"
      : "default";
  const sessionNewTimeout = resolveSessionTimeout(table);
  return {
    dshHome: resolveFrom(runDir, raw),
    dshHomeSource: source,
    permission,
    permissionSource,
    sessionNewTimeoutMs: sessionNewTimeout.value,
    sessionNewTimeoutSource: sessionNewTimeout.source,
  };
}

function resolveSessionTimeout(table: RawTable): { value: number; source: "config" | "default" } {
  const raw = table.session_new_timeout_ms;
  if (raw === undefined) return { value: 10_000, source: "default" };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1000) {
    throw new ConfigError("config_invalid", "[acp].session_new_timeout_ms 必须是 >=1000 的整数", 2);
  }
  return { value: raw, source: "config" };
}

function resolveState(table: RawTable, flags: ConfigFlags, runDir: string): AppConfig["state"] {
  const configured = readString(table, "root", "[state].root");
  if (flags.stateRoot === undefined && configured === undefined) {
    return { root: resolve(runDir, DEFAULT_STATE_DIRNAME), source: "default" };
  }
  return {
    root: resolveFrom(runDir, flags.stateRoot ?? (configured as string)),
    source: flags.stateRoot !== undefined ? "cli" : "config",
  };
}

function resolveLogging(table: RawTable, flags: ConfigFlags): AppConfig["logging"] {
  const configured = table.level;
  if (configured !== undefined && !LOG_LEVELS.includes(configured as LogLevel)) {
    throw new ConfigError("config_invalid", "[logging].level 只能是 debug/info/warn/error", 2);
  }
  if (flags.logLevel !== undefined && !LOG_LEVELS.includes(flags.logLevel as LogLevel)) {
    throw new ConfigError("usage", "--log-level 只能是 debug/info/warn/error", 2);
  }
  const level = (flags.logLevel ?? configured ?? "info") as LogLevel;
  return { level, source: flags.logLevel !== undefined ? "cli" : configured !== undefined ? "config" : "default" };
}

/** 本地并发/超时/保留期三个整型配置；表驱动校验以保持函数数与圈复杂度预算。 */
function resolveTunables(
  capacityTable: RawTable,
  executorTable: RawTable,
  signalTable: RawTable,
): { capacity: AppConfig["capacity"]; executor: AppConfig["executor"]; signal: AppConfig["signal"] } {
  const raws: unknown[] = [capacityTable.max_concurrent, executorTable.idle_timeout_ms, signalTable.retention_days];
  const limits: Array<[min: number, max: number, fallback: number]> = [
    [1, 64, 4],
    [0, Number.MAX_SAFE_INTEGER, 0],
    [1, 365, 7],
  ];
  const labels = ["[capacity].max_concurrent", "[executor].idle_timeout_ms", "[signal].retention_days"];
  const values: number[] = [];
  for (let index = 0; index < raws.length; index += 1) {
    const raw = raws[index];
    const [min, max, fallback] = limits[index] as [number, number, number];
    if (
      raw !== undefined &&
      (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max)
    ) {
      throw new ConfigError("config_invalid", `${labels[index] as string} 必须是 ${min}..${max} 的整数`, 2);
    }
    values.push(raw === undefined ? fallback : (raw as number));
  }
  return {
    capacity: { maxConcurrent: values[0] as number, source: capacityTable.max_concurrent === undefined ? "default" : "config" },
    executor: { idleTimeoutMs: values[1] as number, source: executorTable.idle_timeout_ms === undefined ? "default" : "config" },
    signal: { retentionDays: values[2] as number, source: signalTable.retention_days === undefined ? "default" : "config" },
  };
}

function validatePaths(acp: AppConfig["acp"], state: AppConfig["state"], homeDir: string): void {
  const userDshHome = resolve(homeDir, ".dsh");
  if (isInside(acp.dshHome, userDshHome)) {
    throw new ConfigError("home_forbidden", `[acp].dsh_home 不能指向 ~/.dsh：${acp.dshHome}`, 2);
  }
  if (isInside(state.root, userDshHome)) {
    throw new ConfigError("state_root_forbidden", `[state].root 不能位于 ~/.dsh 之下：${state.root}`, 2);
  }
  if (isInside(state.root, acp.dshHome) || isInside(acp.dshHome, state.root)) {
    throw new ConfigError("state_root_conflict", "[state].root 与 [acp].dsh_home 不能互相包含", 2);
  }
}

function resolveFlags(flags: ConfigFlags): { permission?: PermissionMode } {
  if (flags.permission === undefined) return {};
  if (!PERMISSIONS.includes(flags.permission as PermissionMode)) {
    throw new ConfigError("usage", "--permission 只能是 deny 或 allow", 2);
  }
  return { permission: flags.permission as PermissionMode };
}

/**
 * 加载、校验并冻结配置（CMP-cli §2.3）。
 *
 * 优先级：CLI flag > 环境变量（仅 DSH_HOME）> `.config` > 默认值。
 * 非法值不回退默认：抛 ConfigError，由 CLI 映射退出码。
 */
export async function loadConfig(options: {
  runDir: string;
  env: Record<string, string | undefined>;
  flags?: ConfigFlags;
  homeDir?: string;
  hostname?: string;
}): Promise<AppConfig> {
  const { runDir, env } = options;
  const flags = options.flags ?? {};
  const homeDir = options.homeDir ?? homedir();
  const hostname = options.hostname ?? osHostname();
  const configPath = flags.configPath ? resolve(process.cwd(), flags.configPath) : resolve(runDir, ".config");
  const parsed = await readConfigFile(configPath);

  const flagPermission = resolveFlags(flags).permission;
  const acp = resolveHome(asTable(parsed.acp, "[acp]"), env, runDir, flagPermission);
  const state = resolveState(asTable(parsed.state, "[state]"), flags, runDir);
  const logging = resolveLogging(asTable(parsed.logging, "[logging]"), flags);
  const tunables = resolveTunables(
    asTable(parsed.capacity, "[capacity]"),
    asTable(parsed.executor, "[executor]"),
    asTable(parsed.signal, "[signal]"),
  );
  const scheduler = resolveScheduler(asTable(parsed.scheduler, "[scheduler]"), env, hostname);
  const observability = resolveObservability(
    asTable(parsed.observability, "[observability]"),
    asTable(asTable(parsed.observability, "[observability]").http, "[observability.http]"),
    scheduler.token,
  );

  validatePaths(acp, state, homeDir);
  await ensureDirectory(acp.dshHome, "home_create_failed", "DSH_HOME");
  await ensureDirectory(state.root, "state_root_unwritable", "state.root");

  return Object.freeze({
    runDir,
    configPath,
    acp: Object.freeze(acp),
    state: Object.freeze(state),
    logging: Object.freeze(logging),
    capacity: Object.freeze(tunables.capacity),
    executor: Object.freeze(tunables.executor),
    signal: Object.freeze(tunables.signal),
    observability: Object.freeze(observability),
    scheduler: Object.freeze(scheduler),
  });
}

/** 判断路径是否位于 ~/.dsh 之下（doctor 与配置校验共用）。 */
export function isUserDshPath(path: string, homeDir = homedir()): boolean {
  return isInside(resolve(path), resolve(homeDir, ".dsh"));
}
