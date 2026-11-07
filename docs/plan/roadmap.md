---
layer: plan
module: global
status: current
updated: 2026-11-07
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
- 已完成组件级规格（2026-11-04，P1，待确认）：9 份 `docs/design/components/<id>/spec.md`，覆盖组件内部功能、5 个端口签名、尝试状态机、错误分类、数据所有权与验证计划；跨组件契约总览见 `docs/design/architecture.md` §4，确认记录见 §13。确认前不写实现代码。

## 里程碑

| 阶段 | 目标 | 出口 |
|---|---|---|
| S0 | 本地执行闭环（不接调度器） | 假任务可建 session、刷新技能、执行 prompt、取结果；`SCN-0002` 3+1、`SCN-0001` S0 用例与 `REQ-0002` R-03、R-04（S0 清理部分）门禁通过 |
| S1 | 契约骨架 | 注册/心跳/领取/session 绑定/结果上报接桩调度器；单节点跑通 |
| S2 | 线性多节点与并发 | 两节点顺序执行；fan-out 共享容器与技能集；取消（实例级整体终止）、重试、恢复 |
| S3 | 安全与交付 | 凭据、完整性、日志、打包与目标平台验证 |

## 依赖

- S0 不依赖调度器，可独立开始。
- S1 起依赖调度器侧字段级契约冻结；契约权威在调度器，client 不自行定义字段。
- 上游边界设计：`../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`。

## 进行中工序

- `docs/works/2026-11-04-scheduler-contract-proposal/`：调度器契约提案（P1，调度器评审「有条件通过」；v0.4 已处置两轮评审 RB/RD/ND-01～ND-06，待调度器收口）；S1 前需裁决 §15 的 Q1/Q2/Q3/Q5/Q6/Q7，M1 冻结前需清 Q13～Q16。
- `docs/works/2026-11-06-observability-http/`：client 只读观测 HTTP 的 P1 设计稿（`/api/v1/observability`：当前/历史日志、SSE、DSH session 归档与 raw 下载）；调度器附评 `OB-01`–`OB-09` 已处置，`OB-01` 明文传 raw 为已接受风险；待 P1 确认后回填 `design/`。
- 组件规格已出，等待 P1 确认；确认后立项 S0 本地执行闭环（`docs/works/<日期>-s0-local-loop/`），按 `SCN-0002` / `SCN-0001` 的 S0 用例拆任务。

ACP 预研、S0 P0 验证、会话记录调研均已收口；概念设计已确认、冻结并归档。S0 以冻结稿的不变量与 S0 用例为输入（`docs/history/works/2026-11-03-client-concept-design/`），并按 `SCN-0002`/`SCN-0001`/`REQ-0002` 收敛；「配置校验与 `doctor`」「取消立即强杀 + 进程组回收」「崩溃清理 + 等重派 + 已产生结果重报」「一实例一 home + 只展示本实例 session」已写入组件规格，S0 按规格实现。
