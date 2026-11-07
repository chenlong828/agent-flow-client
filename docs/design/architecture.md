---
layer: design
module: global
status: current
updated: 2026-11-07
---

# 执行面客户端架构

> 范围：client 的对外接口面、组件切分、主流程、数据所有权与关键不变量。字段级契约、DSH/ACP 细节与实现细节不在本文。
>
> 调度器契约的字段级权威：[`contracts/executor-http-v1.md`](contracts/executor-http-v1.md)（frozen，`protocolVersion = 2026-11-07.1`）。本文只定接口面与跨组件关系，**不复述字段**。
>
> 设计过程与取舍见 `docs/history/works/2026-11-03-client-concept-design/`（历史记录，不作为现行依据）。
>
> 上游边界与职责：`../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`。

## 1. 定位

- client 是**执行面**：把调度器下发的节点在本机执行出来，只回少量控制信息；编排决策全部在调度器。
- 单进程 Bun CLI：常驻 `serve` 与单次 `run` 共用一个执行内核；**不提供本地控制面 HTTP 服务或 IPC**。只读观测面是独立 P1（未定稿，见 §12），不属于当前真相。
- 跨边界只走 HTTP，client 主动出站；调度器不主动连 client。编排事件随 client 的心跳长轮询下发。

## 2. 运行模型

| 维度 | 规则 |
|---|---|
| 进程 | 一个 client 进程；`serve` 常驻，`run` 单次；同一执行内核 |
| 实例 | 一个实例一个 DSH 进程；client 可同时承载多个实例，受容量限制 |
| session | 一个可执行节点一个 session；建 session → 上报 id → 取技能集 → prompt；用完即关，不复用 |
| 工作区 | 一实例一个**容器**：准备阶段预置，含 0..N 个带 `.git` 的仓库；顺序节点共享；fan-out 分支共享同一容器与同一技能集 |
| 技能 | 节点级集合；落地在容器根 `.dsh/skills`；刷新是替换，按 digest 幂等 |
| 容量 | 按**实例数**上报（`maxInstances` / `activeInstances`）；同一实例同一时刻只跑一个 attempt，fan-out 在 client 侧串行（契约 §11 方案 A，`SCH-19`） |
| 心跳 | 30s 长轮询，兼作控制事件通道；请求到达即续租，租约过期裁决离线 |
| 取消 | 实例级整体取消（含整个 fan-out），立即终止，不等跑完 |

## 3. 对外接口面

### 3.1 调度器契约面（client 是消费方，权威在调度器）

| 契约面 | 操作 | 目的 |
|---|---|---|
| `C-01` 注册 | `register` | 身份、版本、容量、`limits`；可选 `assignments`；`cleanupPending` |
| `C-02` 心跳 + 控制 | `heartbeat`（长轮询） | 续租、上报状态、收控制事件、`cleanupAcks` |
| `C-03` 领取 | `claim`（长轮询） | 取绑定本 client 的 `NodeRequest`；`claimRequestId` 幂等 |
| `C-04` 会话绑定 | `bindSession` | 上报 `sessionId`；返回该节点技能集（不含租约） |
| `C-05` 技能包 | `GET …/download` | `CMP-assets` 直连下载（不经 gateway） |
| `C-06` 续租 | `renew` | 尝试租约，TTL/3 一次 |
| `C-07` 结果上报 | `reportResult` | 少量结果与错误类别，按 `attemptId` 幂等 |

字段、状态码、错误码、枚举、幂等规则全部以 [`contracts/executor-http-v1.md`](contracts/executor-http-v1.md) 为准；client 只实现消费端，不自定义字段。控制面只出站，调度器不主动连 client。

### 3.2 CLI 操作面

`serve` / `run` / `doctor` / `version`；配置启动时一次性加载、校验、冻结。退出码：`0` 成功、`1` `run` 产生非成功节点结果（failed/cancelled/timeout）、`2` 用法/配置、`3` 鉴权或版本不兼容、`4` DSH/运行时、`5` 工作区或资产、`6` 调度器不可达、`7` `run_superseded`（本 run 被更新 run 顶掉）、`130` SIGINT、`143` SIGTERM。`run` 的 stdout 只输出 `NodeResult` JSON，日志走 stderr。SIGINT/SIGTERM：停止领取 → 取消活跃尝试 → flush journal → 关 session/进程 → 退出；第二次信号强杀并记录未收口尝试。

## 4. 组件与分层

| 层 | 组件 | 职责 |
|---|---|---|
| L2 | `CMP-cli` | 命令与配置、`serve` 循环、组合根装配、信号与退出码 |
| L1b | `CMP-executor` | 节点尝试状态机、定义 5 个端口、attempt 幂等、取消/超时分岔、技能刷新幂等 |
| L1a | `CMP-result` | `NodeResult` 组装、错误分类、结果截断（纯策略） |
| L0 | `CMP-gateway` | `SchedulerPort`、HTTP 长轮询与重连、鉴权、版本协商、幂等键、租约计时 |
| L0 | `CMP-runtime` | DSH 进程、实例 profile 补丁、ACP session 与事件、取消与进程回收 |
| L0 | `CMP-workspace` | 容器校验、`.dsh/skills` 安装点、路径约束、清理 |
| L0 | `CMP-assets` | 技能包获取/校验、原子替换、脚本赋权、缓存与失效 |
| L0 | `CMP-store` | journal、实例锁、孤儿进程记录 |
| L0 | `CMP-observability` | 结构化日志、`doctor`、脱敏、可选进度事件 |

端口（`SchedulerPort` / `RuntimePort` / `WorkspacePort` / `AssetPort` / `JournalPort`）全部定义在 `CMP-executor`，L0 实现并在组合根注入。依赖方向：L2 → L1 → 端口 ← L0，L0 之间不横向调用。

### 4.1 组件规格索引

| 层 | 组件 | 规格 | 状态 | 主要变化轴 |
|---|---|---|---|---|
| L2 | `CMP-cli` | [`components/CMP-cli/spec.md`](components/CMP-cli/spec.md) | planned | 命令/部署形态、配置键、并发模型 |
| L1b | `CMP-executor` | [`components/CMP-executor/spec.md`](components/CMP-executor/spec.md) | planned | 执行流程语义、取消/幂等边界 |
| L1a | `CMP-result` | [`components/CMP-result/spec.md`](components/CMP-result/spec.md) | planned | 结果格式、错误分类 |
| L0 | `CMP-gateway` | [`components/CMP-gateway/spec.md`](components/CMP-gateway/spec.md) | planned | 调度器协议 |
| L0 | `CMP-runtime` | [`components/CMP-runtime/spec.md`](components/CMP-runtime/spec.md) | planned | DSH/ACP 版本与行为 |
| L0 | `CMP-workspace` | [`components/CMP-workspace/spec.md`](components/CMP-workspace/spec.md) | planned | 容器布局、清理策略、路径约束 |
| L0 | `CMP-assets` | [`components/CMP-assets/spec.md`](components/CMP-assets/spec.md) | planned | 包格式、来源、校验方式 |
| L0 | `CMP-store` | [`components/CMP-store/spec.md`](components/CMP-store/spec.md) | planned | 本地持久化格式与保留策略 |
| L0 | `CMP-observability` | [`components/CMP-observability/spec.md`](components/CMP-observability/spec.md) | planned | 观测字段、sink、脱敏规则 |

### 4.2 跨组件契约总览

端口签名以 `CMP-executor` §3.4 为准；各组件规格只写实现语义与扩展错误，不另立签名。本节只定契约面与消费关系，不复制字段。

| 端口 | 定义方 | 实现方 | 消费方 | 目的 |
|---|---|---|---|---|
| `SchedulerPort` | `CMP-executor` | `CMP-gateway` | executor（`bindSession`/`reportResult`）、CLI（`register`/`heartbeat`/`claim`/`renew`） | 调度器协议防腐层 |
| `RuntimePort` | `CMP-executor` | `CMP-runtime` | executor | DSH 进程与 ACP 会话 |
| `WorkspacePort` | `CMP-executor` | `CMP-workspace` | executor | 容器校验、路径解析、清理 |
| `AssetPort` | `CMP-executor` | `CMP-assets` | executor | 技能集安装与 digest |
| `JournalPort` | `CMP-executor` | `CMP-store` | executor（journal/orphan 写）、CLI（pending/list/锁） | 本地恢复事实 |

**端口方法速查**（完整签名见 `CMP-executor` §3.4）：

| 端口 | 方法 | 方向/幂等 |
|---|---|---|
| `SchedulerPort` | `register`、`heartbeat`、`claim`、`renew`、`bindSession`、`reportResult` | client → 调度器；`claim` 按 `claimRequestId`、其余按 `attemptId` 幂等；心跳/领取长轮询 |
| `RuntimePort` | `ensureInstance`、`newSession`、`prompt`、`cancel`、`closeSession`、`shutdownInstance` | executor → DSH；`ensureInstance`/`closeSession` 幂等；prompt 受取消/超时 |
| `WorkspacePort` | `ensureContainer`、`validate`、`resolve`、`cleanup` | executor → 文件系统；`ensureContainer`/`cleanup` 幂等；路径不越界 |
| `AssetPort` | `install`、`verify`、`currentDigest` | executor → 技能包；同 digest `install` 为空操作；失败回滚 |
| `JournalPort` | `append`、`pending`、`mark`、`lockInstance`、`recordOrphan`、`listOrphans`、`clearOrphan` | executor/CLI → 本地存储；追加不覆盖；同实例单写 |

值类型：`NodeRequest`、`NodeResult`、`SkillSet`、`ControlBatch`、`Lease`、`Registration`、`HeartbeatResult`、`HeartbeatRequest`、`SessionBinding`、`Assignment`、`CleanupPending`、`CleanupAck`、`SessionOutcome`、`ContainerPaths`、`InstalledSkills`、`AttemptRecord`、`OrphanRecord`。调度器相关字段见 [`contracts/executor-http-v1.md`](contracts/executor-http-v1.md) §6；组件只依赖语义，不自行扩展字段。

`AuthProvider` / `SchedulerEndpoint` 也是 `CMP-executor` ports 里的值类型：组合根注入同一个实例给 `CMP-gateway` 与 `CMP-assets`，这样 assets 复用凭据策略而不 import gateway。

契约规则：

1. **只出现稳定概念**：签名只用我方值类型；HTTP、JSON-RPC、SDK、ORM、文件路径格式不得进入端口。字段名以 M1 冻结为准。
2. **能力 ID**：公开操作以 `CMP-xxx#op` 引用（如 `CMP-executor#executeNode`、`CMP-runtime#prompt`）；场景与测试只引用 ID，不写行号。代码入口在任务落地后回填 `CMP-xxx/file#symbol`。
3. **幂等**：跨进程写操作以 `attemptId` 为幂等键；重复投递/上报返回既有结果，不重复执行。
4. **错误模式**：错误码是契约的一部分；组件内部错误先归一为稳定码，再由 `CMP-result` 映射为 `ErrorClass` + `retryable`。
5. **超时/取消**：热/跨进程调用必须声明超时与取消；未声明视为契约缺陷。
6. **数据单家**：每份共享数据只有一个写入口；组件之间不互相读存储，跨组件数据只走端口。
7. **无泄漏**：`CMP-result` 不依赖端口；L0 不 import L1/L2 业务代码；L1/L2 不 import L0 具体类型（组合根例外）。

**契约版本与兼容**：

| 契约 | 版本 | 兼容规则 | 废弃/迁移 |
|---|---|---|---|
| 5 个端口 | v1 | 只做加法（新方法/新可选字段）；破坏性变更升主版本 | 旧版本保留一个里程碑；调用方按版本注入 |
| CLI 操作面 | v1 | 新命令/新 flag 可加；退出码语义稳定 | 旧命令保留别名；删除需 P2 |
| 配置 `.config` | v1 | 未知键忽略；新键可加；非法值不回退 | 键名变更需迁移说明（OQ-014） |
| journal | v1 | 读取方忽略未知字段；写入方保留 `v` | 格式升级写新文件 + 快照迁移 |
| 日志/`doctor` JSON | v1 | 字段可加；已有字段语义不变 | 消费方忽略未知字段 |
| ACP | v1 | 按 DSH 基线；升级前复跑关键用例 | 版本不兼容退出 3 |
| 技能包/digest | v1（M1 冻结） | digest 覆盖内容；格式变更换 digest | 旧包缓存可失效 |
| 调度器契约 | **v1 frozen（2026-11-07.1）** | 字段/枚举/错误码加法兼容；删字段、改语义、改必填性升 `protocolVersion` | 不兼容停止领取，退出 3；`run_superseded` 退出 7 |

### 4.3 依赖矩阵与禁止边

| 调用方 | 被调方 | 契约 | 方式 | 冷热 | 失败处理 |
|---|---|---|---|---|---|
| `CMP-cli` | `CMP-executor` | `executeNode` / `cancelInstance` / `recover` | 同步 | 冷 | 节点失败，按错误类别上报 |
| `CMP-cli` | `CMP-gateway` | `SchedulerPort` lease 组 | 同步 | **热** | 退避重试；心跳不可停 |
| `CMP-cli` | `CMP-store` | `JournalPort` / `StoreAdmin` | 同步 | 冷 | 降级：跳过坏记录并告警 |
| `CMP-cli` | `CMP-runtime` | `RuntimeAdmin`（doctor/reap） | 同步 | 冷 | 记录并继续 |
| `CMP-cli` | `CMP-workspace` / `CMP-assets` | `*Admin.diagnose` | 同步 | 冷 | 记录并继续 |
| `CMP-executor` | `CMP-result` | `assemble` / `classify` | 同步（纯函数） | 冷 | 不可失败 |
| `CMP-executor` | `SchedulerPort` | `bindSession` / `reportResult` | 同步 | 冷 | 传输重试；失败则节点失败 |
| `CMP-executor` | `RuntimePort` | `ensureInstance` / `newSession` / `prompt` / `cancel` / `closeSession` / `shutdownInstance` | 同步（长等） | 冷 | 关坏 session；节点失败 |
| `CMP-executor` | `WorkspacePort` | `ensureContainer` / `validate` / `resolve` / `cleanup` | 同步 | 冷 | 节点失败 |
| `CMP-executor` | `AssetPort` | `install` / `verify` / `currentDigest` | 同步（下载/解压） | 冷 | 回滚；不 prompt；节点失败 |
| `CMP-executor` | `JournalPort` | `append` / `mark` / `recordOrphan` / `clearOrphan` | 同步 | 冷 | 尽力写，失败告警 |
| 全部 | `CMP-observability` | `Logger` / `Doctor` | 同步 | 冷 | 吞掉日志失败，不影响主流程 |

**禁止边**：

- L1/L2 不得 import L0 具体类型（`CMP-cli` 作为组合根是唯一例外）。
- L0 不得 import `CMP-cli`；`CMP-runtime` 不得 import workspace/assets/gateway；`CMP-gateway` 不得 import runtime/workspace/assets；`CMP-assets` 不得 import gateway（下载自持）。
- `CMP-result` 不得依赖任何适配器或端口。
- 组件间不共享可变状态，不互相读对方存储；跨组件数据只走端口。
- 值类型（如 `AttemptRecord`、`OrphanRecord`、`CheckResult`、`AuthProvider`、`SchedulerEndpoint`）只读导入不算横向调用；不得借此调用对方运行时逻辑。
- `CMP-assets` 可读 ports 的 `AuthProvider`/`SchedulerEndpoint`，但不得 import `CMP-gateway`；网关与 assets 不共享连接池或会话状态。
- L0 的 `*Admin` 管理面只允许 CLI 调用，不得被 executor 反向依赖。

**扇出/扇入检查**：`CMP-executor` 扇出 6（result + 5 端口，不含 observability），冷路径 ≤8；热路径（租约循环）同步依赖 1（gateway）。`CMP-observability` 扇入最大，契约按平台级稳定性管理；`CMP-gateway` 扇入 2（CLI + executor），不构成平台级。

### 4.4 内部功能骨架

细节在各自组件规格；下表用于快速定位「改一条规则该进哪个组件」。

| 组件 | 内部功能 | 关键状态/不变量 |
|---|---|---|
| `CMP-cli` | `main`、`resolveRunDir`、`loadConfig`、`runServe`、`runOnce`、`runDoctor`、`runVersion`、组合根、信号 | 配置冻结；心跳独立于执行；退出码 |
| `CMP-executor` | `AttemptRegistry`、`AttemptRunner`、`CancellationScope`、`SkillDigestGuard`、`RecoveryPlanner`、`ports` | 状态机 `claimed→bound→ready→running→settled→reported→closed`；attempt 单飞 |
| `CMP-result` | `assemble`、`classify`、`truncate`、`mapStopReason` | 纯函数；错误分类单点；UTF-8 安全截断 |
| `CMP-gateway` | `HttpTransport`、`LongPollLoop`、`RetryPolicy`、`AuthProvider`、`VersionNegotiator`、`IdempotencyCache`、`LeaseTracker`、`ControlSeq` | 长轮询续租；`seq` 幂等；迟到只审计 |
| `CMP-runtime` | `InstanceSupervisor`、`ProfilePatcher`、`AcpConnection`、`SessionRegistry`、`ProcessReaper`、`PermissionPolicy` | 一实例一进程；一 session 单 prompt；取消立即强杀 |
| `CMP-workspace` | `ensureContainer`、`validate`、`resolve`、`cleanup`、`diagnose` | 容器根即技能根；路径不越界；清理幂等 |
| `CMP-assets` | `install`、`verify`、`currentDigest`、原子替换、格式校验、缓存 | 替换不叠加；失败回滚；digest 幂等 |
| `CMP-store` | `append`、`pending`、`mark`、`lockInstance`、孤儿记录、压缩 | 追加不覆盖；同实例单写；可降级读取 |
| `CMP-observability` | `log`、`child`、脱敏、`collect`、`render`、`exitCode`、`progress` | 日志不阻塞；不泄漏凭据/原文 |

### 4.5 需求/场景到组件的追溯

| 需求 / 场景 | 主责组件 | 参与组件 | 验收锚点 |
|---|---|---|---|
| `REQ-0001` / `SCN-0002` 配置与自检 | `CMP-cli` | `CMP-runtime`（home/DSH）、`CMP-store`（残留）、`CMP-observability`（doctor 渲染） | `TC-CONFIG-001`…`004`；`doctor` 检查项与退出码 |
| `REQ-0002` / `SCN-0001` 节点执行与可靠性 | `CMP-executor` | `CMP-result`、`CMP-gateway`（S1）、`CMP-runtime`、`CMP-workspace`、`CMP-assets`、`CMP-store`、`CMP-observability` | `TC-EXEC-001`…`004`；R-01…R-10 门禁 |
| `REQ-0002` R-09/R-10 的配置/安全部分 | `CMP-cli` / `CMP-observability` | `CMP-runtime`、`CMP-workspace`、`CMP-assets` | `doctor` + 脱敏/路径/会话隔离断言 |

S0 不接调度器：`SCN-0001` 的触发用 `CMP-cli` 的 `run` + `LocalSchedulerAdapter`，`CMP-gateway` 在 S1 才进入主路径；这不改变组件切分。

### 4.6 冷热路径卡

| 路径 | 热/冷 | 触发/频率 | 经过组件与契约 | 同步依赖 | 失败/降级 | 资源隔离 | 一致性/观测 |
|---|---|---|---|---|---|---|---|
| 租约循环 | **热** | 注册/心跳 30s 长轮询/领取/续约 | CLI → `SchedulerPort` → gateway | 1 | 退避重连；鉴权/版本失败停领；持续不可达退出 6 | 独立定时器，不占执行队列 | 请求到达即续租；`seq`/`ackSeq`；观测延迟/错误率 |
| 节点执行 | 冷 | 每节点一次；分钟级 | executor → workspace / runtime / assets / result / `SchedulerPort` | 5 | 分类失败；结果先落 journal；可幂等重报 | 每实例独立进程/容器/home | `settled` 后可重放；观测 phase/attempt/session |
| 技能安装 | 冷 | 每节点/技能集变化 | executor → `AssetPort` → assets | 0（assets 自持下载） | 原子回滚；不 prompt；失败 asset 类 | 独立 staging/cache；大小上限 | digest + 原子替换；观测包名/大小/耗时 |
| 恢复/`doctor` | 冷 | 启动/手动 | CLI → store / runtime / workspace / assets `*Admin` | 0（S0 不查网络） | 降级跳过坏记录；检查失败不阻塞启动 | 实例串行清理；不与执行共享锁 | `pending`/orphan/检查项；脱敏 |

### 4.7 验证入口与 CI 门禁

| 组件 | 单独测试目录（落地后） | 关键门禁 |
|---|---|---|
| `CMP-cli` | `tests/components/cli/` | 配置矩阵 `TC-CONFIG-001`…`004`；退出码；`serve` 循环不重复执行；心跳不被 prompt 阻塞 |
| `CMP-executor` | `tests/components/executor/` | 状态机/顺序；同 attempt 单飞；取消/超时；技能集冲突；崩溃恢复（重报/abandoned） |
| `CMP-result` | `tests/components/result/` | 四类结果组装；错误映射表；UTF-8 截断边界 |
| `CMP-gateway` | `tests/components/gateway/` | 桩调度器全错误面；长轮询/ackSeq；幂等/迟到 |
| `CMP-runtime` | `tests/components/runtime/` | ACP 回放；取消后无残留；session 不复用；多 session 隔离 |
| `CMP-workspace` | `tests/components/workspace/` | 容器布局/路径逃逸/清理幂等；容器根即技能根 |
| `CMP-assets` | `tests/components/assets/` | 原子替换/失败回滚；digest 幂等；脚本权限；安全解包 |
| `CMP-store` | `tests/components/store/` | journal 重建；损坏降级；双跑锁；孤儿记录 |
| `CMP-observability` | `tests/components/observability/` | 关联键；脱敏；轮转；`doctor` 输出/退出码 |

CI 至少守住：`bun test`、`bun run typecheck`、`bun run docs:check`、`bun run quality:gate`、契约测试、import 边界检查；S0 起加进程残留冒烟（取消/崩溃后 `kill -0` 为假）。

## 5. 主流程

1. 领取（租约）：`claim` 取绑定本实例的 `NodeRequest`（含容器路径、技能集引用与 prompt）。
2. 准备：`CMP-workspace` 校验预置容器；`CMP-runtime` 确保实例 DSH 进程（独立 `DSH_HOME`，profile 补丁写入技能可见性配置）。
3. 建 session：`session/new`，`cwd` 固定为容器根；上报 `sessionId`。
4. 取技能集：`bindSession` 返回该节点技能集。
5. 刷技能：`CMP-assets` 原子替换容器根 `.dsh/skills`（按 digest 幂等），脚本赋权。
6. 执行：下发 prompt，消费 ACP 事件，累积最终消息、停止原因与用量。
7. 结算：`CMP-result` 组装 `NodeResult` → journal 记 `settled` → `CMP-gateway` 上报（同 attempt 幂等）→ journal 记 `reported`。
8. 收尾：关 session；journal 记 `closed`；实例结束或取消时关进程、按策略清理容器与 `DSH_HOME`。

技能刷新失败不降级执行；刷新失败、容器校验失败、DSH 启动失败都按节点失败上报。

## 6. 关键不变量

1. 同一 `instanceId` 同一时刻只执行一个 attempt（`SCH-19`）；不同实例可并行，受 `maxInstances` 限制。`attemptId` 去重，重复领取不重复执行。
2. 先建 session、再取技能集、再刷新、再 prompt；顺序不交换。
3. 技能刷新是替换不是叠加；失败不留半套，不 prompt。
4. 一个可执行节点一个 session；session 不复用。
5. 取消是实例级整体终止：所有活跃 session 关闭、杀进程组，各 attempt 报 `cancelled`。
6. 跨边界只传控制信息；产物、完整会话记录、日志不出本机。
7. 工作区单写；路径限制在容器内，拒绝越界与跟随越界符号链接。
8. 容器预置：client 不 clone、不检出、不建仓库。
9. 容器根即技能根：session `cwd` 固定为容器根，不指向子仓库。
10. 容器根不建 `.git`，且位于任何仓库之外；`doctor` 校验 `findProjectRoot(容器根) === 容器根`。
11. 同一容器的并发节点由调度器保证同一技能集；client 按 digest 幂等安装，违约显式失败。
12. 心跳是长轮询：请求到达即续租，断开/超时是离线信号，最终以租约过期裁决；心跳与领取是两个独立任务。
13. 控制事件按 `(clientId, runId)` 作用域、至少一次投递、按 `seq` 幂等应用；新 run 丢弃旧 run 未 ack 事件；事件只作用于 `claimedAt <= issuedAt` 的 attempt，已结算的只 ack。
14. 结果先落 journal（`settled`）再上报（`reported`）；上报失败只重试传输，不重复执行。
15. 同一 `attemptId` 重复投递返回既有结果；去重以进程内单飞 + journal 为准，不以 session 复用代替。
16. 取消/超时不等待 prompt 自然结算；已先结算的结果按实际上报，已上报的只 ack。
17. 实例释放/清理以 `cleanupPending` 幂等状态为准，`shutdown` 事件只做在线加速；重启后按 `releaseId` 对账，cleanup 完成前该实例不再领取。
18. 同一 `attemptId` 的结果只归属 `(clientId, attemptId)`，不因 `runId` 变化而失效；重跑必须换新 `attemptId`。

## 7. 数据所有权

| 数据/状态 | 唯一写入口 | 一致性/保留 |
|---|---|---|
| 工作区容器与产物（根 + 子仓库工作树 + `.dsh/skills`） | `CMP-workspace` | 本地强一致；预置仓库按策略保留，默认不删 |
| 技能缓存与落地 | `CMP-assets` | 原子替换；缓存可失效 |
| DSH 进程 / session / `DSH_HOME` | `CMP-runtime` | 进程退出即回收；一实例一 home |
| 运行状态目录：journal / 实例锁 / 孤儿记录 | `CMP-store` | 追加写；崩溃可重建；`stateRoot` 由 CLI 注入 |
| 尝试状态 | `CMP-executor` | 仅运行期；可从 journal 重建 |
| 释放/清理意图 `cleanupPending`/`releaseId` | 调度器（权威）；client 只缓存已处理 `releaseId` | 跨 `runId` 保留到 ack `done`；client 清账后可删本地缓存 |
| 配置 | `CMP-cli` | 启动校验；运行期不变 |
| 日志 | `CMP-observability` | 本地、脱敏、轮转 |

规则：每份数据只有一个写入口；client 本地记录只用于恢复，不是第二真相；session 绑定语义以调度器为准。

## 8. 工作区与技能可见性

```
<workspace>/                    ← 容器根：技能根、session cwd；位于任何 git 仓库之外
├── .dsh/skills/                ← 当前节点的技能集（替换式刷新；脚本随包）
├── repo-a/    (.git)           ← 准备阶段预置的代码/文档容器
└── repo-b/    (.git)
```

- 容器由准备阶段预置，`NodeRequest` 带容器路径（编排层参数）；仓库清单由目录本身表达。
- 容器根不建 `.git`，且必须位于任何仓库之外；否则 `projectRoot` 上浮，`.dsh/skills` 不可见。
- DSH 的项目根取 `cwd` 向上最近的 `.git`，否则 `cwd`；因此 cwd 必须是容器根。
- 技能可见性：实例 profile 保留 `includeDefaultRoots: true`，把 `dshHome` / `agentsHome` / `bundledSkillDir` 指向三个真实空目录；**只屏蔽全局根，保留项目 `.dsh` / `.agents`**。项目自带 `.agents/skills` 仍可见，同名时 `.dsh` 优先（rank 100 < 200）。
- 不要用 `DSH_HOME` 环境变量关技能；它同时影响 settings、credentials 等插件。
- `skill-filesystem` 的补丁是整份替换 config，不与默认配置深合并；未写字段回落 schema 默认值。

## 9. 控制事件（调度器 → client）

- 通道：心跳长轮询 `heartbeat(state, ackSeq, cleanupAcks?) → ControlBatch`；有事件立即返回，无事件挂起 30s 返回空批；不新增独立通知端点，不做 WebSocket/SSE。
- 事件闭集：`cancel(instanceId, reason)`、`pause(instanceId)`、`resume(instanceId)`、`shutdown(instanceId?, cleanup?, releaseId?)`。
- 流转：调度器按 `(clientId, runId)` 单调 `seq` 入队 → 心跳响应内联 `ControlBatch` + `cleanupPending` → `CMP-gateway` 校验 → `CMP-cli` 分派/对账 → `CMP-executor` 执行 → 下次心跳带 `ackSeq` 与 `cleanupAcks`。
- 语义：至少一次 + 按 `seq` 幂等；同 run 断连补发；新 run 丢弃旧 run 未 ack 事件；事件只作用于 `claimedAt <= issuedAt` 的 attempt（同刻取消优先）；已结算/未知实例只 ack + 审计。
- `shutdown(instanceId, cleanup)` 的清理意图同时进 `cleanupPending`（§7）；事件丢失不丢清理，`releaseId` 幂等。
- `cancel` 立即终止、不等 prompt 自然结算；未知类型 ack 并记录。
- 权限请求的人工审批不在本通道：当前由 client 本地策略裁决；若编排要参与，需新增同步交互面（契约变更）。

## 10. 失败与恢复

- 网络/租约：传输退避重试；租约过期丢弃尝试，迟到结果只入审计；`409 run_superseded` 停领、取消活跃、退出 7。
- 技能资产：原子回滚，不 prompt，节点失败（资产类）。
- 工作区：校验失败即节点失败；不迁移其他 client。
- DSH/ACP：关闭坏 session，必要时杀进程；节点失败（运行时类）。
- 崩溃/重启：清理孤儿进程与残留 session，重新注册并等待调度器重新下发；已产生结果按 `attemptId` 幂等重报（R-02），未结算节点不自动重跑；收到重派后再执行当前节点；**不依赖 session 恢复或历史回放**。
- 释放/清理：重启后 `register`/`heartbeat` 取 `cleanupPending`，按 `releaseId` 对账执行并回执；事件丢失不阻止清理，cleanup 失败不影响容量释放但需重试。
- 恢复原则：暂停在节点边界生效；恢复由调度器重新下发触发，client 不自动重跑。

## 11. 不做

- 不做编排决策（下一节点、评审、分支、fan-out 拆分、回退）。
- 不读调度器数据库、不上传产物、不传完整会话记录、不做跨 client 迁移。
- 不做 DSH 改造、不做 UI、不提供本地**控制面** HTTP/IPC 服务；只读观测面是独立 P1，不承接控制。

## 12. 后续

- 组件规格已建（2026-11-04，`planned`）：9 份 `docs/design/components/<id>/spec.md` 覆盖职责、内部功能、端口实现、数据所有权、验证计划与预算；组件级确认前不写实现代码。
- 调度器契约已落盘（2026-11-07，v1；T10 评审待签字）：字段级权威见 [`contracts/executor-http-v1.md`](contracts/executor-http-v1.md)，`protocolVersion = 2026-11-07.1`。
- 场景与可靠性：`SCN-0002`（配置 client 并完成自检）、`SCN-0001`（执行节点并回传结果）与 `REQ-0002`（执行稳定性与可靠性）已建；S0 先按两个场景的 S0 用例落地。
- S0 本地闭环工序：以冻结稿的用例与不变量为输入；优先验证取消/崩溃清理、容器根技能可见性、结果回传与 `doctor` 守门。
- 只读观测 HTTP（`/api/v1/observability`）仍是独立 P1 设计稿（`docs/works/2026-11-06-observability-http/`），未进本架构；确认后另立工序回填。

## 13. 分级与确认

- **级别：P1**。触发项：组件切分与契约（端口签名、状态机、错误分类、数据所有权、分层依赖）。
- **切分不变**：9 组件、端口归属、主流程与取消粒度沿用 2026-11-03 已确认方案（D1–D12），本次不重新打开；只细化组件内部功能、端口签名、状态机与错误映射。若后续要合并/拆分组件，按新的 P1 决策走。
- **已确认（2026-11-03，概念设计）**：对外两个面；9 组件；5 个端口由 `CMP-executor` 定义、L0 实现；主流程与关键不变量（概念设计 13 条，本次补至 16 条）；数据所有权；心跳长轮询兼控制事件；取消以实例为单位立即终止。
- **本次补充（2026-11-04，组件规格待确认）**：
  - 组件内部功能骨架与 9 份组件规格；
  - 尝试状态机加入 `settled`（结果先落 journal 再上报），并补充 `abandoned` 恢复态；
  - 端口签名细化：`JournalPort` 纳入孤儿记录读写；`RuntimePort` / `WorkspacePort` / `AssetPort` 签名与错误码；
  - 错误分类闭集与 `retryable` 提示；
  - 契约版本与兼容规则、冷热路径卡、逐组件验证入口；
  - `run` 退出码 `1`、SIGTERM `143`；`run --permission`；
  - `stateRoot` 默认 `<runDir>/.agent-flow-client`（键名待 OQ-014）；
  - `doctor` 由 CLI 编排、各组件 `diagnose()` 提供检查项。
- **M1 契约冻结落盘（2026-11-07，T1–T9；T10 评审待签字）**：`protocolVersion = 2026-11-07.1`；`C-01`…`C-07`、`SCH-01`…`SCH-20`、`CLT-01`…`CLT-13`、`cleanupPending`、退出码 7、`run` 作用域控制事件全部落盘；字段权威见 `contracts/executor-http-v1.md`。
- **仍待确认**：`[acp].permission` 默认值与配置键、`stateRoot` 键名（OQ-014）、`run` 退出码 `1` / SIGTERM `143`（OQ-015）；这些不阻塞调度器契约。
- **确认前约束**：不写实现代码；不把 `planned` 组件改为 `active`；`SCN-0001` / `SCN-0002` 保持 `designed`，不升 `verified`。
