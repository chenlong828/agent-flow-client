---
layer: works
module: global
status: active
updated: 2026-11-07
---

# 工序 Brief：M1 调度器契约冻结

> 类型：P1 契约冻结落盘（文档冻结，不写实现）。
> 输入：[`proposal.md`](../../history/works/2026-11-04-scheduler-contract-proposal/proposal.md) v0.4（审核通过、已归档）+ [`review.md`](../../history/works/2026-11-04-scheduler-contract-proposal/review.md) + 调度器侧评审原文。
> 输出：`docs/design/` 的契约真相、冻结清单、M1 结果/评审记录；不改代码、不建桩。

## 1. 背景

- 提案 v0.4 于 2026-11-07 审核通过；它现在只是历史记录，不是现行真相。
- 现行 `docs/design/` 仍停在冻结前：没有 `C-05`、`SchedulerPort` 仍返回 `void`/`ControlBatch`/`SkillSet`、没有 `SCH-19`/`SCH-20`、没有 `cleanupPending`、退出码没有 7、`bindSession` 仍带 `lease`。
- M1 的职责是把已经拍板的结论**原样搬进设计真相**，不是重新讨论；任何语义变更必须回到提案/评审，不能在本工序夹带。
- 冻结后 S1 才能按字段实现；S0 不依赖本工序，可并行。

## 2. 输入与已定决策

| 决策 | 冻结值 |
|---|---|
| Q1 容量/同实例并发 | A：实例数 + 同实例串行；`SCH-19` 等价锁定；选 B 须改条并升 `protocolVersion` |
| Q2 重跑 attempt | 新 `attemptId`；同 attemptId 只做传输重放 |
| Q3 迟到结果 | `409 late_result`，只审计 |
| Q5 claim | 长轮询 20s；`204` 可带 `Retry-After` |
| Q6 技能包 | 调度器托管端点；外链必须短期签名且不带 token |
| Q7 认证 | Bearer + TLS；轮换下一版 |
| Q8 租约 | 客户端 90s / 尝试 120s |
| Q9 结果上限 | 256 KiB；`limits` 下发 |
| Q10 pause | 立即取消，`reason=paused`，恢复后新 attempt |
| Q11 版本 | 日期 + 末位；兼容窗口 2 minor |
| Q12 旧 run | 停领 + 取消活跃（`superseded`） |
| Q13–Q20 | 按提案 §15 建议；`claimRequestId`、`SCH-19`、run 作用域、C-04 分档、共享 `AuthProvider`、退出 7、`message` 有输出就填、删除 `bindSession.lease` |

冻结版本已定为 **`2026-11-07.1`**；此后字段名/枚举/错误码变更按 §12 的兼容规则处理。

## 3. 范围

**做：**

- 新建字段级契约主文档，作为跨组件唯一权威；
- 更新 `architecture.md` 的接口面、退出码、依赖边、数据所有权、主流程；
- 更新 `CMP-executor` / `CMP-gateway` / `CMP-cli` / `CMP-result` / `CMP-assets` 规格；
- 关闭相关 OQ，更新 roadmap/risks；
- 出冻结清单与 M1 评审记录。

**不做：**

- 不写任何实现代码、不建桩调度器、不建契约测试代码（S1 做）；
- 不处理观测 HTTP P1（独立工序）；
- 不重新裁决 Q1–Q20；
- 不改 `CMP-observability`（本契约不涉及）。

## 4. 产出

| 产出 | 位置 | 说明 |
|---|---|---|
| 契约主文档 | `docs/design/contracts/executor-http-v1.md`（新建） | 端点、字段、枚举、错误码、幂等、租约、`SCH`/`CLT`；跨组件唯一权威 |
| 架构更新 | `docs/design/architecture.md` | §3.1/§3.2/§4.3/§6/§10 等；只链接主文档，不复述字段 |
| 组件更新 | `docs/design/components/<id>/spec.md` | 只写本组件的端口/消费/失败收口，字段链接主文档 |
| 冻结清单 | `freeze-checklist.md`（本目录） | 提案 §13 每一行 → 目标章节 → 状态 |
| 结果/评审 | `result.md`、`review.md`（本目录） | 冻结结论、设计评审处置（AB/AD/AH）、签字 |
| 计划收口 | `docs/plan/open-questions.md`、`roadmap.md`、`risks.md` | 关闭 OQ-006/010/011/012/013 等，记录 M1 完成 |

## 5. 任务表

| ID | 任务 | 对象 | 产出 | 依赖 | 装载清单 | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| T1 | 建冻结基线：确认 `protocolVersion`、把提案 §13 拆成逐行清单 | 本工序 | `freeze-checklist.md` | 提案 v0.4 | 提案 §13、review、本 brief | 每行有目标文档/章节/负责人 | 完成 |
| T2 | 写契约主文档：C-01…C-07、通用约定、错误码、`SCH-01…20`、`CLT-01…13`、七个请求/响应样例 | `design/contracts` | `executor-http-v1.md` | T1 | 本 brief §2、提案 §4–§8 | 七个端点字段齐全；枚举/错误码闭集；无“待定” | 完成 |
| T3 | 更新 `architecture.md`：交互面、退出码 7、run 作用域、`cleanupPending`、依赖边、数据所有权 | `architecture.md` | §3.1/§3.2/§4.3/§6/§10 | T2 | T2 主文档、`architecture.md` | 与主文档无矛盾；只引用不复述 | 完成 |
| T4 | 更新 `CMP-executor`：`SchedulerPort` 返回类型、`NodeRequest`、`JournalPort`、`CleanupPending`/`CleanupAck`、`AuthProvider` 定义位置 | `CMP-executor` | §3.4/§3.5 | T2 | T2、`CMP-executor` §3 | 端口签名与主文档一致；无 HTTP 类型泄漏 | 完成 |
| T5 | 更新 `CMP-gateway`：HTTP 端点、长轮询、`claimRequestId`、错误表、run 作用域、`issuedAt <=`、`cleanupAcks` | `CMP-gateway` | §2/§3.3 | T2/T4 | T2、`CMP-gateway` §2–§3 | 每个错误码有映射；新 run 丢事件有例外说明 | 完成 |
| T6 | 更新 `CMP-cli`：`serve` 循环、清理对账、`ackSeq` 空洞、退出 7 | `CMP-cli` | §2.4/§2.8 | T2/T5 | T2、`CMP-cli` §2.4/§2.8、提案 §9.3 | 循环顺序与 §9.3 恢复一致；退出码与架构一致 | 完成 |
| T7 | 更新 `CMP-result`：`message`、错误映射、`retryable` | `CMP-result` | §2.1/§2.2 | T2 | T2、`CMP-result` §2 | 有输出就填；`late_result`/`invalid_session` 映射 | 完成 |
| T8 | 更新 `CMP-assets`：`C-05`、304、跨 host 不带 token、共享凭据 | `CMP-assets` | §1/§3 | T2/T4 | T2、`CMP-assets` §1/§3 | 不 import gateway；凭据单一来源 | 完成 |
| T9 | 跨文档一致性 + OQ/计划收口：关闭 OQ-006/010/011/012/013，OQ-021 记账，记录 OQ-023 | `plan/` | OQ/roadmap/risks 更新 | T3–T8 | T3–T8、`plan/open-questions.md` | 无旧语义残留；OQ 状态可追溯 | 完成 |
| T10 | 冻结评审：四档记录、人工签字、`bun run check`、归档本工序 | 本工序 | `review.md`/`result.md` | T1–T9 | 全量 + `freeze-checklist.md` | 第二轮通过；NB-01/ND2-01/02 已补，待归档 | 进行中 |

> 任务按文档边界拆，不按“字段批次”拆；同一事实只写在主文档，组件规格链接过去，避免两套真相。

## 6. 验收标准

- `freeze-checklist.md` 中提案 §13 的每一行都有“目标章节 + 状态”，没有跳过项。
- `docs/design/contracts/executor-http-v1.md` 覆盖：
  - `C-01`…`C-07` 的请求/响应/错误/幂等/调用时机；
  - `SCH-01`…`SCH-20`、`CLT-01`…`CLT-13`；
  - 三个身份、两条租约、`run_superseded`、`cleanupPending`；
  - 错误码闭集与 `ErrorClass`/`CancelReason` 闭集。
- 旧语义 grep 清零：`bindSession.lease`、`claimedAt < issuedAt`、`run_superseded` 退 2、`message` 失败恒空。
- `architecture.md` 与组件规格不再互相矛盾；组件规格不复制主文档字段表。
- `bun run check` 通过。
- 调度器侧确认冻结版本与字段名；M1 `review.md` 签字。

## 7. 风险

| 风险 | 处理 |
|---|---|
| 两套真相：主文档与组件规格各写一份字段 | 主文档为唯一权威；组件只写端口/消费/失败，字段用链接 |
| 旧语义残留 | T9 做 grep 清单，逐条销账 |
| 冻结夹带新决策 | 任何语义变更退回提案/评审；M1 只落已拍板内容 |
| `SCH-19` 与未来 Q1=B 冲突 | 主文档保留“选 B 须改条 + 升 `protocolVersion`”一句 |
| 观测 HTTP 抢跑 | 明确不在本工序；等独立 P1 回填 |
| 上游尚未实现 | 冻结文档先于联调；S1 桩按主文档写 |

## 8. 交接

- **S1**：以 `executor-http-v1.md` + 组件规格为输入，写 `CMP-gateway` 契约测试与桩调度器。
- **S0**：不依赖 M1，继续本地执行闭环。
- **观测 HTTP**：独立工序 `2026-11-06-observability-http`，不并入 M1。
