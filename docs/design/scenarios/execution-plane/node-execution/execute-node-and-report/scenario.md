---
layer: design
module: execution-plane
status: designed
updated: 2026-11-04
flow: FLOW-EXEC-001
scenario: SCN-0001
domain: 执行面
valueStream: 节点执行
title: 执行节点并回传结果
entries: []
docs:
  - path: docs/design/architecture.md
    heading: 5. 主流程
  - path: docs/design/architecture.md
    heading: 6. 关键不变量
  - path: docs/design/architecture.md
    heading: 10. 失败与恢复
  - path: docs/requirements/REQ-0001-acp-dsh-home-config.md
    heading: 5. 影响场景
  - path: docs/requirements/REQ-0002-execution-reliability.md
    heading: 4. 可靠性需求
tests:
  - role: R1
    id: TC-EXEC-001
  - role: R2
    id: TC-EXEC-002
  - role: R3
    id: TC-EXEC-003
  - role: N1
    id: TC-EXEC-004
---

# 执行节点并回传结果

## 1. 场景与价值

调度器把可执行节点下发给 client；client 在本机准备容器、建 session、装配技能、下发 prompt，最后把少量控制结果回传给调度器。

结果：节点执行完成，调度器拿到可判定的 `NodeResult`。

角色与阶段：

- 生产：调度器 `claim` 下发 `NodeRequest`，client 通过 `serve` 领取并执行。
- S0 替身：调度器未接入，开发者用 `run --request` 提交同一形状的本地请求；只是触发方式不同，不构成第二个场景。

本场景不覆盖编排决策（下一节点、评审、分支、fan-out 拆分、回退）、产物上传、跨 client 迁移和 UI。

## 2. 入口

入口待实现。计划入口以组件 ID 表示，落地后回填 `entries`：

- `CMP-cli`：`run`（S0 单次替身）/ `serve`（S1 常驻领取）。
- `CMP-executor`：`executeNode` 用例，负责尝试状态机与顺序。
- `CMP-runtime` / `CMP-workspace` / `CMP-assets` / `CMP-result`：由组合根注入端口实现。

S0 的 `run --request` 是替身触发；不新增第二个场景。

## 3. 运行序

流程定义：`FLOW-EXEC-001`。

1. 接收/领取：S0 读取本地 `NodeRequest`；S1 `claim` 取绑定本 client 的节点并持有租约。
2. 准备：`CMP-workspace` 校验预置容器；`CMP-runtime` 确保实例 DSH 进程（独立 `DSH_HOME`、受控 profile）。
3. 建 session：`cwd` 固定为容器根；S1 上报 `sessionId`。
4. 取技能集：S0 从本地请求内联；S1 `bindSession` 取得该节点技能集。
5. 刷技能：`CMP-assets` 原子替换容器根 `.dsh/skills`，脚本赋权；按 digest 幂等。
6. 执行：下发 prompt，消费 ACP 事件（文本、工具、usage、权限请求）。
7. 结算：`CMP-result` 组装 `NodeResult`；S1 按 `attemptId` 幂等上报，S0 输出到 stdout。
8. 收尾：关 session；实例结束或取消时关进程、按策略清理容器与 `DSH_HOME`。

失败路径：

- 容器非法/路径越界：不 prompt，节点失败（工作区类）。
- 技能获取/校验/替换失败：原子回滚，不 prompt，节点失败（资产类）。
- DSH 启动/ACP 会话失败：关坏 session，必要时杀进程组，节点失败（运行时类）。
- prompt 超时/取消：`session/cancel` → 立即关 session、强杀进程组，报 `timeout` / `cancelled`；prompt 已先结算则按实际结果上报。
- 网络/租约：传输退避；租约过期丢弃尝试；迟到结果只入审计。
- 崩溃/重启：清理孤儿与残留 session，重新注册，等调度器重新下发；client 不自动重跑。

## 4. 不可变引用

- ACP v1 序列：`session/new`、`session/prompt`、`session/update`、`session/cancel`、`session/close`。
- DSH 基线：`dsh 0.2.2-alpha.2`（S0 实测）；升级前复跑关键用例。
- `DSH_HOME` 语义：session 按 home 归属，不按 profile；client 只读/清理本实例 home。
- DSH session 存储格式：只作为排障与目录真值，不作为 client 契约。
- 调度器字段契约：S1 起以 M1 冻结为准，client 不自定义字段。

配置与自检场景见 `SCN-0002`；本场景只断言“执行时使用生效配置的 home 落点”，不重复配置矩阵。

## 5. 用例矩阵

> 3 正 1 反是场景验收最小集；本节是稳定性/可靠性回归矩阵，不替代 3+1。

### A. 正常执行

| ID | 用例 | 期望行为 | 阶段 |
|---|---|---|---|
| UC-01 | 单节点执行 | 一份 `NodeResult`，session 关闭，退出 0 | S0/S1 |
| UC-02 | 顺序多节点 | 第二节点只看到自己的技能，产物叠加，进程复用 | S0.1/S2 |
| UC-03 | fan-out 并发 | 分支结果不串、技能不覆盖 | S2 |
| UC-04 | 技能切换 | 替换不叠加，digest 幂等 | S0.1/S2 |

### B. 输入与环境故障

| ID | 用例 | 期望行为 | 阶段 |
|---|---|---|---|
| UC-05 | 容器非法 | `layout_invalid`/`path_escape`，不 prompt | S0 |
| UC-06 | 技能包异常 | 回滚无半套，不 prompt，节点失败 | S0 |
| UC-07 | 运行时不可用 | 明确错误类别，不误跑 | S0/S1 |
| UC-08 | 工作区不可写/磁盘满 | 节点失败，不破坏已有产物 | S0 |

### C. 执行中故障

| ID | 用例 | 期望行为 | 阶段 |
|---|---|---|---|
| UC-09 | prompt 超时 | 超时 → `session/cancel` → 立即强杀，报 `timeout` | S0/S1 |
| UC-10 | 工具失败/权限拒绝 | 拒绝兜底，模型收到可读结果，不挂起 | S0 |
| UC-11 | DSH 进程崩溃 | 关坏 session，杀进程组，报运行时错误 | S0 |
| UC-12 | 结果过大 | 截断并标记，结果仍可解析 | S1 |

### D. 控制与中断

| ID | 用例 | 期望行为 | 阶段 |
|---|---|---|---|
| UC-13 | 取消执行 | cancel → 立即关 session + 强杀进程组 → `cancelled`；已结算按实际结果上报 | S0/S2 |
| UC-14 | 关闭/二次信号 | 优雅收口；二次信号强杀并记录未收口尝试 | S0/S2 |

### E. 崩溃与恢复

| ID | 用例 | 期望行为 | 阶段 |
|---|---|---|---|
| UC-15 | client 崩溃重启 | 清孤儿/残留 session；重新注册；等调度器重新下发；不自动重跑 | S0（仅清理）/S2 |
| UC-16 | 孤儿进程 | 进程组/作业树清理，`kill -0` 为假 | S0 |
| UC-17 | 崩溃 session/lock | 不复用，不阻塞新 session | S0 |
| UC-18 | 重跑幂等 | 同一 `attemptId` 不重复执行；新 attempt 正常执行 | S0.1/S1 |

### F. 网络与调度（S1+）

| ID | 用例 | 期望行为 | 阶段 |
|---|---|---|---|
| UC-19 | 调度器不可达 | 退避重试；持续不可达退出 6 | S1 |
| UC-20 | 心跳长轮询断开 | 重连 + 补 `ackSeq`；租约过期裁决 | S1 |
| UC-21 | 租约过期/迟到结果 | 丢弃尝试；迟到结果只入审计 | S1 |
| UC-22 | 重复投递/上报 | attempt 幂等，返回已有结果 | S1 |
| UC-23 | 版本/鉴权失败 | 停止领取，退出 3 | S1 |

### G. 并发与资源

| ID | 用例 | 期望行为 | 阶段 |
|---|---|---|---|
| UC-24 | 同容器同技能集并发 | session 独立，事件不串 | S2 |
| UC-25 | 不同技能集并发 | `asset_skill_set_conflict`，不交错覆盖 | S2 |
| UC-26 | 多实例/容量上限 | 排队或拒绝，不超卖 | S1/S2 |
| UC-27 | 日志/结果/磁盘上限 | 轮转、截断、清理 | S1/S3 |

### H. 安全与隔离

| ID | 用例 | 期望行为 | 阶段 |
|---|---|---|---|
| UC-28 | 不可信路径 | `path_escape`，拒绝读写 | S0 |
| UC-29 | 不可信压缩包 | 拒绝/限额，不写工作区外 | S0/S3 |
| UC-30 | 凭据泄漏 | 脱敏，凭据不进边界 | S3 |
| UC-31 | 会话隔离 | client 只见本实例 session；home 不指向 `~/.dsh` | S0/S3 |

## 6. 可靠性需求与门禁

`R-01`…`R-10` 的定义、阈值和 owner 见 `docs/requirements/REQ-0002-execution-reliability.md` §4。本场景的门禁映射：

| 需求 | 覆盖用例 | 门禁 |
|---|---|---|
| R-01 不重复执行 | UC-18、UC-22 | 重复投递/重派测试 |
| R-02 结果不丢 | UC-01、UC-19、UC-21 | 结果上报重试测试 |
| R-03 中断收敛 | UC-13、UC-14 | 取消后进程残留冒烟 |
| R-04 崩溃可恢复 | UC-15、UC-16、UC-17 | 崩溃重启测试 |
| R-05 技能不串/不半套 | UC-04、UC-06、UC-25 | 技能替换/失败注入 |
| R-06 session 不复用 | UC-02、UC-17 | 顺序节点测试 |
| R-07 资源上限 | UC-12、UC-26、UC-27 | M1 阈值注入 |
| R-08 失败可分类 | UC-05–UC-11、UC-23 | 错误映射表 |
| R-09 可观测 | UC-15、UC-19 | 日志字段/doctor |
| R-10 安全边界 | UC-28–UC-31 | 路径/凭据/隔离测试 |

## 7. 测试映射

> UC → 测试文件的完整映射见 [`docs/design/test-matrix.md`](../../../../test-matrix.md)；本表列出的用例是首批锚点。

| 角色 | 测试 ID | 断言 |
|---|---|---|
| R1 | `TC-EXEC-001` | 单节点成功：`NodeResult`、usage、退出 0；会话落 client home，`~/.dsh/sessions` 无新增 |
| R2 | `TC-EXEC-002` | 顺序两节点：第二节点只看到自己的技能，进程复用 |
| R3 | `TC-EXEC-003` | 取消/关闭：`cancelled`，无残留进程/session |
| N1 | `TC-EXEC-004` | 技能校验失败/容器非法：不 prompt，无半套 |

补充：UC-01…UC-31 的实现测试 ID 在 S0/S1/S2 任务中分配。3+1 全过且对应阶段可靠性门禁全过，才可从 `designed` 升到 `verified`；实现测试未全绿前不升。

配置矩阵与 `doctor` 检查归 `SCN-0002`；这里的 home 断言是端到端落点，不是配置校验的替代。

## 8. 覆盖边界

| 阶段 | 覆盖 |
|---|---|
| S0 | UC-01、05、06、07、08、13、14、15（仅清理）、16、17、28、29、31（部分） |
| S0.1 | UC-02、04、18 |
| S1 | UC-12、19–23、26、27 |
| S2 | UC-03、15（重派后执行）、24、25 |
| S3 | UC-27（完整）、29（完整）、30、31（完整） |

不覆盖：编排决策、评审、fan-out 拆分、产物上传、跨 client 迁移、UI、多实例 home 派生（OQ-009）。

## 9. 变更记录

| 时间 | 变更 |
|---|---|
| 2026-11-03 | 场景从“本地单节点/顺序两节点”两个候选收敛为一个；单节点/顺序/fan-out 改为用例。 |
| 2026-11-03 | 取消改为 `session/cancel` 后立即强杀，不等结算。 |
| 2026-11-03 | 崩溃重启改为清理 + 等调度器重派，client 不自动重跑。 |
| 2026-11-03 | 结果/日志/并发上限留 M1，测试用可注入小值。 |
| 2026-11-04 | 配置矩阵与 `doctor` 拆到 `SCN-0002`；本场景只保留执行时 home 落点的端到端断言。 |
