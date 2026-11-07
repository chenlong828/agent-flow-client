import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceHandle, InstanceSpec } from "../executor/ports.ts";
import { AcpConnection } from "./acp-client.ts";
import { RuntimeError } from "./errors.ts";
import { S0_MODEL, writeProfilePatch } from "./profile.ts";
import type { RuntimeOptions } from "./runtime-options.ts";
import type { RuntimeState } from "./runtime-state.ts";

/** 启动一实例的 DSH 进程并完成 initialize；失败归 spawn_failed。 */
export async function startInstance(
  options: RuntimeOptions,
  instance: InstanceSpec,
  state: RuntimeState,
): Promise<InstanceHandle> {
  await mkdir(instance.dshHome, { recursive: true, mode: 0o700 });
  await copyCredentials(instance.dshHome, options.credentialsSource);
  const patchPath = await writeProfilePatch(instance.dshHome, options.model ?? S0_MODEL);

  try {
    const acp = await AcpConnection.connect({
      command: { command: options.command.command, args: [...options.command.args, "--profile", "acp", "--patch", patchPath] },
      cwd: instance.containerRoot,
      env: { ...options.env, DSH_HOME: instance.dshHome, DSH_TELEMETRY_DISABLED: "1" },
      initializeTimeoutMs: 10_000,
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      onNotification: (method, params) => state.applyNotification(method, params),
      onServerRequest: (method, params) => Promise.resolve(state.permission(method, params, options.permission)),
      onExit: (code) => {
        options.onStderr?.(`DSH 进程退出：code=${String(code)}`);
        state.applyExit(instance.instanceId);
      },
    });
    const handle: InstanceHandle = {
      instanceId: instance.instanceId,
      pid: acp.pid,
      ...(process.platform === "win32" ? {} : { pgid: acp.pid }),
    };
    state.addConnection(instance.instanceId, handle, acp);
    return handle;
  } catch (error) {
    throw new RuntimeError("spawn_failed", `DSH 启动失败：${(error as Error).message}`);
  }
}

async function copyCredentials(homeDir: string, source: string | undefined): Promise<void> {
  if (source === undefined) return;
  const target = join(homeDir, ".credentials.yaml");
  const exists = await stat(target).then(() => true).catch(() => false);
  if (exists) return;
  await copyFile(source, target).catch(() => undefined);
}

/** 列出实例 home 下的残留 session 目录（doctor 用，只报告）。 */
export async function listSessionDirs(homeDir: string): Promise<string[]> {
  try {
    return (await readdir(join(homeDir, "sessions"))).map((name) => join(homeDir, "sessions", name));
  } catch {
    return [];
  }
}
