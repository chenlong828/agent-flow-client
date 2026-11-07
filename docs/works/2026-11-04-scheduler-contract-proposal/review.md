---
layer: works
module: global
status: active
updated: 2026-11-07
---

# 调度器评审记录与 client 裁决

> 评审对象：[`proposal.md`](proposal.md)（首轮 v0.1 997 行；2026-11-06 复核 v0.2；2026-11-07 复核 v0.4）。
> 评审原文：`../../../../agent-flow-orchaster/docs/works/2026-11-05-scheduler-contract-review/review.md`（2026-11-05，P1）。
> 评审结论：**有条件通过**；条件是四条 Blocker、五条 Decision now 必须先收口。client 侧已逐条裁决并落到 v0.4；待调度器复核后转「通过」。
> 确认记录：调度器侧评审人见原文；client 侧裁决为本工序；最终确认待复核（P1 人工门未关闭）。

## 1. 总览

| 档位 | 数量 | 处置 |
|---|---:|---|
| Blocker（`RB-01`–`RB-04`） | 4 | 全部接受，已在提案修订；待调度器复核 |
| Decision now（`RD-01`–`RD-05`） | 5 | 全部接受，按评审建议拍板 |
| Hold（`H-01`–`H-07`） | 7 | 全部接受；`H-01` 转 `OQ-021`，其余落提案 |
| 架构备选（client 控制面入站 HTTP） | 1 | 双方一致否决 S1/M1；只读观测 HTTP 另立 P1，不在本契约 |
| 复核新增 Decision now（`ND-01`–`ND-02`） | 2 | 全部接受；`ND-01` 新增 `SCH-20`，`ND-02` 明写 `SCH-19` 与 Q1=A 的等价关系 |
| 复核新增 Hold（`ND-03`–`ND-06`） | 4 | 全部落稿，未留到 M1 |

未改动 `docs/design/`；本轮只改提案与工序文档，冻结仍走 M1。

## 2. Blocker 处置

| ID | 处置 | 提案落点 |
|---|---|---|
| `RB-01` `claim` 无幂等键 | 接受。`claim` 请求加 client 生成的 `claimRequestId`；同一 `(clientId, claimRequestId)` 在租约窗内返回同一 attempt；`attemptId` 只作为响应值，不再冒充请求幂等键 | §2.1、§4.5、§5.3、§7 `SCH-09`、§14.1 |
| `RB-02` fence 不等于停止执行 | 接受。`SCH-02` 改为「旧租约过期或旧 run 已上报终态」才可重派；新增 `SCH-19` 同实例单活跃 attempt；`§5.1.3` 写明 fence 窗口；`§9.3` 同步恢复顺序 | §5.1、§7 `SCH-02`/`SCH-19`、§9.3、§11 |
| `RB-03` 控制事件重放无作用域 | 接受。控制事件队列按 `(clientId, runId)`；新 run 注册时丢弃旧 run 未 ack 事件；`shutdown(instanceId, cleanup)` 的副作用由 `cleanupPending` 补偿；`issuedAt` 只作用于 `claimedAt <= issuedAt` 的 attempt（同刻命中）；`ackSeq` 不要求跨崩溃持久化 | §2.2、§5.2、§6.1、§6.4、§9.3、§13 |
| `RB-04` `C-04` 失败映射冲突 | 接受。`stale_attempt`/`lease_expired`/`404` → `cancelled(superseded|lease_expired)`；`invalid_session`/`400`/`5xx` → `failed(scheduler)`；manifest → `failed(asset)` | §5.4、§9.1、§10 |

## 3. Decision now 处置

| ID | 处置 | 提案落点 |
|---|---|---|
| `RD-01` `C-05` 鉴权归属 | 接受共享凭据读取器：组合根把同一 `AuthProvider`/`SchedulerEndpoint` 注入 gateway 与 assets；assets 不 import gateway；跨 host 仍不带 token | §5.5、§13 |
| `RD-02` `claim` 与 pause/shutdown 竞态 | 接受：不新增 release/nack；claim 到达时若实例已暂停/释放或容器校验失败，不建 session，按 `cancelled(paused|shutdown)` 或失败路径在租约内上报 | §5.3、§10 |
| `RD-03` `run_superseded` 退出码 | 接受新增 `7`；不复用 `2`（用法/配置）。旧 run 停领、取消活跃、上报 `cancelled(superseded)`、退出 7 | §5.1、§5.2、§5.3、§5.6、§9.1、§10、§15 Q18 |
| `RD-04` `message` 语义 | 接受「有输出就填」，按 `maxResultBytes` 截断；空串仅表示确实没有输出 | §6.2、§13 |
| `RD-05` `bindSession.lease` | 接受删除；租约唯一来源 `claim`/`renew`；装技能期间用 `C-06` 续租 | §5.4、§6.6、§13 |

## 4. Verified sound（复核确认，不改）

| ID | 区域 | 复核结论 |
|---|---|---|
| `VS-01` | 三个身份 + 两条租约 | 切分正确，是契约承重墙；心跳断不等于 attempt 失效 |
| `VS-02` | `SCH-11` 崩溃重报 | 按 `(clientId, attemptId)` 归属、`reportResult` 不吃 `run_superseded`，两处一致 |
| `VS-03` | 长轮询超时层次 | 服务端 30s/20s、客户端 35s/25s 自洽；空批 `seq=ackSeq` |
| `VS-04` | 时钟处理 | `serverTime` + 单调时钟 + ±5s，不依赖墙钟 |
| `VS-05` | 结果截断责任 | client 截断、`limits` 下发、服务端不静默截断，责任单一 |
| `VS-06` | 错误码新增 | 端口层只加 `invalid_session`/`run_superseded`，9 个现有值语义未变 |
| `VS-07` | 技能集 digest 所有权 | 规范化归调度器、client 只比较与按包校验；空数组=清空技能根 |

## 5. Hold 处置

| ID | 处置 |
|---|---|
| `H-01` 结果保留窗口 | 留待 M1 前补 `OQ-021`；不阻塞契约冻结 |
| `H-02` `limits` 运行期变更 | 接受：`limits` 在 register 下发、运行期不变；变更需重注册 |
| `H-03` 容量权威 | 接受：`register.capacity` 只是初始声明，运行期以最近心跳 `state.capacity` 为准 |
| `H-04` `C-05` 请求头 | 接受：调度器托管下载补 `X-Client-Run-Id` |
| `H-05` 心跳 `activeAttempts` 冗余 | 保留；明确只是观测，不是权威 |
| `H-06` `attemptNo` 语义 | 接受：同一节点在本实例内的第几次尝试，从 1 开始，仅审计 |
| `H-07` 404 映射 | 接受：`attempt_not_found` → `stale_attempt`；`package_not_found`/`gone` → `asset` |

## 6. client 控制面入站 HTTP

**结论**：不在 S1/M1 做，登记为已评估备选。client 已经是 CLI `serve` 启动的常驻后台服务，但**常驻不等于可被调度器寻址**：仍缺稳定地址、身份、mTLS/服务发现。加入站 HTTP 只改变心跳控制事件的半个操作，却引入新监听、第二套鉴权方向、endpoint 生命周期与新失败域；长任务仍需 `202` + 状态查询 + 完成回调，净收益为负。

**重开条件**：client 具备稳定可寻址地址与身份（常驻已满足，但仍缺地址/身份/发现）；平台提供 mTLS/服务发现；调度器确需调用多种本地能力；执行以短任务/异步 job 为主且团队愿维护双向契约。若重开，另立 P1 `ExecutionIngress`，不改造 `SchedulerPort`。详见提案 §17.1。

> 只读观测 HTTP 已另立 P1（`docs/works/2026-11-06-observability-http/`），只提供日志/session 查询，不承接控制，故不推翻本节结论。

## 6.1 补充缺陷（2026-11-06）

| ID | 缺陷 | 处置 | 提案落点 |
|---|---|---|---|
| `ND-01` | `shutdown(instanceId, cleanup)` 的本地副作用跟着旧 run 未 ack 事件一起丢失；而实例从 assignments 快照消失又不触发删除容器，清理意图无补偿通道 | 接受。新增独立于 `assignments` 的 `cleanupPending[]` 幂等状态（`releaseId`/`instanceId`/`workspacePath?`/`cleanup`/`releasedAt`），`register` 与每次心跳返回；client 用 `cleanupAcks[]` 回执 `done`/`failed`，调度器只在 `done` 时清账。`shutdown` 事件带同一 `releaseId`，只做在线加速；事件丢失/新 run 丢弃时由状态补偿。新增 `SCH-20`，`shutdown(instanceId)` 的释放意图不再依赖事件跨 run 重放 | §5.1、§5.2、§6.6、§7 `SCH-13`/`SCH-20`、§8 `CLT-13`、§9.3、§10、§13、§14 |
| `ND-02` | `SCH-19` 无条件「同实例单活跃 attempt」已等价于 Q1 选 A，但未写明；将来选 B 会变成修改已冻结的 SCH 条目 | 接受。`SCH-19` 明写「本条等价于 Q1 选 A；若选 B，改为同实例多 attempt 仅当技能集 digest 相同（`SCH-05`），且需升 `protocolVersion`」；Q1 推荐与 §11 同步这句话 | §7 `SCH-19`、§11、§15 Q1 |

## 6.2 复核第二轮（2026-11-07）

调度器侧 2026-11-06 复核把条件收窄为 `ND-01`、`ND-02`，并新增 `ND-03`–`ND-06` 四条 Hold。`ND-01`/`ND-02` 已在 v0.3 落稿；本轮把四条 Hold 也一并落掉，避免留到 M1 再改语义。

| ID | 档位 | 发现 | 处置 | 落点 |
|---|---|---|---|---|
| `ND-03` | Hold | 作用域用 `claimedAt < issuedAt`，同刻取消/领取撞在同一毫秒时取消被忽略 | 改为 `claimedAt <= issuedAt`：同刻视为命中、取消优先；补同刻测试 | §5.2、§6.1、§6.4、§14.1 |
| `ND-04` | Hold | `claimRequestId` 幂等记录保留窗口只说「租约窗口内」，窗口过短会产生影子租约 | 明确保留窗口 `>= 尝试租约 TTL + 结果确认窗口`（建议 10min）；属调度器实现参数，不进对外契约 | §5.3 |
| `ND-05` | Hold | `AuthProvider`/`SchedulerEndpoint` 未写定义位置；放进 gateway 会让 assets 违反依赖边 | 明确定义在 `CMP-executor` 的 `ports`，组合根注入同一实例 | §5.5 |
| `ND-06` | Hold | 三处簿记：Q12 旧含义残留；退出码 7 未进 `architecture.md` §3.2；§4.4 混了两套词表 | Q12 标注「退出码已移 Q18」；§13 增 `architecture.md` §3.2 行；§4.4 加脚注说明 `C-05` 的 `asset` 是 `ErrorClass` 不是端口错误 | §4.4、§13、§15 Q12 |

`ND-01`/`ND-02` 的落稿见 §6.1；至此复核条件全部有落点，等调度器侧把本文档收口为「通过」。

## 7. 待复核

1. 调度器侧复核 `RB-01`–`RB-04` 的修订是否满足冻结条件；
2. 确认 `Q13`–`Q16`（Blocker 结论）与 `Q18`（退出码 7）；
3. 确认 `ND-01` 的 `cleanupPending`/`cleanupAcks`/`SCH-20` 与 `ND-02` 的 `SCH-19` 等价表述；
4. 确认 `ND-03`–`ND-06` 四处补充（同刻作用域、幂等保留窗口、类型定义位置、三处簿记）可按现文并入 M1；
5. 复核通过后，本 `review.md` 与调度器侧 `review.md` 收口为「通过」，本工序 `result.md` 更新为最终结论；M1 冻结另立工序。

**决策与反对**：client 接受全部 Blocker/Decision now 修法，无反对意见；`RD-03` 的「退 0」备选未采纳（无法区分正常重跑与旧进程被顶掉，运维不可观测）。**开放**：调度器复核、`OQ-021` 结果保留窗口。**owner**：client 提案工序；调度器侧评审人。
