import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export type DshCommand = {
  command: string;
  args: string[];
  source: "DSH_BIN" | "PATH";
};

/**
 * 定位 DSH 入口（S0 机制，见工序 brief §2.3）：
 * `DSH_BIN` 优先；`.js` 用 node（`AF_NODE_BIN` 可覆盖）启动；否则 PATH 中的 `dsh`。
 */
export function resolveDshCommand(env: Record<string, string | undefined>): DshCommand | null {
  const configured = env.DSH_BIN?.trim();
  const candidate = configured !== undefined && configured !== "" ? configured : Bun.which("dsh");
  if (candidate === null || candidate === undefined) return null;

  if (/\.(c|m)?js$/.test(candidate)) {
    const node = env.AF_NODE_BIN?.trim() || Bun.which("node") || "node";
    return { command: node, args: [candidate], source: configured !== undefined ? "DSH_BIN" : "PATH" };
  }
  return { command: candidate, args: [], source: configured !== undefined ? "DSH_BIN" : "PATH" };
}

/** 读取 DSH 版本；失败返回 null，由 doctor 判定。 */
export async function probeDshVersion(command: DshCommand, timeoutMs = 15_000): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(command.command, [...command.args, "-V"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DSH_TELEMETRY_DISABLED: "1" },
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const line = output.split("\n").map((item) => item.trim()).find((item) => item !== "");
      resolve(line ?? null);
    });
  });
}

export function dshCommandExists(command: DshCommand): boolean {
  try {
    const info = statSync(command.command);
    return info.isFile();
  } catch {
    return existsSync(command.command);
  }
}
