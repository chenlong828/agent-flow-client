import type { PermissionDecision } from "../executor/domain-types.ts";

/** `session/request_permission` 的本地裁决：只选 allow_once/allow_always，否则 cancelled。 */
export function permissionDecision(method: string, params: unknown, decision: PermissionDecision): unknown {
  if (method !== "session/request_permission") throw new Error(`不支持的 ACP 请求：${method}`);
  if (decision === "deny") return { outcome: { outcome: "cancelled" } };
  const options = (params as { options?: { optionId?: string; kind?: string }[] } | undefined)?.options ?? [];
  const allow = options.find((option) => option.kind === "allow_once" || option.kind === "allow_always");
  return allow?.optionId === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: allow.optionId } };
}
