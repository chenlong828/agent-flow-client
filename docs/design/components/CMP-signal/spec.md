---
layer: design
module: execution-plane
component: CMP-signal
status: active
updated: 2026-11-18
---

# CMP-signal 组件规格（v1）

> 状态：`active`（2026-11-18，P1 结构决策后落地）。上游：[`architecture.md`](../../architecture.md) §4/§7、[`executor-http-v3.md`](../../contracts/executor-http-v3.md) `C-13`/`C-14`、提案 [`2026-11-18-review-verdict-mcp`](../../../works/2026-11-18-mcp-signal-feedback/review.md)。

## 1 职责与边界

- **单元 / 层 / 类型**：组件；L0 基础设施；技术边界（文件 + 子进程）。
- **业务价值**：把「review 节点的结构化判决」从消息末尾的 JSON 变成 per-attempt 的结构化信号；删掉它，verdict 只能靠事后解析文本。
- **负责**：
  - 生成 per-attempt 信号目录与 `config.json`（`<stateRoot>/signals/<taskId>/<attempt>/`，`0700`/`0600`）；
  - 构造 `session/new.mcpServers`（server 名 `agentflow`；raw tool 由 `resultSignal.kind` 决定：`review_verdict`→`signal`、`confirmation_request`→`confirm`；绝对 command/脚本、只带 `AF_SIGNAL_CONFIG`）；
  - `--check` 预检与正式启动共用同一入口（`A-10`）；
  - 采集 `signals.jsonl`（忽略半行/非法行、按 seq 取最后窗口、≤8 条/≤16 KiB）；
  - 保留期清理（默认 7 天，启动与 `doctor`）。
- **不负责**：
  - 工具语义与 verdict 判定（`CMP-run` / skill）；
  - `TaskResult` 组装与预算（`CMP-result`）；
  - DSH 进程与 session 生命周期（`CMP-runtime`）；
  - 决定任务成败（`CMP-executor`）。
- **变化轴**：信号契约版本、server 分发形态（bun 脚本 / 独立可执行文件）。
- **删除测试**：删掉后信号目录/预检/采集会散进 `CMP-executor` 与 `CMP-result`，L1 直接碰文件与子进程——真边界。

## 2 内部功能

| 单元 | 职责 |
|---|---|
| `contract` | 受限 schema 定义与校验、`toMcpInputSchema` 投影（`A-01`）、记录形状校验、`parseResultSignal` |
| `directory` | 路径派生（taskId 安全折叠）、目录/文件权限、config 读写、保留期清理 |
| `collect` | 读 `signals.jsonl`：忽略损坏行与半行、seq 排序、最后窗口与字节上限 |
| `mcp` | `mcpServers` 构造；`isSignalMountError`（`error.data.details` 命中 `mcp-client(agentflow)`） |
| `signal` | `FileSignal`：`prepare`/`collect`/`cleanup`，`SignalPort` 的 L0 实现 |
| `signal-server`（`src/mcp/`） | stdio MCP server：初始化、`tools/list`（按 kind 暴露一个工具）、`tools/call`、`--check`；追加 + `fsync` 后 ack |

### 2.1 server 关键行为

- 对未知方法（含 MCP SDK 的 `server/discover` 探针）**立即回 `-32601`**；静默忽略会让 DSH 等满 60 s（实测 `S-07`）。
- 启动幂等：不清空 `signals.jsonl`、不持独占锁；`seq` 从文件最大行续号（`session/new` 会启动两次 server，`S-05`）。
- 参数非法返回 MCP `isError: true` 且不写文件；长度一律按 UTF-8 字节。
- 只写 `AF_SIGNAL_CONFIG` 指定的文件：不读 task-space、不访问网络、不执行 shell。

### 2.2 预检与降级

- `prepare` 只对 `version=1` + `kind=review_verdict` + 合法 schema 生效；其余返回 `unsupported`，executor 按旧行为执行（不挂 MCP、不发 signals）。
- 目录/预检失败抛 `signal_prepare_failed`；挂载失败由 executor 用相同 `mcpServers` 重建一次后归 `signal_mount_failed`（`Q-07`/`Q-09`）。
- 采集异常只记 `signal.invalid`，不把任务判失败。

## 3 端口与契约

```ts
type SignalPort = {
  prepare(input: { taskId: string; attempt: number; contract: ResultSignalContract }): Promise<SignalPrepareResult>;
  collect(input: { taskId: string; attempt: number; contract: ResultSignalContract; plan: SignalPlan }): Promise<TaskSignal[] | undefined>;
  cleanup(retentionDays: number): Promise<number>;
};
```

- 端口由 `CMP-executor` 定义，`CMP-signal` 实现，组合根注入；`CMP-signal` 不 import 其他 L0。
- 值类型（`ResultSignalContract`/`TaskSignal`/`McpServerSpec`/`SignalPlan`）在 `src/components/signal/contract.ts`，server 与 client 共用同一份校验。
- 本组件不与调度器交互；对外只体现为 `TaskResult.signals` 与 `error.code`。

## 4 不变量

1. 一个 `taskId+attempt` 一个目录；旧 attempt 保留但不读。
2. 目录/文件不放进 task-space，也不进归档包。
3. 采集只接受与 `resultSignal.kind` 匹配、且通过受限 schema 校验的记录。
4. `message + signals` 不超 `maxResultBytes`（预算在 `CMP-result` 执行）。
5. server 进程随 DSH 进程组退出（`C-09` 覆盖），不单独做残留清理。

## 5 数据所有权

| 数据 | 写入口 | 一致性/保留 |
|---|---|---|
| `<stateRoot>/signals/<taskId>/<attempt>/config.json` | `CMP-signal` | 每 attempt 覆盖写；`0600` |
| `<stateRoot>/signals/<taskId>/<attempt>/signals.jsonl` | signal server（仅追加） | `fsync` 后 ack；`0600`；默认保留 7 天 |

## 6 验证

| 类型 | 用例 | 文件 |
|---|---|---|
| 契约/投影 | schema 校验、`string[]` 展开、执行关键字不进 schema、UTF-8 字节上限 | `tests/components/signal/contract.test.ts` |
| 组件 | 目录/权限、config、预检、采集窗口、清理 | `tests/components/signal/signal.test.ts` |
| server | `server/discover` 立即回错、初始化、工具调用、非法不写、重启续号、`--check` | `tests/components/signal/server.test.ts` |
| 链路 | session/new 带 `mcpServers`、挂载重试、采集后随结果回传 | `tests/scenarios/signal-flow.test.ts` |
| 确认点 | `confirmation_request` 契约暴露 `confirm` 工具、错用 `signal` 返回 -32602 | `tests/components/signal/server.test.ts` |
| 续跑 | 桩调度器两次任务：确认点回传 `sessionId`，续跑任务 `session/resume` | `tests/scenarios/confirm-flow.test.ts` |

## 7 单独运行

```bash
bun test tests/components/signal tests/scenarios/signal-flow.test.ts
```

`--check` 单独跑：`AF_SIGNAL_CONFIG=<config.json> bun src/mcp/signal-server.ts --check`。

## 8 开放问题

- server 分发形态（已定）：Bun 运行时用 `process.execPath` + 绝对 TS 脚本；编译后的单二进制用自身 + 隐藏子命令 `signal-server`（`resolveSignalServerCommand`）。已用 `bun build --compile` 产物验证 `--check`、`tools/list`、`tools/call`、`server/discover` 回错。
- Windows：仍未在 Windows 上实测；实现层面无 shell 依赖（参数数组、绝对路径），`bun.exe` 由 `basename` 正则识别，`runtime` 的进程组回收已有 `win32` 分支。风险点：盘符/空格路径与 `SIGTERM` 语义，需在 Windows 机器上补一次冒烟。
