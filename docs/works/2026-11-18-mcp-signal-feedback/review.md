---
layer: works
module: global
status: active
updated: 2026-11-18
---

# 评审与反馈：review verdict 走 MCP 信号（client 侧）

> 评审对象：[`2026-11-18-review-verdict-mcp/proposal.md`](../../../../agent-flow-orchaster/docs/works/2026-11-18-review-verdict-mcp/proposal.md)（P1 提案，未冻结）。
> 结论：**通过（无 Blocker）**。提案 `0.1` 已吸收第一轮 15 项处置；仍建议调整 3 处（`Q-07`/`Q-08`/`Q-09` 收窄版），另有 3 条实现硬约束（`A-11`/`A-13`/`A-15`）。
> 范围：只谈 MCP 执行机制——工具名、schema 投影、进程与挂载行为、失败语义、结果预算。部署规模、可用性、停服策略、能力协商、协议扩版属运维层，环境由人工确认后才发起测试，本评审不讨论。
> 方法：提案逐条对 client 现行契约/规格/代码核对；DSH MCP 行为用最小 stdio server 实测（[`probe/`](probe/)，DSH `0.2.2-alpha.2`）。

## 1 已核实无问题

| ID | 结论 | 证据 |
|---|---|---|
| `V-01` | `session/new` 现在固定传 `mcpServers: []`，提案 §1.1 描述成立 | [`runtime.ts`](../../../src/components/runtime/runtime.ts) 的 `newSession`；`RuntimePort` 签名只有 `(instance, cwd)`，见 `A-03`（已按可选参对象采用） |
| `V-02` | 旧 client 会忽略未知字段，§3.3 的兼容前提成立 | [`wire.ts`](../../../src/components/gateway/wire.ts) 的 `parseTask` 逐字段取值，未声明字段不进对象、不报错 |
| `V-03` | `P-02` 没有字段白名单，`signals` 是对象透传 | [`gateway.ts`](../../../src/components/gateway/gateway.ts) 的 `reportResult` 直接把 `TaskResult` 当 body POST；只需在 [`types.ts`](../../../src/components/executor/types.ts) 加字段 |
| `V-04` | 工具参数错误不会把任务判失败 | 实测 `S-03`：非法 verdict 只让 `tool_call_update` 变 `failed`，`session/prompt` 仍 `end_turn` |
| `V-05` | MCP server 随 session/进程组退出，`C-09` 的覆盖判断成立 | 实测 `S-05`：`session/close` 后 server 收 SIGTERM 并退出；`SIGKILL` DSH 进程组后 server 消失 |
| `V-06` | 同实例并发任务不会因 server 重名失败 | 实测 `S-05`：一个 DSH 进程内两个 session 同时挂 `agentflow` 均成功 |
| `V-07` | `signals` 的「只在 succeeded 出现」与现有组装不冲突 | [`result.ts`](../../../src/components/result/result.ts) 的 `statusOf` 只看 `SessionOutcome.error` |

## 2 实测结论（DSH `0.2.2-alpha.2`，acp profile）

证据：[`probe/report.json`](probe/report.json)、[`probe/mcp-server-log.jsonl`](probe/mcp-server-log.jsonl)、[`probe/concurrent-server-log.jsonl`](probe/concurrent-server-log.jsonl)、[`probe/discover-ignore-server-log.jsonl`](probe/discover-ignore-server-log.jsonl)；复跑见 [`probe/README.md`](probe/README.md)。

| ID | 结论 | 与提案的差异 |
|---|---|---|
| `S-01` | 工具公开名是 **`mcp__agentflow__signal`**：DSH 按 `mcp__<serverName>__<rawName>` 注册（serverName 限 `[A-Za-z0-9_-]{1,32}`，公开名 ≤64 字符）。模型按这个名字调用；ACP `tool_call.title` 也是它，`P-04` 日志与观测面天然可见 | 提案原文写 `agentflow_signal`；`0.1` 已改，一致 |
| `S-02` | MCP 工具调用**不触发** `session/request_permission`（合法与非法调用各一次，计数 0）；DSH 的权限请求 payload 只有 `{sessionId, toolCall:{toolCallId}, options}`，不含工具名 | 提案原文「只放行 `agentflow_signal`」无判别依据；`0.1` 已删，一致 |
| `S-03` | 参数错误可在同一 session 内纠正：非法 `verdict` → `tool_call_update status=failed`、文本 `Error: invalid: …`；模型按提示改成 `pass` 后重试成功，`prompt` 正常 `end_turn` | 与 §2.1/§3.4 一致 |
| `S-04` | 启动失败时 `session/new` 返回 JSON-RPC `-32603`，`message` 只有 `"Internal error"`，真实文本在 `error.data.details = "mcp-client(agentflow): initial connection or tool synchronization failed"`；「command 不存在」与「脚本启动即退出」两种失败文本完全相同 | `0.1` 已改 fail-fast；`details` 必须能被 client 读到（`T-RVM-04` 已列） |
| `S-05` | 进程形态：ppid = DSH、cwd = 容器根、env = 基础变量（`PATH`/`HOME`）＋声明项，不含任务路径或凭据；每次 `session/new` 启动 **两个** server 进程：第一个只收到 `server/discover` 探针（`id="server-discover-probe-1"`）就被 SIGTERM，第二个走 legacy `initialize` → `tools/list` 并承载调用；两个 session 并发共 4 次启动，互不干扰 | `0.1` 归因正确（SDK `mode:'auto'` 协商）；见 `A-06`、`S-07` |
| `S-06` | 时延：server 启动到 `tools/call` 完成约 1.1 s（含一次模型往返）；挂 MCP 的 `session/new` 仍是秒级 | 与 `session/new` 10 s 超时相容 |
| `S-07` | **`server/discover` 必须被立即回应**：server 静默忽略时，探针等 **60 s**（实测 `elapsedMs=60048`）才回落 legacy，`session/new` 随之 60 s；回 `-32601` 时约 8 ms 回落 | 提案未提；在 10 s 超时 + fail-fast 下，忽略探针等于每个 review 任务必失败，见 `A-11` |

## 3 提案 `0.1` 的吸收情况

第一轮提出的问题与建议已按 `0.1` 表处置，这里只记结论，不再展开：

| 项 | 处置 |
|---|---|
| `Q-01` 工具名口径 | 已定：全文用 `mcp__agentflow__signal`，`agentflow_signal` 只作语义别名 |
| `Q-02` `required` 的 client 行为 | 已定：记 `signal_missing`、不上报 signals、run 回退消息；不补 prompt、不判失败 |
| `Q-03` 挂载失败可判别性 | 已定：fail-fast；`details` 只用于错误文本/诊断 |
| `Q-04` `evidence` 可见范围 | 已定：进 signals/journal/观测面/`run_node.verdict`，按现有脱敏规则 |
| `Q-05` 信号目录保留期 | 已定：默认 7 天 + `doctor` 清理，不进归档 |
| `Q-06` attempt 归属 | 已定：只读当前 `taskId+attempt`，旧 attempt 保留但不读 |
| `A-01`–`A-10` | 已吸收：schema 投影、`CMP-signal` 候选化 + P1 结构决策、`newSession` 可选参、整体预算、collect 顺序、幂等启动与续号、超时配置、删权限放行、承诺编号 `C-13/C-14`、预检同入口 |

## 4 仍需调整的三处

### `Q-07` fail-fast 是否在同一 attempt 内重试一次

现状：挂载失败直接 `failed(signal_mount_failed)`，而 `S-02` 规定失败结果不自动重派，于是一次启动失败就让整个 run 永久失败。

选项：(a) 零重试；(b) 同 attempt 用**相同 `mcpServers`** 重建 session 一次（不降级、不回退消息），仍失败才报 `signal_mount_failed`。

建议 (b)：成本是一次 `session/new`，换来「启动抖动不毁掉 run」；与 fail-fast 不冲突。

### `Q-08` 删掉 `signal_unavailable` 与启动预检退出

v3 没有「按任务类型不领取」的表达位置：`poll` 的 `tasks[]` 一旦下发，client 要么执行并回报、要么不执行也不回报；`running[]`/`finished[]` 是唯一被调度器看见的持有声明，`S-03` 会把「既不在 running 也不在 finished」的任务原样重发。所以「停止领取带 `resultSignal` 的任务」在协议上只能用「退出 `serve`」实现，而退出会把 review 之外的节点任务一起停掉。

建议：

- 删掉 `signal_unavailable` 这个状态与「退出 serve」分支；挂载失败就逐任务 `failed(signal_mount_failed)`；
- 启动预检简化为任务期 `--check`（prepare 阶段）：环境由人确认后才发起测试，预检失败时人已在现场，逐任务报错足够；同时省掉「serve 不进入执行循环 + 专用退出码」这组新语义。

### `Q-09` 归因：MCP 失败与 DSH/实例失败分开报

本轮只定一件事：`error.data.details` 命中 `mcp-client(<serverName>)` 才报 `signal_mount_failed`；其它 `session/new` / 实例失败按真实原因报（`spawn_failed` / `process_exited` / `protocol_error`），沿用现状「当前任务失败、serve 继续」。

理由：错误码决定运维去修什么。把 DSH 崩溃写成 `signal_mount_failed`，会让人去重装 signal server，而真正坏的是 DSH。

## 5 三条实现硬约束

| ID | 约束 | 依据 |
|---|---|---|
| `A-11` | signal server 必须对 `server/discover` **立即回 JSON-RPC error**（`-32601` 即可），或实现该协议；禁止静默忽略未知方法。测试断言：挂载完成 ≤ 2 s | 实测 `S-07`：忽略会让探针等 60 s，必撞 `session/new` 超时 |
| `A-13` | 新错误码进 `executor-http-v3.md` §4.2 #4 约定表：`signal_prepare_failed` / `signal_mount_failed`，`class=protocol`；orchestrator 按 code 出可读失败文案 | 现在只有 4 个约定 code；不进表，调度侧只能看字符串 |
| `A-15` | `run`（单次模式）与 `serve` 走同一套 prepare/collect/失败语义 | 提案只写了 `serve`；`run` 也会收到带 `resultSignal` 的任务 |

## 6 影响面

| client 单元 | 改动 | 类型 |
|---|---|---|
| `CMP-runtime` | `newSession` 加 `mcpServers`；`AcpProtocol` 透出 `error.data.details` | 端口加法 + 内部 |
| `CMP-executor` | `prepare`/`collect` 调用；挂载失败 fail-fast（含 `Q-07` 重试一次） | 流程 |
| `CMP-result` | `signals` 组装与 `message + signals` 整体预算 | 字段 + 规则 |
| `CMP-gateway` | `parseTask` 读 `resultSignal`；`reportResult` 不用改 | 字段 |
| `CMP-store` | journal 里结果体积增大；信号目录不归它 | 无（观察） |
| `CMP-signal`（新，L0） | 目录/config/预检/采集/server 配置 | 新组件（P1 结构决策） |
| `CMP-observability`/`observer` | 不改；`tool_call.title` 已能看到工具名 | 无 |
| 契约 `executor-http-v3.md` | §5 两处类型 + §7 新承诺（`C-13`/`C-14`） | 契约加法 |

## 7 与提案 §13 验收清单的对照

| 提案 §13 项 | 状态 |
|---|---|
| 用户确认 v1 边界（只做 review、单 kind、只走 `P-02`、不改 scheduler） | 待用户 |
| client 完成 spike | 已完成（工具名/权限/启动失败/回收/并发/时延/`server/discover`）；Windows 与打包形态未覆盖 |
| client 完成 P1 结构决策 | 未开始（`T-RVM-10`） |
| 双方对 §3 字段/上限/回退语义无异议 | 有 3 处调整建议（§4），无方向分歧 |
| 确认兼容矩阵、skill 双写是过渡态 | 前提成立（`V-02`），同意 |
| 确认 `needs_human` 是节点级兜底 | 同意，不属 client 本轮范围 |
| 确认后再改契约/规格/迁移/代码 | 本轮不动 |

## 8 未做与后续

- 未实测 Windows（`process.execPath` 的 `bun.exe`、盘符）与单二进制打包形态；属 `T-RVM-02` 剩余范围。
- 未验证「工具调用被 `task.timeoutMs` 截断」与「`idle_timeout` 把工具等待算作无事件」的组合；补一条用例即可。
- 未涉及 `needs_human` 的 `waiting_confirm` 展示与 UI；归 orchestrator/UI。
- 未改 `requirements/`、`plan/`、`design/`、`src/`；若提案确认，先走 `T-RVM-10`（client P1 结构决策）再拆实现任务。

## 9 定稿复核（2026-11-18）

复核对象：提案定稿版（`0.1` 表已扩到 21 行）。结论：**无冲突，可执行**。

| 检查项 | 结果 |
|---|---|
| `Q-07` fail-fast 前同参重建一次 | 已采纳；client 侧可落地（实测：同一 DSH 进程内两次失败的 `session/new` 之后，第三次带正常 server 的 `session/new` 仍成功，见 `probe/report.json` 的 `missing-command`/`broken-script` → `killGroupReap`） |
| `Q-08` 删 `signal_unavailable` 与启动门禁 | 已采纳；与 `executor-http-v3` 的 poll/结果语义一致，client 不需要新状态 |
| `Q-09` 归因 | 已采纳；依赖 `AcpProtocol` 透出 `error.data.details`，已列入 `T-RVM-04` |
| `A-11` `server/discover` | 已采纳；已进 §7.1 用例（挂载 ≤2s） |
| `A-13` 错误码进契约 | 已采纳；`signal_prepare_failed`/`signal_mount_failed`，`class=protocol` |
| `A-15` `run`/`serve` 同语义 | 已采纳 |
| `§5.5` 第二场景（临时确认点） | 与本轮 v1 不冲突：`session/resume` 是 ACP 能力（DSH `initialize` 已 advertise `sessionCapabilities.resume`）；client 当前实现里 `shutdownInstance` 只回收进程、不删 `DSH_HOME`，`doctor` 对残留 session 只报告（[`runtime.ts`](../../../src/components/runtime/runtime.ts)、[`admin.ts`](../../../src/components/runtime/admin.ts)），持久化 session 可留存。**注意**：`CMP-runtime` 规格 §2.6 写的是「退出后删除实例 `DSH_HOME`」，与实现不一致；若哪天按规格补齐，resume 跨实例重启会失效——留到 `T-RVM-09` 一并处理 |

两条非阻塞提醒（写进 v1 契约时顺手处理即可，不影响开工）：

1. `TaskSignal.kind` 建议定义成可扩展类型（如 `kind: ResultSignalKind`，v1 只允许 `review_verdict`），这样 §5.5 的 `confirmation_request` 到来时不需要改字段类型。
2. §5.5 续跑时 `session/resume` 需要重新传 `mcpServers`（DSH 的 resume 接受该参数，默认 `[]`），否则确认工具在续跑 session 里消失；归 `T-RVM-09` 的 spike 项，v1 不涉及。
