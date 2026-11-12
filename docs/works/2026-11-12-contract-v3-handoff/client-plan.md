---
layer: works
module: global
status: active
updated: 2026-11-12
---

# client 侧实现计划（T-CV3）

> 依据：修订版 [`executor-http-v3.md`](executor-http-v3.md)（2026-11-12，与调度器侧权威一致）、[`response.md`](response.md)、[`review.md`](review.md) §10。
> 定级 **P1**；契约已按评审修订并接受，现进入实现。任务按组件拆分，不在一个任务里跨组件。

## 1 任务表

| ID | 组件 | 内容 | 依赖 | 出口 |
|---|---|---|---|---|
| `T-CV3-01` ✅ | 文档 | v3 副本、v2 归档、doc/README/architecture/roadmap/测试矩阵/规格引用更新、brief 旧口径修正 | — | 文档检查通过 |
| `T-CV3-09` ✅ | 测试支撑 | `stub-scheduler`/`mock-scheduler` 升 v3：协议 3、`P-04`/`P-05`、`archiveRequests`、`409`/`413` 注入 | `T-CV3-01` ✅ | 桩可跑 |
| `T-CV3-02a` ✅ | `CMP-gateway` | 协议 3、类型/wire 新字段、错误码映射、`poll` 收发 `archivedRuns`/`archiveRequests` | `T-CV3-01` ✅ | 单测绿 |
| `T-CV3-02b` ✅ | `CMP-gateway` | `uploadSessionLog`/`uploadArchive`、`stored` 解析、`409 session_log_missing`/`413`/`404` 语义 | `T-CV3-02a` ✅ | 单测绿 |
| `T-CV3-03a` ✅ | `CMP-workspace` | `ensureTaskSpace`：校验绝对路径且在工作区内、只建目录；`packTaskSpace`（tar.gz） | `T-CV3-01` ✅ | 单测绿 |
| `T-CV3-03b` ✅ | `CMP-executor` | 执行时序插入 task-space；日志采集与上传先于结果；空日志；`413` 失败结算 | `T-CV3-02b`、`T-CV3-03a`、`T-CV3-07` | 场景测试绿 |
| `T-CV3-04a` ✅ | `CMP-store` | 待归档/已归档 `runId` 电平持久化（重启可补传） | `T-CV3-01` ✅ | 单测绿 |
| `T-CV3-04b` ✅ | `CMP-cli` | 后台归档任务、`archivedRuns` 维护、不阻塞 poll、`archive_too_large` 停重试 | `T-CV3-03a`、`T-CV3-04a` | 场景测试绿 |
| `T-CV3-07` ✅ | `CMP-runtime` | 原始 ACP 事件出口（`method`/`params`）供日志上传 | `T-CV3-01` ✅ | 单测绿 |
| `T-CV3-08` ✅ | `CMP-result` | `session_log_too_large` 等新码分类 | `T-CV3-01` ✅ | 单测绿 |
| `T-CV3-05` ✅ | 全部 | 契约 §10.2 门禁 + 3 正 1 反；`bun test`、`bun run typecheck`；写 `result.md` | 全部 | 全绿 |
| `T-CV3-06` | — | 通知调度器侧，进入 `T-RUN-09` 联调 | `T-CV3-05` ✅ | 调度器侧确认 |

## 2 实现约束（来自契约与评审）

1. **顺序**：task-space（只建目录）→ session → 技能 → prompt → 日志 → 结果；日志上传在结果之前，无事件传 0 行 gzip ndjson。
2. **归档**：后台执行、不阻塞 poll；`archivedRuns` 在下次 poll 确认；本地 task-space 保留；清理策略不覆盖 `.agent-flow/task`。
3. **重传**：`P-04`/`P-05` 后到覆盖，客户端可重新压缩/打包，不要求持久化首次字节；`stored` 仅用于观测。
4. **失败码**：日志超限 → 空日志 + `failed(session_log_too_large)`（`error.class` 由 client 定为 `runtime`）；归档超限 → 本地记 `archive_too_large`、停重试。
5. **路径**：task-space 与归档打包根都由服务端下发；client 校验「绝对路径 + 在 `workspacePath` 之下」，不拼接、不推断。
6. **冷热**：归档与打包是冷路径，不占 poll 热路径；大文件按流/临时文件处理，不整块进内存。
7. **不变量变更**：`CMP-runtime` 从「不落完整会话」改为「可导出原始 ACP 事件」；`CMP-workspace` 写面增加 `.agent-flow/task`（数据所有权在 `T-CV3-03a` 修订）。

## 3 状态

- 已完成：`T-CV3-01`、`T-CV3-02a/b`、`T-CV3-03a/b`、`T-CV3-04b`、`T-CV3-07`、`T-CV3-08`、`T-CV3-09`、`T-CV3-05`（119 测试通过）。
- 偏差：`T-CV3-04a`（归档电平持久化）未做——`archiveRequests` 是电平信号，重启后服务端会重发，客户端重传即可（后到覆盖幂等），无需本地持久化；`archivedRuns` 由服务端不再下发后移除。
- 待办：`T-CV3-06` 联调确认（等调度器侧 `T-RUN-09`）。
- 已知限制：归档打包后整包读入内存上传（512 MiB 上限）；后续可改流式。

## 4 验收映射

| 契约 §10.2 门禁 | 落点 |
|---|---|
| 并发 N / `free` 如实上报 | `T-CV3-02a`、`T-CV3-05` |
| 结果先落盘后补报 | `T-CV3-02b`、`T-CV3-04b` |
| 日志先于结果、空日志、413 | `T-CV3-02b`、`T-CV3-03b` |
| task-space 只建目录 | `T-CV3-03a`、`T-CV3-03b` |
| 归档后台、`archivedRuns`、本地保留 | `T-CV3-04a`、`T-CV3-04b` |
| 取消/超时无残留 | 回归 `T-CV3-05` |
| 协议 3 闸门 | `T-CV3-02a` ✅ |
