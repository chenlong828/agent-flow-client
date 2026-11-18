---
layer: works
module: global
status: active
updated: 2026-11-18
procedure: 2026-11-18-session-text
level: P2
---

# 工序：会话思考与消息保留原文（preview）

> 来源：用户 2026-11-18 反馈，历史会话的“思考”只显示 `thought: N bytes`，无法判断内容；同一条链路的 assistant message 也被截到 800 字节。
> 要求：**历史的 preview 必须保留 thought 原文**；message 同样处理。
> 定级：**P2**（观测面 preview 内容口径变化 + 存储体积；不改执行面、不改任务语义）。

## 1 结论

- preview 的 `message` 对 `agent_thought_chunk` / `agent_message_chunk` 直接返回正文（≤16 KiB），不再是字节数或 800 字节节选。
- `data.bytes` 保留原始字节数；超限时 `data.truncated=true`、`data.originalBytes`；全文仍在 raw。
- UI 现有历史视图读 `message`，**无需改 UI 即可显示正文**；O-11 live 的 UI 适配另行处理。
- 契约版本 `2026-11-18.1`；纯加法/默认内容变化，不升协议。

## 2 范围

| 做 | 不做 |
|---|---|
| preview thought/message 保留正文 | 改执行面 `executor-http-v3` |
| 契约 §6/§9/§16 与版本 | 改 orchestrator/UI 代码 |
| mapper/tests | 持久化 O-11 rich 事件 |
| 结果记录 | 16 KiB 以上的全文（走 raw） |

## 3 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| T-01 | design | global | 定位 thought/message 丢失点与方案 | 完成 |
| T-02 | code | CMP-observer | mapper preview 直出正文 + bytes/截断标记 | 完成 |
| T-03 | contract | client-observability-v1 | `message` 上限、默认口径、版本 | 完成 |
| T-04 | test | CMP-observer | 正文/截断/字节数/版本断言 | 完成 |
| T-05 | docs | global | 结果与限制记录 | 完成 |

## 4 验收

1. `agent_thought_chunk` 的 preview `message` 等于原文（≤16 KiB），不再是 `thought: N bytes`。
2. `agent_message_chunk` 的 preview `message` 为原文（≤16 KiB），不再是 `assistant: ` 前 800 字节。
3. `data.bytes` 为原始字节数；超 16 KiB 时 `truncated=true`、`originalBytes` 正确，`message` 以 `…` 结尾。
4. 其他 preview 事件仍 ≤4 KiB；prompt/tool I/O 不进入 preview。
5. 历史 UI 不改代码即可显示正文；O-11/live 的 UI 适配列为后续。
