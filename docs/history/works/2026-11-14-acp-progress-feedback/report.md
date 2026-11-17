---
layer: works
module: global
status: frozen
updated: 2026-11-14
---

# 调研报告：任务执行过程的信息反馈（ACP 侧）

> 对应工序：[`brief.md`](brief.md)。本轮只调研，不改代码、不改契约。
> 结论一句话：**不是 ACP 不推过程信息，而是 client 收到后把过程信息全部留在本机——跨边界只报"开始"和"结束"**。ACP 在工具调用级别是实时的，client 有能力展示比现在多得多的信息，瓶颈在契约面与展示面。

## 0. 结论摘要

| # | 结论 | 证据 |
|---|---|---|
| 1 | 执行期跨边界只有两个信号：`poll` 里的 `running[]`（`taskId`/`instanceId`/`startedAt`）与结束时的 `P-04` 日志 + `P-02` 结果 | `serve-context.ts` 45–62、`serve-loops.ts` 153–190 |
| 2 | 契约本来就留了 `running[].lastEventAt`（可选，供调度器观测"在动"），但 **client 从未发送**；调度器解析后也没有存储/暴露 | 契约 §4.1/§5；`serve-context.ts` 46–50；调度器 `executor-request.ts` 49–55 |
| 3 | ACP 侧 DSH 会推 6 类 `session/update`；其中 `tool_call`（调用开始，含工具名与参数）和 `tool_call_update`（完成/失败，含输出）是**实时**的，真机实测 0.54s 与 4.48s 到达 | `packages/acp/acp/src/updates.ts`；[实测时间线](#34-真机实测时间线) |
| 4 | 但 DSH 只推"已提交"的语义事件：文本按消息整块到达，不按 token 流；不发 `plan`、`available_commands_update`、`current_mode_update` 等；工具执行中途也没有中间 update | `session.ts` 320–360；SDK schema `SessionUpdate` |
| 5 | client 只消费 `agent_message_chunk` / `usage_update` / `tool_call*` 三类，且 `tool_call*` 只留一个 `title`；思考块、工具状态与输出、权限请求、配置更新全部丢弃 | `runtime-state.ts` 75–98 |
| 6 | 原始 JSONL 确实在落盘，但只在任务结束、报结果前上传一次；执行期间没有任何读取入口 | `executor.ts` 177–196、`serve-loops.ts` 197–238 |
| 7 | 设计上这是有意为之：架构明确"不提供本地控制面 HTTP"，`CMP-observability` 的 `progress` 被定义为"本地、不跨边界、未实现" | `architecture.md` §1、§12；`CMP-observability/spec.md` 103 |
| 8 | 要"多展示"必须做一次边界决策。最小步是补 `lastEventAt`（零契约变更）；推荐下一步是契约 v4 增加进度字段/端点；观测面（SSE）适合排障详情，不适合首发 | 见 [§6 方案对比](#6-可选方案对比) |
| 9 | 附带发现：`usage` 字段与 DSH 实际不符（真实运行恒为 `null`）；权限请求/决策不进会话日志；`SessionEvent` 通道是死代码 | 见 [§8 附带发现](#8-附带发现可独立修) |

## 1. 调研范围与方法

- **client 代码**：`src/components/runtime`、`executor`、`cli`、`gateway`、`store`、`observability`。
- **上游 DSH**：`/Users/chenlong/agent/deepseek-harness/packages/acp/acp`（当前 `DSH_BIN` 指向的 dev checkout）与安装包内 ACP SDK schema。
- **真机探针**：2026-11-14 用 `hs-deepseek-flash-latest` 跑一条会调用 `bash` 的 prompt，记录每个通知的到达时刻与字段（[`probe/`](probe/)）。
- **跨边界核对**：`docs/design/contracts/executor-http-v3.md`、调度器 `src/components/http-gateway/routes/executor-request.ts`、UI `assets/js/pages/instance-detail.js`。

## 2. 端到端链路：信息在哪一跳消失

```text
DSH (ACP)                 client                                  调度器                        UI
session/update  ──▶  RuntimeState.applyNotification
                      ├─ finalText          （只留最终文本）
                      ├─ lastEventAt        （只给 idle 看门狗用）
                      ├─ onRawEvent ──▶ 本地 JSONL（session-logs/）
                      └─ onEvent（未接线，丢弃）
                                             poll: running[]  ──▶  只存 taskId/startedAt
                                                    （无 lastEventAt/progress）
                      task 结束 ──▶ 上传 P-04 日志（整份）──▶  只存不解析
                                 ──▶ P-02 结果（message/usage）──▶  run node: dispatched→succeeded
                                                                                  │
                                                              5s 轮询 run detail ─┘  只渲染状态/下发时间/完成时间
```

| 跳 | 有什么 | 缺什么 |
|---|---|---|
| DSH → client | 工具开始/结束、思考块、助手消息、上下文用量、权限请求 | token 级文本、计划、阶段事件、工具中途进度 |
| client 内存 | `finalText`、`lastEventAt`、`usage`（永远 null） | 工具时间线、阶段、事件计数、当前工具耗时 |
| client 本地盘 | 完整 JSONL（含思考、工具参数/输出） | 实时读取入口；权限请求不在内 |
| client → 调度器 | `running[]` 两个字段 + 结束时日志与结果 | 执行期的任何过程字段 |
| 调度器 → UI | 节点状态、`dispatchedAt`、`finishedAt`、最终 `message`、日志下载链接 | 进度、最近活动、当前工具、阶段 |

**"不同步"的直接原因**：UI 每 5s 刷新一次 run detail（`instance-detail.js` 31），但后端能返回的执行期字段只有 `dispatchedAt`，刷新多少次都不会出现新内容；日志入口要等任务结束才可用（`instance-detail.js` 421–431）。

## 3. ACP 侧到底能拿到什么

### 3.1 协议面

client 与 DSH 之间只有三种消息（`runtime/acp-protocol.ts`）：

1. **请求/响应**：`initialize`、`session/new`、`session/prompt`、`session/close`、`session/cancel`（通知）。
2. **通知**：`session/update`——过程信息的唯一通道。
3. **agent → client 请求**：`session/request_permission`——工具需要授权时发起，client 必须应答。

`session/prompt` 的响应只有 `stopReason`（DSH 不返回 `usage`），所以**执行期的所有信息都在 `session/update` 里**。

### 3.2 DSH 实际发送的 update（权威：`packages/acp/acp/src/updates.ts` + `session.ts`）

| 消息 | `sessionUpdate` | 触发时刻 | 关键字段 | client 现状 |
|---|---|---|---|---|
| 通知 | `agent_thought_chunk` | 一条助手消息（含推理块）**提交后** | `messageId`、`content.text` | **丢弃** |
| 通知 | `agent_message_chunk` | 同上，按内容块 | `messageId`、`content`（text/image 等） | 累加进 `finalText` |
| 通知 | `tool_call` | 工具调用**开始**时 | `toolCallId`、`title`（= 工具名）、`kind`（DSH 固定 `other`）、`status=in_progress`、`rawInput`（解析后的参数） | 只取 `title` 当 `detail`，且该回调未接线 |
| 通知 | `tool_call_update` | 工具**结束**时 | `toolCallId`、`status`（`completed`/`failed`）、`content[]`（工具输出） | **丢弃** |
| 通知 | `usage_update` | 每条助手消息提交后（与是否产生文本无关） | `used`（上下文已用 token）、`size`（上下文窗口） | 归一化字段名不匹配，恒为 `null` |
| 通知 | `config_option_update` | 模型/推理档位拓扑变化时 | `configOptions` | 丢弃 |
| 请求 | `session/request_permission` | 需要审批时 | `toolCall.toolCallId`、`options`（只有 allow-once/reject-once 两项） | 由静态策略立即应答，不记录 |

DSH 的 ACP 桥是 **automation-only**：模块注释明确只输出"committed semantic updates"，展示型交互留给 harness UI（`packages/acp/acp/src/index.ts` 模块头）。这解释了为什么没有 token 流、计划和中间进度。

### 3.3 粒度与能力边界

**能拿到的**：

- 工具级实时边界：哪个工具、什么参数（前 N 字符可摘要）、开始时刻、结束状态、耗时、输出摘要。
- 每个模型步骤的思考块与助手文本（整块，不是流）。
- 上下文占用：每步 `used/size`，可画"上下文水位"。
- 审批等待：收到 `request_permission` 且未应答的窗口（本 client 静态策略会立即应答，所以通常看不到）。

**拿不到的**：

- token 级文本流；文本只在消息提交时到达。实测最后一段文本在 5.1s 才出现，而工具在 0.54s 就开始了。
- `plan` / `plan_update`（SDK 支持，DSH 不发）；没有"计划步骤"可展示。
- 工具执行中途输出/百分比；`tool_call_update` 只在结束时发一次。
- 显式的 turn/step 开始/结束事件；"模型正在思考"只能从"最近事件时间"推断。
- 成本：`usage_update.cost` DSH 不填。
- `session/prompt` 响应里的 `usage`（DSH 只回 `stopReason`）。

### 3.4 真机实测时间线

条件：`hs-deepseek-flash-latest`，prompt 为"用 bash 工具执行 `sleep 3`，然后只回复 ACP-PROBE-DONE"，权限 allow。完整捕获见 [`probe/summary.json`](probe/summary.json) 与 [`probe/summary.protocol.jsonl`](probe/summary.protocol.jsonl)。

| 相对 prompt 时刻 | 事件 | 内容摘要 |
|---:|---|---|
| 540 ms | `usage_update` | `used=5521, size=1000000` |
| 540 ms | `tool_call` | `title=bash`, `rawInput={command:"sleep 3"}` |
| 565 ms | `tool_call_update` | `failed`（本机 sandbox 后端不可用），带错误文本 |
| 1 449 ms | `agent_thought_chunk` | 218 字推理 |
| 1 450 ms | `tool_call` | 重试 bash，`rawInput` 带 justification |
| 1 457 ms | `request_permission` | 仅 `toolCallId` + 两个选项（需与上一条 `tool_call` 关联） |
| 4 480 ms | `tool_call_update` | `completed`，输出 `(no output)` |
| 5 099 ms | `agent_message_chunk` | `ACP-PROBE-DONE` |
| 5 099 ms | `usage_update` | `used=5814, size=1000000` |

两个结论：

1. **有信息可展示**：0.54s–4.48s 这 4 秒里，client 明确知道"在跑 bash"，完全可以在 UI 上显示"当前工具 + 已运行时长"。
2. **"静默"不等于卡死**：首事件到达前有 0.54s 空窗，工具执行 3s 期间也只有"开始/结束"两个事件；模型思考与工具执行都可能长时间没有新事件。所以 UI 文案不能把"无事件"写成"卡住"，只能写"最近活动 x 秒前"。

## 4. 客户端现在的消费方式

### 4.1 运行时：只留三类

`runtime-state.ts` 的 `applyNotification`（75–98）：

- 先进原始事件出口 `#rawSink`（仅 prompt 期间有效），再按类型处理；
- `agent_message_chunk` → 拼 `finalText`；`usage_update` → 归一化（字段名不匹配，见 §8）；`tool_call*` → 发 `onEvent({kind:"tool", detail:title})`；
- 其余（思考块、工具状态/输出、配置更新）**直接 return**。

而 `onEvent` 这条通道在生产路径上是断的：`RuntimeOptions.onEvent` 从未在组合根传入（`serve-compose.ts` 83–90），`NodeExecutor.#prompt` 构造 `PromptOptions` 时也没传 `onEvent`（`executor.ts` 185–190），只有 `onRawEvent`。`SessionEvent.kind` 里定义的 `permission` 更是从未发出。

### 4.2 原始事件：全量落盘，但只在结束时上传

`executor.ts` 177–196：

- `onRawEvent` 把每个通知序列化成一行 JSONL，追加到 `<stateRoot>/session-logs/<taskId>-a<attempt>.jsonl`（`store/session-logs.ts`）；
- 串行队列（`appends`）保证顺序，`#prompt` 返回前 `await appends`；
- 上传时机只有一处：`reportOne` 里先 `ensureSessionLog`（`serve-loops.ts` 197–238），成功后才 `reportResult`；
- 权限请求走的是 `onServerRequest`（`runtime-instance.ts` 29），**不经过 raw sink**，所以日志里没有审批记录。

### 4.3 上报：只有开始与结束

- `buildPollRequest`（`serve-context.ts` 45–62）从 `ctx.running` 拼 `{taskId, instanceId, startedAt}`，没有 `lastEventAt`。
- `NodeExecutor.snapshotRunning()`（`executor.ts` 100–106）定义了 `lastEventAt` 字段却从不填值，且**没有任何调用方**；`RunningSnapshot` 是死代码。
- `wire.ts` 已经支持序列化 `lastEventAt`（41–46），但因为上游没值，永远不会出现。
- 结果侧 `TaskResult` 只有最终消息、`stopReason`、`usage`、错误（`result.ts` 67–84），没有任何时间线/计数。

### 4.4 调度器与 UI

- 契约 `P-01` 的 `running[]` 只允许 `taskId`/`instanceId`/`startedAt`/`lastEventAt`；调度器用白名单校验，未知字段 `400`（`executor-request.ts` 49–55）。
- 调度器解析 `lastEventAt` 后没有落库/暴露（`grep lastEventAt` 只出现在解析处与类型定义）。
- `RunNodeView`（`run/types.ts`）只有 `dispatchedAt`/`finishedAt`，没有 `startedAt`/`lastEventAt`/进度；UI 节点状态 `dispatched` 直接显示为"运行中"（`run/data.js` NODE_STATE）。
- UI 每 5s 拉一次 run detail（`instance-detail.js` 31），节点详情只有"状态/节点类型/专家/轮次/任务 ID/下发时间/完成时间/耗时"，日志 tab 只提供 gzip 下载，且注释写明"首次点击 404 表示尚未上传"。

## 5. 断点归因

1. **信息本地化**：client 把过程信息写进本地 JSONL，视为"排障材料"而非"展示数据"。`CMP-observability` 的 `progress` 在设计上就写明"本地、不跨边界、不影响主流程"（spec 103）。
2. **契约面没有位置**：`running[]` 只有四个字段，且调度器拒绝未知字段；想加进度必须升契约版本或新增端点。
3. **上传是终态动作**：`P-04` 被定义为"节点每次尝试结束后"上传，`P-02` 还要求日志先到；执行中没有任何上传动作。
4. **展示端没有数据源**：UI 的 5s 轮询只刷 run detail；即使后端把 `lastEventAt` 存下来，`RunNodeView` 也没有这个字段。
5. **协议粒度限制**：文本按消息整块提交，长模型步骤期间没有事件；所以"实时"最多做到工具/消息边界级，做不到逐字。

## 6. 可选方案对比

| 方案 | 可见信息 | 实时性 | 契约改动 | 实现面 | 风险 |
|---|---|---|---|---|---|
| **A. 补 `lastEventAt`** | 最近活动时间（"x 秒前"），能区分"在动/久未动" | ≤30s（poll 长轮询节流） | 无（字段已在 v3） | client runtime/executor/CLI；调度器存储+暴露；UI 一行 | 极低；`OQ-18` 已定"只作观测、不判活" |
| **B. `poll.running[].progress`** | 阶段、当前工具、状态、耗时、上下文水位 | ≤30s（受 poll 挂起上限约束） | **v4**（白名单+字段+版本协商） | client 归一化；调度器存储；UI 渲染 | 中；字段体积/隐私需裁剪；长轮询节奏是硬上限 |
| **C. 独立进度端点 `POST /tasks/{id}/progress`** | 同 B，可再加输出尾部摘要 | 2–5s（客户端节流） | **v4**（新端点） | 契约+gateway+executor+调度器存储+UI | 中；新增端点与鉴权面；失败必须 best-effort，不能影响执行 |
| **D. client 只读观测面（P1 稿：SSE）** | 全量事件、思考、工具输出、历史 attempt | 实时 | 不改调度器契约，但需要 client 入站 HTTP | 观测存储/EventHub/HTTP/SSE/保留/脱敏；调度器或 UI 接入 | 高；与现行"不做入站服务"的默认形态不同（观测面是 P1 允许的例外但未定稿），网络可达、token/TLS、泄露面都要定 |
| **E. 中途上传 `P-04` 快照** | 只能下载原始 JSONL，UI 自己解析 | 取决于上传间隔 | 不改（"后到覆盖"允许同键重传） | client 定时上传；UI 解压渲染 | 中；体积放大、日志含全文、服务端只存不解析；只能算过渡 |

取舍要点：

- **A 是唯一"今天就能做、不动契约"的增量**，但它只能回答"还在动吗"，不能回答"在干什么"。
- **B 与 C 的信息量相同，差别在实时性与改动位置**：B 复用现有 poll，改动小，但 30s 挂起把刷新上限压到 30s；C 多一个端点，可以做到 2–5s，也不占 poll 热路径。
- **D 不适合首发**：它解决的是"排障要看全文/原始事件"，不是"运行中看一眼在干什么"；而且观测面要重新讨论入站 HTTP 的安全边界（`OB-01` 风险仍未关闭）。
- **E 不建议作为产品方案**：把"展示"责任推给 UI 去解 gzip/JSONL，且全文暴露面比结构化摘要大。

## 7. 建议路线

### 阶段 0：不动契约，先把"在动"补上（S）

1. `RuntimeState` 已有 per-session `lastEventAt`，把它经 `RuntimePort` 暴露给 executor（例如 `lastEventAt(session)` 或扩展 `SessionEvent`）。
2. `NodeExecutor.snapshotRunning()` 填上 `lastEventAt` 并真正被 CLI 使用；`buildPollRequest` 从 executor 快照取 `running[]`（保留 `ctx.running` 的 `startedAt` 语义）。
3. 调度器把 `lastEventAt` 存到 task/attempt，`RunNodeView` 增加字段；UI 显示"最近活动 x 秒前"。调度器侧需要确认"只观测、不判活"不变（`OQ-18`）。
4. 同时把权限请求/决策、`usage_update` 的 `used/size` 写进本地结构化日志（`client.jsonl`），先把排障链路补完整。

### 阶段 1：结构化进度快照（M，推荐）

在 client 内定义一个与传输无关的 `ProgressSnapshot`（由 `RuntimeState` 单点维护，按 `taskId + attempt`/session 归属，作为日志、poll、未来端点共用的真相）：

```ts
type ProgressSnapshot = {
  lastEventAt: string;
  phase: "preparing" | "prompting" | "tool" | "settling";
  tool?: { name: string; status: "in_progress" | "completed" | "failed"; startedAt: string; summary?: string };
  usage?: { used: number; size: number };
  events: number;          // 收到的 update 计数，用于判断"在动"
};
```

- `phase` 由 client 推断（session 建立前 `preparing`；prompt 已发且无工具在跑 `prompting`；有 `tool_call` 未结束 `tool`；prompt 已返回 `settling`），**不声称是 ACP 的显式阶段**。
- `tool.summary` 只放工具名 + 参数摘要（截断到固定字节），不放 `rawInput` 全文、不放工具输出、不放思考文本。
- 传输二选一：
  - **B（省事）**：`poll.running[].progress`，契约 v4；接受 30s 刷新上限。
  - **C（体验好）**：`POST /tasks/{taskId}/progress`，客户端节流（如 ≥2s 或事件数变化才发），调度器内存合并，UI 轮询或 SSE。
- 调度器与 UI 侧：`RunNodeView` 增加 `progress`，节点详情显示"阶段 / 当前工具 + 已运行时长 / 最近活动 / 上下文水位"；静默超过阈值只弱提示，不判失败。

### 阶段 2：按需看详情（L，可选）

落地 `docs/works/2026-11-06-observability-http/` 的只读观测面（SSE + attempt 列表 + 规范化事件），作为"排障详情"入口：

- 默认 loopback + token，或由调度器代理，不直接暴露给浏览器；
- 与阶段 1 共用 `ProgressSnapshot`/事件归一化，避免两套解析；
- 需要先关闭 `OB-01`（非 loopback 明文 + 空 token）与 `raw` 暴露的开放问题。

### 不建议

- 不建议把完整 JSONL 实时推到调度器：体积、敏感信息、服务端"只存不解析"的定位都不支持逐条展示。
- 不建议把 `lastEventAt` 用于判活/重派：`OQ-18` 已定只作观测；判活仍走 poll 存在性。

## 8. 附带发现（可独立修）

1. **`usage` 恒为 `null`**：`normalizeUsage`（`runtime-state.ts` 109–117）读 `inputTokens`/`outputTokens`，而 DSH 的 `usage_update` 是 `used`/`size`（ACP schema `UsageUpdate`）；`session/prompt` 响应也不带 `usage`。测试 fixture（`tests/fixtures/fake-acp.mjs` 46–56）用的正是 `inputTokens`/`outputTokens`，掩盖了真实差异。若要展示 token 水位，需要先确定语义（上下文占用 vs 输入/输出 token），契约 `usage` 字段也要一起改。
2. **权限请求不落日志**：`rawSink` 只接 notification，`session/request_permission` 走 `onServerRequest` 直接被策略应答；`P-04` 日志里看不到"何时要求授权、允许还是拒绝"。
3. **`SessionEvent` 是死代码**：`kind` 定义了 `permission` 但从未发出；`onEvent` 无生产调用方；`snapshotRunning`/`RunningSnapshot` 无调用方。要么接线到 `ProgressSnapshot`，要么删除，避免继续误导。
4. **"静默"与"卡死"的文案**：首事件前 0.54s、工具执行 3s 期间都只有少数事件；长思考期间同样可能长时间无事件。UI 不能用"无进展"推断失败；`idle_timeout` 默认关闭也是同一原因（`C-06`）。
5. **`dispatchedAt` 不是开始时间**：它是调度器下发时刻，UI 用它算"节点耗时"会把排队时间算进去；若要展示真实执行时长，需要 client 的 `startedAt`（`TaskResult.startedAt` 已有，但只在结果里）。

## 9. 未决问题（需要拍板）

| # | 问题 | 选项/影响 |
|---|---|---|
| Q1 | 展示受众是谁？ | 调度器 UI 的普通用户看"阶段+当前工具"即可；运维才需要全文/原始事件 |
| Q2 | 是否允许展示模型思考文本？ | 展示思考会显著增加敏感面与体积；建议只显示"思考中/最近活动" |
| Q3 | 实时性目标？ | 30s（方案 B，改动小）还是 5s（方案 C，多一个端点） |
| Q4 | 是否接受 client 被反向访问（观测面）？ | 需要网络可达、token/TLS、调度器代理；与现行"只出站"架构冲突 |
| Q5 | 契约 v4 的字段所有权？ | `progress` 由 client 生成、调度器透传/存储、UI 只读；版本协商与旧 client 兼容策略要对齐 |

## 10. 证据与复现

- 探针脚本：[`probe/acp-progress-probe.mjs`](probe/acp-progress-probe.mjs)
- 捕获结果：[`probe/summary.json`](probe/summary.json)（归一化时间线）、[`probe/summary.protocol.jsonl`](probe/summary.protocol.jsonl)（逐帧协议记录）
- 复现命令（隔离 `DSH_HOME`，注入 provider key，不改本机 `~/.dsh`）：

```bash
mkdir -p /tmp/acp-progress/{home,ws}
# 用 client 的 profile 补丁 + 模型路由（省略生成步骤，见 summary.json 的 commandArgs）
HUNDSUN_PUBLIC_API_KEY=... node docs/history/works/2026-11-14-acp-progress-feedback/probe/acp-progress-probe.mjs \
  --dsh /Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js \
  --home /tmp/acp-progress/home --cwd /tmp/acp-progress/ws \
  --patch /tmp/acp-progress/home/af/profile.skill-patch.yml \
  --out docs/history/works/2026-11-14-acp-progress-feedback/probe/summary.json
```

- 捕获注意：本机 `workspace-write` sandbox 后端不可用，第一次 `bash` 以 `failed` 返回，模型自动改用 `danger-full-access` 重试；这恰好演示了"失败状态与错误文本也能实时展示"，不影响时序结论。

## 11. 结论落点（确认后回填）

| 结论 | 落点 |
|---|---|
| `lastEventAt` 补发与展示 | `CMP-runtime`/`CMP-executor`/`CMP-cli` spec；调度器 `RunNodeView`；UI 节点详情 |
| `ProgressSnapshot` 与进度上报 | `CMP-runtime`/`CMP-executor`/`CMP-gateway`；契约 v4（新字段或新端点） |
| `usage` 语义修正 | `CMP-runtime`/`CMP-result`；契约 `TaskResult.usage` |
| 权限请求/决策落日志 | `CMP-runtime`/`CMP-observability` |
| 观测面（可选） | `CMP-observability` P1 设计 + `architecture.md` §12 |
