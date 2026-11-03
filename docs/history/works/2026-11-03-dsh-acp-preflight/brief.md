---
layer: history
module: runtime
status: frozen
updated: 2026-11-03
---

# 工序 Brief：DSH ACP 对接预研

## 需求与背景

client 的 S0 目标是「本地执行闭环」。其中 CMP-runtime 计划以 ACP（Agent Client Protocol）stdio 驱动本机 DSH：一个实例一个 DSH 进程，一个可执行节点一个 session（见 `docs/design/architecture.md`）。

当前没有任何 DSH 调用代码，也没有确认过：

- DSH 从哪里来、怎么启动（`dsh acp` / `dsh --profile acp`），profile 与 home 如何初始化；
- ACP 连接的最小调用序列与消息形态；
- 真实模型在本机凭据下能否跑通 prompt；
- 权限、取消、关闭、会话持久化这些边界行为是否如文档所述。

本工序先做一次可复现的预研，产出探针与结论，不做产品代码。

## 目标

1. 确认 DSH ACP 服务器的启动路径：二进制来源、版本、`DSH_HOME`、profile 首次初始化、cwd 要求。
2. 用最小客户端跑通真实会话：`initialize` → `session/new` → `session/prompt` → `session/update` → 找到最终 assistant 文本与 `stopReason` → `session/close`。
3. 验证边界：权限请求应答、`session/cancel`、进程退出、`session/list`（持久化是否可用）；`session/resume` 不在本工序验收内。
4. 沉淀一条可复现命令与一份对接说明，供 S0 的 CMP-runtime 参考。

## 非目标

- 不改 DSH 源码，不新增 DSH 侧私有协议；
- 不实现 CMP-runtime 产品代码，不动 `src/`；
- 不接调度器，不验证技能刷新与 session 绑定（S0 后续项）；
- 不做性能与并发压测。

## 验收标准

- A1：从源码 checkout 用隔离 `DSH_HOME` 启动 `dsh --profile acp`，profile 自动初始化，ACP 服务器可接受 `initialize`。
- A2：真实模型（非 mock）跑通一次 prompt，探针打印 `sessionId`、assistant 文本、`stopReason`。
- A3：权限请求可被客户端自动应答（至少验证一次 allow 或 reject 路径）。
- A4：`session/close` 后进程能自行退出；`session/list` 能列到刚关闭的会话。
- A5：探针一条命令可复现（含凭据来源说明），失败时错误信息可读。

## 任务表

| ID | 类型 | 组件 | 状态 | 装载清单 |
|---|---|---|---|---|
| T-01 | 预研 | CMP-runtime | 已完成 | `docs/design/architecture.md`；DSH `docs/cli-help.zh.md`、`packages/bundle/acp-app/README.zh.md`、`packages/acp/acp/README.zh.md` |
| T-02 | 预研 | CMP-runtime | 已完成 | `packages/acp/acp/src/index.ts`、`packages/subagent/subagent-acp/src/run.ts`、ACP SDK schema |
| T-03 | 预研 | CMP-runtime | 已完成 | 同 T-02；探针脚本 `probe/acp-probe.mjs` |
| T-04 | 文档 | CMP-runtime | 已完成 | `docs/plan/open-questions.md`、`docs/plan/roadmap.md`、本目录 `result.md` |

## 领取的开放问题

- OQ-003：DSH 二进制如何供给与升级？本工序给出「源码 checkout 启动」与「按版本固定」的判断依据。
- OQ-008：client 与 DSH 的版本兼容窗口，本工序记录实测版本与 ACP 协议版本作为起点。

OQ-001、OQ-002（技能可见性）不在本工序，留给 S0 首项验证。

## 改动级别

P3：仅探针脚本与文档，不改产品契约、组件切分或数据所有权。若结论要求新契约，另起工序定级。
