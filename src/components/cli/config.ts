import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isValidClientId, resolveClientIdentity, type ClientIdSource } from "./client-identity.ts";

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
  }>;
  state: Readonly<{ root: string; source: Extract<ConfigSource, "cli" | "config" | "default"> }>;
  logging: Readonly<{ level: LogLevel; source: Extract<ConfigSource, "cli" | "config" | "default"> }>;
  capacity: Readonly<{ maxConcurrent: number; source: "config" | "default" }>;
  executor: Readonly<{ idleTimeoutMs: number; source: "config" | "default" }>;
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

export class ConfigError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

type RawTable = Record<string, unknown>;

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

function readString(table: RawTable, key: string, label: string): string | undefined {
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
  return {
    dshHome: resolveFrom(runDir, raw),
    dshHomeSource: source,
    permission,
    permissionSource,
  };
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

function resolveCapacity(table: RawTable): AppConfig["capacity"] {
  const value = table.max_concurrent;
  if (value === undefined) return { maxConcurrent: 4, source: "default" };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 64) {
    throw new ConfigError("config_invalid", "[capacity].max_concurrent 必须是 1..64 的整数", 2);
  }
  return { maxConcurrent: value, source: "config" };
}

function resolveExecutor(table: RawTable): AppConfig["executor"] {
  const value = table.idle_timeout_ms;
  if (value === undefined) return { idleTimeoutMs: 0, source: "default" };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError("config_invalid", "[executor].idle_timeout_ms 必须是非负整数", 2);
  }
  return { idleTimeoutMs: value, source: "config" };
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

const PROTOCOL_VERSION = "2026-11-07.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function parseSchedulerUrl(rawUrl: string): { url: URL; loopback: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConfigError("config_invalid", `[scheduler].url 不是合法 URL：${rawUrl}`, 2);
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new ConfigError("scheduler_insecure_url", "scheduler.url 必须 HTTPS（http 仅允许 loopback）", 2);
  }
  return { url: parsed, loopback };
}

function resolveScheduler(
  table: RawTable,
  env: Record<string, string | undefined>,
  hostname: string,
): AppConfig["scheduler"] {
  const rawUrl = readString(table, "url", "[scheduler].url");
  const configToken = readString(table, "token", "[scheduler].token");
  const envToken = env.AF_SCHEDULER_TOKEN !== undefined && env.AF_SCHEDULER_TOKEN.trim() !== "" ? env.AF_SCHEDULER_TOKEN : undefined;
  const token = envToken ?? configToken ?? null;
  const tokenSource = envToken !== undefined ? "env" : configToken !== undefined ? "config" : "none";

  const allowRaw = table.allow_unauthenticated;
  if (allowRaw !== undefined && typeof allowRaw !== "boolean") {
    throw new ConfigError("config_invalid", "[scheduler].allow_unauthenticated 必须是布尔值", 2);
  }
  const allowUnauthenticated = allowRaw === true;

  const identity = resolveClientIdentity({
    env,
    configId: readString(table, "client_id", "[scheduler].client_id"),
    hostname,
  });
  if (!isValidClientId(identity.clientId)) {
    throw new ConfigError(
      "config_invalid",
      `[scheduler].client_id（来源 ${identity.clientIdSource}）必须是 1–64 个不含空白/控制字符的字符串：${JSON.stringify(identity.clientId)}`,
      2,
    );
  }

  if (rawUrl === undefined) {
    if (token !== null) throw new ConfigError("config_invalid", "[scheduler].token 已配置但 [scheduler].url 为空", 2);
    return {
      url: null,
      token: null,
      tokenSource: "none",
      ...identity,
      allowUnauthenticated,
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  const { url: parsed, loopback } = parseSchedulerUrl(rawUrl);
  if (token === null && !loopback && !allowUnauthenticated) {
    throw new ConfigError(
      "scheduler_token_missing",
      "非 loopback 的 scheduler 必须配置 token（AF_SCHEDULER_TOKEN 或 [scheduler].token），或在开发期设 [scheduler].allow_unauthenticated = true 走 X-Client-Id 自报身份",
      2,
    );
  }
  return {
    url: parsed.toString().replace(/\/$/, ""),
    token,
    tokenSource,
    ...identity,
    allowUnauthenticated,
    protocolVersion: PROTOCOL_VERSION,
  };
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
  const capacity = resolveCapacity(asTable(parsed.capacity, "[capacity]"));
  const executor = resolveExecutor(asTable(parsed.executor, "[executor]"));
  const scheduler = resolveScheduler(asTable(parsed.scheduler, "[scheduler]"), env, hostname);

  validatePaths(acp, state, homeDir);
  await ensureDirectory(acp.dshHome, "home_create_failed", "DSH_HOME");
  await ensureDirectory(state.root, "state_root_unwritable", "state.root");

  return Object.freeze({
    runDir,
    configPath,
    acp: Object.freeze(acp),
    state: Object.freeze(state),
    logging: Object.freeze(logging),
    capacity: Object.freeze(capacity),
    executor: Object.freeze(executor),
    scheduler: Object.freeze(scheduler),
  });
}

/** 判断路径是否位于 ~/.dsh 之下（doctor 与配置校验共用）。 */
export function isUserDshPath(path: string, homeDir = homedir()): boolean {
  return isInside(resolve(path), resolve(homeDir, ".dsh"));
}
