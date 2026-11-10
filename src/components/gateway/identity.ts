/** v2 协议常量：版本走请求头 `X-Executor-Protocol: 2`，无 clientId/runId。 */
export const PROTOCOL_VERSION = "2";
export const DSH_BASELINE = "0.2.2-alpha.2";

export function newRequestId(): string {
  return crypto.randomUUID();
}
