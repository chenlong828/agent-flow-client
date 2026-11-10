---
layer: works
module: global
status: frozen
updated: 2026-11-10
---

> **状态：已被取代（2026-11-10）**。调度器侧随后发布 executor contract v2（三端点、at-least-once），本提议的 v1 前提与“契约主体不变”结论不再适用；现行契约见 `docs/design/contracts/executor-http-v2.md`，迁移见 `docs/history/works/2026-11-10-contract-v2-migration/`。

# 工序 Brief：执行容错语义与卡死处理提议

> 目的：把「Agent 分析任务允许顺序重试、但同容器必须单写者」这一执行语义整理成跨团队提议，提交调度层评审。评审通过后再决定是否改契约、拆实现。

## 1. 背景

- client 执行的是 Agent 智能体分析任务：中断后工作区会留下中间分析结果/知识；同一节点重新执行时，agent 能读到上次痕迹并自行决策继续或重跑。
- 因此执行语义不必追求 exactly-once；真正要守的是「同一容器同一时刻只有一个活跃写入者」，以及「卡死不能无限占容量」。
- 当前 v1 契约冻结 A 方案（同实例单活跃 attempt）；S1/S2 已实现租约、重派、恢复与顺序多节点。前期讨论发现：按“强一致任务”的优先级排序会过度设计，也会误判卡死的严重性。

## 2. 目标与非目标

**目标**：

- 明确执行语义：at-most-one active writer per container + 允许顺序重试 + 工作区保留，不承诺 exactly-once。
- 明确卡死/超时的处理链路：总超时、空闲看门狗、scheduler cancel、进程组回收、部分输出回报。
- 列出 client 侧待补项与调度层需要决策的问题（重试、超时归属、可选字段、清理策略）。
- 形成可直接评审的提议稿。

**非目标**：

- 本工序不实现代码、不改冻结契约、不切 Q1 的 B 方案。
- 不重新设计工作流/编排；不改变“client 不执行编排”的边界。
- 不承诺 DSH 内部死锁可被检测（只承诺有界终止与重试）。

## 3. 任务表

| ID | 任务 | 状态 | 交付 |
|---|---|---|---|
| `T1` | 起草提议 | 完成 | `proposal.md` |
| `T2` | 提交调度层评审 | 待开始 | 调度层对 §9 问题给出结论 |
| `T3` | 处置评审意见 | 待开始 | `review.md` + 决策（改契约/另立实现工序/维持现状） |

## 4. 评审对象与验收

- 评审方：调度器团队（契约权威侧）。
- 需要回答：`proposal.md` §9 的 Q1–Q8。
- 验收：每个问题有明确结论（接受/拒绝/修改），并说明是否新增契约字段、是否调整重试策略。
- 评审通过后：按结论更新 `docs/design/contracts/executor-http-v1.md`（若需要）并另立实现工序；本工序归档。

## 5. 装载清单

- `docs/design/contracts/executor-http-v1.md` §2.3、§5.2、§5.3、§5.6、§5.7、§11、附录 B（Q1/Q2/Q8/Q9/Q10/Q12/Q14/Q15）
- `SCH-02`、`SCH-07`、`SCH-11`、`SCH-16`、`SCH-19`
- `REQ-0002` R-02/R-04/R-05
- `docs/history/works/2026-11-08-s1-contract-skeleton/result.md`
- `docs/history/works/2026-11-09-s2-linear-and-recovery/result.md`
- 当前实现：`src/components/cli/serve*.ts`、`src/components/executor/executor.ts`、`src/components/runtime/runtime.ts`、`src/components/gateway/gateway.ts`

## 6. 风险

| 风险 | 处理 |
|---|---|
| 双方对“重试是否安全”理解不一致 | 提议明确不承诺 exactly-once，并给出同容器单写者不变式 |
| 调度层担心放宽后重复执行放大成本 | 由调度器掌握重试次数/退避；client 只回报 timeout 与部分输出 |
| 新增可选字段被视为契约漂移 | 只做加法、默认关闭；拒绝也不影响本提议主体 |
