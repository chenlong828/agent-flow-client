---
layer: works
module: global
status: closed
updated: 2026-11-19
procedure: 2026-11-19-confirm-channel-client
---

# 评审：review 应急确认（P2 四档）

> 对象：本工序 diff（`src/`、`tests/`、`docs/design/`、契约副本）。级别 P2：加法契约 + 跨模块改动，无组件切分/数据所有权变化 → 人工最终确认可异步。

## 1 Blocker

无。

## 2 Decision now（冻结后再改就成 breaking change）

| # | 决定 | 理由与证据 |
|---|---|---|
| `D-01` | `confirmation.kind` 不是 `confirmation_request` 时按 `signal_prepare_failed` 硬失败，不静默跳过 | 提案 §4 明确「`--check` 失败，不静默改 kind」；跳过会让 client 少挂工具而调用方以为挂上了。pinning：`tests/components/executor/signal-flow.test.ts`「confirmation.kind 不是 confirmation_request」；实现在 `SignalRunner.prepare` |
| `D-02` | `parseConfirmation` 只做形状提取、`kind` 原样保留；槽位语义在 `prepare` 校验 | wire 层不能因可选字段让整批任务失败（与 `resultSignal` 容忍一致），但也不能静默丢弃错误 kind。pinning：`tests/components/signal/contract.test.ts`「kind 原样保留」+ `D-01` 用例 |
| `D-03` | 续跑 `not_expected` 判据从「`resultSignal.kind === confirmation_request`」改为「没有续跑后仍必须交付的必需结果」（`resultSignalKind` 存在且不是 `confirmation_request`） | 双契约下 review 的 `resultSignal` 是 verdict，沿用旧判据行为不变；只有 `confirmation` 的边界旧判据会误报 `signal.missing`。pinning：`signal-flow.test.ts` 两条续跑用例（确认点续跑 `not_expected`、review 续跑 `missing`） |
| `D-04` | 契约副本本次全量对齐权威文件（含 2026-11-17 观测面 `C-16`/`C-17`、`runId`、`X-Observability-Url` 的遗留漂移），而不只补 confirmation 段落 | 副本是同步件，残留漂移会让联调按副本读错字段。验证：与 orchestrator 文件 diff 只剩 4 行仓库路径/权威说明差异；`C-16`/`C-17` 在 client 已有实现（`transport.ts` 的 `X-Observability-Url`、`runId` 落 observer/store） |

## 3 Verified sound（已查、无需改）

| # | 查了什么 | 怎么查 | 结果 |
|---|---|---|---|
| `V-01` | 无 `confirmation` 的旧任务行为 | `signal-flow.test.ts`「任务没有 resultSignal 与 confirmation」、`wire.test.ts` 字段缺省、全量 255 测试 | 不 prepare、不挂 MCP；`signals` 缺省 |
| `V-02` | 一次 attempt 只挂一个 server | `signal.test.ts` 两契约用例（`mcpServers` 长度 1、`env` 只有一份 `AF_SIGNAL_CONFIG`）、`signal-flow.test.ts`（`runtime.calls[0].mcpServers` 长度 1） | 通过；两个工具有同一 config |
| `V-03` | 工具暴露与分派 | `server.test.ts`：`tools/list` 顺序 `["signal","confirm"]` 且各自 `const` kind；混调两工具写同一 `signals.jsonl`（seq 1/2）；未知工具 `-32602`；kind 与工具不符 `isError` | 通过 |
| `V-04` | 采集按 kind 分派、预算共用 | `signal.test.ts` 两契约用例：合法两行、未挂 kind 行、schema 不符行 → invalid=2；窗口逻辑未变（12 条取末 8） | 通过 |
| `V-05` | 重复 kind 双点拦截 | `signal.test.ts`「重复 kind 按配置错误失败」；`server.test.ts`「`--check` 重复工具名退出非 0」 | 通过 |
| `V-06` | `confirmation` 不支持只跳过 | `signal-flow.test.ts`「confirmation 不支持」：记 `signal.partial`，`resultSignal` 仍挂 1 个工具 | 通过 |
| `V-07` | 门禁与质量规则 | `bun run check`（typecheck + test + docs:check + quality:gate） | 全绿；Q-06 导出数曾 23>20，已收回 `SIGNAL_TOOL_RAW_NAME`/`SIGNAL_TOOL_PUBLIC_NAME`、删除 `specOf` 后达标 |
| `V-08` | 真实 DSH 下模型同时可见两工具 | `probe/dual-tool-e2e.ts`：真实 DSH + 模型，一条 review 任务 | 模型分别调用 `confirm` 与 `signal`；`P-02` 回传两种 kind + `sessionId` |

## 4 Hold（不阻塞本次，转待办）

| # | 事项 | 为什么不阻塞 | 去向 |
|---|---|---|---|
| `H-01` | 与 orchestrator 的 review pass / reject / 无答复 / 取消四条路径联调（`T-CCE-06`） | 属调度侧工序，client 侧证据已到桩调度器 + 真实 DSH 单任务 | 交调度侧；本工序保持 `active` |
| `H-02` | 升级前已落盘的旧 `config.json`（`kind`/`schema`）不再可读，`signals --task` 报 `config.tools 缺失` | 提案 §3.2 允许不兼容内部 config；信号目录默认 7 天清理后自然消失 | 记录在 `result.md`；不写迁移 |
| `H-03` | `signal.prepared`/`signal.collected` 日志字段由 `kind` 改为 `kinds`（数组） | 诊断日志不是契约；双契约下数组更准确 | 联调时同步给调度侧；`CMP-cli` 规格已更新 |
| `H-04` | 真实 orchestrator 尚未验证「两契约在 `S-05` 下重派原样下发」 | 冻结/重派在调度器侧（`task.result_signal` 列），client 只消费 poll 响应 | `T-CCE-06` 覆盖 |

## 5 结论

**通过（P2）**。无 blocker；`D-01`–`D-04` 已落 pinning 测试与文档；`H-01`–`H-04` 已登记。合并前需人工确认（P2 门），确认后按 `result.md` 的落点提交。
