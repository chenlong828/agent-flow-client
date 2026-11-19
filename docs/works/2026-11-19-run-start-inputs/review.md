---
layer: works
module: global
status: active
updated: 2026-11-19
procedure: 2026-11-19-run-start-inputs
level: P2
---

# 评审与裁决：run 初始资料（图片）

> 输入：上游提案 [`client-proposal.md`](../../../../agent-flow-orchaster/docs/works/2026-11-19-run-start-images/client-proposal.md)、本仓库代码现状、`probe/read-image-evidence.json`。
> 结论：**通过**（P2，合并前需人最终确认）。

## 1 Blocker

无。

## 2 Decision now

| # | 决策 | 选项与代价 | 落地 |
|---|---|---|---|
| `D-01` | 初始资料写入用 **`WorkspacePort.inputs` 子能力**，不在 `WorkspacePort` 上平铺三个方法 | 平铺更贴提案原文，但 `FileWorkspace` 方法数会超过仓库质量门禁（Q-09 ≤10、Q-08 ≤20）；子能力把「初始资料写入」收成一个明确的二级契约 | `ports.ts#WorkspaceInputsPort`、`workspace/inputs.ts#TaskSpaceInputs`；pinning：`tests/components/workspace/task-space.test.ts` |
| `D-02` | `EXE-06` 的 **404 分两种**：信封 `run_not_found` → 让任务失败；其它 404 → 视为旧服务端，返回空列表并记 `run_inputs.unavailable` | 全部当空列表会静默吞掉「run 不存在」；全部当失败会破坏旧服务端兼容 | `gateway.ts#listRunInputs`；pinning：`gateway.test.ts` 两条 404 用例 |
| `D-03` | 初始资料名禁止以 `.` 开头；临时文件用 `.name.<uuid>.part`；`ensureDir` 清理残留 `.part` | 否则崩溃残留会进归档；以点开头也避开隐藏文件与临时文件冲突（服务端扩展名恒为图片类型，不会与 `.part` 撞名） | `workspace/inputs.ts`；pinning：`writeInput…无残留临时文件`、`ensureInputsDir…清理 .part` |
| `D-04` | `AF_MODEL` 只覆盖模型 id，`input` 继承 `S0_MODEL.input` | 提案已明确；纯文本路由需部署时同步改 `input`（RC-03）。不为此新增 `AF_MODEL_INPUT` 配置键，避免扩大配置面 | `cli/compose.ts`、`cli/serve-compose.ts` 的 `...S0_MODEL`；pinning：`profile.test.ts` |

## 3 Verified sound

| 检查 | 方式 | 结果 |
|---|---|---|
| 模型条目补 `input` 后 ACP 声明图片能力 | 真实 `dsh --profile acp --patch <产物>` + `initialize` | `promptCapabilities.image=true`（探针前为 false） |
| `read_image` 在 acp 会话工具目录且模型能读图 | 同一探针内 `session/prompt`，图片 `AF IMG 7319` + 蓝矩形 | 调用 `read_image`，模型读出文本与形状（`probe/read-image-evidence.json`） |
| 解析白名单拒绝非法响应 | `run-input-wire.ts` + `wire.test.ts` 表驱动 | 类型/摘要/大小/跨 run 路径均 `protocol_error` |
| 下载路径不越界 | 下载前 `assertInputDownloadPath`（形状 + `inputId` 一致） | 不匹配时不发请求 |
| 原子写入与只读 | 真实文件系统测试 | 内容一致、`0400`、无 `.part`、覆盖可用 |
| 符号链接/路径穿越 | 目标符号链接、`inputs/` 目录符号链接、`..`/`/`/绝对路径 | 全部 `path_escape`，不跟随 |
| 幂等与失败语义 | executor 单测 8 条 | 同大小跳过；摘要不符/下载失败/路径非法 → `asset`；磁盘/权限仍 `workspace` |
| 端到端 | `v3-serve.test.ts` 桩调度器 + 真实 `serve` | `task-space/inputs/01-界面截图.png` 出现、只读；poll 带能力头 |
| 质量门禁 | `bun run check` | typecheck + 285 tests + docs:check + 16 项指标全 PASS |

## 4 Hold

| 项 | 原因 | 去向 |
|---|---|---|
| 真实 orchestrator 联调（上传→绑定→下发→拉取） | 编排侧 `EXE-06/07` 尚未实现，client 只能先用桩验证 | 上游工序 `2026-11-19-run-start-images`；本仓库 `result.md` |
| 单张 8 MiB / 合计 20 MiB / ≤8 张 | 服务端限制，client 不重复设限 | 契约 §4.6 与上游 proposal |
| Windows 覆盖只读文件的 `rename` 行为 | 已有「先 rm 再 rename」分支，但未在 Windows 真机跑过 | 平台矩阵遗留项 |
| task-space 归档含 `inputs/` 的断言 | 归档逻辑未改，tar 天然包含；仅在单测中确认打包条目 | 归档联调时补 |

## 5 确认记录

- 2026-11-19：用户选择「按提案开始实现（先做 `T-CLI-IMG-01` 读图验证）」，作为 P2 的开工确认。
- 合并前待用户对完整 diff 与验证结果做最终确认（P2 人工门）。
