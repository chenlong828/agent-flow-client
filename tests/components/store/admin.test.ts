import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../../../src/components/store/store.ts";
import { StoreAdmin } from "../../../src/components/store/admin.ts";

describe("StoreAdmin（v2）", () => {
  test("未确认结果与孤儿记录进入诊断项", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-admin-"));
    const store = new FileStore({ stateRoot });
    await store.init();
    await store.append({
      v: 2,
      ts: "2026-11-10T00:00:00Z",
      taskId: "task-1",
      attempt: 1,
      instanceId: "i-1",
      nodeId: "n-1",
      state: "settled",
      result: {
        taskId: "task-1",
        attempt: 1,
        status: "succeeded",
        message: "OK",
        truncated: false,
        stopReason: "end_turn",
        usage: null,
        error: null,
      },
    });
    await store.recordOrphan({ pid: 999999, instanceId: "i-1", createdAt: "2026-11-10T00:00:00Z", host: "h" });

    const checks = await new StoreAdmin({ stateRoot, store }).diagnose();
    expect(checks.find((check) => check.id === "state.settled")?.status).toBe("warn");
    expect(checks.find((check) => check.id === "state.orphans")?.status).toBe("warn");
    expect(checks.find((check) => check.id === "state.journal")?.status).toBe("pass");
  });
});
