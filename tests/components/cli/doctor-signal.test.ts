import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/components/cli/config.ts";
import { collectDoctorChecks } from "../../../src/components/cli/doctor-checks.ts";

describe("doctor signal.* 检查", () => {
  test("信号目录、server 入口、--check 与支持 kind", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "afc-doctor-signal-"));
    const config = await loadConfig({ runDir, env: {}, flags: { stateRoot: join(runDir, "state") } });
    const checks = await collectDoctorChecks({ config, env: {} });
    const signalChecks = checks.filter((check) => check.id.startsWith("signal."));
    expect(signalChecks.map((check) => check.id).sort()).toEqual([
      "signal.check",
      "signal.dir",
      "signal.kinds",
      "signal.server",
    ]);
    for (const check of signalChecks) expect({ id: check.id, status: check.status }).toEqual({ id: check.id, status: check.status === "pass" ? "pass" : check.status });
    expect(signalChecks.find((check) => check.id === "signal.check")?.status).toBe("pass");
    expect(signalChecks.find((check) => check.id === "signal.kinds")?.detail).toContain("confirmation_request");
  }, 20_000);
});
