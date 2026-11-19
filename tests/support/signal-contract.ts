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
