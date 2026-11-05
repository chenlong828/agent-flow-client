---
layer: design
module: execution-plane
component: CMP-gateway
status: planned
updated: 2026-11-04
---

# CMP-gateway 组件规格

> 状态：`planned`。调度器 HTTP 契约的 client 侧防腐层；端点是占位名，字段级契约由 M1 冻结，权威在调度器。
>
> 上游：`docs/design/architecture.md` §3.1、§9、§10；`SCN-0001` UC-19–23；`REQ-0002` R-01/R-02/R-08；ACP/租约预研见 `docs/history/works/2026-11-03-dsh-acp-preflight/result.md`。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L0 基础设施；技术边界（HTTP/鉴权/版本/重试）。
- **业务价值**：把调度器协议、鉴权、版本与传输重试封在边界内，领域层只看到 `SchedulerPort`。
- **负责 X**：
  - `SchedulerPort` 实现；
  - HTTP 长轮询（心跳兼作控制事件通道）、重连与退避；
  - 鉴权头、版本协商；
  - 传输层重试、幂等键；
  - 租约计时与过期判定；
  - 控制事件 `seq`/`ackSeq` 校验与去重。
- **不负责 Y**：
  - 业务判定（何时重试节点由调度器裁决）；
  - 结果内容（`CMP-result`）；
  - 进程/文件（runtime/workspace）；
  - 节点执行顺序（executor）。
- **变化轴**：调度器协议（端点、字段、鉴权、版本）。
- **删除测试**：删掉后 HTTP 细节会渗进 executor/CLI——真边界（防腐层）。

## 2. 内部功能

### 2.1 传输

| 内部单元 | 职责 |
|---|---|
| `HttpTransport` | `fetch` 封装：超时、JSON、错误归一、取消 |
| `LongPollLoop` | `heartbeat` 长轮询；30s 挂起；断线重连；`ackSeq` |
| `RetryPolicy` | 退避 + 抖动；可重试/不可重试分类；上限 |
| `AuthProvider` | 凭据注入；只加请求头，不写日志 |
| `VersionNegotiator` | client/DSH 版本上报；兼容窗口校验 |
| `IdempotencyCache` | `attemptId` 短期去重；重复上报返回既有 ack |
| `LeaseTracker` | `expiresAt` 计时；续租；过期标记 |
| `ControlSeq` | `seq` 单调校验、去重、累计 `ackSeq` |

### 2.2 长轮询心跳

- 形态：`heartbeat(state, ackSeq)` 一条常驻请求；服务端有事件立即返回，无事件挂起至 30s 返回空批。
- 请求到达即续租；连接断开/超时是离线信号；最终以租约过期裁决。
- 客户端超时 = 服务端挂起 + 余量（建议 35s）；超时后按退避重连，不视为业务失败。
- 重连即重新 `register`（如需）并补发 `ackSeq`；事件按 `seq` 至少一次、幂等应用。
- 心跳循环独立于执行；prompt 长等不得阻塞它。

### 2.3 幂等与租约

- `claim` / `reportResult` 以 `attemptId` 为幂等键。
- 重复 `reportResult` 返回同一 `Ack`；迟到结果返回 `late_result`，只入审计，不推进流程。
- `renew` 延长租约；租约过期由 `CMP-executor` 丢弃尝试，gateway 不自行重跑。
- 幂等缓存有界（默认 256 条，可配）；淘汰后以服务端幂等为准。

### 2.4 控制事件

- 事件闭集：`cancel` / `pause` / `resume` / `shutdown`。
- 响应内联 `ControlBatch`；gateway 只做结构校验、`seq` 去重与排序，业务分派交给 CLI/executor。
- 已结算事件回 `stale` 并 ack；未知类型 ack + 记录，不崩溃。
- 下一跳心跳带累计 `ackSeq`；断连补发。

### 2.5 版本与鉴权

- `register` 上报 client 版本、ACP 协议版本、DSH 基线版本。
- 版本不兼容：停止领取，`version_incompatible`，由 CLI 退出 3。
- 鉴权失败：停止领取，`unauthorized`，退出 3；不无限重试。
- 凭据只从注入的 `AuthProvider` 取；不写日志、不进结果、不进 prompt。

## 3. 契约

### 3.1 实现 `SchedulerPort`

签名见 `CMP-executor` §3.4；本组件补充：

| 方法 | 传输语义 | 错误 |
|---|---|---|
| `register` | 幂等注册；鉴权；版本上报 | `unreachable`、`unauthorized`、`version_incompatible` |
| `heartbeat` | 长轮询；返回 `ControlBatch`；续租 | `unreachable`、`timeout`、`rate_limited` |
| `claim` | 取绑定本 client 的请求；无则 `null` | `lease_expired`、`rate_limited`、`invalid_request` |
| `renew` | 延长租约 | `lease_expired`、`unreachable` |
| `bindSession` | 上报 sessionId；返回技能集 | `stale_attempt`、`invalid_session`、`unreachable` |
| `reportResult` | 幂等上报；返回 ack | `unreachable`、`late_result`、`invalid_request` |

### 3.2 前置/后置/不变量

- 前置：`scheduler.url` 与凭据已注入；`attemptId` 非空。
- 后置：成功返回时响应已解析；失败返回稳定错误码，不泄漏 HTTP/SDK 类型。
- 不变量：
  1. `claim` 只返回绑定本 client 的请求；不抢其他实例。
  2. `reportResult` 同 attempt 幂等；重复/迟到不覆盖。
  3. 心跳请求到达即续租；断开/超时是离线信号，最终以租约过期裁决。
  4. 控制事件至少一次 + 按 `seq` 幂等；未知类型 ack。
  5. 鉴权/版本失败停止领取，不无限重试。
  6. 凭据不进日志/结果/prompt。

### 3.3 错误模式

| 错误 | 触发 | 可重试 | 调用方应对 |
|---|---|---|---|
| `unreachable` | 连接失败/DNS/TLS/5xx | 是（退避） | 继续重试；持续失败退出 6 |
| `timeout` | 请求超时（含长轮询余量） | 是 | 重连；不误判业务失败 |
| `unauthorized` | 401/403 | 否 | 停止领取，退出 3 |
| `version_incompatible` | 版本协商失败 | 否 | 停止领取，退出 3 |
| `lease_expired` | 租约过期 | 否 | 丢弃尝试，不重跑 |
| `rate_limited` | 429 | 是（退避） | 降低领取频率 |
| `invalid_request` | 400/422 | 否 | 记录并放弃，不重试 |
| `stale_attempt` | 旧 attempt 绑定 | 否 | 丢弃该绑定 |
| `late_result` | 租约过期后的上报 | 否 | 只入审计，不覆盖 |

- 传输重试只改变传输结果，不改变业务语义。
- HTTP 状态码、SDK 类型不得出现在端口错误之外；上层只看到上表。

### 3.4 `GatewayAdmin`（L0 管理面）

```ts
interface GatewayAdmin {
  diagnose(): Promise<CheckResult[]>;
  connectivity(): Promise<CheckResult>; // S1；S0 返回 none
}
```

- 由 `CMP-cli` 在 `doctor` 时调用；S0 不检查网络，返回 `none` 并注明原因。

## 4. 依赖与分层

- 依赖：`SchedulerPort` 类型、`CMP-observability`、标准库 `fetch` / `AbortSignal`。
- 禁止边：不得 import `CMP-cli`、`CMP-executor` 具体实现、`CMP-runtime`、`CMP-workspace`、`CMP-assets`；不得读 journal/工作区；不得把第三方 HTTP 类型泄漏到端口。
- 组合根注入：基础 URL、凭据、版本、超时/重试策略、日志器。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性/保留 |
|---|---|---|---|
| 幂等缓存（attemptId → ack） | `CMP-gateway` | 自身 | 内存；有界；重启丢失 |
| 控制事件 `seq` / `ackSeq` | `CMP-gateway` | 自身、CLI | 内存；重连补发 |
| 租约计时 | `CMP-gateway` | executor/CLI | 内存；过期即丢弃 |
| 凭据 | `AuthProvider`（注入） | gateway | 不进日志/结果 |

## 6. 冷热与资源

- **热路径**：注册/心跳/领取/续约；同步依赖 1（HTTP），独立定时器，不与执行共享队列/锁。
- 失败语义：退避重试、限流、最终 `unreachable`；不阻塞本地执行收尾。
- 长轮询连接与普通请求分开管理；断线重连不重建执行状态。
- 幂等缓存有界，防止内存无界。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| 契约 | 桩调度器：register/heartbeat/claim/renew/bind/report | 请求形状、响应解析、错误映射 |
| 长轮询 | 有事件立即返回；无事件 30s 空批；断开重连；ackSeq 补发 | 不丢事件、不重复应用 |
| 幂等 | 重复 claim/report；迟到 report | 同 ack；迟到只审计 |
| 错误 | 401/403/409/422/429/5xx/超时/版本不兼容 | 重试/停止/退出码正确 |
| 租约 | 续租、过期、过期后上报 | 丢弃尝试；不覆盖 |
| 安全 | 凭据不进日志/结果；脱敏 | 日志断言 |
| 架构 | 端口无 HTTP/SDK 类型；无 L0 横向依赖 | 静态检查 |

## 8. 预算与单独运行

- 预算：目标 ≤30k token，上限 120k。
- 单独运行：`bun test tests/components/gateway/`（落地后创建）；用 Bun `serve` 桩调度器，不连真实服务。
- 状态：`planned`；无入口符号；S1 才需要实现，S0 用 `LocalSchedulerAdapter`。

## 9. 开放问题

- 端点/字段/鉴权/版本兼容窗口（M1）。
- 租约 TTL 与心跳超时余量（OQ-010）。
- 控制事件批大小与补发窗口（M1）。
- 调度器不可达的退出阈值（重试次数/时长，M1）。
- 容量单位（OQ-011）与 `claim` 参数形态。
