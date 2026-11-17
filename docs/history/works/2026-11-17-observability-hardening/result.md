---
layer: works
module: global
status: frozen
updated: 2026-11-17
---

# 结果：观测面发布门禁加固

## 1 结论

- **recorder 与 HTTP 解耦**：`enabled=true` 时即使观测面 bind 失败，attempt/session 事件仍落盘；只有 `enabled=false` 才关闭记录。`X-Observability-Url` 只在 HTTP 启动成功时广告。
- **失败路径补测**：启动失败仍记录且不广告 URL、prune 后 raw/session 410、第 6 条 SSE 429、慢消费者 `slow_consumer` 结束。
- **大目录截断维持契约现状**：`limit+1` 扫描子集 + 子集排序 + `truncated`，不实现全量排序；理由与重开条件见 §3。
- **全量门禁**：`bun test` 176 pass / 0 fail，连续 3 次 + 串行 1 次；`signals` UC-14 未再复现。

## 2 验收对照

| brief 验收 | 结果 | 证据 |
|---|---|---|
| `enabled=true` + bind 失败仍记录、不发 URL | 通过 | `observer-setup.test.ts`「bind 失败…仍记录事件，但不广告 URL」；写 `attempts/<id>/meta.json` |
| `enabled=false` 不记录、不发 URL | 通过 | `observer-setup.test.ts`「enabled=false…」 |
| prune 后 raw/session 410 | 通过 | `server.test.ts`「prune 后 raw 与 session 返回 410」 |
| 第 6 条 SSE 429 | 通过 | `server.test.ts`「SSE 并发超过 maxStreams 返回 429」 |
| 慢消费者 `slow_consumer` | 通过 | `sse-writer.test.ts` |
| 全量测试 + signals 稳定 | 通过 | 176 pass ×3、串行 176 pass；`signals.test.ts` 单跑 5 次绿 |
| 大目录取舍有记录 | 通过 | §3 |
| 提交并推送 | 通过 | 见 §5 |

## 3 决策：大目录截断

**决定：维持现状（方案 A），不改实现。**

- 现状：`WorkspaceFileReader.list` 按目录枚举顺序收集 `limit+1` 条后排序并截断；超过上限时 `truncated=true`，保留哪 2000 条不确定。
- 契约已允许：`client-observability-v1` §11 明确“子集不保证全局排序（性能优先）”。
- 理由：O-09 是浏览辅助，不是目录索引；UI 已用 `truncated` 表达截断，可按更窄路径重查；全量收集 + 排序会在大目录上增加扫描/内存成本。
- 重开条件：UI 需要“确定性的前 N 条”或文件选择器；届时改为“收集全部 dirent → 排序 → 只 lstat 前 N+1”，并按 P2 修订契约。已写入 `CMP-observer` 规格 §3.2。

## 4 改动清单

| 文件 | 改动 |
|---|---|
| `src/components/cli/observer-setup.ts` | 新增 `record`/`advertiseUrl`；启动失败仍返回 recorder 与 record=true |
| `src/components/cli/serve-compose.ts` | observation 由 `setup.record` 决定；URL 由 `setup.advertiseUrl` 决定 |
| `tests/components/cli/observer-setup.test.ts` | 新增 3 例：关闭、bind 失败仍记录、启动成功广告 |
| `tests/components/observer/server.test.ts` | 新增 prune 410、maxStreams 429 |
| `tests/components/observer/sse-writer.test.ts` | 新增慢消费者 guard 用例 |
| `docs/design/components/CMP-observer/spec.md` | §3.2/§3.3 回填截断取舍与记录解耦 |
| `docs/works/2026-11-06-observability-http/result.md` | §13 交付版本与 v1.1 基线 |

## 5 验证与交付

- `bun run typecheck`：通过。
- `bun test`：**176 pass / 0 fail**（连续 3 次）；`bun test --max-concurrency=1`：176 pass / 0 fail。
- `signals.test.ts`：单独跑 5 次全绿。
- `bun run docs:check`：通过；`bun run quality:gate`：16 项全 PASS，违规 0。
- 交付：提交并推送 `main`；`client-observability-v1.1`（`58136f7`）保持为已验证基线，本次加固在其后，未移动 tag。

## 6 未决

- 若 orchestrator 需要包含本次加固的版本，另打 `v1.2` 或直接取 `main`；本次按用户要求保留 v1.1 作为对接基线。
- `signals` 用例仍是 10s 截止 + 200ms 存活检查，属时间敏感型；若 CI 高负载复发，再改成显式就绪信号。
