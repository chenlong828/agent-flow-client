---
layer: works
module: global
status: active
updated: 2026-11-14
---

# 结果：任务执行过程的信息反馈调研（ACP 侧）

> 对应工序：[`brief.md`](brief.md)；报告：[`report.md`](report.md)；设计分析：[`design-progress-5s.md`](design-progress-5s.md)。本轮只调研与设计，未改 `src/`、未改契约、未改 UI。
> 状态：调研完成；2026-11-14 用户确认「5s 回报 + 模式 C」，设计分析已出，**待确认 C1–C6 后进入实现**。

## 1. 结论

- "过程展示不同步"不是 ACP 不推：DSH 在工具级实时推送 `tool_call` / `tool_call_update`（实测 0.54s 开始、4.48s 结束），client 拿到后只做了两件事——攒最终文本、把原始 JSONL 落到本机。
- 跨边界只有"开始"和"结束"两个信号：`poll.running[]` 没有 `lastEventAt`（字段早就在契约里，client 从未发、调度器也未存/展示），`P-04` 日志只在任务结束前上传一次。
- 设计层面是有意为之：架构明确"不提供本地控制面 HTTP"，`CMP-observability` 的 `progress` 被定义为"本地、不跨边界、未实现"。因此"多展示"需要一次边界决策，而不是 client 单方面加字段。
- 建议路线：阶段 0 补 `lastEventAt` + 本地进度日志（零契约变更）；阶段 1 用契约 v4 增加结构化 `ProgressSnapshot`（poll 字段或独立进度端点）；观测面（SSE）只作为后续排障详情。

## 2. 验收对照

| brief 验收项 | 结果 | 证据 |
|---|---|---|
| 逐跳说明信息在哪被丢弃/延迟 | 完成 | `report.md` §2、§4 |
| ACP 能提供/不能提供的信息清单 + 真机时间线 | 完成 | `report.md` §3；`probe/summary.json` |
| ≥3 条方案并标明契约/实现/实时性/风险 | 完成 | `report.md` §6（A–E 五条） |
| 明确"不改契约可做"与"必须改契约"的分界 | 完成 | `report.md` §6、§7 |
| 开放问题可拍板 | 完成 | `report.md` §9（Q1–Q5） |

## 3. 交付物

- [`report.md`](report.md)：调研报告（结论、链路、ACP 清单、实测、方案对比、建议、未决问题）。
- [`probe/acp-progress-probe.mjs`](probe/acp-progress-probe.mjs)：可复现探针。
- [`probe/summary.json`](probe/summary.json)、[`probe/summary.protocol.jsonl`](probe/summary.protocol.jsonl)：2026-11-14 真机捕获。

## 4. 附带发现（可另立小工序）

1. `usage` 恒为 `null`：client 读 `inputTokens`/`outputTokens`，DSH 发 `used`/`size`；测试 fixture 用了不存在的形状。
2. `session/request_permission` 不进入 `P-04` 会话日志（raw sink 只接通知）。
3. `SessionEvent`/`onEvent`/`snapshotRunning` 是未接线的死代码；`SessionEvent.kind="permission"` 从未发出。
4. UI 用 `dispatchedAt` 算"节点耗时"，把调度排队时间也算进去了；真实开始时间只在 `TaskResult.startedAt`。

## 5. 下一步（待确认）

1. 用户在 `report.md` §9 的 Q1–Q5 上拍板（受众、是否展示思考、实时性目标、是否允许 client 入站、契约 v4 字段所有权）。
2. 按拍板结果拆实现工序：
   - 最小：补 `lastEventAt`（client + 调度器 + UI）；
   - 推荐：`ProgressSnapshot` + 契约 v4（poll 字段或 `POST /tasks/{id}/progress`）；
   - 可选：观测面 P1 落地（需先关闭 `OB-01` 等安全未决项）。
3. 实现前回填 `docs/design/architecture.md`、`CMP-runtime`、`CMP-executor`、`CMP-observability` 与调度器契约；涉及契约破坏性变更时按 `arch-design-spec` 重新定级。

## 6. 追加：5s + 模式 C 的设计分析（2026-11-14）

用户确认按 **5s 回报**、采用**模式 C（独立进度端点）**。设计分析见 [`design-progress-5s.md`](design-progress-5s.md)，要点：

- 端点：`POST /api/v1/executor/tasks/{taskId}/progress`（P-06），5s 一跳、`seq` 单调、只保留最新快照。
- 兼容：不升 protocol 版本，用 `poll` 响应新增 `capabilities:["progress-v1"]` 做能力协商；任一侧可独立升级/回滚。
- 存储：调度器内存 `ProgressRegistry`，不落库、不留历史；重启后下一跳自愈。
- client：CLI 每 5s 采样 `executor.snapshotProgress()` 上报；runtime 只维护 session 事实；失败不影响任务。
- UI：run detail 新增 `progress` 字段，展示阶段/当前工具/耗时/最近活动/上下文；`stale` 弱提示，不判失败。
- 定级 **P1**：跨仓库契约 + 新数据所有权 + 七个模块。待确认 C1–C6 后出最终规格与任务表，再编码。

设计文档 §15 列出了待拍板的 C1–C6；§16 是确认后的任务拆分。

## 7. 追加：实测模拟与载荷修订（2026-11-14）

用当时正在运行的 `n3「方案」` 任务重建 5s tick（[`sim-progress-live.md`](sim-progress-live.md)），发现原载荷只报"当前工具"不够：

- 59 个工具全部 <0.2s，28 个 tick 的 `active` 都是 0，按原设计 UI 只会显示"模型处理中"；
- 窗口内 `agent_message_chunk` 为 0，叙事全在 `thought` 里；
- 因此载荷改为"最近 8 个动作（`activity`）+ 最新叙述尾部（`text`）"，仍不含 prompt/最终消息/工具输出；原 C4 随之修订。
- `text` 是否默认开启（thought 是否可看）与 `promptHead` 是否由 run detail 提供，列为待确认 Q7/Q8。
