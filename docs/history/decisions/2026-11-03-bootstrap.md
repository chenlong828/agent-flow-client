---
layer: history
module: global
status: frozen
updated: 2026-11-03
---

# 2026-11-03 项目初始化

## 背景

调度器侧已完成边界与职责设计，client 作为独立执行面项目启动。初始化需要确定技术栈、技能来源、文档组织与最小骨架。

## 决策

1. `agent-flow-client` 独立成库，Bun + TypeScript，单进程 CLI；不放入调度器仓库。
2. 开发技能从 `../agent-flow-orchaster/.agents/skills/` 原样复制五个：`req-scenario-spec`、`design-before-coding`、`arch-design-spec`、`dev-execution-spec`、`doc-layout-spec`。
3. 文档采用五态分离；当前只创建有内容的 `plan/`、`design/`、`history/`，`requirements/`、`works/`、`components/`、`scenarios/` 在首份内容出现时创建。
4. 最小可运行骨架：CLI 提供 `help`/`version`；`serve`/`run`/`doctor` 只保留入口并明确“尚未实现”，不伪造功能。
5. Bun 随项目放在 `.local/bun/`，与调度器项目一致；`.local/` 不入库。

## 影响

- 后续 S0 可直接在本地假任务上验证 DSH 技能可见性与 session 生命周期，不依赖调度器。
- 技能升级按“覆盖同名目录 + 决策记录”执行；本次复制不修改正文。
- 契约字段与端点尚未冻结；S1 前需调度器侧接口设计。

## 未做

- 未接调度器、DSH/ACP、技能下载与工作区刷新；
- 未建 `requirements/`、`works/`、`components/`、`scenarios/`；
- 初始化提交待评审后按项目规则处理。
