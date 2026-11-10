---
layer: design
module: execution-plane
component: CMP-result
status: active
updated: 2026-11-10
---

# CMP-result 组件规格（v2）

> 状态：`active`。纯策略组件，无 I/O、无端口、无持久化。

## 1. 职责

- 从 `SessionOutcome` 组装 `TaskResult`；
- 组件错误码 → `ErrorClass`（v2 无 `retryable`）；
- UTF-8 安全截断（上限 256 KiB）；
- 停止原因归一。

## 2. 组装规则

- 无 error 且 stopReason 正常 → `succeeded`。
- `class=cancelled` → `cancelled`；`class=timeout` → `timeout`；其他 error → `failed`。
- `message` 有输出就填，空串只表示确实没有输出。
- `error` 为 `{class, code, message}`；无 `retryable`/`reason`。
- `taskId`/`attempt` 来自上下文，不从模型输出推断。
- `usage` 缺失为 `null`。

## 3. 截断

- 单位 UTF-8 字节；标记 `\n…[truncated]`（15 字节）。
- 总字节数（含标记）≤ `maxBytes`；不切断码点；`maxBytes < 15` 返回空串 + `truncated=true`。

## 4. 错误映射

闭集：`workspace` / `asset` / `runtime` / `protocol` / `cancelled` / `timeout` / `scheduler` / `internal`。约定 code：`prompt_timeout`（总超时）、`idle_timeout`（无进度）。

## 5. 验证

`tests/components/result/result.test.ts`。
