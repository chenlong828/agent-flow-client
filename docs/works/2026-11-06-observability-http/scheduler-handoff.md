---
layer: works
module: global
status: active
updated: 2026-11-17
---

# 调度器侧配合清单（client 观测面 v1）

> 用户决定：**不修改调度器代码**；需要配合的部分转交调度器一侧。本文件是交接清单，不包含调度器改动。
> client 已完成 O-01–O-11、文件端点、runId 接收、`X-Observability-Url` 发送、run 注册表与 raw 归档；见 `contract-v1.md` 与 `implementation-plan.md`。

## 1. client 已具备

- 观测面：`/api/v1/observability`，O-01–O-11（health/attempts/logs/SSE/session/events/raw/files/O-11 rich SSE）。
- 鉴权：Bearer；token 空时只允许 loopback。
- `TaskRequest.runId?`：wire 解析已支持；收到后写 `<stateRoot>/runs/<runId>.json`，O-09/O-10 用它定位 workspace/task-space。
- poll 请求头 `X-Observability-Url`：config enabled 时发送，值为 `advertise_url`。
- 本地联调：`/health`、attempts、O-04、O-06、O-08 raw 正常；O-09/O-10 因调度器未下发 `runId`，当前返回 `run_not_found`。

## 2. 调度器需要配合的点

### H-01 `TaskRequest.runId` 富化（阻塞 O-09/O-10）

- wire DTO `ExecutorTask` 增可选 `runId: string`。
- poll 组装时用 `run_node.task_id` 反查 `runId`；`run_node_task_id_key` 已有唯一索引。
- 建议落点：`src/executor-backend.ts` 的 `poll`；`src/components/run` 提供 `runIdForTask(taskId)`（`select run_id from run_node where task_id = $1`）。
- 无 run 归属的手工任务不发；client 会跳过 files。
- 不升 `X-Executor-Protocol`；旧 client 忽略。

### H-02 读取 `X-Observability-Url`（发现）

- poll 路由读取该头（≤2048），登记到内存 `ObservabilityDirectory`（按 clientId 存 URL + seenAt），不落库。
- 优先级：调度器静态配置 > 自报 URL；自报仅 loopback/开发期；生产用静态配置。
- 适配器校验：http(s)、无 userinfo/fragment、禁重定向、5s 超时、2 MiB 上限、防 SSRF。
- 旧 orchestrator 忽略未知头；旧 client 不发。

### H-03 client 观测适配器与产品文件 API（T9）

若要做“运行文件”页，调度器侧还需要：

- `CMP-client-observability` L0 适配器：`listFiles/readFile`，Bearer 复用 executor client token，5s 超时、2 MiB、错误映射。
- `ClientRunFiles` 端口；`CMP-run` 只调端口，不直接发 HTTP。
- 产品 API：`GET /api/v1/runs/{id}/files`、`/files/content`；DTO 映射 `path/hidden/previewable/contentType/language`。
- 错误：client 401 → 502；连接失败/超时 → 504；404/410/415 透传。

### H-04 可选

- 运行节点视图暴露 `sessionId`（结果里已有，`RunNodeView` 未用），UI 才能从 run 直接跳观测 session。
- 前端文件 Tab 调用 H-03 的产品 API；本清单不含 UI。

## 3. 联调步骤

1. client `serve` 启动 observer（默认 `127.0.0.1:17890`）。
2. 调度器 poll 下发带 `runId` 的任务。
3. 确认 client `<stateRoot>/runs/<runId>.json` 存在。
4. `GET /api/v1/observability/runs/{runId}/files?root=task-space&path=` 应返回列表。
5. 无 `runId` 时预期 `404 run_not_found`，任务本身不受影响。

## 4. 约束

- 只读、run-scoped 相对路径；不接受绝对路径；不写/不删/不下载。
- 非 loopback 必须 token；v1 复用 executor token，不新增秘密。
- 观测面失败不影响任务；`required=false` 降级。

## 5. 状态

| 项 | 状态 |
|---|---|
| client O-01–O-11/文件/runId 接收 | 完成 |
| H-01 runId 富化 | **待调度器侧** |
| H-02 URL 头登记 | **待调度器侧** |
| H-03 适配器/产品 API | **待调度器侧**；client 不阻塞 |
| 调度器代码改动 | 无（本次未修改） |
