# 联调 smoke 脚本

`mock-e2e.ts`：桩调度器 → `serve` → 真实 DSH → `mcp__agentflow__signal` → `P-02.signals`。

```bash
set -a; . ./.env; set +a
bun docs/works/2026-11-18-mcp-signal-impl/probe/mock-e2e.ts
```

- 需要 `DSH_BIN`、`AF_MODEL`、`HUNDSUN_PUBLIC_API_KEY`（DPH 侧凭据）已在环境里；脚本会把 `.env` 之外的 `DSH_HOME` 清掉，用临时 home。
- 输出：桩调度器收到的 `TaskResult`（含 `signals`）与 `serve-exit`；期望 `status=succeeded`、`signals[0].data.verdict=pass`、`serve-exit=0`。
- 2026-11-18 实测结果：`succeeded` + 一条 `review_verdict`，`signal.prepared`/`signal.collected` 各一条，`serve` 收到 `stop` 后退出 0。
