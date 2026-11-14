---
layer: works
module: global
status: active
updated: 2026-11-14
---

# 设计分析：执行过程进度上报（5s 周期 / 模式 C 独立端点）

> 输入：用户确认「按 5s 回报，模式 C」。[`report.md`](report.md) 的方案 C。
> 范围：跨 client 与调度器的执行面契约新增一个可选端点，client 每 5s 上报一次进度快照，调度器内存保存并经 run detail 暴露给 UI。
> 本轮只做设计分析，不写代码、不改契约正文。定级 **P1**（见 §15），确认后才进入实现。

## 0. 决策摘要

| # | 决策 | 理由 |
|---|---|---|
| D1 | 传输用**独立进度端点** `POST /tasks/{taskId}/progress`，不塞进 poll | poll 有 30s 挂起，无法支撑 5s；进度失败也不能影响 poll 热路径 |
| D2 | **不升 protocol 版本**，用 poll 响应新增 `capabilities: ["progress-v1"]` 做能力协商 | 加法变更；任一侧先升级都不破坏对方；v4 会引入部署顺序与回滚耦合 |
| D3 | 调度器**只在内存**保存最新快照，不落库、不留历史 | 5s×N 任务的写入量不值得；重启后下一跳自动补齐；历史由 `P-04` 日志承担 |
| D4 | client 由 **CLI 每 5s 采样 executor 快照**后上报，不在 runtime 里放定时器 | I/O 收口在 CLI（与 poll/result 一致）；runtime 只维护事实；失败天然隔离 |
| D5 | 首版 phase 只有 `preparing / prompting / tool / settling`，不含 `waiting_approval` | 当前 client 静态策略立即应答权限请求，等待窗口不可见；交互式审批再补 |
| D6 | 载荷含**最近工具动作（≤8 条）+ 最新叙述尾部（≤200 字节）+ 上下文水位 + 事件计数**；不含 prompt、最终消息全文、工具输出、完整思考 | 控制敏感面与体积；"当前在做什么"需要动作序列与最新叙述，见 §0.1 实测 |
| D7 | 5s 是**心跳**：无变化也发；调度器按最后一次上报判断 `stale`（>15s），但**不判失败、不影响执行** | 免掉"静默=卡死"的误判；服务端重启后一个周期内自愈 |

关键数字：单任务 5s 一次 ≈ 0.2 req/s；单 client（并发 2）≈ 0.4 req/s；1000 个在跑任务 ≈ 200 req/s，全部内存更新、不查库。

### 0.1 实测校准（2026-11-14，n3「方案」节点）

用当前正在跑的真实任务重建 5s tick 后，发现了只含"当前工具"版本的硬伤：

- 28 个 tick 的 `phase` **全部是 `prompting`**，`active=0`；59 个工具动作全部在 0.01–0.11s 内完成，5s 采样一次都抓不到；
- 窗口内 `agent_message_chunk` 为 **0**，叙事全在 36 段 `agent_thought_chunk` 里；
- 只报"当前工具 + 上下文/事件数"，UI 在 2 分多钟里只会显示同一行"模型处理中 · 最近活动 x 秒前"。

因此载荷修订为"**最近动作序列 + 最新叙述尾部**"，详细模拟见 [`sim-progress-live.md`](sim-progress-live.md)。

## 1. 目标与非目标

### 目标

1. 任务执行期间，UI 能显示：当前阶段、最近工具动作与耗时、最新叙述尾部、最近活动时间、上下文水位。
2. 进度上报失败、调度器重启、端点不存在时，**任务执行与结果上报完全不受影响**。
3. 不引入新的持久化数据、不保存全文、不改变任务结算与重派语义。
4. 任一侧（client / 调度器 / UI）可独立升级、独立回滚。

### 非目标

- 不做 token 级流式输出；文本仍按消息提交到达（见 `report.md` §3）。
- 不做完整思考/工具输出的实时展示；只展示截断后的叙述尾部与工具摘要，完整内容仍走 `P-04`/观测面。
- 不做控制面：进度不能触发取消、重派、停止，也不作为判活依据。
- 不改 `TaskResult.usage` 语义（DSH 只给 `used/size`；这是独立的后续修正）。
- 不做历史进度回放；只保留最新快照。

## 2. 约束与前提

| 约束 | 内容 |
|---|---|
| 周期 | 5s，允许 ±20% 抖动（4–6s）；任务开始后的第一个 5s 跳内上报 |
| 拓扑 | 调度器当前单进程部署（内存保存的前提）；client 只出站，调度器不反连 client |
| 契约 | 调度器侧 `executor-http-v3` 为权威；本仓库只同步副本，改动需调度器侧同意 |
| 隐私 | 工具参数摘要与叙述尾部可能含路径/命令/业务内容；必须截断 + 脱敏；`text` 可配置关闭；不传工具输出与 prompt |
| UI | 详情页每 5s 轮询 run detail；进度展示延迟 = 上报周期 + 轮询周期（≈5–10s） |
| 现有语义 | `poll` 承担判活；`OQ-18` 已定 `lastEventAt` 只作观测，不判活；进度沿用同一原则 |

## 3. 方案选择

### 3.1 为什么是独立端点（C）

| 候选 | 否决理由 |
|---|---|
| B：`poll.running[].progress` | `free=0` 或等任务时服务端挂起 `pollHoldMs=30s`，进度最快 30s 才出去一次；且进度与派发/判活挤在同一热响应里，失败面耦合 |
| D：client 观测面（SSE） | 需要 client 入站 HTTP、网络可达、token/TLS、调度器代理；解决的是"看全文/排障"，不是"5s 看一眼在干什么"；P1 稿尚未定稿 |
| E：中途传 `P-04` 快照 | 服务端只存不解析，UI 要自己解 gzip/JSONL；全文暴露面大；只能过渡 |
| 复用 `result` | 结果一次性、终态语义，破坏后无法再报 |

独立端点的代价是多一条路由与一个 client 方法；换来的是 5s 可达、失败隔离、与 poll 解耦。

### 3.2 版本策略：能力协商，不升 v4（推荐）

| 候选 | 行为 | 评价 |
|---|---|---|
| **A. v3 + `capabilities`（推荐）** | poll 响应增可选字段 `capabilities:["progress-v1"]`；client 看到才上报；契约文档追加 P-06 修订 | 旧 client 忽略未知响应字段（契约已要求）；旧调度器不广告 → 新 client 静默不发；任一侧回滚都安全 |
| B. protocol v4 | client 发 `X-Executor-Protocol: 4`；调度器需同时接受 3/4 | 语义干净，但必须先升调度器、且回滚调度器会把新 client 打成 `400` 退出；为一个可选能力引入版本耦合不划算 |
| C. 404 探测 | 新 client 直接发，收到 404 后禁用 | 无契约改动，但"路由不存在"与"task 不存在"都返回 404，歧义；会先产生一轮无意义请求与误报 |

结论：按 A 做。契约文档把它写成 **v3 追加修订（可选能力）**，`X-Executor-Protocol` 仍为 `3`；若调度器侧坚持版本化，再按 B 走"调度器先发、接受 3/4、双版本过渡"。

### 3.3 存储：调度器内存（推荐）

| 候选 | 否决理由 |
|---|---|
| 落 `task` 表字段 | 5s×N 的写放大；进度是秒级易失事实，不值得进事务与备份 |
| 新建进度表 | 同上，还要迁移、保留、清理 |
| 写 run 节点行 | 跨越 `CMP-scheduler` 与 `CMP-run` 的数据所有权（run 只读任务结果） |
| 内存 `ProgressRegistry` | 读写 O(1)、重启后 5s 自愈、无迁移；代价是多实例部署时需粘性/共享存储（记为开放问题） |

### 3.4 客户端驱动：CLI 采样（推荐）

| 候选 | 评价 |
|---|---|
| runtime 内每任务定时器 | runtime 引入 I/O 与生命周期复杂度；权限/取消路径都要管定时器 |
| **CLI 每 5s 采样 executor 快照（推荐）** | 与 poll/result 的 I/O 收口一致；executor 只产出事实；失败不影响任务；沿用 `snapshotRunning` 的定位并替换为 `snapshotProgress` |
| 事件驱动即时上报 | 更快，但请求量随工具数放大；5s 心跳已满足需求，后续可加"状态变化时提前一跳" |

代价：工具切换的可见延迟最多 5s；用户已接受 5s 周期。

## 4. 能力、不变量与语义

**能力**：`progress-v1` —— 执行中的任务以不超过每 5s 一次的节奏上报结构化快照。

**不变量**：

1. 进度**不影响**任务状态、派发、超时、重派、取消与结算；缺失进度不是失败。
2. 服务端每个 `taskId + attempt` 只保留**最新**一份快照，无历史。
3. `seq` 在 attempt 内单调递增；旧值被忽略，不报错。
4. 进度只允许该任务的承接 client 上报；归属校验失败按 `404 task_not_found` 处理。
5. 载荷不含 prompt、最终消息全文、工具输出、完整思考；工具摘要与叙述尾部经截断与脱敏（`text` 可关闭）。
6. client 在任务结算/取消后停止上报；迟到上报被忽略。
7. 上报周期是 SHOULD（5s ±20%）；服务端 MUST NOT 因间隔长短判定任务失败。
8. 服务端重启后允许短暂无进度，下一次上报自动恢复。

## 5. 组件地图与依赖

```text
client                                              scheduler
┌─────────────┐   snapshotProgress()   ┌──────────┐   POST /tasks/{id}/progress   ┌──────────────┐
│ CMP-runtime │◀───────────────────────│CMP-executor│────────────────────────────▶│ http-gateway │
│ SessionProgress                      └──────────┘   (经 CMP-gateway)            │  P-06 路由    │
└─────────────┘                              ▲                                    └──────┬───────┘
                                             │ 5s 采样                                   │ reportProgress
                                      ┌──────┴──────┐                                    ▼
                                      │   CMP-cli   │                            ┌──────────────┐
                                      │ progress 循环│                            │ CMP-scheduler│
                                      └─────────────┘                            │ ProgressRegistry │
                                                                                 └──────┬───────┘
                                                                                        │ progress(taskId)
                                                                                 ┌──────▼───────┐
                                                                                 │   CMP-run    │
                                                                                 │ RunNodeView  │
                                                                                 └──────┬───────┘
                                                                                        │ GET /runs/{id}
                                                                                 ┌──────▼───────┐
                                                                                 │     UI       │
                                                                                 └──────────────┘
```

| 模块 | 本次职责 | 不负责 |
|---|---|---|
| `CMP-runtime` | 维护每 session 的事实：活跃工具、`lastEventAt`、`usage`、事件计数 | 定时、序列化、HTTP |
| `CMP-executor` | 把 session 事实与任务状态合成 `TaskProgress`；`snapshotProgress()` | 网络、重试、能力判断 |
| `CMP-cli` | 5s 采样循环、`seq`、能力门控、失败隔离 | 数据解析/展示 |
| `CMP-gateway` | `POST progress`、错误分类、`capabilities` 缓存 | 业务判断 |
| `CMP-scheduler` | 校验归属/attempt/seq，内存保存最新快照，提供读接口 | 展示、历史、判活 |
| `CMP-run` | 在 `GET /runs/{id}` 里把进度并入 `RunNodeView` | 存储进度 |
| UI | 渲染阶段/工具/耗时/上下文，`stale` 弱提示 | 推断任务失败 |

新增的都是既有模块的内部单元（`SessionProgress`、`ProgressRegistry`、progress 循环），**不新增组件、不改分层**。

## 6. 契约卡：`P-06` 上报执行进度（v3 追加）

- 所属面：调度器执行面契约；client 是消费方。
- 目的：让调度器/UI 在执行期间看到结构化进度，不改变任务语义。

### 6.1 请求

```http
POST /api/v1/executor/tasks/{taskId}/progress
Authorization: Bearer <token>
X-Executor-Protocol: 3
Content-Type: application/json

{
  "taskId": "01J9Z7Q0M4",
  "attempt": 1,
  "executionId": "6f1c2a4e-6f3b-4f0e-9d4e-0b7f3a2c1d55",
  "seq": 6,
  "phase": "prompting",
  "elapsedMs": 30000,
  "lastEventAgeMs": 1335,
  "events": 86,
  "activity": [
    { "id": "call_…", "name": "bash", "summary": "sed -n '80,120p' doc/plan/roadmap.md",
      "status": "completed", "durationMs": 31, "endedAgeMs": 1335 },
    { "id": "call_…", "name": "read", "summary": "…/REQ-0013-dwell-auto-read.md",
      "status": "completed", "durationMs": 18, "endedAgeMs": 2470 }
  ],
  "text": { "kind": "thought", "ageMs": 1422,
            "tail": "…Let me check the architecture and roadmap. Also risks.", "truncated": true },
  "usage": { "used": 80780, "size": 1000000 }
}
```

约束：

| 字段 | 类型 | 约束 |
|---|---|---|
| `taskId` | string | 与路径一致；UUID |
| `attempt` | int | ≥1；必须等于调度器当前 attempt |
| `executionId` | string | 每次任务执行生成一个 UUID；client 崩溃/重启后再次执行同一 attempt 时换新值 |
| `seq` | int | ≥1；同一 `executionId` 内单调递增；换 execution 时重置为 1 |
| `phase` | enum | `preparing` / `prompting` / `tool` / `settling` |
| `elapsedMs` | int | ≥0；任务开始至今（client 单调时钟） |
| `lastEventAgeMs` | int | ≥0；最近一次 ACP 事件距今；无事件时等于 `elapsedMs` |
| `tool` | object? | 正在执行的长工具；`{name,elapsedMs,summary?,running}`；无活跃工具时缺省 |
| `activity` | array? | 最近 8 个已结束工具，按结束时间倒序；`{id,name,summary,status,durationMs,endedAgeMs}`；`id` 为 ACP `toolCallId`，供 UI 去重 |
| `activity[].summary` | string | ≤200 字节；`rawInput` 摘要，已脱敏 |
| `activity[].durationMs` | int | ≥0；工具耗时 |
| `activity[].endedAgeMs` | int | ≥0；距快照时刻 |
| `text` | object? | 最新叙述：`{kind:"thought"|"message",ageMs,tail,truncated}`；`tail` ≤200 字节；可关闭 |
| `usage` | object? | `{used,size}` 非负数；未知时缺省 |
| `events` | int | ≥0；本 attempt 收到的 `session/update` 计数 |

- `tool` 只在**有工具正在执行**时出现；短工具靠 `activity` 补，不再依赖 5s 采样恰好抓到 `in_progress`。
- `activity` 是"最近动作"而不是"当前周期动作"：即使本周期没有新工具，也保留最近 8 条，UI 可按 `endedAgeMs` 显示新旧。
- `text` 取最近一个 `agent_thought_chunk` 或 `agent_message_chunk` 的尾部；thought 默认开启、可本地关闭（见 C4）。
- 请求体上限 `maxProgressBytes = 8192`；未知字段 `400 validation_error`。
- 不含绝对时间戳：耗时用 `*Ms` 相对值，避免 client 与调度器时钟偏差（见 §7.8）。

### 6.2 响应

```json
{ "taskId": "01J9Z7Q0M4", "attempt": 1, "accepted": true }
```

忽略时仍 `200`，带原因：

```json
{ "taskId": "01J9Z7Q0M4", "attempt": 1, "accepted": false, "reason": "stale" }
```

`reason` 闭集：`stale`（seq 不新）、`settled`（任务已结算）、`attempt_mismatch`（重派后的旧副本）。

### 6.3 错误模式

| HTTP | code | 触发 | client 应对 |
|---:|---|---|---|
| 400 | `validation_error` | 字段/枚举/上限非法 | 记一次 error 日志，停掉该 attempt 的上报 |
| 401 | `unauthorized` | token/身份失效 | 停掉上报；由下一次 poll 走现有退出流程 |
| 404 | `task_not_found` | 任务不存在或不属于该 client | 停掉该 attempt 的上报 |
| 413 | `payload_too_large` | >8 KiB | 停用该 attempt 并告警；正常不应发生（字段均已限长） |
| 500/503 | `internal_error` / `service_unavailable` | 调度器异常 | 丢弃本次，下一跳继续；不重试 |

### 6.4 顺序、幂等与语义

- 幂等键 `taskId + attempt + executionId + seq`；同一 execution 内重复/乱序由 `seq` 过滤，最新值胜出。
- 同一 attempt 允许被重复执行（client 崩溃后重派，v3 at-least-once 已允许）：新的 `executionId` 到达时重置 `seq` 并接管展示；被取代的旧 executionId 记入小集合（≤4），迟到的旧包按 `stale` 忽略，避免进度来回跳。
- 不补发、不累积；每 5s 是**电平快照**，丢一跳无影响。
- 服务端按 `max(receivedAt)` 计新鲜度；超过 `progressStaleMs=15000` 标记 `stale`，仅展示。
- 进度**不参与** `S-02` 静默判定、不唤醒派发、不影响 `stop/cancelInstances`。

### 6.5 能力协商

`P-01` 响应新增可选字段：

```json
{ "tasks": [], "stop": false, "cancelInstances": [], "archiveRequests": [], "nextPollAfterMs": 0,
  "capabilities": ["progress-v1"] }
```

- 旧 client 忽略未知响应字段（v3 既有要求）。
- 新 client 只有看到 `progress-v1` 才启动上报；旧调度器不广告 → 新 client 完全静默。
- 端点本身仍做 404 兜底（能力缺失但被误调用时停用）。

### 6.6 常量

| 常量 | 值 | 约束对象 |
|---|---|---|
| `clientProgressIntervalMs` | 5000（±20%） | client 推荐节奏 |
| `progressStaleMs` | 15000 | 调度器判"停更" |
| `maxProgressBytes` | 8192 | 请求体 |
| `maxProgressSummaryBytes` | 200 | `tool.summary` / `activity[].summary` |
| `maxProgressTextBytes` | 200 | `text.tail` |
| `maxProgressActivity` | 8 | `activity` 条数 |
| `progressTtlMs` | 900000 | 内存条目兜底清理 |
| `maxProgressEntries` | 10000 | 内存条目上限 |

## 7. 客户端设计

### 7.1 数据模型

```ts
// CMP-runtime：session 事实（不含任务语义）
type SessionProgress = {
  lastEventAt: number;          // Date.now()
  events: number;               // session/update 计数
  tools: Map<string, {          // toolCallId → 记录
    name: string;
    status: "in_progress" | "completed" | "failed";
    startedAt: number;
    endedAt?: number;
    summary?: string;           // 已在采集时截断/脱敏
  }>;
  recent: Array<{               // 最近结束的工具，≤8，按结束时间倒序
    id: string;
    name: string;
    summary?: string;
    status: "completed" | "failed";
    startedAt: number;
    endedAt: number;
  }>;
  narrative?: {                 // 最新一段 thought/message 的尾部
    kind: "thought" | "message";
    text: string;               // ≤200 字节
    at: number;
    truncated: boolean;
  };
  usage?: { used: number; size: number };
};

// CMP-executor：任务快照（含任务状态）
type TaskProgress = {
  taskId: string;
  attempt: number;
  executionId: string;
  phase: "preparing" | "prompting" | "tool" | "settling";
  elapsedMs: number;
  lastEventAgeMs: number;
  tool?: { name: string; elapsedMs: number; summary?: string; running: number };
  activity?: Array<{
    id: string;
    name: string;
    summary: string;
    status: "completed" | "failed";
    durationMs: number;
    endedAgeMs: number;
  }>;
  text?: { kind: "thought" | "message"; ageMs: number; tail: string; truncated: boolean };
  usage?: { used: number; size: number };
  events: number;
};

// CMP-executor：上报回执
type ProgressAck = {
  accepted: boolean;
  reason?: "stale" | "settled" | "attempt_mismatch";
};
```

类型归属：`SessionProgress` 定义在 `CMP-executor` 的 `domain-types.ts`（端口值类型，`CMP-runtime` 只实现）；`TaskProgress`/`ProgressAck` 也由 `CMP-executor` 定义，`CMP-gateway` 只做线格式映射，HTTP 类型不进入端口。

### 7.2 runtime：只维护事实

`RuntimeState` 在 `applyNotification` 增加（不改变现有 `finalText` 逻辑）：

- 每条 `session/update`：`events += 1`；`lastEventAt` 现有逻辑已覆盖所有 `session/update`，沿用。
- `tool_call`：按 `toolCallId` 建记录，`name=title`、`status=in_progress`、`startedAt=now`、`summary=summarize(rawInput)`。
- `tool_call_update`：按 id 更新 `status` 与 `endedAt`；结束（`completed`/`failed`）时压入 `recent`（上限 8，新的在前，同时保留在 `tools` 供 UI 去重）；找不到 id 时忽略。
- `agent_thought_chunk` / `agent_message_chunk`：更新 `narrative={kind,text,at,truncated}`，`text` 取尾部 ≤200 字节；消息优先于思考（同一时刻按到达顺序）。
- `usage_update`：`usage={used,size}`（这是 DSH 实际字段；结果用的 `inputTokens/outputTokens` 不动）。
- 其余类型只计 `events`。

`recent`/`narrative` 都在采集时截断，内存里不保留完整思考或长参数。

`RuntimePort` 增加只读方法（内部端口 v2 兼容扩展）：

```ts
progress(session: SessionRef): SessionProgress | undefined;
```

`AcpRuntime.progress` 委托 `RuntimeState`；未知 session 返回 `undefined`，不抛。

### 7.3 executor：合成任务快照

`NodeExecutor` 增加：

```ts
snapshotProgress(): TaskProgress[];
```

- 遍历 `#active`；每个 active 保存 `task`（含 attempt）、`executionId`（任务开始时生成的 UUID）、`startedAt`、`session`、`promptSettled`。
- phase 推导：
  1. 还没有 session → `preparing`；
  2. `promptSettled` → `settling`；
  3. `SessionProgress.tools` 有 `in_progress` → `tool`；
  4. 其余 → `prompting`。
- `tool`：取最近开始的 `in_progress`；`running` 为并行数；`elapsedMs = now - startedAt`。
- `activity`：把 `SessionProgress.recent` 映射为 `{id,name,summary,status,durationMs:endedAt-startedAt,endedAgeMs:now-endedAt}`，最多 8 条。
- `text`：若 `narrative` 存在，映射为 `{kind,ageMs:now-at,tail,truncated}`。
- `lastEventAgeMs = now - (session?.lastEventAt ?? startedAt)`。
- `elapsedMs = now - startedAt`。
- 不读取 prompt、不读取 `finalText`。
- 删除现有未被调用的 `snapshotRunning()` 与 `RunningSnapshot`（同一职责，避免两套）。

### 7.4 CLI：5s 上报循环

在 `serve` 启动时与 poll 并行起一个循环（`run.ts` 单次执行不上报）：

```text
每 5s ±20%：
  if (!gateway.supportsProgress()) continue;
  const snapshots = executor.snapshotProgress();
  if (inFlight) continue;                 // 上一批未完成则跳过本跳（合并）
  inFlight = true;
  await Promise.allSettled(snapshots.map(s => gateway.reportProgress({...s, seq: nextSeq(s)})));
  inFlight = false;
```

- `seq`：`Map<executionId, number>`；每次发送前 +1；execution 结束后清理。
- 单次请求超时 2s（小于周期）；不重试。
- 失败只记日志（`progress.failed`，debug/warn），不 throw 到任务。
- 401：只停上报；由 poll 的既有逻辑决定进程是否退出（避免两条退出路径）。
- 404 / 400：把该 `taskId#attempt` 加入禁用集合，后续跳过。
- `accepted:false` 且 `reason` 为 `settled`/`attempt_mismatch`：禁用该 attempt；`stale` 忽略。
- 循环随 `ctx.controller.signal` 退出；不持有任务 promise。

为什么放在 CLI：HTTP I/O 与重试/退出策略已经在这里；executor 保持纯本地执行；`run`（单任务）不接调度器时自然不上报。

### 7.5 gateway：新增方法与能力缓存

```ts
interface SchedulerPort {
  // …现有
  reportProgress(input: TaskProgress & { seq: number }): Promise<ProgressAck>;
  supportsProgress(): boolean;
}
```

- `HttpScheduler` 在每次 `poll` 解析 `capabilities`，更新内部标志；`reportProgress` 用 `POST`，2s 超时，无重试。
- 错误映射：
  - 404 → `GatewayError("task_not_found")`（复用现有码）；
  - 400/413/401 → 复用现有错误码；
  - 5xx/网络 → `GatewayError` 可重试类，但 reporter 不重试。
- `LocalSchedulerAdapter`（`run`）`supportsProgress()` 恒为 `false`。

### 7.6 摘要、脱敏与截断

- `summarize(rawInput)`：
  1. 对象 → `JSON.stringify`，数组取前 3 项；
  2. 单行化（`\n` → 空格）；
  3. 按键名脱敏：`authorization|cookie|token|secret|password|passwd|api[-_]?key|credential|private[-_]?key` 的值替换为 `[redacted]`；
  4. 保留**开头** 200 字节（命令/路径的可读部分在前），附 `…`。
- `text.tail`：取尾部 200 字节（最新叙述在后），去掉控制字符；对 `Bearer\s+\S+`、`sk-[A-Za-z0-9]+`、`(token|password|secret)=\S+` 做替换；附 `…` 与 `truncated`。
- 不保存原始 `rawInput` 与完整思考，只在采集时生成摘要/尾部；避免内存里留下长参数与全文。
- 不发送 `tool_call_update.content`（工具输出）、prompt、最终消息全文。

### 7.7 phase 状态机

```text
task received ──▶ preparing ──▶ prompting ⇄ tool ──▶ settling ──▶ (stop)
                                   │                     ▲
                                   └── 工具结束回到 prompting ┘
```

- `preparing`：任务已收，session 未建（workspace/技能/session 建立阶段）。
- `prompting`：prompt 已发，没有进行中的工具。**不叫"thinking"**：客户端无法区分"模型思考"与"等待模型返回"。
- `tool`：至少一个工具 `in_progress`；并行时 `running>1`。
- `settling`：prompt 已返回，正在组装结果/传日志；很短。
- 不做 `waiting_approval`：当前 `[acp].permission` 静态策略立即应答，窗口不可观测；将来做交互式审批时再加（契约 enum 预留扩展）。

### 7.8 时钟

- 不传绝对时间：client 与调度器可能是不同机器，`startedAt`/`lastEventAt` 会因时钟偏差显示负数时长。
- 传 `elapsedMs` / `lastEventAgeMs` / `tool.elapsedMs`；调度器存 `receivedAt`；UI 用 `receivedAt` + 相对值递增显示。
- 代价：排障时看不到客户端绝对时间；需要时看 `P-04` 日志与结果里的 `startedAt`。

## 8. 调度器设计

### 8.1 路由与解析

- 新增 `matchProgress`：`segments = ["executor","tasks",id,"progress"]`，`POST`。
- 复用现有 `assertProtocol` / `authenticate` / 错误信封；请求体走白名单解析（同 `POLL_FIELDS`/`RESULT_FIELDS` 风格），新增 `PROGRESS_FIELDS`。
- 校验路径 `taskId` 为 UUID；体上限 `maxProgressBytes`。
- 成功与忽略都 `200`；只有格式/归属/大小错误用 4xx。

### 8.2 `ProgressRegistry`（CMP-scheduler 内部单元）

- 键：`taskId`；值：`{ attempt, clientId, executionId, superseded: Set<string>, snapshot, seq, receivedAt }`。
- **懒校验**：首次上报（或无缓存 / `attempt` 变化）时查一次 `task` 行，校验 `client_id`、`state` 与当前 attempt，之后常规路径全部走内存；避免 200 req/s 打到数据库。
- 处理顺序：
  1. 缓存缺失、或 `input.attempt != cached.attempt` → `findById` 刷新；任务不存在或 `client_id` 不匹配 → `404`；
  2. `input.attempt != row.attempt` → `200 {accepted:false, reason:"attempt_mismatch"}`；
  3. `state === "done"` → 移除缓存，`200 {accepted:false, reason:"settled"}`；
  4. `executionId` 不等于当前值：
     - 在 `superseded` 中 → `200 {accepted:false, reason:"stale"}`；
     - 否则视为同一 attempt 的新一次执行：把旧值加入 `superseded`（最多 4 个），重置 `seq`，接管；
  5. 同一 `executionId` 且 `seq <= cached.seq` → `200 {accepted:false, reason:"stale"}`；
  6. 写入快照与 `receivedAt`，`200 {accepted:true}`。
- 清理（惰性，不加定时器）：
  - `acceptResult` 结算后 `remove(taskId)`（在 result handler 加一个 hook）；
  - 每次读写命中时检查 `receivedAt`，超过 `progressTtlMs` 的条目删除；
  - 写入新条目时若超过 `maxProgressEntries`，按 `receivedAt` 淘汰最旧。
- 重启：registry 为空；下一跳上报重新懒校验并恢复。run detail 在恢复前返回 `null`（UI 显示"等待进度"）。

### 8.3 读接口与 run detail

`SchedulerService` 增加：

```ts
progress(taskId: string): Promise<TaskProgressView | null>;
```

`TaskProgressView`：

```ts
{
  phase, elapsedMs, lastEventAgeMs, tool?, usage?, events,
  receivedAt: string,
  ageMs: number,        // now - receivedAt
  stale: boolean        // ageMs > progressStaleMs
}
```

`CMP-run` 的 `queries.get`：

- 只对 `state === "dispatched"` 且有 `taskId` 的节点取进度（通常 1 个）；
- `RunNodeView` 新增 `progress: TaskProgressView | null`；
- `scheduler.progress` 抛错时降级为 `null`（观测失败不拖垮 run detail）。

### 8.4 能力广告

- `DispatchDecision` 增加 `capabilities: string[]`（当前 `["progress-v1"]`）；`poll` 响应透传。
- 由 `CMP-scheduler` 提供，因为能力与端点同属一个组件；网关只序列化。
- 若调度器侧决定走 v4（方案 B），则该字段与版本一起处理；本设计按 A。

### 8.5 无控制语义

- 进度不进入 `waiters`，不唤醒长轮询；
- 不参与 `S-02` 静默/超时判定；
- 不出现在 `stop`/`cancelInstances`/`archiveRequests` 的任何路径；
- 不改 `task` 表，不加迁移。

## 9. UI 设计

数据源不变：`GET /api/v1/runs/{id}` 每 5s（现有 `POLL_MS=5000`）。

节点详情（summary tab）新增：

| 行 | 内容 |
|---|---|
| 当前阶段 | 准备中 / 模型处理中 / 工具执行 / 收尾中 |
| 最新叙述 | `text.kind` 标注"思考/输出"；显示 `text.tail`，截断时加"（截断）"；无叙述显示"暂无叙述" |
| 最近动作 | `activity` 最近 5 条：`bash · sed -n '80,120p' … · 0.03s · 1.3s 前`；`edit` 显示文件路径；并行时用 `running` 汇总 |
| 当前工具 | 仅 `tool` 存在（长工具）时显示：`bash · 执行中 · 3.2s` |
| 最近活动 | `lastEventAgeMs + ageMs` → "1.1s 前"；`stale`（上报停更）时橙色提示 |
| 已运行 | `elapsedMs + ageMs` |
| 上下文 | `used/size`（如 `5.8k / 1M`）与进度条（可选） |

文案规则：

- `progress=null` 且节点 `dispatched` → "等待进度上报（客户端可能为旧版本）"；
- `text` 缺失（配置关闭或还没有叙述）→ 显示"暂无叙述"，其余照常；
- `lastEventAgeMs` 很大（如 16.7s）只显示"最近活动 16.7 秒前"，**不等于停更**；停更只看 `stale`（服务端 `receivedAt` 超过 15s 没收到上报）；
- `stale=true` → "进度停更 x 秒，任务可能仍在执行"，**不显示失败**；
- 节点已 `succeeded/failed` → 不显示进度区，回到结果/错误展示；
- 不新增轮询频率；5s UI + 5s 上报 = 5–10s 可见延迟，符合本次"5s 回报"的目标。若后续要求 <5s，再评估把 UI 轮询降到 2–3s 或走 SSE。
- **prompt 不进进度载荷**：UI 已经知道节点名（如"方案"）与 run 上下文；若要补任务说明，由调度器在 `GET /runs/{id}` 的节点视图里暴露一次 `promptHead`（前 120 字节），不要每 5s 回传 prompt。

## 10. 数据所有权与一致性

| 数据 | 所有者（唯一写入口） | 写契约 | 读方 | 一致性/延迟 | 迁移 |
|---|---|---|---|---|---|
| 最新进度快照 | `CMP-scheduler` 的 `ProgressRegistry` | `P-06` | `CMP-run` → UI | 内存、5s 一跳、最多落后 5s | 无 |
| 任务/attempt 事实 | `CMP-scheduler` 的 `task` 表 | `P-01/result` | `ProgressRegistry`（懒校验） | 强一致（读库一次） | 无 |
| session 进度事实 | `CMP-runtime` 的 `RuntimeState` | 内部端口 | `CMP-executor` | 进程内即时 | 无 |
| 展示用的 run 视图 | `CMP-run`（组合） | `GET /runs/{id}` | UI | 请求时拼装 | 无 |
| 完整事件流 | client 本地 + `P-04` | `P-04` | 排障/观测面 | 终态上传 | 无 |

关键：进度是**投影**，不是第二真相；任务是否成功仍只由 `P-02` 结果决定。

## 11. 冷热与容量

### 路径卡：progress 上报（冷偏交互，5s 周期）

| 项 | 内容 |
|---|---|
| 触发/频率 | 每任务每 5s；任务级 |
| SLA | 端到端可见 ≤10s（上报 5s + UI 轮询 5s）；服务端处理目标 p99 <20ms（压测测量，非断言） |
| 经过模块 | CLI → gateway → HTTP → scheduler registry |
| 同步依赖 | 1（调度器 HTTP）；只写内存 |
| 失败模式 | 超时/5xx/网络：丢弃本跳；4xx：停该 attempt；401：等 poll 退出 |
| 超时/重试/幂等 | 2s 超时、不重试、seq 幂等 |
| 资源隔离 | 独立 5s 循环；不与 poll/任务执行共享队列；`Promise.allSettled` + in-flight 跳过 |
| 一致性 | 最终一致，最大陈旧 5s + 网络 |
| 观测 | `progress.sent`/`progress.failed` 计数、payload 字节、`accepted:false` 原因 |

### 容量估算

| 场景 | 上报速率 | 备注 |
|---|---:|---|
| 1 client × 2 并发 | 0.4 req/s | 典型 |
| 100 client × 2 并发 | 40 req/s | 内存更新，无库 |
| 1000 个在跑任务 | 200 req/s | 内存更新、路由不做 DB；单进程上限需压测确认 |
| 载荷 | 典型 ~1.4 KB（8 条动作 + 200B 叙述），上限 8 KiB | 2 并发约 34 KB/min/client |
| 内存 | 10k 条 × ~1 KB ≈ 10 MB | 上限保护 |

与现有热路径的关系：poll 仍是唯一判活/派发路径；progress 是旁路，不共享锁/事务/队列。

## 12. 失败与恢复矩阵

| 场景 | 行为 | 任务影响 |
|---|---|---|
| progress 端点 5xx/超时 | 丢弃本跳，下跳继续 | 无 |
| 旧调度器（无能力） | client 不上报；UI 显示"无进度" | 无 |
| 旧 client（不上报） | 调度器/UI 显示"无进度" | 无 |
| 调度器重启 | 内存清空；下一跳懒校验恢复；期间 UI 显示"等待进度" | 无（任务由 poll 对账） |
| 任务重派 attempt+1 | 旧 attempt 收到 `attempt_mismatch` 后停；新任务重新开始 | 无 |
| 同一 attempt 重复执行（client 重启） | 新 `executionId` 接管并重置 seq；旧 execution 迟到包按 `stale` 忽略 | 无（结果仍首份为准） |
| 任务已结算后迟到进度 | `settled` 忽略；run 已显示结果 | 无 |
| 归属不符 | `404`，client 停 | 无 |
| client 崩溃 | 最后快照留到 TTL/`stale`；UI 显示停更；调度器按 `S-02` 处理任务 | 由既有重派逻辑决定 |
| 取消/停止 | reporter 随 task 结束停；最后快照可能残留到 TTL | 无 |
| 时钟偏差 | 载荷只有相对时长，UI 用 `receivedAt` 递增 | 无 |
| 并行工具 | `tool` 取最近活跃 + `running` 计数 | 无 |
| 超大参数/叙述 | 采集时截断到 200 字节，体上限 8 KiB | 无 |
| 进度量超限 | 淘汰最旧条目；当前任务下跳恢复 | 无 |
| 多调度器实例 | 未解决：进度可能写到 A 实例而 run 读 B 实例 | 记为开放问题 |

## 13. 兼容、发布与回滚

**发布顺序（推荐）**：

1. **调度器**：上线 P-06 路由 + `capabilities` 广告。旧 client 不受影响（忽略新字段，不调新端点）。
2. **client**：上线采样循环 + 能力门控。旧调度器不广告 → 新 client 静默。
3. **UI**：上线渲染；进度字段缺失时保持现状。

**回滚**：

- 回滚 client → 调度器端点闲置，无影响；
- 回滚 UI → 调度器继续保存（无消费者），无影响；
- 回滚调度器 → 新 client 看不到能力，自动停上报；UI 回到无进度；
- 无数据迁移、无脏数据（内存态）。

**兼容承诺**：

- `P-01` 响应新增字段：旧 client 忽略；
- `P-06` 是可选端点：旧 client 从不调用；
- `RunNodeView.progress` 是可选字段：旧 UI 忽略；
- `X-Executor-Protocol` 仍为 `3`；若最终选择 v4，按 §3.2 方案 B 重写本节。

## 14. 验证计划

| 模块 | 契约测试 | 规则/不变量 | 失败/降级 | 冷热/隔离 | 架构约束 |
|---|---|---|---|---|---|
| CMP-runtime | `progress()` 返回工具/usage/计数/`recent`/`narrative` 的形状 | 工具状态迁移；`recent` 上限 8；叙述尾部 ≤200B；未知 id 忽略 | 未知 session 返回 undefined | 不新增定时器 | 不 import gateway/executor 业务 |
| CMP-executor | `snapshotProgress()` 形状与 phase | 四态；并行计数；`activity`/`text` 映射；settle 后消失 | runtime 无进度时降级 preparing | 采样只读，不改任务状态 | 不 import HTTP |
| CMP-cli | 5s 循环调用次数/seq 单调 | 能力缺失不发；任务结束停发；in-flight 跳过 | 5xx/超时/404/400/401 分支；不进任务错误 | 与 poll 并行不互阻 | 退出路径唯一（poll） |
| CMP-gateway | `POST progress` 方法/头/体；能力解析 | 2s 超时；错误码映射 | 404/400/401/413/5xx 测试替身 | 不重试 | 端口不泄漏 HTTP 类型 |
| CMP-scheduler | `reportProgress` 接受/忽略/404 | seq 单调、attempt、settled、归属、TTL、容量淘汰 | 懒校验失败；重启空表；并发同 task | 内存路径不查库（除首跳） | registry 不暴露给网关 |
| CMP-run | `RunNodeView.progress` | 仅 dispatched 附带；finished 为 null | scheduler 读失败降级 null | 并行取数 | 不写进度 |
| UI | 渲染四 phase + stale | 空/停更/旧版本文案 | 不渲染失败 | 5s 轮询不叠加 | 无新依赖 |

关键用例（必须自动化）：

- `progress` 正常：任务开始 5s 后调度器有快照，run detail 可见；
- `seq` 回退被忽略且不报错；
- 重派后旧 attempt 被拒；
- 同一 attempt 换 `executionId` 后接管、seq 重置被接受，旧 execution 迟到包被忽略；
- 结算后进度被忽略、registry 删除；
- 端点 404/5xx/超时不改变任务结果与耗时；
- 调度器重启后 5s 内恢复；
- 能力缺失时 client 零请求；
- 摘要/叙述截断与脱敏（token 值不出现）；叙述关闭时载荷无 `text`、UI 正常降级；
- 用 n3 实测夹具验证"短工具 + 5s 采样"：`activity` 仍能看到动作；
- `activity` 超过 8 条被截断；`text` 超过 200 字节被截断并置 `truncated`；
- 10k 条内存上限淘汰。

## 15. 定级与确认门

**定级：P1**。

触发项（按 `arch-design-spec` §二）：

- 跨仓库公共契约新增（调度器执行面 `P-06` + `P-01` 响应字段）；
- 新数据所有权（`ProgressRegistry`）与投影读路径；
- client 执行期行为变化（新采样循环、新端口方法）；
- 跨 `CMP-runtime`/`CMP-executor`/`CMP-cli`/`CMP-gateway`/`CMP-scheduler`/`CMP-run`/UI 七个模块。

P1 流程：本次是**第一次人参与**（候选设计 + 契约草案 + 取舍）；确认后出最终规格（契约卡定稿、任务表、验证矩阵），第二次人确认冻结，然后才编码。

**需要确认的决策**：

| # | 决策 | 备选 |
|---|---|---|
| C1 | 能力协商（v3 + `capabilities`）而非 protocol v4 | 若调度器侧坚持版本化，改走 v4 双版本过渡 |
| C2 | 首版 phase 不含 `waiting_approval` | 若近期要做交互式审批，则加入 |
| C3 | 进度只存内存、重启丢失 | 若要跨重启保留，需落库（代价见 §3.3） |
| C4 | 载荷含 `activity`（必选）+ `text` 尾部（默认开、可关）；不含 prompt/最终消息全文/工具输出 | 若要完全关闭叙述，设本地开关；工具输出仍只在 `P-04`/观测面 |
| C5 | 5s 固定心跳（无变化也发） | 可改成"变化即发 + 30s 心跳"，但 UI 新鲜度变差 |
| C6 | UI 保持 5s 轮询（可见延迟 5–10s） | 若要 ≤5s，降到 2–3s 或上 SSE |

## 16. 任务拆分（确认后执行）

| ID | 类型 | 组件 | 内容 | 依赖 |
|---|---|---|---|---|
| T-01 | 契约 | 调度器 + client 副本 | P-06、`capabilities`、常量、错误/忽略语义 | C1–C6 |
| T-02 | 实现 | CMP-runtime | `SessionProgress` 采集、`RuntimePort.progress` | T-01 |
| T-03 | 实现 | CMP-executor | 合成 `TaskProgress`、`snapshotProgress`、删除死代码 | T-02 |
| T-04 | 实现 | CMP-gateway | `reportProgress`、能力缓存、错误映射 | T-01 |
| T-05 | 实现 | CMP-cli | 5s 循环、seq、禁用集合、退出清理 | T-03/T-04 |
| T-06 | 实现 | CMP-scheduler | 路由、`ProgressRegistry`、`progress()` 读 | T-01 |
| T-07 | 实现 | CMP-run | `RunNodeView.progress` 组装与降级 | T-06 |
| T-08 | 实现 | UI | 节点进度渲染、stale/空态文案 | T-07 |
| T-09 | 测试 | 全部 | 契约/失败/容量/重启用例 | T-02–T-08 |
| T-10 | 文档 | design | 回填 `architecture.md`、组件规格、契约修订 | T-09 |

## 17. 开放问题

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 调度器是否可能多实例部署？ | 若是，内存 registry 需粘性路由或共享存储；否则 run detail 可能读不到进度 |
| Q2 | 是否接受"调度器重启后短暂无进度"？ | 接受则维持内存方案；不接受则落库并承担写放大 |
| Q3 | 工具摘要是否允许包含命令全文（≤200B）？ | 涉及命令中的 token/路径；默认脱敏 + 截断，需安全确认 |
| Q4 | 是否需要在进度里展示"等待授权"？ | 与交互式审批能力绑定；当前静态策略下不可见 |
| Q5 | `capabilities` 字段由调度器哪个组件生成？ | 本设计放在 scheduler；若网关更合适需调整所有权 |
| Q6 | 是否要把 5s 做成可配置？ | 契约常量 vs client 本地配置；建议本地可配但默认 5s |
| Q7 | `text` 默认开还是关？thought 与 message 都发吗？ | 实测任务 0 条 message、叙事全在 thought；默认关则这个任务仍看不到内容 |
| Q8 | 是否在 run detail 暴露 `promptHead`（一次）？ | 由调度器从 task.prompt 截取前 120 字节，UI 用于任务上下文；不进 5s 载荷 |

## 18. 结论

模式 C + 5s 在现有架构下是**可隔离的加法**：client 侧只是"多采样一份事实"，调度器侧只是"多存一个内存快照"，UI 只是"多渲染几行字"。真正的成本集中在三点：

1. 契约必须写成**可选能力**，否则两个仓库的发布顺序会互相卡住；
2. 进度必须**旁路**（不参与判活/重派/结算），否则会把观测问题变成执行问题；
3. 载荷必须只含**摘要**，否则会把日志的隐私问题搬到调度器内存和 UI 上。

按本设计，5s 上报的容量与失败面都在可控范围内；确认 §15 的 C1–C6 后即可出最终规格与实现任务。
