---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 工序：多技能包安装布局（OQ-33）

> 来源：编排侧 [`OQ-33`](../../../../agent-flow-orchaster/docs/plan/open-questions.md)（2026-11-12 联调发现，客户端侧）。本工序在 client 仓库落地「每个技能一个目录」。
> 定级：**P2**（安装目录布局与失败语义变更，跨 `CMP-assets`/`CMP-workspace`；有旧容器迁移动作）。设计由 agent 完成，合并前需人最终确认。

## 1 问题

`install()` 把每个包都解到同一个 staging 根；编排侧 `P-03` 包根只有 `SKILL.md`（附件在 `scripts/**`、`references/**`）。实测三种表现：

| 场景 | 结果 |
|---|---|
| 单包仅 `SKILL.md` | 平铺 `<skills>/SKILL.md`；DSH 按 frontmatter 读技能名，能跑 |
| 单包带 `scripts/` 或 `references/` | **今天已失败**：`invalid_skill_format: 缺少 SKILL.md：…/references/SKILL.md`（顶层目录被当成技能目录） |
| 两包各仅 `SKILL.md` | 后者覆盖前者；`installed.skills=["SKILL"]`；摘要校验无异常 |

摘要发现不了的原因：单包摘要校验的是下载字节；装配后不重算整棵树，`.skills-digest` 直接写任务给的集合 digest；下一次同 digest 短路复用坏树。

## 2 目标

1. 每个包按包内 frontmatter `name` 落到 `<skills>/<name>/`，多包互不覆盖。
2. 包内 `scripts/**`、`references/**` 跟随技能目录，不再被当作顶层技能。
3. 重名技能显式失败（`invalid_skill_format`），不静默覆盖；失败保持旧技能集。
4. 旧容器（平铺布局）自动重装一次：新增 `.dsh/.skills-layout = dir-v1` 参与幂等短路。
5. 保留 S0 本地目录来源的多技能树行为（`<name>/SKILL.md`、`<name>.md`）。

## 3 影响规格

### 3.1 契约与布局

| 面 | 变更 | 兼容性 |
|---|---|---|
| `.dsh/skills` 布局 | 平铺 `SKILL.md` → `<name>/SKILL.md`（DSH 的目录形态；`resourceBase` 指向技能目录） | 旧容器靠布局标记重装一次；DSH 两种形态都认 |
| `.dsh/.skills-layout` | 新增标记文件（`dir-v1`），`clean-skills` 一并清理 | 缺标记视为旧布局 |
| `install` 错误 | 多包解析出同名技能 → `invalid_skill_format`（消息含技能名） | 已有的错误码，不新增；`result` 分类仍是 `asset` |
| 包来源 | `P-03` 包（根 `SKILL.md`）与 S0 本地多技能树都支持 | 不改 HTTP 契约、不改编排侧打包 |

### 3.2 组件关系

- 调用边：`CMP-assets` 内部新增 `mergePackageRoot`（`skill-layout.ts`），把「单包解包目录」并入「技能集暂存根」；`assets.ts#LocalAssets` 仍是对外唯一入口。
- 数据所有权：`.dsh/skills`、`.dsh/.skills-digest`、`.dsh/.skills-layout` 仍只有 `CMP-assets` 一个写入口。
- 不受影响：`CMP-executor`/`CMP-runtime`/`CMP-gateway`/`CMP-store`；HTTP 契约；调度器侧打包。

### 3.3 回滚

- 回滚代码即可：旧代码不认 `.skills-layout`，但会照常按 digest 短路或重装，布局仍可被 DSH 读取。
- 无数据迁移脚本；`.skills-layout` 是普通标记文件。

## 4 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| `T-ASSET-01` | change | `CMP-assets` | 逐包独立暂存 + 按 frontmatter name 归位 + 重名冲突 | 完成 |
| `T-ASSET-02` | change | `CMP-assets` | `.skills-layout` 标记与旧布局重装；`clean-skills` 同步 | 完成 |
| `T-ASSET-03` | test | `CMP-assets` | 多包、附件、重名冲突、旧布局迁移 4 组用例 | 完成 |
| `T-ASSET-04` | docs | — | CMP-assets/workspace 规格、architecture、test-matrix、SCN-0001 UC-04a | 完成 |
| `T-ASSET-05` | verify | — | `bun run check`；写 `result.md` | 完成 |

## 5 验收

| ID | 断言 |
|---|---|
| `TC-ASSET-001` | 两包各带 `SKILL.md`：落 `<a>/`、`<b>/`，两者内容都在；`installed.skills` 为真实技能名 |
| `TC-ASSET-002` | 包内 `scripts/`、`references/` 落在技能目录内，脚本可执行位保留 |
| `TC-ASSET-003` | 两包同名技能 → `invalid_skill_format`，旧技能集与 digest 不变 |
| `TC-ASSET-004` | 旧布局（平铺 `SKILL.md`、无布局标记）同 digest 也重装为目录布局 |

## 6 确认记录

| 时间 | 事项 | 结论 |
|---|---|---|
| 2026-11-12 | 修法 | 用户选择「客户端按技能名建子目录」 |
| 2026-11-12 | 重名策略 | 用户选择「报错失败」，不覆盖 |
| 2026-11-12 | P2 合并确认 | 待收口时用户复核 `review.md` |
