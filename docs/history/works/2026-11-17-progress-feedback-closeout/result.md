---
layer: works
module: global
status: frozen
updated: 2026-11-17
---

# 结果：执行过程可见性收口

## 1 结论

- 5s 模式 C 正式暂停，原调研 C1–C6 不再等待确认；执行期可见性统一由消费方主动拉取观测面。
- UI 经调度器产品 API/BFF 拉取（不直连 client）；client 不新增进度端点/字段，`lastEventAt` 暂不补。
- 文档已回填；无代码、契约、调度器或 UI 改动。

## 2 验收对照

| brief 验收 | 结果 | 证据 |
|---|---|---|
| 现行文档无「5s 待确认/待实现」表述 | 通过 | `CMP-observability` §2.4；`architecture.md` §3.3；`OQ-028` |
| 架构能回答来源/发起/边界/失败 | 通过 | §3.3 拉取面、§4.6 观测路径、§1 拓扑 |
| 原调研 5 项目标逐项有归属 | 通过 | §3 |
| 无契约/代码改动 | 通过 | 改动仅 `docs/` |
| 遗留项有去向 | 通过 | §5 |

## 3 原调研展示目标的归属

| 目标 | 归属 | 说明 |
|---|---|---|
| 当前阶段 | 消费方聚合 | `attempt.phase` + 事件序列；UI 展示时聚合，不新增 `phase` 字段 |
| 当前工具与耗时 | 消费方聚合 | `O-11` `tool_call`/`tool_result`；进行中耗时由 UI 按事件时间计算 |
| 最新叙述尾部 | 消费方聚合 | `O-11` `message`/`thought`（≤16 KiB，含截断标记） |
| 最近活动 | 消费方聚合 | 事件 `ts`；不新增 `lastEventAt` |
| 上下文水位 | 消费方聚合 | `O-11`/`O-04` 的 `usage` 事件（`used/size`） |
| 5s 推送 / 调度器快照 | 不做 | 决策「决策 1」；调度器不新增 `ProgressRegistry` |

## 4 改动清单

| 文件 | 改动 |
|---|---|
| `brief.md` / `review.md` / `result.md` | 本工序记录（归档） |
| [`2026-11-17-execution-visibility-pull.md`](../../decisions/2026-11-17-execution-visibility-pull.md) | 新建决策记录：5s 暂停、拉取方向、边界、备选与未决 |
| [`architecture.md`](../../../design/architecture.md) | §1 拓扑；§3.1 控制面表述；新增 §3.3 拉取面；§4 能力表去掉 `progress`；§4.6 增加观测路径；§12 状态 |
| [`CMP-observability/spec.md`](../../../design/components/CMP-observability/spec.md) | 头注、职责、§2.4 改为「进度推送（不做）」、§8 状态 |
| [`CMP-observer/spec.md`](../../../design/components/CMP-observer/spec.md) | 业务价值与 §3.2 明确消费方主动拉取 |
| [`roadmap.md`](../../../plan/roadmap.md) | 当前状态与活跃工序 |
| [`open-questions.md`](../../../plan/open-questions.md) | 新增并关闭 `OQ-028` |
| [`README.md`](../../../README.md) | 归档工序与决策导航；观测面条目改为「已实现」 |

## 5 遗留与交接

- **UI**：会话 Tab / 文件 Tab / 节点摘要，经产品 API 拉取并按事件聚合；属 UI 项目（`T-06`）。
- **client 待办**（`T-07`）：`lastEventAt`（重开条件见决策「未决 3」）、死代码清理（P3）、`OQ-022` 旧口径、`CMP-executor` 规格中 `onEvent` 描述与实现不一致。
- **观测面工序**：`docs/works/2026-11-06-observability-http/` 仍为 `active`，建议按其自身收口流程归档。
- **调度器侧**：决策只在 client 仓库记录；上游 `agent-flow-orchaster` 仍需同步一条对应决策（`P-06`/`ProgressSnapshot` 不做），本次未改上游仓库。

## 6 验证

- `bun run docs:check`：通过（场景索引无 diff）。
- 本次无代码改动，未跑 `bun test`/`typecheck`；合并前按项目门禁另行执行。
