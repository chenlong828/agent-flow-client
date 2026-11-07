---
layer: history
module: global
status: frozen
updated: 2026-11-07
---

# 结果：M1 契约冻结（T1–T10，已收口）

## 1. 结论

- T1–T9 完成：`v0.4` 提案已落进 `docs/design/contracts/executor-http-v1.md` 与组件规格；`protocolVersion = 2026-11-07.1`。
- 调度器侧设计评审（2026-11-07）第二轮判 **通过**：首轮 4 条 Blocker、5 条 Decision now 已修复；复核新增 `NB-01`/`ND2-01`/`ND2-02` 已补齐，`ND2-03`–`ND2-06` 已记录/部分落稿。
- T10 完成：设计评审第二轮判「通过」，`NB-01`/`ND2-01`/`ND2-02` 已补，本工序归档。
- 转出项：`AH-02`（OQ-014）、`AH-07`/`AH-08`（S0 排期）、`OQ-021`（S1 实测）、`OQ-025`（调度器侧 follow-up）。

## 2. 落盘产出

| 产出 | 位置 |
|---|---|
| 契约主文档 | `docs/design/contracts/executor-http-v1.md` |
| 架构 | `docs/design/architecture.md` |
| 组件规格 | `CMP-executor` / `CMP-gateway` / `CMP-cli` / `CMP-result` / `CMP-assets` |
| 冻结清单 | `freeze-checklist.md`（F-00…F-24 + 评审 AB/AD/AH） |
| 评审处置 | `review.md` |
| 计划收口 | `plan/open-questions.md`、`plan/roadmap.md`、`plan/risks.md` |

## 3. 设计评审处置摘要

第二轮新增：`NB-01` 采用「assignments 留在 CLI」方案；`ND2-01`/`ND2-02` 补齐；`ND2-03`–`ND2-06` 记录/落稿。


- `AB-01`：`SchedulerPort.heartbeat(state, acks)`；`ackSeq`/`clientLease` 留 gateway；新增 `snapshotAttempts()`。
- `AB-02`：`JournalPort` 以 executor §3.4 唯一定义；store 补 `pendingAll`/`listInstances`。
- `AB-03`：统一 `asset_skill_set_conflict`。
- `AB-04`：实例终结与 `cleanupPending` 对账收进 `executor.reconcileCleanup`，CLI 只搬运/回执。
- `AD-01`–`AD-05`：错误映射拆分、截断预留标记、`<stateRoot>` 分区、取锁点、`DSH_HOME` 归属全部落稿。

## 4. 未决

| 项 | 状态 |
|---|---|
| T10 复核签字 | **已完成**：2026-11-07 第二轮判「通过」 |
| `AH-02` `stateRoot` 默认 | 随 OQ-014，不阻塞契约 |
| `AH-07` 组件预算 | S0 排任务按组件切 |
| `AH-08` UC→测试映射 | 转 S0 开工前补（`OQ-024`） |
| `OQ-021` 结果保留窗口 | S1 实测后定，不阻塞契约 |
| `OQ-025` `CleanupAck.failed` 终止规则 | 调度器侧 follow-up |

## 5. 校验

- `bun run check` 通过（typecheck / tests / docs:check / quality gate）。
- `docs/design/` 未改字段语义；本轮只做设计自洽修复与落盘。

## 6. 下一步

1. 归档本工序（`docs/history/works/2026-11-07-m1-contract-freeze/`）。
2. 启动 S0 本地执行闭环：按 `SCN-0002` / `SCN-0001` 的 S0 用例拆任务，开工前补 `AH-08` UC→测试映射。
3. S1 契约测试与桩调度器按 `design/contracts/executor-http-v1.md` 附录 A 准备，可与 S0 并行。
4. 观测 HTTP P1 独立推进，不并入 M1。
