/**
 * 结构化信号契约（v1）：常量、受限 schema、MCP inputSchema 投影、入参解析。
 *
 * 纯模块，无 I/O：`CMP-signal`（client 主进程）与 stdio signal server（独立进程）共用同一份
 * 定义；校验函数在 `validate.ts`，记录/配置形状在 `plan.ts`。
 */

/** 契约版本；`TaskRequest.resultSignal.version` 必须等于它才启用信号。 */
export const SIGNAL_CONTRACT_VERSION = 1;

/** v1 的 kind：review 判决 + 执行中临时确认点（§5.5）。 */
export const SIGNAL_KIND_REVIEW_VERDICT = "review_verdict";
export const SIGNAL_KIND_CONFIRMATION_REQUEST = "confirmation_request";

/** DSH 的 MCP server 名；kind → raw tool 名 → 模型可见名。 */
export const SIGNAL_SERVER_NAME = "agentflow";
export const SIGNAL_TOOL_NAME_BY_KIND: Record<string, string> = {
  [SIGNAL_KIND_REVIEW_VERDICT]: "signal",
  [SIGNAL_KIND_CONFIRMATION_REQUEST]: "confirm",
};
/** 缺省 raw tool 名（`review_verdict` 的 `signal`）：未知 kind 回落到它。 */
const SIGNAL_TOOL_RAW_NAME = SIGNAL_TOOL_NAME_BY_KIND[SIGNAL_KIND_REVIEW_VERDICT] as string;

/** 某 kind 的 raw tool 名；未知 kind 回落到 `signal`。 */
export function toolNameForKind(kind: string): string {
  return SIGNAL_TOOL_NAME_BY_KIND[kind] ?? SIGNAL_TOOL_RAW_NAME;
}

export function publicToolName(kind: string): string {
  return `mcp__${SIGNAL_SERVER_NAME}__${toolNameForKind(kind)}`;
}

/** 本 client 支持的 kind（契约版本 1 内）。 */
export const SIGNAL_SUPPORTED_KINDS: readonly string[] = [
  SIGNAL_KIND_REVIEW_VERDICT,
  SIGNAL_KIND_CONFIRMATION_REQUEST,
];

/** 信号与结果的总量上限（结果体预算，见 proposal §3.2）。 */
export const SIGNAL_LIMITS = {
  maxBytes: 16 * 1024,
  maxCount: 8,
  reasonBytes: 8 * 1024,
  evidenceItems: 16,
  evidenceItemBytes: 512,
} as const;

/** MCP stdio server 声明（ACP `session/new.mcpServers` 的形状，作为我方值类型使用）。 */
export type McpServerSpec = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

/** 受限字段类型：只表达 v1 需要的子集，不是完整 JSON Schema。 */
export type RestrictedField =
  | { type: "string"; enum?: string[]; minLength?: number; maxLength?: number; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "number"; minimum?: number; maximum?: number; description?: string }
  | { type: "string[]"; maxItems?: number; maxLength?: number; description?: string };

export type RestrictedSchema = {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, RestrictedField>;
};

/**
 * `TaskRequest.resultSignal` / `TaskRequest.confirmation`：由 `CMP-run` 按节点生成，
 * client 视为 opaque JSON + 受限 schema。一次 attempt 至多两个契约，各对应一个 MCP 工具。
 */
export type ResultSignalContract = {
  version: number;
  kind: string;
  required: boolean;
  schema: RestrictedSchema;
};

/** 挂到一次 attempt 上的单个工具契约（kind + data schema）；client 内部值类型。 */
export type SignalContractSpec = {
  kind: string;
  schema: RestrictedSchema;
};

/** `TaskResult.signals[]` 的一条：server 追加写入 `signals.jsonl` 后由 client 采集。 */
export type TaskSignal = {
  seq: number;
  at: string;
  kind: string;
  data: Record<string, unknown>;
};

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 该契约是否可被本 client 版本执行（不合法/不支持的契约一律不启用信号）。 */
export function isSupportedContract(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const contract = value as Partial<ResultSignalContract>;
  if (contract.version !== SIGNAL_CONTRACT_VERSION) return false;
  if (typeof contract.kind !== "string" || !SIGNAL_SUPPORTED_KINDS.includes(contract.kind)) return false;
  if (typeof contract.required !== "boolean") return false;
  return hasValidSchemaShape(contract.schema);
}

/** 结构校验（与 `validate.ts` 的 `validateSchema` 同义，供契约判定用）。 */
function hasValidSchemaShape(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const candidate = schema as Partial<RestrictedSchema>;
  return candidate.type === "object" && candidate.additionalProperties === false && isRecord(candidate.properties);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把受限 schema 投影成 MCP `inputSchema`：只保留 DSH 强制子集认得的关键字。
 * `maxLength`/`maxItems`/`minimum` 与 `string[]` 的执行语义由 `validate.ts` 自己承担。
 */
export function toMcpInputSchema(contract: ResultSignalContract): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    kind: { const: contract.kind, description: `信号类型，固定为 ${contract.kind}` },
  };
  for (const [name, field] of Object.entries(contract.schema.properties)) {
    properties[name] = projectField(field);
  }
  const required = ["kind", ...contract.schema.required.filter((name) => name !== "kind")];
  return { type: "object", properties, required, additionalProperties: false };
}

function projectField(field: RestrictedField): Record<string, unknown> {
  const description = field.description === undefined ? {} : { description: field.description };
  switch (field.type) {
    case "string":
      return { type: "string", ...(field.enum === undefined ? {} : { enum: field.enum }), ...description };
    case "boolean":
      return { type: "boolean", ...description };
    case "number":
      return { type: "number", ...description };
    case "string[]":
      return { type: "array", items: { type: "string" }, ...description };
  }
}

/** 从任意 JSON 里取出 `TaskRequest.resultSignal` 的候选值；不猜测、不修补。 */
export function parseResultSignal(value: unknown): ResultSignalContract | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.version !== "number") return undefined;
  if (typeof value.kind !== "string") return undefined;
  if (!isRecord(value.schema)) return undefined;
  return {
    version: value.version,
    kind: value.kind,
    required: value.required === true,
    schema: value.schema as unknown as RestrictedSchema,
  };
}

/**
 * 从任意 JSON 里取出 `TaskRequest.confirmation` 的候选值；形状与 `parseResultSignal` 相同。
 * 只做形状提取：`kind` 必须是 `confirmation_request` 的槽位语义由 `SignalRunner.prepare` 校验，
 * 这里不静默改写、也不静默丢弃（否则错误的 kind 会被当成「没有确认契约」）。
 */
export function parseConfirmation(value: unknown): ResultSignalContract | undefined {
  return parseResultSignal(value);
}
