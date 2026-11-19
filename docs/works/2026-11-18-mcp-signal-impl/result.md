---
layer: works
module: global
status: active
updated: 2026-11-18
---

# 结果：MCP 结果信号实现

## 1 结论

`T-RVM-10`、`T-RVM-03`、`T-RVM-04` 全部落地；`bun run check` 全绿（typecheck、220 个测试、docs:check、quality:gate）。契约加法 `C-13`/`C-14` 已写进 [`executor-http-v3.md`](../../design/contracts/executor-http-v3.md)，调度面可直接按 [`contract-diff.md`](contract-diff.md) 对接验证。与 orchestrator 的真实端到端（`T-RVM-08`）待调度面联调。

## 2 落地清单

| 单元 | 文件 |
|---|---|
| 契约/投影/校验（纯模块，client 与 server 共用） | `src/components/signal/contract.ts` |
| 目录与 config、保留期清理 | `src/components/signal/directory.ts` |
| 采集（半行/非法行忽略、最后窗口、字节上限） | `src/components/signal/collect.ts` |
| `mcpServers` 构造与挂载失败归因 | `src/components/signal/mcp.ts` |
| `CMP-signal`（`SignalPort` 的 L0 实现） | `src/components/signal/signal.ts` |
| stdio signal server（`--check`、`tools/list`、`tools/call`、`server/discover` 回错） | `src/mcp/signal-server.ts` |
| 端口 | `src/components/executor/ports.ts`（`SignalPort`、`newSession` 可选参） |
| 执行流程 | `src/components/executor/executor.ts`（prepare、挂载重试、collect、归因、事件） |
| 结果预算 | `src/components/result/result.ts`（`signals` 组装与共享预算、两个错误码映射） |
| 入参解析 | `src/components/gateway/wire.ts`（`resultSignal`） |
| 运行期 | `src/components/runtime/runtime.ts`（`mcpServers`/超时）、`runtime/acp-protocol.ts`（透出 `error.data`）、`runtime/errors.ts` |
| 配置 | `src/components/cli/config.ts`（`[acp].session_new_timeout_ms`、`[signal].retention_days`） |
| 装配与启动清理 | `src/components/cli/{compose,serve-compose,serve}.ts` |
| 文档 | `docs/design/components/CMP-signal/spec.md`；`architecture.md`、`CMP-executor`/`CMP-runtime`/`CMP-result`/`CMP-gateway` 规格；契约 |

## 3 验收对照

| 验收项 | 证据 |
|---|---|
| `server/discover` 立即回 `-32601`（A-11） | `tests/components/signal/server.test.ts`（< 2s 断言） |
| 挂载失败同参重建一次（Q-07） | `tests/components/executor/signal-flow.test.ts`、`tests/scenarios/signal-flow.test.ts` |
| 归因：非 MCP 失败不重试、不写 `signal_mount_failed`（Q-09） | `signal-flow.test.ts` |
| collect 在 closeSession 之前（A-05） | `signal-flow.test.ts`（顺序断言） |
| signals 只在 succeeded、预算共享、超限丢弃（A-04/C-14） | `tests/components/result/signals.test.ts` |
| `resultSignal` 解析与脏数据容忍（C-13） | `tests/components/gateway/wire.test.ts` |
| 旧 orchestrator 组合不变 | 全量回归 220 测试通过；未带 `resultSignal` 的任务不挂 MCP |
| 真实 ACP 链路（executor + AcpRuntime + FileSignal） | `tests/scenarios/signal-flow.test.ts`（fake-acp 记录 `mcpServers` 并模拟调用） |
| **真实 DSH 端到端** | `run --request` + DSH `0.2.2-alpha.2` + `hs-deepseek-flash-latest`：模型调用 `mcp__agentflow__signal`，`P-02.signals` 返回 `{verdict:"pass", reason:"e2e-real-dsh"}`，`state/signals/<taskId>/1/signals.jsonl` 落盘 |
| 单二进制分发 | `bun build --compile` 产物跑 `signal-server --check`、`initialize`、`tools/list`、`tools/call`、`server/discover`（-32601）全部通过；`resolveSignalServerCommand` 有单测 |
| `run` 单次模式与 serve 同语义（A-15） | `tests/components/cli/request.test.ts`：`resultSignal` 透传；e2e 前发现 `loadLocalRequest` 漏解析，已修 |
| 确认点（第二场景） | `tests/scenarios/confirm-flow.test.ts`：桩调度器两次任务——第一次回 `confirmation_request` + `sessionId`，第二次带 `resumeSessionId` 续跑；`tests/components/signal/server.test.ts` 覆盖 `confirm` 工具与 kind→工具映射 |
| **桩调度器 + serve 联调 smoke** | [`probe/mock-e2e.ts`](probe/mock-e2e.ts)：桩调度器派发带 `resultSignal` 的 review 任务 → `serve` → 真实 DSH 调用 `mcp__agentflow__signal` → `P-02` 收到 `signals[0].data.verdict=pass`；`stop` 后 `serve` 退出 0 |

## 4 实施中的取舍

1. **上报窗口**：`TaskResult.signals` 取最后 8 条合法记录（按 seq），`CMP-run` 仍取最后一条判定；比「只报一条」多留排障信息，且不超预算。
2. **契约脏数据**：`resultSignal` 形状非法按「不支持」处理（不挂 MCP、不发 signals），不判任务失败；生成端的校验交给调度面 `validateDraft`。
3. **server 分发**：用 `process.execPath`（Bun）+ 仓库内绝对脚本路径，无构建产物；单二进制打包时另发 `agentflow-signal`（遗留 `T-RVM-02`）。
4. **事件名**：沿用提案的 `signal.prepared`/`signal.disabled`/`signal.mount_retry`/`signal.collected`/`signal.missing`/`signal.invalid`，由 CLI 注入 logger。
5. **清理时机**：`serve` 启动时清理过期目录；`doctor` 已加 `signal.dir`/`signal.server`/`signal.check`/`signal.kinds` 四项检查。
6. **`run` 模式曾漏解析 `resultSignal`**：真机 e2e 第一跑复现（任务成功但没有信号，模型自称手动连 server 属幻觉）；已修 `loadLocalRequest` 并补测试。
7. **单二进制分发**：编译产物用自身 + 隐藏子命令 `signal-server`，不再依赖旁路 TS 脚本；`--check`/工具调用已实测。
8. **续跑能力（§5.5）**：真机实测 `session/resume` 在 `session/close` 之后、以及 DSH 进程重启之后都可续跑同一 session；client 已加 `RuntimePort.resumeSession` 与 `TaskRequest.resumeSessionId`，确认点流程见 `tests/scenarios/confirm-flow.test.ts`。

## 4.1 联调摩擦点修复（2026-11-18，按调度面反馈）

| # | 修复 | 落点 |
|---|---|---|
| 1 | `serve.started` 带 `schedulerUrl`/`clientId`/`stateRoot`/`dshHome`/`signalKinds`（不含 token） | `serve.ts`；`tests/scenarios/confirm-flow.test.ts` 断言 |
| 2 | `task.reported` 带 `signals{count,kinds}`、`resumeSessionId`、`continuation` | `serve-loops.ts`；同上断言 |
| 3 | 确认点续跑不再误报 `signal.missing`，改 `signal.not_expected(reason=continuation)`；review 续跑仍报 missing 并带 `resumeSessionId` | `signal-runner.ts`；`executor/signal-flow.test.ts` |
| 4 | 新增 `agent-flow-client signals --task <id> [--attempt n] [--json]`；doctor 显示 signal 目录 | `cli/signals.ts`；`tests/components/cli/signals.test.ts` |
| 5 | `session/resume` 失败 message 带 `sessionId`/`cwd`/`mcpServers`，并记 `signal.resume_failed`（错误码仍 `protocol_error`） | `runtime.ts`、`signal-runner.ts`；`runtime.test.ts` |
| 附 | `doctor` 加 `signal.*` 四项；`AF_SCHEDULER_URL` env 覆盖；契约/结果文档口径收口 | `doctor-checks.ts`、`config.ts`、docs |
| 附 | 续跑后同一 `sessionId` 多个 attempt：`findBySession` 改取最新（`startedAt` 降序、同刻 `attemptId` 降序、忽略 `goneAt`），`O-06/O-07/O-08/O-11` 共用 | `observer/attempt-store.ts`；`tests/components/observer/attempt-store.test.ts`；`client-observability-v1.md` §2/§8.1 |

## 5 未做与下一步

- Windows 冒烟（`bun.exe`、盘符/空格路径、SIGTERM 语义）；实现层已无 shell 依赖，打包形态已解决。
- §5.5 的 `mcp__agentflow__confirm` 工具与 `confirmation_request` kind：等 orchestrator 契约与 UI `decide` 口径（`T-RVM-09`）再实现；client 侧 resume 能力已就绪。
- 与 orchestrator 的兼容矩阵与真实 DSH 端到端（`T-RVM-08`，需调度面参与）。
- `§5.5` 第二场景（`session/resume` + `mcp__agentflow__confirm`，`T-RVM-09`）。
- `doctor` 增加信号目录检查；`idle_timeout` 与工具调用等待的组合用例。
