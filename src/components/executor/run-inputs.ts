import { createHash } from "node:crypto";
import type { RunInputPort, WorkspaceInputsPort } from "./ports.ts";
import type { ExecutorRunInput } from "./types.ts";
import { WorkspaceError } from "../workspace/errors.ts";
import { ExecutorError } from "./executor-helpers.ts";

export type SeedRunInputsOptions = {
  runId: string;
  taskSpacePath: string;
  port: RunInputPort;
  inputs: WorkspaceInputsPort;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

/**
 * 初始资料落盘（`EXE-06/07`）：列表 → 逐张下载 → 校验 → 原子写入 `<task-space>/inputs/<name>`。
 * 在 `ensureTaskSpace` 之后、建 session 之前调用；失败抛 `ExecutorError`，结果归 `asset`。
 */
export async function seedRunInputs(options: SeedRunInputsOptions): Promise<void> {
  const refs = await listRefs(options);
  if (refs.length === 0) return;
  await prepareDir(options);
  for (const ref of refs) await storeRef(options, ref);
}

async function listRefs(options: SeedRunInputsOptions): Promise<ExecutorRunInput[]> {
  try {
    return await options.port.listRunInputs(options.runId);
  } catch (error) {
    options.log?.("run_inputs.failed", { phase: "list", runId: options.runId, message: (error as Error).message });
    throw new ExecutorError("input_fetch_failed", `拉取初始资料列表失败：${(error as Error).message}`);
  }
}

async function prepareDir(options: SeedRunInputsOptions): Promise<void> {
  try {
    await options.inputs.ensureDir(options.taskSpacePath);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "path_escape") {
      throw new ExecutorError("input_path_invalid", `初始资料目录非法：${options.taskSpacePath}`);
    }
    throw error;
  }
}

async function storeRef(options: SeedRunInputsOptions, ref: ExecutorRunInput): Promise<void> {
  const { log } = options;
  try {
    const existing = await options.inputs.stat(options.taskSpacePath, ref.name);
    if (existing !== null && existing.size === ref.sizeBytes) {
      log?.("run_inputs.skip", { inputId: ref.inputId, name: ref.name });
      return;
    }
    const bytes = await download(options, ref);
    if (bytes.byteLength !== ref.sizeBytes || sha256Hex(bytes) !== ref.sha256) {
      throw new ExecutorError("input_checksum_mismatch", `初始资料校验失败：${ref.name}`);
    }
    await options.inputs.write(options.taskSpacePath, ref.name, bytes);
    log?.("run_inputs.stored", { inputId: ref.inputId, name: ref.name, bytes: bytes.byteLength });
  } catch (error) {
    throw mapSeedError(options, error, ref);
  }
}

async function download(options: SeedRunInputsOptions, ref: ExecutorRunInput): Promise<Uint8Array> {
  try {
    return await options.port.downloadRunInput(ref);
  } catch (error) {
    throw new ExecutorError("input_fetch_failed", `下载初始资料失败：${ref.name}：${(error as Error).message}`);
  }
}

function mapSeedError(options: SeedRunInputsOptions, error: unknown, ref: ExecutorRunInput): Error {
  if (error instanceof ExecutorError) {
    options.log?.("run_inputs.failed", { phase: "store", inputId: ref.inputId, name: ref.name, code: error.code });
    return error;
  }
  if (error instanceof WorkspaceError) {
    if (error.code === "path_escape") return new ExecutorError("input_path_invalid", `初始资料路径非法：${ref.name}`);
    return error;
  }
  return new ExecutorError("input_fetch_failed", `拉取初始资料失败：${ref.name}：${(error as Error).message}`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
