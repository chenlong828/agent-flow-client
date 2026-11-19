/** 信号目录/配置/计划形状（client 内部；不进出执行面契约）。 */
import type { McpServerSpec, SignalContractSpec } from "./contract.ts";

/** 一次 attempt 的信号准备结果；`contracts` 是本次挂载的全部工具契约。 */
export type SignalPlan = {
  taskId: string;
  attempt: number;
  contracts: SignalContractSpec[];
  dir: string;
  configPath: string;
  outputPath: string;
  mcpServers: McpServerSpec[];
};

/** server 启动配置（`AF_SIGNAL_CONFIG` 指向的文件）；一个 server 可暴露多个工具。 */
export type SignalServerConfig = {
  version: number;
  taskId: string;
  attempt: number;
  /** 追加目标（绝对路径）。 */
  output: string;
  /** 本次 attempt 挂载的工具：kind → 工具名（`SIGNAL_TOOL_NAME_BY_KIND`），各带 data schema。 */
  tools: SignalContractSpec[];
  limits: { maxSignals: number; maxBytes: number };
};
