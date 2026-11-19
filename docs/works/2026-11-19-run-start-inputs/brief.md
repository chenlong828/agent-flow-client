---
layer: works
module: global
status: active
updated: 2026-11-19
procedure: 2026-11-19-run-start-inputs
level: P2
---

# 工序：run 初始资料（图片）拉取与图片模型能力

> 上游提案：[`client-proposal.md`](../../../../agent-flow-orchaster/docs/works/2026-11-19-run-start-images/client-proposal.md)，后端契约以同目录 `proposal.md` §5.1/§5.2 为准。
> 用户 2026-11-19 确认：按提案实现，先做 `T-CLI-IMG-01`（模型图片输入 + 真实 `read_image` 验证），通过后依次做 02–06。

## 1 范围

| 做 | 不做 |
|---|---|
| 模型条目声明 `input: ["text","image"]`，真实 `read_image` 验证 | 通用文件（PDF/文本）拉取 |
| poll 增加 `X-Executor-Capabilities: run-inputs` | 上传、图片编辑/压缩/OCR/缩略图 |
| `EXE-06/07` 客户端：列表、下载、SHA-256 校验、`<task-space>/inputs/` 落盘 | 改 `TaskRequest`、ACP prompt 仍为文本 |
| 失败显式（`asset` 类）与向后兼容（旧服务端无端点 → 无资料继续） | 本地缓存跨 run 复用、IMDS/对象存储 |
| 单元/组件/场景测试与 README/契约副本同步 | 改 orchestrator 仓库代码 |

## 2 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| `T-CLI-IMG-01` | change | `CMP-runtime` | `ProfileModel.input`、`S0_MODEL` 声明图片、profile 补丁带 `input`、真实 `read_image` 探针 | 完成 |
| `T-CLI-IMG-02` | change | `CMP-gateway` | transport JSON `get`、`post` 可选头、poll 能力头 | 完成 |
| `T-CLI-IMG-03` | change | `CMP-gateway` | `ExecutorRunInput`、`RunInputPort`、`parseRunInputs`、严格路径校验、`HttpScheduler` list/download | 完成 |
| `T-CLI-IMG-04` | change | `CMP-workspace` | `ensureInputsDir`/`inputStat`/`writeInput`（原子写、只读、路径/符号链接拒绝） | 完成 |
| `T-CLI-IMG-05` | change | `CMP-executor` / `CMP-result` | `runInputs` 选项、`#seedRunInputs`、三个错误码归 `asset` | 完成 |
| `T-CLI-IMG-06` | test | 上述组件 | 单元/组件/场景测试；桩调度器端到端 | 完成 |
| `T-CLI-IMG-07` | docs | `CMP-gateway` / `CMP-executor` | README 能力清单、`executor-http-v3` 契约副本、组件规格 | 完成 |

## 3 定级与确认

- **P2**：跨 `CMP-gateway`/`CMP-workspace`/`CMP-executor`/`CMP-result`/`CMP-runtime` 五个组件；给 `WorkspacePort` 增加方法、新增 `RunInputPort`，属兼容性契约扩展；不改模块切分、数据所有权与分层依赖。
- 人工门：人最终确认（合并前）；本次「按提案实现」即开工确认，收口时给完整 diff 与验证结果再确认合并。

## 4 验收标准

1. `bash scripts/check.sh`（`bun run check`）全绿：typecheck + test + docs:check + quality gate。
2. 真实链路：`writeProfilePatch` 生成的补丁启动 `dsh --profile acp`，`initialize.promptCapabilities.image === true`，`read_image` 能读出探针图中的文本与形状（证据落 `probe/`）。
3. 带 `runId` 的任务：列表 → 下载 → 校验 → `<task-space>/inputs/<name>`；无 `runId`、旧服务端 404、空列表均正常执行。
4. 失败归类：下载失败/摘要不符/路径非法 → `failed` + `error.class = asset`；磁盘/权限仍归 `workspace`。
5. 已存在且大小相同的文件不重复下载；崩溃残留临时文件不进入归档。

## 5 装载清单

- 提案：`../agent-flow-orchaster/docs/works/2026-11-19-run-start-images/{client-proposal,proposal,ui-proposal}.md`
- 契约：`docs/design/contracts/executor-http-v3.md`
- 规格：`docs/design/components/CMP-{runtime,gateway,workspace,executor,result}/spec.md`
- 代码：`src/components/{runtime,gateway,workspace,executor,result}/`、`src/components/cli/{compose,serve-compose}.ts`
- 测试：`tests/components/{runtime,gateway,workspace,executor,result}/`、`tests/scenarios/`
