---
layer: design
module: execution-plane
status: current
updated: 2026-11-17
contract: client-observability-v1
version: 2026-11-17.1
---

# client-observability-v1：client 只读观测面

> 依据：上游 [`2026-11-17-client-observability`](../../../../agent-flow-orchaster/docs/works/2026-11-17-client-observability/proposal.md)（用户确认）+ 2026-11-17 三项决策（恢复 attempt 端点 / preview 事件 / O-05+O-11）。
> 本文件是现行契约（2026-11-17 P1 确认后回填）。
> 只读、全部 `GET`；基础路径 `/api/v1/observability`；JSON UTF-8、camelCase、ISO-8601 UTC。

## 1. 端点总表

| ID | 方法/路径 | 用途 |
|---|---|---|
| `O-01` | `GET /health` | 存活、版本、计数、能力开关 |
| `O-02` | `GET /attempts` | attempt 列表（当前+历史） |
| `O-03` | `GET /attempts/{attemptId}` | attempt 详情 + session 摘要 |
| `O-04` | `GET /attempts/{attemptId}/logs` | attempt 规范化日志（preview） |
| `O-05` | `GET /attempts/{attemptId}/logs/stream` | attempt 日志 SSE（preview） |
| `O-06` | `GET /sessions/{sessionId}` | session 元数据 + 归档 |
| `O-07` | `GET /sessions/{sessionId}/events` | session 规范化事件（preview，按 sessionId 过滤） |
| `O-08` | `GET /sessions/{sessionId}/raw` | 原始 zstd 下载 |
| `O-09` | `GET /runs/{runId}/files` | 运行文件列表 |
| `O-10` | `GET /runs/{runId}/files/content` | 运行文件内容 |
| `O-11` | `GET /sessions/{sessionId}/events/stream` | **运行中富 ACP 事件 SSE** |

## 2. 对象与身份

- `attemptId`：client 在任务接收时为每次 attempt 生成 **UUIDv7**；持久化在 attempt meta；与 `taskId + attemptNo` 一一对应。
- `sessionId`：DSH `session/new` 返回；一个 attempt 最多一个 session；建 session 前失败时 `session=null`。
- `runId`：`TaskRequest.runId?`；manual task 可缺；用于 `O-09`/`O-10`。
- `nodeId`：字符串（如 `n3`），不是 UUID。
- `attempt` 状态：`running` / `completed` / `failed` / `cancelled` / `timeout` / `interrupted`。
- `attempt` phase：`claimed` / `bound` / `ready` / `running` / `settled` / `reported` / `closed`。

## 3. `O-01` health

```json
{
  "status": "ok",
  "observabilityVersion": "2026-11-17.1",
  "clientVersion": "0.1.0",
  "startedAt": "2026-11-17T09:00:00Z",
  "uptimeMs": 123456,
  "activeAttempts": 1,
  "retainedAttempts": 35,
  "activeSessions": 1,
  "retainedSessions": 35,
  "registeredRuns": 12,
  "filesEnabled": true,
  "richStreamEnabled": true,
  "authRequired": false
}
```

`status`：`ok` / `degraded`（事件写盘持续失败、归档失败）。不返回路径/配置/凭据。

## 4. `O-02` attempt 列表

查询：`instanceId`、`nodeId`、`runId`、`taskId`、`sessionId`、`status`、`from`/`to`、`limit`（1..200，默认 50）、`cursor`。

```json
{
  "items": [{
    "attemptId": "01a1daa8-…",
    "instanceId": "0193f0aa-…",
    "nodeId": "n3",
    "runId": "01a1daa7-…",
    "taskId": "01a1daa8-…",
    "attemptNo": 1,
    "status": "running",
    "phase": "running",
    "sessionId": "0ae3227a-…",
    "startedAt": "2026-11-17T09:35:43Z",
    "finishedAt": null,
    "durationMs": null,
    "errorClass": null,
    "logCount": 24,
    "archiveStatus": "pending"
  }],
  "nextCursor": "…"
}
```

排序：当前 attempt 置顶，其余 `startedAt` 降序。`archiveStatus`：`pending`/`stored`/`partial`/`failed`/`not_applicable`。

## 5. `O-03` attempt 详情

```json
{
  "attempt": { "…同 O-02 item…": "" },
  "session": {
    "sessionId": "0ae3227a-…",
    "status": "running",
    "cwd": "/abs/instance-a",
    "startedAt": "…",
    "finishedAt": null,
    "archive": { "status": "pending", "sizeBytes": null, "sha256": null }
  },
  "logRange": { "firstSeq": 1, "lastSeq": 24 }
}
```

无 session 时 `session=null`。

## 6. `O-04` attempt 日志（preview）

查询：`cursor`、`limit`（1..1000，默认 200）、`level`（`debug|info|warn|error`）、`kind`（`phase|log|acp|result`）。

```json
{
  "items": [{
    "seq": 1,
    "ts": "2026-11-17T09:35:43Z",
    "attemptId": "01a1daa8-…",
    "instanceId": "0193f0aa-…",
    "nodeId": "n3",
    "runId": "01a1daa7-…",
    "sessionId": "0ae3227a-…",
    "kind": "acp",
    "event": "session.update",
    "message": "assistant message: 第 1 步…",
    "data": { "acpType": "agent_message_chunk", "truncated": true }
  }],
  "nextCursor": "…",
  "truncatedBefore": null
}
```

- `message` 是**可读预览**，≤4 KiB，已脱敏；`data` 白名单。
- 不返回 prompt、最终消息全文、推理、工具完整 I/O；全文走 `O-08`。
- `seq` per attempt 单调；截断给 `truncatedBefore`。

## 7. `O-05` attempt 日志 SSE（preview）

`Accept: text/event-stream`；可选 `Last-Event-ID`。

```text
event: snapshot
id: 24
data: {"events":[…最多200…],"truncatedBefore":null}

event: log
id: 25
data: {"seq":25,"kind":"acp",…}

event: heartbeat
data: {"ts":"…"}

event: end
data: {"status":"completed","finishedAt":"…"}
```

15s heartbeat；慢消费者队列 1000，超限 `slow_consumer` 关闭；`maxStreams=20` 全局，超限 429。

## 8. `O-06` session 元数据

```json
{
  "sessionId": "0ae3227a-…",
  "attemptId": "01a1daa8-…",
  "instanceId": "0193f0aa-…",
  "nodeId": "n3",
  "runId": "01a1daa7-…",
  "cwd": "/abs/instance-a",
  "status": "completed",
  "startedAt": "…",
  "finishedAt": "…",
  "eventCount": 24,
  "archive": {
    "status": "stored",
    "sizeBytes": 123456,
    "sha256": "sha256:…",
    "downloadUrl": "/api/v1/observability/sessions/0ae3227a-…/raw"
  }
}
```

## 9. `O-07` session 事件（preview）

- 由 `O-04` 的 attempt 事件按 `sessionId` 过滤得到；`seq` 沿用 attempt seq。
- 支持 `cursor`/`limit`；不返回富文本/工具 I/O；`410 observation_gone` 已清理。
- 与 `O-04` 同一 schema，不新增字段。

## 10. `O-08` raw

- `200 application/zstd`；`Content-Disposition`、`Content-Length`、`ETag`、`X-Checksum-Sha256`、`Accept-Ranges`。
- `409 archive_not_ready`；`404 session_not_found`；`410 observation_gone`；`403 raw_disabled`。
- 不解析；访问审计。
- `Accept-Ranges: bytes` 已声明；v1 不实现 Range 切片，带 `Range` 请求按 `200` 全量返回。

## 11. `O-09`/`O-10` 运行文件

按 §15（proposal）执行：`root=task-space|workspace`、相对路径、一层、2000 条、文本 1 MiB、二进制元数据、错误码 `path_escape`/`run_not_found`/`run_gone`/`file_not_found`/`file_permission_denied`/`unsupported_file`。

- 限制归属：**client 强制 2000 条 / 1 MiB**；`2 MiB/5s` 是调度器适配器/BFF 的限制，client 不额外强制。
- 鉴权：token 非空要求 Bearer；token 为空仅允许 loopback；v1 不提供独立 auth 开关（与执行面 token 语义一致）。

## 12. `O-11` session 富事件 SSE（新增）

`Accept: text/event-stream`；可选 `Last-Event-ID`；仅运行中/内存快照。

```text
event: snapshot
id: 24
data: {"events":[…最多200…],"reset":false}

event: event
id: 25
data: {"seq":25,"kind":"tool_call",…}

event: heartbeat
data: {"ts":"…"}

event: end
data: {"status":"completed","finishedAt":"…"}
```

### 12.1 `SessionRichEvent`

```ts
type SessionRichEvent = {
  seq: number;                 // per session，内存内单调
  ts: string;
  sessionId: string;
  kind: "lifecycle" | "prompt" | "message" | "thought" | "tool_call" | "tool_result" | "usage" | "permission" | "config" | "other";
  messageId?: string;
  toolCallId?: string;
  lifecycle?: "session.started" | "prompt.result" | "session.closed";
  acpType?: string;            // kind=other 时的原 sessionUpdate
  text?: string;               // ≤16 KiB，truncated 标记
  tool?: { name: string; status: "in_progress"|"completed"|"failed"; input?: unknown; output?: string; durationMs?: number };
  usage?: { used: number; size: number };
  permission?: { tool?: { name?: string; inputSummary?: string }; options: {kind:string;name:string}[]; decision?: "allow"|"reject" };
  stopReason?: string;
  error?: { class?: string; code: string; message: string };
  data?: Record<string, unknown>;
  truncated?: boolean;
  originalBytes?: number;
};
```

- 只在运行中内存 ring（默认 1000 条）保留；`snapshot` 最近 200；不落盘。
- 结束/重启后不提供历史富事件；历史看 `O-07` preview + `O-08` raw。
- 内容上限：单事件 16 KiB；超出 `truncated=true`。
- `rich_stream_enabled=false` 时 `503 rich_stream_disabled`。

## 13. 配置

```toml
[observability]
retention_days = 7
max_bytes = 1073741824
max_attempt_event_bytes = 10485760

[observability.http]
enabled = true
required = false
bind = "127.0.0.1"
port = 17890
advertise_url = "http://127.0.0.1:17890/api/v1/observability"
token = ""
max_streams = 20
raw_enabled = true
rich_stream_enabled = true
```

- 非 loopback 必须 token；token 空时回退 `[scheduler].token`；否则拒绝启动。
- `required=false`：bind 失败降级；`required=true` 退出 4。
- `X-Observability-Url` 头只报 URL；静态配置优先；适配器做 SSRF。

## 14. 错误码

沿用 `400 validation_error` / `400 path_escape` / `401 unauthorized` / `403 raw_disabled` / `403 file_permission_denied` / `404 attempt_not_found` / `404 session_not_found` / `404 run_not_found` / `404 file_not_found` / `409 archive_not_ready` / `410 observation_gone` / `410 run_gone` / `413 payload_too_large` / `415 unsupported_file` / `429 rate_limited` / `500 unsupported_layout` / `503 service_unavailable`。

## 15. 存储与所有权

```text
<stateRoot>/observability/
  attempts/<attemptId>/{meta.json,events.jsonl}
  sessions/<sessionId>/{meta.json,session.v4.jsonl.zstd}
<stateRoot>/runs/<runId>.json
```

- attempts：`CMP-observability` 写；O-02/O-03/O-04/O-07 读。
- sessions meta：`CMP-observability` 写；raw：`CMP-runtime` 写；O-06/O-08 读。
- runs：`CMP-store` 写；O-09/O-10 读。
- rich ring：`CMP-observer` 内存；O-11 读。
- 保留：attempt 事件 10 MiB/attempt；session 事件不落盘；sessions/raw 7 天/1 GiB；runs 归档 7 天/未归档 30 天。

## 16. 验收

- O-01–O-11 正常/错误/404/410/415/429；
- attempt 生成/重派/session 关联/runId；
- O-04/O-05/O-07 preview 不含 prompt/推理/tool I/O；
- O-11 富事件顺序/上限/snapshot/Last-Event-ID/慢消费者/结束；
- O-09/O-10 路径/截断/二进制/符号链接；
- run 注册表 upsert/重建/保留；
- 鉴权/绑定/降级/SSRF；
- 观测不阻塞 poll/任务。
