---
layer: works
module: global
status: active
updated: 2026-11-07
---

# 设计评审记录与处置（架构 + 组件规格）

> 评审对象：`docs/design/architecture.md` 与 `docs/design/components/*/spec.md`（M1 落盘后版本）。
> 评审原文：`../../../../agent-flow-orchaster/docs/works/2026-11-07-client-architecture-review/review.md`（P1）。
> 结论：**通过**。首轮 4 条 Blocker + 5 条 Decision now 已落稿；第二轮复核新增的 `NB-01`、`ND2-01`、`ND2-02` 也已补齐，`ND2-03`–`ND2-06` 按建议记录/部分落稿，不再需要新一轮评审。

## 1. 总览

| 档位 | 数量 | 处置 |
|---|---:|---|
| Blocker（`AB-01`–`AB-04`） | 4 | 全部修复，已改 `design/` |
| Decision now（`AD-01`–`AD-05`） | 5 | 全部修复 |
| Hold（`AH-01`–`AH-08`） | 8 | `AH-01/03/04/05/06` 已落稿；`AH-02` 随 OQ-014；`AH-07/08` 排 S0 时处理 |

## 2. Blocker 处置

| ID | 处置 | 落点 |
|---|---|---|
| `AB-01` `heartbeat` 入参跨三个所有者 | 端口改为 `heartbeat(state: ClientState, acks?: CleanupAck[]) → HeartbeatOutcome`；`ackSeq`/`clientLease` 留在 gateway 传输层；新增 `executor.snapshotAttempts()`；`HeartbeatRequest`/`HeartbeatResult`/`Registration` 只作 HTTP 线格式 | executor §2.1/§3.4、contract §6.6、gateway §2.2/§3.1、cli §2.4.6 |
| `AB-02` `JournalPort` 三份签名 | 以 executor §3.4 为唯一定义；store §3.1 改为实现视图并补齐 9 个方法；architecture §4.2 改为引用不再复制 | store §3.1、architecture §4.2 |
| `AB-03` 技能冲突两个 `code` | 统一为 `asset_skill_set_conflict`；改 assets/result/executor 与 `SCN-0001` UC-25 | assets §2.5/§3.3、result §2.2、scenario UC-25 |
| `AB-04` 实例终结有两个主人 | 实例终结与 `cleanupPending` 对账收进 `executor.reconcileCleanup`；CLI 只搬运与回执，不再调 `RuntimePort`/`WorkspacePort` | executor §2.1/§2.4.11、cli §2.4.4/§2.4.10/§3.2、architecture §4.3/§9 |

## 3. Decision now 处置

| ID | 处置 | 落点 |
|---|---|---|
| `AD-01` `prompt_failed` 两类别 | 拆两行：`protocol_error` → `protocol`；`prompt_failed` → `runtime` | result §2.2 |
| `AD-02` 截断与上限矛盾 | 先预留 15 字节标记再截断；含标记 ≤ `maxBytes`；补 `maxBytes < markerBytes` 边界 | result §2.3/§3.3/§7 |
| `AD-03` `<stateRoot>` 多写者 | architecture §7 分区登记：journal/locks/orphans → store；cache → assets；logs → observability；互不读写 | architecture §7 |
| `AD-04` `lockInstance` 无调用点 | CLI 在 `claim` 成功后取锁，`closed`/`abandoned` 后释放；失败报 `failed(workspace)` | cli §2.4.8、executor §3.4 |
| `AD-05` `DSH_HOME` 归属三说 | CLI 创建/校验；runtime 独占写入；`shutdownInstance` 内删除，失败留给 `doctor` | architecture §7、runtime §2.6/§5、cli §2.3 |

## 4. Hold 处置

| ID | 处置 |
|---|---|
| `AH-01` `--concurrency` 与 `maxInstances` | 删除 `--concurrency`；容量只来自配置 `capacity.maxInstances`（OQ-014） |
| `AH-02` `stateRoot` 默认在系统目录 | 记入 cli §9，随 OQ-014 定默认 |
| `AH-03` 日志 phase 缺 `abandoned` | observability §2.1 补 `abandoned` |
| `AH-04` 多 session 取消在 A 方案不可达 | 不变量 5/11 标注「v1 A 方案下不可达，S2/B 生效」 |
| `AH-05` L1b 持有传输类型 | executor §3.5 声明 `ports.ts` 分两区；继续增长则 S1 抽 L0 小模块 |
| `AH-06` 两套 HTTP 栈 | gateway/assets 标注共用 `SchedulerEndpoint` 的 host/TLS/超时配置，S1 联调核对 |
| `AH-07` 预算合计偏高 | 排任务按组件切；跨组件任务先拆 |
| `AH-08` 缺 UC→测试映射 | architecture §4.7 记「S0 开工前补」，不在本轮造表 |

## 5. 待复核

1. `AB-01` 的端口裁剪（`HeartbeatOutcome` + `snapshotAttempts`）是否接受；
2. `AB-04` 的 `reconcileCleanup` 归属与 CLI 只做搬运是否接受；
3. `AD-03`/`AD-05` 的 `stateRoot` 分区与 `DSH_HOME` 删除归属是否接受；
4. `AH-08` 的 UC→测试映射表放在 S0 工序是否可接受。


## 6. 第二轮复核（2026-11-07）

调度器侧复核 `8e3c168` 后判「通过，条件一处补字段」，新增 `NB-01`、`ND2-01`/`ND2-02` 与 `ND2-03`–`ND2-06`。处置如下。

| ID | 档位 | 处置 | 落点 |
|---|---|---|---|
| `NB-01` | Blocker | **成立**，但采用评审给的第二方案：`assignments`/`assignmentsVersion` 留在 CLI 的容器视图，不裁给 gateway。`ClientState` 增加 `assignmentsVersion`；`HeartbeatOutcome` 增加 `assignmentsVersion` + `assignments?`；gateway 只透传。这样 gateway 不需要理解 assignment 语义，CLI 仍能在运行期替换快照 | contract §6.6、executor §3.4、cli §2.4.6、gateway §3.1 |
| `ND2-01` | Decision now | 成立。result §2.2 补 store/journal 来源：`locked` → `workspace`/false、`corrupt` → `internal`/false、journal `io_error` → `internal`/true；assets 的 `io_error` 标注按来源区分 | result §2.2 |
| `ND2-02` | Decision now | 成立。CLI §2.4.9 补：事件先到、无 pending 时用 `{releaseId, instanceId, cleanup}` 合成，`workspacePath` 缺失由 executor 回查 journal | cli §2.4.9、executor §2.1 |
| `ND2-03` | Hold | 成立，补一句：去重只是进程内优化；正确性依赖 cleanup/releaseId 幂等，崩溃后重复执行可接受 | executor §2.1 |
| `ND2-04` | Hold | 成立，`CleanupReconciler` 加入 executor 内部结构与 architecture §4.4 | executor §2.8、architecture §4.4 |
| `ND2-05` | Hold | 成立，标注 `snapshotAttempts` 是观测快照，允许与容量计数瞬时偏差 | cli §2.4 |
| `ND2-06` | Hold | 成立，但属调度器侧行为：记 `OQ-025`，契约补 follow-up 注记，不改 client 回执语义 | contract §5.2、open-questions OQ-025 |

### 6.1 对 `NB-01` 推荐方案的判断

评审推荐「`assignments` 补进 `HeartbeatOutcome`；`assignmentsVersion` 由 gateway 截留、回传」。**问题成立，但推荐方案不是最优**：`assignments` 是 CLI 的容器视图，`assignmentsVersion` 是这个视图的游标，不是传输层状态。让 gateway 持有游标，会把 assignment 语义泄漏进 L0 传输组件，CLI 反而失去「我看到的快照是哪一版」的判断依据。

因此本稿采用评审的第二方案并补齐：`ClientState.assignmentsVersion` + `HeartbeatOutcome.assignmentsVersion/assignments?`，gateway 只透传。两方案都能闭合 `NB-01`；第二方案与 `AB-01` 的「按所有者裁剪」原则更一致。
