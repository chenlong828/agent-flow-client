---
layer: works
module: global
status: frozen
updated: 2026-11-17
procedure: 2026-11-17-progress-feedback-closeout
level: P2
---

# 工序：执行过程可见性收口（5s 模式 C 暂停，改消费方拉取）

> 来源：2026-11-14 ACP 过程信息调研（`docs/history/works/2026-11-14-acp-progress-feedback/`）识别出的落地工作一直未实施；2026-11-17 观测面 v1 落地后，用户确认不再做 5s 推送，改由 UI 主动发起、经调度器产品 API 拉取观测面。
> 定级：**P2**（现行设计文档与跨项目方向收口；无契约、无代码改动）。用户 2026-11-17 确认方向与本次范围（只落文档）。

## 1 问题与目标

调研识别出的阶段 0（`lastEventAt`）与阶段 1（5s `ProgressSnapshot` + 模式 C）一直没有实施；2026-11-17 落地的观测面（O-01–O-11）覆盖的是"按需看详情"。两者之间没有收口记录，导致：

- 归档件仍写"待确认 C1–C6 后进入实现"，读起来像待办；
- 现行架构仍写"调度器不主动连 client"，与观测面入站拉取矛盾；
- `CMP-observability` 仍列着未实现的 `progress` 能力；
- 路线图与开放问题没有结论。

目标：用一份决策记录 + 现行文档回填，明确"5s 模式 C 暂不实施、执行期可见性由消费方主动拉取观测面"，并给原调研的展示目标逐项归属。

## 2 范围

| 做 | 不做 |
|---|---|
| 决策记录（`history/decisions/`） | 改 client 代码 |
| 回填 `architecture.md`、`CMP-observability`、`CMP-observer` | 改调度器/UI 代码 |
| 同步 `plan/roadmap.md`、`plan/open-questions.md`、`docs/README.md` | 新增/修改契约 |
| 把 UI 接入、死代码清理、`lastEventAt` 列为后续项 | 实现 5s 推送或进度端点 |

## 3 任务表

| ID | 类型 | 组件 | 内容 | 状态 | 装载 |
|---|---|---|---|---|---|
| T-01 | decision | global | 记录 5s 模式 C 暂停、拉取方向、边界与未决 | 完成 | 本 brief |
| T-02 | design | architecture / CMP-observability / CMP-observer | 回填现行真相：拉取面、职责、冷热路径、不做项 | 完成 | T-01 |
| T-03 | plan | global | `roadmap.md`、`open-questions.md` 同步（OQ-028） | 完成 | T-01 |
| T-04 | docs | global | `README.md` 导航与归档 | 完成 | T-02/T-03 |
| T-05 | docs | works | `review.md`、`result.md` 与归档 | 完成 | T-01–T-04 |
| T-06 | handoff | UI | 会话 Tab/节点摘要：经产品 API 拉取并按事件聚合（外部项目） | 待外部 | T-02 |
| T-07 | backlog | client | `lastEventAt`、死代码清理、OQ-022 旧口径 | 转待办 | T-03 |

## 4 验收标准

1. 现行文档中没有"5s 模式 C 待确认/待实现"的表述；归档件保持原样，由决策记录与 README 指向。
2. `architecture.md` 能回答：执行期过程信息从哪来、谁发起、走哪条边界、失败如何隔离。
3. 原调研目标 1 的 5 项（阶段、当前工具与耗时、最新叙述、最近活动、上下文水位）逐项有归属：拉取 + 消费方聚合，或明确不做。
4. 不新增/修改契约，不改 client/调度器/UI 代码。
5. 遗留项有去向（UI 交接、`open-questions` 或待办）。

## 5 领取的开放问题

- 原调研 §15 的 C1–C6：随本决策失效，不再等待确认。
- 新增 OQ-028：执行期可见性用推送还是拉取（本工序关闭）。
- OQ-022（观测面绑定地址/token）：仍为 `0.0.0.0` 旧口径，转 T-07。
