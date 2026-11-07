export type AssetErrorCode =
  | "download_failed"
  | "checksum_mismatch"
  | "unpack_failed"
  | "invalid_skill_format"
  | "io_error"
  | "asset_skill_set_conflict";

export class AssetError extends Error {
  readonly code: AssetErrorCode;

  constructor(code: AssetErrorCode, message: string) {
    super(message);
    this.name = "AssetError";
    this.code = code;
  }
}
