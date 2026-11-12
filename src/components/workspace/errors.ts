export type WorkspaceErrorCode =
  | "pack_failed"
  | "not_prepared"
  | "layout_invalid"
  | "path_escape"
  | "permission_denied"
  | "disk_full";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}
