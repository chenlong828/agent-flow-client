---
layer: design
module: execution-plane
component: CMP-observer
status: active
updated: 2026-11-17
---

# CMP-observer 组件规格

> 状态：`active`（2026-11-17，观测面 v1 落地）。
> 上游：`docs/design/contracts/client-observability-v1.md`；工序 `docs/works/2026-11-06-observability-http/`。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L0 技术边界（只读 HTTP 适配器）。
- **业务价值**：把 client 本地执行过程变成调度器/运维可查询的只读信息面；没有它，执行细节只能靠日志文件与人工登录。
- **负责 X**：
  - 只读 HTTP 路由与鉴权（O-01–O-11）；
  - attempt 查询/分页、session 查询、SSE；
  - 运行文件 `O-09`/`O-10` 的请求编排；
  - 事件流广播与慢消费者隔离。
- **不负责 Y**：
  - 事件/meta 的持久化（`CMP-observability`）；
  - ACP 事件归一化与 raw 归档（`CMP-runtime`）；
  - run 注册表（`CMP-store`）；
  - 文件系统读取与路径约束（`CMP-workspace`）；
  - 控制面、写入、上传、DSH 解析。
- **变化轴**：观测 API 版本、内容级别、发现/鉴权方式。
- **删除测试**：删掉后本地执行细节重新变成不可查询；是真边界。

## 2. 内部功能

| 单元 | 职责 |
|---|---|
| `ObservationHttpServer` | Bun HTTP server、路由、错误信封、`no-store` |
| `ObserverAuth` | Bearer 校验；空 token 仅 loopback |
| `AttemptQuery` | O-02–O-05/O-07 的分页/过滤/SSE 编排 |
| `SessionQuery` | O-06/O-08、session→attempt 关联 |
| `SessionEventHub` | O-11 内存 ring、snapshot、订阅、关闭 |
| `RunFileQuery` | O-09/O-10 的 root/path 校验与 DTO 映射 |

- 不持有持久化数据；内存仅 O-11 ring（默认 1000 条）。
- 事件写盘/广播失败只降级该请求，不影响执行。

## 3. 契约

### 3.1 实现的只读端口

| 端口 | 提供方 | 用途 |
|---|---|---|
| `ObservationQuery` | `CMP-observability` | attempt/meta/events 查询 |
| `RunDirectory` | `CMP-store` | run → workspace/task-space |
| `RunFileReader` | `CMP-workspace` | 只读目录/文本读取 |
| `SessionArchiveReader` | `CMP-runtime` 归档文件 | O-08 raw |

### 3.2 HTTP

- 端点、字段、错误码以 [`contracts/client-observability-v1.md`](../../contracts/client-observability-v1.md) 为准。
- 全部 `GET`；`/api/v1/observability`；Bearer；`no-store`、`nosniff`、无 CORS。
- O-05/O-11 SSE：snapshot、`Last-Event-ID`、15s heartbeat、`end`、慢消费者、`maxStreams`。

### 3.3 启动/降级

- `[observability.http].enabled`；`required=false` 时 bind/初始化失败只记 `observability_disabled`。
- `run` 不启动；`serve` 启动/停止。
- 非 loopback 无 token 在配置层拒绝。

## 4. 数据所有权

- 无自有持久化；只读 `observability/sessions/*`、`runs/*`、工作区文件。
- O-11 ring 是进程内派生状态，重启丢失；历史以 `CMP-observability` 的 preview 事件与 raw 为准。

## 5. 验证

- `tests/components/observer/`：attempt store、mapper、recorder、HTTP、files、server start。
- 契约测试：O-01–O-11 正常/错误/鉴权/SSE/文件路径逃逸。
- 本地联调：`/health`、O-02/O-04/O-06/O-08、O-11 snapshot/end。

## 6. 预算

目标 ≤60k / 上限 120k（源码 + 规格 + 测试，按字节折算）。超过 60k 或端点 >12 个再拆子模块。
