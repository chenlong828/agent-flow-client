---
layer: works
module: global
status: active
updated: 2026-11-14
---

# 评审：工作区根支持 git 超项目（P2）

裁决：**通过**。P2 合并前需人最终确认；无 blocker，Hold 1 项已转开放问题。

## Blocker

无（0）。

## Decision now

1. **doctor 的 workspace 检查接入方式**：实际 `doctor --workspace` 原先走 `CMP-cli` 内部复制的 `workspaceChecks`，`WorkspaceAdmin.diagnose` 未被调用。为保证验收「doctor 显示 `layout=superproject`」且避免两处逻辑漂移，改为由 `doctor-checks.ts` 调用 `WorkspaceAdmin.diagnose`。
   - 影响：doctor 的 workspace 检查从 1 条 `workspace.project_root` 变为 `workspace.container`、`workspace.project_root`、`workspace.writable`、`workspace.staging`，warnings 非空时追加 `workspace.submodules`；退出码前缀不变（`workspace.` → 5）。
   - 依据：`CMP-cli` 规格 §2.6「由各 L0 暴露的 diagnose() 提供，CLI 编排」。
   - pinning test：`tests/components/cli/commands.test.ts`「doctor --workspace 识别超项目形态并告警未初始化子模块」。

2. **`LayoutReport` 增加 `layout` 与 `warnings`**：内部端口类型的兼容扩展；`ok` 仍只由 `issues` 决定。`FileWorkspace` 与 `FakeWorkspace` 已同步。
   - 替代方案：admin 自行重新探测 `.git`/`.gitmodules`。否决理由：重复判断逻辑，两处易漂移。
   - pinning test：`tests/components/workspace/admin.test.ts` 的 `layout=superproject|container` 断言。

## Verified sound

- 原容器形态：根无 `.git` 时 `layout=container`，`ensureContainer`、路径约束、清理、task-space 行为不变；144 个测试全绿。
- 「根位于别人仓库内」仍拒绝：`findProjectRoot` 上浮检查保留，错误码与文案不变。
- `.dsh` 必须是真实目录：符号链接仍 `layout_invalid`。
- 子模块告警不阻断：目录不存在/为空/缺 `.git` 仅进 `warnings`；`ensureContainer` 仍创建 `.dsh`。
- 不执行 git 命令：仅读取 `.gitmodules` 文本，不调用 git。
- 无 HTTP 契约/schema/数据库变更。

## Hold

1. ~~`docs/design/contracts/executor-http-v3.md` §4.1 不变式 3 的「位于任何 git 仓库之外」旧表述未改（契约权威在调度器侧，本次要求无契约变更）。已记入 `result.md` 未决问题，转调度器侧契约维护。~~
   已解除（2026-11-15）：`W-01` 修订落地，权威契约与 client 同步副本同批更新；无 wire 变化，不升协议版本。
2. `.gitignore` 缺项提示未做（可选项），已记入 `CMP-workspace` 规格开放问题。

## 确认记录

2026-11-14 用户确认 doctor 采用 A 方案：`doctor --workspace` 改用 `WorkspaceAdmin.diagnose`。
