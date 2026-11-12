---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 契约 v3 client 侧实现与联调结果

> 输入：修订版契约（2026-11-12，与调度器侧权威一致）、`response.md`、`review.md` §10、`client-plan.md`。
> 结论：**client 已按 v3 实现，2026-11-12 11:45 后与协议 3 调度器联调通过**（两个 run、4 个节点；日志→结果→归档全链路）。
> 本机限制：DSH 的 bash 工具因 `sandbox-exec` 不可用而失败，模型改用文件工具落盘；**本机未执行命令级验证**（见 §3）。

## 1 完成项

| 任务 | 状态 | 落点 |
|---|---|---|
| `T-CV3-01` 文档同步 | 完成 | `docs/design/contracts/executor-http-v3.md`；v2 归档于 `docs/history/works/2026-11-12-contract-v3-handoff/executor-http-v2.md`；README/导航/architecture/roadmap/test-matrix/组件规格/brief 已更新 |
| `T-CV3-02a/b` gateway | 完成 | `transport.ts` 协议 3；`wire.ts` 新字段；`errors.ts` 新码；`gateway.ts` `uploadSessionLog`/`uploadArchive`、`archivedRuns`/`archiveRequests` |
| `T-CV3-03a` workspace | 完成 | `ensureTaskSpace`（绝对路径 + 工作区内 + 符号链接检查，只建目录）、`packTaskSpace`（tar.gz） |
| `T-CV3-03b` executor | 完成 | 时序：task-space → session → 技能 → prompt（原始 ACP 事件落盘）→ 结果；`413` 转空日志 + `failed(session_log_too_large)` |
| `T-CV3-04b` cli | 完成 | 报结果前先确保日志已上传（0 行也传）；归档后台执行、`archivedRuns` 回报、不阻塞 poll；`404` 丢弃；本地无 task-space 时跳过且不再重复尝试 |
| `T-CV3-07` runtime | 完成 | `PromptOptions.onRawEvent` 导出原始 `method`/`params` |
| `T-CV3-08` result | 完成 | `session_log_too_large` → `runtime` |
| `T-CV3-09` 测试桩 | 完成 | `stub-scheduler` 升 v3（P-04/P-05、`archiveRequests`、`archivedRuns`、409/413 注入）；`mock-scheduler --archive <runId>:<workspacePath>` |
| `T-CV3-05` 验收 | 完成 | `bun test` 119 通过、`typecheck`、`docs:check`、质量门 0 违规 |
| `T-CV3-06` 联调 | 完成（有环境限制） | 2026-11-12 11:45–12:03，协议 3 下两个 run 全链路通过 |

## 2 联调结果（2026-11-12）

| 项 | 证据 |
|---|---|
| 协议 3 握手 | 调度器重启（`EXECUTOR_PROTOCOL_VERSION = 3`）后，client 常驻 0 重启、harness `client-stub-01` 心跳 `online`；不再 400 |
| run `01a1cddc-1511-7490-9135-3973e93e9741` | n1/n2 均 `succeeded`；`state=done`、`outcome=succeeded`、`archiveState=stored`；task-space `/tmp/jd/ws-smoke/.agent-flow/task/01a1cddc-1511…/`，含 `intent.md`（start 专家写）与 `verification-result.md`（end 专家写） |
| run `01a1cdec-2dec-76bf-a1e8-f1b7b2c06566` | 两个节点 `succeeded`；归档 `1277 B` 上传成功 |
| 日志先于结果 | 调度器侧 `P-02` 前置要求日志；4 次 `task.reported` 前均有对应 `P-04` 上传（`session-logs` 已清空） |
| 归档落点 | orchaster `.local/archive/runs/<runId>/nodes/<nodeId>-<visit>-a<attempt>.jsonl.gz`；`.local/archive/history/<instanceId>/<runId>/task-space.tar.gz` + `logs/` 副本 |
| client 痕迹 | `journal.jsonl` 8 条（received/running/settled/reported ×2 per run）、`logs/client.jsonl` 含 `task.reported` 与 `archive.uploaded` |

## 3 环境限制（非契约问题）

n1 的会话日志显示：模型第一次调用 `bash` 时被 DSH 沙箱拒绝——

```
Error: sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host;
refusing to run the command unconfined. Runner failure: sandbox-exec: sandbox_apply: Operation not permitted
```

随后模型改用 `write`/`read` 文件工具完成 `intent.md` 落盘与校验。因此：

- **本机未执行命令级验证**（bash/脚本/工具调用路径未覆盖）；
- 文件类能力（task-space、intent、产物、日志、归档）已验证；
- 命令级验证需换到 `sandbox-exec` 可用的环境（或按 DSH 建议切 `danger-full-access`）后补测。

## 4 偏差与未做

| 项 | 说明 |
|---|---|
| `T-CV3-04a` 归档电平持久化 | **未做**。`archiveRequests` 是电平信号，重启后服务端会重发；`P-05` 后到覆盖，重传幂等，无需本地持久化 |
| 归档上传内存占用 | 打包后整包读入内存再上传（≤512 MiB）；流式上传列为后续优化 |
| 提交 | 已整理为 v3 实现提交（见仓库历史 `feat: 实现契约 v3`）；可联调版本以该提交为准 |

## 5 遗留问题（双方待办）

| 问题 | 现象 | 建议 |
|---|---|---|
| 无 task-space 的 run 归档如何收口 | `01a1cdc6…`、`01a1cdcc…` 在 task-space 产生前被取消，服务端 `archive_state` 留在 `pending` 并持续下发 `archiveRequests`；client 本地无对应目录，此前每 30s 刷一条 `archive.skipped` | **服务端**：run 从未产生 task-space 时直接置 `archive_state=none/failed`，不再下发；**契约**：若要客户端收口，需新增「跳过/专用 ack」语义（不能用 `archivedRuns` 冒充已归档，否则会把 `archive_state` 写成 `stored`）。client 已改为每进程只记一次、不再重复打包/上传 |
| 本机命令级验证缺口 | bash 工具被 `sandbox-exec` 拒绝（见 §3） | 换环境或调整 DSH 沙箱模式后补跑命令类节点 |

## 6 已接受风险（来自契约 §12）

1. 日志超限（>64 MiB）时真实日志不保留，任务以 `failed(session_log_too_large)` 结算。
2. 日志完整透传，可能含密钥/工具输出；服务端只存不解析。
3. 同键重传「后到覆盖」，理论上较晚的重传会替换较早内容（同一 client、同一 attempt/run）。
