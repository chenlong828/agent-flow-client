/**
 * 受限 schema 与信号数据的校验（纯函数）。长度一律按 UTF-8 字节。
 *
 * 与 `contract.ts` 的投影共用同一份类型；server 与 client 采集都走这里，避免两端漂移。
 */
import {
  SIGNAL_LIMITS,
  byteLength,
  type RestrictedField,
  type RestrictedSchema,
  type SignalContractSpec,
  type TaskSignal,
} from "./contract.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isField(value: unknown): value is RestrictedField {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "string":
      return (
        (value.enum === undefined || (Array.isArray(value.enum) && value.enum.every((item) => typeof item === "string"))) &&
        optionalNumber(value.minLength) &&
        optionalNumber(value.maxLength)
      );
    case "boolean":
      return true;
    case "number":
      return optionalNumber(value.minimum) && optionalNumber(value.maximum);
    case "string[]":
      return optionalNumber(value.maxItems) && optionalNumber(value.maxLength);
    default:
      return false;
  }
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

/** 校验受限 schema 的结构；返回错误列表（空表示合法）。 */
export function validateSchema(schema: unknown): string[] {
  if (!isRecord(schema)) return ["schema 必须是对象"];
  const errors: string[] = [];
  if (schema.type !== "object") errors.push("schema.type 必须是 object");
  if (schema.additionalProperties !== false) errors.push("schema.additionalProperties 必须是 false");
  if (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === "string")) {
    errors.push("schema.required 必须是字符串数组");
  }
  if (!isRecord(schema.properties)) {
    errors.push("schema.properties 必须是对象");
    return errors;
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!isField(field)) errors.push(`schema.properties.${name} 不是受限字段`);
    if (name === "kind") errors.push("schema.properties 不能包含 kind（由工具固定）");
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    if (!Object.hasOwn(schema.properties, name)) errors.push(`schema.required 引用了未声明字段：${name}`);
  }
  return errors;
}

/** 按受限 schema 校验 `data`（不含 `kind`）；返回错误列表。 */
export function validateSignalData(schema: RestrictedSchema, data: unknown): string[] {
  if (!isRecord(data)) return ["data 必须是对象"];
  const errors: string[] = [];
  for (const name of Object.keys(data)) {
    if (!Object.hasOwn(schema.properties, name)) errors.push(`不允许的字段：${name}`);
  }
  for (const name of schema.required) {
    if (!Object.hasOwn(data, name)) errors.push(`缺少必填字段：${name}`);
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(data, name)) continue;
    errors.push(...validateField(name, field, data[name]));
  }
  // reason 的全局上限与 schema 上限可能同时命中；对模型只报一次。
  return [...new Set(errors)];
}

function validateField(name: string, field: RestrictedField, value: unknown): string[] {
  switch (field.type) {
    case "string":
      return validateString(name, field, value);
    case "boolean":
      return typeof value === "boolean" ? [] : [`${name} 必须是布尔值`];
    case "number":
      return validateNumber(name, field, value);
    case "string[]":
      return validateStringArray(name, field, value);
  }
}

function validateString(name: string, field: Extract<RestrictedField, { type: "string" }>, value: unknown): string[] {
  if (typeof value !== "string") return [`${name} 必须是字符串`];
  const errors: string[] = [];
  if (field.enum !== undefined && !field.enum.includes(value)) errors.push(`${name} 只能是 ${field.enum.join("/")}`);
  const bytes = byteLength(value);
  if (field.minLength !== undefined && bytes < field.minLength) errors.push(`${name} 至少 ${field.minLength} 字节`);
  if (field.maxLength !== undefined && bytes > field.maxLength) errors.push(`${name} 超过 ${field.maxLength} 字节`);
  if (name === "reason" && bytes > SIGNAL_LIMITS.reasonBytes) errors.push(`${name} 超过 ${SIGNAL_LIMITS.reasonBytes} 字节`);
  return errors;
}

function validateNumber(name: string, field: Extract<RestrictedField, { type: "number" }>, value: unknown): string[] {
  if (typeof value !== "number" || !Number.isFinite(value)) return [`${name} 必须是数字`];
  const errors: string[] = [];
  if (field.minimum !== undefined && value < field.minimum) errors.push(`${name} 不能小于 ${field.minimum}`);
  if (field.maximum !== undefined && value > field.maximum) errors.push(`${name} 不能大于 ${field.maximum}`);
  return errors;
}

function validateStringArray(name: string, field: Extract<RestrictedField, { type: "string[]" }>, value: unknown): string[] {
  if (!Array.isArray(value)) return [`${name} 必须是字符串数组`];
  const errors: string[] = [];
  const maxItems = Math.min(field.maxItems ?? SIGNAL_LIMITS.evidenceItems, SIGNAL_LIMITS.evidenceItems);
  const maxBytes = Math.min(field.maxLength ?? SIGNAL_LIMITS.evidenceItemBytes, SIGNAL_LIMITS.evidenceItemBytes);
  if (value.length > maxItems) errors.push(`${name} 最多 ${maxItems} 项`);
  value.forEach((item, index) => {
    if (typeof item !== "string") errors.push(`${name}[${index}] 必须是字符串`);
    else if (byteLength(item) > maxBytes) errors.push(`${name}[${index}] 超过 ${maxBytes} 字节`);
  });
  return errors;
}

/** 校验一条已落盘/待上报的信号记录；`contract` 是该 kind 对应的工具契约。 */
export function validateTaskSignal(contract: SignalContractSpec, value: unknown): string[] {
  if (!isRecord(value)) return ["signal 必须是对象"];
  const errors: string[] = [];
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) errors.push("seq 必须是正整数");
  if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) errors.push("at 必须是 ISO-8601 时间");
  if (value.kind !== contract.kind) errors.push(`kind 必须是 ${contract.kind}`);
  errors.push(...validateSignalData(contract.schema, value.data));
  return errors;
}

/** 采集侧的类型窄化：只接受通过校验的记录。 */
export function isTaskSignal(contract: SignalContractSpec, value: unknown): value is TaskSignal {
  return validateTaskSignal(contract, value).length === 0;
}
