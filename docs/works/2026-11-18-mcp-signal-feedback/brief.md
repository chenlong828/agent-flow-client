---
layer: works
module: global
status: active
updated: 2026-11-18
procedure: 2026-11-18-mcp-signal-feedback
level: P1
---

# 工序：review verdict 走 MCP 信号的需求澄清与反馈（client 侧）

> 来源：调度面提案 [`2026-11-18-review-verdict-mcp/proposal.md`](../../../../agent-flow-orchaster/docs/works/2026-11-18-review-verdict-mcp/proposal.md)（P1，未冻结，目标读者是 client 实现者）。
> 本轮定位：**只做需求澄清与技术反馈**，不做实现、不改 `requirements/`、`design/`、代码；结论不设阻塞（用户 2026-11-18 决定），把可拍板项交回调度面与用户。
> 交付物：本 `brief.md`、[`review.md`](review.md)（评审、澄清与建议）、[`probe/`](probe/)（DSH MCP 最小实测脚本与原始证据）。

## 1 要解决什么

提案把 review 节点的 verdict 从「skill 约定模型在消息末尾写 JSON、服务端事后解析」改成「client 给 session 挂 MCP 工具，模型调用工具提交结构化 verdict，client 采集后随 `P-02` 回传」。client 是这条链路的实现方：要新增 stdio MCP server、per-attempt 信号目录、`RuntimePort.newSession` 的 `mcpServers` 参数、`TaskResult.signals` 字段与结果字节预算。

本轮要回答三个问题：

1. 提案里关于 client 与 DSH 的事实性假设是否成立（工具名、权限、启动失败、进程回收、schema 约束）；
2. 契约字段（`resultSignal` / `signals`）与兼容矩阵在 client 侧是否可落地、有没有需要改口径的地方；
3. 哪些点必须由调度面或用户拍板，哪些是 client 内部实现时可以自行决定的。

## 2 范围

| 做 | 不做 |
|---|---|
| 读提案、client 现行契约/组件规格/代码，逐条核对前提 | 改 client 代码或测试 |
| 用最小 stdio MCP server 实测 DSH 的挂载、命名、权限、启动失败、回收 | 改 orchestrator 仓库任何文件 |
| 输出澄清问题（Q）与建议（A），并标明影响面；只讨论 MCP 执行机制 | 运维/部署层议题（停服、能力协商、扩协议）；建 REQ 卡、改 `plan/`、改组件规格 |
| 记录实测证据，供 `T-RVM-02` 直接复用 | 决定 `needs_human` 的产品口径、执行中问答模式 |

## 3 任务表

| ID | 类型 | 组件 | 内容 | 装载清单 | 状态 |
|---|---|---|---|---|---|
| `T-01` | review | global | 提案前提与 client 现状核对（`runtime.ts`、`executor.ts`、`result.ts`、`wire.ts`、`executor-http-v3.md`、组件规格） | 提案 + 上述文件 | 完成 |
| `T-02` | verify | global | DSH MCP 最小实测：挂载、工具公开名、权限请求、参数错误纠正、启动失败、`session/close` 与进程组回收、并发同名 | 提案 §2/§4；`probe/drive.mjs` | 完成 |
| `T-03` | review | global | 写 `review.md`：实测结论、澄清问题、建议、影响面 | `T-01`/`T-02` 产出 | 完成 |
| `T-04` | review | global | 调度面回复与第一轮 6 个待拍板项收口 | `review.md` | 完成（提案 `0.1` 已吸收） |
| `T-05` | verify + review | global | 第二轮：复核提案 `0.1` 修订；补 `server/discover` 探针实测（`S-07`）；把需求收窄到 MCP 执行机制 | 修订版提案、`review.md`、`probe/discover-probe.mjs` | 完成 |
| `T-06` | review | global | 三处调整（`Q-07`–`Q-09`）与 `T-RVM-10` 的顺序确认 | `review.md` §4 | 完成（提案定稿版已采纳，复核见 `review.md` §9） |

## 4 验收标准（本轮）

1. 提案中每一条关于 client/DSH 的事实性断言，都有「成立 / 不成立 / 需实测」的结论与证据（代码位置或实测记录）。
2. 澄清问题可拍板：每条写清现状、选项、影响方，不只写「请确认」。
3. 建议项给出 client 侧落地形态（组件、端口、字段、预算），但不写成实现方案。
4. 实测脚本可复跑，证据落 `probe/`，不依赖本次会话的临时目录。
5. 不改动 `requirements/`、`design/`、`src/`、`tests/`（`git status` 可验证）。

## 5 领取的开放问题

本轮最终只剩 3 条待定（`review.md` §4 的 `Q-07`–`Q-09`），提案定稿版已全部采纳（复核见 `review.md` §9）；第一轮 6 条已在提案 `0.1`/§12 落默认，部署规模与运维层问题（停服止损、能力协商、协议扩版）按用户 2026-11-18 决定从评审中剔除。按 doc-layout-spec，`works/` 的结论在收口时才分流到 `plan/open-questions.md` 与组件规格；本轮未收口，故只记在 `review.md`，不预写 `plan/`。
