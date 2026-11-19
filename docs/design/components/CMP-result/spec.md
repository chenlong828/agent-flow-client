---
layer: design
module: execution-plane
component: CMP-result
status: active
updated: 2026-11-12
---

# CMP-result 组件规格（v2）

> 状态：`active`。纯策略组件，无 I/O、无端口、无持久化。

## 1. 职责

- 从 `SessionOutcome` 组装 `TaskResult`；
- 组件错误码 → `ErrorClass`（v2 无 `retryable`）；v3 增 `session_log_too_large` → `runtime`；
- UTF-8 安全截断（上限 256 KiB）；
- 停止原因归一。

## 2. 组装规则

- 无 error 且 stopReason 正常 → `succeeded`。
- `class=cancelled` → `cancelled`；`class=timeout` → `timeout`；其他 error → `failed`。
- `message` 有输出就填，空串只表示确实没有输出。
- `signals` 只在 `succeeded` 且采集到合法记录时写入；超过 8 条取最后 8 条，整段超 16 KiB 时丢弃（不截断 `reason`）。
- `error` 为 `{class, code, message}`；无 `retryable`/`reason`。
- `taskId`/`attempt` 来自上下文，不从模型输出推断。
- `usage` 缺失为 `null`。

## 3. 截断

- 单位 UTF-8 字节；标记 `\n…[truncated]`（15 字节）。
- 有 `signals` 时 `message` 预算 = `maxResultBytes - signals 字节 - 1 KiB`；无 `signals` 时与旧行为一致。
- 总字节数（含标记）≤ `maxBytes`；不切断码点；`maxBytes < 15` 返回空串 + `truncated=true`。

## 4. 错误映射

闭集：`workspace` / `asset` / `runtime` / `protocol` / `cancelled` / `timeout` / `scheduler` / `internal`。约定 code：`prompt_timeout`（总超时）、`idle_timeout`（无进度）。

| 新 code | class | 触发 |
|---|---|---|
| `input_fetch_failed` | `asset` | 初始资料列表/下载失败（网络、5xx、超时重试后） |
| `input_checksum_mismatch` | `asset` | 初始资料长度或 SHA-256 不符 |
| `input_path_invalid` | `asset` | 初始资料名/路径穿越、符号链接或目录越界 |

## 5. 验证

`tests/components/result/result.test.ts`。
