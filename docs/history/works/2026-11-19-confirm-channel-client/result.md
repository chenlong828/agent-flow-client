---
layer: works
module: global
status: frozen
updated: 2026-11-19
procedure: 2026-11-19-confirm-channel-client
---

# 结果：review 应急确认（`T-CCE-04`）

## 1 结论

client 侧多契约 prepare / mount / collect 已落地：review 任务一次 attempt 挂一个 `agentflow` server、同时暴露 `mcp__agentflow__signal` 与 `mcp__agentflow__confirm`；采集按 `kind` 分派校验，两种信号随 `succeeded` 回传。没有 `confirmation` 的旧任务行为不变。`bun run check` 全绿（typecheck、255 个测试、docs:check、quality:gate）。2026-11-19 调度侧反馈联调（`T-CCE-06`）通过，工序收口。

## 2 落地清单

| 单元 | 文件 |
|---|---|
| 契约值类型与解析（`SignalContractSpec`、`parseConfirmation`、工具名映射） | `src/components/signal/contract.ts` |
| plan/config 形状（`contracts[]` / `tools[]`） | `src/components/signal/plan.ts` |
| 采集按 kind 分派、窗口/预算共用 | `src/components/signal/collect.ts` |
| 记录校验改为「契约（kind+schema）」入参 | `src/components/signal/validate.ts` |
| `FileSignal.prepare`（契约集合、重复 kind/schema 检查）/`collect` | `src/components/signal/signal.ts` |
| config 读写（`tools[]`） | `src/components/signal/directory.ts` |
| stdio server：`tools/list` 每契约一项、`tools/call` 按名分派、`--check` 查重 | `src/mcp/signal-server.ts` |
| 端口与值类型（`SignalPort`、`TaskRequest.confirmation`） | `src/components/executor/{ports,types}.ts` |
| 契约取舍（unsupported/partial/kind 错误）、续跑语义、日志 `kinds` | `src/components/executor/signal-runner.ts` |
| poll 响应解析 | `src/components/gateway/wire.ts` |
| 本地 `run --request` 解析 | `src/components/cli/request.ts` |
| `signals` 命令（kinds、按 config.tools 采集） | `src/components/cli/signals.ts` |
| `doctor` 的 `signal.check` 夹具换 `tools[]` | `src/components/cli/doctor-checks.ts` |
| 测试夹具（两契约单一来源、按契约逐个模拟工具调用） | `tests/support/signal-contract.ts`、`tests/fixtures/fake-acp.mjs` |
| 测试 | `tests/components/signal/{contract,signal,server}.test.ts`、`tests/components/executor/signal-flow.test.ts`、`tests/components/gateway/wire.test.ts`、`tests/components/cli/{request,signals}.test.ts`、`tests/scenarios/confirm-flow.test.ts` |
| 文档 | `docs/design/components/CMP-signal/spec.md`；`CMP-executor`/`CMP-gateway`/`CMP-cli` 规格；`architecture.md`；契约副本 `executor-http-v3.md` |
| 真实 DSH 探针 | `probe/dual-tool-e2e.ts` |

## 3 验收对照

| 验收项（提案 §6） | 证据 |
|---|---|
| 1. review 任务模型可见两个工具 | `server.test.ts`「两个契约：`tools/list` 同时有 signal 与 confirm」；**真实 DSH**：`probe/dual-tool-e2e.ts` 模型分别调用 `confirm` 与 `signal`，`config.json.tools = ["review_verdict","confirmation_request"]` |
| 2. 调 `confirm` 后 `signals` 含 `confirmation_request`、`succeeded` + `sessionId` | 真实 DSH 探针输出：`status=succeeded`、`sessionId=4d5aa92a-…`、`signals[0].kind=confirmation_request`、`signals[1].kind=review_verdict`；`confirm-flow.test.ts` 桩调度器同断言 |
| 3. 续跑任务 `resumeSessionId` 正确、仍挂两工具 | `confirm-flow.test.ts`「review 双契约…续跑仍挂两工具」：`session/resume` 日志、`second.sessionId === sessionId`、第二个 attempt 的 `config.tools` 仍两项、混采两种 kind |
| 4. 无 `confirmation` 的旧任务不变 | `signal-flow.test.ts`「任务没有 resultSignal 与 confirmation」；`wire.test.ts`/`request.test.ts` 字段缺省；全量 255 测试回归 |
| 5. `bun run check` | 全绿（见 §5） |
| 6. 契约副本同步 | `executor-http-v3.md`：`TaskRequest.confirmation`、`ResultSignalContract` 注释、`S-05`、`C-13`/`C-15`、§11.7；与权威文件仅剩 4 行仓库路径/权威说明差异 |

补充：`confirmation` 不支持（version 不符）只跳过并记 `signal.partial`、`resultSignal` 照常挂载（`signal-flow.test.ts`）；`confirmation.kind` 错误按 `signal_prepare_failed` 失败（同文件）。

## 4 实施中的取舍

1. **契约在 `SignalRunner` 取舍、`FileSignal` 只负责落地**：`resultSignal` 不支持 → 整个 attempt 降级（沿用旧语义）；`confirmation` 不支持 → 只跳过它（可选契约不判失败）。`FileSignal.prepare` 仍做防御性检查（重复 kind、schema 非法）。
2. **`collect` 只收 `plan`**：契约集合单一来源是 `SignalPlan.contracts`，端口不再重复传 `contracts`，避免两份不一致。
3. **续跑 `not_expected` 判据**：改为「没有续跑后仍必须交付的必需结果」，review 续跑缺 verdict 仍记 `signal.missing`（让 orchestrator 按 `verdict_invalid` 暴露），确认点续跑记 `signal.not_expected`。
4. **日志字段 `kinds`**：`signal.prepared`/`signal.collected` 由单数 `kind` 改为数组，`serve.started` 的 `signalKinds` 与 `task.reported` 的 `signals{kinds}` 形状不变。
5. **config 不兼容旧形状**：提案 §3.2 允许；`signals` 命令对升级前旧 attempt 会报 `config.tools 缺失`，信号目录默认 7 天清理后自然消失（`H-02`）。
6. **契约副本全量对齐**：顺带补齐此前未同步的观测面 `C-16`/`C-17`、`runId`、`X-Observability-Url`（`D-04`），避免副本继续漂移。
7. **测试夹具去重**：`confirmation_request` 契约原先在三个测试文件各写一份，统一到 `tests/support/signal-contract.ts`。

## 5 门禁与证据

- `bun run typecheck`：通过。
- `bun test`：255 pass / 0 fail（41 文件，863 expect）。
- `bun run docs:check`：场景索引最新（2 个场景）。
- `bun run quality:gate`：违规 0；16 项规则全 PASS。
- 真实 DSH 探针：`bun run docs/history/works/2026-11-19-confirm-channel-client/probe/dual-tool-e2e.ts` → `succeeded`、两种 kind、`serve-exit=0`。

## 6 未做与下一步

- 与 orchestrator 的四条路径联调（`T-CCE-06`）已由调度侧执行并于 2026-11-19 反馈通过；工序收口，目录待归档到 `docs/history/works/`。
- 旧 `config.json` 兼容（`H-02`）、日志字段变更同步（`H-03`）、`S-05` 重派验证（`H-04`）见 `review.md`。
- 真实模型只跑了一条「先 confirm 再 verdict」的路径；「呼人后停轮、等人答复再续跑」的真实模型行为由调度侧联调覆盖。
