---
layer: works
module: global
status: active
updated: 2026-11-14
---

# 结果：工作区根支持 git 超项目

## 1 验收结果

| 验收标准 | 结果 | 证据 |
|---|---|---|
| superproject 根：`ensureContainer` 通过，doctor 显示 `layout=superproject` | 通过 | `workspace.test.ts`「根是 superproject…通过且无告警」；`admin.test.ts`「容器通过并标 layout」；`commands.test.ts`「doctor --workspace 识别超项目形态」 |
| 子模块未初始化：任务不 block，doctor warn 并列出目录名 | 通过 | `workspace.test.ts` 目录为空/缺 `.git` 两例；`admin.test.ts` 的 `workspace.submodules` warn；CLI 集成测试输出「子模块未初始化：uumail（目录为空）」 |
| 原容器目录形态行为不变 | 通过 | 全量 144 个测试全绿；`layout=container` 用例保留 |
| 根位于其他仓库内仍拒绝，`layout_invalid` 不变 | 通过 | `workspace.test.ts`「容器根位于外层仓库下仍判 layout_invalid，文案不变」 |
| 无契约变更 | 通过 | 未改 `TaskRequest.workspacePath` / `taskSpacePath` / HTTP 契约 / 数据库；仅内部 `LayoutReport` 增加 `layout`、`warnings` |

## 2 验证命令

`bun run check`：

- `bun run typecheck`：通过
- `bun test`：144 pass / 0 fail / 475 expect，23 个文件
- `bun run docs:check`：场景索引已是最新
- `bun run quality:gate`：16 项规则全部 PASS，违规 0

## 3 结论落点

| 内容 | 落点 |
|---|---|
| 容器形态与子模块告警 | [`workspace.ts`](../../../src/components/workspace/workspace.ts)、[`superproject.ts`](../../../src/components/workspace/superproject.ts)、[`fs-path.ts`](../../../src/components/workspace/fs-path.ts) |
| `LayoutReport` 字段 | [`domain-types.ts`](../../../src/components/executor/domain-types.ts) |
| doctor 检查项 | [`admin.ts`](../../../src/components/workspace/admin.ts) |
| doctor 接入 | [`doctor-checks.ts`](../../../src/components/cli/doctor-checks.ts) |
| 规格与架构 | [`CMP-workspace/spec.md`](../../design/components/CMP-workspace/spec.md)、[`CMP-cli/spec.md`](../../design/components/CMP-cli/spec.md)、[`architecture.md`](../../design/architecture.md) |

## 4 未决问题

- `docs/design/contracts/executor-http-v3.md` §4.1 不变式 3 仍写 `workspacePath`「位于任何 git 仓库之外」。本次遵守「无契约变更」未改该文件；该表述与超项目根已不一致，需调度器侧契约 owner 在下一次契约维护时同步。
- `.gitignore` 缺项提示（风险表的可选项）未做，已记入 `CMP-workspace` 规格的开放问题。
- 本次未提交 commit；P2 合并前需人最终确认。
