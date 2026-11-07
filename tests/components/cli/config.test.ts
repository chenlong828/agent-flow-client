import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../../src/components/cli/config.ts";

async function fixture(config?: string): Promise<{ runDir: string; homeDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "afc-config-"));
  const runDir = join(base, "app");
  const homeDir = join(base, "home");
  await mkdir(runDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  if (config !== undefined) await writeFile(join(runDir, ".config"), config);
  return { runDir, homeDir };
}

describe("TC-CONFIG-001 默认配置", () => {
  test("TC-CONFIG-001 无 .config、无 env 时用 <runDir>/AF_DSH_HOME 与默认 state", async () => {
    const { runDir, homeDir } = await fixture();
    const config = await loadConfig({ runDir, env: {}, homeDir });
    expect(config.acp.dshHome).toBe(join(runDir, "AF_DSH_HOME"));
    expect(config.acp.dshHomeSource).toBe("default");
    expect(config.acp.permission).toBe("deny");
    expect(config.state.root).toBe(join(runDir, ".agent-flow-client"));
    expect(config.state.source).toBe("default");
    expect(config.logging.level).toBe("info");
    expect(config.capacity.maxInstances).toBe(4);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe("TC-CONFIG-002 配置文件路径", () => {
  test("TC-CONFIG-002 绝对路径与相对路径都解析为绝对配置", async () => {
    const { runDir, homeDir } = await fixture(`
[acp]
dsh_home = "custom-home"
permission = "allow"
[state]
root = "var/state"
[logging]
level = "debug"
[capacity]
max_instances = 8
`);
    const config = await loadConfig({ runDir, env: {}, homeDir });
    expect(config.acp.dshHome).toBe(join(runDir, "custom-home"));
    expect(config.acp.dshHomeSource).toBe("config");
    expect(config.acp.permission).toBe("allow");
    expect(config.state.root).toBe(join(runDir, "var/state"));
    expect(config.state.source).toBe("config");
    expect(config.logging.level).toBe("debug");
    expect(config.capacity.maxInstances).toBe(8);
    expect(config.capacity.source).toBe("config");
  });

  test("CLI flag 覆盖配置", async () => {
    const { runDir, homeDir } = await fixture(`
[state]
root = "from-config"
[logging]
level = "warn"
`);
    const config = await loadConfig({
      runDir,
      env: {},
      homeDir,
      flags: { stateRoot: "from-flag", logLevel: "error", permission: "allow" },
    });
    expect(config.state.root).toBe(join(runDir, "from-flag"));
    expect(config.state.source).toBe("cli");
    expect(config.logging.level).toBe("error");
    expect(config.acp.permission).toBe("allow");
    expect(config.acp.permissionSource).toBe("cli");
  });
});

describe("TC-CONFIG-003 环境变量覆盖", () => {
  test("TC-CONFIG-003 非空 DSH_HOME 胜出；空值按未设置", async () => {
    const { runDir, homeDir } = await fixture(`
[acp]
dsh_home = "from-config"
`);
    const envHome = join(runDir, "from-env");
    const config = await loadConfig({ runDir, env: { DSH_HOME: envHome }, homeDir });
    expect(config.acp.dshHome).toBe(envHome);
    expect(config.acp.dshHomeSource).toBe("env");

    const empty = await loadConfig({ runDir, env: { DSH_HOME: "   " }, homeDir });
    expect(empty.acp.dshHome).toBe(join(runDir, "from-config"));
    expect(empty.acp.dshHomeSource).toBe("config");
  });

  test("加载后冻结，运行期修改 .config 不切换", async () => {
    const { runDir, homeDir } = await fixture(`
[acp]
dsh_home = "first"
`);
    const config = await loadConfig({ runDir, env: {}, homeDir });
    await writeFile(join(runDir, ".config"), `[acp]\ndsh_home = "second"\n`);
    expect(config.acp.dshHome).toBe(join(runDir, "first"));
    await expect(loadConfig({ runDir, env: {}, homeDir })).resolves.toMatchObject({
      acp: { dshHome: join(runDir, "second") },
    });
  });
});

describe("TC-CONFIG-004 非法配置不回退", () => {
  const cases: Array<[string, string, number]> = [
    ["TOML 语法错误", "[acp\n", 2],
    ["dsh_home 为空", `[acp]\ndsh_home = "  "\n`, 2],
    ["dsh_home 类型错误", `[acp]\ndsh_home = 3\n`, 2],
    ["permission 非法", `[acp]\npermission = "maybe"\n`, 2],
    ["logging.level 非法", `[logging]\nlevel = "trace"\n`, 2],
    ["max_instances 越界", `[capacity]\nmax_instances = 0\n`, 2],
  ];

  test("TC-CONFIG-004 非法 TOML、空值、类型与越界值一律 config_invalid/2", async () => {
    for (const [name, content, code] of cases) {
      const { runDir, homeDir } = await fixture(content);
      const error = await loadConfig({ runDir, env: {}, homeDir }).catch((caught: unknown) => caught);
      expect({ name, instance: error instanceof ConfigError }).toEqual({ name, instance: true });
      expect({ name, code: (error as ConfigError).code }).toEqual({ name, code: "config_invalid" });
      expect({ name, exitCode: (error as ConfigError).exitCode }).toEqual({ name, exitCode: code });
    }
  });

  test("指向 ~/.dsh 退出 2", async () => {
    const { runDir, homeDir } = await fixture();
    const error = await loadConfig({ runDir, env: { DSH_HOME: join(homeDir, ".dsh") }, homeDir }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe("home_forbidden");
    expect((error as ConfigError).exitCode).toBe(2);
  });

  test("home 是文件退出 4", async () => {
    const { runDir, homeDir } = await fixture();
    const path = join(runDir, "home-is-file");
    await writeFile(path, "x");
    const error = await loadConfig({ runDir, env: { DSH_HOME: path }, homeDir }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe("home_create_failed");
    expect((error as ConfigError).exitCode).toBe(4);
  });

  test("state.root 不可写退出 4", async () => {
    const { runDir, homeDir } = await fixture();
    const path = join(runDir, "readonly");
    await mkdir(path);
    await chmod(path, 0o500);
    const error = await loadConfig({ runDir, env: {}, homeDir, flags: { stateRoot: path } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe("state_root_unwritable");
    expect((error as ConfigError).exitCode).toBe(4);
    await chmod(path, 0o700);
  });
});
