---
layer: works
module: global
status: active
updated: 2026-11-18
---

# 设计：会话思考全文的读取契约

> 对应 [brief.md](brief.md)。目标：会话视图（历史与运行中）都能看到 thought 正文，而不是 `thought: 618 bytes`。
> 结论：**不改 preview 的默认语义，新增显式 `content=thought` 读取路径**；client 落盘有上限的 thought 正文，orchestrator 透传查询，UI 同时适配 preview 与 rich 两种事件形状。

## 1 现状：正文在哪一跳丢失

```text
DSH agent_thought_chunk
  └─ client AcpObservationMapper.#thought
       ├─ preview: message="thought: 618 bytes", data={acpType}      ← 正文在这里被丢掉
       │    └─ recorder 落盘 attempts/<id>/events.jsonl
       │         └─ O-04/O-05/O-07（preview）→ API-51 → UI 会话历史
       └─ rich: {kind:"thought", text:"……"}                          ← 有正文
            └─ SessionRichHub 内存 ring（不落盘）
                 └─ O-11 SSE → API-52 → UI 运行中
```

| 跳 | 现状 | 证据 |
|---|---|---|
| client 归一化 | preview 只写字节数；rich 写正文 | [`mapper.ts:52`](../../../src/components/observer/mapper.ts) |
| 落盘 | 只落 preview；rich 只在内存 | [`recorder.ts:104`](../../../src/components/observer/recorder.ts) |
| 历史读取 | O-04/O-05/O-07 返回 `message`，不含正文 | [`client-observability-v1.md:135`](../../design/contracts/client-observability-v1.md) |
| orchestrator 代理 | API-51 透传 preview 的 `message`/`data` | `observability-client/adapter.ts` 的 `listEvents`/`toEvent` |
| UI 渲染 | `eventText` 先取 `message`，所以显示字节数 | `agent-flow-ui/assets/js/run/views/session.js:69` |

补充：运行中的 O-11 虽然有 `text`，但 UI 的筛选按 `event`（rich 只有 `kind`）、`eventText` 只看 `message`/`data.text`，所以 **live 的 thought 目前也不会按“思考”正确显示**。这是 UI 适配问题，与契约无关；本次设计一并列入 UI 改动。

## 2 方案对比

| 方案 | 做法 | 契约改动 | 存储 | 隐私 | UI 改动 | 结论 |
|---|---|---|---|---|---|---|
| **A. preview 增加 `content=thought`（推荐）** | O-04/O-05/O-07 新增查询；只在该查询下返回 thought 正文 | 兼容性加法 | preview 事件多存 `data.text`（有上限） | 默认不暴露，显式查询才返回 | 传查询、渲染 `data.text` | **推荐** |
| B. preview 默认带正文 | 不加查询，`data.text` 始终返回 | 改默认语义 | 同上 | 所有 preview 消费者都拿到 | 最小 | 不推荐：默认泄露面/响应体变大 |
| C. 新增 `GET /sessions/{id}/thoughts` | 独立 thought 列表 | 新端点 | 仍需落盘 | 显式端点 | 新数据源 | 可行，但多一套分页/游标/错误面 |
| D. 持久化 O-11 rich 事件 | rich 落盘，历史读 rich | 新存储/端点 | 与 preview 双份 | 同上 | 统一形状 | 改动最大，暂不推荐 |
| E. 只修 UI（live） | UI 读 O-11 `text` | 无 | 不落盘 | 无 | 中 | 只解决运行中，历史仍是字节数 |

推荐 **A**：历史与实时都能看到正文；默认行为不变；存储只增加一个有上限的字段，不引入第二份事件流。

## 3 推荐契约 diff（`client-observability-v1`）

### 3.1 O-04 / O-05 / O-07 新增查询

```text
content=metadata | thought      # 默认 metadata
```

- `metadata`：现状不变，thought 只有 `thought: N bytes`。
- `thought`：`event=agent_thought_chunk` 的 `data` 增加：

```json
{
  "acpType": "agent_thought_chunk",
  "text": "……完整思考……",
  "truncated": false,
  "originalBytes": 618
}
```

| 字段 | 规则 |
|---|---|
| `data.text` | UTF-8，单条 ≤16 KiB；超出截断 |
| `data.truncated` | 仅截断时出现，`true` |
| `data.originalBytes` | 仅截断时出现，原始字节数 |
| `message` | 保持 `thought: N bytes`，旧消费者不受影响；新 UI 优先 `data.text` |

- `content=thought` 只影响 `agent_thought_chunk`；message/tool/usage 不变。
- 老数据（升级前写入）没有 `data.text`：返回时省略该字段，UI 显示“本条未保存思考正文”，不回退成 0 字节。
- `content` 非法值 `400 validation_error`；默认 `metadata`。

### 3.2 O-11 不变

`SessionRichEvent.kind="thought"` 已有 `text`（≤16 KiB）与 `truncated`/`originalBytes`（[契约 §12.1](../../design/contracts/client-observability-v1.md)）。O-11 仍是 live 的首选来源；本次只要求 UI 正确渲染 `text` 与按 `kind` 筛选。

### 3.3 存储与保留

- `<stateRoot>/observability/attempts/<id>/events.jsonl` 的 thought 事件增加 `data.text`（≤16 KiB）。
- 单 attempt 事件预算仍为 10 MiB；正文会提前触发截断/淘汰，需在契约中写明。若实际任务经常触顶，再把预算调大或把 thought 文本拆到独立文件（另立 P2）。
- `[observability].thought_text`（建议默认 `true`）：`false` 时不落盘正文，`content=thought` 也返回 metadata；用于敏感环境关闭。
- O-11 仍是内存态，结束/重启后不保留；历史统一走 O-07 + `content=thought`，全文仍可走 O-08 raw。

### 3.4 版本与兼容

- `observabilityVersion` `2026-11-17.1` → `2026-11-18.1`；纯加法，不升协议版本。
- 旧 client：忽略 `content`，返回 metadata；旧 orchestrator：不传 `content`，UI 拿不到正文；旧 UI：显示字节数。
- 发布顺序：client（先落盘正文）→ orchestrator（透传 `content`）→ UI（传查询并渲染）；回滚先回 UI。

## 4 组件改动清单

### 4.1 client

| 文件 | 改动 |
|---|---|
| `src/components/observer/mapper.ts` | `#thought` 的 preview 增加 `data.text`/`truncated`/`originalBytes`（写盘时） |
| `src/components/observer/routes.ts` | O-04/O-05/O-07 解析 `content`，`metadata` 时剥掉 `data.text` |
| `src/components/observer/attempt-store.ts` | 无 schema 变更（`data` 已是自由 JSON）；确认事件大小/截断策略 |
| 配置 | `[observability].thought_text`（默认 `true`） |
| 测试 | mapper 原文/截断、O-04/O-07 的 content 过滤、老数据缺字段 |

### 4.2 orchestrator

| 文件 | 改动 |
|---|---|
| `src/components/observability-client/adapter.ts` | `listEvents` 增加 `content` 参数，原样透传 |
| `src/components/run/client-observability.ts` | `listSessionEvents` 接收并传递 `content` |
| `src/components/http-gateway/routes/run.ts` / `openapi.yaml` | API-51 增加 `content` 查询；描述从“preview”改为“preview；`content=thought` 可含思考正文” |
| 测试 | 透传、默认 metadata、非法值 400 |

`RunSessionEvent.data` 已是自由对象（[OpenAPI:4569](../../../../agent-flow-orchaster/src/components/http-gateway/openapi.yaml)），不需要改 DTO。

### 4.3 UI

| 文件 | 改动 |
|---|---|
| `assets/js/run/data.js` | `listSessionEvents` 增加 `content: 'thought'`（会话视图） |
| `assets/js/run/views/session.js` | `eventText` 增加 `e.text`（rich）；筛选/统计同时匹配 `e.event` 与 `e.kind`；preview thought 优先 `data.text`；截断标记 |
| 测试 | 历史 thought 显示正文；live rich thought 显示正文并进入“思考”筛选；截断标记；无正文时降级文案 |

**形状归一化**：建议 UI 内部做一个 `normalizeEvent()`，把 O-11 rich 映射成视图模型（`event`、`data.text`、`data.tool`、`data.status`），避免每个渲染函数都判断两套形状。是否改由 orchestrator BFF 统一归一化，见 §6 Q3。

## 5 验收与测试

- 历史：完成态 session 的“思考”显示 `data.text`，不再显示 `thought: 618 bytes`；旧数据有降级文案。
- 实时：运行中 O-11 的 thought 进入“思考”筛选并显示 `text`。
- 默认：不带 `content` 的 O-04/O-07 响应与现在逐字节一致（无 `data.text`）。
- 上限：16 KiB 截断时 `truncated=true`、`originalBytes` 正确；raw 仍可下载全文。
- 安全：`content=metadata` 不出现正文；prompt/tool I/O 仍不进入 preview。
- 兼容：旧 UI/orchestrator 不受影响；回滚 UI 后回到字节数展示。

## 6 未决问题（需拍板）

| # | 问题 | 选项/建议 |
|---|---|---|
| Q1 | 单条 thought 上限 | 16 KiB（与 O-11 一致，推荐）；若“全部”必须无上限，只能走 raw 或调大预算 |
| Q2 | 是否默认落盘正文 | 建议默认开 + `thought_text` 开关；敏感环境可关 |
| Q3 | live 形状归一化位置 | UI 内 `normalizeEvent()`（改动小）或 orchestrator BFF 归一化（UI 只认一套形状，推荐长期） |
| Q4 | 是否也开放 message 正文 | 本次只做 thought；message 已有 `assistant message: …` 预览，若要全文另议 |
| Q5 | 10 MiB/attempt 预算是否调整 | 先保持；用真实会话统计 thought 占比后再定 |
