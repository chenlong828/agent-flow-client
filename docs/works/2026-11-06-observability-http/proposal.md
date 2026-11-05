---
layer: works
module: global
status: active
updated: 2026-11-06
---

# Client 只读观测 HTTP 提案（P1）

> 范围：`serve` 常驻进程对外暴露的**只读**观测面；不改变调度器控制契约（claim/cancel/heartbeat 仍由 client 出站）。
> 命名：用户原文 `/observale` 为拼写错误；本稿采用 `/api/v1/observability`（名词），短路径备选 `/observe`。
> 状态：设计稿，未改 `docs/design/`；P1 确认后回填架构与组件规格。

## 1. 结论

新增一个独立的只读 HTTP 面：

```text
GET /api/v1/observability/...
```

它提供三类能力：

1. **当前执行**：按 attempt 查询日志、通过 SSE 看实时流；
2. **历史步骤**：按实例/状态列出已完成的 attempt，读取保留的日志；
3. **DSH session 信息**：session 元数据、规范化事件、原始 `session.v4.jsonl.zstd` 下载。

它是**观测面**，不是控制面：

- 不提供 claim/cancel/pause/shutdown 的入站替代；
- 不参与租约、心跳、重试与结果上报；
- 调度器控制仍走心跳长轮询，`SCH-18` 不变。

## 2. 关键决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 路径 | `/api/v1/observability` | `observability` 是正确名词；`/observale` 拼写错误 |
| 读写 | 只读，全部 `GET` | 避免与调度控制面混淆；降低攻击面 |
| 消费方 | 调度器/运维 | 用户明确“调度器访问即可” |
| 实时日志 | SSE | 单向、简单、支持 `Last-Event-ID` 续传 |
| 历史保留 | 实例清理前复制到 `stateRoot/observability` | 不依赖实例 home 存活；可设保留窗口 |
| Session 粒度 | 规范化事件 + 原始文件下载 | 查询稳定；排障可拿 DSH 原文 |
| 鉴权 | 静态 Bearer token 可选；token 为空则不鉴权（受控网络） | 先做功能；TLS/mTLS/轮换后续 |
| 发现 | v1 由调度器侧配置 base URL，不自动注册 | 不扩调度器契约；S2 再评估 |
| 绑定 | 默认 `0.0.0.0:17890`，CLI 参数可改 | 调度器可直接访问；绑定所有接口不等于可路由，仍需网络可达 |

## 3. 端点

基础路径：`/api/v1/observability`；JSON UTF-8，字段 camelCase，时间 ISO-8601 UTC。

| ID | 方法/路径 | 用途 |
|---|---|---|
| `O-01` | `GET /health` | 存活、版本、活跃 attempt 数、归档数 |
| `O-02` | `GET /attempts` | 列出 attempt（当前 + 历史） |
| `O-03` | `GET /attempts/{attemptId}` | attempt 详情 + session 摘要 |
| `O-04` | `GET /attempts/{attemptId}/logs` | 分页读取规范化日志 |
| `O-05` | `GET /attempts/{attemptId}/logs/stream` | SSE 实时日志 |
| `O-06` | `GET /sessions/{sessionId}` | DSH session 元数据 |
| `O-07` | `GET /sessions/{sessionId}/events` | 规范化 session 事件（分页） |
| `O-08` | `GET /sessions/{sessionId}/raw` | 原始 `session.v4.jsonl.zstd` 下载 |

### 3.1 `O-01` `GET /health`

```json
{
  "status": "ok",
  "version": "2026-11-06.1",
  "startedAt": "2026-11-06T01:00:00Z",
  "uptimeMs": 123456,
  "activeAttempts": 2,
  "retainedAttempts": 37,
  "retainedSessions": 35
}
```

鉴权与其它端点一致：token 非空时要求 Bearer；token 为空时不鉴权（受控网络）。`health` 不返回路径、配置、凭据；`status` 取值 `ok` / `degraded`（日志写盘或归档失败）。

### 3.2 `O-02` `GET /attempts`

查询参数：

| 参数 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `instanceId` | UUIDv7 | — | 过滤实例 |
| `status` | enum | — | `running` / `completed` / `failed` / `cancelled` / `timeout` |
| `sessionId` | string | — | 过滤 session |
| `from` / `to` | ISO-8601 | — | 按 `startedAt` 过滤 |
| `limit` | 1..200 | 50 | 条数 |
| `cursor` | string | — | 上一页 `nextCursor` |

响应：

```json
{
  "items": [
    {
      "attemptId": "<uuid-v7>",
      "instanceId": "<uuid-v7>",
      "nodeId": "<uuid-v7>",
      "attemptNo": 2,
      "status": "running",
      "phase": "running",
      "sessionId": "<session-id>",
      "startedAt": "2026-11-06T01:02:10Z",
      "finishedAt": null,
      "durationMs": null,
      "errorClass": null,
      "logCount": 84,
      "archiveStatus": "pending"
    }
  ],
  "nextCursor": "eyJzZXEiOjEyM30="
}
```

排序：`startedAt` 降序；当前 attempt 置顶。`archiveStatus`：`pending` / `archived` / `partial` / `failed` / `not_applicable`（无 session）。

### 3.3 `O-03` `GET /attempts/{attemptId}`

```json
{
  "attempt": { "...": "同 O-02 item" },
  "session": {
    "sessionId": "<session-id>",
    "status": "running",
    "cwd": "/abs/instance-a",
    "startedAt": "2026-11-06T01:02:10Z",
    "finishedAt": null,
    "archive": {
      "available": false,
      "sizeBytes": null,
      "sha256": null,
      "downloadUrl": null
    }
  },
  "logRange": { "firstSeq": 1, "lastSeq": 84 }
}
```

无 session（建 session 前失败）时 `session=null`。

### 3.4 `O-04` `GET /attempts/{attemptId}/logs`

查询：`cursor`、`limit`（1..1000，默认 200）、`level`（可选，`debug|info|warn|error`）、`kind`（可选，`phase|log|acp|result`）。

```json
{
  "items": [
    {
      "seq": 1,
      "ts": "2026-11-06T01:02:10Z",
      "attemptId": "<uuid-v7>",
      "instanceId": "<uuid-v7>",
      "nodeId": "<uuid-v7>",
      "sessionId": "<session-id>",
      "kind": "phase",
      "phase": "claimed",
      "level": "info",
      "event": "attempt.claimed",
      "message": "attempt claimed",
      "data": { "attemptNo": 1 }
    }
  ],
  "nextCursor": "eyJzZXEiOjIwMH0="
}
```

- `seq` 按 attempt 单调递增；空洞表示日志被保留策略截断，返回 `truncatedBefore: <seq>`。
- `message` 已脱敏、截断（默认 4 KiB）；`data` 只放白名单字段。
- 不返回 prompt/最终结果全文；需要全文走 session raw（鉴权 + 审计）。

### 3.5 `O-05` `GET /attempts/{attemptId}/logs/stream`

请求头：`Accept: text/event-stream`；可选 `Last-Event-ID: <seq>`。

事件：

```text
event: snapshot
id: 84
data: {"attemptId":"...","events":[...],"truncatedBefore":null}

event: log
id: 85
data: {"seq":85,...}

event: end
id: 86
data: {"status":"completed","finishedAt":"..."}
```

- 建连先发 `snapshot`（最近最多 200 条；有 `Last-Event-ID` 则从该 seq+1 补发，超出保留范围则 `snapshot` 带 `reset=true`）。
- 之后实时 `log`/`phase`/`acp`/`result`；每 15s `heartbeat`。
- attempt 已结束：`snapshot` + `end` 后关闭。
- 慢消费者：队列上限 1000；超过则发 `event: error`（`slow_consumer`）并关闭。
- 并发流上限 `maxStreams`（默认 20）；超限 `429 rate_limited`。

### 3.6 `O-06` `GET /sessions/{sessionId}`

```json
{
  "sessionId": "<session-id>",
  "attemptId": "<uuid-v7>",
  "instanceId": "<uuid-v7>",
  "nodeId": "<uuid-v7>",
  "cwd": "/abs/instance-a",
  "status": "completed",
  "startedAt": "2026-11-06T01:02:10Z",
  "finishedAt": "2026-11-06T01:03:40Z",
  "eventCount": 42,
  "archive": {
    "available": true,
    "sizeBytes": 123456,
    "sha256": "sha256:<hex>",
    "downloadUrl": "/api/v1/observability/sessions/<session-id>/raw"
  }
}
```

`status`：`running` / `completed` / `failed` / `cancelled` / `timeout`。archive 未完成时 `available=false`，`raw` 返回 `409 archive_not_ready`。

### 3.7 `O-07` `GET /sessions/{sessionId}/events`

返回由 client 观测事件中 `sessionId` 匹配的规范化事件（不是现场解析 DSH 原始文件，避免格式版本耦合）：

```json
{
  "items": [
    {
      "seq": 3,
      "ts": "2026-11-06T01:02:12Z",
      "kind": "acp",
      "event": "session.update",
      "message": "tool call: read",
      "data": { "tool": "read", "status": "completed" }
    }
  ],
  "nextCursor": "eyJzZXEiOjN9"
}
```

支持 `cursor`/`limit`。若 session 已被保留策略清理，返回 `410 observation_gone`。

### 3.8 `O-08` `GET /sessions/{sessionId}/raw`

- 200：`Content-Type: application/zstd`；`Content-Disposition: attachment; filename="<sessionId>.jsonl.zstd"`；`Content-Length`、`ETag`、`X-Checksum-Sha256`、`Accept-Ranges: bytes`。
- `Range` 请求可选支持（大文件排障）。
- `409 archive_not_ready`：session 还活跃或归档未完成。
- `404 session_not_found`：从未归档且无 session。
- `410 observation_gone`：已按保留策略删除。
- 响应不包 JSON；错误仍用 JSON 错误信封。

## 4. 数据模型

### 4.1 `ObservationEvent`

```ts
type ObservationEvent = {
  seq: number;                 // per attempt，单调递增
  ts: string;                  // ISO-8601
  attemptId: string;
  instanceId: string;
  nodeId: string;
  sessionId?: string;
  kind: "phase" | "log" | "acp" | "result";
  phase?: "claimed" | "bound" | "ready" | "running" | "settled" | "reported" | "closed";
  level?: "debug" | "info" | "warn" | "error";
  event: string;               // 稳定事件名，如 attempt.claimed / session.update
  message?: string;            // 已脱敏、截断
  data?: Record<string, unknown>; // 白名单字段
};
```

- `message` 默认上限 4 KiB；超限 `truncated=true` 放 `data`。
- `kind="acp"` 的 `message` 是 DSH 事件的可读预览（assistant 文本片段、工具名/状态、停止原因），不是完整 transcript；完整内容走 raw。
- `data` 白名单：`attemptNo`、`tool`、`status`、`stopReason`、`usage`、`errorClass`、`code`、`retryable`、`durationMs`、`sizeBytes`、`truncated`。
- 不写 prompt、最终结果全文、模型推理、工具完整 I/O；原始 session 文件承担全文排障。

### 4.2 `AttemptSummary` / `SessionMeta`

见 O-02/O-06；`SessionMeta` 额外持久化 `sourceFile`、`archiveStatus`、`sha256`、`sizeBytes`、`finishedAt`。

### 4.3 存储布局

```text
<stateRoot>/observability/
  attempts/<attemptId>/
    meta.json
    events.jsonl
  sessions/<sessionId>/
    meta.json
    session.v4.jsonl.zstd
```

- `events.jsonl` 追加写，按 attempt 分文件；`seq` 单调。
- `meta.json` 原子写（临时文件 + rename），包含状态、时间、计数、archive 信息。
- `CMP-observability` 是 `attempts/*` 的唯一写入口。
- `CMP-runtime` 是 `sessions/*` 的唯一写入口：session 关闭时把实例 home 中的原始文件复制到归档目录；原子 rename；计算 sha256。`session.v4.jsonl.zstd` 是当前实测名，实际文件名/格式以 DSH 为准，归档记录 `sourceFile`，不做解析。
- `CMP-observability` 只读 `sessions/*`，不写；不直接读 journal。

### 4.4 保留与清理

| 配置 | 默认 | 语义 |
|---|---|---|
| `retentionDays` | 7 | 完成超过 N 天删除 |
| `maxBytes` | 1 GiB | 超过上限按 `finishedAt` 最旧删除 |
| `maxEventBytesPerAttempt` | 10 MiB | 单 attempt 日志上限；超过截断并记 `truncated` |

- 只清理已结束的 attempt/session；活跃永不清理。
- 清理顺序：先 attempt 事件，后 session 归档；失败重试，不阻塞主流程。
- 已清理的 attempt 在列表可省略；直接访问返回 `410 observation_gone`（raw/session）或 `404`（attempt index 已删）。
- 实例清理前必须先归档 session；归档失败时**不删除实例 home**，记 `archive_failed`，留待重试/人工处理。
- 崩溃恢复：`serve` 启动时扫描未归档的实例 home；能读到的 session 文件先复制为 `partial` 归档（`meta.partial=true`），再进入正常清理；读不到则保留 home 并告警。部分归档的 raw 可下载，但列表标记 `archiveStatus=partial`。

## 5. 组件修改方案

### 5.1 候选

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 扩展 `CMP-observability`：新增 `ObservationStore`、`EventHub`、`ObservationHttpServer`；`CMP-runtime` 写 session 归档 | 组件少、数据同源、日志/查询/归档都在观测域 | L0 组件新增入站 HTTP，职责变重；需改边界 |
| B | 新增 `CMP-observer` L0，专管 HTTP 与查询；`CMP-observability` 仍只写日志 | 关注点分离清楚 | 新组件 + L0 横向依赖/组合根接线；v1 成本高 |
| C | HTTP 放在 `CMP-cli` | 改动最小 | CLI 变成查询/协议层，违背“薄组合根”；后续难拆 |

**推荐 A**：v1 先把观测面收在 `CMP-observability` 内；当端点/数据源继续增长（接 journal、metrics、多 client）再拆 B。`CMP-observability` 的新边界是「只读本地观测」，仍不做控制、不做上传。

### 5.2 依赖与调用

```text
CMP-cli（组合根）
  ├─ 启动/停止 ObservationHttpServer
  ├─ 注入 ObservationStore / archiveRoot / token / bind
  └─ 把 Logger 注入所有组件
CMP-executor ── Logger ──▶ CMP-observability（事件）
CMP-runtime ── Logger ──▶ CMP-observability（ACP 事件）
CMP-runtime ── 写 ──▶ <stateRoot>/observability/sessions/*（归档）
CMP-observability ── 读 ──▶ attempts/*、sessions/*（HTTP）
```

- 禁止：`CMP-observability` import `CMP-cli`/`CMP-executor`/`CMP-runtime`；HTTP 层不直接读 journal/工作区。
- `CMP-runtime` 不 import `CMP-observability`；归档路径由组合根注入，写入是文件契约。

### 5.3 与现行规格的差异

| 现行文档 | 现行表述 | 本提案需要的修订 |
|---|---|---|
| `architecture.md` §1 | 不提供本地 HTTP 服务或 IPC | 改为「不提供控制面 HTTP/IPC；提供只读观测 HTTP」 |
| `architecture.md` §3.2 | CLI 只有 serve/run/doctor/version | 不变；`serve` 增加观测 HTTP 启停与配置，不新增命令 |
| `CMP-observability` §1 | 不负责跨边界上传日志/全文；不负责进程/文件/网络 | 保留「不上传/不控制」；新增「只读本地观测 HTTP、观测存储、session 归档读取」 |
| `CMP-runtime` §1 | 不负责 store/结果/调度器 | 新增「session 关闭时归档原始 session 文件到观测目录」；仍不负责查询/HTTP |
| `CMP-cli` §1 | 命令与配置、serve 循环、组合根 | 新增「启动/停止 ObservationHttpServer；注入 bind/port/token/archiveRoot」 |

这些修订在 P1 评审通过后回填，不在本设计稿中直接改 `design/`。

### 5.4 配置（提案，M1 冻结）

```toml
[observability]
retention_days = 7
max_bytes = 1073741824
max_event_bytes_per_attempt = 10485760

[observability.http]
enabled = true          # 仅 serve 生效；run 不启
bind = "0.0.0.0"
port = 17890
token = ""              # 空 = 不鉴权；仅用于受控网络
max_streams = 20
```

- `bind` 默认 `0.0.0.0`，`port` 默认 `17890`；CLI 参数 `--observability-bind` / `--observability-port` / `--observability-token` 覆盖配置（`serve` 专用，`run` 不启）。
- `token` 为空：不鉴权，启动日志与 `doctor` 记 `observability_insecure` 警告；仅用于受控网络。token 非空：所有请求要求 Bearer。
- 绑定失败/端口占用：退出 4（`observability_bind_failed`）。
- 调度器跨机访问：`0.0.0.0` 只是监听所有接口，调度器仍需可达 IP/端口；v1 不做自动发现。

## 6. 鉴权与安全

- token 非空时：所有端点要求 `Authorization: Bearer <token>`；常量时间比较；不记录 token。
- token 为空时：不鉴权；启动日志与 `doctor` 告警 `observability_insecure`。默认 `bind=0.0.0.0`，不要把无鉴权端口暴露到不可信网络；TLS/mTLS/轮换/来源 IP 限制后续特性。
- 原始 session 文件包含 system prompt、推理、工具 I/O，属敏感数据；只通过本观测面访问；token 为空时仅限受控网络；`Cache-Control: no-store`，访问写审计（requestId/attemptId/sessionId/remote）。
- 日志事件默认脱敏：键名匹配凭据；prompt/结果全文不写；`message` 截断。
- 只读：不提供 POST/PUT/PATCH/DELETE；不提供文件系统路径参数；`sessionId`/`attemptId` 必须存在。
- 响应头：`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`；不做 CORS（调度器非浏览器）。
- 速率限制：v1 只限制并发 SSE；HTTP 请求可由反向代理限流。

## 7. 错误码

统一信封：

```json
{ "error": { "code": "attempt_not_found", "message": "attempt not found", "details": {}, "requestId": "<id>" } }
```

| HTTP | code | 触发 |
|---:|---|---|
| 400 | `validation_error` | 参数缺失/非法/超限 |
| 401 | `unauthorized` | token 缺失/错误 |
| 403 | `forbidden` | token 无权访问该资源（预留） |
| 404 | `attempt_not_found` | attempt 不存在 |
| 404 | `session_not_found` | session 不存在 |
| 409 | `archive_not_ready` | session 活跃/归档未完成时下载 raw |
| 410 | `observation_gone` | 已按保留策略清理 |
| 429 | `rate_limited` | SSE 并发超限 |
| 500 | `internal` | 未分类 |
| 503 | `service_unavailable` | 归档/磁盘暂不可用 |

## 8. 失败与边界

| 场景 | 行为 |
|---|---|
| HTTP 端口被占 | `serve` 启动失败，退出 4；不影响 `run` |
| token 为空 | 不鉴权启动，记 `observability_insecure` 警告；受控网络才允许 |
| 日志写盘失败 | 主流程不受影响；HTTP 仍可读已有日志；健康状态 `degraded` |
| session 归档失败 | 不删除实例 home；`archiveStatus=failed`；`raw` 返回 409/503；告警 |
| 保留清理与查询并发 | 查询返回 410 或空；不返回半文件 |
| SSE 慢消费者 | 队列满后 `error` + 关闭，不阻塞日志写入 |
| 客户端重启 | 旧 run 的活跃 attempt 结束；历史 attempt/session 归档保留；新 run 可查；启动时补归档未收口 session（partial） |
| DSH session 文件格式变化 | 原始下载不受影响；规范化事件来自 client 日志，不解析 DSH 格式 |
| 归档未完成时实例被清理 | 禁止；必须先归档成功或显式人工覆盖 |

## 9. 版本与兼容

- 观测 API 独立版本 `observabilityVersion = "2026-11-06.1"`；与调度器 `protocolVersion` 解耦。
- 加可选字段/端点兼容；删字段/改语义需升版本。
- 原始 session 文件格式由 DSH 决定，不作为稳定契约；客户端只保证“原样归档/下载”。
- 保留策略变化不改变 API 语义，只改变可用窗口。

## 10. 待确认

1. ~~`bind`/`port`/token 默认值~~ 已定：`0.0.0.0:17890`，CLI 可改；token 可选，空则不鉴权并告警。
2. 调度器如何拿到 base URL/token：v1 静态配置，还是 `register` 上报 `observabilityUrl`？
3. 历史范围：只保留本 client 的 attempt，还是按实例跨 client 合并？（当前：本 client）。
4. 原始 session 下载是否需要二次授权/审计级别（v1 只 token）。
5. 是否需要在 `doctor` 中增加观测面自检（端口、归档目录、保留空间）。

## 11. 验收建议

- 端点：health/attempts/logs/stream/sessions/raw 的正常与 404/410/409/429。
- SSE：snapshot、断线 `Last-Event-ID` 续传、慢消费者、结束关闭。
- 归档：session 关闭后 raw 可下载；实例清理后仍可查；归档失败不删 home。
- 脱敏：日志无 prompt/结果全文/凭据；raw 仅 token 可下载。
- 并发：多 attempt 日志隔离；多 SSE 订阅互不阻塞。
- 重启：历史 attempt/session 可查；活跃 attempt 不伪造历史。
