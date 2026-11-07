---
layer: works
module: global
status: active
updated: 2026-11-07
---

# M1 冻结清单

> 把已归档提案 v0.4 的 §13 差异表逐行映射到 `docs/design/`。每行必须在 M1 关闭前有明确状态；`[x]` 未做，`[x]` 已落，`[-]` 不适用（需写原因）。
> 主文档：`docs/design/contracts/executor-http-v1.md`（T2 建）；组件规格只写本组件的端口/消费/失败收口。

## 1. 契约主文档

| ID | 提案位置 | 目标 | 验收 | 状态 |
|---|---|---|---|---|
| F-00 | §5–§6 全量 | 新建 `design/contracts/executor-http-v1.md` | 七个端点、通用约定、错误码、`SCH-01…20`、`CLT-01…13`、样例齐全 | [x] |

## 2. 架构

| ID | 提案位置 | 目标 | 验收 | 状态 |
|---|---|---|---|---|
| F-01 | §13 `architecture.md` §3.1 | 交互面补 `C-05`；`C-02` 唯一推送；`runId`/`serverTime`/`limits`/`claimRequestId`/`SCH-19`；控制事件 run 作用域 | 与主文档链接一致；不复制字段表 | [x] |
| F-02 | §13 `architecture.md` §2 | 容量单位定为实例数 + 同实例串行（A）；`SCH-19` 等价说明 | 与 `SCH-19` 一致 | [x] |
| F-03 | §13 `architecture.md` §3.2 | 退出码新增 `7 run_superseded` | 与 `CMP-cli` §2.8 一致 | [x] |
| F-04 | `ND-06` | `architecture.md` 与组件规格的退出码同步；§4.4 词表脚注 | 无“2 = superseded”残留 | [x] |
| F-05 | `SCH-20`/`ND-01` | 数据所有权/主流程补 `cleanupPending` 释放清理 | 与 `CMP-gateway`/`CMP-runtime` 边界一致 | [x] |

## 3. 组件规格

| ID | 提案位置 | 目标 | 验收 | 状态 |
|---|---|---|---|---|
| F-06 | §13 `CMP-executor` §3.4 | `SchedulerPort` 返回 `Registration`/`HeartbeatResult`/`SessionBinding`；`SessionBinding` 无 `lease`；`HeartbeatRequest` | 字段以主文档为准；无 HTTP 类型 | [x] |
| F-07 | §13 `CMP-executor` §3.5 | `NodeRequest` 去 `skillSet`，加 `attemptNo`/`claimedAt`/`timeoutMs`/`lease` | 与主文档 `NodeRequest` 一致 | [x] |
| F-08 | §13 `CMP-executor` §3.5 | `JournalPort` 补 `listInstances()`/`pendingAll()` | P2 内部端口；不扩调度器契约 | [x] |
| F-09 | §13 `CMP-gateway` §3.3 | 错误表新增 `invalid_session`/`run_superseded`；404/410 归置；`late_result` 409 | 与主文档错误表一致 | [x] |
| F-10 | §13 `CMP-gateway` §2.3 | `claim` 用 `claimRequestId`；bind/report/renew 幂等；attempt 归属 `clientId` | 同键重试返回同一 attempt | [x] |
| F-11 | §13 `CMP-gateway` §2.2 | 传输重连不重新 `register`；仅新 `runId`/显式要求 | 与 §5.1.10 一致 | [x] |
| F-12 | §13 `CMP-gateway` §2.4 | 控制事件按 `(clientId, runId)`；新 run 丢旧事件；`issuedAt` 作用域 | `claimedAt <= issuedAt` 写明 | [x] |
| F-13 | `ND-01` | `C-01`/`C-02` 补 `cleanupPending[]`/`cleanupAcks[]`；`shutdown` 补 `releaseId` | 幂等状态优先于事件 | [x] |
| F-14 | `ND-05` | `AuthProvider`/`SchedulerEndpoint` 定义在 `CMP-executor` ports | `CMP-assets` 不 import gateway | [x] |
| F-15 | §13 `CMP-cli` §2.4 | 循环补 `claimRequestId`、`assignments`、`cleanupPending`/`cleanupAcks`、`ackSeq` 空洞、204/长轮询、fence 收口、`SCH-19` | 与 §9.3 恢复顺序一致 | [x] |
| F-16 | §13 `CMP-cli` §2.8 | 新增退出码 7 | 与架构一致 | [x] |
| F-17 | §13 `CMP-assets` §3 | `C-05` 304、跨 host 不带 token、`packageId` 不可变、共享凭据 | 不 import gateway；凭据单一来源 | [x] |
| F-18 | §13 `CMP-result` §2.2 | 新增 `invalid_session`/`run_superseded` 映射；cancel reason 映射 | 与主文档 `ErrorClass`/`CancelReason` 一致 | [x] |
| F-19 | §13 `CMP-result` §2.1 | `message` 有输出就填；空串仅表示无输出 | 与 `RD-04` 一致 | [x] |
| F-20 | §13 `CMP-result` §2.1 | `paused`/`lease_expired` 的 `retryable` 建议值 | 冻结为 `true` 或写理由 | [x] |

## 4. 计划与开放问题

| ID | 提案位置 | 目标 | 验收 | 状态 |
|---|---|---|---|---|
| F-21 | §15 Q8/Q9 | 关闭 OQ-006（结果上限）、OQ-010（租约 TTL） | 写入主文档 `limits`/租约表 | [x] |
| F-22 | §11/Q1、Q2 | 关闭 OQ-011（容量）、OQ-012（崩溃重派） | 写入架构 + `SCH-02`/`SCH-19` | [x] |
| F-23 | Q3/`RD-04` | 关闭 OQ-013（取消部分输出）、OQ-021（结果保留窗口） | 写明确认值或“M1 后仍开放” | [x] |
| F-24 | `ND-04` | OQ-023 `claimRequestId` 保留窗口写进实现说明 | 不改对外契约 | [x] |

## 5. 旧语义清零检查

M1 结束前对 `docs/design/` 全量 grep，以下必须为零或只在“被否决方案”上下文出现：

| 检查 | 期望 |
|---|---|
| `bindSession.lease` / `SessionBinding.*lease` | 0 处有效定义 |
| `claimedAt < issuedAt` | 0 处 |
| `run_superseded` 退 `2` | 0 处 |
| `message.*失败.*空串` / 失败恒 `""` | 0 处 |
| `C-05` 缺 `X-Client-Run-Id` | 0 处 |
| `SchedulerPort` 返回 `void` | 仅历史/差异说明，不作为现行签名 |

## 6. 完成定义

- 本清单所有 `[x]` 变为 `[x]` 或 `[-]`（附理由）；
- `bun run check` 通过；
- M1 `review.md` 四档评审签字；
- `docs/design/` 与主文档无未解释差异；
- `protocolVersion` 固定为冻结值。

## 7. 设计评审反馈（2026-11-07）

> 评审原文：`agent-flow-orchaster/docs/works/2026-11-07-client-architecture-review/review.md`。处置记录见 [`review.md`](review.md)。

| ID | 反馈 | 落点 | 状态 |
|---|---|---|---|
| `AB-01` | `heartbeat` 入参跨 CLI/executor/gateway 三个所有者 | 端口改 `heartbeat(ClientState, acks)`；`ackSeq`/`clientLease` 归 gateway；新增 `snapshotAttempts` | [x] |
| `AB-02` | `JournalPort` 三份签名 | executor §3.4 唯一定义；store §3.1 补 `pendingAll`/`listInstances`；架构改引用 | [x] |
| `AB-03` | 技能冲突两个 `code` | 统一 `asset_skill_set_conflict` | [x] |
| `AB-04` | 实例终结有两个主人 | 收进 `executor.reconcileCleanup`；CLI 只搬运/回执 | [x] |
| `AD-01` | `prompt_failed` 映射两类别 | 拆 `protocol_error` → `protocol`、`prompt_failed` → `runtime` | [x] |
| `AD-02` | 截断标记导致超上限 | 预留 15 字节标记；补边界用例 | [x] |
| `AD-03` | `<stateRoot>` 多写者 | 架构 §7 按 store/assets/observability 分区 | [x] |
| `AD-04` | `lockInstance` 无调用点 | CLI claim 后取锁、closed/abandoned 释放 | [x] |
| `AD-05` | `DSH_HOME` 归属三说 | CLI 创建、runtime 写入、`shutdownInstance` 删除 | [x] |
| `AH-01` | `--concurrency` 双容量源 | 删除 flag；只用 `capacity.maxInstances` | [x] |
| `AH-03` | phase 缺 `abandoned` | observability 补 | [x] |
| `AH-04` | 多 session 取消在 A 方案不可达 | 不变量 5/11 标 S2/B 生效 | [x] |
| `AH-05` | L1b 持传输类型 | `ports.ts` 分领域端口/共享值类型 | [x] |
| `AH-06` | 两套 HTTP 栈 | 共用 host/TLS/超时配置，S1 核对 | [x] |
| `AH-02` | `stateRoot` 默认系统目录 | 随 OQ-014，记录在 CLI §9 | [ ] |
| `AH-07` | 组件预算合计偏高 | S0 排任务按组件切 | [ ] |
| `AH-08` | 缺 UC→测试映射 | S0 开工前补 | [ ] |

### 第二轮复核新增

| ID | 反馈 | 落点 | 状态 |
|---|---|---|---|
| `NB-01` | 端口裁剪丢了 `assignments`/`assignmentsVersion` | `ClientState` 加版本；`HeartbeatOutcome` 加版本+快照；gateway 只透传 | [x] |
| `ND2-01` | `locked`/`corrupt`/journal `io_error` 无映射 | result §2.2 补 store/journal 行 | [x] |
| `ND2-02` | `shutdown` 事件路径的 pending 来源 | CLI 用事件字段合成，缺 `workspacePath` 回落 journal | [x] |
| `ND2-03` | `reconcileCleanup` 去重状态归属 | 标注进程内优化，正确性依赖幂等 | [x] |
| `ND2-04` | `CleanupReconciler` 未进内部骨架 | executor §2.8、architecture §4.4 补 | [x] |
| `ND2-05` | `snapshotAttempts` 与容量计数可能瞬时不一致 | 标注观测快照，允许偏差 | [x] |
| `ND2-06` | `CleanupAck.failed + retryable=false` 终止规则 | `OQ-025` 调度器 follow-up；契约加注 | [x] |
