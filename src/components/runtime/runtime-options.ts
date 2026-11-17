import type { PermissionDecision, SessionEvent } from "../executor/ports.ts";
import type { AcpCommand } from "./acp-client.ts";
import type { ProfileModel } from "./profile.ts";

export type RuntimeOptions = {
  command: AcpCommand;
  env: Record<string, string | undefined>;
  permission: PermissionDecision;
  model?: ProfileModel;
  credentialsSource?: string;
  onStderr?: (line: string) => void;
  onEvent?: (event: SessionEvent) => void;
  /** 权限请求的观测回调；decision 是实际裁决方向。 */
  onPermission?: (sessionId: string, params: unknown, decision: "allow" | "deny") => void;
};

export type ReapOrphanResult = boolean;
