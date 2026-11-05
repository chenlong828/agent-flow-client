---
layer: works
module: global
status: active
updated: 2026-11-04
---

# 调度器契约提案：执行面客户端的接口依赖（v0.1）

> **权威在调度器侧。** 本稿是 client 消费端的需求提案，不是冻结契约；端点路径、字段名、状态码都可以谈，但 §7 的调度器责任、§8 的客户端承诺与 §6 的枚举闭集是 client 实现要依赖的语义，改动需要双侧确认。
>
> 上游依据：`../../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`、同目录 `client-work.md`、`../../../../agent-flow-orchaster/docs/design/components/http-gateway/spec.md`；本仓库 `docs/design/architecture.md` §3/§4/§9、`CMP-executor` §3.4、`CMP-gateway`、`CMP-cli`、`CMP-assets`、`CMP-result`。
>
> 现状：9 个组件均为 `planned`，代码未落地；本稿把「端口签名」推进到「字段级 HTTP 契约 + 双侧责任 + 执行器承接」，供 M1 冻结。

## 1. 一句话结论

调度器只需要向 client 提供 **6 个控制面操作 + 1 个制品通道**：

`register`、`heartbeat`（长轮询，兼控制事件）、`claim`、`renew`、`bindSession`、`reportResult`，以及技能包下载。

client 不读调度器数据库、不执行编排、不接受调度器主动连接；所有交互由 client 出站。其余能力（工作流定义、节点选择、评审、分支、fan-out 拆分、产物、会话全文、日志）都不在契约面内。

## 2. 一页结论

### 2.1 契约面总表

| ID | 操作 | HTTP | 端口方法 | 消费组件 | 频率/冷暖 | 幂等键 |
|---|---|---|---|---|---|---|
| `C-01` | 注册 | `POST /api/v1/executor/register` | `register` | `CMP-cli` | 启动/重连；热 | `(clientId, runId)` |
| `C-02` | 心跳 + 控制事件 | `POST /api/v1/executor/heartbeat` | `heartbeat` | `CMP-cli` | 30s 长轮询；热 | `ackSeq` 累计确认 |
| `C-03` | 领取 | `POST /api/v1/executor/claim` | `claim` | `CMP-cli` | 有空容量时；热 | `attemptId` |
| `C-04` | 会话绑定 + 技能集 | `POST /api/v1/executor/attempts/{attemptId}/session` | `bindSession` | `CMP-executor` | 每 attempt 一次；冷 | `(attemptId, sessionId)` |
| `C-05` | 技能包下载 | `GET /api/v1/executor/skill-packages/{packageId}/download` | 无（`CMP-assets` 直连） | `CMP-assets` | 每包一次；冷 | `packageId + digest` |
| `C-06` | 尝试续租 | `POST /api/v1/executor/attempts/{attemptId}/lease` | `renew` | `CMP-cli` | TTL/3；热 | `attemptId` |
| `C-07` | 结果上报 | `POST /api/v1/executor/attempts/{attemptId}/result` | `reportResult` | `CMP-executor` | 每 attempt 一次 + 重试；冷 | `attemptId` |

### 2.2 三个身份

| 身份 | 生命周期 | 谁生成 | 用途 |
|---|---|---|---|
| `clientId` | 长期 | 调度器发放（与凭据绑定） | 实例粘性、审计、attempt 归属 |
| `runId` | 每次进程启动 | client | 区分重启/双跑；fencing 旧进程；不进 attempt 身份 |
| `attemptId` | 一次执行尝试 | 调度器 | 去重、幂等、结果归属；**重跑必须换新值** |

> attempt 归属按 `(clientId, attemptId)` 判定，不按 `runId`。client 崩溃重启后换了 `runId`，仍可重报旧 attempt 的已结算结果（`SCH-11`）。

### 2.3 两条租约

| 租约 | 授予 | 续租 | 默认 TTL | 过期含义 |
|---|---|---|---|---|
| 客户端租约 | `register` | 每次 `heartbeat` 请求到达即续 | 90s（> 30s 长轮询） | 调度器判定 client 离线；停止派发 |
| 尝试租约 | `claim` / `renew` | `renew`，建议 TTL/3 一次 | 120s（按节点类型可调） | 该 attempt 不再归本 client；迟到结果只审计 |

两刀分开：心跳断了不等于 attempt 立刻失效；attempt 租约过期也不等客户端租约过期。客户端租约决定「还能不能领新活」，尝试租约决定「当前这活还算不算我的」。

### 2.4 需要双侧裁决的 12 件事

见 §15。阻塞 S1 的 6 件：容量与同实例并发（Q1）、重跑 attempt 身份（Q2）、迟到结果表达（Q3）、claim 是否长轮询（Q5）、技能包通道（Q6）、认证方式（Q7）。

## 3. 依赖总览：组件要调度器提供什么

| 组件 | 为什么依赖调度器 | 需要的契约面 | 调用时机 | 缺失/违约时的后果 |
|---|---|---|---|---|
| `CMP-cli` | `serve` 循环：注册、存活、容量、领活、租约、控制事件 | `C-01`、`C-02`、`C-03`、`C-06` | 启动、30s 心跳、有空容量、活跃 attempt | 无法领取；租约误判；控制事件丢失 |
| `CMP-executor` | 建 session 后取技能集；结算后上报结果 | `C-04`、`C-07` | `newSession` 之后、`settled` 之后 | 无法 prompt；结果无法归属 |
| `CMP-gateway` | 全部 HTTP 的防腐层：鉴权、版本、长轮询、重试、幂等、租约计时 | `C-01`…`C-07` | 由 CLI/executor 调用 | 协议细节渗进领域层 |
| `CMP-assets` | 按 manifest 下载技能包、校验 digest | `C-05`（`C-04` 返回的 manifest） | 技能安装前 | 无法刷新技能；只能失败 |
| `CMP-result` | 产出 `NodeResult` 的字段与错误分类 | `C-07` 的请求体形状 | 结算 | 结果不可解析/不可判定 |
| `CMP-store` | 不直接依赖调度器 | 无 | — | — |
| `CMP-runtime` | 不直接依赖调度器；`workspacePath` 与 `instanceId` 经 `C-03` 传入 | 无 | — | — |
| `CMP-workspace` | 不直接依赖调度器；只校验 `C-03` 给的容器路径 | 无 | — | — |
| `CMP-observability` | 不直接依赖调度器；用 `requestId` / `serverTime` 关联日志 | 无 | — | — |

**client 明确不需要的调度器能力**：

- 工作流定义、节点选择、评审、分支、fan-out 拆分、回退；
- 读数据库、读专家/技能装配、审计查询；
- 调度器主动连接 client、WebSocket/SSE、本地监听端口；
- 产物上传、会话全文、日志上传、跨 client 迁移；
- 调度器管理 DSH 进程、工作区或技能目录。

## 4. 通用约定

### 4.1 传输与格式

- 基础路径：`/api/v1/executor`；全部 `POST`/`GET`，请求/响应 `application/json; charset=utf-8`（`C-05` 为 `application/zip`）。
- ID：除 `sessionId`（DSH 生成）外均为 UUIDv7 字符串；时间均为 ISO-8601 UTC（`2026-11-04T01:02:03Z`）。
- 每个请求可带 `X-Request-Id`；服务端回显，未带则生成。client 把 `requestId` 写进日志与审计关联键。
- 成功响应直接返回对象，不包 `data`；错误响应沿用上游错误信封（§4.4）。
- 未知响应字段必须忽略；未知**请求**字段服务端应拒绝 `400 validation_error`，避免静默丢字段。

### 4.2 身份与鉴权

所有请求带：

```http
Authorization: Bearer <client-token>
X-Client-Run-Id: <runId>
```

- `clientId` 由 token 绑定；`register` 请求体再显式带一次，服务端校验一致，不一致 `400`。
- `runId` 每次进程启动生成；由 `CMP-cli` 组合根生成并注入 `CMP-gateway`，`register` 之后所有请求由 gateway 自动带头。服务端用它做 fencing 与审计，不用于 attempt 归属；端口方法不新增 `runId` 参数。
- 401：凭据缺失/失效；403：凭据有效但无权访问该 attempt/package/实例。client 对两者都按「停止领取、退出 3」处理，但日志保留 HTTP 状态。
- 生产必须 HTTPS；`http://` 只允许 loopback 开发。client 启动时校验 `scheduler.url`，非 HTTPS 且非 loopback → 退出 2。
- 上游现有 `/api/v1` 面按「只监听 `127.0.0.1`、无登录/鉴权」设计；`/api/v1/executor` 是机器对机器的出站面，必须独立鉴权并走 TLS，不能沿用无鉴权假设。
- token 只从注入的凭据读取；不进 URL、日志、结果、prompt。轮换机制本版不做（Q7）。

### 4.3 版本协商

- `protocolVersion`：日期 + 递增序号，如 `2026-11-04.1`；只做加法时递增末位。
- `register` 上报 `protocolVersion` / `clientVersion` / ACP 版本 / DSH 版本；服务端返回 `protocolVersion` 与 `compatibility`。
- `compatibility = "compatible" | "deprecated"`：`deprecated` 继续工作，响应带 `sunsetAt`，client 记警告。
- 不兼容：`426 version_incompatible`，`details` 带 `clientProtocolVersion`、`minProtocolVersion`、`maxProtocolVersion`；client 停止领取，退出 3。
- 服务端不得用「未知字段」表达新语义；新增必填字段视为破坏性变更。

### 4.4 错误信封

```json
{
  "error": {
    "code": "late_result",
    "message": "尝试已关闭，结果只入审计",
    "details": { "attemptId": "<uuid-v7>", "attemptState": "closed" },
    "requestId": "<request-id>"
  }
}
```

稳定错误码：

| HTTP | `code` | 触发 | client 端口层错误 | 可重试 |
|---:|---|---|---|---|
| 400 | `validation_error` | 字段缺失/类型错/未知字段/长度超限 | `invalid_request` | 否 |
| 401 | `unauthorized` | 凭据缺失/失效 | `unauthorized` | 否（退出 3） |
| 403 | `forbidden` | 无权访问该 attempt/package | `unauthorized`（details 保留 `forbidden`） | 否（退出 3） |
| 404 | `attempt_not_found` / `package_not_found` | attempt/包不存在 | `invalid_request`（details 保留 404） | 否 |
| 410 | `package_gone` | 包已失效/下架 | `invalid_request`（details 保留 410） | 否 |
| 409 | `stale_attempt` | attempt 已绑定/已终态/已重派 | `stale_attempt` | 否 |
| 409 | `invalid_session` | session 不属于本 attempt/client，或已关闭 | `invalid_session`（新增） | 否 |
| 409 | `lease_expired` | 尝试租约已过期 | `lease_expired` | 否 |
| 409 | `late_result` | 结果晚于关闭/重派 | `late_result` | 否（只审计） |
| 409 | `run_superseded` | 同一 clientId 有更新的 runId | `run_superseded`（新增） | 否 |
| 413 | `payload_too_large` | 请求/结果/包超限 | `invalid_request`（details 带 limit） | 否 |
| 426 | `version_incompatible` | 协议不兼容 | `version_incompatible` | 否（退出 3） |
| 429 | `rate_limited` | 限流 | `rate_limited` | 是（按 `Retry-After`） |
| 500 | `internal` | 未分类服务端错误 | `unreachable` | 是 |
| 503 | `service_unavailable` | 依赖不可用/维护 | `unreachable` | 是（按 `Retry-After`） |

> 传输层失败（连接拒绝、DNS、TLS、超时、5xx 解析失败）不产生 HTTP 错误码，由 `CMP-gateway` 归一为 `unreachable` / `timeout`；HTTP 状态码与 JSON 信封不进入 `SchedulerPort`。

### 4.5 幂等与重试

- `claim` / `bindSession` / `reportResult` / `renew` 均以 `attemptId` 为幂等键；同一键重复请求不产生第二次执行、不改变已接受结果。
- 传输重试只改变传输结果，不改变业务语义；client 只在「请求未得到确定响应」时重试。
- 收到确定错误（4xx）不重试，除 `429` 按 `Retry-After` 退避。
- `reportResult` 重复提交：服务端返回首次结果的 `ack`，`disposition = "duplicate"`；client 不再重复上报。
- `claim` 重复提交：同一 attempt 不得同时租给两个 client/run；同一 client 的重复调用由 client 单飞去重。
- 本契约面不使用上游面向人的 `If-Match` / `revision` 并发控制：没有资源版本语义；并发由 `attemptId` 幂等 + 租约承担。

### 4.6 长轮询

| 项 | `heartbeat`（`C-02`） | `claim`（`C-03`） |
|---|---|---|
| 服务端挂起 | 30s；有事件立即返回 | 20s；有请求立即返回 |
| 空结果 | `200`，`events: []`，`seq = ackSeq` | `204`，可带 `Retry-After` |
| 客户端超时 | 35s（服务端挂起 + 余量） | 25s |
| 超时语义 | 断连信号，退避重连；不是业务失败 | 无活；等待下一次心跳或短退避 |
| 连接数 | 每 client 1 条常驻 | 按容量最多 1 条常驻 |

- 服务端可通过 `nextPollAfterMs` 要求 client 放慢心跳；client 取 `max(serverPollTimeout, nextPollAfterMs)`。
- 长轮询断开不重建执行状态；重连后心跳带 `ackSeq`，claim 重新判断容量。
- 两条长轮询意味着每 client 至多 2 条挂起连接；若调度器侧承压，可把 claim 退化为「立即 `204` + `Retry-After`」，client 两种都支持（Q5）。

### 4.7 时间、租约与限制

- 每个成功 JSON 响应带 `serverTime`（`C-05` 二进制响应用 `Date` 头）；租约响应带 `expiresAt` + `ttlMs`。
- client 不用本地墙钟判断过期：用「响应中的 `serverTime` + 单调时钟经过量」计算剩余时间；容忍 ±5s 偏差。
- `register` 返回 `limits`：`maxResultBytes`（默认 262144）、`maxPromptBytes`（默认 1048576）、`maxRequestBytes`（默认 2097152）、`maxSkillPackageBytes`（默认 67108864）、`maxSkillPackages`（默认 64）。超限服务端返回 `413`，不静默截断。
- client 结果截断在 `CMP-result` 完成，保证 `NodeResult` 序列化后不超过 `maxResultBytes`；`truncated=true`。

### 4.8 安全

- prompt 与结果可能含业务敏感文本；client 不把 prompt 原文、模型输出、凭据写进日志/审计。
- `C-05` 若 `downloadUrl` 指向调度器以外的 host，必须是短期签名 URL；client 不得把 `Authorization` 发给第三方 host（见 `C-05`）。
- 服务端审计记录 `clientId` / `runId` / `instanceId` / `nodeId` / `attemptId` / `sessionId` / `requestId`，不要求 client 回传全文。

## 5. 端点契约

### 5.1 `C-01` 注册

**用途**：建立 client 身份、上报版本与容量、取得客户端租约与限制；可选下发实例绑定快照。
**消费方**：`CMP-cli` → `SchedulerPort.register`，启动时调用；重连可重复调用。
**调用时机**：进程启动、配置加载后、清理孤儿后；心跳持续失败重连时可重注册。

请求：

```json
{
  "clientId": "<uuid-v7>",
  "protocolVersion": "2026-11-04.1",
  "clientVersion": "0.1.0",
  "runtime": {
    "acpVersion": "1",
    "dshVersion": "0.2.2-alpha.2",
    "os": "darwin",
    "arch": "arm64"
  },
  "capacity": {
    "maxInstances": 4
  },
  "labels": {
    "host": "chenlong-mbp"
  }
}
```

响应 `200`：

```json
{
  "serverTime": "2026-11-04T01:02:03Z",
  "protocolVersion": "2026-11-04.1",
  "compatibility": "compatible",
  "clientLease": { "expiresAt": "2026-11-04T01:03:33Z", "ttlMs": 90000 },
  "heartbeat": { "pollTimeoutMs": 30000, "clientTimeoutMs": 35000, "nextPollAfterMs": 0 },
  "limits": {
    "maxResultBytes": 262144,
    "maxPromptBytes": 1048576,
    "maxRequestBytes": 2097152,
    "maxSkillPackageBytes": 67108864,
    "maxSkillPackages": 64
  },
  "assignmentsVersion": 7,
  "assignments": [
    { "instanceId": "<uuid-v7>", "workspacePath": "/abs/instance-a", "state": "active" }
  ]
}
```

**语义与不变量**：

1. 幂等键 `(clientId, runId)`；同键重复注册刷新客户端租约，返回当前 `assignmentsVersion` 与 `limits`。
2. 同一 `clientId` 出现新 `runId`：新 run 生效，旧 run 之后的 `heartbeat`/`claim`/`renew` 返回 `409 run_superseded`；旧 run 已 `settled` 的结果仍可按 `clientId + attemptId` 重报（`SCH-11`）。旧 run 再次 `register` 也返回 `409 run_superseded`。
3. `assignments` 是**可选**快照：client 有则用于重启后校验容器；没有则从 journal 恢复，不阻塞领取。变更通过 `assignmentsVersion` 递增，心跳响应在版本变化时带回（§5.2）。实例从快照消失不触发删除容器——清理只由 `shutdown.cleanup`、实例释放或操作者触发。
4. `assignments[].workspacePath` 必须是绝对路径、已预置、位于任何 git 仓库之外、实例内稳定（`SCH-04`）；client 只校验，不创建/不 clone。`state` 取 `active`（有活跃/待执行 attempt）或 `waiting`（已准备、空闲）。
5. `compatibility = "deprecated"` 时带 `sunsetAt`；`426` 表示不兼容。
6. `limits` 在 register 下发，运行期视为不变；变更需重新注册（client 重启或重连）。
7. 认证失败 `401`/`403`、版本失败 `426`：终止，退出 3；`409 run_superseded`：停止领取、取消活跃（`reason=superseded`），按 Q12 收口；`429`/`5xx`：退避重试；持续不可达达到阈值退出 6。
8. 传输层重连**不重新 `register`**：同一 `runId` 的 `heartbeat`/`claim` 直接重试；只有新进程（新 `runId`）或调度器显式要求时才重新注册。

**错误**：`400`、`401`、`403`、`409 run_superseded`、`426`、`429`、`500`、`503`。

### 5.2 `C-02` 心跳（长轮询 + 控制事件）

**用途**：续客户端租约、上报状态与容量、接收控制事件、累计确认。
**消费方**：`CMP-cli` 独立心跳任务 → `SchedulerPort.heartbeat`；与执行任务不共享定时器/队列。

请求：

```json
{
  "state": {
    "pausedInstances": [],
    "capacity": {
      "maxInstances": 4,
      "activeInstances": 2,
      "activeAttempts": 2
    },
    "activeAttempts": [
      { "attemptId": "<uuid-v7>", "instanceId": "<uuid-v7>", "phase": "running", "sessionId": "<session-id>" }
    ]
  },
  "ackSeq": 41,
  "assignmentsVersion": 7
}
```

响应 `200`（有事件）：

```json
{
  "serverTime": "2026-11-04T01:02:33Z",
  "clientLease": { "expiresAt": "2026-11-04T01:04:03Z", "ttlMs": 90000 },
  "control": {
    "seq": 42,
    "events": [
      { "type": "cancel", "instanceId": "<uuid-v7>", "reason": "user_cancel", "issuedAt": "2026-11-04T01:02:30Z" }
    ]
  },
  "assignmentsVersion": 7,
  "nextPollAfterMs": 30000
}
```

无事件时 `200`：

```json
{
  "serverTime": "2026-11-04T01:03:03Z",
  "clientLease": { "expiresAt": "2026-11-04T01:04:33Z", "ttlMs": 90000 },
  "control": { "seq": 41, "events": [] },
  "assignmentsVersion": 7,
  "nextPollAfterMs": 30000
}
```

- `assignmentsVersion` 与 client 上报值不同时，响应额外带 `assignments` 快照（结构同 `C-01`）；相同则省略。client 以最新快照替换本地视图，不阻塞执行。
- `state.activeAttempts[].phase` 取尝试生命周期值：`claimed` / `bound` / `ready` / `running` / `settled` / `reported`；只用于观测。
- `state.pausedInstances` 列出本 client 当前暂停的实例；暂停由控制事件驱动、权威在调度器，这里只用于观测。

**控制事件闭集**：

| `type` | 字段 | client 行为 | 结果/收口 |
|---|---|---|---|
| `cancel` | `instanceId`、`reason`（固定 `user_cancel`） | 立即终止该实例所有活跃 attempt：abort → `session/cancel` → 关 session → 杀进程组 | `cancelled(user_cancel)`；已结算的只 ack |
| `pause` | `instanceId` | 停止该实例领取；取消活跃 attempt（`reason = paused`） | `cancelled(paused)`；恢复后由调度器重新派发（新 attemptId） |
| `resume` | `instanceId` | 恢复该实例领取 | 无 attempt 结果 |
| `shutdown` | `instanceId?`、`cleanup?` | 有 `instanceId`：释放该实例（取消活跃、关 session/进程、按 `cleanup` 清理、释放容量）；无：优雅停整个 client | 活跃 attempt `cancelled(shutdown)`；尽力上报后退出 0（信号退出用 130/143） |

- `cancel` 只承载 `user_cancel`；`paused` / `shutdown` 分别由 `pause` / `shutdown` 事件产生。`lease_expired`、`superseded`、`signal`、`prompt_timeout` 是 client 本地原因，出现在结果里，不来自控制事件。
- `cleanup` 闭集：`keep`（默认）/ `clean-skills` / `clean-client`；对应 `WorkspacePort.cleanup` 策略。

**序号与确认**：

1. 服务端按 client 维护单调 `seq`；同一批事件按 `seq` 升序、连续；`control.seq` 是本批最大序号；空批 `seq = ackSeq`。
2. 至少一次投递；client 重连后带 `ackSeq`，服务端从 `ackSeq + 1` 补发；client 按 `seq` 幂等应用。
3. client 在下一跳心跳带「已处理的最大连续 `seq`」作为 `ackSeq`；有空洞时不得越过空洞确认，服务端应重发。
4. 未知事件类型：ack + 记录，不崩溃；已结算/已释放实例的事件：只 ack（审计记 stale）。

**语义与不变量**：

1. 请求到达即续客户端租约；断开/超时是离线信号，最终以租约过期裁决（`SCH-07`）。
2. 心跳循环独立于执行；prompt 长等不得阻塞心跳。
3. `state.activeAttempts` 是观测信息，不是权威；服务端不得据此推进状态。
4. `401`/`403`/`426` 终止，退出 3；`409 run_superseded` 停止领取、取消活跃 attempt（`reason=superseded`），按 Q12 收口；`429`/`5xx`/超时：退避重连，不视为业务失败。

**错误**：`400`、`401`、`403`、`409 run_superseded`、`426`、`429`、`500`、`503`。

### 5.3 `C-03` 领取

**用途**：取一个绑定本 client 的节点执行请求与尝试租约。
**消费方**：`CMP-cli` 领取循环 → `SchedulerPort.claim`；只在有可用容量时调用。

请求：

```json
{
  "capacity": { "availableInstances": 2 },
  "acceptLongPollMs": 20000
}
```

响应 `200`：

```json
{
  "attemptId": "<uuid-v7>",
  "attemptNo": 1,
  "instanceId": "<uuid-v7>",
  "nodeId": "<uuid-v7>",
  "workspacePath": "/abs/instance-a",
  "prompt": "……节点 prompt，输出契约在文本内……",
  "timeoutMs": 1800000,
  "lease": { "expiresAt": "2026-11-04T01:04:33Z", "ttlMs": 120000 }
}
```

无活：`204 No Content`，可带 `Retry-After`。

**语义与不变量**：

1. 只返回绑定本 `clientId` 的实例；同一实例同一时刻不得有两个 client 的活跃 attempt（`SCH-01`）。
2. 同一 `attemptId` 同一时刻只租给一个 client/run；重复投递到同一 client 由单飞去重，不重复执行（`SCH-02`）。
3. `workspacePath` 是准备阶段预置的容器根：绝对、存在、可写、位于任何 git 仓库之外、实例内稳定；client 不 clone/checkout/创建（`SCH-04`）。
4. `prompt` 是 opaque 文本，输出契约在文本内；client 不解析业务字段；字节数不得超过 `limits.maxPromptBytes`，超限 client 拒绝执行并报 `scheduler` 失败（调度器违约）。
5. `timeoutMs` 是 prompt 执行超时（毫秒，正整数）；client 以它为准，超时走 `timeout`，不等自然结算。
6. `lease` 在响应时生效；client 在 TTL/3 时 `renew`（§5.6）。
7. 无容量时不要调用；`availableInstances = 0` 时服务端可立即 `204`。
8. 技能集不在 claim 返回；由 `C-04` 在 session 建立后返回（避免同一节点两处真相）。

**错误**：`400`、`401`、`403`、`409 run_superseded`、`426`、`429`、`500`、`503`。

**client 失败处理**：`204` → 等心跳/短抖动后再领；`429`/`5xx`/超时 → 退避；`401`/`403`/`426` → 退出 3；`409 run_superseded` → 停止领取，按 Q12 收口。

### 5.4 `C-04` 会话绑定 + 技能集

**用途**：把本 client 为本 attempt 创建的 DSH session 绑定到调度器，取该节点的技能集。
**消费方**：`CMP-executor` 在 `runtime.newSession` 之后 → `SchedulerPort.bindSession`；失败则不 prompt。

请求：

```json
{
  "sessionId": "<session-id>",
  "cwd": "/abs/instance-a"
}
```

响应 `200`：

```json
{
  "attemptId": "<uuid-v7>",
  "sessionId": "<session-id>",
  "skillSet": {
    "digest": "sha256:<hex>",
    "packages": [
      {
        "packageId": "<uuid-v7>",
        "name": "code-review",
        "version": "1.2.0",
        "digest": "sha256:<hex>",
        "sizeBytes": 123456,
        "downloadUrl": "/api/v1/executor/skill-packages/<uuid-v7>/download",
        "etag": "\"sha256-<hex>\""
      }
    ]
  },
  "lease": { "expiresAt": "2026-11-04T01:04:33Z", "ttlMs": 120000 }
}
```

**语义与不变量**：

1. 只能在 `session/new` 之后调用；`sessionId` 必须由本 client 为本 attempt 创建且未关闭；一个 attempt 只绑定一个 session。
2. 同一 `(attemptId, sessionId)` 重复调用返回同一 `skillSet`（幂等）；换 `sessionId` → `409 invalid_session`；attempt 已终态/已重派 → `409 stale_attempt`。
3. 同一 attempt 的 `skillSet.digest` 必须稳定；同一容器上并发 attempt 的 digest 必须一致（`SCH-05`）。client 发现同容器不同 digest 且有活跃 session → `asset_skill_set_conflict`，不 prompt，节点失败。
4. `digest` 的规范化（包排序、去重、哈希算法）由调度器定义；client 只做相等比较与按包 `digest` 校验，不自行重算集合 digest。
5. `packages` 是集合，顺序无语义；空数组表示空技能集，client 清空容器根 `.dsh/skills`。
6. `downloadUrl` 可为相对路径（拼 `scheduler.url`）或绝对 URL；绝对且跨 host 时必须是短期签名 URL，client 不发 `Authorization`（`C-05`）。
7. `sizeBytes` 用于预检与磁盘保护；`etag` 用于缓存。
8. `cwd` 必须等于 claim 的 `workspacePath`；不一致 `400`，防止客户端串容器。
9. `packages.length` 不得超过 `limits.maxSkillPackages`；超限按 `asset` 失败，不 prompt。

**错误**：`400`、`401`、`403`、`404 attempt_not_found`、`409 stale_attempt`、`409 invalid_session`、`429`、`500`、`503`。

**client 失败处理**：关闭该 session；结果 `failed`，`error.class = scheduler`（不可重试）或 `asset`（manifest 不合法）；不 prompt；已结算的上报走 `C-07`（可能是 `late_result`）。

### 5.5 `C-05` 技能包下载

**用途**：按 `C-04` 的 manifest 取技能包 zip；由 `CMP-assets` 直接调用，不经 `CMP-gateway`。
**消费方**：`CMP-assets`；素材来自 `C-04`。

请求：

```http
GET /api/v1/executor/skill-packages/<packageId>/download
Authorization: Bearer <client-token>
If-None-Match: "sha256-<hex>"
```

响应：

- `200 application/zip`：`Content-Length`、`ETag`、`X-Checksum-Sha256: <hex>`、`Cache-Control: private, max-age=3600`。
- `304 Not Modified`：`ETag` 命中，client 用本地缓存。
- `404 package_not_found` / `410 package_gone`：包已失效；不可重试，节点失败（asset）。
- `403`：无权访问；终止，退出 3。
- `413`（可选）：服务端拒绝超限包；client 按 asset 失败处理。正常应由 client 先按 manifest `sizeBytes` 预检。
- `429` / `5xx`：退避重试。

**语义与不变量**：

1. `packageId` 对应不可变内容；同一 `packageId` 的字节不得变化。若内容变，必须换 `packageId` 与 `digest`。
2. client 下载后必须校验 `X-Checksum-Sha256`（或 manifest `digest`）与 `sizeBytes`；不匹配 → 重试一次，仍失败 → `checksum_mismatch`，不 prompt。
3. client 在下载前按 `sizeBytes` 与 `limits.maxSkillPackageBytes` 预检；`Content-Length` 超限或实际字节超限时中止，不写工作区。
4. client 以 digest 为缓存键；缓存命中且 digest 一致时跳过下载。
5. 包解压必须防路径穿越/越界符号链接；只在容器内 staging 目录解压，成功后原子替换 `.dsh/skills`。
6. 若 `downloadUrl` 跨 host：只允许短期签名 URL；client 不发送调度器 token，避免凭据泄漏。

**client 失败处理**：`404`/`410`/`413`/digest 不匹配 → `asset` 类失败，不 prompt；`429`/`5xx`/超时 → 退避重试；`403` → 退出 3。

### 5.6 `C-06` 尝试续租

**用途**：在 prompt 长等期间保持 attempt 归属，避免被判定过期/重派。
**消费方**：`CMP-cli` 租约任务 → `SchedulerPort.renew`；只对活跃 attempt 调用。

请求：`POST /api/v1/executor/attempts/{attemptId}/lease`，body `{}`（身份在头里）。

响应 `200`：

```json
{
  "serverTime": "2026-11-04T01:03:03Z",
  "lease": { "expiresAt": "2026-11-04T01:05:03Z", "ttlMs": 120000 }
}
```

**语义与不变量**：

1. 续租幂等；在租约有效期内重复调用只延长。
2. `409 lease_expired`：已过期；client 立即 abort、关 session、杀进程组，结果 `cancelled(lease_expired)`，仍尝试上报（服务端多半回 `late_result`）。
3. `409 stale_attempt`：attempt 已终态/已重派；abort 并以 `cancelled(superseded)` 收口，不再重试。
4. `404 attempt_not_found`：视为契约/实现错误；abort 并以 `cancelled(superseded)` 收口，同时告警。
5. `409 run_superseded`：本 run 已被新 run 顶掉；立即 abort 活跃 attempt（`reason=superseded`），按 Q12 收口，不再续租。
6. 只对 `claimed`…`running` 的 attempt 调用；`settled` 之后停止续租。
7. 续租失败但未过期：继续按 TTL/3 重试；到 `expiresAt` 仍失败才 abort。

**错误**：`401`、`403`、`404`、`409 lease_expired`、`409 stale_attempt`、`409 run_superseded`、`429`、`500`、`503`。

### 5.7 `C-07` 结果上报

**用途**：把已 `settled` 的 `NodeResult` 交给调度器；按 `attemptId` 幂等。
**消费方**：`CMP-executor` 在 journal 记 `settled` 之后 → `SchedulerPort.reportResult`；失败只重试上报，不重跑。

请求：

```json
{
  "result": {
    "attemptId": "<uuid-v7>",
    "status": "succeeded",
    "sessionId": "<session-id>",
    "message": "最终消息（可能被截断）",
    "truncated": false,
    "stopReason": "end_turn",
    "usage": { "inputTokens": 1234, "outputTokens": 567 },
    "error": null,
    "startedAt": "2026-11-04T01:02:10Z",
    "finishedAt": "2026-11-04T01:03:40Z"
  }
}
```

失败/取消/超时：

```json
{
  "result": {
    "attemptId": "<uuid-v7>",
    "status": "cancelled",
    "sessionId": "<session-id>",
    "message": "",
    "truncated": false,
    "stopReason": null,
    "usage": null,
    "error": {
      "class": "cancelled",
      "code": "cancelled",
      "message": "实例被取消",
      "retryable": false,
      "reason": "user_cancel"
    },
    "startedAt": "2026-11-04T01:02:10Z",
    "finishedAt": "2026-11-04T01:02:50Z"
  }
}
```

响应 `200`：

```json
{
  "attemptId": "<uuid-v7>",
  "disposition": "accepted",
  "attemptState": "reported",
  "recordedAt": "2026-11-04T01:03:41Z"
}
```

`disposition`：`accepted`（首次接受）| `duplicate`（重复上报，返回首次结果）。

**语义与不变量**：

1. `attemptId` 全局唯一；同一 attempt 第一次被接受的 `NodeResult` 为准，后续重复上报不覆盖。
2. 结果上报不要求 `runId` 一致：按 `(clientId, attemptId)` 归属；client 重启后可用新 `runId` 重报旧 attempt；该 attempt 未被重派且未被调度器关闭时接受，否则 `late_result`（`SCH-11`）。
3. `late_result`（409）：attempt 已关闭或已重派；只入审计，不推进状态、不覆盖新 attempt。client 收到后记 `reported` → `closed`，不再重试。
4. `truncated=true` 是合法结果，调度器不得当作失败；结果大小上限由 `limits.maxResultBytes` 约束。
5. 结果只含控制信息：状态、最终消息、停止原因、用量、session、错误类别；不含产物、会话全文、日志、凭据。
6. `error.class` 闭集见 §6.5；`retryable` 只是提示，最终由调度器裁决。
7. `400 validation_error`：schema 不合法，视为实现缺陷；client 记录并告警，当前建议不再重试、标记 `closed`、保留 journal 证据（M1 可细化）。
8. `413 payload_too_large`：client 应先按 `maxResultBytes` 截断；仍 413 属契约/实现错误，处理同 7。

补充：路径 `{attemptId}` 与 body `result.attemptId` 必须一致，否则 `400`；`409 run_superseded` **不适用于结果上报**——旧 run 的已结算结果仍按 `(clientId, attemptId)` 接受，只有 `late_result` 会拒绝。

**错误**：`400`、`401`、`403`、`404 attempt_not_found`、`409 late_result`、`413`、`429`、`500`、`503`。

**client 失败处理**：`5xx`/`429`/超时 → 指数退避重试，journal 保持 `settled`；进程退出后下次启动 `recover` 重报；`409 late_result` → `reported` → `closed`；`404 attempt_not_found` → 记录告警、保留 journal 证据、标记 `closed`（不再重试）；`401`/`403` → 退出 3（结果保留在 journal，下次带有效凭据重报）。

## 6. 字段级值类型与枚举

> 以下为提案草案；字段名可改，语义与闭集是本稿要保的部分。未列字段一律视为未知字段，双方忽略。

### 6.1 `NodeRequest`（`C-03` 响应体）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `attemptId` | UUIDv7 | 是 | 一次执行尝试的幂等键 |
| `attemptNo` | integer ≥1 | 否 | 同一节点第几次尝试；仅审计/观测，不参与去重 |
| `instanceId` | UUIDv7 | 是 | 工作流实例；决定容器与进程归属 |
| `nodeId` | UUIDv7 | 是 | 节点定义 ID；client 不解释 |
| `workspacePath` | string | 是 | 容器根绝对路径；预置，client 只校验 |
| `prompt` | string | 是 | opaque 文本；输出契约在文本内 |
| `timeoutMs` | integer >0 | 是 | prompt 执行超时；client 强制执行 |
| `lease` | `Lease` | 是 | 尝试租约 |

### 6.2 `NodeResult`（`C-07` 请求体）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `attemptId` | UUIDv7 | 是 | 与请求一致 |
| `status` | enum | 是 | `succeeded` / `failed` / `cancelled` / `timeout` |
| `sessionId` | string | 否 | session 建立后必填；建 session 前的失败可省略 |
| `message` | string | 是 | 最终消息；失败/取消时为空串 |
| `truncated` | boolean | 是 | 是否因大小上限被截断 |
| `stopReason` | string \| null | 是 | ACP 停止原因；未知值原样保留；失败/取消为 `null` |
| `usage` | object \| null | 是 | `{ inputTokens?, outputTokens? }`；未知省略字段，不写 0 |
| `error` | object \| null | 是 | 成功为 `null`；失败/取消/超时为 §6.5 |
| `startedAt` | ISO-8601 | 否 | 审计用；client 时钟，允许偏差 |
| `finishedAt` | ISO-8601 | 否 | 审计用 |

### 6.3 `SkillSet`（`C-04` 响应）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `digest` | `sha256:<hex>` | 是 | 整个技能集的稳定摘要；同 attempt 不变 |
| `packages` | `SkillPackage[]` | 是 | 集合，顺序无语义；空数组合法 |

`SkillPackage`：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `packageId` | UUIDv7 | 是 | 不可变内容 ID |
| `name` | string | 是 | 技能名（日志/审计） |
| `version` | string | 是 | 包版本 |
| `digest` | `sha256:<hex>` | 是 | 包内容摘要 |
| `sizeBytes` | integer ≥0 | 是 | 解压前 zip 大小，用于预检 |
| `downloadUrl` | string | 是 | 相对路径或绝对 URL |
| `etag` | string | 否 | 缓存校验 |

### 6.4 `Lease` / `ControlBatch` / `Ack`

```ts
type Lease = {
  expiresAt: string; // ISO-8601 UTC
  ttlMs: number;     // 正整数
};

type ControlEvent =
  | { type: "cancel"; instanceId: string; reason: "user_cancel"; issuedAt: string }
  | { type: "pause"; instanceId: string; issuedAt: string }
  | { type: "resume"; instanceId: string; issuedAt: string }
  | { type: "shutdown"; instanceId?: string; cleanup?: "keep" | "clean-skills" | "clean-client"; issuedAt: string };

type ControlBatch = {
  seq: number;          // 本批最大序号；空批 = ackSeq
  events: ControlEvent[]; // 按 seq 升序、连续
};

type Ack = {
  attemptId: string;
  disposition: "accepted" | "duplicate";
  attemptState: string; // reported / closed 等，服务端状态
  recordedAt: string;
};
```

### 6.5 错误分类与取消原因

`ErrorClass` 闭集（沿用 `CMP-result`）：`workspace` / `asset` / `runtime` / `timeout` / `cancelled` / `protocol` / `scheduler` / `internal`。

`NodeResult.error`：

```ts
type NodeError = {
  class: ErrorClass;
  code: string;      // 组件稳定错误码，保留原值
  message: string;   // 可读描述，不含凭据/全文
  retryable: boolean; // 提示，调度器裁决
  reason?: CancelReason;
};

type CancelReason =
  | "user_cancel" | "paused" | "shutdown"
  | "lease_expired" | "superseded" | "signal" | "prompt_timeout";
```

| `status` | `error.class` | `reason` 取值 | `retryable` 建议 |
|---|---|---|---|
| `succeeded` | `null` | — | — |
| `failed` | `workspace` / `asset` / `runtime` / `protocol` / `scheduler` / `internal` | — | 按 `CMP-result` 映射 |
| `cancelled` | `cancelled` | `user_cancel` / `paused` / `shutdown` / `lease_expired` / `superseded` / `signal` | `paused`、`lease_expired` 为 true，其余 false |
| `timeout` | `timeout` | `prompt_timeout` | true |

> `retryable` 只是提示；`paused` / `lease_expired` 是否重跑由调度器裁决。client 不自动重跑。
>
> 网关新增码的归类：`invalid_session` / `run_superseded` 归 `scheduler`、`retryable=false`；`late_result` / `stale_attempt` / `lease_expired` 沿用现有映射。`invalid_session` 与 `run_superseded` 需要补进 `CMP-result` 的映射表（§13）。

### 6.6 端口返回类型（对 `CMP-executor` §3.4 的补充）

HTTP 契约要求 `register` / `heartbeat` / `bindSession` 的响应携带租约、限制、assignments 与心跳配置；现有端口返回 `void` / `ControlBatch` / `SkillSet` 承载不了这些信息。提案把这三个方法的返回类型改为：

```ts
type Registration = {
  serverTime: string;
  clientLease: Lease;
  limits: Limits;
  heartbeat: { pollTimeoutMs: number; clientTimeoutMs: number; nextPollAfterMs: number };
  assignmentsVersion: number;
  assignments?: Assignment[];
};

type HeartbeatResult = {
  serverTime: string;
  clientLease: Lease;
  control: ControlBatch;
  assignmentsVersion: number;
  assignments?: Assignment[];
  nextPollAfterMs: number;
};

type SessionBinding = {
  serverTime: string;
  skillSet: SkillSet;
  lease: Lease;
};

type Assignment = { instanceId: string; workspacePath: string; state: "active" | "waiting" };

type Limits = {
  maxResultBytes: number;
  maxPromptBytes: number;
  maxRequestBytes: number;
  maxSkillPackageBytes: number;
  maxSkillPackages: number;
};
```

`claim` / `renew` / `reportResult` 的返回类型不变（`NodeRequest` 内含 `lease`；`renew` 返回 `Lease`；`reportResult` 返回 `Ack`）。这是端口契约的签名变更，按 P1 处理；M1 若坚持 `void`，CLI 只能另加读取限制/assignments 的端口方法，不推荐。

## 7. 调度器侧必须保证的语义（`SCH`）

| ID | 责任 | 为什么 client 需要 | 违反后果 |
|---|---|---|---|
| `SCH-01` | **实例粘性**：一个实例同一时刻只绑定一个 client；解绑必须先显式结束旧绑定 | client 按实例独占容器/进程 | 两个 client 写同一容器；产物/技能互相污染 |
| `SCH-02` | **单派发**：一个 attempt 同一时刻只租给一个 client/run；重派等旧租约过期或被 fence | client 单飞去重只覆盖进程内 | 同一节点两份产物 |
| `SCH-03` | **attempt 身份**：`attemptId` 全局唯一、不可复用；重跑必须新 `attemptId` | client 以 attemptId 去重、恢复、幂等上报 | 同 attemptId 被当成重复执行而拒绝执行，或旧结果覆盖新尝试 |
| `SCH-04` | **容器预置**：`workspacePath` 绝对、存在、可写、实例内稳定、位于任何 git 仓库之外；跨实例不共享 | client 不 clone/checkout/创建容器 | 技能不可见（projectRoot 上浮）、路径越界、节点失败 |
| `SCH-05` | **技能集确定性**：同一 attempt 的 `skillSet.digest` 稳定；同容器并发 attempt digest 一致；包可下载、digest 可校验、大小受限 | client 原子替换技能、按 digest 幂等、冲突即失败 | 模型看到错误技能组合；半套技能；交错覆盖 |
| `SCH-06` | **两条租约**：客户端租约 TTL > 心跳长轮询；尝试租约可续、TTL 与节点类型匹配；以服务端时间为准 | client 判断「还能不能领」与「这活还是不是我的」 | 误判离线、误杀长任务、双跑 |
| `SCH-07` | **心跳即续租**：收到 heartbeat 请求即续客户端租约；断连不等价于立即离线，以 TTL 裁决 | client 无法区分网络抖动与真离线 | 过早重派、实例抖动 |
| `SCH-08` | **控制事件顺序**：per-client `seq` 单调、连续、至少一次、断连补发；空批 `seq=ackSeq` | client 按 `ackSeq` 累计确认、按 seq 幂等 | 丢取消、重复取消、乱序暂停 |
| `SCH-09` | **幂等**：claim / bind / report / renew 按 attemptId 幂等；重复请求不产生第二次执行、不改变已接受结果 | client 会重试传输 | 重复执行、结果被覆盖 |
| `SCH-10` | **迟到结果**：已过期/已重派/已关闭的 attempt 上报返回 `409 late_result`，只入审计，不推进状态、不覆盖新 attempt | client 的 `settled` 结果可能在崩溃后才重报 | 旧结果覆盖新尝试，或结果丢失无审计 |
| `SCH-11` | **崩溃恢复**：同一 `clientId` 可重报旧 attempt 的已结算结果；只要该 attempt 未被重派且未被调度器关闭，必须接受（即使 `runId` 变了）；已关闭/已重派走 `late_result` | client 重启后 `runId` 必变 | `settled` 结果永远上报不出去，R-02 失效 |
| `SCH-12` | **结果约束**：接受 `truncated=true`；通过 `limits` 下发上限；超限 `413` 而非静默截断 | client 在本地截断 | 长输出节点永远失败，或结果被服务端悄悄改坏 |
| `SCH-13` | **取消/暂停/释放**：`cancel` 立即生效；`pause` 期间不派发该实例；`shutdown(instanceId)` 表示实例释放，client 可清理并释放容量 | client 没有其他「实例结束」信号 | 进程/容器永久占用；暂停后仍派活 |
| `SCH-14` | **版本**：协议版本协商；不兼容 `426` 带范围；`deprecated` 带 `sunsetAt`；不静默降级 | client 不能带病执行 | 字段错配、行为漂移 |
| `SCH-15` | **认证与隔离**：token 绑定 `clientId`；401/403 区分；一个 client 不能读他人 attempt/package；TLS | client 只持自己的凭据 | 越权读结果/包；凭据泄漏 |
| `SCH-16` | **限流与容量**：按上报容量派发、不超卖；429 带 `Retry-After`；限流不改变租约语义 | client 按容量决定领不领 | 超卖、OOM、任务堆积在单机 |
| `SCH-17` | **时间与审计**：每个成功响应带 `serverTime`；回显 `requestId`；审计 `clientId/runId/instanceId/nodeId/attemptId/sessionId` | client 处理时钟偏差与排障 | 租约误判、无法对账 |
| `SCH-18` | **推送通道唯一**：只用心跳长轮询；不主动连 client；不要求 client 开端口 | client 是纯出站进程 | 部署不可行、NAT/防火墙问题 |

## 8. 客户端承诺（`CLT`）

| ID | 承诺 | 对应实现点 |
|---|---|---|
| `CLT-01` | 只领取绑定本 client 的实例；不抢他人 attempt | `C-03` + `SCH-01` |
| `CLT-02` | `attemptId` 单飞；重复投递返回同一结果，不重复执行 | `AttemptRegistry` |
| `CLT-03` | 一个 attempt 一个 session；先建 session 再 bind；关闭后不复用 | `AttemptRunner` + `CMP-runtime` |
| `CLT-04` | 技能替换原子、digest 幂等；同容器不同 digest 显式失败 | `CMP-assets` + `SkillDigestGuard` |
| `CLT-05` | 结果先落 journal 再上报；`settled` 后只重试传输，不重跑 | `JournalPort` + `C-07` |
| `CLT-06` | 取消/超时立即终止；不等 prompt 自然结算；回收进程组 | `CancellationScope` + `CMP-runtime` |
| `CLT-07` | 心跳独立于执行；prompt 长等不阻塞心跳 | `CMP-cli` 心跳任务 |
| `CLT-08` | 只传控制信息；不传产物、会话全文、日志、凭据；结果截断 | `CMP-result` |
| `CLT-09` | 鉴权/版本失败停止领取并退出 3；持续不可达退出 6 | `CMP-cli` 退出码 |
| `CLT-10` | 崩溃后清孤儿、不自动重跑、等调度器重派 | `recover` + `CMP-runtime` |
| `CLT-11` | 只连 `scheduler.url` 与 manifest 授权的下载地址；跨 host 不带 token | `CMP-gateway` + `CMP-assets` |
| `CLT-12` | 租约按 `serverTime` + 单调时钟判断，不依赖本地墙钟 | `LeaseTracker` |

## 9. 执行器承接：从 HTTP 到组件、状态机与 journal

### 9.1 操作 → 端口 → 组件 → 状态

| 操作 | 端口方法 | 调用组件 | 调用点 | 尝试状态迁移 | journal | 失败处理 |
|---|---|---|---|---|---|---|
| `C-01` | `register` | `CMP-cli` | 启动/重连 | 无 attempt | 无 | 401/403/426 退出 3；409 按 Q12；其余退避，持续退出 6 |
| `C-02` | `heartbeat` | `CMP-cli` 心跳任务 | 常驻 30s | 无迁移 | 无 | 退避重连；控制事件分派给 executor |
| `C-03` | `claim` | `CMP-cli` 领取循环 | 有空容量 | `→ claimed` | `claimed` | `204` 等待；429/5xx 退避 |
| `C-04` | `bindSession` | `CMP-executor` | `newSession` 后 | `claimed → bound` | `bound`（含 sessionId） | 关 session；`settled(failed)`，不 prompt |
| `C-05` | 无（`CMP-assets` 直连） | `CMP-executor` 编排 | `bindSession` 后 | `bound → ready`（安装成功） | `ready` | 原子回滚；`settled(failed)`，不 prompt |
| `C-06` | `renew` | `CMP-cli` 租约任务 | TTL/3 | 无迁移 | 无 | 过期 → `cancelInstance`；`settled(cancelled)` |
| `C-07` | `reportResult` | `CMP-executor` | `settled` 后 | `settled → reported → closed` | `settled` / `reported` / `closed` | 保留 `settled` 重试；`late_result` 只 ack |

### 9.2 状态与 HTTP 的对应

```
claim ──▶ claimed ──newSession──▶ bindSession(C-04) ──▶ bound
  │                                                      │
  │                                   install(C-05) + validate
  ▼                                                      ▼
（无 session 失败）                                    ready
  │                                                      │
  └──────────────▶ settled(failed/...) ◀── prompt ── running
                                                         │
                                              assemble + settled
                                                         ▼
                                              reportResult(C-07)
                                                         │
                                              reported ──▶ closed
```

- `C-03` 成功即 journal `claimed`；重复投递不新建状态机（`CLT-02`）。
- `C-04` 失败：关 session，`settled(failed)`，`error.class = scheduler`；不 prompt。
- `C-06` 过期：`AbortSignal` → `runtime.cancel` → 关 session/杀进程组 → `settled(cancelled, reason=lease_expired)` → `C-07`（可能 late）→ `closed`。
- `C-07` 是唯一让状态从 `settled` 前进到 `reported` 的路径；`run` 模式用本地输出代替，不注册调度器。
- 控制事件 `cancel`/`pause`/`shutdown` 走 `cancelInstance`，不经过 `C-07` 的请求触发点；但仍产生 `settled(cancelled)` 并上报。

### 9.3 启动恢复与重报

1. 清孤儿：`store.listOrphans` → `runtime.reapOrphan` → `store.clearOrphan`（client 不杀别人的进程）。
2. `register`（新 `runId`）；调度器 fence 旧 run（`run_superseded`），但保留旧 attempt 的归属。
3. `recover`：读 journal 非终态 attempt；`settled`/`reported` 且有结果的 → 用 **新 runId** 重报 `C-07`；`claimed`…`running` 无结果的 → 标记 `abandoned`，不上报。
4. 重报成功的旧 attempt → `reported` → `closed`；失败的保留 `settled`，下次再试。
5. 不自动重跑；等调度器用**新 attemptId**重派（`SCH-03`）。
6. `assignments` 存在时，用其 `workspacePath` 校验容器；不存在时以 journal 为准，不阻塞领取。注意：无 `assignments` 时，`JournalPort` 需提供 `listInstances()` / `pendingAll()` 才能枚举待恢复 attempt；这是客户端内部端口变更（P2），不改变调度器接口。

### 9.4 容量与领取节奏

- `serve` 启动后先 `register`，再启动心跳；心跳与领取是两个独立任务。
- 有 `availableInstances > 0` 且未被 `pause` 时，调用 `claim`；`204` 后等心跳返回或短抖动（建议 1–2s）再试。
- `claim` 成功先占容量（`activeInstances + 1`），attempt 结束/失败/取消后释放；释放发生在 `closed` 或 `abandoned`。
- `shutdown(instanceId)` 释放该实例容量；`shutdown()` 停止领取并释放全部。
- 容量单位与同实例并发见 §11；S1 推荐「实例数 + 同实例串行」，此时 `availableInstances` 足够表达。

## 10. 失败与边界矩阵

| 场景 | 调度器行为 | client 行为 | 终态/退出 |
|---|---|---|---|
| 启动时调度器不可达 | 无响应/5xx | 退避 1s→30s + 抖动；持续失败按阈值退出 | 6 |
| `401`/`403` | 返回错误 | 停止领取，不重试 | 3 |
| `426 version_incompatible` | 带兼容范围 | 停止领取，记录版本 | 3 |
| `429 rate_limited` | 带 `Retry-After` | 按建议退避，不改变业务状态 | 继续运行 |
| 心跳超时（35s） | 连接被断开 | 视为断连，重连带 `ackSeq`；不取消 attempt | 继续运行 |
| 客户端租约过期 | 标记离线、停止派发 | 继续尝试心跳/续租；不立即自杀 | 重连恢复或按阈值退出 |
| 尝试租约过期 | 可重派新 attempt | abort、关 session、杀进程组、`settled(cancelled, lease_expired)`、上报（可能 late） | `closed` |
| 同一 attempt 重复投递 | 同一 client 可重复返回 | 单飞，返回同一 Promise/结果 | 不重复执行 |
| 同一结果重复上报 | 返回 `duplicate` + 首次 ack | 记 `reported` → `closed` | `closed` |
| 迟到结果 | `409 late_result` | 只审计，记 `reported` → `closed` | `closed` |
| 崩溃在 `settled` 后、上报前 | — | 重启后 `recover` 重报；未被重派则接受 | `closed` |
| 崩溃在 `running` | 等租约过期后重派新 attempt | 重启清孤儿；旧 attempt 标 `abandoned`，不重报 | `abandoned` |
| 同容器不同技能集 | 调度器违约（`SCH-05`） | `asset_skill_set_conflict`，不 prompt | `failed(asset)` |
| 技能包 digest 不匹配 | — | 重试一次；仍失败 `checksum_mismatch`，不 prompt | `failed(asset)` |
| prompt 中出现 cancel | 发 `cancel` | abort、关 session、杀进程组、上报 `cancelled(user_cancel)` | `closed` |
| 暂停 | 发 `pause(instanceId)` | 停止该实例领取、取消活跃（`cancelled(paused)`） | `closed`；恢复后新 attempt |
| 实例释放 | 发 `shutdown(instanceId, cleanup)` | 取消活跃、关进程、按策略清理、释放容量 | `closed` |
| 整个 client 关闭 | 发 `shutdown()` | 停止领取、取消活跃、flush、退出 | 0（信号 130/143） |
| 未知控制事件 | 未来新增类型 | ack + 记录，不崩溃 | 继续运行 |
| 结果超过上限 | `413` | 应先截断；仍 413 记告警 | `closed` + 审计 |
| 时钟偏差 | 响应带 `serverTime` | 用单调时钟计算剩余；±5s 容忍 | 继续运行 |
| 双跑同一 `clientId` | 新 `runId` 生效，旧 run `409 run_superseded` | 旧 run 停止领取、取消活跃、退出（码待 Q12） | 待定 |
| 调度器 5xx/503 | 带 `Retry-After` | 退避重试；不重复执行 | 继续运行 |

## 11. 容量与同实例并发（待裁决）

现状文档存在一处需要拍板的张力：

- `architecture.md` §2 说「一实例一个容器；顺序节点共享；fan-out 分支共享同一容器与同一技能集」；
- 同文 §6 不变量 1 说「一个 client 实例同一时刻只执行一个尝试」；
- `SCN-0001` UC-24/UC-25 又要求「同容器同技能集并发」「不同技能集并发显式失败」；
- `CMP-cli` 按「实例数」报容量（OQ-011），上游 boundary 又说「client 上报容量时按分支计」。

三个候选：

| 方案 | 语义 | 容量单位 | 对契约的影响 |
|---|---|---|---|
| **A（S1 推荐）** | 同一实例同一时刻一个活跃 attempt；fan-out 在 client 侧串行 | `availableInstances` | 契约最小；`cancelInstance` 够用；不变量 1 成立 |
| B | 同一容器允许多个并发 session（同 digest） | `availableAttempts` / `availableSessions` | 需把 `cancelInstance` 细化为按 attempt 取消；`renew`/租约按 attempt 已支持；技能冲突判定成关键 |
| C | fan-out 分支各自容器/进程 | `availableWorkspaces` | 与当前「共享容器」相冲突；`workspacePath` 变成每分支一个 |

**推荐**：S1 采用 A，先把单节点/顺序节点跑通；B 留到 S2 fan-out 时再开，届时补 `cancelAttempt(attemptId)` 端口或把租约过期映射到实例取消的代价写清楚。若调度器在 S1 就会并发派发同一实例的多个节点，必须现在选 B/C，否则 client 只能串行，调度器会看到「有容量但领不走」的假死。

## 12. 版本、兼容与废弃

| 契约面 | 兼容规则 | 破坏性变更 |
|---|---|---|
| `C-01`…`C-07` | 新增可选字段/端点兼容；未知字段忽略 | 删字段、改语义、新增必填字段、改枚举语义 |
| `protocolVersion` | 日期 + 末位；加法递增末位 | 升主日期 + 双侧协商 |
| `ErrorClass` / `CancelReason` | 新增值需双方发布；旧 client 未知 `class` 归 `internal`，未知 `reason` 保留原字符串 | 改已有值语义 |
| `SkillSet` / `NodeResult` | 加可选字段兼容 | 改必填/单位/截断语义 |
| 控制事件 | 新增 type 时旧 client ack + 记录；不得依赖旧 client 理解新 type | 改已有 type 语义 |

- 不兼容时服务端 `426`，client 退出 3，不带病执行。
- 旧版本保留窗口：至少一个 minor（建议 2 个）；`deprecated` 响应带 `sunsetAt`。
- 端点废弃：先双写/双端点，再在窗口后移除；client 按 `protocolVersion` 选择。

## 13. 与现行文档的差异

> 以下均为**提案建议**，未改 `design/`；确认后由 M1 工序落盘。

| 文档/位置 | 现行 | 提案 | 类型 |
|---|---|---|---|
| `architecture.md` §3.1 | 5 个交互面（注册心跳/领取租约/绑定/上报/控制） | 增加 `C-05` 技能包下载；明确 `C-02` 是唯一推送通道；补 `runId`、`serverTime`、`limits` | 提案变更 |
| `architecture.md` §2 | 容量单位/同实例并发未定 | §11 三候选，S1 推荐 A | 待裁决 |
| `architecture.md` §3.1 | 「字段级契约由 M1 冻结」 | 本稿即 M1 输入；字段名仍可改 | 不改原则 |
| `CMP-executor` §3.4 `SchedulerPort` | `register`/`heartbeat`/`bindSession` 返回 `void`/`ControlBatch`/`SkillSet` | 返回类型扩展为 `Registration`/`HeartbeatResult`/`SessionBinding`（§6.6）；补 `renew` 的「尝试租约」语义、`register`/`heartbeat` 的载荷语义、`NodeRequest` 去 `skillSet` | 提案变更（P1） |
| `CMP-executor` §3.5 `NodeRequest` | 含 `skillSet`（S0 内联/S1 引用），无 `lease`/`timeoutMs` | S1 技能集由 `C-04` 返回（`run` 本地文件仍可内联）；增加 `attemptNo` / `timeoutMs` / `lease` | 提案变更 |
| `CMP-executor` §3.5 `JournalPort` | `pending(instanceId)` 需先知道实例 | 无 `assignments` 时需 `listInstances()` / `pendingAll()` 才能枚举恢复对象 | 提案变更（P2，客户端内部） |
| `CMP-gateway` §3.3 | 错误表 9 项 | 新增 `invalid_session`、`run_superseded`；`forbidden`/404/413 映射说明；`late_result` 保持 409 | 提案变更 |
| `CMP-gateway` §2.3 | `claim`/`reportResult` 幂等 | 补 `bindSession`/`renew` 幂等；补「attempt 归属按 clientId」 | 语义补充 |
| `CMP-gateway` §2.2 | 「重连即重新 `register`（如需）」 | 明确传输重连不重新 `register`；仅新 `runId` 或调度器显式要求时注册 | 语义补充 |
| `CMP-cli` §2.4 | register/heartbeat/claim/renew 循环 | 补 `assignments`、`ackSeq` 空洞处理、claim 204/长轮询、`run_superseded` 收口 | 提案变更 |
| `CMP-cli` §2.8 | 退出码表 | `run_superseded` 退出码待定（Q12）；其余不变 | 待裁决 |
| `CMP-assets` §3 | 下载/校验/原子替换 | 补 `C-05` 的 304/413/跨 host 不带 token；`packageId` 不可变 | 语义补充 |
| `CMP-result` §2.2 | 错误映射表 | 新增 `invalid_session` → `scheduler`/false、`run_superseded` → `scheduler`/false；`cancel reason` 映射 | 提案变更 |
| `CMP-result` §2.1 | 取消/超时 `retryable=false` | `paused`/`lease_expired` 建议 `true` | 待裁决 |
| `OQ-006/010/011/012/013` | 未决 | 本稿给默认值，见 §15；M1 关闭 | 待裁决 |

## 14. 联调与验收建议

### 14.1 桩调度器最小面

按 `C-01`…`C-07` 实现内存桩，覆盖：

- 注册/心跳/领取/绑定/下载/续租/上报的正常序；
- 长轮询：有事件立即返回、无事件 30s 空批、断连补发、`ackSeq` 空洞；
- 幂等：重复 claim、重复 bind、重复 report、迟到 report；
- 租约：续租、过期、过期后上报；
- 错误：400/401/403/404/409/413/426/429/500/503 的映射与退避；
- 控制：cancel/pause/resume/shutdown（含实例级与整机）、未知 type、重复事件；
- 技能：304、digest 不匹配、413、跨 host URL；
- fencing：同 clientId 新 runId 顶掉旧 run；
- 恢复：`settled` 未上报 → 重启 → 重报 accepted/late。

### 14.2 契约测试归属

| 测试面 | 归属 | 证明 |
|---|---|---|
| 端点形状/字段/错误映射 | `tests/components/gateway/` | 桩调度器请求断言 |
| 心跳/领取/租约/控制分派 | `tests/components/cli/` | 循环不重复执行、心跳不被 prompt 阻塞 |
| 绑定/安装/上报/恢复 | `tests/components/executor/` | 调用序、状态机、journal、幂等重报 |
| 下载/校验/原子替换 | `tests/components/assets/` | digest/304/失败回滚 |
| 结果组装/截断/错误分类 | `tests/components/result/` | 四类结果、映射表、UTF-8 截断 |

### 14.3 S1 门禁

- 断网/重复投递下不重复执行（R-01）；
- `settled` 结果在崩溃重启后可重报（R-02）；
- 取消/关闭无残留进程（R-03）；
- 租约过期/迟到结果有确定行为（UC-21）；
- 版本/鉴权失败退出 3（UC-23）；
- 结果超限截断且可解析（UC-12）；
- 控制事件不丢、不重复应用（UC-20）。

## 15. 待裁决问题（给调度器侧）

| ID | 问题 | 选项 | 推荐 | 阻塞 |
|---|---|---|---|---|
| Q1 | 容量单位与同实例并发 | A 实例数+串行 / B 同容器并发 / C 分支独立 | S1 选 A；B 留 S2 | S1 |
| Q2 | 重跑是否复用 `attemptId` | 复用 / 新值 | **新值**；同 attemptId 只做传输重放 | S1 |
| Q3 | 迟到结果表达 | `409 late_result` / `200 disposition=late` | `409`（与现有错误表一致）；client 按终态处理 | S1 |
| Q4 | 启动恢复是否要 `assignments` | 要 / 不要 | 可选下发；client 无则走 journal | S1 可延后 |
| Q5 | `claim` 是否长轮询 | 长轮询 / 立即返回+退避 | 长轮询 20s；`204` 带 `Retry-After` | S1 |
| Q6 | 技能包通道 | 调度器托管端点 / 签名外链 | 托管端点；外链必须短期签名且不带 token | S1 |
| Q7 | 认证方式 | Bearer + TLS / mTLS / 请求签名 | Bearer + TLS；轮换下一版 | S1 |
| Q8 | 两条租约 TTL | 固定 / 服务端下发 | 服务端下发；默认 90s / 120s | S1 可先用默认 |
| Q9 | 结果大小上限 | 64/256/1024 KiB | 256 KiB；`limits` 下发 | S1 可先用默认 |
| Q10 | `pause` 语义 | 节点边界等待 / 立即取消+重跑 | 立即取消，`reason=paused`，恢复后新 attempt | S1 可先用推荐 |
| Q11 | 协议版本方案 | 日期+末位 / 语义化版本 | 日期+末位；兼容窗口 2 minor | S1 可先用默认 |
| Q12 | `run_superseded` 退出码 | 2 / 新增码 / 6 | 暂用 2（重复进程=配置/用法），或新增专用码 | S1 可先用 2 |

> 阻塞 S1 的 6 项：Q1、Q2、Q3、Q5、Q6、Q7。其余可在 S1 实现中先用推荐默认值，M1 冻结时确认。

## 16. 附录：端到端时序

```
client（CLI/gateway）                             调度器
  │ POST /register ───────────────────────────────▶│
  │◀─ clientLease, limits, assignments ────────────│
  │ POST /heartbeat（长轮询 30s）──────────────────▶│
  │◀─ control{seq,events}, clientLease ────────────│
  │ POST /claim（长轮询 20s）──────────────────────▶│
  │◀─ NodeRequest | 204 ───────────────────────────│
  │   ├─ workspace.validate / runtime.ensureInstance
  │   ├─ session/new
  │ POST /attempts/{a}/session ────────────────────▶│
  │◀─ SkillSet(digest, packages) ───────────────────│
  │ GET /skill-packages/{p}/download ──────────────▶│
  │◀─ zip + digest ────────────────────────────────│
  │   ├─ install（原子替换）/ prompt
  │ POST /attempts/{a}/lease（每 ttl/3）───────────▶│
  │◀─ expiresAt ───────────────────────────────────│
  │ POST /attempts/{a}/result ─────────────────────▶│
  │◀─ accepted | duplicate | 409 late_result ──────│
  │   └─ close session → closed
  │◀─ shutdown(instanceId, cleanup) ────────────────│
  │   └─ 关进程 / 清理容器 / 释放容量
```

## 17. 附：本稿未覆盖

- 调度器内部如何选节点、解析结果、决定重跑/评审/分支；
- 凭据发放、轮换、吊销流程；
- 进度事件（可选，冷路径；需要时另立契约面）；
- 产物上传、会话全文、日志回传；
- 多机调度、跨 client 迁移、共享工作区；
- `run` 本地模式（`LocalSchedulerAdapter`）的字段差异；本稿只约束 `serve` 的跨进程契约。
