---
layer: design
module: execution-plane
component: CMP-executor
status: planned
updated: 2026-11-07
---

# CMP-executor 组件规格

> 状态：`planned`。只有职责、契约与内部设计，无代码/测试；S0 落地后转 `active`。
>
> 上游：`docs/design/architecture.md` §4–§6；`SCN-0001`；`REQ-0002`；概念取舍见 `docs/history/decisions/2026-11-03-client-concept.md`。
>
> 本组件是 5 个端口的**定义方**。端口签名是跨组件契约的唯一来源；L0 规格只写实现行为，不另立签名。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L1b 领域能力；业务。
- **业务价值**：保证「一个节点尝试怎么执行」的顺序与失败语义。没有它，`先建 session → 取技能 → 刷技能 → prompt` 会散到 CLI 与 runtime 各写一半。
- **负责 X**：
  - 节点尝试状态机与执行序列；
  - `attemptId` 去重与单飞（同一 attempt 不重复执行）；
  - 实例级取消、prompt 超时分岔；
  - 技能集 digest 幂等与同容器不同技能集的违约判定；
  - 组装 `NodeResult`、先落 journal 再上报；
  - 崩溃恢复的编排（读 journal、清孤儿、标记未收口 attempt）。
- **不负责 Y**：
  - HTTP/ACP/文件/解压的具体实现（端口背后的 L0）；
  - 编排决策（下一节点、评审、分支、fan-out 拆分、回退）；
  - 结果字段的业务含义（`CMP-result`）；
  - 调度器字段契约的权威（调度器侧，M1 冻结）。
- **变化轴**：执行流程语义（顺序、重试边界、取消语义、幂等窗口）。
- **删除测试**：删掉后「先刷技能再 prompt」「一节点一 session」「同 attempt 只执行一次」三条不变量无处安放——真边界。

## 2. 内部功能

### 2.1 用例入口

```ts
executeNode(request: NodeRequest, ctx: ExecutionContext): Promise<NodeResult>
cancelInstance(instanceId: InstanceId, reason: CancelReason): Promise<void>
recover(instanceId: InstanceId): Promise<RecoveryReport>
snapshotAttempts(): ActiveAttemptSnapshot[]
reconcileCleanup(pending: CleanupPending[]): Promise<CleanupAck[]>
```

- `executeNode` 对**预期失败**不抛异常：返回 `NodeResult`，由 `status` / `error.class` 表达。只有违反编程前提（例如缺少 ports）才抛。
- `cancelInstance` 是实例级（含整个 fan-out）取消；只做收口，不等待 prompt 自然结算。
- `recover` 在启动时由 CLI 调用，返回待处理 attempt 与清理结果；不自动重跑。
- `snapshotAttempts()` 返回当前活跃 attempt 的只读快照（`phase`/`sessionId`），供 CLI 组装 `ClientState`；不暴露 `AttemptRegistry`。
- `reconcileCleanup(pending)` 执行实例终结与清理对账：取消活跃 attempt → 关 session/进程 → `workspace.cleanup` → 清孤儿；返回每条 `releaseId` 的 `CleanupAck`。幂等，按 `releaseId` 去重；`cleanupPending` 的对账不越过 executor。
- 去重只是进程内优化；正确性依赖 `workspace.cleanup` 与调度器 `releaseId` 幂等，崩溃后重复执行可接受（`ND2-03`）。
- 事件先于 `cleanupPending` 到达时，CLI 用 `{releaseId, instanceId, cleanup, releasedAt: issuedAt}` 合成 `CleanupPending`；`workspacePath` 缺失则按 `instanceId` 查 journal（契约 §5.1.5）。

### 2.2 尝试状态机

生命周期：

```
claimed ──▶ bound ──▶ ready ──▶ running ──▶ settled ──▶ reported ──▶ closed
```

- **失败/取消/超时**：从当前状态直接进入 `settled`（携带 `NodeResult.status`），再走 `reported → closed`；不跳过结果持久化与资源回收。
- **恢复**：`recover` 发现的未收口记录 → `abandoned`（无结果，不自动重跑）。

| 状态 | 进入条件 | 必须已发生 | 失败/异常时 |
|---|---|---|---|
| `claimed` | 收到请求并通过去重 | journal 记 `claimed` | `settled(failed)` |
| `bound` | session 已建，`bindSession` 返回技能集 | session 已登记；`sessionId` 已记 journal | `settled(failed)` + 关 session |
| `ready` | 容器校验通过、实例就绪、技能集安装成功 | digest 已确认；journal 记 `ready` | `settled(failed)`（不 prompt） |
| `running` | prompt 已下发 | journal 记 `running` | `settled(failed/cancelled/timeout)` |
| `settled` | `NodeResult` 已组装并落 journal | 结果可重放，未依赖上报成功 | 上报失败 → 重试 `reported` |
| `reported` | 调度器 ack 或 `run` 本地输出完成 | journal 记 `reported` | 重试上报 |
| `closed` | session 已关、实例按需收口、journal 终态 | 无活跃 session | 终态 |
| `abandoned` | `recover` 发现上次未收口 | 孤儿清理由 CLI/runtime 执行；journal 记 `abandoned` | 终态，不自动重跑 |

结果状态（`NodeResult.status`）是 `succeeded` / `failed` / `cancelled` / `timeout`，由 `CMP-result` 组装，不是生命周期状态；生命周期终态只有 `closed` / `abandoned`。

规则：

1. 状态只前进，不回退；`settled` 是「结果已持久化、上报可重试」的分界。
2. 任何在 `running` 之前的失败都不允许下发 prompt。
3. `closed` 之前必须关闭 session；`reported` 之前必须已写 journal。
4. 并发 duplicate 请求不产生第二个状态机实例（见 §2.3）。
5. `failed` / `cancelled` / `timeout` 是结果标签，不是绕过收口的快捷路径；所有失败都走 `settled → reported → closed`。

### 2.3 去重与单飞

- 键：`attemptId`。
- 运行中重复调用：返回同一个 Promise（单飞），不新建状态机。
- 已终态重复调用：先查内存结果缓存，再查 journal 终态记录；命中则返回同一 `NodeResult`，不重新执行。
- 缓存是**派生状态**：容量有界（默认 128 条，可配），淘汰后以 journal 为准。
- journal 中无记录且缓存未命中：视为新 attempt；若 `attemptId` 已存在于 journal 的非终态记录，转 `recover` 路径，不直接执行。
- 去重窗口与结果缓存上限属 M1（`REQ-0002` R-01）。

### 2.4 执行序列

1. `begin(attemptId)`：去重 / 单飞 / journal 非终态检查。
2. `workspace.ensureContainer` → `workspace.validate`；失败即 `workspace_*`，不建 session。
3. `runtime.ensureInstance`；成功后按 `InstanceHandle` 的 pid/pgid 写 `OrphanRecord`；失败即 `runtime_*`，不建 session。
4. `runtime.newSession(cwd = container.root)`。
5. `scheduler.bindSession(attemptId, sessionId)` → `SkillSet`；失败按 `scheduler_*`，关 session。
6. `assets.currentDigest(container)`：同容器有活跃 session 且 digest 不同 → `asset_skill_set_conflict`，不 prompt。
7. `assets.install(skillSet, container)`；失败即 `asset_*`，不 prompt。
8. `journal.mark(ready)`；`runtime.prompt(text, { signal, timeoutMs })`；先记 `running` 再下发。
9. `result.assemble(outcome)` → `journal.mark(settled, result)` → `scheduler.reportResult`（或 `run` 输出）→ `journal.mark(reported)`。
10. `runtime.closeSession` → `journal.mark(closed)`。
11. 实例终结（`cancelInstance` 收口、`shutdown`、`reconcileCleanup`）统一由本组件执行：取消活跃 attempt → `runtime.shutdownInstance` → `workspace.cleanup` → `journal.clearOrphan(pid)`；顺序固定，只在 executor 定义一次。

顺序不可交换。`bindSession` 必须在 `newSession` 之后；`assets.install` 必须在 `prompt` 之前。

### 2.5 取消与超时

- 取消粒度：**实例**（含 fan-out 的所有 session）。不做单分支取消。
- 取消路径：`AbortSignal` 触发 → `runtime.cancel(session)` → `runtime.closeSession` → `shutdownInstance`（按实例状态）→ 结果 `cancelled`；**不等待 prompt 自然结算**。
- prompt 已先结算：按实际结果上报；已上报的取消只 ack（`stale`），不覆盖结果。
- 超时：与取消同路径，结果 `timeout`；超时值可注入，生产默认 M1 定。
- 取消/超时都必须回收进程组；残留检查窗口 2s（不是等待时间），由 `CMP-runtime` 执行。

### 2.6 技能集幂等与冲突

- 同容器同一 digest 重复安装：`CMP-assets` 返回 `noop`，executor 不重复替换。
- 同容器不同 digest 且存在活跃 session：判 `asset_skill_set_conflict`，拒绝该 attempt，不交错覆盖。违约方是调度器（并发同容器节点应同技能集）。
- 同一容器同一时刻只允许一个安装临界区；由 `CMP-assets` 的容器锁保证。
- executor 维护 `Map<containerRoot, { digest, activeSessions }>`，只用于冲突判定，不成为第二真相。

### 2.7 崩溃恢复

`recover(instanceId)`：

1. `journal.pending(instanceId)` 取非终态 attempt；
2. **已有结果**的 `settled` / `reported` 记录：重新上报（`reportResult` 按 attemptId 幂等）；成功后记 `reported` → `closed`；上报失败保留 `settled`，下次重试；
3. **无结果**的 `claimed`…`running` 记录：journal 标记 `abandoned`，记录原因与时间；
4. 返回 `RecoveryReport { abandoned: AttemptRecord[], reReported: AttemptRecord[], pendingReports: AttemptRecord[] }`。

孤儿进程由 CLI 在启动时先清理：`store.listOrphans` → `runtime.reapOrphan` → `store.clearOrphan`；executor 不直接杀进程，避免恢复职责与运行时所有权重叠。

不自动重跑未结算的节点；等调度器重新下发（`REQ-0002` R-04）。已经产生的结果不因崩溃丢弃，按 `reportResult` 幂等重报（R-02）。`run` 模式同样执行恢复，但不注册调度器。

### 2.8 内部结构

| 内部单元 | 职责 |
|---|---|
| `AttemptRegistry` | 去重、单飞、结果缓存、活跃 attempt 索引 |
| `AttemptRunner` | 单个 attempt 的状态机与执行序列 |
| `CancellationScope` | 实例级 `AbortController` 树；attempt 继承实例信号 |
| `SkillDigestGuard` | 容器 digest 与活跃 session 的冲突判定 |
| `RecoveryPlanner` | journal → 孤儿/残留清理计划 |
| `CleanupReconciler` | `cleanupPending` 对账：按 `releaseId` 去重、实例终结顺序、回执生成 |
| `ports.ts` | 5 个端口与值类型的唯一定义处 |

## 3. 契约

### 3.1 `executeNode`

- **签名**：`executeNode(request: NodeRequest, ctx: ExecutionContext) → Promise<NodeResult>`。
- **前置条件**：`request.attemptId` 非空；`request.workspacePath` 是绝对路径；`request.prompt` 非空；`ctx.signal` 可取消。
- **后置条件**：返回且仅返回一个 `NodeResult`；`attemptId` 与入参一致；session 已关闭（除非 `runtime` 已崩溃，此时 journal 记 `abandoned`）；journal 至少有一条终态或 `settled` 记录。
- **不变量**：
  1. 同一 `attemptId` 至多执行一次（进程内单飞 + journal 去重）。
  2. 未成功安装技能集不得下发 prompt。
  3. 一个 attempt 只使用一个 session；session 关闭后不复用。
  4. 取消/超时不等待 prompt 结算；结果 `cancelled` / `timeout`。
  5. 结果先落 journal 再上报；上报失败不回滚结果。
- **错误模式**：预期失败全部映射为 `NodeResult.error`，不抛出。`ErrorClass` 见 `CMP-result` 规格。
- **并发/幂等**：duplicate 返回同一结果；取消与结算竞争时以「先到者」为准，后者只 ack；同容器不同 digest 显式失败；上报返回 `late_result` 时只入审计，仍记 `reported` → `closed`，不覆盖新尝试。
- **超时/取消**：由 `ctx.signal` 与 `PromptOptions.timeoutMs` 表达；取消后不再接受新的 prompt。

### 3.2 `cancelInstance`

- **签名**：`cancelInstance(instanceId, reason) → Promise<void>`。
- **前置条件**：实例存在或已结束（幂等）。
- **后置条件**：该实例所有活跃 attempt 的 `AbortSignal` 已触发；runtime 已收到 cancel/close；进程组回收已发起。
- **不变量**：不等待 prompt 自然结算；已结算结果按实际上报；重复调用幂等。
- **错误模式**：仅基础设施错误抛出；业务层 unsupported 记为 `internal`。

### 3.3 `recover`

- **签名**：`recover(instanceId) → Promise<RecoveryReport>`。
- **前置/后置**：读 journal，不修改已终态记录；`settled` / `reported` 有结果的记录重报，`claimed`…`running` 无结果的记录标记 `abandoned`；不杀进程（孤儿由 CLI 调 runtime 清理）。
- **不变量**：不自动重跑未结算节点；已产生结果不因崩溃丢弃；`abandoned` 不当成新结果上报。
- **错误模式**：journal 损坏降级跳过并告警；重报失败保留 `settled` 并记录；清理失败不阻塞启动。

### 3.4 端口定义

> 签名只在 `CMP-executor` 定义。调度器相关值类型字段已按 [`contracts/executor-http-v1.md`](../../contracts/executor-http-v1.md) 冻结；L0 不得扩展字段或另立同名类型。

#### `SchedulerPort`

```ts
interface SchedulerPort {
  register(info: ClientInfo): Promise<RegistrationOutcome>;
  heartbeat(state: ClientState, acks?: CleanupAck[]): Promise<HeartbeatOutcome>;
  claim(capacity: Capacity): Promise<NodeRequest | null>;
  renew(attemptId: AttemptId): Promise<Lease>;
  bindSession(attemptId: AttemptId, sessionId: SessionId): Promise<SessionBinding>;
  reportResult(attemptId: AttemptId, result: NodeResult): Promise<Ack>;
}

type RegistrationOutcome = {
  serverTime: string;
  limits: Limits;
  assignmentsVersion: number;
  assignments?: Assignment[];
  cleanupPending: CleanupPending[];
};

type HeartbeatOutcome = {
  serverTime: string;
  control: ControlBatch;
  cleanupPending: CleanupPending[];
  assignmentsVersion: number;
  assignments?: Assignment[];
  nextPollAfterMs: number;
};
```

- `ackSeq` 与 `clientLease` 属于 gateway 的传输层状态，不进入端口签名：gateway 自己拼请求体、自己收租约。
- `HeartbeatRequest` / `HeartbeatResult` / `Registration` 是 HTTP 线格式，只在契约 §6.6 定义；`ClientState` / `ActiveAttemptSnapshot` 也在契约 §6.6，本端口只暴露裁剪后的领域字段。

- 不变量：`claim` 只返回绑定本 client 的请求；`bindSession` 只接受本 client 为本 attempt 创建且未关闭的 session；`reportResult` 同 attempt 幂等；版本不兼容拒绝领取。
- `claim` 的 `claimRequestId` 由 gateway 生成并持有，不进入端口签名；`cleanupAcks` 由 CLI 传入 `heartbeat`，gateway 拼进请求体。
- `SessionBinding` 不再含 `lease`；租约唯一来源是 `claim` / `renew`（`Q20`）。
- `Registration` / `HeartbeatResult` / `HeartbeatRequest` / `SessionBinding` / `Assignment` / `CleanupPending` / `CleanupAck` 的字段定义见 [`contracts/executor-http-v1.md`](../../contracts/executor-http-v1.md) §6.6；本规格不复制，避免两套真相。
- 消费方：`CMP-executor` 只用 `bindSession` / `reportResult`；`CMP-cli` 只用 `register` / `heartbeat` / `claim` / `renew`。方法集合固定，不按消费方拆端口。
- 错误：`unreachable` / `timeout`（可重试）、`unauthorized`（停止）、`version_incompatible`（停止）、`lease_expired`（丢弃尝试）、`rate_limited`（退避）、`invalid_request`（记录并放弃）。

#### `RuntimePort`

```ts
interface RuntimePort {
  ensureInstance(instance: InstanceSpec): Promise<InstanceHandle>;
  newSession(instance: InstanceHandle, cwd: string): Promise<SessionRef>;
  prompt(session: SessionRef, text: string, opts: PromptOptions): Promise<SessionOutcome>;
  cancel(session: SessionRef): Promise<void>;
  closeSession(session: SessionRef): Promise<void>;
  shutdownInstance(instance: InstanceHandle, mode: ShutdownMode): Promise<void>;
}
```

- 不变量：一实例一进程；一 session 同时最多一个进行中的 prompt；关闭后不复用；`cancel` 立即终止，不等结算；`closeSession` 幂等。
- 错误：`spawn_failed`、`protocol_error`、`prompt_failed`、`cancelled`、`timeout`、`process_exited`。

#### `WorkspacePort`

```ts
interface WorkspacePort {
  ensureContainer(instance: InstanceHandle, path: string): Promise<ContainerPaths>;
  validate(container: ContainerPaths): Promise<LayoutReport>;
  resolve(container: ContainerPaths, relPath: string): Promise<string>;
  cleanup(instance: InstanceHandle, policy: CleanupPolicy): Promise<void>;
}
```

- 不变量：容器预置；容器根即技能根；所有读写限制在容器内；清理幂等且默认不删预置仓库。
- 错误：`not_prepared`、`layout_invalid`、`path_escape`、`permission_denied`、`disk_full`。

#### `AssetPort`

```ts
interface AssetPort {
  install(skillSet: SkillSet, container: ContainerPaths): Promise<InstalledSkills>;
  verify(pkg: SkillPackageRef): Promise<ChecksumResult>;
  currentDigest(container: ContainerPaths): Promise<string | null>;
}
```

- 不变量：替换语义、原子生效；失败不留半套；同 digest 重复安装为空操作；脚本落地即可执行。
- 错误：`download_failed`、`checksum_mismatch`、`unpack_failed`、`invalid_skill_format`、`io_error`、`asset_skill_set_conflict`。

#### `JournalPort`

```ts
interface JournalPort {
  append(record: AttemptRecord): Promise<void>;
  pending(instanceId: InstanceId): Promise<AttemptRecord[]>;
  pendingAll(): Promise<AttemptRecord[]>;
  listInstances(): Promise<InstanceId[]>;
  mark(attemptId: AttemptId, state: AttemptState, patch?: Partial<AttemptRecord>): Promise<void>;
  lockInstance(instanceId: InstanceId): Promise<Unlock>;
  recordOrphan(record: OrphanRecord): Promise<void>;
  listOrphans(instanceId?: InstanceId): Promise<OrphanRecord[]>;
  clearOrphan(pid: number): Promise<void>;
}
```

- 不变量：追加不覆盖；同实例单写（锁）；状态可重建；损坏记录可降级跳过；孤儿记录不含敏感信息。
- `pendingAll` / `listInstances` 只在没有 `assignments` 快照时用于恢复枚举；不是新增调度器契约（P2）。
- **取锁点（`AD-04`）**：CLI 在 `claim` 成功、`executeNode` 之前调 `lockInstance`，`closed`/`abandoned` 后释放；取锁失败即拒绝执行该 attempt 并报 `failed(workspace)`。executor 不自行取锁。
- 错误：`io_error`、`locked`、`corrupt`。
- 孤儿方法：executor 只写 `recordOrphan` / `clearOrphan`；`listOrphans` 供 CLI 启动恢复使用。

### 3.5 值类型（冻结）

```ts
type AttemptState =
  | "claimed" | "bound" | "ready" | "running"
  | "settled" | "reported" | "closed"
  | "abandoned";

type ExecutionContext = {
  signal: AbortSignal;
  deadline?: number;
  trace: { instanceId: InstanceId; attemptId: AttemptId; nodeId: NodeId };
};

type NodeRequest = {
  attemptId: AttemptId;
  instanceId: InstanceId;
  nodeId: NodeId;
  attemptNo: number;        // 同一节点在本实例内的第几次尝试，从 1 开始
  prompt: string;
  workspacePath: string;
  claimedAt: string;        // 服务端授予时间，控制事件作用域判定
  timeoutMs: number;
  lease: Lease;             // 尝试租约，claim 授予
};

type AttemptRecord = {
  v: 1;
  ts: string;
  attemptId: AttemptId;
  instanceId: InstanceId;
  nodeId: NodeId;
  state: AttemptState;
  sessionId?: SessionId;
  result?: NodeResult;
  error?: { code: string; class: ErrorClass; message: string };
};

type OrphanRecord = {
  pid: number;
  pgid?: number;
  instanceId: InstanceId;
  attemptId?: AttemptId;
  createdAt: string;
  host: string;
};

type PromptOptions = {
  signal: AbortSignal;
  timeoutMs: number;
  onEvent?: (event: SessionEvent) => void;
};

type InstanceHandle = { instanceId: InstanceId; pid: number; pgid?: number };
type Unlock = () => Promise<void>;
type ShutdownMode = "graceful" | "force";
type CleanupPolicy = "keep" | "clean-skills" | "clean-client";
```

`InstanceSpec`、`SessionRef`、`SessionOutcome`、`Lease`、`SkillSet`、`ClientInfo`、`ClientState`、`Capacity`、`Ack` 的调度器相关字段以 [`contracts/executor-http-v1.md`](../../contracts/executor-http-v1.md) §6 为准；本规格只依赖语义，不依赖字段名。

`CMP-runtime` 的 `InstanceHandle` 必须暴露 `pid` / `pgid`，供 executor 写孤儿记录与收尾清理。

**凭据值类型归属（`ND-05`）**：`AuthProvider` / `SchedulerEndpoint` 定义在本节 `ports`，`CMP-gateway` 与 `CMP-assets` 各自实现/消费，组合根注入同一实例。共享策略只有一条：同 `scheduler.url` host 带 `Authorization`，跨 host 不带；`CMP-assets` 因此不需要 import gateway。

```ts
interface AuthProvider {
  authorizationFor(url: string): Promise<string | null>;
}

type SchedulerEndpoint = {
  baseUrl: string;
};
```

字段若后续扩展，按 P1 版本规则走；当前只冻结“定义位置 + 策略归属”。

`ports.ts` 内部分两区：**领域端口**（`SchedulerPort`/`RuntimePort`/`WorkspacePort`/`AssetPort`/`JournalPort`）与**跨 L0 共享值类型**（`AuthProvider`/`SchedulerEndpoint`）。后者不得长成第二套传输层；若继续增长，S1 抽独立 L0 小模块（`AH-05`）。

`NodeResult` / `SkillSet` / `ControlBatch` / `Lease` / `SessionOutcome` 的字段已冻结；本组件只依赖 `CMP-result` 提供的值类型名与不变量，不自行扩展。

## 4. 依赖与分层

| 依赖 | 契约 | 方向 | 冷热 |
|---|---|---|---|
| `CMP-result` | `assemble` / `classify` | L1b → L1a | 冷 |
| `SchedulerPort` | `bindSession` / `reportResult` | L1b → 端口（L0 实现） | 冷 |
| `RuntimePort` | 5 个方法 | L1b → 端口 | 冷 |
| `WorkspacePort` | 4 个方法 | L1b → 端口 | 冷 |
| `AssetPort` | 3 个方法 | L1b → 端口 | 冷 |
| `JournalPort` | 4 个方法 | L1b → 端口 | 冷 |
| `CMP-observability` | `log` / `progress` | 横切 | 冷 |

- 扇出：6（result + 5 端口），冷路径，≤8；不含 observability。
- 禁止边：不得 import 任何 L0 具体类型；不得 import `CMP-cli`；不得跨 attempt 共享可变业务状态；不得直连存储。
- 组合根：所有端口实现由 `CMP-cli` 注入；`CMP-executor` 不读环境变量、不选实现。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性 |
|---|---|---|---|
| 尝试状态（内存） | `CMP-executor` | `CMP-cli`、`CMP-observability` | 运行期唯一；可从 journal 重建 |
| 去重/单飞表 | `CMP-executor` | 自身 | 进程内；重启后依赖 journal |
| 容器 digest 活跃表 | `CMP-executor` | 自身 | 仅冲突判定，不持久化 |
| attempt journal 记录 | `CMP-store`（经 `JournalPort`） | executor、CLI | 追加写；结果先落 journal 再上报 |

## 6. 冷热与资源

- 整条节点执行是**冷路径**：分钟级长等、可重试、失败分类。
- 与租约热路径不共享定时器/锁/队列；prompt 等待不得阻塞心跳。
- 每实例独立进程/容器/`DSH_HOME`；技能安装大包走独立暂存目录，设大小上限（M1）。
- 取消/超时使用实例级 `AbortController`，不共享全局取消信号。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| 契约 | 正常单节点；duplicate 并发；duplicate 终态；journal 终态回放 | 单飞、幂等、返回同一结果 |
| 顺序 | 未建 session 不 bind；未装技能不 prompt；先 settled 再 reported | 调用序断言（桩端口记录） |
| 失败 | 容器非法、技能失败、DSH 启动失败、上报失败、取消、超时 | 状态机进入对应终态；不 prompt 的路径确实没有 prompt |
| 冲突 | 同容器不同 digest 并发 | `asset_skill_set_conflict`，不交错覆盖 |
| 恢复 | 崩溃点矩阵（claimed/bound/ready/running/settled/reported） | 无结果 → `abandoned`；有结果 → 幂等重报；不自动重跑；孤儿杀由 CLI/runtime 覆盖 |
| 并发 | 同实例多 session（fan-out）取消 | 全部 abort、无残留、各 attempt 结果独立 |
| 架构 | import 边界、端口签名、无 L0 具体类型 | 架构测试/静态检查 |

## 8. 预算与单独运行

- 预算：目标 ≤30k token（源码 + 规格 + 测试），上限 120k。
- 单独运行：`bun test tests/components/executor/`（落地后创建）；测试用桩实现 5 个端口，不启动 DSH。
- 状态：`planned`；无入口符号，场景 `entries` 暂不引用本组件。

## 9. 开放问题

- 去重窗口与结果缓存上限（R-01，M1）。
- prompt 超时默认值与是否可被节点覆盖（M1）。
- `NodeRequest` / `SkillSet` 字段已冻结（契约 §6.1/§6.3）；client 不扩展。
- 同容器并发写同一仓库的产物冲突：当前由流程层避免，client 不做仓库锁。
