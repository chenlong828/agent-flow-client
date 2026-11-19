---
layer: works
module: global
status: active
updated: 2026-11-19
procedure: 2026-11-19-run-start-inputs
level: P2
---

# 结果：run 初始资料（图片）拉取与图片模型能力

## 1 结论

提案 `T-CLI-IMG-01`–`07` 全部落地；`bun run check` 全绿（typecheck、285 个测试、docs:check、质量门禁 16 项全 PASS）。真实读图链路已在本机验证：`promptCapabilities.image=true`，`read_image` 读出探针图内容。与真实 orchestrator 的联调（`EXE-06/07` 服务端）仍未进行，按上游工序推进。

## 2 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| `bun run check` 全绿 | 通过 | check 输出：typecheck 无错、285 pass / 0 fail、Q-01–Q-16 全 PASS |
| 补丁启动的 ACP 声明图片输入 | 通过 | [`probe/read-image-evidence.json`](probe/read-image-evidence.json)：`promptCapabilities.image=true` |
| `read_image` 能读出图片内容 | 通过 | 同证据：调用 `read_image`，模型读出 `AF IMG 7319` 与蓝色矩形 |
| 带 `runId`：列表→下载→校验→`<task-space>/inputs/<name>` | 通过 | `tests/components/executor/execute.test.ts`、`tests/scenarios/v3-serve.test.ts` |
| 无 `runId`、旧服务端 404、空列表：正常执行 | 通过 | 同上 + `tests/components/gateway/gateway.test.ts` |
| 下载/摘要/路径失败 → `failed` + `asset` | 通过 | `execute.test.ts` 三条失败用例 + `result.test.ts` |
| 磁盘/权限错误仍归 `workspace` | 通过 | `execute.test.ts`「磁盘/权限错误原样抛出」 |
| 已存在且大小相同不重复下载 | 通过 | `execute.test.ts`「已存在且大小相同：跳过下载」 |
| 崩溃残留临时文件不进归档 | 通过 | `task-space.test.ts`「ensureInputsDir…清理 `.part`」 |

## 3 结论落点

| 内容 | 落点 |
|---|---|
| 模型条目 `input: ["text","image"]` | [`src/components/runtime/profile.ts`](../../../src/components/runtime/profile.ts) |
| poll 能力头、`get`、`RunInputPort` 实现 | [`src/components/gateway/transport.ts`](../../../src/components/gateway/transport.ts)、[`gateway.ts`](../../../src/components/gateway/gateway.ts) |
| 严格解析与下载路径校验 | [`src/components/gateway/run-input-wire.ts`](../../../src/components/gateway/run-input-wire.ts) |
| `ExecutorRunInput`、`RunInputPort`、`WorkspaceInputsPort` | [`src/components/executor/types.ts`](../../../src/components/executor/types.ts)、[`ports.ts`](../../../src/components/executor/ports.ts) |
| `inputs/` 原子写入/只读/路径校验 | [`src/components/workspace/inputs.ts`](../../../src/components/workspace/inputs.ts) |
| 种子阶段与失败分流 | [`src/components/executor/run-inputs.ts`](../../../src/components/executor/run-inputs.ts)、[`executor.ts`](../../../src/components/executor/executor.ts) |
| 三个错误码归 `asset` | [`src/components/result/result.ts`](../../../src/components/result/result.ts) |
| 组合根装配（serve 注入、本地 run 不注入） | [`src/components/cli/serve-compose.ts`](../../../src/components/cli/serve-compose.ts)、[`compose.ts`](../../../src/components/cli/compose.ts) |
| 契约副本增量（`EXE-06/07`、能力头、`C-18/19`、§11.8） | [`docs/design/contracts/executor-http-v3.md`](../../design/contracts/executor-http-v3.md) |
| 组件规格与架构更新 | [`CMP-gateway`](../../design/components/CMP-gateway/spec.md)、[`CMP-workspace`](../../design/components/CMP-workspace/spec.md)、[`CMP-executor`](../../design/components/CMP-executor/spec.md)、[`CMP-result`](../../design/components/CMP-result/spec.md)、[`CMP-runtime`](../../design/components/CMP-runtime/spec.md)、[`CMP-cli`](../../design/components/CMP-cli/spec.md)、[`architecture.md`](../../design/architecture.md) |
| 读图探针与证据 | [`probe/read-image-probe.ts`](probe/read-image-probe.ts)、[`probe/read-image-evidence.json`](probe/read-image-evidence.json) |

## 4 测试与门禁

- 新增/扩展：`profile.test.ts`（3）、`wire.test.ts`（5）、`gateway.test.ts`（6）、`task-space.test.ts`（6）、`execute.test.ts`（8）、`result.test.ts`（1）、`v3-serve.test.ts`（1）；全套 285 pass / 0 fail。
- `quality:gate`：Q-05 圈复杂度 15（上限 15）、Q-08 单文件函数 20（上限 20）、Q-09 类方法 10（上限 10），均 PASS；为此把种子逻辑与 `inputs` 子能力拆成独立模块（见 `review.md` `D-01`）。
- 读图探针可复现：`set -a; . ./.env; set +a; bun docs/works/2026-11-19-run-start-inputs/probe/read-image-probe.ts`（需要 `DSH_BIN`、`HUNDSUN_PUBLIC_API_KEY`）。

## 5 未决与后续

1. **真实 orchestrator 联调**：上游 `EXE-06/07` 与上传/绑定落地后，跑「UI 上传 2 张 PNG → 启动 → client 落盘 → 首节点 `read_image` → 归档含 `inputs/`」。
2. **Windows 覆盖只读文件**：`rename` 失败回退分支未真机验证。
3. **归档显式断言**：`packTaskSpace` 未改；建议联调时补一条「tar 含 `inputs/`」断言。
4. **部署注意**：把 `AF_MODEL` 指到纯文本模型时需同步改 `S0_MODEL.input`（或未来加 `AF_MODEL_INPUT`），否则 `read_image` 会在 provider 处失败。
