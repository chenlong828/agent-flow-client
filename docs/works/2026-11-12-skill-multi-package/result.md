---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 结果：多技能包安装布局（OQ-33）

> 输入：[`brief.md`](brief.md)、[`review.md`](review.md)、编排侧 `OQ-33`。
> 结论：**已修复**。多个技能包各落 `<skills>/<name>/`，互不覆盖；同名技能显式失败；包内 `scripts/`、`references/` 随技能目录落地（附件包不再必然失败）；旧平铺容器靠布局标记重装一次。

## 1 完成项

| 任务 | 状态 | 落点 |
|---|---|---|
| `T-ASSET-01` 逐包归位 | 完成 | `src/components/assets/assets.ts`：每包解到 `.staging/<digest>/.packages/<n>-<slug>/`，再 `mergePackageRoot` 按 frontmatter name 改名；`src/components/assets/skill-layout.ts`（新）做归并与冲突检测；`format.ts` 暴露 `readSkillName` |
| `T-ASSET-02` 布局标记 | 完成 | `assets.ts`：短路条件加 `#layoutCurrent`；`#swap` 在技能树就位后写 `.skills-layout=dir-v1`；`CMP-workspace` 的 `clean-skills` 同步清理该文件 |
| `T-ASSET-03` 测试 | 完成 | `tests/components/assets/package.test.ts`（多包、附件、冲突）、`assets.test.ts`（旧布局迁移、既有语义回归） |
| `T-ASSET-04` 文档 | 完成 | `CMP-assets` 规格 §2.1/§2.4/§3/§5/§7/§8、`CMP-workspace` §2 清理表、`architecture.md` §3/§8、`test-matrix` UC-04a、`SCN-0001` UC-04a |
| `T-ASSET-05` 验收 | 完成 | `bun run check`（132 测试、typecheck、docs:check、质量门 0 违规）；真实包布局验证见 §2 |

## 2 验收结果

| ID | 断言 | 证据 |
|---|---|---|
| `TC-ASSET-001` | 两包各落独立目录、内容都在、`installed.skills` 为真实技能名 | `package.test.ts`「两个包各自落到 `<name>/` 目录，互不覆盖」；真实两张包验证：`["basic-test","workflow-init"]` |
| `TC-ASSET-002` | 附件在技能目录内、脚本可执行 | `package.test.ts`「包内 scripts/references 落在技能目录内」 |
| `TC-ASSET-003` | 同名技能 `invalid_skill_format`，旧集与 digest 不变 | `package.test.ts`「两个包同名技能判 invalid_skill_format，旧技能集不被破坏」 |
| `TC-ASSET-004` | 旧平铺布局同 digest 也重装 | `assets.test.ts`「旧布局（平铺 SKILL.md）在缺少布局标记时重装为目录布局」 |

真实包验证（只读下载调度器上已有的两张包，不改服务端状态）：

```
skills = ["basic-test", "workflow-init"]
layout = dir-v1
tree   = ["basic-test", "workflow-init"]
  basic-test/SKILL.md    frontmatter name = "basic-test"
  workflow-init/SKILL.md frontmatter name = "workflow-init"
```

## 3 结论落点

| 内容 | 落点 |
|---|---|
| 安装布局、冲突语义、布局标记 | `docs/design/components/CMP-assets/spec.md` §2.1/§3/§5 |
| `clean-skills` 清理面 | `docs/design/components/CMP-workspace/spec.md` §2 |
| 系统层描述 | `docs/design/architecture.md` §3、§8 |
| 场景与测试映射 | `docs/design/scenarios/.../execute-node-and-report/scenario.md` UC-04a、`docs/design/test-matrix.md` |
| 代码入口 | `src/components/assets/skill-layout.ts#mergePackageRoot`、`assets.ts#LocalAssets`、`format.ts#readSkillName` |

## 4 未决与后续

| 项 | 说明 |
|---|---|
| 编排侧 `OQ-33` 状态 | 由调度器侧工序关闭；client 侧结论在本文件与 `review.md` |
| 真实 DSH catalog 断言 | 未跑模型会话；下次真实 run 时确认 catalog 同时列出两个技能 |
| 部署注意 | 每个既有容器会在下一任务重装一次技能（布局迁移），属预期 |
