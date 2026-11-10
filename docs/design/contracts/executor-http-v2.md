---
layer: design
module: execution-plane
status: current
updated: 2026-11-10
contract: executor-http-v2
protocolVersion: 2
---

# 执行面契约 v2：任务下发与结果回收

> 权威在调度器侧：`agent-flow-orchaster/docs/works/2026-11-10-executor-contract-v2/contract-v2.md`（2026-11-10）。
> 本文件是 client 仓库的现行副本，字段与语义以调度器侧为准；双方冲突时按调度器侧修订本副本。
> v1（`executor-http-v1.md`，`protocolVersion = 2026-11-07.1`）已归档到 `docs/history/works/2026-11-10-contract-v2-migration/`，不再作为设计依据。

> 前提：调度器侧对 v1 尚无实现（2026-11-10 核实），因此本版不做 v1 兼容，直接替换。
> client 侧状态：已按本契约改造（见 `docs/works/2026-11-10-contract-v2-migration/`）。

## 0. 一句话

调度器维护一张任务列表，client 拉取任务、执行、回报结果、再拉下一条。**保证 at-least-once：每个任务最终会被下发并跑完；允许重复执行，允许中断后重跑。**

只有三个端点：`poll`（取任务 + 上报在跑状态 + 收停止/取消）、`result`（交结果）、`skill-packages`（取制品）。

## 1. 模型与不变式

```
调度器                                       client
任务列表 queued → dispatched → done
  │ POST /poll {free, running[], finished[]}   │
  │ ──────────────────────────────────────────▶│  常驻长轮询：没空位时只上报状态
  │◀─ tasks[] / stop / cancelInstances ────────│
  │                                            │  每个任务 = 一个技能集 + 一个 session
  │ POST /tasks/{taskId}/result                │
  │◀───────────────────────────────────────────│
  │  首份结果为准 → done → 取下一条            │
  │  GET /skill-packages/{packageId}           │  同 digest 短路，1000 个任务装一次
```

四条不变式：

1. **任务原子性**：一个 `taskId` 对应一次 session 执行；同 `taskId` 的 prompt / 技能集 / 工作区在重派时保持不变。
2. **至多一个「在跑」副本被认可**：调度器同一时刻只把 `taskId` 派给一个 client；超时或失联后才重派（重派可能与旧副本重叠，属可接受成本）。
3. **结果一次性**：同一 `taskId` 的第一份结果为准，后续只回 `accepted=false`。
4. **有界执行**：每个任务都必须有一个客户端可执行的终止上界（`timeoutMs`），不依赖模型或工具自行返回。

### 1.1 明确放弃的保证

| 保证 | 为什么可以放弃 | 代价 |
|---|---|---|
| exactly-once | 分析任务可重跑，工作区留有痕迹，agent 能识别 | 极端情况下同一任务跑两次，浪费 token |
| 控制指令有序、至少一次、断连补发 | 停止/取消用「当前期望状态」表达，丢一次下一跳还会带 | 停止生效延迟最多一个 poll 周期 |
| 崩溃后状态补偿（清理意图跨重启） | client 默认保留工作区，清理是运维动作 | 容器/目录需要人工或运维脚本回收 |
| 迟到结果审计 | 任务已 done，旧结果无价值 | 无 |
| 单实例单写者 | 任务按模块/调用链拆分；撞车时工具写前会重读 | 偶发 last-write-wins |

## 2. 端点总表

| ID | 方法 / 路径 | 用途 | 长轮询 | 幂等键 |
|---|---|---|---|---|
| `P-01` | `POST /api/v1/executor/poll` | 取任务 + 上报在跑状态 + 收停止/取消 | 30s | 无（见 §7 `S-03` 的对账规则） |
| `P-02` | `POST /api/v1/executor/tasks/{taskId}/result` | 交结果 | 否 | `taskId` |
| `P-03` | `GET /api/v1/executor/skill-packages/{packageId}` | 取技能包 | 否 | `packageId`（不可变内容） |

没有 `register`、`heartbeat`、`claim`、`renew`、`bindSession`、`cleanup` 类端点。

## 3. 通用约定

- 传输：HTTP/1.1 或 2，生产必须 HTTPS；`http://` 仅允许 loopback。
- 格式：请求/响应 `application/json; charset=utf-8`，`P-03` 为 `application/zip`。
- 鉴权：`Authorization: Bearer <token>`；token 绑定 `clientId`，不进 URL、日志、结果。
- 版本：请求头 `X-Executor-Protocol: 2`；不匹配返回 `400 unsupported_protocol`，client 停止并退出。
- 时间：ISO-8601 UTC。**不使用 `serverTime` 做租约计算**（v2 没有租约），时间字段只用于审计。
- 可选请求头 `X-Request-Id`，服务端回显并在错误信封里返回。
- 未知响应字段必须忽略；未知请求字段服务端返回 `400`。
- 常量（不通过接口协商）：

| 常量 | 值 |
|---|---|
| `maxResultBytes` | 262144（256 KiB） |
| `maxPromptBytes` | 1048576（1 MiB） |
| `maxSkillPackageBytes` | 67108864（64 MiB） |
| `maxTasksPerPoll` | 10 |
| `pollHoldMs` | 30000 |
| `clientPollTimeoutMs` | 40000 |
| `clientSilentMs` | 120000 |
| `resultGraceMs` | 60000 |

## 4. 端点契约

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
  ]
}
```

- `capacity.free`：当前还能接几个任务；`free = maxConcurrent - running.length`。
- `running`：**必须**包含该 client 当前所有在跑任务。空也要带 `[]`。
- `finished`：**本地已有结果但尚未拿到 `accepted`** 的任务。空也要带 `[]`。
  作用是防止「结果已算出但上报响应丢失」被 `S-03` 误判为「没收到」而重发，造成重复执行。
- `lastEventAt` 可选：最近一次 ACP 事件时间，供调度器观测「在动」。

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
      "timeoutMs": 1800000,
      "skillSet": { "digest": "sha256:<hex>", "packages": [] }
    }
  ],
  "stop": false,
  "cancelInstances": [],
  "nextPollAfterMs": 0
}
```

- `tasks.length ≤ min(free, 10)`；`free = 0` 时 `tasks` 必须为空。
- 空结果不返回 204：始终 `200` + `tasks: []`，client 按 `nextPollAfterMs` 决定何时再拉（缺省 0 = 立即再拉，服务端已挂起过一个周期）。
- `stop: true`：完成手上任务后停止领取并退出（优雅停）。
- `cancelInstances: [instanceId]`：中止这些实例的在跑任务，并丢弃 `tasks` 里属于这些实例的条目。
- `stop` / `cancelInstances` 是**电平信号**：调度器会持续下发直到 client 的 `running` 不再包含对应任务。

**语义与不变量**

1. `taskId` 是任务的唯一标识（UUIDv7 字符串），重派时不变；`attempt` 单调递增。
2. `prompt` 是 opaque 文本，client 不解析；超过 `maxPromptBytes` 的任务 client 拒绝执行并以 `failed(scheduler)` 上报。
3. `workspacePath` 是准备阶段预置的容器根：绝对、存在、可写、位于任何 git 仓库之外；client 只校验，不创建、不 clone。
4. `skillSet` 随任务下发；同一容器上并发任务共享同一 `digest`（调度器保证，见 §6 `S-06`）。
5. 空 `skillSet.packages` 表示空技能集：client 清空容器根 `.dsh/skills`。
6. client 收到任务后**必须先登记到本地 in-flight，再发起下一次 poll**（见 `S-03` 的依据）。

**错误**：`400`、`401`、`500`、`503`。`401` 表示凭据失效：client 停止领取并退出（退出码由 client 自定，非 0），不重试。

### 4.2 `P-02` 交结果

**用途**：任务结束时上报结果；client 重启后补报未上报的结果也走这里。

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

**语义与不变量**

1. 同一 `taskId` 以**第一份被接受的结果**为准；后续只回 `accepted=false`，不覆盖。
2. `status` 闭集：`succeeded` / `failed` / `cancelled` / `timeout`。
3. `error` 在 `succeeded` 时为 `null`；其余必填。`class` 闭集：`workspace` / `asset` / `runtime` / `protocol` / `cancelled` / `timeout` / `scheduler` / `internal`。
4. `code` 是组件稳定错误码，保留原值。两个约定值：`prompt_timeout`（总超时）、`idle_timeout`（无进度看门狗）。调度器据 `code` 区分「任务太大」与「疑似卡死」，重试策略不同。
5. `message` 只要有输出就填（按 `maxResultBytes` 截断，含截断标记不超过上限），空串只表示确实没有输出。
6. 结果只含控制信息：状态、最终消息、停止原因、用量、session、错误类别；不含产物、会话全文、日志、凭据。
7. 重复上报不要求 `attempt` 一致；以 `taskId` 判定。

**错误**：`400`、`401`、`404`、`413`、`500`、`503`。

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

## 5. 类型

```ts
type PollRequest = {
  capacity: { free: number };          // ≥0
  running: RunningTask[];
  finished: FinishedTask[];            // 已有结果、尚未 accepted
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
  nextPollAfterMs: number;             // 0 = 立即再拉
};

type TaskRequest = {
  taskId: string;
  instanceId: string;
  nodeId: string;
  attempt: number;                     // ≥1，重派递增
  prompt: string;                      // opaque
  workspacePath: string;               // 绝对路径
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
  code: string;
  message: string;                     // 不含凭据/全文
};

type ResultAck = { taskId: string; accepted: boolean };
```

## 6. 调度器职责（`S-01`…`S-08`）

| ID | 职责 |
|---|---|
| `S-01` | **任务列表状态**：`queued` → `dispatched` → `done`；同一 `taskId` 同一时刻只 `dispatched` 给一个 client |
| `S-02` | **重派**：`dispatched` 且未回报，满足「超过 `timeoutMs + resultGraceMs`」或「该 client 静默超过 `clientSilentMs`」→ 回到 `queued`，`attempt + 1`。已收到失败/超时结果的任务，是否再回 `queued` 由调度器按重试策略决定（`attempt + 1`） |
| `S-03` | **未确认重发**：`taskId` 已派给 client C，但既不在 C 的 `running[]`、也不在 `finished[]`、也未回报 → 下一跳把同一 `taskId` 再放进 `tasks`。这是「响应丢失」的唯一兜底，不需要幂等键；`finished[]` 的存在保证「结果已算出但上报响应丢失」不会被误重发 |
| `S-04` | **容量**：`tasks.length ≤ min(free, maxTasksPerPoll)`，不超卖 |
| `S-05` | **任务内容稳定**：同一 `taskId` 重派时 `prompt` / `skillSet` / `workspacePath` 不变，只递增 `attempt` |
| `S-06` | **同容器技能集一致**：同一 `instanceId` 上同时 `dispatched` 的任务，`skillSet.digest` 必须相同 |
| `S-07` | **电平控制**：`stop` / `cancelInstances` 持续下发，直到 client 的 `running[]` 不再包含对应任务 |
| `S-08` | **结果接受**：同一 `taskId` 第一份结果为准；后续回 `accepted=false`；未知 `taskId` 回 404 |

## 7. 客户端承诺（`C-01`…`C-09`）

| ID | 承诺 |
|---|---|
| `C-01` | 收到任务先登记 in-flight，再发起下一次 poll；`running` 必须列出全部在跑任务，`finished` 必须列出全部「有结果未确认」的任务 |
| `C-02` | 一个任务一个 session；`maxConcurrent` 由本地配置决定，`free` 如实上报 |
| `C-03` | 先装技能集再 prompt；同 `digest` 幂等短路；同一容器同一时刻只有一个安装临界区 |
| `C-04` | 结果**先落盘再上报**；上报失败只重试传输，不重跑；拿到 `accepted` 前该任务一直留在 `finished`；重启后补报 |
| `C-05` | `timeoutMs` 到点终止：`session/cancel` → `session/close` → `SIGKILL` 进程组；结果 `timeout`，`message` 带已产生输出 |
| `C-06` | 无进度看门狗（`idle_timeout`）：连续 N 分钟无 ACP 事件则按 `C-05` 终止；`N` 由本地配置决定，**默认关闭**，由调度器按任务类型在 `prompt`/配置中约定后再开 |
| `C-07` | `stop: true` → 停止领取、跑完手上任务后退出 0；`cancelInstances` 命中的任务 → 中止并上报 `cancelled` |
| `C-08` | 只传控制信息；产物、会话全文、日志不出本机；结果超 `maxResultBytes` 截断并置 `truncated` |
| `C-09` | 启动时清理上次残留进程组（按 pgid 或作业对象），不杀其他实例的进程 |

## 8. 失败与恢复矩阵

| 场景 | 谁发现 | client | 调度器 | 结果 |
|---|---|---|---|---|
| 正常完成 | client | 上报 `succeeded` | 标 done，派下一条 | — |
| 任务超时 | client | `C-05` 终止，报 `timeout` | 按 `S-08` 接受 | 任务结束（是否重跑由调度器决定） |
| 卡住但进程活着 | client 看门狗 / 调度器 `S-02` | `C-05` 或被杀后由调度器重派 | `S-02` 回队 | 可能重复执行 |
| client 进程崩溃 | 调度器 `S-02` | 重启后清孤儿、补报已有结果 | 静默 120s 后回队 | 未完成的任务重派 |
| poll 响应丢失 | 调度器 `S-03` | 未登记即未收到 | 下一跳重发同一 `taskId` | 无重复执行 |
| 结果上报失败 / 响应丢失 | client + `S-03` | 重试（本地已落盘），并列进 `finished` | 见到 `finished` 里的 taskId 就不再重发 | 不重跑、不重复 |
| 结果重复上报 | 调度器 `S-08` | 收到 `accepted=false` 后丢弃 | 首份为准 | — |
| 重派后旧副本复活并先交结果 | 调度器 `S-08` | — | 旧结果被接受，新副本结果被忽略 | 一次浪费，可接受 |
| 调度器重启 | 自身 | 继续 poll | 从持久化任务表恢复；`dispatched` 按 `running[]` 对账 | 最多一个 `clientSilentMs` 的延迟 |
| 停止 / 取消 | 调度器 `S-07` | `C-07` | 持续下发直到生效 | — |

## 9. 容量、并发与终止

- **容量**：只由 `capacity.free` 表达。`maxConcurrent` 是 client 本地配置，调度器从 `free` 推断，不做二次限制。
- **并发**：同一 `instanceId` 上允许多个任务同时执行（fan-out 分支），前提是 `S-06` 的同 digest 与 `C-03` 的安装临界区。
- **终止上界**：`timeoutMs` 是契约要求；`idle_timeout` 是可选优化（`C-06`），默认关闭，避免误杀长工具调用。
- **清理**：v2 **没有清理指令**。工作区默认保留（分析产物是重跑的基础）；实例不再需要时由运维按 `instanceId` 回收。

## 10. 联调与验收

### 10.1 桩调度器最小面

1. 批量下发：`free=3` 返回 ≤3 条；`free=0` 返回空。
2. 长轮询：无任务挂起 30s 后返回空；有任务立即返回。
3. 重复派发：同一 `taskId` 在 `S-03` 条件下二次下发。
4. 静默回队：client 停止 poll 120s 后任务回队并重派。
5. 超时回队：任务超过 `timeoutMs + 60s` 未回报 → 回队，`attempt + 1`。
6. 结果：首份 `accepted=true`；第二份 `accepted=false`；未知 `taskId` 404。
7. 控制：`stop`、`cancelInstances` 电平下发直到 client `running` 不再包含。
8. 制品：304 命中、404 缺包、digest 不匹配。

### 10.2 client 门禁

- 并发 N：`free` 如实上报，N 个任务并行、各自 settle；
- 结果先落盘后上报：kill -9 后重启能补报，不重跑；
- 取消/超时后进程组无残留（`kill -0` 为假）；
- 1000 任务吞吐：同一技能集只装一次，后续走 digest 短路；
- 技能集切换：不同 digest 的任务串行安装，不交错；
- `stop` 后优雅退出 0，第二次信号强退。

## 11. 与 v1 的差异与 client 改造清单

### 11.1 删除的机制

| v1 机制 | 为什么删 | 现在由什么兜底 |
|---|---|---|
| `register` + `limits` + `assignments` / `assignmentsVersion` | 客户端不需要从服务端同步实例清单，也不需要协商上限 | 常量写死在契约；实例信息随任务下发 |
| `heartbeat` + `clientLease` + `serverTime` | 判活由 poll 长轮询本身表达 | `S-02` 的 `clientSilentMs` |
| `claim` + `claimRequestId` | 响应丢失用「未确认重发」对账，不需要幂等键 | `S-03` |
| `renew` + 尝试租约 + `LeaseTracker` | 租约只服务「不重派」；v2 允许重派 | `S-02` |
| `bindSession` | 技能集随任务下发，不需要建 session 后回取 | `TaskRequest.skillSet` |
| `runId` + fencing + `run_superseded` + 退出码 7 | 双开只是重复执行，不破坏数据 | 无（`S-02` 会自然收敛） |
| `late_result` + 409 语义 | 任务已 done，旧结果无价值 | `S-08` 的 `accepted=false` |
| 结果去重缓存 + `disposition` | 单流水线进程内去重无意义 | `S-08` 首份为准 |
| `cleanupPending` / `cleanupAcks` / `releaseId` / `SCH-20` | v2 没有「释放实例」动作 | 运维回收 |
| `pause` / `resume` 事件 | 暂停 = 调度器不下发 | 无 |
| `seq` / `ackSeq` / 补发 / `issuedAt` 作用域 | 控制改为电平信号 | `S-07` + `C-07` |
| `compatibility` / `deprecated` / `sunsetAt` / 426 | 双端同仓发布 | `X-Executor-Protocol` 整数校验 |
| `429` / `Retry-After` / `maxRequestBytes` | 单 client 单机 | 无 |
| 7 态状态机（`claimed…closed` + `abandoned`） | 只需要「在跑 / 已交结果」 | `C-01` + `C-04` |

### 11.2 保留的机制

| 机制 | 保留理由 |
|---|---|
| `timeoutMs` + 进程组强杀 | 上千个任务里一个 hung 会堵住队列，这是「跑完」的兜底 |
| 结果先落盘再上报 | 重报比重跑便宜一个数量级 |
| 工作区默认保留 | 「重跑能识别痕迹」的前提 |
| `maxResultBytes` + 截断 | 防单条结果撑爆传输 |
| 技能集 digest 幂等短路 | 1000 个任务只装一次 |
| `workspacePath` 校验与路径约束 | 防止写错容器 |
| 孤儿进程清理 | 进程残留会占资源 |
| 未知字段忽略 / 未知请求字段 400 | 兼容演进与抓错 |

### 11.3 client 改造清单（按现有代码结构）

| 位置 | 动作 |
|---|---|
| `src/components/gateway/state.ts` | **删除**：`ClaimIdempotency`、`ControlSeq`、`IdempotencyCache`、`CleanupAckQueue` |
| `src/components/gateway/gateway.ts` | 删 `register`/`heartbeat`/`claim`/`renew`/`bindSession`；实现 `poll`/`report`/`package`；删租约计时与 `run_superseded` 处理 |
| `src/components/gateway/wire.ts`、`errors.ts` | 按 §5 重写类型与错误码（只剩 6 个 HTTP 码） |
| `src/components/executor/ports.ts` | `SchedulerPort` 改为 `poll` / `reportResult` / `downloadPackage`；删 `Lease`/`Assignment`/`CleanupPending`/`CleanupAck`/`Registration*`/`Heartbeat*` |
| `src/components/executor/executor.ts` | 删 `reconcileCleanup`、技能集冲突守卫；状态机简化为 `received → running → reported`；保留 timeout/cancel/prompt |
| `src/components/cli/serve-loops.ts` | 心跳循环与领取循环**合并为一条 poll 循环**；删 `run_superseded`、`pause/resume`、`cleanupAcks` |
| `src/components/cli/serve-events.ts` | 删 `reconcileCleanup` 相关；`stop`/`cancelInstances` 走 `C-07` |
| `src/components/cli/serve.ts` | 删 `runSuperseded` 退出码；`stop` 走优雅退出 |
| `src/components/cli/serve-context.ts` | `assignmentsVersion`、`pausedInstances` 删除；`buildState` 改为 `buildPollRequest` |
| `src/components/cli/local-scheduler.ts` | 按新端口适配 `run` 模式 |
| `src/components/store/` | 保留 in-flight 与结果表；删除 journal 多态（`claimed…closed`）与压缩；保留孤儿记录（可简化） |
| `src/components/assets/` | 技能集来源从 `bindSession` 改为 `TaskRequest.skillSet`；保留 digest 短路与原子替换；删冲突守卫 |
| `src/components/result/` | 保留组装/截断/分类；删 `retryable` 字段 |
| `docs/design/contracts/executor-http-v1.md` | 归档到 `docs/history/`，换成 v2 |

## 12. 待定

1. `maxConcurrent` 的默认值（建议 2–4，按机器核数）。
2. `idle_timeout` 的默认阈值与是否由调度器按任务类型下发（v2 默认关闭）。
3. 任务列表规模的上界（几十 vs 上千）对调度器侧批量下发的影响——属调度器实现，不改契约。
4. 是否需要 `GET /api/v1/executor/status` 一类的只读面（当前不需要，排障靠日志）。

## 13. 版本演进

- `X-Executor-Protocol` 用整数；不匹配即 `400 unsupported_protocol`，不做兼容窗口。
- 加法（新可选字段）不升版本；删字段、改语义、改必填性升整数。
- 当前版本 `2`。v1 不保留兼容期。
