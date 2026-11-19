import type { ExecutorRunInput } from "../executor/types.ts";
import { GatewayError } from "./errors.ts";
import { asArray, asNumber, asRecord, asString } from "./wire.ts";

const RUN_INPUT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** `EXE-06`：严格解析初始资料列表；`downloadPath` 必须精确指向本 run 的该 input。 */
export function parseRunInputs(body: unknown, runId: string): ExecutorRunInput[] {
  const root = asRecord(body, "runInputs");
  return asArray(root.items, "runInputs.items").map((raw, index) => {
    const item = asRecord(raw, `runInputs.items[${index}]`);
    const inputId = asString(item.inputId, `runInputs.items[${index}].inputId`);
    const name = asString(item.name, `runInputs.items[${index}].name`);
    const mediaType = asString(item.mediaType, `runInputs.items[${index}].mediaType`);
    if (!(RUN_INPUT_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
      throw new GatewayError("protocol_error", `初始资料类型不受支持：${mediaType}`);
    }
    const sizeBytes = asNumber(item.sizeBytes, `runInputs.items[${index}].sizeBytes`);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new GatewayError("protocol_error", `初始资料大小非法：${String(sizeBytes)}`);
    }
    const sha256 = asString(item.sha256, `runInputs.items[${index}].sha256`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new GatewayError("protocol_error", `初始资料摘要非法：${sha256}`);
    const downloadPath = asString(item.downloadPath, `runInputs.items[${index}].downloadPath`);
    assertInputDownloadPath(downloadPath, { runId, inputId });
    return {
      inputId,
      name,
      mediaType: mediaType as ExecutorRunInput["mediaType"],
      sizeBytes,
      sha256,
      downloadPath,
    };
  });
}

/**
 * `EXE-07` 下载路径必须是 `/runs/<runId>/inputs/<inputId>`：
 * 不给 `expected` 时只校验形状（下载侧）；给了就要求对应字段一致（列表侧）。
 */
export function assertInputDownloadPath(path: string, expected?: { runId?: string; inputId?: string }): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new GatewayError("protocol_error", `初始资料下载路径非法：${path}`);
  }
  const match = /^\/runs\/([^/]+)\/inputs\/([^/]+)$/.exec(decoded);
  if (match === null || decoded.includes("..") || path.includes("://")) {
    throw new GatewayError("protocol_error", `初始资料下载路径非法：${path}`);
  }
  if (
    expected !== undefined &&
    ((expected.runId !== undefined && match[1] !== expected.runId) ||
      (expected.inputId !== undefined && match[2] !== expected.inputId))
  ) {
    throw new GatewayError("protocol_error", `初始资料下载路径与 run/input 不匹配：${path}`);
  }
}
