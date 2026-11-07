---
layer: works
module: global
status: active
updated: 2026-11-07
---

# 工序 Brief：client 只读观测 HTTP 面

> 类型：P1 架构/契约提案（新增入站接口面、组件职责与持久化数据）。先设计，不直接改 `design/`。
> 目标：给调度器/运维提供 client 的当前执行日志、历史步骤日志与 DSH session 信息；只读，不参与调度控制。

## 1. 背景

- client 是 CLI `serve` 启动的常驻后台执行进程；此前 `architecture.md` 写的是「不提供本地 HTTP 服务或 IPC」，本次要开一个**只读观测面**，不是控制面。
- 调度器/运维需要看到：当前 attempt 的实时日志、已完成步骤的历史日志、以及对应的 DSH session 信息（含原始 session 文件）。
- 现有 `CMP-observability` 只有结构化日志/`doctor`/脱敏；没有 HTTP、没有按 attempt 的查询索引、没有 session 归档读取。
- DSH session 落在实例 `DSH_HOME/sessions`，实例回收会删 home；要在清理前复制到 client 的持久观测目录，才能查历史。
- 之前的「client 不加入站 HTTP」结论只适用于**控制面**（claim/cancel/心跳替代）；观测面是独立的只读 P1，不改变调度器控制契约。

## 2. 问题

1. 观测 HTTP 的路径、方法、字段、分页、SSE、错误码怎么定？
2. 当前日志与历史日志的数据源、索引、保留窗口、清理时机是什么？
3. “直接提供 DSH session 信息”是规范化事件、原始 session 文件，还是两者？敏感信息如何脱敏/鉴权？
4. HTTP server 放在哪个组件？`CMP-observability` 扩展还是新增 `CMP-observer`？
5. `serve` 如何启停、绑定地址/端口、token 与 scheduler 访问如何配置？

## 3. 验收标准

- 给出只读端点清单（当前 attempt、历史 attempt、日志分页、SSE、session 元数据/事件/原始文件）。
- 给出字段级 schema（`ObservationEvent`、`AttemptSummary`、`SessionMeta`、错误信封）。
- 明确数据所有权、写入/读取路径、保留与清理、`410` 语义。
- 明确组件切分与依赖方向（候选至少两个：扩展 `CMP-observability` vs 新增 `CMP-observer`）。
- 明确鉴权、绑定、脱敏与原始 session 下载的安全边界。
- 不修改 `design/` 真相；P1 评审通过后再回填。

## 4. 非目标

- 不做控制面（claim/cancel/pause/shutdown 的替代入站接口）。
- 不做写操作、远程执行、任意文件读取、DSH 会话恢复/继续。
- 不做 UI、图表、告警后端、日志聚合服务。
- 不做 mTLS/TLS/证书轮换（v1 先做静态 token + 绑定地址；通道级安全另立特性）。
- 不改变调度器心跳/租约/claim 契约。

## 5. 任务表

| ID | 类型 | 内容 | 对象 | 状态 | 装载清单 |
|---|---|---|---|---|---|
| T1 | 设计 | 端点、字段、分页、SSE、错误码 | 观测 HTTP | 进行中 | 本 brief、`proposal.md` |
| T2 | 设计 | 存储/归档/保留与数据所有权 | `CMP-observability`、`CMP-runtime` | 待做 | T1、`CMP-observability`/`CMP-runtime` 规格 |
| T3 | 设计 | 组件切分与 `serve` 启停、配置、鉴权 | `CMP-cli`、`CMP-observability` | 待做 | T1/T2、`architecture.md` §4 |
| T4 | 评审 | P1 四档评审与人工确认 | 双侧 | 完成：附评 `OB-01`–`OB-09` 已处置，`OB-01` 风险已确认接受 | T1–T3 |
| T5 | 落地 | 按确认稿改 `design/` 与代码 | 组件 | 待做 | T4 通过 |

## 6. 领取的开放问题

| ID | 与本工序的关系 | 处理 |
|---|---|---|
| OQ-005 | 日志保留多久 | 本工序给 `retentionDays` / `maxBytes` 默认，M1 确认 |
| OQ-014 | 配置键清单与优先级 | 本工序新增 `[observability.http]`，待 M1 冻结 |
| OQ-021 | 已上报未确认结果保留窗口 | 与观测保留分开：journal 是恢复真相，观测归档是查询副本 |
| OQ-022 | 观测 HTTP 的绑定/鉴权/发现 | 本工序给默认：`0.0.0.0:17890`，CLI 可改；token 可选，空则不鉴权并告警 |

## 7. 环境与边界

| 项 | 值 / 做法 |
|---|---|
| 代码改动 | 本轮无；P1 确认后才动 `src/` |
| 现行真相 | `docs/design/` 不动 |
| 路径拼写 | 用户原写 `/observale`，按 `observability` 修正；短路径备选 `/observe` |
| 校验 | `bun run docs:check`；P1 评审记录 |

## 8. 产出

- `proposal.md`：只读观测 HTTP 契约与组件修改方案。
- `result.md`：设计结论、待确认项与落地顺序。
- `review.md`：调度器附评 `OB-01`–`OB-09` 的处置记录。
