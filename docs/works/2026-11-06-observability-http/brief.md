---
layer: works
module: global
status: active
updated: 2026-11-17
---

# 工序 Brief：client 只读观测面（v2，以 Session 为中心）

> 类型：P1 架构/契约提案（新增入站只读接口、组件职责与持久化数据）。先设计，不直接改 `design/`。
> 2026-11-17 重定向：v1 以 attempt 索引 + 归一化日志为主；调度层已经有很细的 task/attempt/run 视图，重复建设价值不大。v2 聚焦 **打开一个 session 看 ACP 执行反馈**。v1 提案留档 [`proposal-v1.md`](proposal-v1.md)。

## 1. 背景

- client 是 CLI `serve` 启动的常驻后台执行进程；此前架构写的是“不提供本地 HTTP 服务或 IPC”。本工序开一个**只读观测面**，不是控制面。
- 调度层已能回答：哪个 run、哪个节点、第几次 attempt、状态与结果。它缺的是**session 内的执行细节**：模型说了什么、想了什么、调了哪些工具、工具输入输出、usage、权限。
- 现有 `CMP-observability` 只有结构化日志/`doctor`/脱敏；没有入站 HTTP、没有 session 事件存储、没有 SSE。
- DSH session 落在实例 `DSH_HOME/sessions`，实例回收会删 home；要在清理前归档到 client 持久目录。
- 旧结论“client 不加入站 HTTP”只适用于**控制面**；观测面是独立的只读 P1，不改变调度器控制契约。

## 2. 问题

1. 打开 session 后要展示哪些 ACP 事件？字段、内容级别、上限、分页与 SSE 怎么定？
2. session 列表如何做“发现”，同时不复制调度层的 attempt 索引？
3. 事件、meta、raw 三类数据谁写谁读？保留、清理、崩溃恢复怎么做？
4. HTTP server 放在哪个组件？扩展 `CMP-observability` 还是新增 `CMP-observer`？
5. `serve` 如何启停、绑定地址/端口、token、内容级别与 raw 开关如何配置？
6. 内容变丰富后，安全边界（loopback/token/审计/脱敏）如何重新定？
7. 任务级运行文件如何只读拉取？`runId` 从哪来、注册表谁写、路径/大小/二进制边界怎么定？

## 3. 验收标准

- 端点清单以 **session** 为中心：health、session 列表、session 详情、事件分页、事件 SSE、raw 下载；**不提供 `/attempts*`**。
- 字段级 schema：`SessionEvent`（lifecycle/prompt/message/thought/tool_call/tool_result/usage/permission）、`SessionSummary`、`SessionMeta`、错误信封。
- 明确内容级别（`full`/`metadata`）、单事件/单 session 上限、截断标记、raw 兜底。
- 明确数据所有权：meta/events 由 `CMP-observability` 写，raw 由 `CMP-runtime` 写；HTTP 只读。
- 明确组件切分与依赖方向（至少两个候选：扩展 `CMP-observability` vs 新增 `CMP-observer`）。
- 明确鉴权、绑定、SSE 并发、审计、保留与 404/410 语义。
- 明确与调度层的分工：不复制 attempt 状态机；`sessionId` 由调度层/UI 关联。
- 文件端点 `O-09`/`O-10`：run-scoped 相对路径、一层列表、2000 条、文本 1 MiB、二进制元数据、无下载/写入。
- `TaskRequest.runId` + `<stateRoot>/runs/<runId>.json` 注册表：写入/重建/保留/404/410。
- 发现与启动：静态配置 + `X-Observability-Url` 自报、默认 loopback、非 loopback 强制 token、`required=false` 降级。
- 不修改 `design/` 真相；P1 评审通过后再回填。

## 4. 非目标

- **不做 attempt 索引、attempt 列表、attempt 日志、attemptId 路由**；这些在调度层已有。
- 不做控制面（claim/cancel/pause/shutdown 的替代入站接口）。
- 不做上传、远程执行、任意文件读取、DSH 会话恢复/继续。
- 不做 UI、图表、告警后端、日志聚合服务。
- 不做自动发现/注册、多 client 聚合。
- v2 不做 TLS/mTLS/证书轮换（先静态 token + 绑定地址；通道安全另立）。
- 不解析 DSH 原始 session 格式；raw 原样归档/下载。
- 不单独解析/展示 system prompt；raw 里有。
- 文件拉取不做写入/编辑/上传/删除/终端，不做绝对路径/跨 run/递归树/二进制下载。

## 5. 任务表

| ID | 类型 | 内容 | 对象 | 状态 | 装载清单 |
|---|---|---|---|---|---|
| T1 | 设计 | Session 端点、`SessionEvent`、内容级别、分页/SSE、错误码 | 观测 HTTP | 完成（v2 稿） | 本 brief、`proposal.md` |
| T2 | 设计 | 存储/归档/保留/恢复与数据所有权 | `CMP-observability`、`CMP-runtime` | v2 已覆盖，待评审 | T1、组件规格 |
| T3 | 设计 | 组件切分、`serve` 启停、配置、鉴权 | `CMP-cli`、`CMP-observability` | v2 已覆盖，待评审 | T1/T2、`architecture.md` §4 |
| T4 | 评审 | P1 四档评审与人工确认 | 双侧 | v1 已评审；v2 待重新评审 | T1–T3 |
| T5 | 落地 | 按确认稿改 `design/` 与代码 | 组件 | 待做 | T4 通过 |
| T6 | 设计 | 运行文件 `O-09`/`O-10`、runId 注册表、发现/鉴权/降级 | `CMP-observer`、`CMP-store`、`CMP-workspace` | v2 已覆盖（§15），待评审 | T1、上游 2026-11-17 提案 |

## 6. 领取的开放问题

| ID | 与本工序的关系 | 处理 |
|---|---|---|
| OQ-005 | 日志/事件保留多久 | v2 提案默认 7 天 / 1 GiB / 单 session 64 MiB |
| OQ-014 | 配置键清单与优先级 | 新增 `[observability]` / `[observability.http]`，待 M1 冻结 |
| OQ-021 | 已上报未确认结果保留窗口 | 与观测保留分开：journal 是恢复真相，观测归档是查询副本 |
| OQ-022 | 观测 HTTP 的绑定/鉴权/发现 | v2 建议默认 loopback + 可选 token；非 loopback 必须 token；待产品确认（可能推翻 v1 的 `0.0.0.0` 默认） |
| OQ-36 | 观测面文件鉴权/TLS | v1 复用 executor token、默认 loopback；生产前补鉴权/TLS |

## 7. 环境与边界

| 项 | 值 / 做法 |
|---|---|
| 代码改动 | 本轮无；P1 确认后才动 `src/` |
| 现行真相 | `docs/design/` 不动 |
| 路径拼写 | 用户原写 `/observale`，按 `observability` 修正；短路径备选 `/observe` |
| 校验 | `bun run docs:check`；P1 评审记录 |
| 内容级别 | `full`（默认，含文本/工具 I/O）或 `metadata`（只留轨迹） |
| 文件根 | `task-space`（默认）/`workspace`；相对路径；只读 |

## 8. 产出

- `proposal.md`：v2 session-centric 提案。
- `proposal-v1.md`：v1 attempt-centric 提案（留档）。
- `result.md`：结论、待确认项与落地顺序。
- `review.md`：v1 评审记录（v2 需重新评审）。
