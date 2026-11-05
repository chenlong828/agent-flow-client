---
layer: design
module: execution-plane
component: CMP-result
status: planned
updated: 2026-11-04
---

# CMP-result 组件规格

> 状态：`planned`。纯策略组件，无 I/O、无端口、无持久化。
>
> 上游：`docs/design/architecture.md` §4–§7；`SCN-0001`；`REQ-0002` R-02/R-08；结果三段拆分决策 D5。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L1a 领域基础；业务策略。
- **业务价值**：结果语义单点：什么算成功、什么可重试、超长怎么截断、错误如何分类。没有它，错误分类会散进 executor 与 gateway，两个变化轴被合并。
- **负责 X**：
  - 从 `SessionOutcome` 组装 `NodeResult`；
  - 本地失败 → `ErrorClass` + `retryable` 的映射；
  - 最终消息的大小上限与 UTF-8 安全截断；
  - 停止原因与用量的归一化。
- **不负责 Y**：
  - ACP 事件解析（`CMP-runtime`）；
  - 传输、重试、幂等（`CMP-gateway`）；
  - 持久化（`CMP-store`）；
  - 解释业务字段、判断评审结论。
- **变化轴**：结果格式与错误分类（随 M1 契约）。
- **删除测试**：删掉后错误分类与截断会散进 executor 和 gateway——真边界。

## 2. 内部功能

| 函数 | 签名 | 说明 |
|---|---|---|
| `assemble` | `assemble(outcome: SessionOutcome, ctx: ResultContext) → NodeResult` | 成功/失败/取消/超时归一；不抛异常 |
| `classify` | `classify(error: ComponentError) → ErrorMapping` | 组件错误码 → `ErrorClass` + `retryable` + 稳定 `code` |
| `truncate` | `truncate(text: string, maxBytes: number) → TruncatedText` | 按 UTF-8 字节截断，返回 `{ text, truncated }` |
| `mapStopReason` | `mapStopReason(raw: string) → StopReason` | ACP 停止原因归一；未知值保留原字符串并标记 `unknown` |

### 2.1 组装规则

- `outcome.error` 为空且 `stopReason` 正常 → `status: "succeeded"`，`message` = 最终消息（截断）。
- `outcome.error.code === "cancelled"` → `status: "cancelled"`，不带部分输出（OQ-013）。
- `outcome.error.code === "timeout"` → `status: "timeout"`，不带部分输出。
- 其他 `outcome.error` → `status: "failed"`，`error` 由 `classify` 生成。
- `sessionId` 原样带出；`attemptId` 来自 `ResultContext`，不从 model 输出推断。
- `usage` 缺失时省略字段，不写 `0`；`null` 与缺失等价。
- `truncated` 由 `truncate` 结果决定；截断不得影响 `status` / `error` / `sessionId` 等控制字段。

### 2.2 错误分类

`ErrorClass` 闭集：

`workspace` · `asset` · `runtime` · `timeout` · `cancelled` · `protocol` · `scheduler` · `internal`

映射表（组件错误码 → 类别 / 可重试提示）：

| 来源 | 错误码 | `ErrorClass` | `retryable` |
|---|---|---|---|
| workspace | `not_prepared`、`layout_invalid`、`path_escape`、`permission_denied` | `workspace` | false |
| workspace | `disk_full` | `workspace` | false（同机重试无意义；由调度器换实例） |
| assets | `download_failed`、`checksum_mismatch`、`unpack_failed` | `asset` | true |
| assets | `invalid_skill_format`、`skill_set_conflict` | `asset` | false |
| runtime | `spawn_failed`、`process_exited` | `runtime` | true |
| runtime | `protocol_error`、`prompt_failed` | `runtime` / `protocol` | false |
| runtime | `cancelled` | `cancelled` | false |
| runtime | `timeout` | `timeout` | true |
| gateway | `unreachable`、`rate_limited` | `scheduler` | true |
| gateway | `unauthorized`、`version_incompatible`、`invalid_request` | `scheduler` | false |
| gateway | `lease_expired` | `scheduler` | false（丢弃尝试） |
| 未知 | — | `internal` | false |

`retryable` 只是**提示**，最终由调度器裁决；client 不据此自动重跑节点。

### 2.3 截断

- 单位：UTF-8 字节；上限来自配置（M1，OQ-006）。
- 超过上限：在边界处回退到完整码点，追加 `\n…[truncated]`，`truncated: true`。
- 不截断 `status`、`error`、`sessionId`、`attemptId`、`stopReason`。
- 截断后仍是合法 JSON 字符串；不产生半个码点。

## 3. 契约

### 3.1 `assemble`

- **签名**：`assemble(outcome, ctx) → NodeResult`。
- **前置**：`ctx.attemptId` 非空；`outcome` 已完成（成功、失败、取消或超时之一）。
- **后置**：返回的 `NodeResult` 可被 `CMP-gateway` 直接序列化；字段形态符合 M1 冻结的 `NodeResult`。
- **不变量**：纯函数；同样输入同样输出；不读时钟/环境/文件；不抛业务异常。
- **错误模式**：无。若 `outcome` 不自洽（例如既无 error 又无 stopReason），归为 `internal` 并保留诊断信息。

### 3.2 `classify`

- **签名**：`classify(error) → { class: ErrorClass; retryable: boolean; code: string }`。
- **不变量**：未知错误不抛，归 `internal`；映射表是唯一分类来源；`code` 保留原组件错误码，便于排障。
- **错误模式**：无。

### 3.3 `truncate`

- **签名**：`truncate(text, maxBytes) → { text, truncated }`。
- **前置**：`maxBytes ≥ 0`。
- **不变量**：输出字节数不超过 `maxBytes`；不切断 UTF-8 码点；`truncated` 准确。
- **错误模式**：`maxBytes < 0` 视为编程错误，抛 `RangeError`。

### 3.4 值类型（占位）

```ts
type ResultContext = {
  attemptId: AttemptId;
  sessionId?: SessionId;
};

type TruncatedText = { text: string; truncated: boolean };

type ErrorMapping = {
  class: ErrorClass;
  retryable: boolean;
  code: string;
};
```

`NodeResult` 字段由 M1 冻结；本组件只承诺上述语义，不承诺字段名以外的扩展。

## 4. 依赖与分层

- 依赖：无（标准库字符串/编码工具）。不依赖任何 L0、端口或 `CMP-executor`。
- 被依赖：`CMP-executor`（L1b → L1a，唯一允许方向）。
- 禁止边：不得 import L0；不得 import `CMP-cli`；不得读配置/日志/文件。

## 5. 数据所有权

- 无持久化数据；只处理 `NodeResult` 值类型与错误映射。
- 不缓存、不共享可变状态；每次调用独立。

## 6. 冷热与资源

- 纯计算，属于冷路径的结算步骤；无 I/O、无超时、无资源隔离需求。
- 截断是 O(n) 字节扫描，不引入流式/worker。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| 规则 | 成功/失败/取消/超时四类组装 | `status`、`error.class`、`sessionId` 正确 |
| 映射 | 表驱动覆盖每个错误码；未知错误 | 类别与 `retryable` 与表一致 |
| 边界 | 文本刚好等于上限、超 1 字节、超多字节码点、空串 | 不切断码点；`truncated` 准确 |
| 纯度 | 同样输入两次调用 | 输出相等；无副作用 |
| 契约 | 输出可 JSON 序列化；控制字段不被截断 | 序列化/字段断言 |

## 8. 预算与单独运行

- 预算：目标 ≤8k token，上限 120k。
- 单独运行：`bun test tests/components/result/`（落地后创建）；无外部依赖。
- 状态：`planned`；无入口符号。

## 9. 开放问题

- `NodeResult` 字段与结果大小上限（M1，OQ-006）。
- 取消/超时是否携带部分输出（OQ-013；当前默认不带）。
- `usage` 的单位与缺失语义（M1）。
