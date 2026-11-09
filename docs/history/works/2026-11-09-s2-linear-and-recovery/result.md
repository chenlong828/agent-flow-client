---
layer: works
module: global
status: frozen
updated: 2026-11-09
---

# 工序结果：S2 线性多节点与恢复

## 1. 结论摘要

- 在 v1 **A 方案**（实例数 + 同实例串行）内完成 S2 的 client 侧：两节点顺序执行、A→B→A 技能切换、同 attempt 幂等、同容器技能集冲突守卫、清理按 `releaseId` 幂等。
- `serve` + 桩调度器端到端跑通两节点：同一 DSH 进程复用、第二节点只看到自己的技能集、第一节点产物保留。
- Q1 评估结论：**S2 保持 A**，不修改 `SCH-19`、不升 `protocolVersion`；fan-out 真并发（UC-03/24）在 A 下不可达，留 B 方案决策。
- 空技能集安装缺陷已修复（无包时也创建 staging 并清空 `.dsh/skills`）。

## 2. 任务表

| ID | 任务 | 组件 | 状态 | 提交 |
|---|---|---|---|---|
| `T1` | 技能集守卫 + 清理幂等 | `CMP-executor` | 完成 | `068be2b` |
| `T2` | 顺序两节点 + 技能切换 | `CMP-executor`、`CMP-cli` | 完成 | `5752275` |
| `T3` | 重派/同 attempt 幂等 | `CMP-executor` | 完成 | `5752275` |
| `T4` | 冲突守卫与取消语义 | `CMP-executor` | 完成 | `5752275` |
| `T5` | S2 门禁与收口 | 全部 | 完成 | 本次 |

## 3. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| 顺序两节点（`TC-EXEC-002`） | 通过 | `tests/components/executor/sequential-nodes.test.ts`、`tests/scenarios/s2-linear.test.ts` |
| 第二节点只看到自己的技能 | 通过 | 两节点后 `.dsh/skills` 只剩 `beta`；`alpha` 已移除 |
| 产物叠加/保留 | 通过 | `repo-a/artifact.txt` 在两节点后仍在 |
| 进程复用 | 通过 | 桩 ACP 进程日志两节点仅 1 行 |
| 技能切换 A→B→A（UC-04） | 通过 | `sequential-nodes.test.ts` 三节点每次只看到当前集 |
| 同 attempt 不重复执行（UC-18） | 通过 | 完成后重复调用返回缓存，`prompt` 仅 1 次 |
| 同容器不同 digest 冲突（UC-25 A 形态） | 通过 | `asset_skill_set_conflict`，不 prompt |
| 清理幂等（`releaseId`） | 通过 | 重复 `reconcileCleanup` 返回同一 ack，shutdown 仅 1 次 |
| 取消 | 通过 | S1 已覆盖；A 下同实例单活跃 attempt，实例级取消等价 |

## 4. Q1 评估

| 选项 | 结论 | 理由 |
|---|---|---|
| A（现状） | **保持** | 契约冻结；两节点顺序、实例级取消与恢复已满足 S2 出口；无需升 `protocolVersion` |
| B（同容器并发/fan-out 真并发） | 暂不切 | 需改 `SCH-19`、升协议版本并重做容量与技能冲突语义；属独立 P1 决策 |

## 5. 偏差与遗留

- fan-out 真并发（UC-03/24）未实现：A 方案下不可达，待 B 决策。
- 真实调度器联调仍未做（调度器侧不可用）。
- `OQ-021`（结果保留窗口）、`OQ-026`（模型路由）仍开放。
- 多实例 home 派生（OQ-009）留 B/S3。

## 6. 裁决摘要

P2 实现工序（无契约变更）。blocker 0 / decision 1（Q1 保持 A，已落文档）/ hold 2（fan-out 真并发、真实调度器联调）。
