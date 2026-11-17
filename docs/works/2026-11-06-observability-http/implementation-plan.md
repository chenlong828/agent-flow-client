---
layer: works
module: global
status: active
updated: 2026-11-17
---

# client-observability-v1 实施计划

> 契约：[`contract-v1.md`](contract-v1.md)（2026-11-17 冻结）。
> 决策：恢复 `O-02`–`O-05`/`attemptId`；`O-04/O-05/O-07` 严格 preview；`O-05` 扩展 + `O-11` session 富 SSE。
> 定级：P1；用户已确认合并方向，契约冻结后开始编码。

## 1. 实施顺序

| 阶段 | 任务 | 组件 | 产出 | 依赖 |
|---|---|---|---|---|
| A | T1 契约类型与配置 | `CMP-observer` / `CMP-cli` | `observer/types.ts`、config schema、错误码 | 合同冻结 |
| A | T2 attempt 观测存储 | `CMP-observability` | attempt meta/events 写入、seq、保留 | T1 |
| A | T3 run 注册表 | `CMP-store` | `<stateRoot>/runs/<runId>.json`、upsert/重建 | T1 |
| B | T4 runtime 归一化 | `CMP-runtime` | attempt/session 关联、preview 事件、rich 事件回调、raw 归档 | T2/T3 |
| B | T5 observer HTTP | `CMP-observer` | O-01–O-11 路由、鉴权、SSE、错误 | T1/T2/T3 |
| B | T6 文件读取 | `CMP-workspace`/`CMP-observer` | 只读 `listDir`/`readText`、O-09/O-10 | T3/T5 |
| C | T7 CLI 组合根 | `CMP-cli` | 启停、配置、`X-Observability-Url`、required 降级 | T4–T6 |
| C | T8 测试与文档 | 完成 | 契约测试、SSE/文件/注册表/鉴权；规格回填 | T4–T7 |
| D | T9 orchestrator 适配器 | **调度器侧** | `CMP-client-observability`、产品 API | 移交（用户决定不改调度器代码） |

## 2. 第一批实现（建议）

**T1 + T3**：先落契约类型、配置骨架、run 注册表与测试。理由：

- 不依赖完整 event store/HTTP，风险低；
- `runId` 注册表是 `O-09`/`O-10` 的前置，也是执行面加法；
- 可以先跑 `bun test`/`typecheck`，验证目录与接口风格。

**T2**：紧接着 attempt meta/events 存储（preview），为 `O-02`–`O-05` 提供数据。

**T4/T5**：runtime 回调 + observer HTTP；先 `O-01`/`O-02`/`O-04`，再 SSE/文件/O-11。

## 3. 任务验收

| 任务 | 验收 |
|---|---|
| T1 | 类型/配置可编译；未知配置键忽略；枚举/上限有单测 |
| T2 | attempt 创建/事件 seq/保留/重启重建；O-02/O-03/O-04 数据形状 |
| T3 | run upsert/原子写/journal 重建/保留 410/未知 404 |
| T4 | attemptId/sessionId/runId 关联；preview 事件不含富文本；raw 归档 |
| T5 | O-01–O-11 正常/错误/鉴权/SSE/慢消费者；不阻塞 poll |
| T6 | 路径逃逸/符号链接/二进制/截断/2000 条/权限 |
| T7 | bind/port/token/required 降级；URL 头；启动失败不杀 serve |
| T8 | 契约测试 + `bun test` + `typecheck` + docs:check |

## 4. 风险与约束

- **O-11 富事件不落盘**：只保留内存 ring（1000），结束后历史只能 `O-07` preview + `O-08` raw；这是 Q2/Q3 决策的结果。
- **attemptId 与调度层映射**：client 生成 UUIDv7；`taskId + attemptNo` 仍是执行面键；O-02 同时返回两者，避免两套真相。
- **工作树已有未提交改动**（superproject workspace）；动手前先确认 diff 归属，不混入无关改动。
- **调度层配合**：`TaskRequest.runId`、`X-Observability-Url`、run 节点暴露 `sessionId`；client 先做兼容，缺字段时降级。
- **安全默认**：loopback + 非 loopback 强制 token；`O-11`/raw/files 写审计；不做 TLS。
- **性能**：文件读/SSE 不阻塞 poll；事件写盘批量；内存 ring/队列有界。

## 5. 完成定义

- 契约 O-01–O-11 全部实现并通过契约测试；
- `bun test`、`bun run typecheck`、`bun run docs:check` 通过；
- 规格回填 `architecture.md`、`CMP-observability`、`CMP-runtime`、`CMP-cli`、`CMP-workspace`、`CMP-store`，新增 `CMP-observer`；
- 上游适配器另立工序，不混入 client commit。

## 6. 进度

| 日期 | 任务 | 状态 | 证据 |
|---|---|---|---|
| 2026-11-17 | 契约/对齐 | 完成 | `contract-v1.md`、`alignment-blockers.md`、用户确认 Q1–Q3 |
| 2026-11-17 | T3 run 注册表 | 完成 | `src/components/store/runs.ts`、`tests/components/store/runs.test.ts`（4 pass） |
| 2026-11-17 | T9 | **移交调度器侧** | `scheduler-handoff.md` |

## 7. 进度更新（2026-11-17，T1–T6）

| 任务 | 状态 | 证据 |
|---|---|---|
| T1 契约类型 | 完成（配置解析留 T7） | `src/components/observer/types.ts` |
| T2 attempt 存储 | 完成 | `src/components/observer/attempt-store.ts` + 测试 |
| T3 run 注册表 | 完成 | `src/components/store/runs.ts` + 测试 |
| T4 runtime 归一化 | 完成（permission 回调未接，见下） | `recorder.ts`、`mapper.ts`、`archive.ts`、executor hook |
| T5 observer HTTP | 完成（O-01–O-11） | `server.ts` + 测试 |
| T6 文件读取 | 完成 | `workspace/files.ts` + 测试 |
| T7 CLI 组合根 | 待做 | 配置/启停/URL 头/worker 接线 |
| T8 测试/文档回填 | 部分 | 新代码 20 个测试；规格未回填 |
| T9 orchestrator 适配器 | **移交调度器侧** | `scheduler-handoff.md` |

已知缺口（T7 前不阻塞单测）：

- `permission` 富事件：`ObservationRecorder.permission` 已实现，但 runtime 的 `session/request_permission` 回调尚未接到 recorder；O-11 暂时收不到权限事件。
- `O-01.registeredRuns` 固定 0；`RunRegistryPort` 尚未提供计数。
- `O-08` 依赖 runtime 关闭后归档；测试用 fake archive，真实 DSH session 文件路径未做集成验证。
- CLI 未启动 observer；当前只能通过 `createObserverHandler`/`startObserverServer` 单测。

测试：`bun test` 162 pass、`bun run typecheck` 通过。

## 8. 进度更新（2026-11-17，T7）

| 任务 | 状态 | 证据 |
|---|---|---|
| T7 CLI 组合根 | 完成 | `config.ts` 增 `[observability]`；`serve-compose` 启动/停止 observer；`X-Observability-Url`；permission 回调；run 注册表接线 |
| 本地联调 | 部分通过 | `serve-dev.sh reload` 后 `/health` 200；attempt 列表/O-04/O-06/raw 正常；O-11 snapshot/end 正常 |
| T8 文档/规格 | 完成 | `docs/design/contracts/client-observability-v1.md`、`CMP-observer/spec.md`、architecture/5 份组件规格回填 |

剩余已知缺口：

- **runId 未从上游下发**：本地联调 attempt 的 `runId` 为空，`O-09/O-10` 实际请求返回 `run_not_found`；client 已支持 `TaskRequest.runId`，待上游 executor-backend 富化。
- **O-11 富历史**：按决策只保留内存 ring，reload 后 snapshot 为空；历史看 O-07 preview + O-08 raw。
- **permission**：runtime 回调已接，但本地 run 权限请求是否产生取决于权限策略；未做专门联调。
- **O-01 `registeredRuns`** 已有 count；但本地无 runId，注册表为空。
- **组件规格/架构回填**未做，属于 T8/收口。
