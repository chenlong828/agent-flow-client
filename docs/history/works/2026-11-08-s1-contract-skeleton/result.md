---
layer: works
module: global
status: frozen
updated: 2026-11-08
---

# 工序结果：S1 契约骨架

## 1. 结论摘要

- 完成 S1 批次 2 的 7 个任务：调度器配置/身份、`CMP-gateway` 传输与业务面、桩调度器、`C-05` 下载、`serve` 主循环、S1 门禁。
- `serve` 接桩调度器跑通单节点全链路：注册 → 心跳 → 领取 → 建 session → 装技能 → prompt → 上报 → 退出；真实 DSH ACP 复用 S0 已验收的 `CMP-runtime`。
- `SCN-0001` 的 UC-19/20/21/22/23 与 `REQ-0002` R-01/R-02/R-03/R-08 的 S1 部分有测试；契约测试覆盖请求形状、长轮询、幂等、迟到结果、错误映射与退出码。
- 未完成：真实调度器联调（调度器侧尚无可连实例）；`TC-EXEC-002`（顺序两节点）仍留 S2；`OQ-021`/`OQ-026` 未关闭。

## 2. 任务表

| ID | 任务 | 组件 | 状态 | 提交 |
|---|---|---|---|---|
| `T1` | 调度器配置与身份 | `CMP-cli` | 完成 | `a093f3d` |
| `T2` | 传输/错误/重试/鉴权/版本 | `CMP-gateway` | 完成 | `955cb7d` |
| `T3` | 心跳/领取/绑定/上报/清理 | `CMP-gateway` | 完成 | `955cb7d` |
| `T4` | 桩调度器与契约测试骨架 | 全部 | 完成 | `955cb7d` + 本次 |
| `T5` | `C-05` 下载与 zip 解包 | `CMP-assets` | 完成 | `5556da2` |
| `T6` | `serve` 主循环 | `CMP-cli` | 完成 | `af805f7` |
| `T7` | S1 门禁与收口 | 全部 | 完成（见 §3） | 本次 |

## 3. S1 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| 断网/重复投递下不重复执行（R-01） | 通过 | `tests/components/gateway/gateway.test.ts`（claimRequestId 复用/换新）、`tests/components/executor/execute.test.ts`（同 attempt 单飞） |
| `settled` 结果崩溃重启后可重报（R-02） | 通过 | `tests/scenarios/s1-serve.test.ts`（seed settled → serve recover → accepted）、`reportResult` 5xx 重试 |
| 取消/关闭无残留进程（R-03） | 通过 | `tests/scenarios/s1-serve.test.ts`（cancel 控制事件）、`runtime.test.ts`（进程组回收）、`signals.test.ts`（SIGINT 130） |
| 租约过期/迟到结果有确定行为（UC-21） | 通过 | `transport.test.ts`（`lease_expired` 映射）、`gateway.test.ts`（`late_result` → closed + 审计，不重试） |
| 版本/鉴权失败退出 3（UC-23） | 通过 | `tests/scenarios/s1-serve.test.ts`（401→3、426→3）、`run_superseded`→7 |
| 结果超限截断且可解析（UC-12） | 通过 | `tests/components/result/result.test.ts`、`tests/components/executor/execute.test.ts`（registered limits 截断） |
| 控制事件不丢、不重复应用（UC-20） | 通过 | `tests/components/gateway/gateway.test.ts`（ackSeq 推进、重复 seq 丢弃）、`heartbeat` 失败后 `cleanupAcks` 重发 |
| 释放/清理意图不丢（`SCH-20`） | 通过 | `tests/scenarios/s1-serve.test.ts`（register 的 `cleanupPending` → 心跳 `cleanupAcks`） |

## 4. 实现要点

- `CMP-gateway`：`HttpTransport`（公共头/超时/错误信封）→ `HttpScheduler`（`SchedulerPort`）；`claimRequestId` 重试复用、`ackSeq` 单调去重、租约计时、幂等缓存、`cleanupAcks` 队列。
- `serve`：注册 → 清孤儿 → `reconcileCleanup` → `recover` → 独立心跳 + 领取循环；注册 `limits` 回填 executor；`shutdown` 等待在飞任务并释放实例。
- `C-05`：相对/绝对 URL、304 缓存、`X-Checksum-Sha256`、大小上限、跨 host 不带 token；zip 用系统 `unzip`，解包前校验条目、解包后拒符号链接。
- 配置：`[scheduler].url`/`token` 进 `.config`；`AF_SCHEDULER_TOKEN` 覆盖（用户确认）；`clientId` 持久化 `<stateRoot>/client-id`，`runId` 每进程 UUIDv7。

## 5. 偏差与决定

| 项 | 决定 | 理由 |
|---|---|---|
| token 存 `.config` | 用户确认；env 覆盖优先 | 便于本地联调；日志/错误/结果不输出 token |
| zip 解包工具 | 系统 `unzip`（macOS/Linux） | 不新增 npm 依赖；Windows 留 S3（OQ-007） |
| 真实调度器 | 仅桩（契约附录 A） | 调度器侧尚无实例；契约测试为事实 |
| 顺序两节点 | 未实现（`TC-EXEC-002`） | S2 用例，不阻塞 S1 单节点 |
| 多实例 home | 未派生（OQ-009） | S1 单实例；S2 前另立需求 |

## 6. 遗留与下一步

- 真实调度器联调：注册/心跳/领取/`C-05` 下载的端到端验收。
- `TC-EXEC-002` 顺序两节点（S2）；`serve` 容量上限/多实例派生（S2）。
- `OQ-021` 结果保留窗口、`OQ-026` 模型路由由谁下发。
- 观测 HTTP P1 独立轨道。

## 7. 裁决摘要

P1 实现工序（按冻结契约落地，无契约变更）。blocker 0 / decision 3（token 落配置、系统 unzip、单实例）均落文档 / hold 2（真实调度器联调、S2 多节点）。测试：`bun test` 140+ 用例、`bun run check` 全绿。
