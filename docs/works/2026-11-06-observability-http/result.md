---
layer: works
module: global
status: active
updated: 2026-11-17
---

# 结果：client 只读观测面（v2，Session 为中心）

## 1. 结论

- 2026-11-17 优先级调整：调度层已有 task/attempt/run 视图，观测面不再重复建 attempt 索引；v2 只做 **打开一个 session 看 ACP 执行反馈**。
- 端点改为 session 为中心：`S-01` health、`S-02` session 列表、`S-03` session 详情、`S-04` 事件分页、`S-05` 事件 SSE、`S-06` raw 下载；不再提供 `/attempts*`。
- 事件模型改为 `SessionEvent`：prompt、message、thought、tool_call、tool_result、usage、permission、lifecycle；`content_level=full` 默认保存文本与工具 I/O（有上限），`metadata` 只留轨迹。
- 存储：`<stateRoot>/observability/sessions/<sessionId>/{meta.json,events.jsonl,session.v4.jsonl.zstd}`；meta/events 由 `CMP-observability` 写，raw 由 `CMP-runtime` 写；HTTP 只读。
- 实时：SSE 按 session 推送，snapshot + `Last-Event-ID` + heartbeat + end；慢消费者/并发上限有明确降级。
- 安全：v2 内容面显著大于 v1，建议默认 `bind=127.0.0.1` + 可选 token；非 loopback 必须 token。这会推翻 v1 的 `0.0.0.0` 默认，待产品确认。
- 组件仍推荐扩展 `CMP-observability`（方案 A），预算 ≤60k / 120k；超限再拆 `CMP-observer`。
- v1 提案留档 [`proposal-v1.md`](proposal-v1.md)，v1 评审 `OB-01`–`OB-09` 只覆盖 v1；v2 需重新评审。

## 2. 已定口径（v2）

| 项 | 结论 |
|---|---|
| 路径 | `/api/v1/observability` |
| 主对象 | `sessionId`（不是 `attemptId`） |
| 端点 | `S-01`–`S-06`（health / sessions / session / events / stream / raw） |
| 列表 | `GET /sessions` 只做发现；不复制 attempt 状态机 |
| 事件 | `SessionEvent`；`full`/`metadata` 内容级别；单事件 16 KiB、单 session 64 MiB |
| 实时 | SSE；snapshot 200、heartbeat 15s、`Last-Event-ID`、慢消费者/并发上限 |
| 全文 | raw `session.v4.jsonl.zstd`；事件流只到上限，raw 保完整 |
| 保留 | 默认 7 天 / 1 GiB；清理前归档；tombstone 410 |
| 组件 | 扩展 `CMP-observability`；`CMP-runtime` 归一化 ACP + 写 raw 归档 |
| 安全默认 | 建议 loopback + 可选 token；非 loopback 必须 token；raw 可关；审计/`no-store` |
| 版本 | `observabilityVersion = "2026-11-17.1"`；v1 未实现，不设兼容别名 |

## 3. 与 v1 的差异

| 项 | v1 | v2 |
|---|---|---|
| 主对象 | attempt 索引 + 日志 | **session 内容** |
| 主键 | `attemptId` | `sessionId` |
| 列表 | `GET /attempts` | `GET /sessions`（发现） |
| 事件 | `ObservationEvent`；`kind=acp` 只是预览；不写 prompt/推理/tool I/O | `SessionEvent`；full 模式写 prompt/文本/工具 I/O |
| 实时 | attempt 日志 SSE | session 事件 SSE |
| attempt 状态机 | phase/log 存储 | 不存；交给调度层 |
| 安全默认 | `0.0.0.0` + 可选 token | 建议 `127.0.0.1` + token（待确认） |

## 4. v1 评审处置（仅覆盖 v1）

| ID | 结论 | v2 影响 |
|---|---|---|
| `OB-01` | 接受 `0.0.0.0` + 可选 token 风险 | v2 内容更敏感，**需重新决策**；建议 loopback |
| `OB-02` | 内存队列 + 批量落盘，执行路径不 fsync | 继续沿用 |
| `OB-03` | 信任面反转说明 | 继续适用，且更强 |
| `OB-04` | 预算 ≤60k / 120k，超限拆 B | 继续沿用 |
| `OB-05` | 归档文件契约（layoutVersion/原子写/sha256） | 继续沿用 |
| `OB-06` | `observabilityVersion` + `clientVersion` | 继续沿用，版本号更新 |
| `OB-07` | 单用户/受控容器前提 | 继续适用 |
| `OB-08` | tombstone，404/410 区分 | 继续沿用 |
| `OB-09` | `maxStreams` 按 client 全局 | 继续沿用 |

## 5. 未决

| # | 问题 | 建议 |
|---|---|---|
| Q1 | `content_level` 默认 full/metadata | full（目的所在）；非 loopback 强制 token |
| Q2 | thought 是否默认进事件流 | 进 full；可加开关 |
| Q3 | prompt 是否进事件流 | 进（截断 16 KiB）；完整在 raw |
| Q4 | 默认 bind 是否改 loopback | 建议改；需产品确认（推翻 v1 OB-01） |
| Q5 | raw_enabled 默认 | true（loopback/token 前提） |
| Q6 | 是否保留 session 列表 | 保留作为发现兜底；UI 可优先用调度层 sessionId |
| Q7 | taskId/attempt 关联字段是否保留 | 可选保留用于对齐；不做索引 |
| Q8 | 保留/上限 | 7 天 / 1 GiB / 单 session 64 MiB |

## 6. 下一步

1. 对 v2 提案做 P1 评审（端点/schema/内容级别/安全默认），重新走人工确认门。
2. 评审通过后回填 `architecture.md`、`CMP-observability`、`CMP-runtime`、`CMP-cli` 规格。
3. 再拆实现任务（HTTP server、SessionEvent 归一化、SSE、存储/保留、归档、测试）。
4. 调度侧配合：在 run 节点视图暴露 `sessionId`（结果里已有，视图未用），否则只能靠 `GET /sessions` 发现。

## 7. 交付物

- `proposal.md`：v2 session-centric 提案。
- `proposal-v1.md`：v1 attempt-centric 提案（留档）。
- `result.md`（本文件）。
- `review.md`：v1 评审记录（v2 需重新评审）。

## 8. 补充：任务级运行文件拉取（2026-11-17）

按上游 [`2026-11-17-client-observability`](../../../../agent-flow-orchaster/docs/works/2026-11-17-client-observability/proposal.md) 补充：

- 新增 `O-09` `GET /runs/{runId}/files` 与 `O-10` `GET /runs/{runId}/files/content`；run-scoped 相对路径，只读，不做下载/写入。
- 执行面加法：`TaskRequest.runId?` + poll 头 `X-Observability-Url`；不升协议、不新增执行面端点。
- client 新增 `<stateRoot>/runs/<runId>.json` 注册表（`CMP-store` 写），`CMP-executor` 在任务接收/归档时 upsert；`TaskRecord` 增可选 runId/路径。
- 组件从 v2 初稿的 A 改为 **B：新增 `CMP-observer` L0**；`CMP-observability` 保留事件存储/日志，`CMP-workspace` 提供只读文件读取。
- 安全/启动：默认 `bind=127.0.0.1`；非 loopback 必须 token；`required=false` 降级；复用 executor token；自报 URL 仅 loopback/受控。
- 与上游的差异：上游仍列 `O-02`–`O-05` attempt 端点，本 v2 不实现（调度层已有）；session 面编号 `S-*`，文件端点沿用 `O-09/O-10`；需在交接件中对齐。

## 9. 契约冻结与实施准备（2026-11-17）

- 冲突已收敛：恢复 `O-02`–`O-05`/`attemptId`；`O-04/O-05/O-07` 严格 preview；`O-05` 扩展 + 新增 `O-11` session 富 SSE。
- 冻结稿：[`contract-v1.md`](contract-v1.md)（O-01–O-11、`SessionRichEvent`、runId/文件、配置/错误/存储）。
- 实施计划：[`implementation-plan.md`](implementation-plan.md)（T1–T9）。
- 下一步：T1 契约类型/配置 + T3 run 注册表先落，随后 T2 attempt 存储。
- 已开始并完成 T1–T6 的首轮实现：attempt store、run 注册表、ACP mapper/rich hub、recorder+executor hook、observer HTTP（O-01–O-11）、workspace 文件读取；`bun test` 162 pass、`typecheck` 通过。
- T7 已完成：`[observability]` 配置、`serve-compose` 启停、`X-Observability-Url`、permission 回调、run 注册表、raw 归档。
- 本地联调：`/health` 200；attempts/O-04/O-06/raw 正常；O-11 snapshot/end 正常；因上游尚未下发 `runId`，O-09/O-10 实际请求暂为 `run_not_found`。
- 剩余：T8 规格回填、上游 runId 富化、O-11 富历史按决策不落盘。

## 10. T9 移交（2026-11-17）

按用户决定“不修改调度器代码”，T9 不实施，改为交接：见 [`scheduler-handoff.md`](scheduler-handoff.md)。

- 调度器侧需要：`TaskRequest.runId` 富化、`X-Observability-Url` 登记、`CMP-client-observability` 适配器与产品文件 API。
- client 侧已具备：O-01–O-11、runId 接收/注册表、URL 头发送、O-09/O-10；只等上游下发 `runId`。
- 未修改调度器仓库任何文件。

## 11. T8 文档回填（2026-11-17）

- 现行契约：[`docs/design/contracts/client-observability-v1.md`](../../design/contracts/client-observability-v1.md)。
- 新组件规格：[`docs/design/components/CMP-observer/spec.md`](../../design/components/CMP-observer/spec.md)。
- 已回填：`architecture.md`（组件表/端口/§12）、`CMP-observability`、`CMP-runtime`、`CMP-cli`、`CMP-workspace`、`CMP-store`。
- 调度器侧契约 diff：[`scheduler-contract-diff.md`](scheduler-contract-diff.md)；配合清单 [`scheduler-handoff.md`](scheduler-handoff.md)。
- T8 完成；T9 移交调度器侧，未改调度器代码。

## 12. 验证反馈修复（2026-11-17）

对应 orchestrator `2026-11-17-client-observability-verification/client-fix-list.md`：

- 处置记录：[`client-fix-response.md`](client-fix-response.md)。
- P0 全部处理：SSE abort、保留/上限、run 404/410、SSE idle timeout。
- P1 已处理：Last-Event-ID、truncatedBefore、慢消费者、Accept-Ranges、session meta、health uptime/count、logRange.firstSeq、文件限制归属。
- 剩余：health `degraded`、大目录提前停止、Range 切片（P2/可选）。
- `bun test` 169 pass；`typecheck`/`docs:check` 通过；本地 serve 已 reload。

## 13. 发布门禁与交付版本（2026-11-17）

- `client-observability-v1` = `03336de`（观测面首版）；`client-observability-v1.1` = `58136f7`（含阻塞复核的 P1/P2 修复）。**orchestrator 复跑钉 v1.1**。
- 后续加固在主分支：观测面启动失败仍落事件（recorder 与 HTTP 解耦）、失败路径测试（410/429/慢消费者）；v1.1 不含这部分，若要用加固版另取主分支或新 tag。
- `signals.test.ts` UC-14 本机 5 次单跑、全量 3 次与串行 1 次均 `176 pass / 0 fail`；上游复核的 `ENOENT child.pid` 未在本机复现。
- 环境差异根因（2026-11-17 复核）：测试把 `.config` 写到临时 runDir，但启动命令没传 `--config`，`resolveRunDir` 落到 client 仓库根，临时配置被忽略；只读 checkout 下默认 `state.root`/`dsh_home` 不可写，CLI 在 prompt 前失败，10s 后读 `child.pid` 报 `ENOENT`。已修：显式 `--config`/`--state-root` + 超时诊断；只读副本复验通过。
- 加固记录：[`2026-11-17-observability-hardening/result.md`](../../history/works/2026-11-17-observability-hardening/result.md)。
