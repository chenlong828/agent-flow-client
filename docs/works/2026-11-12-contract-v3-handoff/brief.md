---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 工序：执行面契约 v3 交接与 client 侧实现

> 来源：调度器侧 `REQ-0001`（工作流运行编排）与工序 `2026-11-11-workflow-run-orchestration`；契约 v3 于 2026-11-11 设计冻结。
> 本目录是**交接件**：[`executor-http-v3.md`](executor-http-v3.md) 是调度器侧现行契约的完整副本；[`contract-diff.md`](contract-diff.md) 给出相对 v2 的变更、原因与按组件的实现清单。
> 交接约定：client 在本工序完成契约副本同步与实现后，写 `result.md` 并通知调度器侧；调度器侧收到确认后继续 `T-RUN-05`–`T-RUN-08`，最后双方在 `T-RUN-09` 联调。
> **2026-11-12 修订**：按 [`review.md`](review.md) 调整契约（见 [`response.md`](response.md)）；副本、`contract-diff.md` 与本 brief 已同步更新。

## 1 背景

调度器侧已把执行面契约从 v2 升到 v3，并冻结为完整契约（五个端点；task-space、会话日志、运行归档、协议版本 3）。client 当前仍是 v2：三端点、结果只带控制信息、没有 task-space 与会话日志上传。

v2 → v3 是**开发期版本替换**，不设兼容窗口：调度器侧上线 v3 后会拒绝 `X-Executor-Protocol: 2` 的 client，因此两边必须同批切换。client 是执行面实现方，本次交接负责把这部分落到 client 仓库。

## 2 目标

1. 把 `executor-http-v3.md` 同步为 client 仓库的契约副本，并替换 `docs/design/contracts/executor-http-v2.md`（v2 归档）。
2. 按 v3 改造 client：task-space 目录创建（只建目录）、会话日志上传（含 0 行空日志）、运行归档、`archiveRequests`/`archivedRuns`、协议版本 3。
3. 用测试证明：日志先于结果、缺日志 `409` 后补传、空日志可结算、同键重传覆盖、归档后台与包校验、v3 字段完整。
4. 给出 client 侧完成确认，供调度器侧进入联调。

## 3 范围

**做**：

- `docs/design/contracts/` 的 v3 副本与 v2 归档；相关文档引用（`architecture.md`、`CMP-gateway`/`CMP-executor`/`CMP-runtime`/`CMP-store` 规格、`README.md`、`plan/roadmap.md`、场景与测试矩阵）从 v2 更新到 v3。
- 执行面客户端行为：`taskSpacePath` 创建（只建目录）、0 行空日志、`P-04` 日志上传、`P-05` 归档、`archivedRuns` 回报、协议 3 闸门。
- 契约测试与场景测试（3 正 1 反，按契约 §10.2 的 client 门禁）。

**不做**：

- 不改调度器仓库；不做编排决策（下一节点、verdict 解析、回退、confirm）。
- 不做 `split` / `fanout`（第二期）；不做归档读取端点。
- 不做日志保留期与配额（调度器侧 `OQ-27`，client 只负责上传）。
- 不改 DSH/ACP 本身；不新增本地控制面 HTTP。

## 4 契约变更摘要

| 变更 | 内容 | client 动作 |
|---|---|---|
| 协议版本 | `X-Executor-Protocol: 3`；v2 client 被 `400` 拒绝 | 请求头改为 3；首个 poll 收到 `400 unsupported_protocol` 即退出（非 0） |
| `TaskRequest.taskSpacePath` | 必填绝对路径 | 收到任务先 `mkdir -p`，再建 session |
| `P-04` 会话日志 | `POST /tasks/{taskId}/session-log?attempt=n`，gzip JSONL | 节点结束先上传日志，`200` 后再报结果；允许 0 行空日志；同键重传后到覆盖 |
| `P-05` 运行归档 | `POST /runs/{runId}/archive`，task-space 的 tar.gz | 收到 `archiveRequests` 后在后台打包上传，不阻塞 poll；下一跳 `archivedRuns` 确认 |
| `P-01` 字段 | 请求加 `archivedRuns`；响应加 `archiveRequests` | 解析并处理归档电平 |
| `P-02` 前置 | 缺日志返回 `409 session_log_missing` | 补传日志后重试结果，不重跑任务 |
| 承诺 | 新增 `C-10`/`C-11`/`C-12`；`C-08` 修订 | 见契约 §7 |
| 常量 | 新增 `maxSessionLogBytes`、`maxArchiveBytes`、`maxArchiveEntries`、`maxArchiveUncompressedBytes` | 客户端只需预检 `maxArchiveBytes`；日志超限按空日志 + `failed(session_log_too_large)` 处理 |
| 错误码 | `session_log_missing`、`run_not_found`、`invalid_state`、`invalid_archive`；结果码 `session_log_too_large` | 映射到本地结果错误分类 |

完整字段与语义以 [`executor-http-v3.md`](executor-http-v3.md) 为准；逐条对照见 [`contract-diff.md`](contract-diff.md)。

## 5 为什么改（原因）

1. **task-space**：一次运行的产物需要按 run 隔离，节点之间靠目录里的文件传递上下文；workflow 定义与 run 编排在调度器侧，client 只负责创建目录与写入诉求，不解释内容。
2. **日志先于结果**：run 失败、client 崩溃时，失败节点的会话日志仍要可用；日志按节点上传，不能等到 run 结束的归档。因此日志是独立端点，且是结果被接受的前置。
3. **运行归档**：task-space 是完整证据；run 终态后由 client 打包上传，服务端解包校验并归档。归档失败不回退 run 状态，所以它是独立于结果的冷路径。
4. **协议 3**：新增必填字段与「日志先于结果」的语义变化，按契约 §13 升整数；双端同批上线，不保留 v2 兼容。
5. **单工作区单活跃 run**：调度器侧保证同一工作区同一时刻只推进一个 run 的任务（fan-out 例外，第二期）。client 不需要实现互斥，但会观察到同一容器上的任务更少、更连续。

## 6 任务表

| ID | 类型 | 组件 | 内容 | 出口 | 状态 |
|---|---|---|---|---|---|
| `T-CV3-01` | design | 文档 | 同步 v3 契约副本、归档 v2、更新文档引用与测试矩阵 | 契约副本与调度器侧逐字一致 | 待开始 |
| `T-CV3-02` | change | `CMP-gateway` | 协议 3、`P-04`/`P-05` 客户端方法、`409 session_log_missing`/`413`/`stored` 处理 | 契约测试绿 | 待开始 |
| `T-CV3-03` | change | `CMP-executor` / `CMP-workspace` | `taskSpacePath` 创建（只建目录）、0 行空日志、日志采集与上传时序 | 场景测试绿 | 待开始 |
| `T-CV3-04` | change | `CMP-cli` / `CMP-store` | `archiveRequests`/`archivedRuns` 电平、归档打包与重试、本地目录保留 | 归档场景绿 | 待开始 |
| `T-CV3-05` | verify | 全部 | 契约 §10.2 client 门禁 + 3 正 1 反；`bun test`、`bun run typecheck` | 全绿；写 `result.md` | 待开始 |
| `T-CV3-06` | handoff | — | 向调度器侧确认完成，进入 `T-RUN-09` 联调 | 调度器侧收到确认 | 待开始 |

## 7 验收标准

1. `docs/design/contracts/executor-http-v3.md` 与调度器侧契约副本逐字一致（允许仓库路径说明差异）；v2 已归档且有 superseded 说明。
2. 以下行为有测试与断言：
   - 首任务建 task-space 目录（不写内容）；无事件时上传 0 行空日志；
   - 日志先于结果；缺日志时收到 `409`，补传后结果被接受；
   - 同 `taskId+attempt` 重传不同字节仍 `200`，`stored` 为 `created`/`replaced`/`unchanged`；
   - `P-04`/`P-05` 超限 `413`、归档路径穿越/损坏 `400`；
   - `archiveRequests` 电平与 `archivedRuns` 确认；
   - 协议 `2` 与缺失均被拒绝。
3. `bun test` 与 `bun run typecheck` 通过；场景测试按 3 正 1 反。
4. `result.md` 写明完成项、偏差与未覆盖项，并给出可联调的 client 版本（commit）。

## 8 非目标

- 不做 `split` / `fanout` 与 task.db（第二期）。
- 不做 verdict 解析、回退、confirm——这些在调度器侧。
- 不做 task-space 的服务端读取或归档下载。
- 不做 v2/v3 双版本并存。

## 9 风险与待定

| 风险 | 影响 | 处理 |
|---|---|---|
| 会话日志体积 | 单节点可能上百 MB | 压缩上传 + 64 MiB 上限；超限先传 0 行空日志再报 `failed(session_log_too_large)`，任务正常结算，真实日志不保留（`R-001`） |
| task-space 路径安全 | 写错目录会污染工作区 | 只接受服务端下发的绝对路径，创建前校验位于 `workspacePath` 之下 |
| 归档打包耗时 | run 终态后可能长时间占用 | 归档是冷路径，不阻塞结果；失败保留本地目录可重试 |
| v2 文档引用遗漏 | 契约混乱 | `T-CV3-01` 全仓替换 + 评审检查 |
| 本地未提交改动 | 交接 diff 混杂 | 开工前先清点 `git status`，只提交本工序文件 |

## 10 交接约定

- 本工序以调度器侧契约为唯一权威；client 发现契约缺口时，先反馈调度器侧改契约，不在 client 侧私自扩展字段。
- client 完成后在 `result.md` 写明「契约副本已同步、实现已完成、可联调版本」，并通知调度器侧；调度器侧收到后继续 `T-RUN-05`–`T-RUN-08`，最后进 `T-RUN-09`。
