---
layer: works
module: global
status: active
updated: 2026-11-14
---

# 工序：工作区根支持 git 超项目

> 来源：2026-11-14 联调要求。工作区要支持「整体可回放」：根仓库提交 submodule 指针，固定 uumail、i2xclient 等项目的版本组合。
> 定级：**P2**（跨 `CMP-workspace` 与 `CMP-cli` doctor 装配；`LayoutReport` 内部端口类型新增字段；无 HTTP 契约/schema/数据库变更）。设计由 agent 完成，2026-11-14 用户确认 doctor 采用 A 方案（改用 `WorkspaceAdmin.diagnose`）后实施。

## 1 问题

`FileWorkspace.validate` 当前拒绝根有 `.git`。超级项目根的 `.git` 是目录，`pathKind` 返回 `dir`，直接产生 `layout_invalid`，任务不执行。

## 2 目标

1. 根是 git 超项目（`.git` 目录/文件 + `.gitmodules` + 已初始化子模块）时 `validate.ok=true`，`ensureContainer` 通过。
2. 子模块目录不存在/为空/缺 `.git` 只产生 `warnings`，不阻断任务；doctor 以 `workspace.submodules` warn 展示。
3. 保留「根位于别人仓库内」的拒绝（`layout_invalid`，文案不变）与 `.dsh` 真实目录校验。
4. 原容器目录形态行为不变。
5. client 不执行任何 git 命令；无 HTTP 契约与数据库变更。

## 3 非目标

- 不实现 clone / `git submodule update --init` / commit。
- 不改 `TaskRequest.workspacePath`、`taskSpacePath` 语义与服务端校验。
- 不做 `.gitignore` 缺项提示（记为开放问题）。

## 4 影响场景

- UC-05 容器非法（扩展：superproject 合法、子模块未初始化只 warn）。
- UC-08 工作区不可写（不变）。
- UC-28 不可信路径（不变）。
- `doctor --workspace` 容器布局检查。

## 5 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| T-01 | 契约 | CMP-executor / CMP-workspace | `LayoutReport` 新增 `layout`、`warnings`（内部端口，兼容扩展） | 完成 |
| T-02 | 实现 | CMP-workspace | `validate` 允许超项目、解析 `.gitmodules` 生成 warnings | 完成 |
| T-03 | 实现 | CMP-workspace | `admin.diagnose` 输出 `layout=` 与 `workspace.submodules` warn | 完成 |
| T-04 | 集成 | CMP-cli | doctor 改用 `WorkspaceAdmin.diagnose` | 完成 |
| T-05 | 测试 | CMP-workspace / CMP-cli | 超项目、子模块、`.dsh` 符号链接、外层仓库、doctor 集成 | 完成 |
| T-06 | 文档 | CMP-workspace / CMP-cli / 架构 | 容器布局、警告语义、doctor 检查说明 | 完成 |

## 6 验收标准

1. `workspacePath` 是 superproject 根：任务正常下发、`ensureContainer` 通过、doctor 显示 `layout=superproject`。
2. 子模块未初始化：任务仍可执行（不 block），doctor 给出 warn 与该目录名。
3. 原有容器目录形态：行为不变，全部现有测试通过。
4. 根位于其他仓库内：仍然拒绝，错误码 `layout_invalid` 不变。
5. 无契约变更：`TaskRequest.workspacePath` 与 `taskSpacePath` 语义不变；服务端仍只做「绝对路径 + 位于 workspace 之下」校验。

## 7 回滚

只回滚 `workspace.ts` 的 validate 分支、`admin.ts` 的 doctor 文案/检查项、`doctor-checks.ts` 的接入与 `LayoutReport` 字段；无数据迁移。
