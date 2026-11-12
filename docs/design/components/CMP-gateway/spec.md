---
layer: design
module: execution-plane
component: CMP-gateway
status: active
updated: 2026-11-12
---

# CMP-gateway 组件规格（v3）

> 状态：`active`（executor contract v3，2026-11-12）。字段权威：[`contracts/executor-http-v3.md`](../../contracts/executor-http-v3.md)；本规格只写防腐层实现语义。
>
> 上游：`architecture.md` §3.1/§9/§10；`SCN-0001`；v1/v2 归档于 `docs/history/works/`。

## 1. 职责与边界

- **单元 / 层**：组件；L0 基础设施；HTTP 防腐层。
- **负责**：五端点 `poll`/`reportResult`/`downloadPackage`/`uploadSessionLog`/`uploadArchive`；Bearer 鉴权；`X-Executor-Protocol: 3`；超时/重试；HTTP 错误信封归一。
- **不负责**：任务状态机（executor）、结果语义（result）、进程/文件（runtime/workspace/assets）、调度器内部任务列表。
- **变化轴**：调度器协议。

## 2. 实现 `SchedulerPort`

| 方法 | 传输语义 | 返回 | 错误 |
|---|---|---|---|
| `poll(request)` | `POST /poll`；客户端超时 40s；带 `capacity.free`、`running[]`、`finished[]`、`archivedRuns` | `PollResponse`（含 `archiveRequests`） | `unreachable`、`timeout`、`unauthorized`、`unsupported_protocol` |
| `reportResult(result)` | `POST /tasks/{taskId}/result`；5xx/网络退避重试；404 → `accepted=false`；`409 session_log_missing` → 交给调用方补传日志 | `ResultAck` | 同上 + `payload_too_large`、`session_log_missing` |
| `uploadSessionLog(taskId, attempt, bytes)` | `POST /tasks/{taskId}/session-log?attempt=n`；`application/x-ndjson` + gzip；同键后到覆盖，`200` 返回 `stored` | `SessionLogAck` | `task_not_found`、`payload_too_large`、`unreachable`、`timeout` |
| `uploadArchive(runId, bytes)` | `POST /runs/{runId}/archive`；`application/gzip`；终态前置；后到覆盖 | `ArchiveAck` | `run_not_found`、`invalid_state`、`payload_too_large`、`unreachable`、`timeout` |
| `downloadPackage(pkg)` | `GET /skill-packages/{packageId}`；支持 `If-None-Match`；304 → `notModified` | `PackageDownload` | `package_not_found`、`unreachable` |

- 公共头：`Authorization: Bearer <token>`、`X-Executor-Protocol: 3`、`X-Request-Id`。
- 没有 `clientId`/`runId`/`register`/`heartbeat`/`claim`/`renew`/`bindSession`。
- HTTP 状态与 JSON 信封不进入端口；错误码闭集：`unsupported_protocol`、`unauthorized`、`task_not_found`、`run_not_found`、`package_not_found`、`session_log_missing`、`invalid_state`、`invalid_archive`、`payload_too_large`、`unreachable`、`timeout`、`protocol_error`。
- 二进制上传必须带 `Content-Length`；`bytes`/`sha256` 一律指压缩后内容。

## 3. 不变量

1. `poll` 是唯一常驻请求；`running[]`/`finished[]`/`archivedRuns` 原样上报，不做业务判断。
2. `reportResult` 不做客户端去重；首份为准由调度器决定；`accepted=false` 由 CLI 丢弃。
3. 4xx 不重试（`task_not_found` 转 ack false）；仅 5xx/网络类退避。
4. `downloadPackage` 只在同源 URL 带 token；跨 host 不带。
5. `uploadSessionLog`/`uploadArchive` 不做本地重试编排；重试与「先日志后结果」由 executor/CLI 决定。
6. `P-04` 的 `404` 由调用方丢弃上传与结果，`413` 由调用方转「空日志 + 失败结果」流程。
5. 凭据不进日志/结果/错误 message。

## 4. 依赖与分层

- 依赖：`SchedulerPort` 类型、`CMP-observability`、标准库 `fetch`。
- 禁止边：不 import CLI/executor 具体实现/runtime/workspace/assets；不读 journal。

## 5. 数据所有权

| 数据 | 写入口 | 保留 |
|---|---|---|
| 无状态（v2 删除幂等缓存、租约、ackSeq） | — | — |
| 请求审计（requestId） | 日志 | 本地 |

## 6. 验证

| 类型 | 用例 | 文件 |
|---|---|---|
| 传输 | 头、错误码、超时、重试 | `tests/components/gateway/transport.test.ts` |
| poll | 请求形状、stop/cancelInstances | `tests/components/gateway/gateway.test.ts` |
| result | 首份/重复/404 | 同上 |
| package | 200/304/404 | 同上 |
| 端到端 | poll 循环、并发、取消、finished | `tests/scenarios/v2-serve.test.ts` |

## 7. 单独运行

`bun test tests/components/gateway/`；用 `tests/support/stub-scheduler.ts`，不连真实服务。

## 8. 开放问题

- 真实调度器联调未做（调度器侧契约已定，实现待建）。
