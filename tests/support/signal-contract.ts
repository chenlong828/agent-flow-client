import type { ResultSignalContract } from "../../src/components/signal/contract.ts";

/** review_verdict 契约（与调度面 `REVIEW_VERDICT_SIGNAL` 同形）。 */
export const reviewVerdictContract: ResultSignalContract = {
  version: 1,
  kind: "review_verdict",
  required: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fail", "needs_human"] },
      reason: { type: "string", minLength: 1, maxLength: 8192 },
      evidence: { type: "string[]", maxItems: 16, maxLength: 512 },
    },
  },
};

/** confirmation_request 契约（与调度面 `CONFIRMATION_SIGNAL` 同形）。 */
export const confirmationRequestContract: ResultSignalContract = {
  version: 1,
  kind: "confirmation_request",
  required: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: {
      question: { type: "string", minLength: 1, maxLength: 2048 },
      context: { type: "string", maxLength: 8192 },
      options: { type: "string[]", maxItems: 8, maxLength: 200 },
      allowFreeText: { type: "boolean" },
    },
  },
};

/** review 节点额外挂载的确认契约：同 schema，`required=false`（verdict 才是必需结果）。 */
export const reviewConfirmationContract: ResultSignalContract = {
  ...confirmationRequestContract,
  required: false,
};
