---
layer: design
module: execution-plane
component: CMP-runtime
status: active
updated: 2026-11-04
---

# CMP-runtime 组件规格

> 状态：`active`（2026-11-08，T4 落地）。实例进程、profile 补丁、session/prompt/update/permission/cancel/close 与进程组回收已实现；多实例 home 派生留 S1。
>
> 上游：`docs/design/architecture.md` §2、§5、§8、§10；`SCN-0001` UC-07/09/11/13/16/17/31；`REQ-0002` R-03/R-06/R-10；ACP 预研结论见 `docs/history/works/2026-11-03-dsh-acp-preflight/result.md`。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L0 基础设施；技术边界（防腐层）。
- **业务价值**：把 DSH 进程与 ACP 协议关在本机；一个失败节点能干净收口，不把 ACP 细节漏给领域层。
- **负责 X**：
  - DSH 二进制定位/版本校验/进程启动；
  - 实例 `DSH_HOME`、环境注入、profile 技能可见性补丁；
  - session 生命周期：`new → prompt → update → permission → cancel → close`；
  - ACP 事件累积为 `SessionOutcome`（最终消息、停止原因、用量、错误）；
  - 取消/关闭/崩溃后的进程组回收与残留检查；
  - 多 session（fan-out）并发与事件隔离。
- **不负责 Y**：
  - 技能下载/校验/替换（`CMP-assets`）；
  - 结果语义与截断（`CMP-result`）；
  - 调度器协议/租约（`CMP-gateway`）；
  - 工作区布局校验（`CMP-workspace`）；
  - 是否执行节点（`CMP-executor`）。
- **变化轴**：DSH 版本与 ACP 协议行为。
- **删除测试**：删掉后 ACP 协议细节会渗进 executor——真边界。

## 2. 内部功能

### 2.1 实例监督

| 内部单元 | 职责 |
|---|---|
| `InstanceSupervisor` | 每实例一个 DSH 进程；引用计数、启动/重启/关闭；进程退出通知 |
| `ProfilePatcher` | 生成实例技能可见性补丁、空目录；不修改用户 `~/.dsh` |
| `AcpConnection` | 行分隔 JSON-RPC；请求/响应/通知；超时与取消 |
| `SessionRegistry` | session 状态、每 session 单 prompt、事件累积、权限请求 |
| `ProcessReaper` | 进程组强杀、`kill -0` 残留检查、孤儿识别 |
| `PermissionPolicy` | `session/request_permission` 的本地裁决 |

### 2.2 进程启动

```text
dsh --profile acp --patch <instanceHome>/af/profile.skill-patch.yml
env: DSH_HOME=<instanceHome>, DEEPSEEK_API_KEY=<injected>（若提供）
cwd: <containerRoot>
stdio: stdin/stdout = ACP 行协议；stderr = 日志
```

- `ensureInstance(instance)` 幂等：进程存活且已 `initialize` 则复用；已崩溃则清理后重启。
- 一实例一进程；进程不跨实例共享。
- `DSH_HOME` 由调用方传入，runtime 不推导、不回退 `~/.dsh`；多实例 home 派生归 CLI/后续需求（OQ-009）。
- 不把凭据写入文件、日志或结果；只经环境变量注入（或按 M1 的凭据方案）。
- `stderr` 逐行转结构化日志，不进入 `SessionOutcome`。

### 2.3 技能可见性补丁

补丁文件内容（整份替换 `skill-filesystem` 配置，不深合并）：

```yaml
- id: skill-filesystem
  config:
    dshHome: <instanceHome>/empty/dsh
    agentsHome: <instanceHome>/empty/agents
    bundledSkillDir: <instanceHome>/empty/bundled
```

- 三个空目录由 runtime 以 `0700` 创建；不设置 `includeDefaultRoots`，回落 schema 默认 `true`，保留项目 `.dsh` / `.agents`。
- 不使用 `DSH_HOME` 环境变量关技能；它同时影响 settings/credentials。
- 补丁文件路径固定在实例 home 下；不修改 DSH 自动生成的 `profiles/acp` 模板。

### 2.4 Session 生命周期

```
opening ──▶ open ──▶ prompting ──▶ open
   │          │           │
   └──────────┴───────────┴──▶ closing ──▶ closed
                                   │
                                   └──▶ failed
```

- `newSession(instance, cwd)` → `session/new`，`cwd` 必须是容器根；返回 `SessionRef`。
- 一 session 同时最多一个进行中的 prompt；并发 prompt 是编程错误，显式拒绝。
- `prompt(session, text, opts)` → `session/prompt`；消费 `session/update` 通知直到响应返回。
- `closeSession` 幂等；关闭后不复用；关闭失败记录但不静默复用。
- 一实例可多 session（fan-out）；事件按 sessionId 隔离。

### 2.5 ACP 事件与结果提取

- `agent_message_chunk`（文本）→ 追加 `finalText`。
- `tool_call` / `tool_call_update` → 记录工具名/状态摘要，不保存完整参数与输出。
- `usage_update` → 归一为 `usage`；缺失则省略。
- `session/prompt` 响应 → `stopReason`。
- JSON-RPC error / 进程退出 → `RuntimeFailure`（`protocol_error` / `prompt_failed` / `process_exited`）。
- `session/request_permission` → 由 `PermissionPolicy` 裁决；允许时返回 `allow_once`/`allow_always` 的 `optionId`，拒绝时返回 `cancelled`。
- 不把完整会话记录跨边界；`SessionOutcome` 只含控制信息。

### 2.6 取消、关闭与回收

- `cancel(session)`：发送 `session/cancel` → 立即 `session/close` → 进程组强杀（POSIX `kill(-pgid)`）；**不等待 prompt 自然结算**。
- 取消后 2s 内做残留检查（`kill -0` 为假）；2s 是检查窗口，不是等待时间。
- `shutdownInstance(instance, mode)`：
  - `graceful`：关闭所有 session → stdin EOF → 等退出（上限 5s）→ 超时杀进程组；
  - `force`：直接杀进程组；
  - 进程组确认退出后删除实例 `DSH_HOME`；删除失败只记录并留给 `doctor`，不回滚已完成的关闭。
- `closeSession` 上限 10s；超时杀进程组。
- 崩溃：进程退出事件触发所有活跃 session 失败（`process_exited`）；清理 session 注册表。
- 孤儿进程：`RuntimeAdmin.reapOrphan(orphan)` 按 pid/pgid 强杀并返回是否存活过；由 CLI 在启动恢复时调用，runtime 不读 store。

### 2.7 诊断

`RuntimeAdmin.diagnose()` 返回检查项：

- DSH 二进制定位与版本；
- 实例 home 是否存在/可写/不是 `~/.dsh`；
- 残留 session 目录/锁（只报告，不删除）；
- 孤儿进程（只报告 pid/pgid）；
- profile 补丁是否存在且可解析。

## 3. 契约

### 3.1 实现 `RuntimePort`

签名见 `CMP-executor` §3.4；本组件只补充实现语义：

| 方法 | 实现语义 | 错误 |
|---|---|---|
| `ensureInstance` | 幂等启动/复用；`initialize` 超时 10s；版本校验 | `spawn_failed`、`protocol_error` |
| `newSession` | `session/new`，cwd 固定容器根；超时 10s | `protocol_error`、`prompt_failed` |
| `prompt` | `session/prompt`；消费 update；受 `AbortSignal` 与超时控制 | `cancelled`、`timeout`、`prompt_failed`、`process_exited` |
| `cancel` | `session/cancel` + close + 强杀；幂等 | 不抛业务错误 |
| `closeSession` | `session/close`；幂等；超时 10s | 记录并返回 |
| `shutdownInstance` | graceful/force；回收进程组 | 记录并返回 |

### 3.2 前置/后置/不变量

- 前置：`InstanceSpec.dshHome` 绝对路径、不是 `~/.dsh`；`containerRoot` 已校验为容器根。
- 后置：`shutdownInstance` 返回后进程组不再存活（或已记录无法回收）。
- 不变量：
  1. 一实例一 DSH 进程；一 session 同时最多一个 prompt。
  2. session 关闭后不复用；关闭幂等。
  3. 取消不等待 prompt 结算；已结算结果按实际返回。
  4. 事件按 session 隔离，不串流。
  5. 凭据不进 stdout/stderr/结果/日志。
  6. 不直接读写工作区内容（只把 cwd 传给 DSH）。

### 3.3 错误模式

| 错误 | 触发 | 可重试 | 调用方应对 |
|---|---|---|---|
| `spawn_failed` | 二进制缺失/权限/启动失败 | 是（换实例/重试） | 节点失败（runtime） |
| `protocol_error` | JSON-RPC 解析/未知响应 | 否 | 关 session，节点失败 |
| `prompt_failed` | prompt 返回错误 | 视错误码 | 关 session，节点失败 |
| `cancelled` | 收到取消 | 否 | 上报 `cancelled` |
| `timeout` | prompt 超时 | 是 | 上报 `timeout` |
| `process_exited` | 进程中途退出 | 是 | 关 session，节点失败 |
| `permission_denied` | 策略拒绝 | 否 | 模型收到拒绝结果，不挂起 |

### 3.4 `RuntimeAdmin`（L0 管理面，非执行端口）

```ts
interface RuntimeAdmin {
  diagnose(): Promise<CheckResult[]>;
  reapOrphan(orphan: OrphanRecord): Promise<boolean>;
}
```

- 由 `CMP-cli` 在 `doctor` 与启动恢复时调用；`CMP-executor` 不依赖。
- `OrphanRecord` 见 `CMP-executor` §3.5；runtime 只按 pid/pgid 执行回收，不 import store 实现。

## 4. 依赖与分层

- 依赖：`RuntimePort` 类型（L1 契约）、`CMP-observability`（日志）、标准库 `child_process` / `fs` / `path`。
- 禁止边：不得 import `CMP-cli`、`CMP-executor` 具体实现、`CMP-workspace`、`CMP-assets`、`CMP-gateway`；不得读调度器状态；不得改写工作区文件。
- 组合根注入：DSH 路径、实例 home、权限策略、日志器。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性/保留 |
|---|---|---|---|
| DSH 进程 / session 注册表 | `CMP-runtime` | executor、CLI、observability | 进程退出即回收 |
| `DSH_HOME`（实例） | CLI 创建并校验；runtime 独占写入 | runtime | 一实例一 home；不指向 `~/.dsh`；`shutdownInstance` 内删除，失败记录留给 `doctor` |
| profile 补丁 / 空目录 | `CMP-runtime` | DSH | 启动时生成；可重建 |
| `SessionOutcome` | `CMP-runtime` | executor / result | 请求级，不持久化 |
| 进程组 pid / 退出状态 | `CMP-runtime` | runtime、CLI | 运行期；孤儿记录归 store |

## 6. 冷热与资源

- 节点执行是冷路径：分钟级 prompt 长等；取消/超时 fail fast。
- 每实例独立进程、home、进程组；不与其他实例共享 stdio/锁。
- 进程组强杀隔离到实例；`shutdownInstance` 不与心跳热路径共享定时器。
- 大输出不落 client 全量 transcript；只累积最终消息与摘要，避免内存无界（结果上限由 `CMP-result` 截断）。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| ACP 基线 | `initialize` / `session/new` / `prompt` / `close` 回放 | 协议版本、sessionId、stopReason |
| 生命周期 | 多 session 顺序；close twice；close-before-prompt；prompt 进行中 close | 幂等、无泄漏、进程稳定 |
| 取消 | 长 prompt 取消；空 cancel；取消后新 session | `cancelled`、无残留、session 可再用 |
| 崩溃 | SIGKILL 进程；工具子进程存活检查 | `process_exited`、孤儿识别、`kill -0` 为假 |
| 技能可见性 | 补丁生效：全局根不可见、项目根可见 | catalog/加载行为（S0-05 变体） |
| 权限 | allow/reject 两条路径 | 请求有响应、模型不挂起 |
| 隔离 | 并发两实例/两 session | 事件不串、home 不串 |
| 诊断 | 缺 DSH、版本不兼容、home 不可写、残留 | 检查项与退出码 |

## 8. 预算与单独运行

- 预算：目标 ≤45k token，上限 120k。
- 单独运行：`bun test tests/components/runtime/`；用 ACP 桩（`tests/fixtures/fake-acp.mjs`），不调用真实模型。
- 实现入口（T4）：`src/components/runtime/runtime.ts#AcpRuntime`、`runtime-instance.ts#startInstance`、`acp-client.ts#AcpConnection`、`acp-protocol.ts#AcpProtocol`、`profile.ts#writeProfilePatch`、`admin.ts`（待补）；测试 `tests/components/runtime/`。
- 状态：`active`（单实例；多实例 home 派生待 S1）。

## 9. 开放问题

- 权限默认策略（`deny` / `allow`）与配置键（S0 定；默认建议 `deny`，测试注入 `allow`）。
- `DSH_HOME` 多实例派生（OQ-009；本组件只接收传入值）。
- DSH 版本兼容窗口与升级策略（OQ-003/OQ-008）。
- ACP `session/close` 在 prompt 进行中的行为，需 S0 复验。
- 孤儿进程回收的跨平台实现（macOS/Linux 进程组；Windows 后补，OQ-007）。
