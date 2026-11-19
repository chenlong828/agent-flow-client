import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalRequest } from "../../../src/components/cli/request.ts";
import { reviewConfirmationContract, reviewVerdictContract } from "../../support/signal-contract.ts";

async function fixture(extra: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afc-request-"));
  const path = join(dir, "task.json");
  await writeFile(
    path,
    JSON.stringify({
      taskId: "t-1",
      instanceId: "i-1",
      nodeId: "n-1",
      attempt: 1,
      prompt: "HELLO",
      workspacePath: dir,
      timeoutMs: 1000,
      skillSet: { digest: "sha256:d", packages: [] },
      ...extra,
    }),
  );
  return path;
}

describe("run --request（A-15）", () => {
  test("resultSignal 透传（单次模式与 serve 同语义）", async () => {
    const request = await loadLocalRequest(await fixture({ resultSignal: reviewVerdictContract }));
    expect(request.task.resultSignal).toMatchObject({ version: 1, kind: "review_verdict" });
  });

  test("缺省或不合法时不带 resultSignal", async () => {
    expect((await loadLocalRequest(await fixture({}))).task.resultSignal).toBeUndefined();
    expect((await loadLocalRequest(await fixture({ resultSignal: { version: 9 } }))).task.resultSignal).toBeUndefined();
  });

  test("confirmation 透传；缺省或空对象时不带该字段", async () => {
    const request = await loadLocalRequest(
      await fixture({ resultSignal: reviewVerdictContract, confirmation: reviewConfirmationContract }),
    );
    expect(request.task.confirmation).toMatchObject({ version: 1, kind: "confirmation_request", required: false });
    expect((await loadLocalRequest(await fixture({ resultSignal: reviewVerdictContract }))).task.confirmation).toBeUndefined();
    expect((await loadLocalRequest(await fixture({ confirmation: {} }))).task.confirmation).toBeUndefined();
  });
});
