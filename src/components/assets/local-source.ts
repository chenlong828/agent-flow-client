import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { AssetError } from "./errors.ts";

/** S0 技能包来源：`file://` 或本地绝对路径目录；HTTP 留 S1（C-05）。 */
export async function resolveLocalSource(downloadUrl: string): Promise<string> {
  let path: string;
  if (downloadUrl.startsWith("file://")) {
    path = fileURLToPath(downloadUrl);
  } else if (isAbsolute(downloadUrl)) {
    path = downloadUrl;
  } else {
    throw new AssetError("download_failed", `S0 只支持 file:// 或本地绝对路径：${downloadUrl}`);
  }
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new AssetError("download_failed", `技能包目录不存在：${path}`);
  }
  return path;
}
