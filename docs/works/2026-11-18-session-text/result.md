---
layer: works
module: global
status: active
updated: 2026-11-18
---

# 结果：会话思考与消息保留原文（preview）

## 1 结论

- preview 的 `message` 对 `agent_thought_chunk` / `agent_message_chunk` 直接返回正文（≤16 KiB），历史 UI 无需改代码即可显示。
- `data.bytes` 保留原始字节数；超过 16 KiB 时 `truncated=true` / `originalBytes`，`message` 以 `…` 结尾；全文走 raw。
- 契约升到 `2026-11-18.1`；O-11 rich 不变。
- 运行中 O-11 的 UI 适配仍未做（属于 UI 项目），历史已解决。

## 2 验收对照

| 验收 | 结果 | 证据 |
|---|---|---|
| thought preview 返回原文 | 通过 | `mapper.test.ts`「thought preview 保留正文…」 |
| message preview 返回原文 | 通过 | `mapper.test.ts` 首例，`message="hello"` |
| `data.bytes` 正确 | 通过 | thought 600 B、message 5 B |
| 超 16 KiB 截断标记 | 通过 | 18000 B → `truncated=true`、`originalBytes=18000`、`…` |
| 契约版本 | 通过 | `OBSERVABILITY_VERSION=2026-11-18.1`；health 断言 |
| 历史 UI 无需改动 | 通过 | UI `eventText` 优先 `message`；旧字段不变 |

## 3 改动

| 文件 | 内容 |
|---|---|
| `src/components/observer/mapper.ts` | `previewTextEvent`：正文 ≤16 KiB、`data.bytes`、截断标记 |
| `src/components/observer/types.ts` | 版本 `2026-11-18.1` |
| `docs/design/contracts/client-observability-v1.md` | §6/§9/§16、版本 |
| `tests/components/observer/mapper.test.ts` | 正文/字节数/截断用例 |
| `tests/components/observer/server.test.ts` | health 版本断言 |

## 4 验证

- `bun test tests/components/observer`：**23 pass / 0 fail**。
- `bun run typecheck`：通过。
- `bun run docs:check`：通过。

## 5 限制与后续

- 单条正文上限 16 KiB；更长内容截断，raw 保留全文。
- 运行中 O-11 的 `text` 仍需 UI 适配（筛选按 `kind`、渲染读 `text`）；本次未改 UI 仓库。
- 若需要关闭正文落盘，可另加 `[observability].text_content` 开关；本次默认开启。
- 本次不采用 `content=text` 查询方案：用户要求 preview 本身保留原文，默认直出更直接。
