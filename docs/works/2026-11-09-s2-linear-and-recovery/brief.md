---
layer: works
module: global
status: active
updated: 2026-11-09
---

# 工序 Brief：S2 线性多节点与恢复

> 输入：`docs/plan/roadmap.md` 批次 4 的 S2 部分；`SCN-0001` UC-02/03/04/15（重派后执行）/18/24/25；`REQ-0002` R-01/R-05/R-06；冻结契约 `executor-http-v1.md`（v1，`2026-11-07.1`）。

## 1. 目标与非目标

**目标**：在 v1 A 方案（实例数 + 同实例串行）内完成 S2 的 client 侧部分：

- 两节点顺序执行（`TC-EXEC-002`）：同一 client、`serve` + 桩调度器下依次领取并执行两个 attempt，产物叠加、进程/技能不串；
- 技能切换 A→B→A：替换不叠加、digest 幂等（UC-04）；
- 同容器不同技能集且存在活跃 attempt → `asset_skill_set_conflict`，不交错覆盖（UC-25 的 A 方案形态）；
- 重派后执行：崩溃/放弃后由调度器重新下发新 `attemptId`，client 正常执行；同 `attemptId` 不重复执行（UC-15 S2 部分、UC-18）；
- 实例级取消覆盖同一实例的多个活跃 attempt（fan-out 在 A 方案下串行，取消语义按实例整体）。

**非目标**：

- 不切 Q1 的 B 方案：`SCH-19` 与 `protocolVersion` 不变（切 B 需用户确认并改契约）；
- 不做 fan-out 真并发（A 方案下不可达，UC-03/24 保持 planned）；
- 不做多实例 home 派生（OQ-009）、不做真实调度器联调（调度器侧不可用）；
- 不动观测 HTTP（独立 P1）。

## 2. 决定

| 项 | 决定 | 理由 |
|---|---|---|
| Q1 容量方案 | **S2 保持 A**（实例数 + 同实例串行），不升 `protocolVersion` | 契约冻结；切 B 会改 `SCH-19`，需用户确认，且 S2 出口不依赖真并发 |
| `asset_skill_set_conflict` | 由 executor 维护「容器 → 活跃 attempt/digest」表；同容器有其它活跃 attempt 且 digest 不同即冲突，不 prompt | 落实 `CMP-executor` §2.6；A 方案下不可达但守卫必须在位，B 方案才依赖它 |
| `reconcileCleanup` 幂等 | 按 `releaseId` 缓存回执，重复调用返回同一 ack | `CMP-executor` §2.1「幂等，按 releaseId 去重」 |
| 重试 | client 不自动重跑；重派（新 attemptId）正常执行 | `REQ-0002` R-04、契约 `SCH-02` |

## 3. 任务表

| ID | 类型 | 组件 | 任务 | 状态 | 装载清单 |
|---|---|---|---|---|---|
| `T1` | feature | `CMP-executor` | `SkillDigestGuard` 冲突判定 + `reconcileCleanup` 按 `releaseId` 幂等 | 进行中 | `CMP-executor` §2.1/§2.6 |
| `T2` | test | `CMP-cli`、`CMP-executor` | 顺序两节点端到端（`TC-EXEC-002`）+ 技能切换 A→B→A（UC-04） | 待开始 | `SCN-0001` UC-02/04 |
| `T3` | test | `CMP-executor`、`CMP-store` | 重派后执行、同 attempt 不重复执行（UC-15/18） | 待开始 | `SCN-0001` UC-15/18、`REQ-0002` R-01 |
| `T4` | test | `CMP-executor` | 同容器不同 digest 冲突；实例级取消覆盖多 attempt | 待开始 | UC-25、`SCH-19` |
| `T5` | gate | 全部 | S2 门禁与文档收口 | 待开始 | 本 brief §4 |

## 4. 验收

| 门禁 | 判据 |
|---|---|
| 顺序两节点 | 两个 attempt 依次执行；第二节点只看到自己的技能；第一节点产物保留 |
| 技能切换 | A→B→A 三节点，每次只看到当前集；digest 幂等不重复替换 |
| 冲突守卫 | 同容器存在活跃 attempt 且 digest 不同 → `asset_skill_set_conflict`，无 prompt、无半套 |
| 重派 | 同 attemptId 只执行一次；新 attemptId 正常执行 |
| 取消 | 实例级取消覆盖该实例全部活跃 attempt；取消后无残留 |
| 清理幂等 | 同 `releaseId` 重复对账返回同一 ack，不重复清理 |

## 5. 收口

- 每任务 `bun test` + `bun run typecheck` + `bun run check`；一任务一 commit。
- 收口：`result.md`（Q1 评估结论、门禁证据、遗留）、roadmap/OQ/test-matrix 更新、工序归档。
