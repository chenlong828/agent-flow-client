---
layer: works
module: global
status: frozen
updated: 2026-11-10
---

# 工序结果：执行面契约 v2 迁移

## 1. 结论摘要

- 调度器侧发布 executor contract v2（三端点、at-least-once、`X-Executor-Protocol: 2`），client 已完成迁移。
- 删除 v1 的 register/heartbeat/claim/renew/bindSession/cleanup、租约、`runId` fencing、`late_result`、`cleanupPending`、`seq/ackSeq`、实例锁与清理对账。
- 新模型：`poll`（取任务 + 上报 `running[]`/`finished[]` + 收 `stop`/`cancelInstances`）、`result`、`skill-packages`；同一实例可并发任务。
- 结果先落 journal `settled`，未 accepted 前留在 `finished[]`；重启补报；`accepted=false` 丢弃。
- `bun run check` 全绿；`bun test` 105 用例通过。

## 2. 代码改动

| 区域 | 改动 |
|---|---|
| `executor/types.ts`、`ports.ts`、`domain-types.ts`、`scheduler-port.ts` | 值类型与端口改为 v2；`SchedulerPort` = `poll`/`reportResult`/`downloadPackage` |
| `gateway/` | 三端点、协议头、6 个 HTTP 错误码、重试；删除 `state.ts`、身份文件 |
| `executor/executor.ts` | `executeTask`、`received→running→settled`、任务自带 skillSet、同实例并发、结果落盘 |
| `cli/serve*` | 单 poll 循环、`running`/`finished`、`stop`/`cancelInstances`、信号；删除心跳/领取/清理对账 |
| `assets/` | `P-03` 下载器注入、同容器安装串行、digest 短路；`run` 仅本地来源 |
| `runtime/` | 每 session 超时、可选 idle 看门狗、实例启动去重；仅无其它 session 时回收进程组 |
| `store/` | journal 简化（任务状态 + 结果）、删除实例锁与压缩 |
| `result/` | `TaskResult` 组装、错误映射去 `retryable` |
| `config` | `[capacity].max_concurrent`、`[executor].idle_timeout_ms`（默认 0） |

## 3. 测试

- gateway：传输/错误码/超时/重试、poll、result 首份/404、package 304/404。
- executor：状态序列、并发、技能失败不 prompt、超时、取消、截断。
- serve：同实例并发两任务（同一 DSH 进程）、stop、cancelInstances、finished 防重发、401 退出 3。
- store/assets/result/config 同步更新。
- `tests/support/stub-scheduler.ts` 重写为 v2 桩。

## 4. 偏差与决定

| 项 | 决定 | 说明 |
|---|---|---|
| 超时进程组 | 单任务超时只关自己的 session；同实例无其它 session 时才杀进程组 | v2 C-05 字面要求杀进程组，但同实例并发会连带；按并发安全优先，记录偏差 |
| 技能冲突 | 删除 `asset_skill_set_conflict` 守卫 | v2 交付清单要求；依赖 `S-06`，安装临界区仍串行 |
| 技能包下载 | gateway 实现 `P-03`，assets 通过注入下载器使用 | 保持 assets 不 import gateway |
| 身份 | 删除 clientId/runId 持久化与头部 | v2 无 register，token 绑定 clientId |
| 结果状态 | 本地 `received/running/settled/reported` | v2 只需要「在跑 / 已交结果」 |
| 并发启动 | runtime 对同实例 `ensureInstance` 去重 | 避免并发任务各起一个 DSH 进程 |

## 5. 遗留

- 真实调度器联调（调度器侧实现待建）。
- `idle_timeout` 默认关闭；是否按任务类型开启待调度器约定。
- 多实例 home 派生（OQ-009）仍未做；v2 同实例并发复用同一 home。
- 结果保留窗口（OQ-021）、模型路由（OQ-026）仍开放。
- C-05 字面「超时杀进程组」与同实例并发的冲突已按安全优先处理，待调度器侧确认表述。

## 6. 裁决摘要

P1 契约迁移（按调度器侧冻结稿实现）。blocker 0 / decision 3（超时进程组、技能守卫删除、下载器注入）/ hold 1（真实调度器联调）。
