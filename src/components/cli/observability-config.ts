import type { AppConfig } from "./config.ts";
import { ConfigError } from "./config.ts";

type RawTable = Record<string, unknown>;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function readString(table: RawTable, key: string, label: string): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("config_invalid", `${label} 必须是非空字符串`, 2);
  }
  return value;
}

export function resolveObservability(
  table: RawTable,
  http: RawTable,
  schedulerToken: string | null,
): AppConfig["observability"] {
  return { ...resolveObservabilityHttp(http, schedulerToken), ...resolveObservabilityRetention(table) };
}

function resolveObservabilityHttp(http: RawTable, schedulerToken: string | null): Pick<
  AppConfig["observability"],
  "enabled" | "required" | "bind" | "port" | "advertiseUrl" | "token" | "maxStreams" | "rawEnabled" | "richStreamEnabled"
> {
  return {
    enabled: readBool(http, "enabled", "[observability.http].enabled") ?? true,
    required: readBool(http, "required", "[observability.http].required") ?? false,
    ...resolveObserverEndpoint(http, schedulerToken),
    maxStreams: readInt(http, "max_streams", "[observability.http].max_streams", 1, 200) ?? 20,
    rawEnabled: readBool(http, "raw_enabled", "[observability.http].raw_enabled") ?? true,
    richStreamEnabled: readBool(http, "rich_stream_enabled", "[observability.http].rich_stream_enabled") ?? true,
  };
}

function resolveObserverEndpoint(http: RawTable, schedulerToken: string | null): Pick<
  AppConfig["observability"],
  "bind" | "port" | "advertiseUrl" | "token"
> {
  const bind = readString(http, "bind", "[observability.http].bind") ?? "127.0.0.1";
  const port = readInt(http, "port", "[observability.http].port", 0, 65535) ?? 17890;
  const rawToken = http.token;
  if (rawToken !== undefined && typeof rawToken !== "string") {
    throw new ConfigError("config_invalid", "[observability.http].token 必须是字符串", 2);
  }
  const configuredToken = typeof rawToken === "string" && rawToken.trim() !== "" ? rawToken : undefined;
  const token = configuredToken ?? schedulerToken;
  if (!LOOPBACK_HOSTS.has(bind) && token === null) {
    throw new ConfigError("observability_insecure", "非 loopback 的 [observability.http].bind 必须配置 token（或 [scheduler].token）", 2);
  }
  const advertiseUrl = parseAdvertiseUrl(
    readString(http, "advertise_url", "[observability.http].advertise_url") ?? `http://127.0.0.1:${port}/api/v1/observability`,
  );
  return { bind, port, advertiseUrl, token };
}

function resolveObservabilityRetention(table: RawTable): Pick<
  AppConfig["observability"],
  "retentionDays" | "maxBytes" | "maxAttemptEventBytes"
> {
  return {
    retentionDays: readInt(table, "retention_days", "[observability].retention_days", 1, 3650) ?? 7,
    maxBytes: readInt(table, "max_bytes", "[observability].max_bytes", 1048576, 107374182400) ?? 1073741824,
    maxAttemptEventBytes: readInt(table, "max_attempt_event_bytes", "[observability].max_attempt_event_bytes", 1024, 1073741824) ?? 10485760,
  };
}

function parseAdvertiseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError("config_invalid", "[observability.http].advertise_url 不是合法 URL", 2);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("config_invalid", "[observability.http].advertise_url 必须是 http(s)", 2);
  }
  return parsed.toString().replace(/\/$/, "");
}

function readBool(table: RawTable, key: string, label: string): boolean | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ConfigError("config_invalid", `${label} 必须是布尔值`, 2);
  return value;
}

function readInt(table: RawTable, key: string, label: string, min: number, max: number): number | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError("config_invalid", `${label} 必须是 ${min}..${max} 的整数`, 2);
  }
  return value;
}

