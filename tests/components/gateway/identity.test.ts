import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClientId, newRunId } from "../../../src/components/gateway/identity.ts";
import { uuidv7 } from "../../../src/components/shared/uuid.ts";

describe("clientId / runId", () => {
  test("clientId 首次生成并持久化，后续读取一致", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-id-"));
    const first = await loadClientId(stateRoot);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await loadClientId(stateRoot)).toBe(first);
    expect((await readFile(join(stateRoot, "client-id"), "utf8")).trim()).toBe(first);
  });

  test("已有合法 clientId 时复用；非法值重新生成", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-id-"));
    const existing = uuidv7(1_700_000_000_000);
    await writeFile(join(stateRoot, "client-id"), existing);
    expect(await loadClientId(stateRoot)).toBe(existing);

    await writeFile(join(stateRoot, "client-id"), "not-a-uuid");
    const regenerated = await loadClientId(stateRoot);
    expect(regenerated).not.toBe("not-a-uuid");
    expect(regenerated).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("runId 每次不同且满足 UUIDv7 版本位", () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
    expect(a[14]).toBe("7");
    expect("89ab").toContain(a[19] as string);
  });
});
