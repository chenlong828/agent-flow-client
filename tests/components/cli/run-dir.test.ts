import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunDir } from "../../../src/components/cli/run-dir.ts";

describe("resolveRunDir", () => {
  test("打包态取可执行文件所在目录", () => {
    expect(resolveRunDir({ execPath: "/opt/afc/bin/agent-flow-client", moduleDir: "/unused" })).toBe(
      "/opt/afc/bin",
    );
  });

  test("源码态从模块目录向上找 package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "afc-rundir-"));
    const moduleDir = join(root, "src", "components", "cli");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    expect(resolveRunDir({ execPath: "/usr/local/bin/bun", moduleDir })).toBe(root);
  });
});
