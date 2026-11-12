/** 开发期自报身份（CMP-cli §2.3）：`[scheduler].client_id` 的取值与形状校验。 */

export type ClientIdSource = "env" | "config" | "hostname";

export type ClientIdentity = Readonly<{
  clientId: string;
  clientIdSource: ClientIdSource;
  /** `X-Client-Address`：本机 hostname，仅供服务端展示；hostname 为空时省略。 */
  clientAddress: string | null;
}>;

/** 与服务端 `harness.service` 同一形状：1–64 个字符，不含空白与控制字符。 */
const CLIENT_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,64}$/;

export function isValidClientId(value: string): boolean {
  return CLIENT_ID_PATTERN.test(value);
}

/** 优先级：`AF_CLIENT_ID`（空值视为未设置）> `[scheduler].client_id` > 本机 hostname。 */
export function resolveClientIdentity(input: {
  env: Record<string, string | undefined>;
  configId: string | undefined;
  hostname: string;
}): ClientIdentity {
  const envId = input.env.AF_CLIENT_ID !== undefined && input.env.AF_CLIENT_ID.trim() !== "" ? input.env.AF_CLIENT_ID : undefined;
  const clientIdSource: ClientIdSource =
    envId !== undefined ? "env" : input.configId !== undefined ? "config" : "hostname";
  return {
    clientId: envId ?? input.configId ?? input.hostname,
    clientIdSource,
    clientAddress: input.hostname === "" ? null : input.hostname,
  };
}
