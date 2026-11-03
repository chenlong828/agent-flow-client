---
layer: history
module: global
status: frozen
updated: 2026-11-03
---

# 工序结果：客户端概念设计（服务接口面与模块划分）

## 验收结果

| ID | 标准 | 结论 | 证据 |
|---|---|---|---|
| A1 | 两个对外接口面写清 | 通过 | `design.md` §2：调度器 5 个交互面（注册心跳、领取租约、会话绑定、结果上报、取消控制）+ CLI 命令/配置/退出码/信号 |
| A2 | 9 组件划分可落地 | 通过 | `design.md` §3：9 张模块卡、依赖矩阵、禁止边、扇出预算；用户确认保留 `CMP-result` 独立 |
| A3 | 主流程与不变量冻结 | 通过 | `design.md` §4：一条节点时序、13 条不变量、失败映射、冷热路径、控制事件流转 |
| A4 | 决策可追溯 | 通过 | `design.md` §7 D1–D12 含被否决方案；`history/decisions/2026-11-03-client-concept.md` |
| A5 | 可迁移 | 通过 | 结论已迁入 `design/architecture.md`；组件规格与 S0 工序承接剩余条目 |

## 任务完成情况

| ID | 状态 | 说明 |
|---|---|---|
| T-01 | done | 读取上游边界、client-work、ACP 预研、S0 验证与现有文档 |
| T-02 | done | 2026-11-03 P1 第二轮人工确认通过，设计冻结 |
| T-03 | done | 迁入 `design/architecture.md`；决策落 `history/decisions/2026-11-03-client-concept.md` |
| T-04 | 转出 | 每组件 `design/components/<id>/spec.md`，由 S0 工序补 |
| T-05 | 转出 | S0 工序 brief，由 S0 立项时写 |

## 结论落点

| 结论 | 落点 |
|---|---|
| 接口面、主流程、13 条不变量、数据所有权 | `docs/design/architecture.md` |
| 决策 D1–D12 与关键约束 | `docs/history/decisions/2026-11-03-client-concept.md` |
| 冻结的概念设计细节（含源码依据、取舍过程、S0 用例） | `docs/history/works/2026-11-03-client-concept-design/design.md` |
| M1 待定项 | `docs/design/architecture.md` §12 与 `docs/plan/open-questions.md` |
| 组件规格、S0 工序 | 转出，待 S0 立项 |

## 遗留与风险

- M1 待定：`NodeRequest` / `NodeResult` / `SkillSet` 字段、技能集下发形态、容量单位、鉴权、版本窗口、结果大小上限、租约 TTL（> 30s）。
- OQ-009：`DSH_HOME` 一实例一 home 方向已定，S0 落地回收策略（lock 残留、残留 session、孤儿进程）。
- S0-11：崩溃遗留工具子进程未通过，取消/关闭/崩溃重启统一按进程组回收；需在 S0 落地并复验。
- 组件规格（T-04）在 S0 实现前补齐，避免规格晚于代码。

## 验证

- 文档评审：2026-11-03 用户确认（P1 第二轮）。
- 无代码改动，未运行 `bun test` / typecheck；冻结稿中的 S0 用例随 S0 工序执行。

## 归档

- 本目录整体移入 `docs/history/works/2026-11-03-client-concept-design/`，三份文档 frontmatter 改为 `layer: history` / `status: frozen`。
- 归档后本文只作记忆；现行设计依据是 `docs/design/architecture.md`。
