---
layer: works
module: global
status: active
updated: 2026-11-04
---

# 工序结果：调度器契约提案（client 消费端）

> 状态：**提案已交付，待调度器侧与 client 侧评审**。契约未冻结，`design/` 未改；冻结后另立 M1 工序。

## 结论摘要

- 调度器对 client 的接口面收敛为 **6 个控制面操作 + 1 个制品通道**：`register`、`heartbeat`（长轮询兼控制事件）、`claim`、`renew`、`bindSession`、`reportResult`，以及技能包下载。
- client 侧需要调度器保证 18 条语义（`SCH-01`…`SCH-18`），client 承诺 12 条（`CLT-01`…`CLT-12`）；其中 6 条是 S1 的硬前提：实例粘性、单派发、attempt 身份、容器预置、技能集确定性、两条租约。
- 三个身份（`clientId` / `runId` / `attemptId`）与两条租约（客户端租约 / 尝试租约）是契约的骨架；attempt 归属按 `(clientId, attemptId)`，不按 `runId`，否则崩溃重启后的已结算结果永远报不上去。
- 与现行文档的差异集中在：新增技能包下载面、`NodeRequest` 去掉 `skillSet`（S1 由 `bindSession` 返回）、`SchedulerPort` 的 `register`/`heartbeat`/`bindSession` 返回类型扩展（否则承载不了租约/限制/assignments）、网关错误表新增 `invalid_session` / `run_superseded`。
- 另识别一处客户端内部变更：若调度器不下发 `assignments`，`JournalPort` 需补 `listInstances()` / `pendingAll()` 才能枚举恢复对象（P2，不动调度器契约）。
- 12 项待裁决中 6 项阻塞 S1：容量与同实例并发（Q1）、重跑 attempt 身份（Q2）、迟到结果表达（Q3）、claim 长轮询（Q5）、技能包通道（Q6）、认证方式（Q7）。

## 1. 验收对照

| 验收标准（brief §3） | 落点 | 状态 |
|---|---|---|
| 7 个契约面的端点、字段、状态码、错误码、幂等键、超时/重试、调用时机 | `proposal.md` §2.1、§5.1–§5.7 | 完成 |
| 每个契约面标明消费组件、端口方法、状态与失败收口 | `proposal.md` §3、§9.1 | 完成 |
| 调度器责任 `SCH-*` 与客户端承诺 `CLT-*`，含违反后果 | `proposal.md` §7、§8 | 完成 |
| 字段级值类型与枚举闭集 | `proposal.md` §6 | 完成 |
| 失败与边界矩阵 | `proposal.md` §10 | 完成 |
| 与现行文档的差异，逐条标类型 | `proposal.md` §13 | 完成 |
| 待裁决问题、推荐默认值、阻塞阶段 | `proposal.md` §15 | 完成 |
| 不改 `design/`、不改组件状态 | 本工序只新增 `docs/works/` 与导航/OQ 登记 | 完成 |

## 2. 结论落点

| 结论 | 当前落点 | 确认后去向 |
|---|---|---|
| 7 个契约面与字段级草案 | `proposal.md` §5–§6 | M1 冻结；字段进 `design/architecture.md` §3.1 或独立契约文档 |
| 调度器责任 `SCH-01`…`SCH-18` | `proposal.md` §7 | 进 `architecture.md` §3.1/§10 与 `CMP-gateway` 规格 |
| 客户端承诺 `CLT-01`…`CLT-12` | `proposal.md` §8 | 与 `architecture.md` §6 不变量对齐 |
| 执行器承接与状态映射 | `proposal.md` §9 | 回填 `CMP-executor` §2.4/§3.4、`CMP-cli` §2.4、`CMP-gateway` §3 |
| 与现行文档的差异 | `proposal.md` §13 | 按 P 级逐条改；契约变更按 P1/P2 走 |
| 12 项待裁决 | `proposal.md` §15 | 调度器侧裁决；关闭 `OQ-006/010/011/012/013` 与新增 `OQ-016…020` |
| 联调与验收建议 | `proposal.md` §14 | S1 桩调度器与契约测试的任务输入 |

## 3. 未决与风险

| 项 | 风险 | 处理 |
|---|---|---|
| Q1 容量/同实例并发 | 选了 B/C 会改动 `cancelInstance` 的粒度与容量字段；S1 选 A 但调度器若并发派发会「有容量领不走」 | 调度器侧先确认派发策略 |
| Q2 attempt 身份 | 复用 attemptId 会让 client 去重逻辑把重跑当成重复执行 | 建议写死「重跑新 attemptId」 |
| Q3 迟到结果 | 若调度器把 late 当 200 接受并覆盖，会丢新尝试结果 | 保持 409 + 只审计；client 不重试 |
| Q4 assignments | 不提供时 client 只能靠 journal 恢复；容器清理可能滞后 | 先按可选实现，S2 再评估 |
| Q6 技能包通道 | 跨 host 带 token 会泄漏凭据；签名 URL 过期会让长任务下载失败 | 托管端点优先；外链短期签名 + 不带 token |
| Q12 `run_superseded` 退出码 | 新增退出码是 CLI 契约变更 | 暂用 2，M1 确认 |
| 上游现状 | 调度器仓库还没有这组端点，联调需先建桩 | S1 桩调度器与 client 并行开发 |

## 4. 请求评审

请调度器侧重点裁决：

1. §5 的端点路径与字段是否可接受；字段名可改，语义按 §7 保。
2. §11 的容量与同实例并发：S1 是否承诺「同一实例同一时刻只派一个节点」。
3. §15 的 Q2/Q3/Q5/Q6/Q7：这 5 项决定 client 的租约、幂等、下载与鉴权实现。
4. `run_superseded` 的 fencing 语义是否由调度器承担；若由 client 自行检测重复进程，契约可去掉。

client 侧重点确认：

1. `SCH-11`（按 clientId 重报）是否需要在 `CMP-gateway` 增加「重报模式」标记，还是仅靠 `attemptId` 即可。
2. `C-06` 租约过期映射到 `cancelInstance` 是否足够；若 Q1 选 B，需要新增按 attempt 取消的端口。
3. `C-07` 的 `400`/`413` 兜底（不重试、保留 journal、告警）是否可接受。

## 5. 下一步

1. 调度器侧评审本稿，逐项回复 §15。
2. 双方确认后开 M1 冻结工序：把字段/错误码/枚举写进 `design/`，同步 `architecture.md`、`CMP-executor`、`CMP-gateway`、`CMP-cli`、`CMP-assets`、`CMP-result`。
3. S1 实现顺序建议：桩调度器 → `CMP-gateway` 契约测试 → `CMP-cli` 循环 → `CMP-executor` 绑定/上报 → `CMP-assets` 下载。
