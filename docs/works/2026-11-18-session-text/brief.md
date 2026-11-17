---
layer: works
module: global
status: active
updated: 2026-11-18
procedure: 2026-11-18-session-text
level: P2
---

# 工序：会话思考与消息全文的读取契约（设计）

> 来源：用户 2026-11-18 反馈，会话视图的“思考”只显示 `thought: 618 bytes`，“消息”里的助手消息也被截断；希望历史与运行中都能看到完整正文。
> 定级：**P2**（观测面契约的兼容性加法 + 跨 client/orchestrator/UI 数据口径；不改执行面、不改任务语义）。本工序只做设计，不改代码、不改现行契约。

## 1 问题

- 会话视图的历史事件来自 client 的 **preview** 事件（O-07 → API-51）：
  - thought 只写 `thought: N bytes`，没有正文；
  - message 只写 `assistant: <前 800 字节>…`，超过 800 字节即截断。
- 全文已经在 client 的 **rich** 事件里（O-11 `/sessions/{id}/events/stream`，`kind:"thought"|"message"` + `text`），但 rich 只在运行中内存 ring 保留，不落盘，结束后不可查。
- 实测同一会话：final assistant message 原文 9475 字节，preview 只有 813 字节（含前缀与 `…`）；thought 原文 618 字节，preview 只有字节数。
- 结果是：运行中 O-11 有全文（UI 尚未适配 rich 形状），历史只能看到节选或字节数。

## 2 范围

| 做 | 不做 |
|---|---|
| 现状链路与数据丢失点（thought + message） | 改 client 代码 |
| 方案对比与推荐 | 改现行 `client-observability-v1` |
| 契约 diff（查询、字段、上限、隐私、版本） | 改 orchestrator/UI 代码 |
| client / orchestrator / UI 改动清单与发布顺序 | 实现 O-11 历史持久化 |
| 测试与验收方案 | 改执行面 `executor-http-v3` |

## 3 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| T-01 | design | global | 逐跳定位 thought/message 正文在哪丢失 | 完成 |
| T-02 | design | global | 方案 A–E 对比与推荐 | 完成 |
| T-03 | design | 契约 / client / orchestrator / UI | 契约 diff、组件改动、发布/回滚 | 完成 |
| T-04 | review | global | 用户确认内容范围、上限、默认、live 归一化 | 待确认 |
| T-05 | plan | global | 确认后拆实现工序（client / orchestrator / UI） | 待确认 |

## 4 验收标准（设计阶段）

1. 能逐跳说明 thought 与 message 正文在哪里被丢弃、为什么历史看不到。
2. 给出至少 3 个方案，标明契约、存储、隐私、UI 改动与风险。
3. 契约 diff 可直接执行：查询参数、字段、上限、默认值、错误/缺省、版本与兼容。
4. 明确 client、orchestrator、UI 各自改什么，发布顺序与回滚。
5. 未决问题可拍板（内容范围、上限、默认存储、live 形状归一化）。

## 5 待确认

- 内容范围：只做 thought，还是 thought + message 一起（建议一起，message 同样被截断）。
- 单条上限：16 KiB（与 O-11 一致）还是 64 KiB/不限？
- 是否默认持久化正文，还是用 `[observability].text_content` 开关（默认开/关）？
- live 事件形状：由 orchestrator BFF 归一化，还是 UI 同时兼容 preview/rich 两套形状？
