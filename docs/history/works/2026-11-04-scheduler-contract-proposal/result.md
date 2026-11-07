---
layer: history
module: global
status: frozen
updated: 2026-11-07
---

# 工序结果：调度器契约提案（client 消费端）

> 状态：**v0.4 审核通过（2026-11-07），提案定稿并归档**。本工序只冻结提案，不冻结 `design/`；M1 冻结另立工序。

## 结论摘要

- 调度器对 client 的接口面收敛为 **6 个控制面操作 + 1 个制品通道**：`register`、`heartbeat`（长轮询兼控制事件）、`claim`、`renew`、`bindSession`、`reportResult`，以及技能包下载。
- client 侧需要调度器保证 **20 条**语义（`SCH-01`…`SCH-20`），client 承诺 13 条（`CLT-01`…`CLT-13`）；其中 6 条是 S1 的硬前提：实例粘性、单派发、attempt 身份、容器预置、技能集确定性、两条租约。
- 三个身份（`clientId` / `runId` / `attemptId`）与两条租约（客户端租约 / 尝试租约）是契约的骨架；attempt 归属按 `(clientId, attemptId)`，不按 `runId`，否则崩溃重启后的已结算结果永远报不上去。
- 调度器侧评审结论为 **通过**：两轮 Blocker/Decision now/Hold 全部关闭；逐条处置见 [`review.md`](review.md)，评审原文见 `../../../../../agent-flow-orchaster/docs/works/2026-11-05-scheduler-contract-review/review.md`。
- 评审新增 8 项裁决（Q13–Q20）；加上首轮 12 项，共 **20 项**。阻塞 S1 的仍是 Q1/Q2/Q3/Q5/Q6/Q7；阻塞 M1 冻结的是 Q13–Q16 四条 Blocker。
- client 的运行形态是 **CLI `serve` 启动的常驻后台执行进程**；CLI 只是入口，`run` 仍是一次性模式。常驻不等于可寻址：本契约的控制面仍只允许 client 出站；只读观测面另立 P1。
- 双方一致**不在 S1/M1 给 client 加控制面入站 HTTP**；作为已评估备选登记在提案 §17.1，重开条件为具备稳定可寻址地址与身份（常驻已满足，但仍缺地址/身份/发现）、平台 mTLS/发现、调度器需多种本地能力、执行以短任务/异步 job 为主。只读观测 HTTP 另立 P1（`2026-11-06-observability-http`），不承接控制。
- 与现行文档的差异集中在：新增技能包下载面、`NodeRequest` 去掉 `skillSet`、`SchedulerPort` 的 `register`/`heartbeat`/`bindSession` 返回类型扩展、`claim` 改用 `claimRequestId`、控制事件按 run 作用域、退出码新增 7、`bindSession` 不再返回 `lease`。

## 1. 评审处置

| 项 | 处置 | 落点 |
|---|---|---|
| `RB-01` `claim` 无幂等键 | 加 `claimRequestId`；同键同租约窗返回同一 attempt | `proposal.md` §5.3、§4.5 |
| `RB-02` fence 不等于停止执行 | `SCH-02` 改为旧租约过期或旧 run 收口后才可重派；新增 `SCH-19` | §7、§5.1、§9.3 |
| `RB-03` 控制事件重放无作用域 | 按 `(clientId, runId)` 队列；新 run 丢弃旧事件；`issuedAt` 作用域 | §5.2、§9.3 |
| `RB-04` `C-04` 失败映射冲突 | 按错误码分档：stale/lease_expired → cancelled；invalid_session/400/5xx → failed(scheduler) | §5.4、§9.1 |
| `RD-01` `C-05` 鉴权归属 | 共享 `AuthProvider`/`SchedulerEndpoint`；assets 不 import gateway | §5.5 |
| `RD-02` `claim` 与 pause/shutdown 竞态 | 不建 session，按 `cancelled(paused|shutdown)` 收口；无 release/nack | §5.3、§10 |
| `RD-03` `run_superseded` 退出码 | 新增 `7`，不复用 2 | §15 Q18、§5.1/§5.2/§5.3/§5.6、§10 |
| `RD-04` `message` 语义 | 有输出就填，空串仅表示确实没有输出 | §6.2 |
| `RD-05` `bindSession.lease` | 删除；租约唯一来源 `claim`/`renew` | §5.4、§6.6 |
| `ND-01` `shutdown(instanceId, cleanup)` 副作用随旧事件丢失 | 新增 `cleanupPending[]`/`cleanupAcks[]` 与 `releaseId`；事件只做在线加速，状态跨 run 幂等补偿 | §5.1、§5.2、§7 `SCH-20`、§9.3 |
| `ND-02` `SCH-19` 隐含 Q1=A | `SCH-19` 明写等价于 Q1 选 A；选 B 须改 `SCH-19` 并升 `protocolVersion` | §7、§11、§15 Q1 |
| `ND-03` 同刻作用域 | `claimedAt <= issuedAt`，同刻取消优先 | §5.2、§6.1、§6.4、§14.1 |
| `ND-04` `claimRequestId` 保留窗口 | 明确 `>= 尝试租约 TTL + 结果确认窗口`（建议 10min），属实现参数 | §5.3 |
| `ND-05` 凭据类型定义位置 | 定义在 `CMP-executor` 的 `ports`，组合根注入 | §5.5 |
| `ND-06` 三处簿记 | Q12 标注、`architecture.md` §3.2 退出码、§4.4 词表脚注 | §4.4、§13、§15 Q12 |

## 2. 验收对照

| 验收标准（brief §3） | 落点 | 状态 |
|---|---|---|
| 7 个契约面的端点、字段、状态码、错误码、幂等键、超时/重试、调用时机 | `proposal.md` §2.1、§5.1–§5.7 | 完成 |
| 每个契约面标明消费组件、端口方法、状态与失败收口 | `proposal.md` §3、§9.1 | 完成 |
| 调度器责任 `SCH-*` 与客户端承诺 `CLT-*`，含违反后果 | `proposal.md` §7、§8 | 完成（`SCH-01`…`SCH-20`） |
| 字段级值类型与枚举闭集 | `proposal.md` §6 | 完成 |
| 失败与边界矩阵 | `proposal.md` §10 | 完成 |
| 与现行文档的差异，逐条标类型 | `proposal.md` §13 | 完成 |
| 待裁决问题、推荐默认值、阻塞阶段 | `proposal.md` §15 | 完成（Q1–Q20） |
| 不改 `design/`、不改组件状态 | 本工序只新增/修改 `docs/works/` 与导航/OQ 登记 | 完成 |

## 3. 结论落点

| 结论 | 当前落点 | 确认后去向 |
|---|---|---|
| 7 个契约面与字段级草案 | `proposal.md` §5–§6 | M1 冻结；字段进 `design/architecture.md` §3.1 或独立契约文档 |
| 调度器责任 `SCH-01`…`SCH-20` | `proposal.md` §7 | 进 `architecture.md` §3.1/§10 与 `CMP-gateway` 规格 |
| 客户端承诺 `CLT-01`…`CLT-13` | `proposal.md` §8 | 与 `architecture.md` §6 不变量对齐 |
| 执行器承接与状态映射 | `proposal.md` §9 | 回填 `CMP-executor` §2.4/§3.4、`CMP-cli` §2.4、`CMP-gateway` §3 |
| 与现行文档的差异 | `proposal.md` §13 | 按 P 级逐条改；契约变更按 P1/P2 走 |
| 20 项待裁决 | `proposal.md` §15 | 调度器侧复核 Q13–Q16/Q18；关闭 `OQ-006/010/011/012/013` 与新增 OQ |
| 联调与验收建议 | `proposal.md` §14 | S1 桩调度器与契约测试的任务输入 |
| client 控制面入站 HTTP 否决 | `proposal.md` §17.1 | 已评估备选；只读观测 HTTP 另立 P1 |

## 4. 未决与风险

| 项 | 风险 | 处理 |
|---|---|---|
| Q1 容量/同实例并发 | 选 B/C 会改动 `cancelInstance` 粒度与容量字段；S1 选 A 但调度器若并发派发会「有容量领不走」 | 调度器侧确认派发策略；`SCH-19` 已钉死同实例单活跃 |
| Q2 attempt 身份 | 复用 attemptId 会让 client 去重逻辑把重跑当成重复执行 | 建议写死「重跑新 attemptId」 |
| Q3 迟到结果 | 若调度器把 late 当 200 接受并覆盖，会丢新尝试结果 | 保持 409 + 只审计；client 不重试 |
| Q4 assignments | 不提供时 client 只能靠 journal 恢复；容器清理可能滞后 | 先按可选实现，S2 再评估 |
| Q6 技能包通道 | 跨 host 带 token 会泄漏凭据；签名 URL 过期会让长任务下载失败 | 托管端点优先；外链短期签名 + 不带 token |
| Q18 退出码 | 新增退出码 7 是 CLI 契约变更 | 评审建议采用 7；M1 确认后写入 `CMP-cli` |
| Q13–Q16 Blocker | 未复核前不能冻结 | 两轮复核均判「关闭」；待调度器把评审收口为「通过」 |
| H-01 结果保留窗口 | journal 重报窗口未定，可能丢历史结果 | M1 前补 `OQ-021` |
| 上游现状 | 调度器仓库还没有这组端点，联调需先建桩 | S1 桩调度器与 client 并行开发 |

## 5. 审核结论

调度器侧 2026-11-07 确认**通过**：

1. `RB-01`–`RB-04` 全部关闭；
2. `RD-01`–`RD-05` 与 `Q13`–`Q20` 按提案建议拍板；
3. `ND-01`–`ND-06` 全部落稿；
4. `SCH-19`/`SCH-20`、`CLT-13` 纳入 M1 冻结输入。

本工序归档为历史记录；契约字段的权威落盘在 M1，不在本目录。

## 6. 下一步

1. 开 M1 冻结工序：把字段/错误码/枚举写进 `design/`，同步 `architecture.md`、`CMP-executor`、`CMP-gateway`、`CMP-cli`、`CMP-assets`、`CMP-result`。
2. S1 实现顺序：桩调度器 → `CMP-gateway` 契约测试 → `CMP-cli` 循环（含 `claimRequestId`、`SCH-19`）→ `CMP-executor` 绑定/上报（含 C-04 分档）→ `CMP-assets` 下载。
