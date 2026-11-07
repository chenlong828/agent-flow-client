---
layer: works
module: global
status: active
updated: 2026-11-05
---

# 工序 Brief：调度器契约提案（client 消费端）

> 类型：接口契约提案（P1，契约层）。只产出提案，不写实现代码、不冻结契约。
> 目标：把「当前 9 个 `planned` 组件需要调度器提供什么」收敛成一份字段级 HTTP 契约提案，供调度器侧与 client 侧共同裁决 M1 字段与语义。

## 1. 背景

- client 侧 9 个组件规格已建，状态均为 `planned`；`CMP-executor` §3.4 定义了 `SchedulerPort` 的 6 个方法，但只到端口签名，HTTP 端点、字段、状态码、错误码与调度器侧责任尚未冻结。
- client 的运行形态是 CLI `serve` 启动的常驻后台执行进程；`run` 是单次模式。本工序只约束 `serve` 的跨进程契约。
- 上游 `agent-flow-orchaster` 目前只有面向人的 `/api/v1` REST 面，没有面向执行客户端的租约/长轮询端点；`docs/works/2026-11-03-client-boundary/boundary-design.md` 明确要求「契约先行，两侧分别开发；字段级契约另立接口设计」。
- 若直接按端口名实现，双方会在「租约续谁、claim 怎么唤醒、重跑换不换 attemptId、迟到结果算不算错误、技能包从哪下载」这些语义上各自补洞，最后只能靠联调对齐。本工序先把这些洞显式化。

## 2. 问题

1. client 的 6 个控制面操作 + 技能包下载，需要调度器提供哪些 HTTP 端点、请求/响应字段、状态码与稳定错误码？
2. 哪些语义必须由调度器保证（实例粘性、attempt 身份、容器预置、技能集确定性、租约、控制事件顺序、幂等、迟到结果、恢复、版本、鉴权）？违反时 client 会怎样？
3. 每个操作由哪个组件、在什么状态、经哪个端口消费？失败时如何收口、落哪条 journal、是否重试？
4. 当前组件规格与提案有哪些差异？哪些是 M1 必须裁决的开放问题？

## 3. 验收标准

- 给出 `C-01`…`C-07` 七个契约面的端点、方法、请求/响应字段、状态码、错误码、幂等键、超时/重试与调用时机。
- 每个契约面标明消费组件、端口方法、对应尝试状态与失败收口方式。
- 给出调度器侧责任清单（`SCH-*`）与客户端承诺清单（`CLT-*`），每条说明违反后果。
- 给出字段级值类型与枚举闭集：`NodeRequest`、`NodeResult`、`SkillSet`、`Lease`、`ControlBatch`、`Ack`、`ErrorClass`、`CancelReason`。
- 覆盖失败与边界矩阵：断网、崩溃、重复投递、租约过期、迟到结果、版本/鉴权、暂停/取消/关闭、超大结果、时钟偏差。
- 列出与 `architecture.md`、`CMP-executor`、`CMP-gateway`、`CMP-cli`、`CMP-assets`、`CMP-result` 现行规格的差异，逐条标明「提案变更 / 待裁决 / 不改」。
- 列出待调度器侧裁决的问题、推荐默认值与阻塞阶段；阻塞 S1 的问题单独标出。
- 不修改 `design/` 下的现行真相；不把组件从 `planned` 改 `active`。

## 4. 非目标

- 不做端点实现、不写桩调度器代码（联调桩在 S1 落地）。
- 不重开组件切分、端口归属与主流程（2026-11-03 已确认的 D1–D12）。
- 不定义调度器内部如何存储、如何选节点、如何解析结果。
- 不定义凭据发放流程、部署拓扑、监控后端。
- 不覆盖进度事件、产物上传、会话全文回传、UI。

## 5. 任务表

| ID | 类型 | 内容 | 组件/对象 | 状态 | 装载清单 |
|---|---|---|---|---|---|
| T1 | 盘点 | 从 9 份组件规格与架构文档提取对调度器的依赖面、调用点与失败语义 | `CMP-cli`、`CMP-executor`、`CMP-gateway`、`CMP-assets`、`CMP-result`、`CMP-store` | 完成 | `docs/design/architecture.md`、`docs/design/components/*/spec.md`、`SCN-0001`、`REQ-0002` |
| T2 | 设计 | 起草 7 个契约面的 HTTP 形状：端点、字段、状态码、错误码、幂等、长轮询、租约 | 调度器契约面 | 完成 | T1 产出、上游 `boundary-design.md`、`CMP-http-gateway` §2–§3 |
| T3 | 设计 | 写调度器责任（`SCH-*`）与客户端承诺（`CLT-*`），逐条给违反后果 | 双侧职责 | 完成 | T2 产出、`architecture.md` §6 不变量、`REQ-0002` R-01…R-10 |
| T4 | 设计 | 映射到执行器承接：端口方法、状态机迁移、journal 落点、重试与退出码 | `CMP-executor`、`CMP-cli`、`CMP-gateway` | 完成 | T2/T3 产出、`CMP-executor` §2.2–§2.7、`CMP-cli` §2.4 |
| T5 | 核对 | 与现行文档逐条 diff，标出提案变更/待裁决/不改；核对与上游 REST 约定的冲突 | 文档一致性 | 完成 | T2/T3/T4 产出、`docs/design/**`、上游 `http-gateway/spec.md` |
| T6 | 交付 | 汇总待裁决问题与推荐默认值，交调度器侧评审 | 双侧评审 | 完成（两轮评审已处置；v0.4 待调度器收口） | T5 产出、`plan/open-questions.md` |

## 6. 领取的开放问题

| ID | 与本工序的关系 | 本工序的处理 |
|---|---|---|
| OQ-006 | 结果大小上限 | 提案给默认 256 KiB，写入 `register.limits`；待 M1 确认 |
| OQ-010 | 租约 TTL 与心跳超时 | 提案拆成「客户端租约」与「尝试租约」两条，默认 90s / 120s |
| OQ-011 | 容量单位（实例数 or session 数） | 提案 §11 给三个候选，推荐 S1 先按「实例数 + 同实例串行」 |
| OQ-012 | 崩溃后重派是否复用 attemptId | 提案建议「重跑必须新 attemptId」，同 attemptId 只做传输重放 |
| OQ-013 | 取消/超时是否带部分输出 | 提案维持不带；`NodeResult.message` 有输出就填，空串仅表示确实没有输出（`RD-04`） |
| OQ-016…021 | 本工序新识别：迟到结果表达、assignments、技能包通道、claim 长轮询、认证与 fencing、结果保留窗口 | 提案 §15 给推荐默认值，并登记到 `plan/open-questions.md` |

## 7. 环境与边界

| 项 | 值 / 做法 |
|---|---|
| 代码改动 | 无；只改文档 |
| 现行真相 | `docs/design/` 不动；提案不是设计依据，确认后另立 M1 冻结工序 |
| 上游依据 | `../../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`、同目录 `client-work.md`、`../../../../agent-flow-orchaster/docs/design/components/http-gateway/spec.md` |
| 校验 | `bun run docs:check`；人工核对 frontmatter 与导航 |
| 评审门 | 调度器侧确认端点与语义；client 侧确认承接与退出码；P1 冻结后进 `design/` |

## 8. 产出

- `proposal.md`：契约提案正文（本工序主产物，v0.4）。
- `result.md`：验收对照、结论落点与未决项。
- `review.md`：调度器评审结论与 client 四档裁决（P1 评审记录）。
- `docs/README.md` 工序导航与 `docs/plan/open-questions.md` 的 OQ-016…021 登记。
