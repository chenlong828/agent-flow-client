---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 工序：client 开发期自报身份（`X-Client-Id`）

> 来源：调度器侧工序 [`2026-11-12-dev-executor-self-enroll`](../../../../agent-flow-orchaster/docs/works/2026-11-12-dev-executor-self-enroll/client-proposal.md) 的 client 改动清单；决策背景见调度器侧 [`2026-11-12-executor-auth-dev-bypass`](../../../../agent-flow-orchaster/docs/history/decisions/2026-11-12-executor-auth-dev-bypass.md)。
> 定级：**P2**（新增可选请求头与配置键，跨 `CMP-cli`/`CMP-gateway`；兼容性契约变更，自动化测试可覆盖）。设计由 agent 完成，合并前需人最终确认。

## 1 背景与目标

开发期为加速联调，client 不应再依赖「先建 Harness 资产、签 token」才能被调度器认出。服务端已在 `EXECUTOR_AUTH=off`（当前默认）下支持身份旁路：请求带稳定的 `X-Client-Id`，服务端首见自动登记节点、重复请求复用同一行。

本工序把该旁路落到 client：一行 `[scheduler] client_id` 配置即可启动并自报身份；有 token 时继续带 `Bearer`，两种模式共存。

目标：

1. client 的五个执行面端点统一带 `X-Client-Id`（可选带 `X-Client-Address`），跨重启稳定。
2. 配置支持 `[scheduler] client_id`（`AF_CLIENT_ID` > 配置 > `hostname()`），非法值按配置错误退出 2。
3. 放开「非 loopback + 无 token」的启动校验，由 `[scheduler] allow_unauthenticated` 控制，默认关闭（回补时不用改代码）。
4. `doctor` 展示身份取值/来源与开发期身份方式。
5. 不新增注册端点、不持久化服务端身份、不改服务端。

## 2 范围

**做**：

- `CMP-cli`：`AppConfig.scheduler` 增加 `clientId`/`clientIdSource`/`clientAddress`/`allowUnauthenticated`；形状校验；放宽 token 校验；`doctor` 两项检查；组合根把身份注入传输层。
- `CMP-gateway`：`HttpTransport` 公共头层新增 `X-Client-Id`/`X-Client-Address`。
- 测试：`TC-CLT-ENR-1`～`4`（配置优先级/校验、五端点头、Bearer 共存、端到端 serve）。
- 文档：契约副本同步开发期身份旁路；`CMP-cli`/`CMP-gateway` 规格、`architecture.md` 契约表、`test-matrix`、`SCN-0002`、README、`.env.example`。

**不做**：

- 不新增注册/心跳端点，不由服务端发放 token，不做 token 自动回退（401 仍按退出 3 处理）。
- 不持久化 `clientId`/token，不读服务端回写的身份；权威仍在服务端。
- 不改 `run` 路径（`LocalScheduler` 不触网），不改 executor/runtime/workspace/assets/store。
- 不做生产模式收口（`EXECUTOR_AUTH=on` 属调度器侧部署动作）。

## 3 影响规格

### 3.1 外部契约调整（均为兼容扩展）

| 面 | 变更 | 兼容性 |
|---|---|---|
| HTTP 请求头 | 五端点新增 `X-Client-Id`（总是带）、`X-Client-Address`（可选） | 服务端 `EXECUTOR_AUTH=on` 时忽略；无 token 的旧部署仍可用 Bearer，行为不变 |
| `.config` | 新增 `[scheduler] client_id`、`[scheduler] allow_unauthenticated` | 未知键本就被忽略；旧配置不写这两个键时行为不变（身份取 hostname） |
| 环境变量 | 新增 `AF_CLIENT_ID` | 未设置时按配置/hostname 回退 |
| `doctor` 输出 | 新增 `scheduler.client_id`、`scheduler.identity` 两项检查 | JSON 消费方按 id 读取，新增项不破坏既有字段 |

配置优先级：`AF_CLIENT_ID` > `[scheduler].client_id` > `hostname()`。形状校验与服务端同正则 `^[^\s\u0000-\u001f\u007f]{1,64}$`；非法 → `config_invalid` 退出 2。

### 3.2 组件间关系调整

- 调用边（新增）：`CMP-cli` 组合根（`serve-compose`）读取已冻结的身份配置 → 构造 `HttpTransport` 时注入 → 传输层写入公共头。`CMP-gateway` 不读取配置，也不知道来源。
- 数据所有权（不变）：`clientId` 的权威在服务端（`harness.client_id`）。client 只持有启动期的冻结快照，不落盘、不回写。
- 基数：一个 client 进程 ↔ 一个稳定 `clientId`（1:1）；同一 `clientId` 可跨重启复用同一服务端节点行。
- 不受影响：`CMP-executor`/`CMP-runtime`/`CMP-workspace`/`CMP-assets`/`CMP-store` 的契约与实现；`run` 模式；结果与会话日志语义。

### 3.3 迁移与回滚

- 迁移：无数据迁移。已部署 client 不改配置即可工作（身份头取 hostname）；想显式命名就加 `client_id`。
- 回滚：服务端切 `EXECUTOR_AUTH=on` 后身份头失效，client 继续用 Bearer；`allow_unauthenticated` 默认 `false`，回补时无需改代码。

## 4 任务表

| ID | 类型 | 组件 | 内容 | 出口 | 状态 |
|---|---|---|---|---|---|
| `T-ENR-01` | change | `CMP-cli` | `client_id`/`allow_unauthenticated` 配置解析、校验、来源；放宽 token 校验 | 配置测试绿 | 完成 |
| `T-ENR-02` | change | `CMP-gateway` | 公共头 `X-Client-Id`/`X-Client-Address`；组合根注入 | 传输测试绿 | 完成 |
| `T-ENR-03` | change | `CMP-cli` | `doctor` 两项检查 | `doctor` 输出含取值/来源与开发期提示 | 完成 |
| `T-ENR-04` | test | 全部 | `TC-CLT-ENR-1`～`4`：配置 3 正 1 反、五端点头、Bearer 共存、端到端 serve | 全部绿 | 完成 |
| `T-ENR-05` | docs | — | 契约副本、组件规格、`architecture.md`、`test-matrix`、`SCN-0002`、README、`.env.example` | `docs:check` 绿 | 完成 |
| `T-ENR-06` | verify | — | `bun test`、`bun run typecheck`、`docs:check`、`quality:gate`；写 `result.md` | 全绿 | 完成 |

## 5 验收标准

| ID | 断言 |
|---|---|
| `TC-CLT-ENR-1` | 有 `client_id`、无 token：配置加载通过，请求带 `X-Client-Id` 且 `poll` 不被拒 |
| `TC-CLT-ENR-2` | 结果上报、会话日志、制品下载、归档同样带 `X-Client-Id`（五个端点公共头） |
| `TC-CLT-ENR-3` | `client_id` 空/全空白/超长/含空白 → `config_invalid` 退出 2，不回退 |
| `TC-CLT-ENR-4` | 有 token 时仍带 `Bearer`，并与 `X-Client-Id` 共存 |

## 6 确认记录

| 时间 | 事项 | 结论 |
|---|---|---|
| 2026-11-12 | `X-Client-Address` 取值 | 用户选择 `hostname()`：公共头总是带，仅服务端展示，不新增配置键 |
| 2026-11-12 | 按提案实施（含 `allow_unauthenticated` 开关） | 用户要求实现该提案 |
| 2026-11-12 | P2 合并确认 | 待收口时用户复核 `review.md` |
