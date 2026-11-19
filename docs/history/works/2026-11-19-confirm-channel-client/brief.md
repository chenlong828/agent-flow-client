---
layer: works
module: global
status: frozen
updated: 2026-11-19
procedure: 2026-11-19-confirm-channel-client
level: P2
---

# 工序：review 应急确认（`T-CCE-04`）

> 上游：调度侧提案 [`client-implementation-proposal.md`](../../../../../agent-flow-orchaster/docs/works/2026-11-19-confirm-channel-escalation/client-implementation-proposal.md)（orchestrator 侧契约与调度已落地，等 client 完成后联调 `T-CCE-06`）。
> 用户 2026-11-19 确认：按提案在 client 侧实现多契约 prepare/mount/collect，完成后供调度侧联调。
> 2026-11-19 调度侧反馈联调通过（`T-CCE-06`），工序收口。

## 1 范围

| 做 | 不做 |
|---|---|
| `TaskRequest.confirmation` 解析（wire + 本地 `run --request`） | 改 orchestrator 仓库代码 |
| 一次 attempt 一个 `agentflow` server、每个契约一个工具（`signal` / `confirm`） | 挂两个 MCP server（同名 server 不能重复挂） |
| 采集按 `kind` 分派校验；窗口/字节预算多 kind 共用 | 改 `P-02` 端点语义、协议版本、任务状态 |
| `SignalRunner` 契约取舍：不支持/partial/kind 错误 | 通用聊天、任意节点呼人、确认次数计数 |
| 契约副本与组件规格同步；`bun run check` 全绿 | 旧 client 能力协商（v1 同版本发布） |

## 2 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| `T-CCE-04-01` | design | `CMP-signal` / `CMP-executor` | 契约集合：`SignalContractSpec`、`SignalPlan.contracts`、`SignalServerConfig.tools`、`SignalPort` 签名 | 完成 |
| `T-CCE-04-02` | change | `CMP-signal` | `prepare`/`collect`/`--check` 支持多契约；按 kind 分派校验；重复 kind 配置失败 | 完成 |
| `T-CCE-04-03` | change | `CMP-signal`（server） | `tools/list` 每个契约一项；`tools/call` 按工具名分派；同一 `signals.jsonl`/`seq` | 完成 |
| `T-CCE-04-04` | change | `CMP-executor` / `CMP-gateway` / `CMP-cli` | `TaskRequest.confirmation`、`SignalRunner` 契约取舍与续跑语义、`signals` 命令/doctor 换 config 形状 | 完成 |
| `T-CCE-04-05` | verify | `CMP-signal` | 单测 + 桩调度器/桩 DSH 端到端（review 双契约、续跑仍挂两工具） | 完成 |
| `T-CCE-04-06` | verify | `CMP-signal` | 真实 DSH：模型同时可见两个工具并分别调用 | 完成（见 `probe/dual-tool-e2e.ts`） |
| `T-CCE-06` | verify | both | 与 orchestrator 的 review pass/reject/无答复/取消四条路径联调 | 完成（调度侧 2026-11-19 反馈联调通过） |

## 3 装载清单

- 契约：`docs/design/contracts/executor-http-v3.md` §5、§7（`C-13`/`C-15`）、`S-05`、§11.7
- 规格：`docs/design/components/CMP-signal/spec.md`、`CMP-executor`、`CMP-gateway`、`CMP-cli`
- 代码：`src/components/signal/*`、`src/mcp/signal-server.ts`、`src/components/{executor,gateway,cli}/*`
- 测试：`tests/components/signal/*`、`tests/components/executor/signal-flow.test.ts`、`tests/scenarios/confirm-flow.test.ts`、`tests/fixtures/fake-acp.mjs`

## 4 影响规格（P2）

- **外部契约**：`TaskRequest` 增可选 `confirmation: ResultSignalContract`（`kind=confirmation_request`、`required=false`）；加法字段，不升协议版本。`TaskResult.signals` 形状不变，可同时含两种 kind。
- **内部契约**：`SignalPlan.kind` → `contracts: SignalContractSpec[]`；`SignalServerConfig.kind/schema` → `tools: SignalContractSpec[]`。config 是 client 内部文件，不兼容旧形状（提案 §3.2 明确）。
- **组件间关系**：`SignalPort.prepare` 收契约集合、`collect` 只收 `plan`（契约单一来源在 plan）；`CMP-signal` 仍是唯一写 `<stateRoot>/signals/` 的组件，数据所有权不变。
- **不受影响**：网关端点、结果预算（`CMP-result`）、runtime session 语义、store/journal、无 `confirmation` 的旧任务行为。

## 5 验收标准

1. review 任务拿到 `resultSignal` + `confirmation` 后，模型可见工具列表同时有 `mcp__agentflow__signal` 与 `mcp__agentflow__confirm`。
2. 调 `confirm` 后 `TaskResult.signals` 含 `confirmation_request`，`status=succeeded` 且带 `sessionId`。
3. 人工 `decide` 后的续跑任务 `resumeSessionId` 正确，仍挂两个工具；提交 `review_verdict` 后 orchestrator 能正常结算/回退。
4. 没有 `confirmation` 的旧任务（agent/start/end/confirm）行为不变。
5. `bun run check`（typecheck + test + docs:check + quality:gate）通过。
6. 契约副本同步（`TaskRequest.confirmation`、`C-13`/`C-15`/`S-05`/§11.7）。
