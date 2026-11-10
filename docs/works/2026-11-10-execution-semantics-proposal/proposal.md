---
layer: works
module: global
status: active
updated: 2026-11-10
---

# 提议：Agent 执行任务的容错语义与卡死处理

> 提交对象：调度器团队（契约权威侧）。
>
> 结论先行：**client 不追求 exactly-once**；要守的是「同一容器同一时刻只有一个活跃写入者」+「卡死有界终止」+「工作区默认保留」。v1 契约主体不需要改；只有 1–2 个可选加法字段需要评审决定。请重点看 §9 的 Q1–Q8。

## 0. 一页结论

| 议题 | 提议 |
|---|---|
| 执行语义 | at-most-one active writer per container；允许同一节点顺序重试；不承诺 exactly-once |
| 失败处理 | 中断/超时/取消后，工作区产物保留；重派用新 `attemptId`；agent 自行决定续跑或重跑 |
| 卡死 | 总超时（`NodeRequest.timeoutMs`）+ 客户端“无进度”看门狗；到点 cancel → 关 session → SIGKILL 进程组；回报 `timeout` + 已有部分输出 |
| 重试归属 | 调度器决定是否重试、次数与退避；client 不自动重跑 |
| 并发 | v1 维持 A（同实例单活跃 attempt）；B 的 fan-out 真并发不在本提议内，但“单写者”仍是 B 的前提 |
| 契约 | 主体不变；可选新增 `idleTimeoutMs`（加法、默认关闭）；`NodeResult.error.reason` 按现有契约补齐，不算新字段 |
| 关键前提 | client 必须补 `C-06` 续租、进程确认死亡前不释放实例、孤儿/初始化失败清理；否则“单写者”和“有界占用”不成立 |

## 1. 背景：为什么按 Agent 任务重排优先级

client 跑的是智能体分析任务，不是交易类强一致任务：

- 节点执行中会持续把中间分析、检索结果、草稿写入工作区；
- 中断后重跑，agent 能读到这些痕迹，自行判断继续、补齐还是重来；
- 因此“同一节点执行两次”通常只是浪费 token/时间，不是数据灾难；
- 真正的风险是**两个进程同时写同一容器**：交错写入会让“上次痕迹”本身变脏，重跑基于坏中间态做出错误判断；
- 其次是**卡死无限占容量**：一个 hung session 占住实例，后续节点排队。

现行讨论中把“重复执行”和“卡死”按强一致系统定级，导致优先级偏高。本提议按上述业务模型重排。

## 2. 提议的执行语义

### 2.1 四条不变式

1. **单写者**：同一 `(instanceId, workspacePath)` 同一时刻至多一个活跃 attempt；由调度器 `SCH-19` 与 client 实例锁共同保证。
2. **可重试**：同一节点失败/超时/取消后，允许调度器用**新 `attemptId`** 重派；同 `attemptId` 只做传输重放（`SCH-03`、`OQ-012`）。
3. **产物保留**：中断后不清理预置仓库与分析产物；client 默认 `cleanup=keep`，只在调度器显式要求时清理技能/客户端临时文件。
4. **有界占用**：任何 attempt 都必须有一个客户端可执行的终止上界，不依赖 DSH 自行返回。

### 2.2 不承诺什么

- 不承诺 exactly-once；
- 不承诺崩溃后自动续跑（client 不自动重跑，等调度器重派）；
- 不承诺 DSH 内部死锁可被“检测”；只承诺有界终止 + 可重试；
- 不承诺同容器并发写安全（B 方案需另行设计仓库级冲突策略）。

## 3. 卡死与超时模型

### 3.1 三层时间边界

| 边界 | 归属 | 行为 |
|---|---|---|
| `NodeRequest.timeoutMs`（总超时） | 调度器下发，client 强制执行 | 到期：`session/cancel` → 关 session → SIGKILL 进程组；结果 `timeout`，`retryable=true`，`message` 保留已产生输出 |
| 无进度看门狗（idle timeout） | client 本地默认（建议 10 分钟，可配；可选下发） | 连续 N 分钟没有 ACP `session/update`（文本/tool/usage）才触发，避免误杀“静默思考” |
| 调度器硬上限/人工取消 | 调度器 | 控制事件 `cancel` → client 立即 cancel/close/kill，结果 `cancelled(user_cancel)` |

### 3.2 为什么需要 idle 而不只是总超时

- Agent 可能长时间无文本输出（检索、推理、工具等待），但仍在工作；
- 总超时只能按节点类型给一个保守大值，无法区分“安静”和“卡死”；
- idle 只在 ACP 完全无事件时触发，误杀率低于纯总超时；
- 两者叠加：总超时兜底，idle 更早释放容量。

### 3.3 终止顺序（固定）

```
停止计时 → 标记 timedOut → session/cancel（通知）
        → session/close（限时）→ kill(-pgid) SIGKILL
        → 等待进程组退出（限时）→ 结果 timeout（含部分输出）
        → journal settled/reported/closed
```

若进程组在限时内未确认退出：记录孤儿、**该实例保持不可用**，不再接受新 attempt，直到清理/重启（见 §5 Q5）。

## 4. 现状与差距

### 4.1 已具备

- 每实例 DSH 进程、每 attempt 独立 session；A 下同实例串行；
- prompt 总超时、cancel/close/SIGKILL 进程组；
- 部分输出累积并在 `timeout` 结果中返回；
- 实例锁、journal 恢复、`settled` 重报、孤儿记录；
- 心跳与执行分离，prompt 卡死不影响心跳。

### 4.2 需要补的 client 侧缺口

| 缺口 | 影响 | 优先级 |
|---|---|---|
| `C-06` 续租未接线 | 长任务租约先过期，调度器可能误判并重派，造成并发重叠 | **高** |
| 进程未确认死亡就释放实例锁 | 旧进程仍是写入者，新 attempt 可能并发写 | **高** |
| `initialize` 卡死时未 kill/未记录 | 进程泄漏，重启后可能与新进程并发写 | 高 |
| 普通 `session/close` 超时不杀进程组 | session/进程资源泄漏 | 中 |
| `NodeResult.error.reason` 未填 | 调度器无法区分超时/取消原因 | 中 |
| 无 idle 看门狗 | 只能靠总超时，容量释放慢 | 中 |
| 客户端事件循环卡死无 watchdog | 只能靠租约过期重派 | 低（极少见） |

### 4.3 与现行契约的关系

- 上述主体语义 **v1 已允许**：重派新 attemptId、`timeout` 可重试、`late_result`、`cleanupPending` 都与本提议一致；
- 本提议不修改 A 方案与 `SCH-19`；
- 唯一可选的契约加法是 `idleTimeoutMs`（见 §6），不加也能靠 client 配置实现。

## 5. 双方职责

### 5.1 调度器

1. 只在旧 attempt **终态或租约过期**后重派；不因心跳短暂断开立即重派（`SCH-02`/`SCH-07`）。
2. 重派必须新 `attemptId`、`attemptNo+1`；是否在 prompt 中要求“先检查工作区已有产物再决定续跑”由编排决定。
3. 决定重试次数/退避；`timeout` 的 `retryable=true` 只是提示。
4. 需要硬性终止时发 `cancel`；client 会在心跳周期内响应。
5. 实例释放/清理继续走 `cleanupPending`；默认 `keep`。
6. 若 client 报告实例因进程未回收而不可用，调度器应把该实例视为待清理，不再派发（Q5）。

### 5.2 客户端

1. 每个活跃 attempt 按 TTL/3 调 `C-06` 续租。
2. 总超时 + idle 看门狗；到点按 §3.3 终止。
3. 进程未确认退出时保留实例锁/标记不可用，记录孤儿；启动时清理。
4. `NodeResult.error.reason` 按契约填 `prompt_timeout` / `user_cancel` 等。
5. 默认保留工作区产物；不做仓库级并发锁。
6. 不自动重跑；恢复时只重报已 `settled` 的结果。

## 6. 契约影响（需评审）

### 6.1 不变更

- `SCH-19`、`SCH-02`、`SCH-03`、`SCH-11`、`SCH-16`、`C-06`、`C-07` 均按现状使用。
- `NodeResult.error.reason` 已在 §6.5 定义，client 补齐即可。

### 6.2 可选加法（推荐只做第一项）

| 字段 | 位置 | 类型 | 默认 | 用途 |
|---|---|---|---|---|
| `idleTimeoutMs` | `NodeRequest`（可选） | integer ≥0，0=关闭 | 缺省用 client 配置 | 调度器按节点类型控制“无进度”阈值 |
| `lastEventAt` | 心跳 `state.activeAttempts[]`（可选） | ISO-8601 | 无 | 调度器观测 attempt 最近活动，辅助判断是否真卡死 |

- 两者都是加法、可忽略；若调度器不接受，client 用本地配置实现 idle，不影响本提议主体。
- 若接受，按契约规则 `protocolVersion` 末位递增（如 `2026-11-07.2`），不升主日期。

## 7. 失败矩阵

| 场景 | 检测方 | client 行为 | 调度器行为 | 数据风险 |
|---|---|---|---|---|
| 客户端进程崩溃 | 租约到期 | 重启后清孤儿、重报 settled、未结算标 abandoned | 租约过期后新 attempt 重派 | 低：顺序重跑，产物保留 |
| 网络分区但进程活着 | 租约/续租失败 | 继续执行直到总超时；能恢复则继续 | 租约过期才重派；可能短暂重叠 | 中：靠实例锁/粘性避免同 client 重叠 |
| prompt 卡死但进程活着 | idle/总超时 | cancel+close+SIGKILL；回报 timeout+部分输出 | 按策略决定是否重派 | 低：旧进程被终止 |
| `initialize` 卡死 | 10s 超时 | kill 进程组、记录孤儿、实例失败 | 视错误类别重派/换实例 | 低 |
| 进程 SIGKILL 后仍不退出（D 状态） | `waitExit` 超时 | 保留实例不可用、记录孤儿 | 不派该实例，等待清理/重启 | 中高：需避免并发写 |
| 工具子进程逃逸进程组 | 残留检查 | 启动时 reap；记录孤儿 | 可换实例重派 | 低到中：需重启清理 |
| 客户端事件循环卡死 | 租约到期 | 无法动作 | 租约过期重派；旧进程可能残留 | 中：靠重启清理 |
| 调度器误判重派同实例 | client 锁 | 拒绝执行，报 failed(workspace) | 修正派发/清理 | 低：不并发写 |

## 8. 验证计划（评审通过后执行）

### 8.1 client 单测/集成

1. **续租**：TTL/3 触发 `renew`；stub 记录；租约有效期内调度器不重派。
2. **idle**：无事件 X 分钟触发 timeout；持续有 `session/update` 时不触发；总超时仍独立生效。
3. **部分输出**：kill 后 `NodeResult.message` 保留已累积文本；`reason=prompt_timeout`。
4. **进程未死**：注入 `waitExit=false`，实例保持不可用，第二个 attempt 被拒；孤儿记录存在。
5. **initialize 失败**：子进程被 kill，无未记录残留。
6. **删除/清理**：默认 keep 不改仓库产物；`clean-skills` 只清 `.dsh` 技能。
7. **恢复**：settled 重报、未结算 abandoned、新 attempt 正常执行。

### 8.2 桩调度器 / 契约

1. 旧 attempt 租约未过期时不重派；过期后新 attemptId 重派。
2. 旧 attempt 迟到结果 → `late_result`，不覆盖新结果。
3. client 报告实例不可用后，调度器不再派发（Q5 确认后）。
4. `idleTimeoutMs` 缺省/下发两种路径。

### 8.3 真实 DSH

- 长思考但持续有 usage/thought：idle 不误杀，总超时兜底；
- 真实工具卡死（如 `sleep` 不返回）：到 idle/总超时后进程组回收、无残留；
- 中断后重跑：工作区痕迹保留，agent 能识别并继续；
- 资源：连续 timeout/重派后无 DSH 进程累积。

### 8.4 验收标准

- 任意时刻同一容器无两个活跃写入者；
- 任意 attempt 在“总超时 + 余量”内终止并回报；
- 进程未确认退出时不会开启同容器新 attempt；
- 重派后工作区产物与技能集一致；
- 全程无未记录孤儿进程。

## 9. 给调度层的评审问题

| ID | 问题 | 建议 | 阻塞 |
|---|---|---|---|
| Q1 | 是否接受“不承诺 exactly-once；允许同节点顺序重试；同容器单写者”作为执行语义？ | 接受；写入契约说明/调度器重试策略文档 | 是 |
| Q2 | `timeout` 结果是否自动重派？次数/退避/是否要求 prompt 带“先检查已有产物”？ | 调度器决定；建议新 attemptId + 退避；prompt 续跑提示由编排加 | 是 |
| Q3 | 总超时由谁定、分析类节点典型值？ | `NodeRequest.timeoutMs` 按节点类型给（如 30–60min）；client 强制执行 | 是 |
| Q4 | 是否新增可选 `idleTimeoutMs`（及 `lastEventAt`）？ | 只加 `idleTimeoutMs`；不加则 client 配置默认 10min | 否 |
| Q5 | client 报告“实例因进程未回收而不可用”时，调度器是否停派并转清理？ | 是；该实例进入待清理，不再派发 | 是 |
| Q6 | 实例释放清理默认 `keep` 是否确认？ | 确认；分析产物必须保留 | 否 |
| Q7 | 服务端是否对“持续续租但长时间 running”的 attempt 设硬上限并主动 cancel？ | 由 Q3 的 timeoutMs 决定，服务端不额外加更短硬上限 | 否 |
| Q8 | B 方案（fan-out 真并发）时间点；单写者是否仍为 B 的前提？ | B 另立 P1；单写者仍是前提，B 需仓库级冲突策略 | 否 |

## 10. 实施顺序（评审通过后）

1. **client 高优先**：续租、进程未死保锁、initialize 清理、`reason` 补齐。
2. **client 中优先**：idle 看门狗、`closeSession` 超时杀组、孤儿即时探活。
3. **调度器**：重试策略、Q4 字段（若接受）、Q5 停派语义。
4. **验证**：§8 的 client + 桩 + 真实 DSH 门禁。
5. **契约**：仅在 Q4 接受时做加法并升末位版本；否则不动契约。

## 11. 附：相关条款与实现

- 契约：`docs/design/contracts/executor-http-v1.md` §5.3（claim/timeout）、§5.6（renew）、§5.7（result/late）、§11（A/B）、`SCH-02/03/07/11/16/19`
- 实现：`src/components/cli/serve-loops.ts`、`serve-events.ts`、`src/components/executor/executor.ts`、`src/components/runtime/runtime.ts`、`src/components/gateway/gateway.ts`
- 历史：`docs/history/works/2026-11-08-s1-contract-skeleton/result.md`、`docs/history/works/2026-11-09-s2-linear-and-recovery/result.md`
