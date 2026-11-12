---
layer: design
module: execution-plane
status: current
updated: 2026-11-12
contract: executor-http-v3
protocolVersion: 3
supersedes: executor-http-v2
---

# 执行面契约 v3：任务、会话日志与运行归档

> 权威在本文件（调度器侧）。client 仓库的同步副本：`agent-flow-client/docs/design/contracts/executor-http-v3.md`（交接件见 `agent-flow-client/docs/works/2026-11-12-contract-v3-handoff/`）；冲突时以本文件为准。
> 状态：**现行契约**。`P-01`–`P-03` 已实现（2026-11-11）；`P-04`/`P-05`、`taskSpacePath`、归档电平字段随运行编排实现（`T-RUN-06`）。相对 v2 的差异见 §11。
> 修订：2026-11-12 按 client 评审（`agent-flow-client/docs/works/2026-11-12-contract-v3-handoff/review.md`）修订 `B-01`–`B-04`、`D-01`–`D-09`；见 §11.4。
> v2 已由本版取代并归档：`docs/history/works/2026-11-12-contract-v3-handoff/executor-http-v2.md`，不再作为设计依据。v2 → v3 是开发期版本替换，不设兼容窗口、不保留双版本并行期。

**端点**：`poll`（取任务 + 上报在跑状态 + 收停止/取消 + 收归档指令）、`result`（交结果）、`skill-packages`（取制品）、`session-log`（上传会话日志）、`run archive`（上传运行归档）。

## 0 一句话

调度器维护一张任务列表，client 拉取任务、执行、回报结果、再拉下一条。**保证 at-least-once：每个任务最终会被下发并跑完；允许重复执行，允许中断后重跑。**

v3 在此之上加两件事：**执行前有 task-space**（工作区内按 run 隔离的目录，节点读写都限制在这里），**执行后有会话日志与运行归档**（独立端点上传，不塞进结果体）。

## 1 模型与不变式

```
调度器                                       client
任务列表 queued → dispatched → done
  │ POST /poll {free, running[], finished[], archivedRuns[]}
  │ ──────────────────────────────────────────▶│  常驻长轮询：没空位时只上报状态
  │◀─ tasks[] / stop / cancelInstances / archiveRequests
  │                                            │  每个任务 = 一个技能集 + 一个 session
  │ POST /tasks/{taskId}/session-log           │  节点结束：先传日志
  │◀───────────────────────────────────────────│
  │ POST /tasks/{taskId}/result                │  再报结果
  │◀───────────────────────────────────────────│
  │  首份结果为准 → done → 取下一条             │
  │ GET /skill-packages/{packageId}            │  同 digest 短路，1000 个任务装一次
  │ POST /runs/{runId}/archive                 │  run 结束：后台打包上传 task-space
  │◀───────────────────────────────────────────│
```

六条不变式：

1. **任务原子性**：一个 `taskId` 对应一次 session 执行；同 `taskId` 的 prompt / 技能集 / 工作区 / task-space 在重派时保持不变。
2. **至多一个「在跑」副本被认可**：调度器同一时刻只把 `taskId` 派给一个 client；超时或失联后才重派（重派可能与旧副本重叠，属可接受成本）。
3. **结果一次性**：同一 `taskId` 的第一份结果为准，后续只回 `accepted=false`。
4. **有界执行**：每个任务都必须有一个客户端可执行的终止上界（`timeoutMs`），不依赖模型或工具自行返回。
5. **日志先于结果**：`P-02` 到达时该 `taskId` 的当前 `attempt` 必须已有通过校验的会话日志，否则 `409 session_log_missing`，任务不结算、不重派。**允许 0 行的空日志**：在 session 建立前就失败（prompt 超限、workspace 校验失败、技能安装失败、`spawn_failed`、取消）的尝试，由 client 上传一份 0 行 gzip ndjson 再报结果。
6. **task-space 隔离**：任务的所有读写限制在 `taskSpacePath` 与工作区内；task-space 路径由服务端拼接并下发，client **不拼接、不推断**，只做「绝对路径且在 `workspacePath` 之下」的校验。

### 1.1 明确放弃的保证

| 保证 | 为什么可以放弃 | 代价 |
|---|---|---|
| exactly-once | 分析任务可重跑，工作区留有痕迹，agent 能识别 | 极端情况下同一任务跑两次，浪费 token |
| 控制指令有序、至少一次、断连补发 | 停止/取消/归档用「当前期望状态」表达，丢一次下一跳还会带 | 生效延迟最多一个 poll 周期 |
| 崩溃后状态补偿（清理意图跨重启） | client 默认保留工作区，清理是运维动作 | 容器/目录需要人工或运维脚本回收 |
| 迟到结果审计 | 任务已 done，旧结果无价值 | 无 |
| 单实例单写者 | 任务按模块/调用链拆分；撞车时工具写前会重读 | 偶发 last-write-wins |
| 归档一次成功 | 归档不阻塞 run 终态，失败保留 `archive_state=failed` 供运维处理 | 需人工补传或放弃该次归档 |
| 上传产物字节级不可变 | 同键重传按「后到覆盖」处理，不要求客户端持久化压缩字节 | 极端情况下同一键的内容被较晚的重传替换（均来自同一 client、同一 attempt/run） |
| 日志脱敏 | 日志完整透传，服务端只存不解析；排障时离线解析 | 日志可能含工具输出与凭据；属已接受风险（`plan/risks.md`） |

## 2 端点总表

| ID | 方法 / 路径 | 用途 | 长轮询 | 幂等键 |
|---|---|---|---|---|
| `P-01` | `POST /api/v1/executor/poll` | 取任务 + 上报在跑状态 + 收停止/取消 + 收归档指令 | 30s | 无（见 §6 `S-03` 的对账规则） |
| `P-02` | `POST /api/v1/executor/tasks/{taskId}/result` | 交结果（前置：该 `taskId+attempt` 的会话日志已上传） | 否 | `taskId` |
| `P-03` | `GET /api/v1/executor/skill-packages/{packageId}` | 取技能包 | 否 | `packageId`（不可变内容） |
| `P-04` | `POST /api/v1/executor/tasks/{taskId}/session-log?attempt=n` | 上传单次尝试的会话日志 | 否 | `taskId + attempt`（后到覆盖） |
| `P-05` | `POST /api/v1/executor/runs/{runId}/archive` | 上传运行归档包（task-space 的 tar.gz） | 否 | `runId`（后到覆盖） |

没有 `register`、`heartbeat`、`claim`、`renew`、`bindSession`、`cleanup` 类端点。

## 3 通用约定

- 传输：HTTP/1.1 或 2，生产必须 HTTPS；`http://` 仅允许 loopback。
- 格式：请求/响应 `application/json; charset=utf-8`；`P-03` 为 `application/zip`；`P-04` 为 `application/x-ndjson` + `Content-Encoding: gzip`；`P-05` 为 `application/gzip`。
- 鉴权：`Authorization: Bearer <token>`；token 绑定 `clientId`，不进 URL、日志、结果。
- 版本：请求头 `X-Executor-Protocol: 3`；不匹配返回 `400 unsupported_protocol`，client 停止并退出。
- 时间：ISO-8601 UTC。**不使用 `serverTime` 做租约计算**（没有租约），时间字段只用于审计。
- 可选请求头 `X-Request-Id`，服务端回显并在错误信封里返回。
- 未知响应字段必须忽略；未知请求字段服务端返回 `400`。
- 二进制请求（`P-04`/`P-05`）必须带 `Content-Length`；服务端先写临时键、校验通过后原子改名，中断不留半包。响应与 `details` 里的 `bytes` 一律是**压缩后**的字节数。
- 常量（不通过接口协商）：

| 常量 | 值 | 约束对象 |
|---|---|---|
| `maxResultBytes` | 262144（256 KiB） | `P-02` 请求体 |
| `maxPromptBytes` | 1048576（1 MiB） | `TaskRequest.prompt`（启动诉求也在这条预算内） |
| `maxSkillPackageBytes` | 67108864（64 MiB） | `P-03` 响应体 |
| `maxSessionLogBytes` | 67108864（64 MiB） | `P-04` 请求体（压缩后） |
| `maxArchiveBytes` | 536870912（512 MiB） | `P-05` 请求体（压缩后） |
| `maxArchiveEntries` | 100000 | `P-05` 解包后的条目数（服务端校验） |
| `maxArchiveUncompressedBytes` | 2147483648（2 GiB） | `P-05` 解包后的总字节数（服务端校验） |
| `maxTasksPerPoll` | 10 | `P-01` 响应 |
| `pollHoldMs` | 30000 | `P-01` 挂起上限 |
| `clientPollTimeoutMs` | 40000 | client 侧超时 |
| `clientSilentMs` | 120000 | `S-02` 静默判定 |
| `resultGraceMs` | 60000 | `S-02` 超时判定 |

### 3.1 错误信封与码表

错误信封沿用 v2：`{ "error": { "code": string, "message": string, "details"?: object }, "requestId"?: string }`。`code` 是稳定英文标识，跨版本不复用含义。

| HTTP | `code` | 触发 |
|---:|---|---|
| 400 | `unsupported_protocol` | `X-Executor-Protocol` 缺失或不等于 `3` |
| 400 | `validation_error` | 请求体未知字段、字段类型/范围非法、`status`/`error.class` 不在闭集 |
| 400 | `invalid_archive` | `P-05` 的 gzip/tar 损坏、含绝对路径/`..`/越界符号链接、超条目或解压总量 |
| 401 | `unauthorized` | Bearer 缺失或 token 未映射到 `clientId` |
| 404 | `task_not_found` | `P-02`/`P-04` 的 `taskId` 不存在或不属于该 client 的实例 |
| 404 | `run_not_found` | `P-05` 的 `runId` 不存在或不属于该 `clientId` |
| 404 | `package_not_found` | `P-03` 的 `packageId` 不存在或已下架 |
| 409 | `session_log_missing` | `P-02` 到达时该 `taskId+attempt` 没有已上传的会话日志 |
| 409 | `invalid_state` | `P-05` 的 run 尚未进入终态 |
| 413 | `payload_too_large` | 结果/日志/归档超过对应上限；`details.limit` 标明对象 |
| 500 | `package_unavailable` | 包文件缺失/损坏 |
| 503 | `service_unavailable` | 数据库或存储不可用 |

- 同键重传**不是**错误：`P-04`/`P-05` 按「后到覆盖」返回 `200`（§4.4 第 4 条、§4.5 第 4 条）。v3 早期草案的 `content_conflict` 已删除，不再出现。

## 4 端点契约

### 4.1 `P-01` 取任务

**用途**：client **持续**调用（无论是否有空位）。有空位就取任务，没空位就只上报 `running`——这条常驻请求同时承担判活，**没有独立的心跳端点**。`free = 0` 时服务端挂起到 `pollHoldMs` 后返回空批。

请求：

```json
{
  "capacity": { "free": 2 },
  "running": [
    {
      "taskId": "01J9Z7Q0M4",
      "instanceId": "0193f0aa-6c31-7c4e-9a4b-0d1e2f3a4b5c",
      "startedAt": "2026-11-10T02:00:00Z",
      "lastEventAt": "2026-11-10T02:03:10Z"
    }
  ],
  "finished": [
    { "taskId": "01J9Z7Q0K1", "attempt": 1, "finishedAt": "2026-11-10T01:58:00Z" }
  ],
  "archivedRuns": ["01J9Z8A1B2"]
}
```

- `capacity.free`：当前还能接几个任务；`free = maxConcurrent - running.length`。
- `running`：**必须**包含该 client 当前所有在跑任务。空也要带 `[]`。
- `finished`：**本地已有结果但尚未拿到 `accepted`** 的任务。空也要带 `[]`。
  作用是防止「结果已算出但上报响应丢失」被 `S-03` 误判为「没收到」而重发，造成重复执行。
- `lastEventAt` 可选：最近一次 ACP 事件时间，供调度器观测「在动」。
- `archivedRuns` 可选：client 已成功上传归档的 `runId` 列表；服务端据此停止下发对应 `archiveRequests`，未知 `runId` 忽略。client 可以在服务端不再下发该 `runId` 后移除本地记录（不设固定保留条数）。

响应 `200`（长轮询 30s 内返回，有任务立即返回）：

```json
{
  "tasks": [
    {
      "taskId": "01J9Z7Q0M4",
      "instanceId": "0193f0aa-6c31-7c4e-9a4b-0d1e2f3a4b5c",
      "nodeId": "0193f0aa-6c31-7c4e-9a4b-0d1e2f3a4b5c",
      "attempt": 1,
      "prompt": "……任务信息 + 输出契约，opaque 文本……",
      "workspacePath": "/abs/instance-a",
      "taskSpacePath": "/abs/instance-a/.agent-flow/task/01J9Z8A1B2",
      "timeoutMs": 1800000,
      "skillSet": { "digest": "sha256:<hex>", "packages": [] }
    }
  ],
  "stop": false,
  "cancelInstances": [],
  "archiveRequests": [
    {
      "runId": "01J9Z8A1B2",
      "instanceId": "0193f0aa-6c31-7c4e-9a4b-0d1e2f3a4b5c",
      "workspacePath": "/abs/instance-a",
      "taskSpacePath": "/abs/instance-a/.agent-flow/task/01J9Z8A1B2"
    }
  ],
  "nextPollAfterMs": 0
}
```

- `tasks.length ≤ min(free, 10)`；`free = 0` 时 `tasks` 必须为空。
- 空结果不返回 204：始终 `200` + `tasks: []`，client 按 `nextPollAfterMs` 决定何时再拉（缺省 0 = 立即再拉，服务端已挂起过一个周期）。
- `stop: true`：完成手上任务后停止领取并退出（优雅停）。
- `cancelInstances: [instanceId]`：中止这些实例的在跑任务，并丢弃 `tasks` 里属于这些实例的条目。
- `archiveRequests`：缺省视为 `[]`；条目含 `runId`、`instanceId`、`workspacePath`、`taskSpacePath`。**电平信号**：同一 `runId` 会持续下发，直到 client 在 `archivedRuns` 中确认或该 run 记录被清理。
- **归档不改变挂起行为**：服务端不因存在待归档 run 而缩短 `pollHoldMs`。唯一例外是某个 `runId` 首次进入待归档状态的那一跳可立即返回一次；之后按正常长轮询挂起。client 在**后台**打包上传，不阻塞 poll，否则会因归档耗时触发 `S-02` 静默重派。
- `stop` / `cancelInstances` / `archiveRequests` 是**电平信号**：调度器会持续下发直到 client 侧生效（`running` 不再包含对应任务 / `archivedRuns` 确认）。

**语义与不变量**

1. `taskId` 是任务的唯一标识（UUIDv7 字符串），重派时不变；`attempt` 单调递增。
2. `prompt` 是 opaque 文本，client 不解析；超过 `maxPromptBytes` 的任务 client 拒绝执行并以 `failed(scheduler)` 上报（此时按不变式 5 先传 0 行空日志）。
3. `workspacePath` 是准备阶段预置的容器根：绝对、存在、可写、位于任何 git 仓库之外；client 只校验，不创建、不 clone。
4. `taskSpacePath` 是本次运行的 task-space：绝对路径、位于 `workspacePath` 之下。client 收到后：校验绝对路径且在 `workspacePath` 之下 → 不存在则 `mkdir -p` 创建 → 建 session。client **只创建目录，不写目录内容**；`intent.md` 等文件由节点内的模型按 prompt 指令写入。
5. 启动诉求**不通过独立字段下发**：编排侧把它写进首个执行节点的 `prompt`，并要求该节点把诉求落到 `<taskSpacePath>/intent.md`；后续节点从 prompt 得知 task-space 路径与「诉求在 intent.md」。`prompt` 总长受 `maxPromptBytes` 约束。
6. `skillSet` 随任务下发；同一容器上并发任务共享同一 `digest`（调度器保证，见 §6 `S-06`）。
7. 空 `skillSet.packages` 表示空技能集：client 清空容器根 `.dsh/skills`。
8. client 收到任务后**必须先登记到本地 in-flight，再发起下一次 poll**（见 `S-03` 的依据）。

**错误**：`400`、`401`、`500`、`503`。`401` 表示凭据失效：client 停止领取并退出（退出码由 client 自定，非 0），不重试。

### 4.2 `P-02` 交结果

**用途**：任务结束时上报结果；client 重启后补报未上报的结果也走这里。**前置**：该 `taskId` 当前 `attempt` 的会话日志已通过 `P-04` 上传（0 行空日志也算）。

请求：

```json
{
  "taskId": "01J9Z7Q0M4",
  "attempt": 1,
  "status": "succeeded",
  "sessionId": "<session-id>",
  "message": "最终消息（可能被截断）",
  "truncated": false,
  "stopReason": "end_turn",
  "usage": { "inputTokens": 1234, "outputTokens": 567 },
  "error": null,
  "startedAt": "2026-11-10T02:00:05Z",
  "finishedAt": "2026-11-10T02:31:20Z"
}
```

失败/取消/超时：

```json
{
  "taskId": "01J9Z7Q0M4",
  "attempt": 1,
  "status": "timeout",
  "sessionId": "<session-id>",
  "message": "已产生的部分输出",
  "truncated": false,
  "stopReason": null,
  "usage": null,
  "error": {
    "class": "timeout",
    "code": "idle_timeout",
    "message": "连续 10 分钟无 ACP 事件"
  },
  "startedAt": "2026-11-10T02:00:05Z",
  "finishedAt": "2026-11-10T02:15:05Z"
}
```

响应 `200`：

```json
{ "taskId": "01J9Z7Q0M4", "accepted": true }
```

- `accepted: false`：任务已结算（重复上报或已被重派后的结果），client 停止重试并丢弃本地副本。
- `404 task_not_found`：任务不存在（调度器侧数据已清理），client 丢弃结果，不重试。
- `409 session_log_missing`：该 `taskId+attempt` 没有会话日志。**任务不结算、不重派**；client 补传 `P-04`（没有事件时传 0 行空日志）后重试同一结果（内容不变）。

**语义与不变量**

1. 同一 `taskId` 以**第一份被接受的结果**为准；后续只回 `accepted=false`，不覆盖。
2. `status` 闭集：`succeeded` / `failed` / `cancelled` / `timeout`。
3. `error` 在 `succeeded` 时为 `null`；其余必填。`class` 闭集：`workspace` / `asset` / `runtime` / `protocol` / `cancelled` / `timeout` / `scheduler` / `internal`。
4. `code` 是组件稳定错误码，保留原值。约定值：
   - `prompt_timeout`（总超时）、`idle_timeout`（无进度看门狗）；
   - `session_log_too_large`：会话日志压缩后超过 `maxSessionLogBytes`，client 已上传 0 行空日志后按 `failed` 上报；
   - `archive_too_large`：归档超过 `maxArchiveBytes`（记录在 run 的 `archive_state`，不进结果体）。
   调度器据 `code` 区分「任务太大」与「疑似卡死」。
5. `message` 只要有输出就填（按 `maxResultBytes` 截断，含截断标记不超过上限），空串只表示确实没有输出。**`review` 节点的 verdict JSON 就在 `message` 的最后一段代码块里**，由服务端解析；client 不解析、不改写。
6. 结果只含控制信息：状态、最终消息、停止原因、用量、session、错误类别；不含产物、会话全文、日志、凭据。
7. 重复上报不要求 `attempt` 一致；以 `taskId` 判定。
8. 已结算任务的重复上报仍按第 1 条返回 `accepted=false`；`session_log_missing` 只用于「尚未结算且缺日志」。

**错误**：`400`、`401`、`404`、`409`、`413`、`500`、`503`。

### 4.3 `P-03` 取技能包

```http
GET /api/v1/executor/skill-packages/<packageId>
Authorization: Bearer <token>
If-None-Match: "sha256-<hex>"
```

- `200 application/zip`：`Content-Length`、`ETag`、`X-Checksum-Sha256`、`Cache-Control: private, max-age=3600`。
- `304 Not Modified`：`ETag` 命中，用本地缓存。
- `404 package_not_found`：包不存在或已下架；client 以 `failed(asset)` 上报，不重试。
- `5xx`：服务端/依赖不可用，client 退避重试；超过阈值以 `failed(asset)` 上报，服务端视为任务失败并自行决定是否重派。

**语义与不变量**

1. `packageId` 对应不可变内容：内容变必须换 `packageId`。
2. client 下载后必须校验 `X-Checksum-Sha256`（或 manifest `digest`）与 `sizeBytes`；不匹配重试一次，仍失败以 `failed(asset)` 上报。
3. 下载前按 `sizeBytes` 与 `maxSkillPackageBytes` 预检；超限中止，不写工作区。
4. 解压必须防路径穿越与越界符号链接；只在容器内 staging 目录解压，成功后原子替换 `.dsh/skills`。
5. 同 `digest` 且 `.dsh/skills` 已存在 → 跳过下载与替换（热路径，1000 个任务里 999 个走这里）。
6. `downloadUrl` 若指向调度器以外 host，必须是短期签名 URL；client 不发 `Authorization` 给第三方 host。

### 4.4 `P-04` 上传会话日志

**用途**：节点每次尝试结束后，把该次尝试的 ACP 事件流传给服务端。**先传日志、再报结果**；日志是服务端唯一的会话全文来源（结果体只带截断后的最终消息）。

```http
POST /api/v1/executor/tasks/<taskId>/session-log?attempt=1
Authorization: Bearer <token>
X-Executor-Protocol: 3
Content-Type: application/x-ndjson
Content-Encoding: gzip
Content-Length: <bytes>
```

响应 `200`：

```json
{ "taskId": "…", "attempt": 1, "bytes": 12345, "sha256": "…", "stored": "created" }
```

**语义与不变量**

1. 内容：该次尝试的 ACP 事件流，JSON Lines 一行一个事件，gzip 压缩；服务端**不解析内容**，只校验 gzip 头、大小并计算 sha256。**完整透传、不脱敏**；排障时离线解析（已接受风险，见 `plan/risks.md`）。
2. 允许 0 行：没有任何 ACP 事件的尝试（session 建立前的失败、取消）必须上传一份 0 行 gzip ndjson，而不是跳过。
3. 归属：`taskId` 必须属于该 token 解析出的 `clientId`；未知或不属于 → `404 task_not_found`，client 丢弃该次上传与结果，停止重试。
4. **幂等：后到覆盖**。同 `taskId+attempt` 重复上传一律 `200`；`stored` 取 `created` / `replaced` / `unchanged`（内容与已存字节相同）。服务端用「最后到达的一份」作为该尝试的日志，不做内容比对、不返回冲突。这样客户端重试或重启后**可以重新压缩、重新上传**，无需持久化首次压缩字节。
5. 大小：压缩后超过 `maxSessionLogBytes` → `413`，不落盘。client 的处理顺序：先上传 0 行空日志（保证结果可被接受）→ 再以 `failed` 上报结果，`error.code=session_log_too_large`。真实日志不保留，任务按失败结算。
6. 存储键由服务端拼接：`runs/<runId>/nodes/<nodeId>-<visit>-a<attempt>.jsonl.gz`（重派产生新 attempt，各自一份）；client 不提供任何路径分量。
7. 日志与结果相互独立：日志上传成功不代表任务成功；任务成功必须有结果，结果接受必须有日志。

**错误**：`400`、`401`、`404`、`413`、`500`、`503`。

### 4.5 `P-05` 上传运行归档

**用途**：run 进入终态后，client 在**后台**把整个 task-space 打包上传，服务端归档为 `history/<instanceId>/<runId>/`。

```http
POST /api/v1/executor/runs/<runId>/archive
Authorization: Bearer <token>
X-Executor-Protocol: 3
Content-Type: application/gzip
Content-Length: <bytes>
```

响应 `200`：

```json
{ "runId": "…", "bytes": 123456, "sha256": "…", "stored": "created" }
```

**语义与不变量**

1. 内容：对 `taskSpacePath` 打的 tar.gz，条目路径为相对 task-space 根。client 用 `archiveRequests[].taskSpacePath` 作为打包根，用 `workspacePath` 做「根在工作区之下」的校验。
2. 前置：run 必须已进入终态（`succeeded` / `failed` / `cancelled`）；否则 `409 invalid_state`。
3. 安全校验（服务端）：拒绝绝对路径、含 `..` 的段与越界符号链接；条目数 ≤ `maxArchiveEntries`；解压总量 ≤ `maxArchiveUncompressedBytes`；每个常规文件拼接后的绝对路径必须仍在归档根之下。任一失败 → `400 invalid_archive`。
4. **幂等：后到覆盖**。同 `runId` 重复上传一律 `200`；`stored` 取 `created` / `replaced` / `unchanged`。允许 client 重新打包（tar/gzip 时间戳不同也不影响），无需持久化首次字节。
5. 大小：压缩后超过 `maxArchiveBytes` → `413`，不落盘；run 的 `archive_state` 置 `failed`，client 停止重试并记录 `archive_too_large`。
6. 归属：`runId` 不存在或所属实例不绑定该 `clientId` → `404 run_not_found`，client 丢弃并停止重试。
7. 落盘路径全部由服务端拼接，不使用 client 提供的任何路径分量。
8. 归档不阻塞 run 终态；归档失败不回退 run 状态。**归档在后台执行**，不阻塞 poll；`archivedRuns` 在下次 poll 确认。

**错误**：`400`、`401`、`404`、`409`、`413`、`500`、`503`。

## 5 类型

```ts
type PollRequest = {
  capacity: { free: number };          // ≥0
  running: RunningTask[];
  finished: FinishedTask[];            // 已有结果、尚未 accepted
  archivedRuns?: string[];             // 已成功上传归档的 runId
};

type RunningTask = {
  taskId: string;
  instanceId: string;
  startedAt: string;                   // ISO-8601
  lastEventAt?: string;                // 最近一次 ACP 事件；可选
};

type FinishedTask = {
  taskId: string;
  attempt: number;
  finishedAt: string;                  // 本地结果产生时间
};

type PollResponse = {
  tasks: TaskRequest[];                // ≤ min(free, 10)
  stop: boolean;
  cancelInstances: string[];
  archiveRequests: ArchiveRequest[];   // 缺省视为 []
  nextPollAfterMs: number;             // 0 = 立即再拉
};

type ArchiveRequest = {
  runId: string;
  instanceId: string;
  workspacePath: string;               // 绝对路径；用于根内校验
  taskSpacePath: string;               // 绝对路径；tar 的打包根
};

type TaskRequest = {
  taskId: string;
  instanceId: string;
  nodeId: string;
  attempt: number;                     // ≥1，重派递增
  prompt: string;                      // opaque；启动诉求已并入首个节点的 prompt
  workspacePath: string;               // 绝对路径
  taskSpacePath: string;               // 绝对路径，位于 workspacePath 之下；client 只建目录
  timeoutMs: number;                   // >0
  skillSet: SkillSet;
};

type SkillSet = {
  digest: string;                      // sha256:<hex>，规范化由调度器定义
  packages: SkillPackage[];
};

type SkillPackage = {
  packageId: string;
  name: string;
  version: string;
  digest: string;                      // sha256:<hex>
  sizeBytes: number;
  downloadUrl: string;                 // 相对路径或绝对 URL
  etag?: string;
};

type TaskResult = {
  taskId: string;
  attempt: number;
  status: "succeeded" | "failed" | "cancelled" | "timeout";
  sessionId?: string;
  message: string;
  truncated: boolean;
  stopReason: string | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  error: TaskError | null;
  startedAt?: string;
  finishedAt?: string;
};

type TaskError = {
  class: "workspace" | "asset" | "runtime" | "protocol"
       | "cancelled" | "timeout" | "scheduler" | "internal";
  code: string;                        // 约定值见 §4.2 #4
  message: string;                     // 不含凭据/全文
};

type ResultAck = { taskId: string; accepted: boolean };

type SessionLogAck = {
  taskId: string;
  attempt: number;
  bytes: number;                       // 压缩后
  sha256: string;
  stored: "created" | "replaced" | "unchanged";
};

type ArchiveAck = {
  runId: string;
  bytes: number;                       // 压缩后
  sha256: string;
  stored: "created" | "replaced" | "unchanged";
};
```

## 6 调度器职责（`S-01`…`S-08`）

| ID | 职责 |
|---|---|
| `S-01` | **任务列表状态**：`queued` → `dispatched` → `done`；同一 `taskId` 同一时刻只 `dispatched` 给一个 client |
| `S-02` | **重派**：`dispatched` 且未回报，满足「超过 `timeoutMs + resultGraceMs`」或「该 client 静默超过 `clientSilentMs`」→ 回到 `queued`，`attempt + 1`。**已收到失败/超时结果的任务不再自动重派**（v2 措辞为「由调度器按重试策略决定」，v3 固定为不重派） |
| `S-03` | **未确认重发**：`taskId` 已派给 client C，但既不在 C 的 `running[]`、也不在 `finished[]`、也未回报 → 下一跳把同一 `taskId` 再放进 `tasks`。这是「响应丢失」的唯一兜底，不需要幂等键；`finished[]` 的存在保证「结果已算出但上报响应丢失」不会被误重发 |
| `S-04` | **容量**：`tasks.length ≤ min(free, maxTasksPerPoll)`，不超卖 |
| `S-05` | **任务内容稳定**：同一 `taskId` 重派时 `prompt` / `skillSet` / `workspacePath` / `taskSpacePath` 不变，只递增 `attempt` |
| `S-06` | **同容器技能集一致**：同一 `instanceId` 上同时 `dispatched` 的任务，`skillSet.digest` 必须相同 |
| `S-07` | **电平控制**：`stop` / `cancelInstances` / `archiveRequests` 持续下发，直到 client 侧生效；`archiveRequests` 不缩短 `pollHoldMs`（首次下发的同一跳可立即返回一次） |
| `S-08` | **结果接受**：同一 `taskId` 第一份结果为准；后续回 `accepted=false`；未知 `taskId` 回 404 |

补充：结果接受前必须校验会话日志（§1 不变式 5，允许 0 行）；日志缺失不结算、不重派。归档指令由运行编排侧发起，调度器只负责在 `poll` 响应里透传与回收确认。

## 7 客户端承诺（`C-01`…`C-12`）

| ID | 承诺 |
|---|---|
| `C-01` | 收到任务先登记 in-flight，再发起下一次 poll；`running` 必须列出全部在跑任务，`finished` 必须列出全部「有结果未确认」的任务 |
| `C-02` | 一个任务一个 session；`maxConcurrent` 由本地配置决定，`free` 如实上报 |
| `C-03` | 先装技能集再 prompt；同 `digest` 幂等短路；同一容器同一时刻只有一个安装临界区 |
| `C-04` | 结果**先落盘再上报**；上报失败只重试传输，不重跑；拿到 `accepted` 前该任务一直留在 `finished`；重启后补报 |
| `C-05` | `timeoutMs` 到点终止：`session/cancel` → `session/close` → `SIGKILL` 进程组；结果 `timeout`，`message` 带已产生输出 |
| `C-06` | 无进度看门狗（`idle_timeout`）：连续 N 分钟无 ACP 事件则按 `C-05` 终止；`N` 由本地配置决定，**默认关闭** |
| `C-07` | `stop: true` → 停止领取、跑完手上任务后退出 0；`cancelInstances` 命中的任务 → 中止并上报 `cancelled`（未建 session 时按 `C-11` 传空日志） |
| `C-08` | 结果只传控制信息；产物、会话全文、日志不进结果；结果超 `maxResultBytes` 截断并置 `truncated`。会话全文由 `C-11` 单独上传 |
| `C-09` | 启动时清理上次残留进程组（按 pgid 或作业对象），不杀其他实例的进程 |
| `C-10` | 收到任务后校验 `taskSpacePath` 为绝对路径且位于 `workspacePath` 之下；不存在则创建目录；**只建目录、不写目录内容**（`intent.md` 等由节点内模型写）；所有读写限制在 task-space 与工作区内 |
| `C-11` | 节点结束**先上传 `P-04`、拿到 `200` 后再报结果**；每个 `attempt` 必须有一份日志，无事件时传 0 行 gzip ndjson；日志上传失败按传输重试，不重跑任务；同键重传可直接重新压缩（服务端后到覆盖） |
| `C-12` | 收到 `archiveRequests` 后**在后台**打包上传 `P-05`，不阻塞 poll；成功后在下一次 poll 的 `archivedRuns` 回报；失败可重试，本地 task 目录保留不删除 |

## 8 失败与恢复矩阵

| 场景 | 谁发现 | client | 调度器 / 编排 | 结果 |
|---|---|---|---|---|
| 正常完成 | client | 先传日志，再报 `succeeded` | 标的 done，派下一条 | — |
| 任务超时 | client | `C-05` 终止，传日志后报 `timeout` | 接受结果 | 任务结束（不自动重跑） |
| 卡住但进程活着 | client 看门狗 / 调度器 `S-02` | `C-05` 或被杀后由调度器重派 | `S-02` 回队 | 可能重复执行 |
| client 进程崩溃 | 调度器 `S-02` | 重启后清孤儿、补传日志、补报已有结果 | 静默 120s 后回队 | 未完成的任务重派 |
| poll 响应丢失 | 调度器 `S-03` | 未登记即未收到 | 下一跳重发同一 `taskId` | 无重复执行 |
| 结果上报失败 / 响应丢失 | client + `S-03` | 重试（本地已落盘），并列进 `finished` | 见到 `finished` 里的 taskId 就不再重发 | 不重跑、不重复 |
| 结果重复上报 | 调度器 `S-08` | 收到 `accepted=false` 后丢弃 | 首份为准 | — |
| 建立 session 前失败（prompt 超限/workspace/asset/spawn/取消） | client | 传 0 行空日志，再报 `failed`/`cancelled` | 正常接受 | 任务结算，不卡死 |
| 日志未传就报结果 | 服务端 | 收 `409 session_log_missing`，补传后重试结果 | 不结算、不重派 | 任务继续 |
| 日志上传中断 | client | 重试同一份或重新压缩后上传 | 未完成的临时键不生效；重传覆盖 | 幂等重试 |
| 日志超 64 MiB | 服务端 | 收 `413`，先传 0 行空日志，再报 `failed(session_log_too_large)` | 任务按失败结算 | 真实日志不保留（已接受风险） |
| 日志与结果之间崩溃 | client 重启 | 从本地 `finished` 状态补传日志再补报结果 | 结果仍可接受 | 不重跑 |
| 重派后旧副本复活并先交结果 | 调度器 `S-08` | — | 旧结果被接受，新副本结果被忽略 | 一次浪费，可接受 |
| 调度器重启 | 自身 | 继续 poll | 从持久化任务表恢复；`dispatched` 按 `running[]` 对账 | 最多一个 `clientSilentMs` 的延迟 |
| 停止 / 取消 | 调度器 `S-07` | `C-07` | 持续下发直到生效 | — |
| run 终态但 client 离线 | 编排侧 | 下次 poll 收到 `archiveRequests` 再补传 | 归档保持 `pending`，不阻塞 run | 可补 |
| 归档超过上限 | 服务端 | 收 `413`，记 `archive_too_large`，停止重试 | `archive_state=failed` | 运维处理 |
| 归档包损坏/路径穿越 | 服务端 | 收 `400 invalid_archive`，停止重试（包本身有问题） | 不落盘 | 运维处理 |
| 归档后台打包耗时 | — | poll 照常进行，心跳不断 | 不因归档缩短挂起 | 不会被误判静默 |

## 9 容量、并发与终止

- **容量**：只由 `capacity.free` 表达。`maxConcurrent` 是 client 本地配置，调度器从 `free` 推断，不做二次限制。
- **并发**：同一 `instanceId` 上允许多个任务同时执行，前提是 `S-06` 的同 digest 与 `C-03` 的安装临界区。
- **产品侧约束**（不属于本契约的传输语义，但影响任务分布）：同一工作区同时只推进一个运行的节点任务；例外是 `fanout` 内部展开的多个任务，它们同属一个 run、共用同一专家与技能集。
- **终止上界**：`timeoutMs` 是契约要求；`idle_timeout` 是可选优化（`C-06`），默认关闭，避免误杀长工具调用。
- **清理**：本契约**没有清理指令**。工作区与 task-space 默认保留（分析产物是重跑的基础；归档依赖该目录）；实例不再需要时由运维按 `instanceId` 回收。`keep` / `clean-skills` / `clean-client` 等本地清理策略**不覆盖** `.agent-flow/task`。

## 10 联调与验收

### 10.1 桩调度器最小面

1. 批量下发：`free=3` 返回 ≤3 条；`free=0` 返回空。
2. 长轮询：无任务挂起 30s 后返回空；有任务立即返回；归档首次下发的那一跳可立即返回，之后仍挂起。
3. 重复派发：同一 `taskId` 在 `S-03` 条件下二次下发。
4. 静默回队：client 停止 poll 120s 后任务回队并重派。
5. 超时回队：任务超过 `timeoutMs + 60s` 未回报 → 回队，`attempt + 1`。
6. 结果：首份 `accepted=true`；第二份 `accepted=false`；未知 `taskId` 404；缺日志 409。
7. 控制：`stop`、`cancelInstances`、`archiveRequests` 电平下发直到生效。
8. 制品：304 命中、404 缺包、digest 不匹配。
9. 日志：先传后报通过；缺日志 409；0 行空日志可结算；同键重传覆盖且返回 `stored`；超 64 MiB 413。
10. 归档：终态前 409；路径穿越 400；超 512 MiB 413；同 run 重传覆盖；`archiveRequests` 不缩短挂起。

### 10.2 client 门禁

- 并发 N：`free` 如实上报，N 个任务并行、各自 settle；
- 结果先落盘后上报：kill -9 后重启能补报，不重跑；
- 日志先于结果：kill 在两步之间，重启后能补传日志再补报；
- 空日志：session 建立前失败与取消都能结算，不卡 409；
- task-space：收到任务后目录存在；client 不写 `intent.md`（由 start 节点模型写）；
- 归档：后台打包上传，poll 心跳不断；`archivedRuns` 确认；本地目录保留；
- 取消/超时后进程组无残留（`kill -0` 为假）；
- 1000 任务吞吐：同一技能集只装一次，后续走 digest 短路；
- 技能集切换：不同 digest 的任务串行安装，不交错；
- `stop` 后优雅退出 0，第二次信号强退。

## 11 与 v2 的差异

### 11.1 新增

| 项 | 内容 |
|---|---|
| `P-04` | 会话日志上传；结果接受前置；允许 0 行空日志 |
| `P-05` | 运行归档上传；终态前置；后台执行 |
| `TaskRequest.taskSpacePath` | 必填；client 只建目录 |
| `PollRequest.archivedRuns` / `PollResponse.archiveRequests` | 归档电平与确认；`ArchiveRequest` 含 `workspacePath` |
| 错误码 | `session_log_missing`、`run_not_found`、`invalid_state`、`invalid_archive` |
| 结果 `error.code` 约定值 | `session_log_too_large`；归档超限记 `archive_too_large`（`archive_state`，不进结果体） |
| 常量 | `maxSessionLogBytes`、`maxArchiveBytes`、`maxArchiveEntries`、`maxArchiveUncompressedBytes` |
| 承诺 | `C-10`（task-space）、`C-11`（日志先于结果 + 空日志）、`C-12`（后台归档） |

### 11.2 修改

| 项 | v2 | v3 |
|---|---|---|
| 协议版本 | `2` | `3` |
| `S-02` | 失败/超时结果「是否再回 `queued` 由调度器按重试策略决定」 | 固定为**不自动重派**；只有「未回报」才回队 |
| `S-05` | `prompt`/`skillSet`/`workspacePath` 不变 | 再加 `taskSpacePath` 不变 |
| `S-07` | `stop` / `cancelInstances` | 增加 `archiveRequests`；且不缩短 `pollHoldMs` |
| `C-06` | 「由调度器按任务类型在 prompt/配置中约定后再开」 | 只由 client 本地配置决定，默认关闭 |
| `C-08` | 会话全文不出本机 | 结果仍只含控制信息；会话全文按 `C-11` 上传 |
| §9 并发 | 同实例允许并发任务 | 仍允许；补充「同一工作区同时只推进一个 run」的产品侧约束 |

### 11.3 未改变

端点语义 `P-03` 制品、结果字段与错误信封、重派与对账规则、`S-01`/`S-03`/`S-04`/`S-06`/`S-08`、`C-01`–`C-05`、`C-07`、`C-09`、容量与终止上界、无清理指令。

### 11.4 2026-11-12 修订（client 评审闭环）

| 编号 | 修订 |
|---|---|
| `B-01` | 日志超限不再形成死锁：client 先传 0 行空日志，再报 `failed(session_log_too_large)`；任务正常结算，真实日志不保留（已接受风险） |
| `B-02` | 每个 `attempt` 必须有日志，允许 0 行；早失败与取消都先传空日志（§1 不变式 5、§4.4 #2、`C-11`） |
| `B-03` | `P-04`/`P-05` 改为「后到覆盖」，不要求持久化首次压缩字节；删除 `content_conflict` 错误码 |
| `B-04` | 归档改后台执行，不阻塞 poll；`S-07` 明确 `archiveRequests` 不缩短挂起（§4.1、§6、`C-12`） |
| `D-01` | 冲突不再二选一：同键重传直接覆盖（`stored` 字段说明结果） |
| `D-02` | `archivedRuns` 保留到服务端不再下发该 `runId`，不设固定上限 |
| `D-03` | `ArchiveRequest` 增 `workspacePath` |
| `D-04` | `C-10` 改为「只建目录，不写内容」；`intent.md` 由 start 节点模型写；删除 `TaskRequest.intentMarkdown` 与 `maxIntentBytes` |
| `D-05` | 日志完整透传、不脱敏，服务端只存不解析；风险记入 `plan/risks.md` |
| `D-06` | 新增 `session_log_too_large`、`archive_too_large` 两个结果/归档错误码 |
| `D-07` | 升级时丢弃 v2 遗留的 `settled` 结果（client 启动迁移逻辑；契约侧无需字段） |
| `D-08` | §11.2/§11.3 按正文修正（`S-02`、`S-07`、`C-06`、`C-08`） |
| `D-09` | 清理策略不覆盖 `.agent-flow/task`（§9） |
| `D-10` | 归档确认后仍保留本地 task-space（`C-12`） |
| `H-01` | 响应与 `details` 的 `bytes` 明确为压缩后大小 |
| `H-02` | `P-04` 的 `404 task_not_found` → client 丢弃上传与结果，停止重试 |

## 12 待定与已接受风险

1. `maxConcurrent` 的默认值（建议 2–4，按机器核数）。
2. `idle_timeout` 的默认阈值与是否由调度器按任务类型下发（默认关闭）。
3. 任务列表规模的上界（几十 vs 上千）对调度器侧批量下发的影响。
4. 会话日志与归档的保留期、配额与清理（`OQ-27`）。
5. 归档是否分包（当前单包，超限即失败）。
6. **已接受风险：日志超限丢真实日志**。`maxSessionLogBytes` 是按 64 MiB 估的；一旦单节点日志超过它，该尝试的真实日志不会保留，任务以 `failed(session_log_too_large)` 结算。等真实数据出现再调阈值或改截断策略。
7. **已接受风险：日志含敏感信息**。日志完整透传、不脱敏；工作区里的凭据、工具输出都可能进日志。归档目录按运维规范限制访问。
8. **已接受风险：同键重传后到覆盖**。理论上较晚的重传会替换较早内容（同一 client、同一 attempt/run），可能让日志/归档与当时的结果不完全对应。

## 13 版本演进

- `X-Executor-Protocol` 用整数；不匹配即 `400 unsupported_protocol`，不做兼容窗口。
- 加法（新可选字段）不升版本；删字段、改语义、改必填性升整数。
- 当前版本 `3`。v2 已归档，不再维护双版本并行期；双端同批升级。
