---
layer: works
module: global
status: frozen
updated: 2026-11-17
procedure: 2026-11-17-observability-hardening
level: P3
---

# 工序：观测面发布门禁加固（recorder 解耦 + 失败路径测试）

> 来源：2026-11-17 上游 `client-blocker-review` 后的复核。P1/P2 代码项已在 `58136f7` 修复；残余是失败路径缺少回归测试、观测面启动失败时事件不落盘、大目录截断取舍未定。
> 定级：**P3**（组合根局部行为 + 测试；无契约/schema/分层变更）。

## 1 问题

- 启动失败不发 URL、prune 后 410、慢消费者/429 都只有代码、没有回归用例。
- `serve-compose` 只在 observer 启动成功时装配 recorder；`enabled=true` 但端口冲突时事件完全不落盘，拉取模型下这次执行再也查不到。
- 大目录 `limit+1` 扫描后排序，保留子集不确定；契约已允许，需要明确取舍。
- `signals` 用例在上游复核时失败，当前不可复现；需在重复/串行负载下确认。

## 2 范围

| 做 | 不做 |
|---|---|
| recorder 与 HTTP 启动解耦；`enabled=false` 才关闭记录 | 改契约/schema |
| 补启动失败、prune 410、429、慢消费者用例 | 改 UI/调度器 |
| 记录大目录截断决策 | 实现全量排序 |
| 全量测试重复跑、提交、推送、交付交接 | 新 tag（v1.1 保持原义） |

## 3 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| T-01 | code | CMP-cli / CMP-observer | `record`/`advertiseUrl` 由启动结果决定；recorder 独立于 HTTP | 完成 |
| T-02 | test | CMP-observer | 启动失败不落 URL、仍落事件；prune 后 410；429；慢消费者 | 完成 |
| T-03 | decision | CMP-workspace / 契约 | 大目录截断维持契约现状，不实现全量排序 | 完成 |
| T-04 | delivery | global | 全量测试重复跑、commit、push、handoff v1.1 | 完成 |
| T-05 | docs | global | 规格、result、README 回填 | 完成 |

## 4 验收标准

1. `enabled=true` + bind 失败：recorder 仍写 attempt meta；不带 `X-Observability-Url`。
2. `enabled=false`：不记录、不带 URL。
3. prune 后 raw/session 返回 410 `observation_gone`。
4. 第 6 条 SSE 返回 429；慢消费者 guard 发 `slow_consumer` 并结束。
5. `bun test` 全绿；`signals` 在重复与串行跑中绿。
6. 大目录取舍有记录，无代码变更。
7. 提交并推送；交接写明 `client-observability-v1.1` 是已验证基线。
