---
layer: works
module: global
status: active
updated: 2026-11-17
---

# client 观测面修复反馈（对应 orchestrator client-fix-list）

> 来源：`agent-flow-orchaster/docs/works/2026-11-17-client-observability-verification/client-fix-list.md`。
> 状态：P0/P1 已修；P2 部分处理；未改调度器。

## 1 P0

| ID | 状态 | 处理 |
|---|---|---|
| `CF-01` SSE abort 异常 | 已修 | `attemptStream`/`sessionStream` 用统一 `finish()`：`closed` 先置位、`controller.close()` try/catch、abort/cancel 共用清理；新增 abort/ended 测试 |
| `CF-02` 保留/上限 | 已修（基础） | `FileAttemptStore.prune`、`FileSessionArchive.prune`、`FileRunRegistry.prune`；`serve` 每小时执行；attempt 事件超 10 MiB 时保留后半并记 `truncatedBefore`；活跃 attempt/session/run 不清理；`goneAt` tombstone |
| `CF-03` run 404/410 | 已修 | run 清理写 tombstone `goneAt`；O-09/O-10 对 tombstone 返回 `410 run_gone`；未存在仍 404 |
| `CF-19` SSE idle 超时 | 已修 | `Bun.serve({ idleTimeout: 30 })`，高于 15s heartbeat |

## 2 P1

| ID | 状态 | 处理 |
|---|---|---|
| `CF-04` `Last-Event-ID` | 已修 | O-05/O-11 读取头；从 seq+1 补发；O-11 有 gap 时 `reset=true` |
| `CF-05` snapshot `truncatedBefore` | 已修 | O-05 snapshot 带 `truncatedBefore` |
| `CF-06` 慢消费者 | 已修 | 每流按 `controller.desiredSize<=0` 累计 pending；>1000 发 `slow_consumer` 并关闭；不影响其他流 |
| `CF-07` raw Range | 部分 | 已加 `Accept-Ranges: bytes`；未实现单 Range 切片（契约标可选） |
| `CF-08` session meta | 已修 | `writeSessionMeta` 落 `sessions/<id>/meta.json`（attempt/run/node/cwd/status/archive）；recorder 在 session/settle/archive 时更新 |
| `CF-09` health | 部分 | 真实 `startedAt`/`uptimeMs`；计数用 `stats()` 不再截断 200；`degraded` 仍固定 ok（需要写盘失败状态汇总，后续） |
| `CF-10` `logRange.firstSeq` | 已修 | 从首事件 seq 计算；无事件为 0 |
| `CF-11` 文件限制 | 已确认 | 保留 2000/1 MiB；契约写明；未改成不设限（上游限制仍有效） |
| `CF-12` 2 MiB/5s 归属 | 已澄清 | 契约写明：client 只强制 2000/1 MiB；2 MiB/5s 是调度器适配器/BFF 限制 |

## 3 P2

| ID | 状态 | 处理 |
|---|---|---|
| `CF-13` O-05 结束 snapshot | 已修 | 已结束 attempt 先发 snapshot 再发 end |
| `CF-14` `session.closed` | 已修 | recorder.settle 在 close 前 publish `lifecycle=session.closed` |
| `CF-15` 大目录提前停止 | 未做 | 仍先 `readdir` 再 `lstat` 全部；大目录性能后续 |
| `CF-16` raw sha 复用 | 已修 | archive 后写 session meta；`FileSessionArchive.resolve` 优先读 meta 的 size/sha |
| `CF-17` auth 开关 | 已澄清 | 保持 token 语义：非空要求 Bearer，空仅 loopback；不加独立开关 |
| `CF-18` attempt 重复 | 维持 | 非缺陷；client 本地排障用途 |

## 4 测试

- 新增/更新：SSE Last-Event-ID、abort、ended snapshot+end、慢消费者（逻辑）、run tombstone、session meta、health。
- `bun test` **169 pass**；`typecheck`、`docs:check` 通过。
- 本地 `serve` 已 reload，`/health` 返回真实 uptime；`Last-Event-ID: 2` 验证只补 seq 3+。

## 5 未完成/后续

- `CF-09` `degraded`：需要把事件写盘持续失败状态汇总到 health；当前仍 `ok`。
- `CF-15` 大目录性能；`CF-07` Range 切片可选。
- `CF-02` 清理周期为 1 小时；首次启动不立即清理（可加启动清理）。
- 调度器侧 `runId`/URL/适配器仍按 `scheduler-contract-diff.md` 交接。

## 6. 2026-11-17 追加处理（UI handoff 期间）

| ID | 状态 | 处理 |
|---|---|---|
| `CF-09` | 已完成 | `ObserverHealth`：事件写盘连续失败 3 次 `degraded`，成功恢复；health 返回 `degraded` |
| `CF-15` | 已完成 | `opendir` 读到 `limit+1` 即停，不再全量 `readdir+lstat` |
| `CF-02` | 已补 | 启动时执行一次清理，之后每小时；attempt/session/run 均清理 |
| `CF-07` | 已明确 | 仅声明 `Accept-Ranges`；v1 不实现 Range 切片，契约写清 200 全量 |
| `CF-06` | 代码已改 | desiredSize 限额；真实慢消费者测试未补 |
| `CF-10` | 代码已改 | `firstSeq` 从首事件算；截断用例未补 |
| `CL-03` | 已完成 | 新增 [`deployment.md`](deployment.md) |
| `CL-04` | 已完成 | 契约补充 Accept-Ranges/Range、2000/1MiB、2MiB/5s 归属、degraded |
| `CL-02` | 完成 | `bun test` 169 pass；`bun run check` 全绿（质量报告 0 违规） |
| `CL-01` | 完成 | 本 commit 仅包含观测面相关文件；tag `client-observability-v1` |

## 7. 阻塞复核修复（2026-11-17 第二轮）

| 项 | 状态 | 处理 |
|---|---|---|
| 3.1 SSE cancel 泄漏 | 已修 | `attemptStream`/`sessionStream` 的 `cancel()` 统一调 `finish()`/`writer.finish()`；`finish` 幂等，清理 poll/heartbeat/订阅/activeStreams |
| 3.2 启动失败仍上报 URL | 已修 | transport 只在 `setup.observer !== undefined` 时带 `X-Observability-Url` |
| P2 raw gone | 已修 | raw 先查 attempt `goneAt`，返回 410 |
| P2 活跃 run 保护 | 已修 | run 注册表只清理已归档且过期的 run；未归档 run 不按时间清理 |
| P2 session tombstone | 已修 | prune 写 `sessions/<id>/gone` 并删 raw；O-06/O-07/O-08/O-11 返回 410 |
| P2 文件截断顺序 | 已明确 | 超过 2000 条时返回 `limit+1` 扫描子集，契约写明不保证全局排序 |
| signals UC-14 | 本地不重现 | 当前 commit 连续 3 次 `signals.test.ts` 1 pass；全量 169 pass。需失败方提供 commit/环境/日志 |

- `bun test` 169 pass；`bun run check` 质量报告 0 违规。
- 第二轮修复将单独 commit（仅观测面），tag 建议新打 `client-observability-v1.1`，不移动已发布的 `v1`。
