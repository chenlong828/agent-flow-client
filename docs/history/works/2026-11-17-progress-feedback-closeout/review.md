---
layer: works
module: global
status: frozen
updated: 2026-11-17
---

# 评审：执行过程可见性收口

## 1 定级与确认

- **级别：P2**。只改现行设计文档与决策记录，不动契约/schema/代码；跨文件但无运行时影响。
- **确认**：用户 2026-11-17 明确「5s 模式 C 暂不做」「UI 一侧主动查探和拉取」「经调度器产品 API/BFF」「本次只落文档」。结论落在 [`../../decisions/2026-11-17-execution-visibility-pull.md`](../../decisions/2026-11-17-execution-visibility-pull.md)。

## 2 四档裁决

**Blocker**：无。证据：无契约/代码变更；观测面 O-01–O-11 已实现，测试在 `tests/components/observer/`；调度器适配器与产品 API 已集成（上游 `2026-11-17-client-observability-integration`）。

**Decision now**：

1. 5s 模式 C 暂不实施，原 C1–C6 失效 —— 决策文档「决策 1」。
2. UI 经调度器产品 API/BFF 拉取，不直连 client —— 决策文档「决策 3」；现行架构 [`architecture.md`](../../../design/architecture.md) §3.3。
3. `lastEventAt` 暂不补，重开条件写入未决 —— 决策文档「决策 4」「未决 3」。

**Verified sound**：

- 观测面端点与契约一致：`O-01`–`O-11` 见 [`client-observability-v1.md`](../../../design/contracts/client-observability-v1.md)。
- 默认 loopback、非 loopback 强制 token：`src/components/cli/observability-config.ts`，与决策边界一致。
- 拉取/写入失败不影响执行：recorder 调用处统一 `catch`，observer 启停不进入执行路径（`serve-compose`、`observer-setup`）。
- UI 尚未接入：UI 仓库无 session/事件消费代码，与交接件一致（不阻塞本次收口）。

**Hold**：

- UI 会话 Tab / 文件 Tab / 节点摘要（外部项目）。
- 死代码 `SessionEvent`/`onEvent`/`snapshotRunning`，以及 `CMP-executor` 规格里 `onEvent` 的旧描述（另立 P3）。
- `OQ-022` 仍是 `0.0.0.0` 旧口径；观测面工序 `docs/works/2026-11-06-observability-http/` 待归档。
- 归档调研件保持 frozen 不改写；后续由 `README.md` 与决策文档指向。
- 调度器仓库尚无对应决策记录（跨仓库同步项）。

## 3 结论

**通过**。条件均属 Hold，不阻塞本次收口；无 Blocker，无未决的 Decision now。
