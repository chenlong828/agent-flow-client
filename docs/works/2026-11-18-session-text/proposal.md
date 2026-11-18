---
layer: works
module: global
status: active
updated: 2026-11-18
---

# 设计：会话思考与消息保留原文（preview）

> 对应 [brief.md](brief.md)。结论：**preview 的 `message` 直接返回 thought/message 正文（≤16 KiB）**，不再只给字节数或 800 字节节选；不改查询、不改 O-11、不需要 UI 改动就能让历史视图显示正文。

## 1 现状与证据

```text
DSH agent_thought_chunk / agent_message_chunk
  └─ client AcpObservationMapper
       ├─ preview thought: message="thought: N bytes"        ← 正文丢掉
       ├─ preview message: message="assistant: <前 800 字节>…" ← 截断
       │    └─ 落盘 attempts/<id>/events.jsonl
       │         └─ O-04/O-05/O-07 → API-51 → UI 历史
       └─ rich: {kind, text}（≤16 KiB）→ O-11 → API-52 → UI live
```

实测同一会话（2026-11-17 16:41，n2）：

| 内容 | 原文 | 旧 preview |
|---|---:|---:|
| final assistant message | 9475 字节 | 813 字节（800 + 前缀 + `…`） |
| thought #32 | 1496 字节 | 只有 `thought: 1496 bytes` |
| thought #44 | 1961 字节 | 只有 `thought: 1961 bytes` |

旧实现：`previewText("assistant", text)` 截 800 字节；`#thought` 只写字节数；UI `eventText` 优先取 `message`，所以显示节选/字节数。

## 2 决策

**A. preview `message` 直出正文（采用）**

- thought/message 的 `message` = 原文，单条 ≤16 KiB；超出用 `…` 截断。
- `data.bytes` = 原始字节数；截断时加 `truncated`/`originalBytes`。
- 其他 preview 事件仍 ≤4 KiB。
- O-11 不变；live 仍由 UI 适配 rich `text`。
- 历史 UI 无需改动：它已经显示 `message`。

被否决：

| 方案 | 否决理由 |
|---|---|
| 新增 `content=text` 查询 | 用户要求 preview 本身保留原文；多一个查询与发布顺序 |
| `data.text` 另存 + UI 改造 | 旧 UI 仍显示字节数，不能立即解决截图问题 |
| 只改 UI 读 O-11 | 只解决运行中，历史仍无正文 |
| 持久化 O-11 rich | 与 preview 双份存储，改动最大 |

## 3 契约 diff（`client-observability-v1`）

- §6 O-04：
  - `message`：`agent_thought_chunk` / `agent_message_chunk` ≤16 KiB；其他事件 ≤4 KiB。
  - `data.bytes`：thought/message 原始字节数。
  - 截断：`data.truncated=true`、`data.originalBytes`。
  - 默认返回正文；不返回 prompt、工具完整 I/O；全文走 O-08。
- §9 O-07：同一 schema；thought/message 同样按 16 KiB 上限返回。
- §16 验收：preview 不含 prompt/tool I/O；thought/message 正文按 16 KiB 上限返回。
- 版本：`2026-11-17.1` → `2026-11-18.1`；`observabilityVersion` 同步。
- 兼容：字段不变，只是 `message` 内容变长；旧 UI/orchestrator 无需改；旧 client 仍显示节选。

## 4 实现与数据

| 文件 | 改动 |
|---|---|
| `src/components/observer/mapper.ts` | `#thought`/`#message` 用 `previewTextEvent`；正文 ≤16 KiB；`data.bytes`/截断 |
| `src/components/observer/types.ts` | `OBSERVABILITY_VERSION` → `2026-11-18.1` |
| `docs/design/contracts/client-observability-v1.md` | §6/§9/§16 与版本 |
| `tests/components/observer/mapper.test.ts` | 正文、字节数、16 KiB 截断 |
| `tests/components/observer/server.test.ts` | health 版本 |

存储：thought/message 正文写入 attempt `events.jsonl`，计入 10 MiB/attempt 预算；超出预算时按既有淘汰策略截断，raw 仍是全文。观测面默认 loopback + token；正文按本地敏感数据处理。

## 5 影响与后续

- 历史“思考/消息”立即显示正文（≤16 KiB），字节数作为 chip 保留。
- 运行中 O-11 的 `text` 仍需 UI 适配（筛选按 `kind`、渲染读 `text`）；不在本次 client 改动范围。
- 超过 16 KiB 的单条内容截断，UI 应显示截断标记；全文用 raw。
- 若后续需要彻底关闭正文，再加 `[observability].text_content` 开关（本次未加）。
