---
layer: design
module: execution-plane
component: CMP-cli
status: active
updated: 2026-11-08
---

# CMP-cli 组件规格

> 状态：`active`（2026-11-08，T1 落地）。命令面、配置加载/冻结、退出码、组合根骨架与 `doctor` 已实现；`serve` 循环与执行内核在 S1/T5 接入。
>
> 上游：`docs/design/architecture.md` §3、§4、§10；`SCN-0002`；`REQ-0001`；`REQ-0002` R-04/R-09/R-10；配置键清单见 OQ-014。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L2 整合；业务入口 + 组合根。
- **业务价值**：把操作者的运行意图变成一次 `serve` 循环、一次本地 `run` 或一次 `doctor`；没有它，client 无法被启动，L0 实现也无处装配。
- **负责 X**：
  - 命令解析与帮助；
  - 配置加载、优先级、校验、冻结；
  - `serve` 循环：注册、心跳、领取、容量、实例生命周期、控制事件分派；
  - `run` 单次：本地 `NodeRequest` → 内核 → stdout；
  - `doctor` 编排：收集检查项、聚合结论、退出码；
  - 组合根：读取配置、选择实现、注入依赖；
  - 信号与退出码。
- **不负责 Y**：
  - 节点执行顺序与状态机（`CMP-executor`）；
  - HTTP/ACP/文件/解压细节（L0）；
  - 结果语义（`CMP-result`）；
  - 编排决策。
- **变化轴**：命令与部署形态、并发模型、配置键。
- **删除测试**：删掉后没有启动入口，复杂度会集中到宿主机脚本——真边界。

## 2. 内部功能

### 2.1 命令面

```text
agent-flow-client serve   [--config <path>] [--state-root <path>] [--log-level <level>] [--permission deny|allow]
agent-flow-client run     --request <file> [--config <path>] [--state-root <path>] [--permission deny|allow]
agent-flow-client doctor  [--config <path>] [--workspace <path>] [--json]
agent-flow-client version [--json]
agent-flow-client --help
```

- `serve`：常驻；注册 + 心跳长轮询 + 领取 + 执行；SIGINT/SIGTERM 优雅停。
- 容量只有一个来源：配置 `capacity.maxInstances`（OQ-014 冻结键名）。不提供 `--concurrency`，避免 flag 与配置两个来源（`AH-01`）。
- `run`：单次；不接调度器；用本地 `NodeRequest` 驱动同一执行内核；stdout 只输出 `NodeResult` JSON。
- `doctor`：本地检查，不依赖调度器；S0 不检查网络。
- `version`：client 版本、ACP 协议版本、DSH 基线版本。
- `--permission`：ACP 权限请求的本地策略；默认 `deny`，S0 本地调试可显式 `allow`。键名与是否进 `.config` 待 OQ-014。

### 2.2 运行目录 `<runDir>`

- 打包态：`dirname(process.execPath)`（可执行文件所在目录）。
- 源码态：`process.execPath` 是 `bun`/`node` 时，从 `import.meta.dir` 向上找最近的 `package.json` 所在目录；找不到则退出 2。
- **不使用** `process.cwd()`；不从解释器安装目录推导。
- `.config` 与默认 `AF_DSH_HOME` 都以 `<runDir>` 为基准。

### 2.3 配置加载

```ts
type AppConfig = Readonly<{
  runDir: string;
  acp: {
    dshHome: string;
    dshHomeSource: "env" | "config" | "default";
    permission: "deny" | "allow";
  };
  state: { root: string; source: "cli" | "config" | "default" };
  logging: { level: LogLevel; source: "cli" | "config" | "default" };
  capacity: { maxInstances: number; source: "config" | "default" };
  // S1 起：scheduler.url / retention；键名沿用本表
}>;
```

**配置键（v1 冻结，`OQ-014`）**：

| 段 | 键 | 类型/范围 | 默认 | 覆盖方式 |
|---|---|---|---|---|
| `[acp]` | `dsh_home` | string，绝对或相对 `<runDir>` | `<runDir>/AF_DSH_HOME` | `DSH_HOME` > 配置 |
| `[acp]` | `permission` | `deny` / `allow` | `deny` | `--permission` > 配置 |
| `[state]` | `root` | string，相对 `<runDir>` 解析 | `<runDir>/.agent-flow-client` | `--state-root` > 配置 |
| `[logging]` | `level` | `debug` / `info` / `warn` / `error` | `info` | `--log-level` > 配置 |
| `[capacity]` | `max_instances` | integer 1..64 | `4` | 仅配置 |
| `[scheduler]` | `url` | string，S1 使用 | 无 | 仅配置（S1） |

优先级（高 → 低）：**CLI flag > 环境变量（仅 `DSH_HOME`）> `<runDir>/.config` > 默认值**。`capacity.max_instances` 只能来自配置，不提供 flag（`AH-01`）。

`stateRoot` 默认选 `<runDir>/.agent-flow-client`：与 `REQ-0001` 的 `AF_DSH_HOME` 同一基准，不引入平台状态目录。运行目录不可写时**不静默回退**：退出 4（`state_root_unwritable`），提示用 `--state-root` 覆盖；`doctor` 报生效值。这是 `AH-02` 的收口。

规则：

- `.config` 为 TOML、UTF-8；用 Bun 内置 `Bun.TOML.parse`（不新增依赖）。
- 文件不存在 → 按默认值，不是错误。
- TOML 语法错误、`[acp].dsh_home` 非字符串、空/全空白 → **退出 2**，不回退默认。
- 未知键忽略并记 debug 日志；不做热加载。
- 空字符串环境变量按未设置处理。
- 相对路径按 `<runDir>` 解析，统一 `path.resolve` 为绝对路径；不做 `~` 展开。
- 解析出的 home 等于或位于 `~/.dsh` 之下 → **退出 2**（配置错误）。
- 目录不存在 → 以 `0700` 创建；已存在 → 必须是目录且可写；失败 **退出 4**（运行时目录错误）。
- 启动日志记录最终路径与来源（`env`/`config`/`default`），不打印配置内容或凭据。
- 加载后 `Object.freeze` 快照；运行期不重读。
- `DSH_HOME` 由 CLI 创建并校验 `0700`、拒绝 `~/.dsh`；运行期不删；实例终结由 `CMP-runtime.shutdownInstance` 删除。

### 2.4 `serve` 循环

1. 加载配置、组合根装配。
2. 清理孤儿：`store.listOrphans()` → `runtime.reapOrphan(orphan)` → `store.clearOrphan(pid)`。
3. `scheduler.register`（新 `runId`）；返回 `assignments`（可选）与 `cleanupPending`；失败按错误类别退避/退出。
4. **清理对账**：把 `cleanupPending` 交给 `executor.reconcileCleanup(pending)`，结果暂存到下一跳 `cleanupAcks`；cleanup 完成前该实例不领取（`SCH-20`）。CLI 不直接调 `RuntimePort`/`WorkspacePort`。
5. 恢复：`executor.recover(...)`：未结算的标记 `abandoned`，已产生结果的按 `attemptId` 幂等重报；无 `assignments` 时用 `JournalPort.listInstances()` / `pendingAll()` 枚举；重报失败保留 `settled`，下次重试。
6. 启动**独立**心跳任务：`state = { capacity, pausedInstances, activeAttempts: executor.snapshotAttempts(), assignmentsVersion }`，调 `heartbeat(state, cleanupAcks)`；响应里的 `assignmentsVersion`/`assignments` 更新本地容器视图；`ackSeq`/`clientLease` 由 gateway 内部处理。
7. 领取循环：有容量时 `claim(capacity)`（`claimRequestId` 由 gateway 生成/复用）；无请求则等待下一次心跳/短退避。
8. 对每个请求：`journal.lockInstance(instanceId)` → `executor.executeNode`（异步）→ 在 `closed`/`abandoned` 后释放锁；同一 `instanceId` 同一时刻只执行一个 attempt（`SCH-19`）。取锁失败报 `failed(workspace)`，不执行。
9. 控制事件分派：`cancel` → `executor.cancelInstance`；`pause` → 停止领取 + 取消活跃；`resume` → 恢复领取；`shutdown(instanceId, cleanup, releaseId)` → 有 `cleanupPending` 则按 `releaseId` 合并，**没有则用事件字段合成** `{releaseId, instanceId, cleanup, releasedAt: issuedAt}`（`workspacePath` 缺失，由 executor 按契约 §5.1.5 回查 journal），再交 `executor.reconcileCleanup`；无 `instanceId` → 优雅停整个 client。
10. 实例结束/取消/关闭：由 executor 统一收口（关 session/进程、`workspace.cleanup`、`journal.clearOrphan`）；CLI 只负责释放锁、容量与回执。
11. 信号：第一次 SIGINT/SIGTERM → 停止领取 → 取消活跃 → flush journal → 关 session/进程 → 退出；第二次 → 强杀并记录未收口 attempt。

- 心跳与执行**不共享定时器/队列**；prompt 再长也不阻塞心跳。
- 容量单位：实例数 + 同实例串行（契约 §11 方案 A，`SCH-19`）。
- `snapshotAttempts()` 是观测快照，`capacity.activeAttempts` 允许与其瞬时不一致；判定以服务端为准（`ND2-05`）。
- 同一实例不并发执行；client 可承载多实例，受 `maxInstances` 限制。
- `409 run_superseded`：停止领取、取消活跃、收口后退出 7，不再重连。

### 2.5 `run` 单次

1. 读取 `--request <file>` JSON，最小校验 `attemptId` / `instanceId` / `workspacePath` / `prompt` / `skillSet`；非法退出 2。
2. 用 `LocalSchedulerAdapter` 实现 `SchedulerPort`：`bindSession` 返回请求内联的技能集；`reportResult` 捕获结果；`register`/`heartbeat` 返回最小合法值；`claim` 只返回一次本地请求；不产生调度器 I/O。
3. 调用 `executor.executeNode`；stdout 输出一份 `NodeResult` JSON；日志只走 stderr。
4. 退出码：结果 `succeeded` → 0；`failed` / `cancelled` / `timeout` → 1；配置/用法 2；运行时 4；工作区/资产 5。

`run` 启动时同样执行恢复：清孤儿（`store` + `runtime`）、把未收口 attempt 标记 `abandoned`，然后才执行新请求。

`LocalSchedulerAdapter` 是组合根的本地适配器，不是新组件；`run` 与 `serve` 共用同一执行内核。

### 2.6 `doctor`

- 收集检查项（由各 L0 暴露的 `diagnose()` 提供，CLI 编排）：
  - 配置：home 来源、绝对路径、不是 `~/.dsh`、存在/可写、权限；
  - DSH：二进制定位、版本、与基线兼容；
  - 凭据：`DEEPSEEK_API_KEY` 或 `.credentials.yaml` 是否存在（只显示“已配置/未配置”）；
  - 工作区（传 `--workspace` 时）：容器布局、`findProjectRoot(容器根) === 容器根`、可写；
  - 残留：journal 未收口 attempt、实例锁、孤儿进程、残留 session；
  - 调度器连通性（S1；S0 标 `none`）。
- 输出：人类可读表格或 `--json`；生效配置脱敏。
- 退出码按阻塞项：配置 2、版本/鉴权 3、DSH/运行时 4、工作区/资产 5；全部通过 0（可有非阻塞警告）。
- `doctor` 不启动执行、不注册调度器、不改配置。

### 2.7 组合根

装配顺序：

```
config → observability → store → workspace → assets → runtime → gateway
      → executor（注入 result + 5 端口）→ CLI 命令
```

- 只有组合根 import L0 具体实现；`serve` 注入 gateway；`run` 注入 `LocalSchedulerAdapter`。
- 模块内部禁止用环境变量挑选实现；配置在组合根读取、校验、类型化后传入。
- 测试通过测试组合根或桩端口注入。

### 2.8 信号与退出码

| 码 | 含义 |
|---|---|
| `0` | 成功；或 `doctor` 全绿 |
| `1` | `run` 产生了非成功 `NodeResult`（failed/cancelled/timeout） |
| `2` | 用法/配置错误（含非法 TOML、空值、指向 `~/.dsh`） |
| `3` | 鉴权或版本不兼容 |
| `4` | DSH/运行时失败（含 home 不可创建/不可写） |
| `5` | 工作区或资产失败 |
| `6` | 调度器不可达（持续重试后） |
| `7` | `run_superseded`：本 run 被更新 run 顶掉 |
| `130` | SIGINT 优雅退出 |
| `143` | SIGTERM 优雅退出 |

- 第二次信号：强杀进程组，记录未收口 attempt，以同一信号码退出。
- 退出码是 CLI 契约；组件错误码到退出码的映射在组合根完成。

## 3. 契约

### 3.1 CLI 操作面

- **签名**：进程入口 `main(argv, env, stdio) → Promise<number>`。
- **前置**：无。
- **后置**：按命令产生 stdout/stderr 与退出码；`run` 的 stdout 必须是单个可解析的 `NodeResult` JSON；日志不混入 stdout。
- **不变量**：配置启动时一次加载并冻结；`serve` 与 `run` 共用执行内核；`doctor` 不依赖网络（S0）。
- **错误模式**：配置错误 2、鉴权/版本 3、运行时 4、工作区/资产 5、调度器不可达 6、`run_superseded` 7；不静默回退。

### 3.2 对 `CMP-executor` 的调用

- 只调用 `executeNode`、`cancelInstance`、`recover`、`snapshotAttempts`、`reconcileCleanup`；`cleanupPending` 的实例终结与清理由 executor 执行，CLI 只搬运与回执。
- 不直接调用 L0 组件完成执行；L0 只在组合根与 `doctor` 编排中出现。
- `serve` 不解释 `NodeResult` 业务含义；`run` 原样输出。

### 3.3 契约卡：配置快照

- **签名**：`loadConfig(runDir, env, fileReader) → AppConfig`。
- **前置**：`runDir` 已解析。
- **后置**：返回冻结的绝对路径配置；home 目录已确保存在且可写。
- **不变量**：env > config > default；空 env 视为未设置；非法输入不回退。
- **错误模式**：`config_invalid`（2）、`home_forbidden`（2）、`home_unwritable` / `home_create_failed`（4）。

## 4. 依赖与分层

| 依赖 | 契约 | 说明 |
|---|---|---|
| `CMP-executor` | `executeNode` / `cancelInstance` / `recover` | 唯一执行入口 |
| `SchedulerPort` | 6 个方法 | `serve` 用 lease 组；`run` 用本地适配器 |
| `CMP-store` | `JournalPort` | 启动恢复、锁、flush |
| `CMP-runtime` / `CMP-workspace` / `CMP-assets` | 各自端口 | 组合根注入；`doctor` 收集检查 |
| `CMP-observability` | `log` / `doctor` 渲染 | 日志与检查输出 |

- L2 → L1 契约；L0 实现只在组合根出现。
- 禁止边：L0 不得 import `CMP-cli`；`CMP-cli` 不把 L0 类型泄漏进 executor 契约。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性 |
|---|---|---|---|
| 配置 | `CMP-cli`（加载后只读） | 全部（注入） | 启动校验；运行期不变 |
| 运行目录解析结果 | `CMP-cli` | 配置/home 解析 | 启动时一次 |
| `run` 的本地结果 | `CMP-cli`（stdout） | 操作者/测试 | 不持久化 |

## 6. 冷热与资源

- 热路径：租约循环（注册/心跳/领取/续约），同步依赖 1（`SchedulerPort`），独立定时器，失败退避，不阻塞执行。
- 冷路径：节点执行、恢复、`doctor`、技能安装；不与热路径共享队列/锁。
- `serve` 进程级资源：心跳任务、领取循环、每实例执行任务；容量上限防止超卖。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| 配置矩阵 | `TC-CONFIG-001`…`004`：默认、绝对/相对、env 覆盖、非法 TOML/空值/不可写/`~/.dsh` | 生效值、来源、退出码、DSH 子进程入参 |
| 命令 | `--help`、`version`、未知命令、缺参数 | 输出/退出码 |
| `serve` | 桩端口：领取→执行→回报；取消；暂停/恢复；容量；二次信号 | 循环不重复执行、心跳不被阻塞 |
| `run` | 单节点成功/失败/取消；stdout 只有 JSON；退出码 0/1 | 与 `serve` 共用内核 |
| `doctor` | 全绿、缺 DSH、版本不兼容、容器非法、残留 session/lock/孤儿 | 检查项、脱敏、退出码 |
| 架构 | import 边界；L0 只在组合根 | 静态检查 |

对应场景：`SCN-0002` 的 3+1；`SCN-0001` 的 R1 home 落点与 S0 用例。

## 8. 预算与单独运行

- 预算：目标 ≤35k token，上限 120k。
- 单独运行：`bun test tests/components/cli/`；用临时目录 + 假 L0 端口。
- 实现入口（T1）：`src/components/cli/main.ts#main`、`config.ts#loadConfig`、`run-dir.ts#resolveRunDir`、`args.ts#parseArgs`、`doctor-checks.ts#collectDoctorChecks`、`exit-codes.ts#ExitCode`；测试 `tests/components/cli/`。
- 状态：`active`（`serve` 循环与执行接线待 S1/T5）。

## 9. 开放问题

- 除 `[acp].dsh_home` 外的配置键与优先级（OQ-014，M1）。
- 容量单位已冻结：实例数 + 同实例串行（OQ-011 已关闭，契约 §11）。
- `run` 的退出码 `1` 与 SIGTERM `143` 需在架构 §3.2 同步（本次已补，待确认）。
- 打包态 `process.execPath` 与源码态包根解析需在 S0 实测（REQ-0001 待确认项）。
- ~~`stateRoot` 默认与平台目录~~ 已定（2026-11-08）：`<runDir>/.agent-flow-client`；不可写退出 4，不静默回退。
- 权限策略默认值（`allow` / `deny`）与是否可配置，需在 S0 定。
