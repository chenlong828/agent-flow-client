import { describe, expect, test } from "bun:test";
import { collect, render, exitCode, type CheckResult } from "../../../src/components/observability/doctor.ts";

function check(id: string, status: CheckResult["status"]): CheckResult {
  return { id, title: id, status };
}

describe("doctor 聚合与渲染", () => {
  test("全部 pass/warn/none 时退出 0", () => {
    const report = collect([check("config.run_dir", "pass"), check("dsh.version", "warn"), check("scheduler.connectivity", "none")]);
    expect(report.summary).toEqual({ pass: 1, warn: 1, fail: 0, none: 1 });
    expect(exitCode(report)).toBe(0);
  });

  test("退出码按 config > auth > runtime > workspace 优先级", () => {
    const report = collect([
      check("workspace.container", "fail"),
      check("dsh.binary", "fail"),
      check("auth.credentials", "fail"),
      check("config.dsh_home", "fail"),
    ]);
    expect(report.exitCode).toBe(2);
  });

  test("human 渲染带 FAIL 与修复提示", () => {
    const report = collect([
      { id: "dsh.binary", title: "DSH 入口", status: "fail", detail: "missing", remediation: "设置 DSH_BIN" },
    ]);
    const text = render(report, "human");
    expect(text).toContain("[FAIL] dsh.binary DSH 入口  missing");
    expect(text).toContain("修复：设置 DSH_BIN");
  });

  test("json 渲染可解析且含 summary", () => {
    const report = collect([check("config.run_dir", "pass")]);
    const parsed = JSON.parse(render(report, "json"));
    expect(parsed.summary.pass).toBe(1);
    expect(parsed.exitCode).toBe(0);
  });
});
