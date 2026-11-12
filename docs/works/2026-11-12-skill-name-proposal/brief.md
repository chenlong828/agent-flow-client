---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 工序：技能「展示名 / 系统名」分离提案

> 承 `OQ-17` 修复后的实测（2026-11-12 20:35）：带技能包的 run 已经能下载、解包，但卡在 `invalid_skill_format`。本工序只产出**给调度层的提案**，不改调度器仓库代码。

## 1 背景

`skill.name` 一个字段同时承担两种职责：

- 给人看的展示名（本项目常态是中文，例如 `工作流初始化`）；
- 进系统、被 DSH 识别的技能标识符。

DSH 对技能名有硬约束：frontmatter 的 `name` 必须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`（`deepseek-harness/packages/skill/skill/src/index.ts:29`），不匹配的技能会被直接忽略、不进 catalog。客户端的安装校验与规则一致（`src/components/assets/format.ts:59`），因此在下载成功后报 `invalid_skill_format`，节点失败。

调度器侧的建包校验只要求 `name` 非空（`agent-flow-orchaster/src/components/skill/package.ts:92`），中文名可以一路走到执行面。

## 2 目标

1. 给调度层一份可执行的提案：用一个新增字段承载系统标识，让中文展示名与 kebab-case 标识并存。
2. 说清字段、校验、包格式、迁移、兼容与验证方式，便于调度层直接立项。
3. 明确客户端与 DSH 不需要改什么。

## 3 范围

| 做 | 不做 |
|---|---|
| 提案文档（字段/契约/迁移/测试） | 改 `agent-flow-orchaster` 代码 |
| 用本轮实测证据支撑结论 | 改客户端校验规则 |
| 给出命名与备选方案、待定项 | 改 DSH 的技能名规则 |

## 4 验收

- 提案落在文档里，能直接转成调度层的工序。
- 提案中的字段与校验能通过现有 DSH 规则推演，不引入客户端改动。
- 明确迁移对存量技能包的影响与处置方式。

## 5 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| `T-SNP-01` | analysis | `CMP-skill` | 复核实测证据与 DSH 校验规则 | 完成 |
| `T-SNP-02` | handoff | 调度层 | 提案：字段设计、契约影响、迁移、测试 | 完成 |

## 6 领取的开放问题

- `OQ-17`（304）已修复，不再跟踪；本工序承接其后续暴露的 `invalid_skill_format`。
