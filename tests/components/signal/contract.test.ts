import { describe, expect, test } from "bun:test";
import {
  SIGNAL_TOOL_PUBLIC_NAME,
  isSupportedContract,
  parseResultSignal,
  toMcpInputSchema,
  type ResultSignalContract,
} from "../../../src/components/signal/contract.ts";
import { validateSchema, validateSignalData, validateTaskSignal } from "../../../src/components/signal/validate.ts";

const contract: ResultSignalContract = {
  version: 1,
  kind: "review_verdict",
  required: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fail", "needs_human"], description: "结论" },
      reason: { type: "string", minLength: 1, maxLength: 8192, description: "理由" },
      evidence: { type: "string[]", maxItems: 16, maxLength: 512, description: "证据" },
    },
  },
};

const valid = { verdict: "pass", reason: "ok" };

describe("受限 schema", () => {
  test("合法契约通过结构校验；工具公开名固定", () => {
    expect(validateSchema(contract.schema)).toEqual([]);
    expect(isSupportedContract(contract)).toBe(true);
    expect(SIGNAL_TOOL_PUBLIC_NAME).toBe("mcp__agentflow__signal");
  });

  test("拒绝 kind 字段、未声明的 required、非法字段类型", () => {
    expect(
      validateSchema({
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { type: "string" } },
      }),
    ).toEqual(["schema.properties 不能包含 kind（由工具固定）"]);
    expect(
      validateSchema({ type: "object", additionalProperties: false, required: ["x"], properties: {} }),
    ).toEqual(["schema.required 引用了未声明字段：x"]);
    expect(
      validateSchema({ type: "object", additionalProperties: false, required: [], properties: { a: { type: "object" } } }),
    ).toEqual(["schema.properties.a 不是受限字段"]);
  });

  test("不支持的 version/kind 不启用信号", () => {
    expect(isSupportedContract({ ...contract, version: 2 })).toBe(false);
    expect(isSupportedContract({ ...contract, kind: "other" })).toBe(false);
    expect(isSupportedContract({ ...contract, required: "yes" })).toBe(false);
    expect(isSupportedContract(undefined)).toBe(false);
  });
});

describe("MCP inputSchema 投影（A-01）", () => {
  test("string[] 展开成 array/items，执行约束不进 schema", () => {
    const projected = toMcpInputSchema(contract) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(projected.properties.evidence).toEqual({ type: "array", items: { type: "string" }, description: "证据" });
    expect(projected.properties.reason).toEqual({ type: "string", description: "理由" });
    expect(projected.properties.verdict).toMatchObject({ type: "string", enum: ["pass", "fail", "needs_human"] });
    expect(projected.properties.kind).toMatchObject({ const: "review_verdict" });
    expect(projected.required).toEqual(["kind", "verdict", "reason"]);
    expect(projected.additionalProperties).toBe(false);
    const text = JSON.stringify(projected);
    for (const keyword of ["maxLength", "minLength", "maxItems", "minimum"]) {
      expect(text.includes(`"${keyword}"`)).toBe(false);
    }
  });
});

describe("信号数据校验（UTF-8 字节）", () => {
  test("合法数据", () => {
    expect(validateSignalData(contract.schema, valid)).toEqual([]);
    expect(validateSignalData(contract.schema, { ...valid, evidence: ["a.ts", "b.ts"] })).toEqual([]);
  });

  test("缺字段、枚举、多余字段、数组上限", () => {
    expect(validateSignalData(contract.schema, { verdict: "pass" })).toEqual(["缺少必填字段：reason"]);
    expect(validateSignalData(contract.schema, { verdict: "maybe", reason: "x" })).toEqual([
      "verdict 只能是 pass/fail/needs_human",
    ]);
    expect(validateSignalData(contract.schema, { ...valid, extra: 1 })).toEqual(["不允许的字段：extra"]);
    expect(validateSignalData(contract.schema, { ...valid, evidence: new Array(17).fill("x") })).toEqual([
      "evidence 最多 16 项",
    ]);
    expect(validateSignalData(contract.schema, { ...valid, evidence: ["a".repeat(513)] })).toEqual([
      "evidence[0] 超过 512 字节",
    ]);
  });

  test("中文按字节计：maxLength=8192 时 3000 个汉字已超限", () => {
    const schema = { ...contract.schema, properties: { reason: { type: "string" as const, maxLength: 8192 } }, required: ["reason"] };
    expect(validateSignalData(schema, { reason: "中".repeat(3000) })).toEqual(["reason 超过 8192 字节"]);
  });
});

describe("信号记录与入参解析", () => {
  test("记录形状与 kind", () => {
    expect(validateTaskSignal(contract, { seq: 1, at: "2026-11-18T00:00:00.000Z", kind: "review_verdict", data: valid })).toEqual([]);
    expect(validateTaskSignal(contract, { seq: 0, at: "x", kind: "other", data: valid }).length).toBeGreaterThan(0);
  });

  test("parseResultSignal 只挑字段、不修补", () => {
    expect(parseResultSignal({ ...contract })).toMatchObject({ version: 1, kind: "review_verdict", required: true });
    expect(parseResultSignal({ version: 1 })).toBeUndefined();
    expect(parseResultSignal("x")).toBeUndefined();
    expect(parseResultSignal({ version: 1, kind: "review_verdict", schema: {}, required: "true" })).toMatchObject({
      required: false,
    });
  });
});
