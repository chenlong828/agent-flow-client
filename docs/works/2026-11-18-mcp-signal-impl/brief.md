---
layer: works
module: global
status: active
updated: 2026-11-18
procedure: 2026-11-18-mcp-signal-impl
level: P1
---

# 工序：MCP 结果信号实现（T-RVM-10 / T-RVM-03 / T-RVM-04）

> 上游：提案 [`2026-11-18-review-verdict-mcp`](../../../../agent-flow-orchaster/docs/works/2026-11-18-review-verdict-mcp/proposal.md)（定稿版）+ client 评审 [`2026-11-18-mcp-signal-feedback/review.md`](../2026-11-18-mcp-signal-feedback/review.md)（§9 定稿复核：无冲突、可执行）。
> 用户 2026-11-18 确认：按「新增 L0 `CMP-signal`」落地，直接执行；完成后输出更新后的契约供调度层对接验证。

## 1 范围

| 做 | 不做 |
|---|---|
| `T-RVM-10` P1 结构决策：新增 L0 `CMP-signal` + `SignalPort` | 改 orchestrator 仓库代码 |
| `T-RVM-03` signal server（`src/mcp/signal-server.ts`）+ 契约/投影/校验 + 单测 | Windows 与单二进制打包（`T-RVM-02` 遗留） |
| `T-RVM-04` runtime `mcpServers`、`AcpProtocol` 透出 `details`、executor prepare/collect/挂载重试/归因、result 预算 | §5.5 第二场景（`T-RVM-09`） |
| 契约加法 `C-13`/`C-14` + 组件规格 + 架构/数据所有权更新 | 改 `P-02` 端点语义、改 scheduler |

## 2 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| `T-RVM-10` | design | `CMP-signal` / `CMP-executor` | 结构决策：新增 L0 组件、`SignalPort` 归属、数据所有权、清理策略 | 完成 |
| `T-RVM-03` | change | `CMP-signal` | 契约/投影/校验、目录与 config、预检、采集、清理、stdio server、单测 | 完成 |
| `T-RVM-04` | change | `CMP-runtime` / `CMP-executor` / `CMP-result` / `CMP-gateway` | `newSession` 可选参、`details` 透出、prepare/collect、挂载重试、归因、预算、`resultSignal` 解析、配置键 | 完成 |
| `T-RVM-02` | verify | `CMP-signal` | 打包形态（单二进制 `signal-server` 子命令）完成；Windows 冒烟未做 | 部分完成 |
| `T-RVM-09` | change | `CMP-signal` / `CMP-runtime` / `CMP-executor` | 确认点：`confirmation_request` kind、`mcp__agentflow__confirm` 工具、`resumeSessionId` 续跑；桩调度器 + 桩 DSH 自测；真机 resume 实测 | 完成（client 侧） |
| `T-RVM-08` | verify | both | 与 orchestrator 的兼容矩阵、`SCN-0302` 断言（client↔DSH 真机链路已完成，见 `result.md` §3） | 待调度面联调 |
| `T-FIX-01` | change | `CMP-observer` | 续跑同 sessionId 多 attempt：`findBySession` 取最新（P3） | 完成 |

## 3 装载清单

- 契约：`docs/design/contracts/executor-http-v3.md` §4.2、§5、§7
- 规格：`docs/design/components/CMP-signal/spec.md`、`CMP-executor`、`CMP-runtime`、`CMP-result`、`CMP-gateway`
- 代码：`src/components/signal/*`、`src/mcp/signal-server.ts`、`src/components/{executor,runtime,result,gateway}/*`
- 测试：`tests/components/signal/*`、`tests/scenarios/signal-flow.test.ts`、`tests/fixtures/fake-acp.mjs`

## 4 验收标准

1. `bun run check` 全绿（typecheck + test + docs:check + quality:gate）。
2. 四条硬约束有测试：`server/discover` 立即回错、挂载失败同参重建一次、失败归因、signals 与 message 共享预算。
3. 契约加法可被调度面直接消费：`TaskRequest.resultSignal`、`TaskResult.signals`、两个新错误码、`C-13`/`C-14`、`S-05` 稳定内容。
4. 不改变未带 `resultSignal` 的既有行为（旧 orchestrator + 新 client 组合仍可用）。
5. 结构变更落 `architecture.md`：第 10 个组件、`SignalPort`、`<stateRoot>/signals/` 数据所有权。
