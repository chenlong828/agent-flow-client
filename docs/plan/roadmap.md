---
layer: plan
module: global
status: current
updated: 2026-11-03
---

# 路线图

## 当前状态

- 项目骨架已初始化；CLI 只提供 `help`/`version`，`serve`/`run`/`doctor` 尚未实现。
- 当前目标：S0 本地执行闭环，验证 DSH 技能可见性与 session 生命周期。
- 已完成 DSH ACP 对接预研并归档：启动方式、协议序列、权限/取消/关闭边界与本机版本基线，见 `docs/history/works/2026-11-03-dsh-acp-preflight/result.md`。
- 已完成 S0 P0 阻断项验证（12 项 11 通过）：技能根/格式、写入时机、每节点替换、根隔离、脚本权限、并发、项目根均成立；崩溃遗留孤儿进程（S0-11）未通过，见 `docs/works/2026-11-03-s0-acp-verification/result.md`。
- 已完成 ACP 会话记录与跨 profile 可见性调研：session 记录按 `DSH_HOME` 归属、不按 profile；共用 home 会被 web/desktop 的 `session/list` 读取，首次初始化还会被 workspace bootstrap 采纳；专用 home 才能满足「desktop/web 看不到」，见 `docs/works/2026-11-03-acp-session-records/result.md`。
- 已完成客户端概念设计（P1 确认、冻结并归档）：对外两个面、9 组件、13 条不变量、多仓库容器、心跳长轮询兼控制事件；现行真相见 `docs/design/architecture.md`。

## 里程碑

| 阶段 | 目标 | 出口 |
|---|---|---|
| S0 | 本地执行闭环（不接调度器） | 假任务可建 session、刷新技能、执行 prompt、取结果；验证 DSH 在 prompt 时读取技能 |
| S1 | 契约骨架 | 注册/心跳/领取/session 绑定/结果上报接桩调度器；单节点跑通 |
| S2 | 线性多节点与并发 | 两节点顺序执行；fan-out 共享容器与技能集；取消（实例级整体终止）、重试、恢复 |
| S3 | 安全与交付 | 凭据、完整性、日志、打包与目标平台验证 |

## 依赖

- S0 不依赖调度器，可独立开始。
- S1 起依赖调度器侧字段级契约冻结；契约权威在调度器，client 不自行定义字段。
- 上游边界设计：`../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`。

## 进行中工序

- 无。概念设计已收口，下一步立项 S0 本地执行闭环（`docs/works/<日期>-s0-local-loop/`）。

ACP 预研、S0 P0 验证、会话记录调研均已收口；概念设计已确认、冻结并归档。S0 以冻结稿的不变量与 S0 用例为输入（`docs/history/works/2026-11-03-client-concept-design/`）；实现前需把「崩溃清理」和「一实例一 home + 只展示本实例 session」纳入进程/session 设计。
