---
layer: design
module: execution-plane
component: CMP-executor
status: active
updated: 2026-11-12
---

# CMP-executor 组件规格（v3）

> 状态：`active`（executor contract v3，2026-11-12）。端口与值类型的唯一来源：`ports.ts`、`domain-types.ts`、`scheduler-port.ts`。
>
> 上游：`architecture.md` §4–§6；`SCN-0001`；[`contracts/executor-http-v3.md`](../../contracts/executor-http-v3.md)。

## 1. 职责与边界

- **业务价值**：保证「一个任务怎么执行」的顺序与失败语义：容器校验 → task-space → 实例 → session → 技能 → prompt → 日志上传 → 结果落盘。
- **负责**：任务状态 `received → running → settled`；同 `taskId` 单飞；实例级取消；`P-04` 日志上传时序（含 0 行空日志）；结果组装与落盘；孤儿记录。
- **不负责**：调度器协议（gateway）、HTTP/ACP/文件细节（L0）、结果字段语义（result）、编排决策。
- **删除测试**：删掉后「先装技能再 prompt」「一任务一 session」「结果先落盘」会散到 CLI 与 L0。

## 2. 执行序列

1. `journal.append(received)`。
2. `workspace.ensureContainer` → `workspace.ensureTaskSpace(task, container)`（校验绝对路径且在 `workspacePath` 之下；不存在则建目录；**只建目录、不写内容**）。
3. `runtime.ensureInstance` → `recordOrphan`。
4. `runtime.newSession(cwd=容器根)` → `journal.mark(running, {sessionId})`。
5. `assets.install(task.skillSet, container)`：同 digest 短路；同容器安装由 assets 串行。
6. `runtime.prompt(task.prompt, {signal, timeoutMs, idleTimeoutMs?, onEvent})`：`onEvent` 把原始 ACP 事件写入本次 attempt 的会话日志。
7. `scheduler.uploadSessionLog(taskId, attempt, gz)`：**先传日志、拿到 `200` 再报结果**；无事件时传 0 行 gzip ndjson；`413` 时改为上传空日志并把结果置 `failed(session_log_too_large)`；`404` 时丢弃上传与结果。
8. `result.assemble` → `journal.mark(settled, {result})` → `runtime.closeSession`。
9. 返回 `TaskResult`；上报与 `accepted` 由 CLI 负责。

- 任何 prompt 之前的失败都进 `settled`，不 prompt；这些失败同样按第 7 步先传 0 行空日志再报结果。
- 同 `taskId` 并发调用返回同一 Promise；不同 `taskId`（同实例）可并发。
- 取消：`cancelInstance` abort 该实例所有在跑任务并 `runtime.cancel`；`cancelAll` 用于停机。
- `shutdownInstances` 关闭所有实例进程并清孤儿记录。

## 3. 端口

| 端口 | 方法 | 说明 |
|---|---|---|
| `RuntimePort` | `ensureInstance` / `newSession` / `prompt` / `cancel` / `closeSession` / `shutdownInstance` / `activeSessions` | 一实例一进程；同实例多 session |
| `WorkspacePort` | `ensureContainer` / `validate` / `resolve` | 容器预置、路径约束 |
| `AssetPort` | `install` / `verify` / `currentDigest` | 替换不叠加、digest 幂等 |
| `JournalPort` | `append` / `mark` / `settled` / `recordOrphan` / `listOrphans` / `clearOrphan` | 结果先落盘；孤儿记录 |
| `SchedulerPort` | `poll` / `reportResult` / `downloadPackage` | 由 gateway 实现；executor 不直接依赖 |

值类型：`TaskRequest`、`TaskResult`、`TaskRecord`、`PollRequest`、`PollResponse`、`ResultAck`、`SessionOutcome`、`ContainerPaths`、`InstalledSkills`、`OrphanRecord`。字段以契约 v2 §5 为准，组件不扩展。

## 4. 不变量

1. 一个任务一个 session，不复用。
2. 未成功安装技能不得 prompt。
3. 结果先落 journal（`settled`）再交给 CLI 上报。
4. 同 `taskId` 至多一个在跑实例；重复调用返回同一结果 Promise。
5. 取消/超时不等待 prompt 自然结算；结果 `cancelled`/`timeout`。
6. 不自动重跑；重派是新 `attempt`。

## 5. 数据所有权

| 数据 | 写入口 | 一致性 |
|---|---|---|
| 在跑任务、结果缓存 | executor | 运行期；可从 journal 重建 |
| 任务状态/结果 | store（经 JournalPort） | 追加写；`settled` 先落盘 |

## 6. 验证

| 类型 | 用例 | 文件 |
|---|---|---|
| 正常 | 状态序列、技能、session 关闭 | `tests/components/executor/execute.test.ts` |
| 并发 | 同 taskId 单飞；同实例多任务 | 同上、`tests/scenarios/v2-serve.test.ts` |
| 失败 | 技能失败不 prompt；超时；取消 | 同上 |
| 结果 | 截断、分类 | `tests/components/result/result.test.ts` |

## 7. 单独运行

`bun test tests/components/executor/`；桩实现 4 个端口，不启动 DSH。

## 8. 开放问题

- 多实例 home 派生（OQ-009）：当前一实例一进程，但 home 复用配置值。
- fan-out 同容器写冲突由流程层避免，client 不做仓库锁。
