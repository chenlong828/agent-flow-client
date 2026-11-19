import { ConfigError } from "./config-error.ts";
import { readString, type RawTable } from "./config.ts";
import type { AppConfig } from "./config.ts";
import { isValidClientId, resolveClientIdentity } from "./client-identity.ts";

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

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** 地址来源：`AF_SCHEDULER_URL` > `[scheduler].url`。 */
function schedulerUrl(table: RawTable, env: Record<string, string | undefined>): string | undefined {
  return nonEmpty(env.AF_SCHEDULER_URL) ?? readString(table, "url", "[scheduler].url");
}

function schedulerToken(
  table: RawTable,
  env: Record<string, string | undefined>,
): Pick<AppConfig["scheduler"], "token" | "tokenSource"> {
  const configToken = readString(table, "token", "[scheduler].token");
  const envToken = nonEmpty(env.AF_SCHEDULER_TOKEN);
  if (envToken !== undefined) return { token: envToken, tokenSource: "env" };
  if (configToken !== undefined) return { token: configToken, tokenSource: "config" };
  return { token: null, tokenSource: "none" };
}

/** `[scheduler].allow_unauthenticated` 只接受布尔值；缺省 false。 */
function allowUnauthenticatedOf(table: RawTable): boolean {
  const value = table.allow_unauthenticated;
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ConfigError("config_invalid", "[scheduler].allow_unauthenticated 必须是布尔值", 2);
  }
  return value;
}

/** 客户端身份（`AF_CLIENT_ID` > 配置 > hostname），并校验合法性。 */
function identityOf(
  table: RawTable,
  env: Record<string, string | undefined>,
  hostname: string,
): Pick<AppConfig["scheduler"], "clientId" | "clientIdSource" | "clientAddress"> {
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
  return identity;
}

export function resolveScheduler(
  table: RawTable,
  env: Record<string, string | undefined>,
  hostname: string,
): AppConfig["scheduler"] {
  const rawUrl = schedulerUrl(table, env);
  const { token, tokenSource } = schedulerToken(table, env);
  const allowUnauthenticated = allowUnauthenticatedOf(table);
  const identity = identityOf(table, env, hostname);

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
