---
layer: plan
module: global
status: current
updated: 2026-11-08
---

# 路线图

## 当前状态

- 项目骨架已初始化；CLI 只提供 `help`/`version`，`serve`/`run`/`doctor` 尚未实现。
- 当前目标：S0 本地执行闭环，验证 DSH 技能可见性与 session 生命周期。
- 已完成 DSH ACP 对接预研并归档：启动方式、协议序列、权限/取消/关闭边界与本机版本基线，见 `docs/history/works/2026-11-03-dsh-acp-preflight/result.md`。
- 已完成 S0 P0 阻断项验证（12 项 11 通过）：技能根/格式、写入时机、每节点替换、根隔离、脚本权限、并发、项目根均成立；崩溃遗留孤儿进程（S0-11）未通过，见 `docs/works/2026-11-03-s0-acp-verification/result.md`。
- 已完成 ACP 会话记录与跨 profile 可见性调研：session 记录按 `DSH_HOME` 归属、不按 profile；共用 home 会被 web/desktop 的 `session/list` 读取，首次初始化还会被 workspace bootstrap 采纳；专用 home 才能满足「desktop/web 看不到」，见 `docs/works/2026-11-03-acp-session-records/result.md`。
- 已完成客户端概念设计（P1 确认、冻结并归档）：对外两个面、9 组件、关键不变量（概念设计 13 条，组件规格补至 16 条）、多仓库容器、心跳长轮询兼控制事件；现行真相见 `docs/design/architecture.md`。
- 新增需求 `REQ-0001`（ACP 模式可配置 `DSH_HOME`，默认 `<运行目录>/AF_DSH_HOME`）：已 accepted，验收并入 `SCN-0002`（配置矩阵）与 `SCN-0001`（端到端 home 落点），见 `docs/requirements/REQ-0001-acp-dsh-home-config.md`。
- 已建 `SCN-0002`（配置 client 并完成自检）与 `SCN-0001`（执行节点并回传结果）：配置/自检 3+1 与执行 31 用例；`REQ-0002` R-03（取消立即强杀）与 R-04（崩溃等调度器重派）已锁定，其余阈值留 M1。见 `docs/design/scenarios/execution-plane/run-preparation/configure-and-self-check/scenario.md`、`docs/design/scenarios/execution-plane/node-execution/execute-node-and-report/scenario.md` 与 `docs/requirements/REQ-0002-execution-reliability.md`。
- 已完成调度器契约提案并归档（2026-11-07，审核通过）：7 个契约面、20 条 `SCH`、13 条 `CLT`、`cleanupPending`/`SCH-20` 等全部收口；见 `docs/history/works/2026-11-04-scheduler-contract-proposal/result.md`。
- 已完成组件级规格（2026-11-04；2026-11-07 评审通过）：9 份 `docs/design/components/<id>/spec.md`，覆盖组件内部功能、端口签名、状态机、错误分类、数据所有权与验证计划；评审处置见 `docs/history/works/2026-11-07-m1-contract-freeze/review.md`。
- 已完成 M1 契约冻结并归档（2026-11-07）：`docs/design/contracts/executor-http-v1.md`（frozen，`protocolVersion = 2026-11-07.1`）；字段级权威唯一，组件规格只写端口与失败收口。

## 里程碑

| 阶段 | 目标 | 出口 |
|---|---|---|
| S0 | 本地执行闭环（不接调度器） | 假任务可建 session、刷新技能、执行 prompt、取结果；`SCN-0002` 3+1、`SCN-0001` S0 用例与 `REQ-0002` R-03、R-04（S0 清理部分）门禁通过 |
| S1 | 契约骨架 | 注册/心跳/领取/session 绑定/结果上报接桩调度器；单节点跑通 |
| S2 | 线性多节点与并发 | 两节点顺序执行；fan-out 共享容器与技能集；取消（实例级整体终止）、重试、恢复 |
| S3 | 安全与交付 | 凭据、完整性、日志、打包与目标平台验证 |

## 依赖

- S0 不依赖调度器，可独立开始。
- S1 依赖的字段级契约已于 2026-11-07 冻结（`design/contracts/executor-http-v1.md`），S1 可直接按它实现与建桩。
- 上游边界设计：`../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`。

## 下一步工作计划

> 当前唯一活跃工序：`docs/works/2026-11-06-observability-http/`（观测 HTTP P1 设计稿）；M1 已归档。

### 批次 1：S0 本地执行闭环（进行中，最高优先级）

目标：不接调度器，用 `run` + `LocalSchedulerAdapter` 跑通「容器校验 → 建 session → 装技能 → prompt → 结果」；出口是 `SCN-0002` 3+1、`SCN-0001` S0 用例、`REQ-0002` R-03/R-04。

建议拆成 6 个工序（按组件切，避免跨组件任务超预算，`AH-07`）：

| 顺序 | 工序 | 组件 | 出口 |
|---|---|---|---|
| 1 | 配置与骨架 | `CMP-cli`（命令/配置/组合根/退出码）+ `CMP-store`（journal 骨架） | `serve`/`run`/`doctor`/`version` 可跑；配置矩阵 `TC-CONFIG-001`…`004` |
| 2 | 运行目录与状态 | `CMP-store`、`CMP-observability` | journal 追加/重建/锁；日志与脱敏；`doctor` 渲染 |
| 3 | 容器与技能 | `CMP-workspace`、`CMP-assets` | 容器校验、`.dsh/skills` 原子替换、digest 幂等 |
| 4 | DSH 执行 | `CMP-runtime` | ACP 建 session/prompt/取消/进程组回收；S0-11 崩溃孤儿修复 |
| 5 | 执行内核 | `CMP-executor`、`CMP-result` | 状态机、`reconcileCleanup`、结果组装与截断 |
| 6 | S0 门禁 | 全部 | `SCN-0002` 3+1、`SCN-0001` S0 用例、R-03/R-04 |

开工前置已清：`OQ-024` 映射见 `docs/design/test-matrix.md`；`OQ-014` 配置键与 `stateRoot` 默认已冻结（`CMP-cli` §2.3）。

### 批次 2：S1 契约骨架（与批次 1 并行）

目标：接桩调度器，跑通单节点全链路。

| 顺序 | 工序 | 产出 |
|---|---|---|
| 1 | 桩调度器 + 契约测试骨架 | 按契约附录 A；覆盖幂等、长轮询、错误码、`cleanupPending` |
| 2 | `CMP-gateway` 实现 | `claimRequestId`、run 作用域事件、`cleanupAcks`、`run_superseded` |
| 3 | `CMP-cli` 循环接线 | `serve` 主循环、`lockInstance` 取锁、心跳状态快照、清理对账 |
| 4 | `CMP-executor`/`CMP-assets` 接线 | `bindSession` 取技能集、`C-05` 下载、`reportResult` |
| 5 | S1 门禁 | `proposal.md` §14.3 的 7 条 |

### 批次 3：观测 HTTP P1 收尾（独立轨道）

- 现处 P1 设计稿，`OB-01` 风险已确认接受；下一步是 P1 回填 `architecture.md`、`CMP-observability`、`CMP-runtime`、`CMP-cli`，再拆实现。
- 不与 S0/S1 争同一批组件改动；建议在 S1 核心稳定后插入。

### 批次 4：S2 / S3

- S2：线性多节点、fan-out 共享容器、实例级取消、重试与恢复；届时评估 Q1 是否切 B（需改 `SCH-19` + 升 `protocolVersion`）。
- S3：凭据、完整性、TLS/轮换、打包与目标平台验证。

### 待办与阻塞

| 项 | 影响 | 处理 |
|---|---|---|
| ~~`OQ-014` 配置键 / `stateRoot` 默认~~ | 已关闭（2026-11-08） | `CMP-cli` §2.3 |
| ~~`OQ-024` UC→测试映射~~ | 已关闭（2026-11-08） | `docs/design/test-matrix.md` |
| `OQ-021` 结果保留窗口 | journal 磁盘增长 | S1 实测后定 |
| `OQ-025` `CleanupAck.failed` 终止规则 | 调度器侧永久重发 | 调度器 follow-up，不阻塞 client |
| `AH-07` 组件预算 | 跨组件任务超装载 | 按组件拆工序，已体现在批次 1 的 6 个工序 |

ACP 预研、S0 P0 验证、会话记录调研均已收口；概念设计已确认、冻结并归档。S0 以冻结稿的不变量与 S0 用例为输入（`docs/history/works/2026-11-03-client-concept-design/`），并按 `SCN-0002`/`SCN-0001`/`REQ-0002` 收敛；「配置校验与 `doctor`」「取消立即强杀 + 进程组回收」「崩溃清理 + 等重派 + 已产生结果重报」「一实例一 home + 只展示本实例 session」已写入组件规格，S0 按规格实现。
