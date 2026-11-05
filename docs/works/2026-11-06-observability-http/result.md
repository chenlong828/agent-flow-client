---
layer: works
module: global
status: active
updated: 2026-11-06
---

# 结果：client 只读观测 HTTP（P1 设计稿）

## 1. 结论

- 新增只读端点面 `/api/v1/observability`；用户原写 `/observale` 为拼写错误，按 `observability` 修正。
- 观测面与控制面分离：调度器控制仍走心跳；观测面不参与 claim/cancel/租约/结果上报。
- 当前日志用 SSE；历史步骤通过 attempt 列表 + 分页日志查询；DSH session 同时提供规范化事件与原始 `session.v4.jsonl.zstd` 下载。
- session 清理前归档到 `<stateRoot>/observability/sessions/<sessionId>/`；归档失败不删实例 home。
- 推荐扩展 `CMP-observability`（方案 A），新增 `ObservationStore` / `EventHub` / `ObservationHttpServer`；`CMP-runtime` 只负责写 session 归档。
- v1 默认 `bind=0.0.0.0:17890`，可用 `serve --observability-bind/--observability-port` 覆盖；Bearer token 可选，为空时不鉴权并告警；TLS/mTLS/轮换后续特性。

## 2. 已定口径

| 项 | 结论 |
|---|---|
| 路径 | `/api/v1/observability` |
| 暴露 | 调度器/运维；v1 静态 base URL + 可选 token，不做自动发现 |
| 读写 | 只读 GET |
| 实时 | SSE，支持 `Last-Event-ID` |
| Session | 规范化事件 + 原始文件下载 |
| 保留 | 默认 7 天 / 1 GiB；清理前归档 |
| 组件 | 扩展 `CMP-observability`；`CMP-runtime` 写归档 |

## 3. 未决

1. ~~调度器与 client 同机/跨机；`bind` 默认值~~ 已定：默认 `0.0.0.0:17890`，CLI 可改；实际可达 IP/端口由部署配置。
2. 调度器如何拿到 base URL/token：静态配置，还是 `register` 上报 `observabilityUrl`？
3. 历史是否只查本 client，还是按实例跨 client 合并。
4. 原始 session 下载是否要二次授权/审计级别。
5. `doctor` 是否增加观测面自检。

## 4. 下一步

1. 双方确认 `proposal.md` 的端点/schema/安全口径。
2. 按 P1 四档评审；通过后回填 `architecture.md`、`CMP-observability`、`CMP-runtime`、`CMP-cli` 规格。
3. 再拆实现任务（HTTP server、归档、SSE、保留、测试）；本轮不动代码与 `design/`。

## 5. 交付物

- `brief.md`
- `proposal.md`
- `result.md`（本文件）
