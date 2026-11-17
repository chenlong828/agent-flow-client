---
layer: works
module: global
status: active
updated: 2026-11-17
---

# 交给调度器一侧的契约变更

> client 侧已完成观测面 v1；按用户决定不修改调度器代码。本文件是调度器侧需要落地的契约 diff 与验收点。
> client 权威契约：[`../../design/contracts/client-observability-v1.md`](../../design/contracts/client-observability-v1.md)；配合清单：[`scheduler-handoff.md`](scheduler-handoff.md)。

## 1. 执行面 `executor-http-v3`（加法，不升版本）

### 1.1 `PollResponse.tasks[].runId?`

```diff
 type TaskRequest = {
   taskId: string;
   instanceId: string;
   nodeId: string;
   attempt: number;
+  /** 可选：run 归属；带此字段时 client 会注册 run→workspace/task-space，用于 O-09/O-10。 */
+  runId?: string;
   prompt: string;
   workspacePath: string;
   taskSpacePath: string;
   timeoutMs: number;
   skillSet: SkillSet;
 };
```

- 调度器在 poll 组装时用 `run_node.task_id` 反查 `runId`（唯一索引已有）。
- manual/无 run 归属任务可不发；client files 端点返回 `run_not_found`，任务不受影响。
- 旧 client 忽略；不升 `X-Executor-Protocol`。

### 1.2 poll 请求头 `X-Observability-Url`

```http
POST /api/v1/executor/poll
X-Observability-Url: http://127.0.0.1:17890/api/v1/observability
```

- client 在 `[observability.http].enabled=true` 且 `advertise_url` 非空时发送；≤2048；不放在 body。
- 调度器只登记 URL（内存 `ObservabilityDirectory`），不落库、不改变派发。
- 优先级：调度器静态配置 > 自报；自报仅 loopback/开发期；适配器做 SSRF 校验（http(s)、无 userinfo/fragment、禁重定向、5s、2 MiB）。
- 旧调度器忽略未知头；旧 client 不发。

### 1.3 client 承诺

- `C-13`：观测面启用时上报 `X-Observability-Url`；文件端点不可用时不影响任务。
- `C-14`：收到 `runId` 时持久化 run→两个路径；任务空间读写仍限制在 task-space/workspace。

## 2. `client-observability-v1`（client 已实现）

完整字段见 [`contracts/client-observability-v1.md`](../../design/contracts/client-observability-v1.md)。调度器/UI 需要的核心端点：

| ID | 路径 | 用途 |
|---|---|---|
| `O-01` | `GET /health` | 存活/版本/计数 |
| `O-02` | `GET /attempts` | attempt 列表 |
| `O-03` | `GET /attempts/{attemptId}` | attempt 详情 + session |
| `O-04` | `GET /attempts/{attemptId}/logs` | preview 日志 |
| `O-05` | `GET /attempts/{attemptId}/logs/stream` | preview SSE |
| `O-06` | `GET /sessions/{sessionId}` | session 元数据 |
| `O-07` | `GET /sessions/{sessionId}/events` | preview 事件 |
| `O-08` | `GET /sessions/{sessionId}/raw` | 原始 zstd |
| `O-09` | `GET /runs/{runId}/files` | 运行文件列表 |
| `O-10` | `GET /runs/{runId}/files/content` | 运行文件内容 |
| `O-11` | `GET /sessions/{sessionId}/events/stream` | 富 ACP 事件 SSE（运行中，内存） |

- 基础路径 `/api/v1/observability`；全部 GET；Bearer；`no-store`。
- **O-09/O-10 依赖 H-01 的 `TaskRequest.runId`**；没有 runId 时 client 返回 `404 run_not_found`。
- O-04/O-05/O-07 严格 preview；O-11 是富事件，仅运行中内存，历史看 O-07 + O-08。
- 采用 O-01–O-10 作为外部契约；O-11 是加法扩展，调度器可先不接。

## 3. 调度器侧实现清单

| ID | 改动 | 落点 | 验收 |
|---|---|---|---|
| H-01 | `ExecutorTask` wire 增 `runId?`；poll 富化 | `http-gateway/routes/executor-types.ts`、`executor-backend.ts`、`run` 提供 `runIdForTask` | poll 响应任务带 runId；client 注册表出现 `<stateRoot>/runs/<id>.json` |
| H-02 | poll 读 `X-Observability-Url`，登记目录 | poll 路由 + 内存 `ObservabilityDirectory` | 合法 URL 登记；非法/非 loopback 自报不登记；不影响 poll |
| H-03 | `CMP-client-observability` 适配器 + `ClientRunFiles` 端口 | 新 L0 + 端口 | listFiles/readFile 200/401/404/410/415/超时/超大 |
| H-03b | 产品 API `GET /runs/{id}/files`、`/files/content` | `http-gateway`/`run` | DTO 映射、path/root 校验、错误映射 |
| H-04 | run 节点视图暴露 `sessionId`（可选） | `run` view | UI 可从 run 跳 session |

## 4. 测试门槛

- 执行面：旧 client 无 runId/头仍正常；新 client 带 runId/头不改变派发。
- 发现：静态配置优先；自报 loopback 可用；SSRF 拒绝；URL 大小上限。
- 文件：正常/截断/二进制/目录/缺失/路径逃逸/符号链接/权限；client 401→502、超时→504。
- 观测：O-01–O-08 回归；O-11 snapshot/Last-Event-ID/慢消费者/end。
- 安全：非 loopback 无 token 拒绝；raw 开关；不记录文件内容。

## 5. 不在本次范围

- 不做 UI、不做文件下载/写入、不做 confirm 快照、不做 NAT 打洞。
- 不改 `CMP-scheduler` 任务表/派发；不改数据库。
- 不改 client 代码（client 侧已完成）。
