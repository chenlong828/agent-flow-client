---
layer: design
module: global
status: current
updated: 2026-11-08
---

# 执行面客户端架构

> 范围：client 的对外接口面、组件切分、主流程、数据所有权与关键不变量。字段级契约、DSH/ACP 细节与实现细节不在本文。
>
> 调度器契约的字段级权威：[`contracts/executor-http-v2.md`](contracts/executor-http-v2.md)（v2，2026-11-10，三端点、at-least-once）。本文只定接口面与跨组件关系，**不复述字段**。
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
| 实例 | 一实例一个 DSH 进程；同一实例允许多个任务并发（共享容器与同一技能集 digest） |
| 任务 | 一个 `taskId` 一个 session；技能集随任务下发；任务结束关 session，不复用 |
| 工作区 | 一实例一个**容器**：准备阶段预置，含 0..N 个带 `.git` 的仓库；任务共享；产物默认保留 |
| 技能 | 任务级集合；落地在容器根 `.dsh/skills`；替换不叠加、按 digest 幂等；同容器安装串行 |
| 容量 | 本地 `maxConcurrent`；`poll` 上报 `capacity.free`；调度器不超卖 |
| 判活 | `poll` 长轮询（服务端挂起 30s、客户端 40s 超时）；没有独立心跳端点 |
| 控制 | `stop` / `cancelInstances` 电平信号；实例级取消，立即终止 |

## 3. 对外接口面

### 3.1 调度器契约面（client 是消费方，权威在调度器）

| 契约面 | 操作 | 目的 |
|---|---|---|
| `P-01` 取任务 | `POST /poll`（长轮询） | 取任务、上报 `running[]`/`finished[]`、收 `stop`/`cancelInstances` |
| `P-02` 交结果 | `POST /tasks/{taskId}/result` | 交 `TaskResult`；首份为准，`accepted` 确认 |
| `P-03` 技能包 | `GET /skill-packages/{packageId}` | 取 zip；304 命中缓存 |

字段、错误码、容量与超时全部以 [`contracts/executor-http-v2.md`](contracts/executor-http-v2.md) 为准；client 只实现消费端，不自定义字段。控制面只出站，调度器不主动连 client。

### 3.2 CLI 操作面

`serve` / `run` / `doctor` / `version`；配置启动时一次性加载、校验、冻结。退出码：`0` 成功、`1` `run` 产生非成功任务结果（failed/cancelled/timeout）、`2` 用法/配置、`3` 鉴权或协议版本不兼容、`4` DSH/运行时、`5` 工作区或资产、`6` 调度器不可达、`130` SIGINT、`143` SIGTERM。`run` 的 stdout 只输出 `TaskResult` JSON，日志走 stderr。SIGINT/SIGTERM：停止领取 → 取消活跃任务 → flush journal → 关 session/进程 → 退出；第二次信号强杀并记录未收口任务。

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
| `SchedulerPort` | `CMP-executor` | `CMP-gateway` | CLI（`poll`/`reportResult`/`downloadPackage`） | 调度器协议防腐层 |
| `RuntimePort` | `CMP-executor` | `CMP-runtime` | executor | DSH 进程与 ACP 会话 |
| `WorkspacePort` | `CMP-executor` | `CMP-workspace` | executor | 容器校验、路径解析 |
| `AssetPort` | `CMP-executor` | `CMP-assets` | executor | 技能集安装与 digest |
| `JournalPort` | `CMP-executor` | `CMP-store` | executor/CLI | 任务状态、结果与孤儿记录 |

**端口方法速查**（完整签名见 `CMP-executor` §3.4）：

| 端口 | 方法 | 方向/幂等 |
|---|---|---|
| `SchedulerPort` | `poll`、`reportResult`、`downloadPackage` | client → 调度器；结果按 `taskId` 首份为准；poll 长轮询 |
| `RuntimePort` | `ensureInstance`、`newSession`、`prompt`、`cancel`、`closeSession`、`shutdownInstance`、`activeSessions` | executor → DSH；`ensureInstance`/`closeSession` 幂等；prompt 受取消/超时 |
| `WorkspacePort` | `ensureContainer`、`validate`、`resolve` | executor → 文件系统；容器预置；路径不越界 |
| `AssetPort` | `install`、`verify`、`currentDigest` | executor → 技能包；同 digest `install` 为空操作；失败回滚 |
| `JournalPort` | `append`、`mark`、`settled`、`recordOrphan`、`listOrphans`、`clearOrphan` | executor/CLI → 本地存储；追加不覆盖 |

值类型：`TaskRequest`、`TaskResult`、`TaskRecord`、`SkillSet`、`PollRequest`、`PollResponse`、`ResultAck`、`RunningTask`、`FinishedTask`、`SessionOutcome`、`ContainerPaths`、`InstalledSkills`、`OrphanRecord`。字段见 [`contracts/executor-http-v2.md`](contracts/executor-http-v2.md) §5；组件只依赖语义，不自行扩展字段。

契约规则：

1. **只出现稳定概念**：签名只用我方值类型；HTTP、JSON-RPC、SDK、ORM、文件路径格式不得进入端口。字段名以 v2 冻结为准。
2. **能力 ID**：公开操作以 `CMP-xxx#op` 引用；场景与测试只引用 ID，不写行号。
3. **幂等**：结果按 `taskId` 首份为准；`finished[]` 保证「结果已算出、响应丢失」不被重发；同一任务重派只递增 `attempt`。
4. **错误模式**：错误码是契约的一部分；组件内部错误先归一为稳定码，再由 `CMP-result` 映射为 `ErrorClass`（无 `retryable`）。
5. **超时/取消**：热/跨进程调用必须声明超时与取消；未声明视为契约缺陷。
6. **数据单家**：每份共享数据只有一个写入口；组件之间不互相读存储，跨组件数据只走端口。
7. **无泄漏**：`CMP-result` 不依赖端口；L0 不 import L1/L2 业务代码；L1/L2 不 import L0 具体类型（组合根例外）。

**契约版本与兼容**：

| 契约 | 版本 | 兼容规则 | 废弃/迁移 |
|---|---|---|---|
| 5 个端口 | v2 | 只做加法（新方法/新可选字段）；破坏性变更升主版本 | 旧版本保留一个里程碑；调用方按版本注入 |
| CLI 操作面 | v1 | 新命令/新 flag 可加；退出码语义稳定 | 旧命令保留别名；删除需 P2 |
| 配置 `.config` | v2 | 未知键忽略；新键可加；非法值不回退 | 键名变更需迁移说明 |
| journal | v2 | 读取方忽略未知字段；写入方保留 `v` | v1 记录忽略 |
| 日志/`doctor` JSON | v1 | 字段可加；已有字段语义不变 | 消费方忽略未知字段 |
| ACP | v1 | 按 DSH 基线；升级前复跑关键用例 | 版本不兼容退出 3 |
| 技能包/digest | v1 | digest 覆盖内容；格式变更换 digest | 旧包缓存可失效 |
| 调度器契约 | **v2（2026-11-10）** | 三端点、at-least-once；`X-Executor-Protocol: 2` | 不兼容 `400 unsupported_protocol`，停止并退出 |

### 4.3 依赖矩阵与禁止边

| 调用方 | 被调方 | 契约 | 方式 | 冷热 | 失败处理 |
|---|---|---|---|---|---|
| `CMP-cli` | `CMP-executor` | `executeTask` / `cancelInstance` / `cancelAll` / `snapshotRunning` | 同步 | 冷 | 任务失败按错误类别上报；快照只用于 `running[]` |
| `CMP-cli` | `CMP-gateway` | `SchedulerPort`（`poll`/`reportResult`/`downloadPackage`） | 同步 | **热** | 退避重试；poll 不可停 |
| `CMP-cli` | `CMP-store` | `JournalPort` / `StoreAdmin` | 同步 | 冷 | 降级：跳过坏记录并告警 |
| `CMP-cli` | `CMP-runtime` | `RuntimeAdmin`（doctor/reap） | 同步 | 冷 | 记录并继续 |
| `CMP-cli` | `CMP-workspace` / `CMP-assets` | `*Admin.diagnose` | 同步 | 冷 | 记录并继续 |
| `CMP-executor` | `CMP-result` | `assemble` / `classify` | 同步（纯函数） | 冷 | 不可失败 |
| `CMP-executor` | `SchedulerPort` | 不直接依赖（由 CLI 上报） | — | — | — |
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
| `CMP-executor` | `TaskRunner`、`CancellationScope`、`ports` | 状态 `received→running→settled`；同 taskId 单飞；结果先落盘 |
| `CMP-result` | `assemble`、`classify`、`truncate`、`mapStopReason` | 纯函数；错误分类单点；UTF-8 安全截断 |
| `CMP-gateway` | `HttpTransport`、`RetryPolicy` | `poll` 长轮询；结果首份为准；`X-Executor-Protocol: 2` |
| `CMP-runtime` | `InstanceSupervisor`、`ProfilePatcher`、`AcpConnection`、`SessionRegistry`、`ProcessReaper`、`PermissionPolicy` | 一实例一进程；一 session 单 prompt；取消立即强杀 |
| `CMP-workspace` | `ensureContainer`、`validate`、`resolve`、`cleanup`、`diagnose` | 容器根即技能根；路径不越界；清理幂等 |
| `CMP-assets` | `install`、`verify`、`currentDigest`、原子替换、格式校验、缓存 | 替换不叠加；失败回滚；digest 幂等 |
| `CMP-store` | `append`、`mark`、`settled`、孤儿记录 | 追加不覆盖；结果先落盘；可降级读取 |
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
| poll 循环 | **热** | 常驻 30s 长轮询（兼判活） | CLI → `SchedulerPort` → gateway | 1 | 退避重连；鉴权/协议失败退出 3；持续不可达退出 6 | 独立任务，不占执行队列 | `running[]`/`finished[]`；观测延迟/错误率 |
| 任务执行 | 冷 | 每任务一次；分钟级 | executor → workspace / runtime / assets / result | 4 | 分类失败；结果先落 journal；未 accepted 前留在 finished | 每实例独立进程/容器/home | `settled` 后可重报；观测 taskId/session |
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

场景 UC → 测试文件的映射见 [`test-matrix.md`](test-matrix.md)（`AH-08`/`OQ-024`）；每个 S0 UC 至少有一个计划测试文件，测试 ID 在工序中回填。

## 5. 主流程

1. 取任务：`poll` 常驻长轮询，带 `capacity.free`、`running[]`、`finished[]`；服务端返回 `tasks[]`/`stop`/`cancelInstances`。
2. 登记：收到任务先登记到本地 in-flight，再发起下一次 `poll`（`C-01`）。
3. 准备：`CMP-workspace` 校验预置容器；`CMP-runtime` 确保实例 DSH 进程。
4. 建 session：`session/new`，`cwd` 固定为容器根。
5. 刷技能：`CMP-assets` 原子替换容器根 `.dsh/skills`；同 digest 直接短路；同容器安装串行。
6. 执行：下发 prompt，消费 ACP 事件，强制 `timeoutMs` 与可选 idle 看门狗。
7. 结算：`CMP-result` 组装 `TaskResult` → journal 记 `settled`（结果先落盘）→ `reportResult` → `accepted` 后记 `reported`；未 accepted 前保留在 `finished[]`。
8. 收尾：关 session；实例进程保留供后续任务；`stop` 时跑完手上任务退出 0；`cancelInstances` 立即中止并上报 `cancelled`。

技能刷新失败不降级执行；刷新失败、容器校验失败、DSH 启动失败都按任务失败上报。

## 6. 关键不变量

1. **at-least-once**：同一 `taskId` 可能被执行多次；调度器以第一份被接受的结果为准（`S-08`），client 不承诺 exactly-once。
2. 一个任务一个 session；session 不复用。
3. 先装技能再 prompt；技能刷新是替换不是叠加；失败不留半套，不 prompt。
4. 同一容器上并发任务由调度器保证同一 `skillSet.digest`（`S-06`）；client 只保证安装临界区串行。
5. 结果先落 journal（`settled`）再上报；未 accepted 前任务一直留在 `finished[]`；重启后补报。
6. 取消是实例级：`cancelInstances` 命中该实例全部在跑任务，立即终止，结果 `cancelled`。
7. 跨边界只传控制信息；产物、完整会话记录、日志不出本机。
8. 路径限制在容器内，拒绝越界与跟随越界符号链接；容器根即技能根。
9. 容器预置：client 不 clone、不检出、不建仓库；容器根不建 `.git`，位于任何仓库之外。
10. 工作区默认保留；v2 没有清理指令，回收由运维按 `instanceId` 处理。
11. `poll` 的 `running[]` 必须包含全部在跑任务；`finished[]` 必须包含全部「有结果未确认」任务。
12. `stop` 后停止领取，跑完手上任务退出 0；第二次信号强杀。
13. 任务超时只终止该任务：`session/cancel` → `session/close`；同实例无其它 session 时才回收进程组，避免连带杀死并发任务。

## 7. 数据所有权

| 数据/状态 | 唯一写入口 | 一致性/保留 |
|---|---|---|
| 工作区容器与产物 | `CMP-workspace` | 本地强一致；默认保留 |
| 技能缓存与落地 | `CMP-assets` | 原子替换；digest 幂等；缓存可失效 |
| DSH 进程 / session | `CMP-runtime` | 进程退出即回收；一实例一进程 |
| `DSH_HOME`（实例） | CLI 创建/校验；`CMP-runtime` 独占写入 | 运行期使用；S3 再定回收 |
| `<stateRoot>/journal.jsonl` / `orphans/` | `CMP-store` | 追加写；崩溃可重建 |
| `<stateRoot>/cache/` | `CMP-assets` | 技能包缓存；可失效 |
| `<stateRoot>/logs/` | `CMP-observability` | 日志轮转 |
| 任务在跑/已结算状态 | `CMP-executor` | 运行期；可从 journal 重建 |
| 结果确认（`accepted`） | 调度器（权威）；client 只记本地 `reported` | 未确认结果保留到 accepted |
| 配置 | `CMP-cli` | 启动校验；运行期不变 |

规则：每份数据只有一个写入口；client 本地记录只用于恢复与补报，不是第二真相；结果归属以 `taskId` 为准。

## 8. 工作区与技能可见性

```
<workspace>/                    ← 容器根：技能根、session cwd；位于任何 git 仓库之外
├── .dsh/skills/                ← 当前节点的技能集（替换式刷新；脚本随包）
├── repo-a/    (.git)           ← 准备阶段预置的代码/文档容器
└── repo-b/    (.git)
```

- 容器由准备阶段预置，`TaskRequest.workspacePath` 带容器路径（编排层参数）；仓库清单由目录本身表达。
- 容器根不建 `.git`，且必须位于任何仓库之外；否则 `projectRoot` 上浮，`.dsh/skills` 不可见。
- DSH 的项目根取 `cwd` 向上最近的 `.git`，否则 `cwd`；因此 cwd 必须是容器根。
- 技能可见性：实例 profile 保留 `includeDefaultRoots: true`，把 `dshHome` / `agentsHome` / `bundledSkillDir` 指向三个真实空目录；**只屏蔽全局根，保留项目 `.dsh` / `.agents`**。项目自带 `.agents/skills` 仍可见，同名时 `.dsh` 优先（rank 100 < 200）。
- 不要用 `DSH_HOME` 环境变量关技能；它同时影响 settings、credentials 等插件。
- `skill-filesystem` 的补丁是整份替换 config，不与默认配置深合并；未写字段回落 schema 默认值。

## 9. 控制信号（调度器 → client）

- 通道：`poll` 响应内联 `stop` 与 `cancelInstances[]`；没有独立控制端点，不做 WebSocket/SSE。
- `stop`：停止领取；跑完手上任务后退出 0。
- `cancelInstances[]`：中止这些实例的全部在跑任务，丢弃同批任务中属于这些实例的条目；结果报 `cancelled`。
- 两者都是**电平信号**：调度器持续下发，直到 client 的 `running[]` 不再包含对应任务（`S-07`）。
- 没有 `pause`/`resume`：暂停 = 调度器不下发新任务；没有 `seq`/`ackSeq`/补发。
- 权限请求仍由 client 本地策略裁决，不在该通道。

## 10. 失败与恢复

- 重复派发：`finished[]` 让调度器不重发已算出结果的任务；同一 `taskId` 的结果以首份为准（`accepted=false` 丢弃）。
- poll 响应丢失：任务未登记即未收到，`S-03` 下一跳重发同一 `taskId`；不需要幂等键。
- 结果上报失败：重试传输；任务留在 `finished[]`；重启后补报；调度器见到 `finished` 不再重发。
- 超时/卡死：`timeoutMs` 到点终止并报 `timeout`；可选 idle 看门狗报 `idle_timeout`；调度器按策略重派（`attempt + 1`）。
- client 崩溃：重启清孤儿进程组；`settled` 结果补报；`received/running` 直接丢弃，等调度器静默回队后重派。
- 调度器不可达：退避重试；连续失败达到阈值退出 6；`401`/协议不匹配停止并退出 3。
- 不自动重跑；重试归属调度器。

## 11. 不做

- 不做编排决策（下一节点、评审、分支、fan-out 拆分、回退）。
- 不读调度器数据库、不上传产物、不传完整会话记录、不做跨 client 迁移。
- 不做 DSH 改造、不做 UI、不提供本地**控制面** HTTP/IPC 服务；只读观测面是独立 P1，不承接控制。

## 12. 后续

- 组件规格已建（2026-11-04，`planned`）：9 份 `docs/design/components/<id>/spec.md` 覆盖职责、内部功能、端口实现、数据所有权、验证计划与预算；组件级确认前不写实现代码。
- 调度器契约已升级到 v2（2026-11-10）：三端点、at-least-once、`X-Executor-Protocol: 2`；字段级权威见 [`contracts/executor-http-v2.md`](contracts/executor-http-v2.md)。v1 已归档。
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
- **契约 v2（2026-11-10）**：调度器侧将执行语义改为 at-least-once，端点收敛为 `poll`/`result`/`skill-packages`；删除 register/heartbeat/claim/renew/bindSession/cleanup、租约、`runId` fencing、`late_result`、`cleanupPending`、`seq/ackSeq`。client 已按 v2 改造，字段权威见 `contracts/executor-http-v2.md`，迁移记录见 `docs/history/works/2026-11-10-contract-v2-migration/`。
- **配置键已冻结（2026-11-08，OQ-014 关闭）**：`[acp].dsh_home`/`permission`、`[state].root`、`[logging].level`、`[capacity].max_instances`；`stateRoot` 默认 `<runDir>/.agent-flow-client`。
- **退出码已冻结（2026-11-08，OQ-015 关闭）**：`run` 非成功 `NodeResult` 用 `1`，SIGINT `130`、SIGTERM `143`；其余按 §3.2。
- **S0 已落地（2026-11-08）**：8 个组件转 `active`；`run`/`doctor` 可用，`SCN-0002` 3+1 与 `SCN-0001` S0 用例通过；见 `docs/history/works/2026-11-08-s0-local-loop/result.md`。
- **S1 已落地（2026-11-08）**：`CMP-gateway` 转 `active`；`serve` 接桩调度器跑通注册/心跳/领取/绑定/`C-05`/上报/清理；S1 门禁 8 条有测试；见 `docs/history/works/2026-11-08-s1-contract-skeleton/result.md`。
- **S2 已落地（2026-11-09，A 方案内）**：顺序两节点、技能切换、同 attempt 幂等、同容器技能集冲突守卫、清理幂等；Q1 保持 A，不升协议版本；fan-out 真并发留 B 决策。见 `docs/history/works/2026-11-09-s2-linear-and-recovery/result.md`。
