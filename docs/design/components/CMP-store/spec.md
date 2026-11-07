---
layer: design
module: execution-plane
component: CMP-store
status: planned
updated: 2026-11-04
---

# CMP-store 组件规格

> 状态：`planned`。本地恢复事实的唯一边界：journal、实例锁、孤儿进程记录。它是恢复依据，不是第二真相。
>
> 上游：`docs/design/architecture.md` §7、§10；`SCN-0001` UC-15/16/17；`REQ-0002` R-02/R-04；决策 D11（工作区预置）与「等重派」结论。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L0 基础设施；技术边界（本地持久化）。
- **业务价值**：崩溃后能说清「上次做到哪」，并让重启可清理、可等待重派；没有它，本地恢复事实无处存放。
- **负责 X**：
  - attempt journal 追加/读取/压缩；
  - 实例锁（单写）；
  - 孤儿进程记录（pid/pgid/instance/attempt）；
  - 启动恢复所需的 `pending` / `orphans` 查询；
  - 损坏记录的降级读取。
- **不负责 Y**：
  - 恢复决策（重跑/等重派由 executor/CLI 定）；
  - 调度器状态、结果权威；
  - 工作区内容、技能内容；
  - 日志轮转（`CMP-observability`）。
- **变化轴**：本地持久化格式与保留策略。
- **删除测试**：删掉后本地恢复事实无处存放——真边界。

## 2. 内部功能

### 2.1 目录布局

```text
<stateRoot>/                     ← 组合根注入；默认 <runDir>/.agent-flow-client
├── journal.jsonl                ← 追加写；一行一条 AttemptRecord
├── locks/<instanceId>.lock      ← 实例单写锁
└── orphans/<pid>.json           ← 孤儿进程记录
```

- `stateRoot` 由 CLI 配置；store 不自行推导。
- 目录以 `0700` 创建；文件 `0600`。
- 不把 journal 放在工作区容器内（避免被模型/工具读写）。

### 2.2 Journal

记录形态（`AttemptRecord`，字段与 `CMP-executor` §3.5 一致；`v` 为格式版本）：

```ts
type AttemptRecord = {
  v: 1;
  ts: string;
  attemptId: AttemptId;
  instanceId: InstanceId;
  nodeId: NodeId;
  state: AttemptState;
  sessionId?: SessionId;
  result?: NodeResult;   // settled/终态时写入
  error?: { code: string; class: ErrorClass; message: string };
};
```

- `append(record)`：一行 JSON + `\n`；`settled` / 终态记录 `fsync`；其他可批量。
- `mark(attemptId, state, patch)`：追加一条新记录，不原地修改；读取时按 `attemptId` 折叠最后一条。
- `pending(instanceId)`：返回该实例每个 attempt 的最新非终态记录（`claimed`…`reported`）。
- 损坏行：跳过并告警，继续读后续行；不因一行损坏阻塞启动。
- 压缩：文件超过阈值（默认 10MB 或 10k 行）时，将每个 attempt 的最新记录写成快照，原子 rename 替换；压缩失败保留原文件。
- 并发：同实例由锁保证单写；跨实例追加通过串行队列/文件锁避免交错行。

### 2.3 实例锁

- `lockInstance(instanceId)`：以 `wx` 创建 `locks/<instanceId>.lock`，内容 `{pid, host, startedAt}`；成功返回 `unlock`。
- 已存在锁：
  - 同 pid 且进程存活：返回 `locked`（同实例双跑）。
  - pid 不存活，或锁年龄超过阈值（默认 10 分钟）：视为陈旧锁，记录并接管；原锁内容归档到日志。
- `unlock` 幂等；进程退出时尽量释放；崩溃残留由下一次启动接管。
- 锁只防同实例双跑，不承担跨实例互斥。

### 2.4 孤儿进程记录

```ts
type OrphanRecord = {
  pid: number;
  pgid?: number;
  instanceId: InstanceId;
  attemptId?: AttemptId;
  createdAt: string;
  host: string;
};
```

- `recordOrphan`：executor 在 `ensureInstance` 成功后写入；同一 pid 覆盖。
- `listOrphans(instanceId?)`：按实例/全部列出；不探活。
- `clearOrphan(pid)`：删除记录；幂等。
- 启动恢复由 CLI 编排：`listOrphans` → `CMP-runtime.reapOrphan` → `clearOrphan`。
- store 不杀进程、不判断存活；只记录与查询。

### 2.5 恢复读取

- `pending(instanceId)` 用于 executor 恢复：无结果的未结算记录标记 `abandoned`，已产生结果的 `settled` / `reported` 记录幂等重报；
- `listOrphans` 用于 CLI 清理；
- 两者都只读，不修改 journal 的终态记录。
- 恢复不依赖 session 恢复或历史回放（`REQ-0002` R-04）。

## 3. 契约

### 3.1 实现 `JournalPort`

签名**只在 `CMP-executor` §3.4 定义**；本节是实现视图，不另立契约。当前 9 个方法（含 `pendingAll` / `listInstances`）：

```ts
interface JournalPort {
  append(record: AttemptRecord): Promise<void>;
  pending(instanceId: InstanceId): Promise<AttemptRecord[]>;
  pendingAll(): Promise<AttemptRecord[]>;
  mark(attemptId: AttemptId, state: AttemptState, patch?: Partial<AttemptRecord>): Promise<void>;
  lockInstance(instanceId: InstanceId): Promise<Unlock>;
  recordOrphan(record: OrphanRecord): Promise<void>;
  listOrphans(instanceId?: InstanceId): Promise<OrphanRecord[]>;
  clearOrphan(pid: number): Promise<void>;
  listInstances(): Promise<InstanceId[]>;
}
```

### 3.2 前置/后置/不变量

- 前置：`stateRoot` 已创建且可写；`attemptId`/`instanceId` 非空。
- 后置：`append`/`mark` 返回后记录已落盘（`settled`/终态已 `fsync`）。
- 不变量：
  1. 追加不覆盖；状态折叠以最后一条为准。
  2. 同实例单写（锁）；锁与数据不分离。
  3. 尝试状态可从 journal 重建。
  4. 损坏记录可降级跳过并告警，不阻塞启动。
  5. journal 不是第二真相：结果权威在调度器；本地记录只用于恢复与排障。
  6. 孤儿记录不包含凭据/提示词/完整输出。

### 3.3 错误模式

| 错误 | 触发 | 可重试 | 调用方应对 |
|---|---|---|---|
| `io_error` | 磁盘/权限/rename 失败 | 是（换路径/清理） | 节点失败；恢复降级 |
| `locked` | 同实例已有活跃锁 | 否 | 拒绝双跑；退出/等待 |
| `corrupt` | journal 头部/版本不可读 | 否 | 降级为空 journal + 告警；不删除原文件 |

### 3.4 `StoreAdmin`（L0 管理面）

```ts
interface StoreAdmin {
  diagnose(): Promise<CheckResult[]>;
  compact(): Promise<void>;
  stateRoot(): string;
}
```

- 由 `CMP-cli` 在 `doctor`/维护时调用；executor 不依赖。

## 4. 依赖与分层

- 依赖：`JournalPort` 类型、`CMP-observability`、标准库 `fs` / `path`。
- 禁止边：不得 import `CMP-cli`、`CMP-executor` 具体实现、`CMP-runtime`、`CMP-workspace`、`CMP-assets`、`CMP-gateway`；不得读工作区内容；不得读调度器状态。
- 组合根注入：`stateRoot`、保留/压缩阈值、日志器。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性/保留 |
|---|---|---|---|
| journal | `CMP-store`（唯一写入口） | executor、CLI、observability | 追加写；崩溃可重建 |
| 实例锁 | `CMP-store` | CLI、executor | 单写；陈旧锁可接管 |
| 孤儿记录 | `CMP-store` | CLI、runtime（消费） | 启动清理；不含敏感信息 |

## 6. 冷热与资源

- 冷路径：journal、锁、恢复、压缩；不参与心跳。
- `append` 在节点执行关键路径上，但只做本地追加；`settled` 一次 `fsync`，不放大为每事件一写。
- 压缩在启动/空闲时执行，不阻塞执行；压缩期间读取走旧文件+快照。
- 磁盘上限与保留策略可配（OQ-005）；`doctor` 报告 journal 大小。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| Journal | 追加/折叠/终态/pending | 最新状态正确；终态不丢 |
| 崩溃点 | claimed/bound/ready/running/settled 各点重启 | `pending` 可重建；不自动重跑 |
| 损坏 | 半行、非法 JSON、未知版本 | 降级跳过；启动不阻塞 |
| 压缩 | 超阈值压缩、压缩中断 | 数据不丢；原子替换 |
| 锁 | 同实例双跑、陈旧锁接管、unlock 幂等 | `locked` / 接管正确 |
| 孤儿 | 记录/列出/清理 | 幂等；不含敏感信息 |
| 并发 | 跨实例并发追加 | 行不交错、可解析 |

## 8. 预算与单独运行

- 预算：目标 ≤25k token，上限 120k。
- 单独运行：`bun test tests/components/store/`（落地后创建）；临时目录夹具。
- 状态：`planned`；无入口符号。

## 9. 开放问题

- `stateRoot` 默认路径与配置键（OQ-014；当前提案 `<runDir>/.agent-flow-client`）。
- journal 保留时长/大小与压缩阈值（OQ-005）。
- 锁的陈旧判定：仅 pid 探活，还是加启动时间/心跳（防 pid 复用）。
- 是否记录部分输出（OQ-013；当前默认不记录）。
