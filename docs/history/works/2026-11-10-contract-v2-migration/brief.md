---
layer: works
module: global
status: active
updated: 2026-11-10
---

# 工序 Brief：执行面契约 v2 迁移

> 输入：调度器侧 `agent-flow-orchaster/docs/works/2026-11-10-executor-contract-v2/contract-v2.md`（2026-11-10，at-least-once、三端点）。
> 本地副本：`docs/design/contracts/executor-http-v2.md`；v1 已归档到 `docs/history/works/2026-11-10-contract-v2-migration/executor-http-v1.md`。

## 1. 背景与取舍

- 产品裁决把执行语义从 exactly-once 改为 at-least-once：任务最终跑完即可，允许重复与中断重跑。
- 目标流程简化为「任务列表 → 取一条 → 执行 → 回报 → 取下一条」。
- 调度器侧 v1 实现为零，因此 v2 不做兼容、直接替换；client 侧是唯一迁移成本。
- 放弃的保证：exactly-once、控制有序/补发、崩溃清理补偿、迟到结果审计、单实例单写者；均有对应兜底（`S-08` 首份为准、电平控制、工作区保留、`accepted=false`、流程层避免并发写）。
- 保留：`timeoutMs` + 进程组回收、结果先落盘后上报、工作区默认保留、结果截断、digest 幂等、路径约束、孤儿清理。

## 2. 本工序的 client 实现决定

| 项 | 决定 |
|---|---|
| 并发默认值 | `[capacity].max_concurrent` 默认 4（沿用原 `max_instances=4`） |
| idle 看门狗 | `[executor].idle_timeout_ms` 默认 0（关闭）；C-06 默认关闭 |
| 状态机 | 本地只保留 `received → running → settled → reported`；`settled` = 结果已落盘未确认，进 `finished[]` |
| 实例锁 | 删除（v2 允许同实例多任务）；技能安装仍用 `.dsh/.install.lock` 单临界区 |
| 技能冲突守卫 | 删除；同实例并发任务由调度器 `S-06` 保证同 digest |
| 进程模型 | 一实例一 DSH 进程、多 session；任务超时只关自己的 session，实例无活跃 session 时才回收进程组（避免连带杀死同实例其它任务） |
| 技能包 | 保留 assets 直连 `P-03`；路径改为 `/skill-packages/{packageId}`；serve 注入 gateway 的下载器；`run` 只用本地来源 |
| 身份 | 删除 clientId/runId 持久化；只保留 Bearer + `X-Executor-Protocol: 2` + 可选 `X-Request-Id` |
| 恢复 | 启动清孤儿；journal 中 `settled` 结果进 `finished[]` 补报；`received/running` 直接丢弃（调度器静默回队重派） |

## 3. 任务表

| ID | 类型 | 组件 | 任务 | 状态 |
|---|---|---|---|---|
| `T1` | docs | 契约 | v2 副本、v1 归档、架构/规格/场景引用切换 | 进行中 |
| `T2` | feature | `CMP-executor`/`CMP-result` | 值类型、端口、结果类型去 `retryable`、journal 简化 | 待开始 |
| `T3` | feature | `CMP-gateway` | `poll`/`reportResult`/`downloadPackage`、头部、错误码、删 state | 待开始 |
| `T4` | feature | `CMP-executor`/`CMP-cli` | 任务模型、去 cleanup/冲突守卫、`run` 适配 | 待开始 |
| `T5` | feature | `CMP-assets` | `P-03` 路径、下载器注入、同 digest 短路 | 待开始 |
| `T6` | feature | `CMP-cli` | 单 poll 循环、`running`/`finished`、`stop`/`cancelInstances`、配置 | 待开始 |
| `T7` | test | 全部 | v2 桩调度器、契约与门禁测试、文档收口 | 待开始 |

## 4. 验收

- 契约 §10.1 桩最小面 8 条 + §10.2 client 门禁 6 条。
- `bun run check` 全绿；v1 专属测试删除或改写，不留 skip。
- 文档：`architecture`/组件规格/`SCN-0001`/`REQ-0002`/test-matrix 与 v2 一致，v1 不再作为依据。

## 5. 风险

| 风险 | 处理 |
|---|---|
| 同实例并发 + 超时组杀 | 采用「最后 session 才回收进程组」；在 result 文档中标注与 C-05 字面差异 |
| 技能集并发切换 | 依赖 `S-06`；client 不做冲突拒绝（按 v2 交付清单），安装临界区保序 |
| 结果先落盘 | journal `settled` 即持久化，`finished[]` 直到 accepted |
| 轮询忙等 | `nextPollAfterMs=0` 时加 10ms 下限 |
