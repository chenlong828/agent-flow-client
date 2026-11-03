---
layer: history
module: global
status: frozen
updated: 2026-11-03
---

# 工序 brief：客户端概念设计（服务接口面与模块划分）

## 需求

在「DSH 在每次 `session/prompt` 时重新读取工作区技能」已实测成立（OQ-001 关闭）的前提下，冻结 agent-flow-client 的：

1. **对外服务接口面**：调度器 HTTP 契约面（client 作为消费方）与 CLI 操作面；
2. **内部模块划分**：组件、层次、依赖方向、数据所有权与端口契约；
3. **节点执行的主流程与不变量**：作为 S0 组件规格与 M1 字段级契约的输入。

本工序只到概念级：方法、不变量、错误类别；请求/响应字段、本地目录布局、库表与实现细节留给 M1 与组件规格。

## 背景

- 上游依据：`../../../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`（边界与职责）与 `client-work.md`（client 侧工作清单）。
- 已完成 DSH ACP 预研（已归档）：启动方式、协议序列、权限/取消/关闭行为，见 `../2026-11-03-dsh-acp-preflight/result.md`。
- 现状：`design/architecture.md` 只有 8 个组件方向，且**缺「节点执行流程」的 owner**；没有任何组件规格；CLI 只有空壳。
- 工作区布局（2026-11-03 用户输入）：工作区是**容器根**，下面是 0..N 个自带 `.git` 的项目子目录；`.dsh/skills` 在容器根，用于切换技能（专家由调度器装配，persona 进 prompt）；技能与工具不进子仓库。容器与仓库由准备阶段预置，client 不 clone；fan-out 分支共享同一容器与技能集。
- 本次关键变化：技能读取时机验证通过，「建 session → 上报 id → 取技能集 → 刷新 → prompt」不再是待验证假设，可以冻结为唯一顺序，不必为备选路径预留分叉。

## 验收标准

| ID | 标准 | 判据 |
|---|---|---|
| A1 | 两个对外接口面写清 | 调度器契约面 5 个交互面的方法、不变量、错误类别；CLI 命令、配置、退出码、信号语义 |
| A2 | 9 组件划分可落地 | 每组件一句话职责、负责/不负责、数据、依赖、验证入口；依赖矩阵无环、无同层横调、扇出在预算内 |
| A3 | 主流程与不变量冻结 | 一条节点执行时序 + 不变量清单 + 失败映射表 |
| A4 | 决策可追溯 | 关键决策含被否决方案与理由；被推翻的上游结论（如「不提供本地 HTTP 服务」）显式登记 |
| A5 | 可迁移 | 评审通过后，结论能原样迁入 `design/architecture.md` 与各 `design/components/<id>/spec.md` |

P1 门：本稿确认前不写实现代码；确认后 S0 才动工。

## 任务表

| ID | 类型 | 组件 | 状态 | 装载清单 |
|---|---|---|---|---|
| T-01 | design | global | done | boundary-design、client-work、ACP 预研 result、design/architecture、roadmap、open-questions、risks |
| T-02 | review | global | done | 2026-11-03 P1 第二轮确认通过；设计冻结 |
| T-03 | doc | global | done | 结论迁入 `design/architecture.md`；决策落 `history/decisions/2026-11-03-client-concept.md` |
| T-04 | doc | CMP-cli / executor / result / gateway / runtime / workspace / assets / store / observability | 转出 | 每组件 `design/components/<id>/spec.md`，由 S0 工序补 |
| T-05 | doc | global | 转出 | S0 工序 brief，由 S0 工序立项时写 |

## 领取的开放问题

| OQ | 状态 | 本工序结论 |
|---|---|---|
| OQ-001 技能读取时机 | 已关闭 | 实测 prompt 时读取；主流程冻结为「先建 session 后刷技能」 |
| OQ-002 技能目录约定 | 已关闭 | 项目根 = 最近 `.git` 祖先；`<root>/.dsh/skills` 与 `<root>/.agents/skills` 自动发现；全局根用实例 profile 置空（design §4.5） |
| OQ-006 结果大小上限 | 承接 | 契约层给截断策略，具体数值留 M1 |
| OQ-009 DSH_HOME 粒度 | 承接 | 设计倾向「一实例一 home」，S0 定稿（影响 `CMP-runtime` 数据边界） |
