---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 契约 v2 → v3 变更说明与 client 实现清单

> 权威：[`executor-http-v3.md`](executor-http-v3.md)（调度器侧 2026-11-12 修订版）。
> 本文只解释「变了什么、为什么、client 怎么改」，字段级语义以契约为准，不复制契约正文。
> 修订说明：2026-11-12 按 [`review.md`](review.md) 调整（`B-01`–`B-04`、`D-01`–`D-10`），见 [`response.md`](response.md)。

## 1 结论

v3 在 v2 的 at-least-once 任务模型上补两段：**执行前有 task-space、执行后有会话日志与运行归档**。任务仍是「一个 taskId 一个 session」，结果仍只带控制信息；新增的日志与归档走独立端点，不塞进结果。

相对 v2，client 侧需要新增的行为只有三件：**建 task-space 目录、节点结束先传日志（含 0 行空日志）再报结果、run 终态后后台打包上传归档**。其余（verdict 解析、回退、confirm、run 状态）都在调度器侧，client 不参与。

## 2 变更总表

| # | 变更 | v2 | v3 | 为什么 |
|---|---|---|---|---|
| 1 | 协议版本 | `X-Executor-Protocol: 2` | `3` | 新增必填字段 + 日志先于结果的语义变化；双端同批，无兼容窗口 |
| 2 | task-space | 无 | `TaskRequest.taskSpacePath` 必填 | 一次 run 的产物按 run 隔离；节点间靠目录文件传上下文 |
| 3 | 会话日志 | 结果只带截断后的 `message` | 新增 `P-04`，gzip JSONL，按 `taskId+attempt`；允许 0 行 | 失败/崩溃时日志仍可追溯；结果体放不下全文 |
| 4 | 日志前置 | 无 | `P-02` 缺日志 → `409 session_log_missing` | 保证「节点完成」与「日志可用」一致 |
| 5 | 运行归档 | 无 | 新增 `P-05`，task-space 的 tar.gz；后台执行 | 运行结束后保留完整证据；与结果解耦 |
| 6 | 归档电平 | 无 | `P-01` 请求 `archivedRuns`、响应 `archiveRequests`（含 `workspacePath`） | 与 `stop`/`cancelInstances` 同一套电平语义 |
| 7 | 重传语义 | 无 | 同键**后到覆盖**，响应 `stored` | 客户端重试/重启可重新压缩，不要求持久化首次字节 |
| 8 | 承诺 | `C-01`–`C-09` | 新增 `C-10`–`C-12`；`C-08` 修订 | 明确 client 的新义务 |
| 9 | 常量 | 6 个 | 新增 4 个（日志/归档/解包校验） | 上传前预检与失败语义 |
| 10 | 结果错误码 | 2 个约定值 | 新增 `session_log_too_large`、`archive_too_large` | 日志/归档超限时的稳定分类 |

## 3 端点细节

### 3.1 `P-01` poll

- 请求新增可选 `archivedRuns: string[]`：已成功上传归档的 `runId`；服务端据此停止下发对应归档指令，未知 `runId` 忽略。client 在服务端不再下发该 `runId` 后移除本地记录（不设固定条数）。
- 响应新增 `archiveRequests: {runId, instanceId, workspacePath, taskSpacePath}[]`：缺省 `[]`；**电平信号**。
- **归档不改变挂起行为**：服务端不因待归档 run 缩短 `pollHoldMs`，只在某个 `runId` 首次进入待归档的那一跳立即返回一次。client 在**后台**打包上传，poll 照常进行，避免因归档耗时被判静默重派。

### 3.2 `P-02` result

- 前置：该 `taskId` 当前 `attempt` 的日志必须已通过 `P-04` 上传（**0 行空日志也算**）。
- 缺日志 → `409 session_log_missing`：任务不结算、不重派；client 补传（没有事件时传 0 行）后重试同一结果。
- 已结算任务的重复上报仍返回 `accepted=false`。
- 结果字段不变；verdict 由调度器解析，client 不改写。

### 3.3 `P-04` 会话日志

```http
POST /api/v1/executor/tasks/<taskId>/session-log?attempt=<n>
Content-Type: application/x-ndjson
Content-Encoding: gzip
Content-Length: <bytes>
```

- 内容：该次尝试的 ACP 事件流，一行一个 JSON 事件，gzip；**完整透传、不脱敏**，服务端只存不解析。
- 允许 0 行：session 建立前的失败（prompt 超限、workspace/asset/spawn、取消）也要传一份 0 行 gzip ndjson。
- 响应：`{taskId, attempt, bytes, sha256, stored}`；`bytes` 为压缩后大小；`stored` 为 `created` / `replaced` / `unchanged`。
- 幂等：同 `taskId+attempt` 重传一律 `200`，后到覆盖；可重新压缩，无需保存第一次的字节。
- 超限：压缩后 > 64 MiB → `413`。处理顺序：先传 0 行空日志 → 再报 `failed(session_log_too_large)`；任务正常失败结算，真实日志不保留（风险 `R-001`）。
- `404 task_not_found`：丢弃该次上传与结果，停止重试。
- 重派会产生新 `attempt`，各自一份日志。

### 3.4 `P-05` 运行归档

```http
POST /api/v1/executor/runs/<runId>/archive
Content-Type: application/gzip
Content-Length: <bytes>
```

- 内容：以 `archiveRequests[].taskSpacePath` 为根打的 tar.gz，条目相对根；用 `workspacePath` 校验根在工作区之下。
- 前置：run 已终态；否则 `409 invalid_state`。
- 响应：`{runId, bytes, sha256, stored}`；**后到覆盖**，可重新打包。
- 超限：压缩后 > 512 MiB → `413`；记 `archive_too_large`，停止重试，服务端 `archive_state=failed`。
- 服务端解包校验路径穿越、条目数与解压总量；client 只需保证标准 tar.gz、路径相对、不含绝对路径与 `..`。
- 归档在后台执行，不阻塞 poll；确认后本地 task 目录保留。

## 4 任务载荷与类型

```ts
type TaskRequest = {
  // ...v2 字段
  taskSpacePath: string;   // 必填；位于 workspacePath 之下；client 只建目录
};

type PollRequest  = { /* v2 */ archivedRuns?: string[] };
type PollResponse = { /* v2 */ archiveRequests: ArchiveRequest[] };
type ArchiveRequest = {
  runId: string;
  instanceId: string;
  workspacePath: string;
  taskSpacePath: string;
};
```

- 启动诉求不单独下发：编排侧写进首个执行节点的 `prompt`，并要求该节点把诉求落到 `<taskSpacePath>/intent.md`。client **不写 `intent.md`**。
- client 只创建 task-space 目录（`mkdir -p`）；所有节点读写限制在 task-space 与工作区内。

## 5 客户端承诺

| ID | 内容 |
|---|---|
| `C-08`（修订） | 结果只传控制信息；会话全文走 `P-04`，不进结果 |
| `C-10` | 校验 `taskSpacePath` 为绝对路径且在 `workspacePath` 之下；不存在则建目录；**只建目录、不写内容** |
| `C-11` | 节点结束先传 `P-04`，拿到 `200` 再报结果；每个 `attempt` 必须有日志，无事件传 0 行；失败按传输重试；同键可重新压缩 |
| `C-12` | 收到 `archiveRequests` 后**后台**打包上传 `P-05`，不阻塞 poll；下一次 poll 的 `archivedRuns` 确认；失败可重试；本地目录保留 |

## 6 常量

| 常量 | 值 | 用途 |
|---|---|---|
| `maxSessionLogBytes` | 67108864（64 MiB） | `P-04` 压缩后 |
| `maxArchiveBytes` | 536870912（512 MiB） | `P-05` 压缩后 |
| `maxArchiveEntries` | 100000 | 服务端解包校验 |
| `maxArchiveUncompressedBytes` | 2147483648（2 GiB） | 服务端解包校验 |

client 上传前只需预检 `maxArchiveBytes`（`maxArchiveEntries` / `maxArchiveUncompressedBytes` 是服务端解包校验）。

## 7 按组件的实现清单

> 按当前代码结构给出落点，实际以 client 仓库现状为准；只改与契约相关的部分。

| 组件 | 文件（当前结构） | 改动 |
|---|---|---|
| `CMP-gateway` | `src/components/gateway/wire.ts` | 协议常量改 3；`TaskRequest`/`PollRequest`/`PollResponse` 增字段；新增 `SessionLogAck`/`ArchiveAck` |
| `CMP-gateway` | `src/components/gateway/gateway.ts` | 新增 `uploadSessionLog`、`uploadArchive`；`poll` 发送 `archivedRuns`、解析 `archiveRequests`；处理 `409 session_log_missing`/`413` |
| `CMP-gateway` | `src/components/gateway/errors.ts` | 映射新增错误码与 `413` 上限 |
| `CMP-executor` | `src/components/executor/executor.ts` | 任务开始前校验并创建 task-space；节点结束先上传日志（含 0 行）再组装/上报结果 |
| `CMP-executor` | `src/components/executor/ports.ts` | `SchedulerPort` 增两个上传方法；日志上传结果纳入任务状态机 |
| `CMP-cli` | `src/components/cli/serve-loops.ts` | 后台归档任务、`archiveRequests`/`archivedRuns` 电平处理；不阻塞 poll |
| `CMP-store` | `src/components/store/` | 记录待归档/已归档 `runId` 与上传产物（可选，重启后可补传）；不改任务 journal 语义 |
| `CMP-workspace` | `src/components/workspace/` | 创建 task-space 目录、打包 task-space；写面与数据所有权按 client 影响规格修订 |
| `CMP-runtime` | `src/components/runtime/` | 原始 ACP 事件出口（`method`/`params`），供日志上传使用（client 评审 `B-05`） |
| `CMP-result` | `src/components/result/` | 新错误码映射与结果分类（client 评审 `B-05`） |

## 8 测试清单

至少覆盖（3 正 1 反）：

1. **task-space**：首任务目录存在；client 不写 `intent.md`；路径越界被拒。
2. **日志先于结果**：先传日志再报结果成功；缺日志报结果收到 `409`，补传后成功。
3. **空日志**：session 建立前失败（prompt 超限/workspace/asset/spawn/取消）能正常结算。
4. **重传覆盖**：同 `taskId+attempt` 重传不同字节仍 `200`，`stored` 正确；无需持久化首次字节。
5. **日志超限**：`413` 后传 0 行空日志再报 `failed(session_log_too_large)`，任务结算。
6. **归档**：后台按 `archiveRequests` 上传，poll 心跳不断；`archivedRuns` 确认；未终态 `409`；损坏包 `400`；超 512 MiB `413`；本地目录保留。
7. **协议闸门**：版本 `2` 与缺失均被拒绝；版本 `3` 通过。
8. **回归**：v2 的 `S-02` 重派、`S-08` 首份为准、`stop`/`cancelInstances` 不回归。

## 9 上线顺序与回滚

- 双端同批：client 与调度器一起切到协议 3；调度器先上会拒绝 v2 client，client 先上会拒绝 v2 调度器。联调在 `T-RUN-09` 一次性验证。
- 回滚：双方同时回到 v2 契约与实现；不保留双版本并行期。
- 升级迁移：丢弃 v2 遗留的未确认 `settled` 结果（`D-07`），不补报无日志结果。

## 10 待定

- 日志保留期与容量（调度器侧 `OQ-27`）。
- 归档读取端点（当前不提供）。
- fan-out 与 task.db（第二期，不在本交接）。
