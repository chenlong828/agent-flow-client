---
layer: works
module: global
status: active
updated: 2026-11-17
---

# Client 只读观测面（v2）：以 Session 为中心的 ACP 执行视图

> 修订：2026-11-17 按新优先级重写。v1 以 attempt 索引 + 归一化日志为主；调度层已经有很细的 task/attempt/run 视图，再建一套 attempt 索引价值不大。v2 只解决一件事：**打开一个 session，看这次执行过程中 ACP 反馈出来的丰富信息**。
> v1 留档：[`proposal-v1.md`](proposal-v1.md)（不再作为设计依据）。
> 状态：P1 设计稿 v2，未改 `docs/design/`、未写代码。v1 的 `OB-01`–`OB-09` 评审只覆盖 v1；v2 内容面更大，需要重新评审。
> 2026-11-17 补充：按上游 [`2026-11-17-client-observability`](../../../../agent-flow-orchaster/docs/works/2026-11-17-client-observability/proposal.md) 增加任务级运行文件拉取（`O-09`/`O-10`）与 `runId` 注册表；详细见 §15。attempt 端点仍不纳入 v2。

## 1. 目标

### 1.1 一句话

给调度器/运维一个**只读的 session 视图**：运行中可以实时看，结束后可以回放，原始 DSH 文件可以下载。

### 1.2 具体目标

1. **打开一个 session**：按 `sessionId` 直接看，或从 session 列表按实例/节点/状态/时间找到。
2. **看丰富的 ACP 事件**：prompt、助手正文、思考、工具调用与结果、usage、权限请求/决策、生命周期与停止原因。
3. **运行中实时**：SSE 推送；新事件按 `seq` 到达；支持断线续传。
4. **历史可回放**：分页读取同一份事件流，不依赖实例 home 存活。
5. **原文兜底**：原始 `session.v4.jsonl.zstd` 可下载，包含 system prompt、完整推理、完整工具 I/O。
6. **不影响执行**：观测写入是可丢旁路；不 fsync 执行路径、不阻塞 prompt/心跳、不做控制。
7. **与调度层分工**：调度层负责 task/attempt/run/节点状态；观测面只负责 session 内容，不复制 attempt 索引。
8. **任务级运行文件拉取（补充）**：按 `runId` 只读列出/读取 task-space 与 workspace 的相对路径文件，供调度器/UI 的“运行文件”页使用。

### 1.3 非目标

- **不做 attempt 索引/attempt 列表/attempt 日志**（v1 的 `/attempts*` 不再提供；调度层已有）。
- 不做控制面（claim/cancel/pause/shutdown），不参与租约/心跳/重试/结果上报。
- 不做上传、外发、UI、图表、告警后端、日志聚合。
- 不解析 DSH 原始 session 格式；raw 原样归档/下载。
- 不做多 client 聚合、TLS/mTLS/token 轮换（通道安全另立）；发现只做静态配置 + poll 的 URL 自报（§15.7），不做注册中心。
- 不把 system prompt 从 DSH 文件里解析出来单独展示；raw 里有，事件流不重复。
- 文件拉取不做写入/编辑/上传/删除/终端；不做任意绝对路径、跨 run 读取、递归树、二进制下载；v1 只返回文本前 1 MiB 与文件元数据。

## 2. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **主键是 `sessionId`**，不是 `attemptId` | 调度层已有 task/attempt；观测面的对象是 DSH 会话 |
| D2 | **事件流内容化**：保存 message/thought/tool/prompt 的文本（有上限） | 只看工具名/状态无法回答“具体做了什么” |
| D3 | **实时 + 历史同一份事件模型** | SSE 与分页查询读同一 `events.jsonl`，避免两套解析 |
| D4 | **session 列表最小化**：只做发现，不做 attempt 复刻 | 列表字段只到 session 元数据；不出现 attempt 状态机 |
| D5 | **默认 `content_level=full`，`bind=127.0.0.1`** | 内容面大，先保证本机可看；跨机显式开 token/bind |
| D6 | **观测写入是可丢旁路** | 内存队列 + 批量落盘；溢出丢弃；不影响执行 |
| D7 | **原始文件单独承担全文** | 事件流有 16 KiB/事件上限；raw 保完整 |
| D8 | **文件拉取按 `runId` + 注册表**，调用方只传相对路径 | 不接受绝对路径；可读范围锁在该 run 的 workspace/task-space |
| D9 | **文件端点沿用上游 `O-09`/`O-10`** | 与 orchestrator 交接稿路径一致；session 端点仍用 S-* |
| D10 | **发现用静态配置 + loopback 自报** | `X-Observability-Url` 只报 URL 不报 token；适配器做 SSRF 校验 |
| D11 | **默认 loopback；非 loopback 必须 token；`required=false` 降级** | 文件面扩大暴露面；观测面启动失败不能拖垮执行 |

## 3. 端点

基础路径：`/api/v1/observability`；JSON UTF-8，camelCase，ISO-8601 UTC。

| ID | 方法/路径 | 用途 |
|---|---|---|
| `S-01` | `GET /health` | 存活、版本、活跃 session 数、保留 session 数 |
| `S-02` | `GET /sessions` | 列出 session（运行中 + 历史），用于发现/选择 |
| `S-03` | `GET /sessions/{sessionId}` | session 元数据 + 计数 + 归档状态 |
| `S-04` | `GET /sessions/{sessionId}/events` | 分页读取丰富 ACP 事件 |
| `S-05` | `GET /sessions/{sessionId}/events/stream` | SSE 实时事件流 |
| `S-06` | `GET /sessions/{sessionId}/raw` | 原始 `session.v4.jsonl.zstd` 下载 |
| `O-09` | `GET /runs/{runId}/files` | 运行文件列表（run-scoped，一层） |
| `O-10` | `GET /runs/{runId}/files/content` | 运行文件内容（文本/元数据） |

> v1 的 `O-02`/`O-03`/`O-04`/`O-05`（`/attempts*`）在 v2 中**删除**，不提供兼容别名；v1 未实现、无消费者。若未来确实需要 attempt 视角，另立轻量查询，不进入本提案主路径。
> 编号说明：`S-01`–`S-06` 是 v2 的 session 面；`O-09`/`O-10` 沿用上游交接稿，避免跨项目再改路径。两套编号不冲突，路径才是契约。

### 3.1 `S-01` `GET /health`

```json
{
  "status": "ok",
  "observabilityVersion": "2026-11-17.1",
  "clientVersion": "0.1.0",
  "startedAt": "2026-11-17T09:00:00Z",
  "uptimeMs": 123456,
  "activeSessions": 1,
  "retainedSessions": 35,
  "registeredRuns": 12,
  "filesEnabled": true,
  "authRequired": false,
  "contentLevel": "full"
}
```

- `status`：`ok` / `degraded`（事件写盘持续失败或归档失败）。
- 不返回路径、配置、凭据。

### 3.2 `S-02` `GET /sessions`

查询参数：

| 参数 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `instanceId` | UUID | — | 过滤实例 |
| `nodeId` | string（1..64） | — | 过滤节点；当前实现为 `n1`/`n3` 这类工作流节点 ID |
| `taskId` | UUID | — | 可选关联过滤 |
| `status` | enum | — | `running` / `interrupted` / `completed` / `failed` / `cancelled` / `timeout` |
| `from` / `to` | ISO-8601 | — | 按 `startedAt` 过滤 |
| `limit` | 1..200 | 50 | 条数 |
| `cursor` | string | — | 上一页 `nextCursor` |

响应：

```json
{
  "items": [
    {
      "sessionId": "0ae3227a-…",
      "status": "running",
      "cwd": "/abs/instance-a",
      "instanceId": "0193f0aa-…",
      "nodeId": "n3",
      "runId": "01a1daa7-…",
      "taskId": "01a1daa8-…",
      "attempt": 1,
      "startedAt": "2026-11-17T09:35:43Z",
      "finishedAt": null,
      "lastEventAt": "2026-11-17T09:35:57Z",
      "durationMs": null,
      "eventCount": 24,
      "messageCount": 4,
      "thoughtCount": 3,
      "toolCount": 6,
      "archive": { "status": "pending", "sizeBytes": null, "sha256": null }
    }
  ],
  "nextCursor": "…"
}
```

- `archive.status`：`pending` / `stored` / `partial` / `failed`。
- 排序：运行中置顶，其余按 `startedAt` 降序。
- 列表只回答“有哪些 session 可以打开”，不承担 attempt 状态机。
- `instanceId/nodeId/taskId/attempt` 是**可选关联字段**，用于和调度层对齐；不作为路由主键，不要求调度层反查。
- `status=interrupted`：client 重启后发现的未收口 session（见 §6.4）。

### 3.3 `S-03` `GET /sessions/{sessionId}`

```json
{
  "sessionId": "0ae3227a-…",
  "status": "completed",
  "cwd": "/abs/instance-a",
  "instanceId": "0193f0aa-…",
  "nodeId": "n3",
  "runId": "01a1daa7-…",
  "taskId": "01a1daa8-…",
  "attempt": 1,
  "startedAt": "2026-11-17T09:35:43Z",
  "finishedAt": "2026-11-17T09:35:57Z",
  "durationMs": 14800,
  "eventCount": 24,
  "counts": { "message": 4, "thought": 3, "tool": 6, "usage": 5, "permission": 2 },
  "contentLevel": "full",
  "archive": {
    "status": "stored",
    "sizeBytes": 123456,
    "sha256": "sha256:…",
    "downloadUrl": "/api/v1/observability/sessions/0ae3227a-…/raw"
  }
}
```

- 无归档（未结束/归档失败）时 `archive.status` 为 `pending`/`failed`，`downloadUrl=null`。
- session 不存在：`404 session_not_found`；已清理：`410 observation_gone`。

### 3.4 `S-04` `GET /sessions/{sessionId}/events`

查询参数：

| 参数 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `afterSeq` | int | — | 返回 seq > afterSeq 的事件（向后翻页/追新） |
| `beforeSeq` | int | — | 返回 seq < beforeSeq 的事件（向前翻旧） |
| `limit` | 1..500 | 100 | 条数 |
| `kind` | enum | — | `lifecycle` / `prompt` / `message` / `thought` / `tool_call` / `tool_result` / `usage` / `permission` / `config` / `other` |

`afterSeq` 与 `beforeSeq` 互斥；都缺省时返回最新一页。

响应：

```json
{
  "items": [ { "seq": 1, "ts": "…", "sessionId": "…", "kind": "message", "messageId": "…", "text": "…" } ],
  "nextAfterSeq": 101,
  "nextBeforeSeq": 1,
  "truncatedBefore": null
}
```

- `truncatedBefore`：保留策略/单 session 上限截断时，最早可用 seq；查询更早返回该值。
- 事件内容按 §4 上限截断，`truncated`/`originalBytes` 标在事件上。
- 不返回 system prompt；prompt 事件只含本次 `session/prompt` 的文本（截断）。

### 3.5 `S-05` `GET /sessions/{sessionId}/events/stream`

请求头：`Accept: text/event-stream`；可选 `Last-Event-ID: <seq>`。

```text
event: snapshot
id: 24
data: {"events":[…最近最多200条…],"truncatedBefore":null}

event: event
id: 25
data: {"seq":25,"kind":"message",…}

event: heartbeat
data: {"ts":"…"}

event: end
data: {"status":"completed","finishedAt":"…"}
```

- 建连先发 `snapshot`（最近最多 200 条；`Last-Event-ID` 在保留范围内则从 seq+1 补发，超出范围 `reset=true`）。
- 之后每条新事件一条 `event`，`id=seq`；每 15s 一条 heartbeat。
- session 已结束：`snapshot` + `end` 后关闭。
- 慢消费者：内存队列 1000；超过发 `event: error`（`slow_consumer`）并关闭，不阻塞写盘。
- 并发流上限 `maxStreams`（默认 20，按 client 全局，不是 per-session）；超限 `429 rate_limited`。

### 3.6 `S-06` `GET /sessions/{sessionId}/raw`

- `200 application/zstd`：`Content-Disposition: attachment; filename="<sessionId>.jsonl.zstd"`，`Content-Length`、`ETag`、`X-Checksum-Sha256`、`Accept-Ranges: bytes`（Range 可选）。
- `409 archive_not_ready`：session 仍活跃或归档未完成。
- `404 session_not_found`：从未存在。
- `410 observation_gone`：已按保留策略清理。
- `403 raw_disabled`：配置关闭。
- 只读；不解析内容；raw 访问写审计。


### 3.7 `O-09` / `O-10` 运行文件（补充）

文件端点按 `runId` 定位，不是 session；完整契约、限制、错误码见 **§15**。

```http
GET /api/v1/observability/runs/<runId>/files?root=task-space&path=reports
GET /api/v1/observability/runs/<runId>/files/content?root=task-space&path=reports/design.md
```

- 根只有 `task-space`（默认）/`workspace`；`path` 是相对 POSIX 路径，调用方不能传绝对路径。
- 列表一层、目录优先；内容只读文本前 1 MiB；二进制只给元数据；不做下载/写入。
- `runId` 来自 `TaskRequest.runId` + client 运行注册表；无注册表 → `404 run_not_found`，已清理 → `410 run_gone`。

## 4. 事件模型

### 4.1 `SessionEvent`

```ts
type SessionEvent = {
  seq: number;                 // per session，从 1 单调递增
  ts: string;                  // ISO-8601
  sessionId: string;
  kind: "lifecycle" | "prompt" | "message" | "thought" | "tool_call" | "tool_result" | "usage" | "permission" | "config" | "other";
  acpType?: string;            // 未映射的 ACP sessionUpdate 原值（kind=other 时）
  messageId?: string;
  toolCallId?: string;
  lifecycle?: "session.started" | "prompt.result" | "session.closed";
  text?: string;               // prompt / message / thought；≤maxEventContentBytes
  tool?: {
    name: string;
    status: "in_progress" | "completed" | "failed";
    input?: unknown;           // rawInput 原样（≤上限）；write 的 content 也在内
    output?: string;           // tool_call_update.content 的文本拼接（≤上限）
    durationMs?: number;
  };
  usage?: { used: number; size: number };
  permission?: {
    tool?: { name?: string; inputSummary?: string };  // 由 runtime 关联 toolCallId 补齐
    options: { kind: string; name: string }[];
    decision?: "allow" | "reject";
  };
  stopReason?: string;
  error?: { class?: string; code: string; message: string };
  data?: Record<string, unknown>;   // lifecycle 的上下文；白名单字段
  truncated?: boolean;
  originalBytes?: number;
};
```

### 4.2 各类事件的实际形态

**lifecycle**

```json
{ "seq": 1, "kind": "lifecycle", "lifecycle": "session.started",
  "ts": "…", "sessionId": "…", "data": { "cwd": "/abs/…", "instanceId": "…", "nodeId": "n3" } }
```

```json
{ "seq": 23, "kind": "lifecycle", "lifecycle": "prompt.result",
  "stopReason": "end_turn", "usage": { "used": 6979, "size": 1000000 } }
```

```json
{ "seq": 24, "kind": "lifecycle", "lifecycle": "session.closed" }
```

**prompt**（本次 `session/prompt` 的输入；不是 ACP update，但属于 session 执行事实）

```json
{ "seq": 2, "kind": "prompt",
  "text": "请实际执行一个多步骤文件任务……", "truncated": true, "originalBytes": 421 }
```

- `content_level=full` 才带 text；`metadata` 只留 `originalBytes`，不带正文。
- 完整 prompt 仍在 raw 的 user message 里。

**message / thought**

```json
{ "seq": 3, "kind": "message", "messageId": "e9bad8e7-…",
  "text": "我会直接按照这个多步骤任务执行。" }
```

```json
{ "seq": 6, "kind": "thought", "messageId": "326a17fc-…",
  "text": "The sandbox backend is not usable. Approval prompts enabled…",
  "truncated": false }
```

**tool_call**

```json
{ "seq": 4, "kind": "tool_call", "toolCallId": "call_00_ET_…",
  "tool": { "name": "bash", "status": "in_progress",
            "input": { "command": "mkdir -p out && printf 'alpha' > out/a.txt …",
                       "description": "Create out dir and two text files" } } }
```

**tool_result**

```json
{ "seq": 7, "kind": "tool_result", "toolCallId": "call_00_ET_…",
  "tool": { "name": "bash", "status": "completed",
            "output": "total 24\ndrwxr-xr-x@ 5 …", "durationMs": 25 } }
```

- 失败时 `status:"failed"`，`output` 是错误文本。
- `write`/`edit` 的 `input.content` 可能很大，按 `maxEventContentBytes` 截断并标 `truncated`；完整内容看 raw。
- `tool_result.output` 是 `tool_call_update.content` 中 text 块的拼接；图片等非文本内容只记类型/计数。

**usage**

```json
{ "seq": 8, "kind": "usage", "usage": { "used": 5913, "size": 1000000 } }
```

**config / other**

```json
{ "seq": 10, "kind": "config", "acpType": "config_option_update",
  "data": { "configOptions": [ { "id": "model", "currentValue": "[\"hundsun-public\",\"hs-deepseek-flash-latest\"]" } ] } }
```

```json
{ "seq": 11, "kind": "other", "acpType": "plan",
  "data": { "entries": [ { "content": "…", "status": "in_progress" } ] }, "truncated": false }
```

- `config_option_update` 归 `config`；未来出现的 `plan`/`available_commands_update`/`current_mode_update` 等未知类型归 `other`，保留 `acpType` 与截断后的 `data`，不静默丢弃。

**permission**

```json
{ "seq": 9, "kind": "permission", "toolCallId": "call_00_uVSB…",
  "permission": {
    "tool": { "name": "bash", "inputSummary": "cat out/a.txt out/b.txt > out/combined.txt" },
    "options": [ { "kind": "allow_once", "name": "Allow once" },
                 { "kind": "reject_once", "name": "Reject" } ],
    "decision": "allow"
  } }
```

- 关键：`session/request_permission` 本身只有 `toolCallId`；runtime 在写事件时用内存里的 tool 表补齐 `name`/`inputSummary`，UI 才能显示“在申请执行什么”。
- 本 client 静态策略立即应答，`decision` 在请求后马上写入；将来交互式审批可先发无 decision 的事件，再补决策事件。

### 4.3 内容级别与上限

| 级别 | 内容 | 用途 |
|---|---|---|
| `full`（默认） | prompt/message/thought 文本；tool input/output；permission 关联信息 | 正常观测/排障 |
| `metadata` | 只保留类型、名称、状态、计数、错误码；不保留 prompt/文本/tool I/O | 受控网络、只关心轨迹 |

上限：

| 常量 | 值 | 说明 |
|---|---|---|
| `maxEventContentBytes` | 16384 | 单个 text/tool input/output/prompt 文本 |
| `maxSessionContentBytes` | 67108864 | 单 session `events.jsonl` 上限 |
| `maxPromptEventBytes` | 16384 | prompt 事件正文 |
| `maxEventsPerPage` | 500 | S-04 |
| `sseSnapshotMax` | 200 | S-05 snapshot |
| `sseStreamQueue` | 1000 | 慢消费者 |
| `maxStreams` | 20（全局） | S-05 |

- 超限统一 `truncated=true` + `originalBytes`；不要静默截断。
- 事件流不是全文仓库；全文在 raw。

## 5. 存储与写入

### 5.1 布局

```text
<stateRoot>/observability/
  sessions/<sessionId>/
    meta.json
    events.jsonl
    session.v4.jsonl.zstd
<stateRoot>/runs/<runId>.json        # 运行注册表，见 §15.2
```

- `meta.json`：session 元数据、计数、archive 状态、`layoutVersion`。
- `events.jsonl`：一行一个 `SessionEvent`，`seq` 单调。
- `session.v4.jsonl.zstd`：DSH 原始文件原样复制（文件名以 DSH 实际为准，meta 记 `sourceFile`）。

### 5.2 谁写谁读

| 文件 | 唯一写者 | 读者 |
|---|---|---|
| `meta.json` | `CMP-observability` 的 `SessionObservationStore` | 观测 HTTP |
| `events.jsonl` | `CMP-observability` 的 `SessionObservationStore` | 观测 HTTP |
| `session.v4.jsonl.zstd` | `CMP-runtime`（session 关闭后复制） | 观测 HTTP（只读） |

- runtime **不直接写** `meta.json`/`events.jsonl`；它通过组合根注入的回调把 `SessionEventInput` 交给 store，把 archive 信息交给 store。
- store 是 meta/events 的唯一写入口；raw 文件是 runtime 的唯一写入口；两者通过文件契约与 `attachArchive` 关联。
- 不允许两个组件同时写同一个 JSON 文件；不允许 HTTP 层直接读实例 home。

### 5.3 写入路径

- runtime 收到 `session/update` → 归一化为 `SessionEventInput` → 回调 `onSessionEvent` → store：
  1. 分配 `seq`；
  2. 立即广播给 SSE 订阅者；
  3. 入内存队列，后台按批（100 条/200ms）追加 `events.jsonl`。
- 执行路径不 `fsync`、不做同步磁盘 I/O；队列 10,000 条，溢出按 kind 计数丢弃并告警。
- 进程退出前 flush ≤2s；超时记 `dropped_on_exit`。
- session 关闭后 runtime 复制 raw → 计算 sha256 → 回调 `attachArchive` → store 原子更新 `meta.json`。
- 只有持续 3 批写失败才把 `health.status` 置 `degraded`；单次失败丢事件，不影响执行。

### 5.4 保留与清理

| 配置 | 默认 | 语义 |
|---|---|---|
| `retentionDays` | 7 | 结束超过 N 天删除 |
| `maxBytes` | 1 GiB | 超限按 `finishedAt` 最旧删除 |
| `maxSessionContentBytes` | 64 MiB | 单 session 事件上限；超过截断并记 `truncatedBefore` |

- 只清理已结束 session；活跃永不清理。
- 清理前必须已有 raw 归档（或明确 `raw_enabled=false`）；归档失败不删实例 home。
- 清理后保留 tombstone：`410 observation_gone`；从未存在才是 `404 session_not_found`。
- 崩溃恢复：启动扫 `sessions/*/meta.json` 中 `status=running` 的条目，标为 `interrupted`；有 raw 无 meta 的目录按 `partial` 建档；实例 home 中未归档的 session 尝试补归档。

## 6. 组件与依赖

### 6.1 方案

**补充文件端点后改为方案 B：新增 `CMP-observer` L0。**

v2 初稿推荐扩展 `CMP-observability`（方案 A）；加入运行文件拉取后，A 不再合适：

- 文件读取需要触达 `CMP-workspace`（只读目录/文件），HTTP/SSE 需要触达 `CMP-runtime` 的 session 归档、`CMP-store` 的 run 注册表；这些都超出 `CMP-observability` 现行「不负责进程/文件/网络、不读 journal/工作区」的边界。
- `CMP-observability` 继续管日志/doctor/session 事件存储；HTTP/查询/文件由新 L0 `CMP-observer` 承担，符合上游提案推荐，也符合 `OB-04` 的拆分触发。

组件职责：

| 单元 | 职责 | 数据 |
|---|---|---|
| `CMP-observer`（新 L0） | HTTP 路由、鉴权、SSE、查询编排、`O-09`/`O-10` 文件端点 | 无持久化 |
| `CMP-observability` | 日志/脱敏/doctor、`SessionObservationStore`（meta/events） | `<stateRoot>/observability/sessions/*/{meta,events}` |
| `CMP-runtime` | ACP 事件归一化（回调）、raw session 归档 | `<stateRoot>/observability/sessions/*/session.v4.jsonl.zstd` |
| `CMP-store` | run 注册表 `<stateRoot>/runs/<runId>.json`；journal 扩展 | run 映射 |
| `CMP-workspace` | 只读 `listDir`/`readText`，复用路径约束 | 工作区文件（只读） |
| `CMP-executor` | 任务接收/归档时写 run 注册表 | 运行时状态 |
| `CMP-cli` | 组合根：启动 observer、注入端口/配置、接线回调 | 无 |

- `CMP-observer` 只依赖只读端口：`ObservationQuery`、`RunDirectory`、`RunFileReader`、`SessionArchiveReader`；端口由 CLI 注入，L0 之间不 import 具体实现。
- `CMP-observability` 仍是 session 事件/meta 的唯一写入口；`CMP-runtime` 仍是 raw 的唯一写入口；`CMP-store` 是 run 注册表的唯一写入口。
- 方案 A（扩展 `CMP-observability`）保留为后备：只有放弃文件端点、且端点 ≤6 时才考虑。

### 6.2 依赖与调用

```text
CMP-cli（组合根）
  ├─ 启动 CMP-observer（HTTP）
  ├─ 注入 ObservationQuery / RunDirectory / RunFileReader / SessionArchiveReader
  ├─ 把 CMP-runtime.onSessionEvent ──▶ CMP-observability.store.ingest
  ├─ 把 CMP-runtime.onSessionArchive ──▶ CMP-observability.store.attachArchive
  └─ 把 CMP-executor 的 runId/paths ──▶ CMP-store 注册表
CMP-observer ── 只读 ──▶ CMP-observability（events/meta）、CMP-store（run）、CMP-workspace（files）、CMP-runtime（raw）
CMP-runtime ── 写 ──▶ sessions/*/session.v4.jsonl.zstd
CMP-observability ── 写 ──▶ sessions/*/meta.json、events.jsonl
CMP-store ── 写 ──▶ runs/<runId>.json
```

- 禁止：`CMP-observer` import CLI/executor；`CMP-runtime` import observability 的具体实现；HTTP 层读 journal/工作区（必须经 `RunDirectory`/`RunFileReader` 端口）。
- runtime 只依赖回调类型（结构化 `SessionEventInput`），不依赖观测组件；组合根负责接线。
- 数据所有权：meta/events 归 `CMP-observability`；raw 归 `CMP-runtime`；run 注册表归 `CMP-store`；文件只读，不落库。

### 6.3 预算

- `CMP-observer` 目标 ≤60k / 上限 120k；`CMP-observability` 目标 ≤15k / 上限 120k（回落到日志/事件存储职责）。
- 端点已到 8 个（S-01–S-06 + O-09/O-10）；超过 12 个再拆子模块，不拆第二个 HTTP 宿主。

### 6.4 状态与恢复

- session 状态：`running`（活跃）/ `interrupted`（进程重启后发现未收口）/ `completed` / `failed` / `cancelled` / `timeout`。
- 启动时把残留 `running` 改 `interrupted`；不伪造结束时间；事件流保留到最后一条。
- 归档失败：`archive.status=failed`，raw 不可下载，`meta` 保留；不阻塞新任务。

## 7. 与调度层/UI 的分工

| 关注点 | 调度层 | 观测面 |
|---|---|---|
| task/attempt/run/节点状态 | 已有，权威 | 不复刻 |
| attempt 重试/排队/派发 | 已有 | 不参与 |
| session 执行内容 | 只知道 sessionId/结果 | **权威视图** |
| 打开方式 | run/节点详情带 sessionId 链接 | `GET /sessions/{id}` 或列表 |
| 实时性 | 5s/30s 状态 | 事件级 SSE |
| 全文 | 不存/不传 | raw 下载 |
| 运行文件 | 知道 runId/workspace/task-space | `O-09`/`O-10` 只读列表/内容 |
| 发现 | 下发任务、持有 client 凭据 | 静态 URL + `X-Observability-Url` 自报 |

需要调度层配合的两点：

1. **把 `sessionId` 暴露到 run 节点视图**（结果里已有 `TaskResult.sessionId`，但当前 `RunNodeView` 没有）。这是调度侧改动，不属于本提案；本提案提供 `S-02` 列表作为兜底发现方式。
2. **在 `TaskRequest` 带 `runId`**，并在 poll 读 `X-Observability-Url`（§15.9）。调度层已有 runId，无需新表；client 只用来定位 run 的 workspace/task-space。

## 8. 安全

- 只读 GET；无 POST/PUT/PATCH/DELETE；不提供任意绝对文件路径；文件端点只接受 run-scoped 相对路径（§15）。
- v2 事件流含 prompt/正文/思考/工具 I/O，敏感面显著大于 v1；`content_level=metadata` 可降级。
- 默认建议：
  - `bind=127.0.0.1`，`token` 可选；
  - 非 loopback 必须配置 token，且显式确认 `content_level=full`；
  - `raw_enabled` 默认 true，但仅限受控网络/已鉴权；
  - 访问 raw 与 SSE 写审计（requestId/sessionId/remote/action）；`Cache-Control: no-store`、`nosniff`、不做 CORS。
- 脱敏：日志/事件中的凭据键（`authorization|cookie|token|secret|password|api key|credential|private key`）替换；但 full 模式下文本/工具内容仍可能含敏感数据，**不是脱敏保证**。
- 信任面反转：调度器/持 token 者可读所有已接入 client 的会话内容；v1 的 OB-01（明文 + 静态 token + raw）风险在 v2 更严重，必须重新确认。
- v2 不提供 TLS/mTLS/轮换；跨机用 SSH 隧道/反代或后续特性。
- 文件端点进一步扩大暴露面：run-scoped 只读、相对路径、禁绝对路径/跨 run/符号链接逃逸；默认 loopback；非 loopback 必须 token；访问审计（runId/root/path/bytes/结果码/remote），不记录文件内容。
- v1 复用 executor client token；不新增秘密。自报 URL 只报地址不报 token；调度器适配器必须做 SSRF 校验（静态优先、禁重定向、超时、响应上限）。

## 9. 失败与降级

| 场景 | 行为 |
|---|---|
| HTTP 端口被占 | `serve` 启动失败，退出 4；不影响 `run` |
| 事件队列溢出 | 丢弃并计数；执行/心跳不受影响；`health` 可 `degraded` |
| 事件写盘持续失败 | 丢事件；已有事件仍可读；告警 |
| raw 归档失败 | `archive=failed`；raw 409/503；不删实例 home；不阻塞任务 |
| SSE 慢消费者 | 队列满发 `slow_consumer` 并关闭；不影响写盘/执行 |
| session 崩溃/重启 | 残留 `running` 标 `interrupted`；partial 归档可下载；不伪造完成 |
| 保留清理与查询并发 | 返回 410 或空；不返回半文件 |
| session 已结束但请求流 | snapshot + end 后关闭 |
| 无 session 的早失败 | 不在观测面出现；调度层已有失败记录 |
| 观测面 bind 失败 | `required=false` 记 `observability_disabled`，serve 继续；文件/观测端点不可用，任务不受影响 |
| run 未注册/已清理 | `404 run_not_found` / `410 run_gone`；任务不受影响 |
| 文件路径逃逸/符号链接 | `400 path_escape` / `415 unsupported_file`；不返回内容 |
| 文件读取慢/权限不足 | 异步 FS + 5s 适配器超时；`403 file_permission_denied`；不阻塞 poll/SSE |
| 二进制/超大文件 | 二进制给元数据；文本截断 1 MiB；`truncated` |

## 10. 版本与兼容

- 观测 API 独立版本 `observabilityVersion = "2026-11-17.1"`；与调度器 `protocolVersion` 解耦。v2 端点集：`S-01`–`S-06` + `O-09`/`O-10`；不提供 `/attempts*`。
- v1 的 `/attempts*` 未实现、无消费者，v2 不提供兼容别名；如果以后要 attempt 视角，另加只读查询，不复用 `attemptId` 主键。
- raw 文件格式由 DSH 决定，不是稳定契约；client 只保证原样归档/下载。
- 事件 schema 加法兼容；删除字段/改语义升版本。
- `content_level` 变化不改变端点语义，只改变内容可用性。

## 11. 验收

1. **运行中 session**：`S-05` 能看到 prompt、message、thought、tool_call/tool_result、usage、permission、lifecycle；工具执行结束几秒内可见。
2. **历史 session**：`S-04` 能按 `afterSeq/beforeSeq` 翻页；事件顺序与 SSE 一致。
3. **发现**：`S-02` 按 instance/node/status/time 能找到运行中与历史 session。
4. **原文**：session 结束后 `S-06` 可下载；sha256/长度正确；未归档 409；清理后 410。
5. **内容级别**：`metadata` 下不含 prompt/文本/tool I/O；`full` 下有且截断标记正确。
6. **上限**：单事件 16 KiB、单 session 64 MiB；超限 `truncated`/`truncatedBefore`。
7. **SSE**：snapshot、Last-Event-ID 续传、heartbeat、end、慢消费者、maxStreams 429。
8. **低干扰**：事件写盘/SSE 不阻塞 prompt、心跳、结果上报；队列溢出只丢观测。
9. **恢复**：重启后 running → interrupted；partial 归档可读；实例 home 清理前必须归档。
10. **安全**：token/loopback/raw 开关/审计/脱敏按配置生效；无控制面动词。
11. **运行文件**：`O-09`/`O-10` 正常/截断/二进制/目录/缺失/路径逃逸/符号链接/权限；文件读不阻塞 poll/SSE。
12. **run 注册表**：task runId upsert、archive upsert、重启重建、保留 410、未知 404。
13. **发现/鉴权**：loopback 无 token、非 loopback 拒绝、token 正确/错误、`X-Observability-Url`/静态配置/非法 URL。
14. **降级**：bind 失败 `required=false` 不杀 serve；client 离线时调度器 504，任务不受影响。

## 12. 待确认

| # | 问题 | 建议 |
|---|---|---|
| Q1 | `content_level` 默认 `full` 还是 `metadata`？ | `full`（本提案目的）；非 loopback 强制 token |
| Q2 | thought 是否默认进事件流？ | 进（`full`）；如合规要求可加 `thought_enabled=false` |
| Q3 | prompt 是否进事件流？ | 进（截断 16 KiB）；完整在 raw |
| Q4 | 默认 bind 改 `127.0.0.1`？ | 建议改；跨机显式开 token/bind，需产品确认（推翻 v1 OB-01 默认） |
| Q5 | raw_enabled 默认？ | true（loopback/token 前提）；受控网络可关 |
| Q6 | session 列表是否需要，还是只靠调度层给 sessionId？ | 保留 S-02 作为发现兜底 |
| Q7 | `attempt`/`taskId` 关联字段是否要？ | 可选保留，仅用于对齐；不做 attempt 索引 |
| Q8 | 保留窗口/单 session 上限？ | 7 天 / 1 GiB / 64 MiB，按实测调整 |
| Q9 | 是否接受 `TaskRequest.runId` 可选 + run 注册表？ | 接受；manual task 无文件端点 |
| Q10 | 文件限制 2000/1 MiB/5s/2 MiB、一层、不做下载？ | 沿用上游 |
| Q11 | 默认 bind 改 loopback、非 loopback 强制 token、`required=false`？ | 接受；需产品确认 |
| Q12 | 复用 executor token？ | v1 接受；独立 token 后置 |
| Q13 | 自报 URL 只限 loopback/开发期？ | 静态优先，自报仅 loopback |
| Q14 | run 注册表保留 7 天/30 天、任务空间不删？ | 接受 |
| Q15 | 上游是否接受不实现 attempt 端点、session 事件 rich？ | 需双方对齐；见 §15.11 |

## 13. 实施任务（确认后）

| ID | 内容 | 依赖 |
|---|---|---|
| T1 | 契约：S-01–S-06、`SessionEvent`、上限、错误码、版本 | Q1–Q8 |
| T2 | `CMP-runtime`：ACP 归一化、`onSessionEvent`/`onSessionArchive`、raw 归档 | T1 |
| T3 | `CMP-observability`：`SessionObservationStore`、`SessionEventHub`、保留/恢复 | T1 |
| T4 | `ObservationHttpServer`：S-01–S-06、SSE、鉴权/审计 | T3 |
| T5 | `CMP-cli`：配置、组合根接线、启停 | T2/T3/T4 |
| T6 | 测试：事件 schema、SSE 续传、慢消费者、上限、归档、重启、安全 | T2–T5 |
| T7 | 文档：回填 `architecture.md`、`CMP-observability`、`CMP-runtime`、`CMP-cli` | T6 |
| T8 | run 注册表：`TaskRequest.runId`、`CMP-store` 写入/重建、`CMP-executor` 接线 | T1 |
| T9 | 文件端点：`CMP-observer` 的 `O-09`/`O-10`、`CMP-workspace` 只读读取、错误/限制 | T1/T8 |
| T10 | 发现/鉴权/降级：`X-Observability-Url`、静态配置、bind/token/required | T4 |
| T11 | orchestrator 适配器与产品 API 接线（跨仓库，另立工序） | T9/T10 |

## 14. 与 v1 的差异

| 项 | v1 | v2 |
|---|---|---|
| 主对象 | attempt 索引 + 日志 | **session 内容** |
| 主键 | `attemptId`（uuid-v7） | `sessionId` |
| 列表 | `/attempts` | `/sessions`（只做发现） |
| 事件 | `ObservationEvent`，`kind=acp` 只是预览；不写 prompt/推理/tool I/O | `SessionEvent`，full 模式写文本/工具输入输出/prompt |
| 实时 | attempt 日志 SSE | session 事件 SSE |
| 全文 | raw | raw（不变） |
| attempt 状态机 | 有（phase/log） | 无；交给调度层 |
| 文件拉取 | 无 | `O-09`/`O-10`，run-scoped 相对路径 |
| run 身份 | 无 | `TaskRequest.runId` + `runs/<runId>.json` |
| 组件 | 扩展 `CMP-observability` | 新增 `CMP-observer`（B） |
| 发现 | 静态配置 | 静态优先 + `X-Observability-Url`（loopback/受控） |
| 安全默认 | `0.0.0.0` + 可选 token | `127.0.0.1` + 非 loopback 强制 token（待确认） |

## 15. 补充：任务级运行文件拉取（O-09/O-10）

> 来源：上游 [`2026-11-17-client-observability`](../../../../agent-flow-orchaster/docs/works/2026-11-17-client-observability/proposal.md)。本节把“按 run 看文件”补进 client 观测面；文件端点沿用上游 `O-09`/`O-10`。

### 15.1 目标与边界

**目标**

1. 调度器/UI 用 `runId` 直接向 client 要**运行文件列表**与**文件内容**，替代 poll 反向文件请求。
2. 只读、run-scoped、相对路径；可读范围是该 run 的 `task-space`（默认）或 `workspace`。
3. 运行中可读，文件变化读到当前内容；不做一致性快照。
4. 文件读取失败/观测面不可达**不影响任务执行**。

**边界**

- 不做写入/编辑/上传/删除/终端；不做任意绝对路径、跨 run、递归树。
- v1 不做二进制下载/预览；二进制只返回元数据。
- 不做文件内容缓存；`no-store`；不记录内容日志。
- 不做运行结束后的服务端归档浏览（上游 `OQ-34`）。

### 15.2 `runId` 与运行注册表

**`TaskRequest.runId`（可选）**

- 执行面 `executor-http-v3` 加法字段：`runId?: string`；手工注入/无 run 归属的任务没有该字段，任务照常执行，只是文件端点不可用。
- 不升 `X-Executor-Protocol`；旧 client 忽略；旧 orchestrator 不发。
- 上游在 poll 组装时用 `run_node.task_id` 反查 `runId`；client 不解析 run 结构，只把 `runId` 当不透明字符串。

**注册表**

```ts
type RunRecord = {
  runId: string;
  instanceId: string;
  workspacePath: string;   // 绝对路径
  taskSpacePath: string;   // 绝对路径
  firstSeenAt: string;
  updatedAt: string;
  archivedAt?: string;
};
```

- 存储：`<stateRoot>/runs/<runId>.json`；临时文件 + rename 原子写；`CMP-store` 是唯一写入口。
- 写入时机：
  1. 收到带 `runId` 的 `TaskRequest`，在**启动 session 前** upsert；
  2. `ArchiveRequest`（`runId` + 两个路径）到达时 upsert/刷新，写 `archivedAt`；
  3. 同一 run 重派/重跑只更新 `updatedAt`（路径由 `S-05` 保证不变）。
- 重建：`TaskRecord` 增可选 `runId`/`workspacePath`/`taskSpacePath`；启动时若 `runs/` 缺失，从 journal 重建；旧 journal 行缺字段时跳过。
- 保留：
  - 活跃任务对应的 run 永不清理；
  - 已归档 run 从 `archivedAt` 起按观测保留期（默认 7 天）清理；
  - 未归档 run 用 30 天兜底（按 `updatedAt`）；
  - 清理只删注册表，不删 task-space/workspace 文件；端点返回 `410 run_gone`。
- 未知 run：`404 run_not_found`；已清理：`410 run_gone`。

### 15.3 路径模型

- `root`：`task-space`（默认）/ `workspace`。
- `path`：相对 POSIX 路径；`""` 表示根。
- 拒绝：`..`、`.`/空段、绝对路径、反斜杠、NUL；长度 ≤1024 字符、段数 ≤64。
- 根由 client 从注册表取；调用方**不能传绝对路径**，也不能指定别的 run。
- 列表只返回一层；UI 展开子目录再请求；不返回递归树。
- 符号链接：列表标 `symlink`；读取拒绝符号链接；`realpath` 必须仍在根内。
- 文件读取不写盘、不缓存；不做一致性快照。

### 15.4 `O-09` 列表

```http
GET /api/v1/observability/runs/<runId>/files?root=task-space&path=reports
```

| 参数 | 必填 | 规则 |
|---|---|---|
| `root` | 否 | `task-space`（默认）/ `workspace` |
| `path` | 否 | 相对路径；`""` 根 |

响应 `200`：

```json
{
  "runId": "01a1daa7-…",
  "root": "task-space",
  "path": "reports",
  "entries": [
    { "name": "design.md", "type": "file", "sizeBytes": 2048, "modifiedAt": "2026-11-17T08:10:00Z" },
    { "name": "assets", "type": "dir", "sizeBytes": null, "modifiedAt": "2026-11-17T08:09:00Z" }
  ],
  "truncated": false,
  "fetchedAt": "2026-11-17T08:12:00Z"
}
```

- `entries` 只含直接子项；目录优先、名称升序。
- `type`：`file` / `dir` / `symlink` / `other`。
- 超过 `maxFileEntries=2000`：返回前 2000 条，`truncated=true`。
- 不返回绝对路径；`name` 是单段。

### 15.5 `O-10` 内容

```http
GET /api/v1/observability/runs/<runId>/files/content?root=task-space&path=reports/design.md
```

响应 `200`：

```json
{
  "runId": "01a1daa7-…",
  "root": "task-space",
  "path": "reports/design.md",
  "name": "design.md",
  "sizeBytes": 2048,
  "modifiedAt": "2026-11-17T08:10:00Z",
  "content": "# 方案\n…",
  "encoding": "utf-8",
  "binary": false,
  "truncated": false,
  "fetchedAt": "2026-11-17T08:12:01Z"
}
```

- 文本：UTF-8 `content`；超过 1 MiB 返回前 1 MiB，`truncated=true`。
- 二进制/非法 UTF-8：`content=null`、`encoding=null`、`binary=true`；只给 `sizeBytes`/`modifiedAt`。
- 目录/符号链接当文件读：`415 unsupported_file`。
- 不返回 `contentType`/`language`；由调度器按扩展名映射，UI 只消费产品 DTO。

### 15.6 限制与错误

| 常量 | 值 | 约束 |
|---|---:|---|
| `maxFileEntries` | 2000 | 单次列表 |
| `maxFileBytes` | 1048576（1 MiB） | 单文件文本截断 |
| `maxFilePathLength` | 1024 | 相对路径字符 |
| `maxFilePathSegments` | 64 | 相对路径段数 |
| `maxFileResponseBytes` | 2097152（2 MiB） | 适配器接收上限 |
| `fileRequestTimeoutMs` | 5000 | 调度器适配器超时 |

| HTTP | `code` | 触发 |
|---:|---|---|
| 400 | `validation_error` | `root`/`path` 非法、超长 |
| 400 | `path_escape` | `..`、绝对路径、符号链接逃逸 |
| 401 | `unauthorized` | token 缺失/错误 |
| 403 | `file_permission_denied` | 无读权限 |
| 404 | `run_not_found` | 注册表从未有过该 run |
| 404 | `file_not_found` | 文件/目录不存在 |
| 410 | `run_gone` | 注册表已按保留策略清理 |
| 415 | `unsupported_file` | 目录/符号链接当文件读、不支持的类型 |
| 503 | `service_unavailable` | 磁盘/观测存档暂不可用 |
| 500 | `internal` | 未分类 |

- 错误信封沿用 §3；`requestId` 回显；不把文件内容写进错误 message。
- 文件读取用异步 FS；单层列表；按需读前 1 MiB；并发上限建议 4；不阻塞 poll/SSE/任务。

### 15.7 发现、鉴权与启动

**配置**

```toml
[observability]
retention_days = 7
max_bytes = 1073741824
max_session_content_bytes = 67108864

[observability.http]
enabled = true
required = false                 # true：观测面启动失败则 serve 退出；默认降级
bind = "127.0.0.1"               # 非 loopback 必须配置 token
port = 17890
advertise_url = "http://127.0.0.1:17890/api/v1/observability"
token = ""                       # 空：仅 loopback；复用 [scheduler].token 优先
max_streams = 20
raw_enabled = true
```

- `bind` 默认从 v1 的 `0.0.0.0` 改为 `127.0.0.1`；跨机显式配置 + token + 隧道/反代。
- `advertise_url` 是调度器可达的 URL，不是 bind 地址；`0.0.0.0` 不能作为 advertise。
- token 为空：若 `[scheduler].token` 非空则复用；否则只允许 loopback；配了非 loopback 且无 token → 拒绝启动（`observability_insecure`）。
- `required=false`（默认）：bind/初始化失败记 `observability_disabled`，serve 继续；文件/观测端点不可用，任务不受影响。`required=true`：退出 4。
- v1 **复用 executor client token**，不新增秘密；独立观测 token/轮换/TLS 后置。

**自报 URL**

- client 每次 poll 带 `X-Observability-Url: <advertise_url>`（仅 enabled 且非空；≤2048；不放在 body）。
- 上游静态配置优先；自报仅 loopback/开发期可用；适配器校验 URL、禁重定向、5s 超时、2 MiB 响应、防 SSRF。
- 只报 URL，不报 token。

### 15.8 组件落点

见 §6（方案 B）：`CMP-observer` 负责 HTTP/查询/文件；`CMP-observability` 管 session 事件/meta；`CMP-store` 管 run 注册表；`CMP-workspace` 提供只读 `listDir`/`readText`；`CMP-runtime` 管 raw；`CMP-executor` 写 run 注册表；`CMP-cli` 组合根接线。

### 15.9 执行面加法

- `TaskRequest` 增可选 `runId: string`；重派不变；manual task 可缺。
- poll 请求头增可选 `X-Observability-Url`（≤2048，绝对 http(s)）；服务端只登记，不改变派发。
- client 承诺：
  - `C-13`：观测面启用时上报 `X-Observability-Url`；文件端点不可用时不影响任务。
  - `C-14`：收到 `runId` 时持久化 run→两个路径；任务空间读写仍限制在 task-space/workspace。
- 不新增执行面端点；`X-Executor-Protocol` 仍 `3`；旧 client/旧调度器互相忽略。

### 15.10 验证

- `O-09`/`O-10`：正常、截断、二进制、目录、缺失、路径逃逸、符号链接、权限。
- 注册表：task runId upsert、archive upsert、重启重建、保留/410、未知 404。
- 鉴权/发现：loopback 无 token、非 loopback 拒绝、token 正确/错误、URL 头/静态配置、非法 URL。
- 隔离：文件读不阻塞 poll/SSE；并发上限；bind 失败降级。
- 集成：真实 client + run；文件列表/读 md/code；client 离线 504；任务执行不受影响。

### 15.11 与上游提案的差异（需对齐）

| 项 | 上游 `2026-11-17-client-observability` | 本 v2 | 处理 |
|---|---|---|---|
| attempt 端点 | 保留 `O-02`–`O-05`（attempt 列表/详情/日志/SSE） | 不实现，调度层已有 | 上游需把 attempt 端点降为可选；或另立轻量查询 |
| session 端点 | `O-06`–`O-08` | `S-03`–`S-06`（S-01/S-02 为 health/list） | 路径对齐：`/sessions*`；编号映射写进交接件 |
| 文件端点 | `O-09`/`O-10` | 同路径、同 ID | 已对齐 |
| 事件内容 | P1 的“规范化事件”，未承诺 prompt/思考/tool I/O | `SessionEvent` full 模式含文本/工具 I/O | 上游需确认接收更丰富的事件，或 UI 只读 raw |
| 组件 | 新增 `CMP-observer` | 已改为 B | 已对齐 |
| 默认 bind | `127.0.0.1` | 同 | 已对齐 |
| runId/注册表 | `TaskRequest.runId` + 注册表 | 同 | 已对齐 |
| 版本 | `2026-11-17.1` | 同 | 已对齐 |

**编号说明**：上游的 `O-01`–`O-10` 是连续编号；本 v2 把 session 面用 `S-*` 重排，文件端点保留 `O-09/O-10`。跨项目契约以**路径**为准；建议交接时统一成一份 client 权威契约，避免两套编号长期并存。

### 15.12 待确认（文件补充）

1. 是否接受 `TaskRequest.runId` 可选 + 注册表/journal 扩展？
2. `O-09`/`O-10` 是否沿用上游 2000/1 MiB/5s/2 MiB/一层/不做下载？
3. 默认 bind 改 `127.0.0.1`、非 loopback 强制 token、`required=false` 降级是否确认？
4. 复用 executor token 是否接受（v1 不建独立观测 token）？
5. 自报 URL 是否只限 loopback/开发期，生产用静态配置？
6. run 注册表保留：归档 7 天、未归档 30 天、任务空间不删，是否接受？
7. 上游是否接受“不实现 attempt 端点”、并把 session 事件扩展为 rich `SessionEvent`？
