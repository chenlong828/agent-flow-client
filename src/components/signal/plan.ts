/** 信号目录/配置/计划形状（client 内部；不进出执行面契约）。 */
import type { McpServerSpec, RestrictedSchema } from "./contract.ts";

/** 一次 attempt 的信号准备结果。 */
export type SignalPlan = {
  taskId: string;
  attempt: number;
  kind: string;
  dir: string;
  configPath: string;
  outputPath: string;
  mcpServers: McpServerSpec[];
};

/** server 启动配置（`AF_SIGNAL_CONFIG` 指向的文件）。 */
export type SignalServerConfig = {
  version: number;
  kind: string;
  taskId: string;
  attempt: number;
  /** 追加目标（绝对路径）。 */
  output: string;
  schema: RestrictedSchema;
  limits: { maxSignals: number; maxBytes: number };
};
