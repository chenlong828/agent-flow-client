import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli/run.ts";
import { VERSION } from "../src/version.ts";

function captureRun(args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(args, {
    out: (message) => out.push(message),
    err: (message) => err.push(message),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli", () => {
  test("--version 打印版本", () => {
    const result = captureRun(["--version"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(VERSION);
  });

  test("--help 打印命令", () => {
    const result = captureRun(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("agent-flow-client");
    expect(result.out).toContain("serve");
  });

  test("未知命令返回 2", () => {
    const result = captureRun(["nope"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("未知命令");
  });

  test("未实现的命令返回 2 并说明", () => {
    const result = captureRun(["serve"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("尚未实现");
  });
});
