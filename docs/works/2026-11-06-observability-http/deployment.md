---
layer: works
module: global
status: active
updated: 2026-11-17
---

# 观测面部署说明（client v1）

## 1. 最小配置

```toml
[observability]
retention_days = 7
max_bytes = 1073741824
max_attempt_event_bytes = 10485760

[observability.http]
enabled = true
required = false
bind = "127.0.0.1"
port = 17890
advertise_url = "http://127.0.0.1:17890/api/v1/observability"
token = ""                # 空：仅 loopback；非 loopback 必须配置
max_streams = 20
raw_enabled = true
rich_stream_enabled = true
```

## 2. 启动

```bash
./scripts/serve-dev.sh status
./scripts/serve-dev.sh reload
curl -s http://127.0.0.1:17890/api/v1/observability/health
```

- `serve` 启动 observer；`run` 不启动。
- `required=false`：bind/初始化失败记 `observability_disabled`，serve 继续。
- `required=true`：失败退出 4。
- 非 loopback + 无 token：配置层拒绝（`observability_insecure`）。

## 3. 网络/鉴权

- 默认 loopback；跨机必须显式 `bind` + token + 隧道/反代。
- token 非空要求 `Authorization: Bearer`；token 空仅 loopback。
- `advertise_url` 必须是调度器可达地址，不能填 `0.0.0.0`。
- v1 复用 executor client token；不新增独立观测 token。

## 4. 数据

- `observability/attempts/<attemptId>/`：meta/events。
- `observability/sessions/<sessionId>/`：meta/raw。
- `runs/<runId>.json`：run → workspace/task-space。
- 保留：7 天 / 1 GiB；每小时清理；启动时也执行一次。
- 清理后保留 tombstone，O-03/O-06 返回 410。

## 5. 限制

- 文件：2000 条/1 MiB（client 强制）；2 MiB/5s 是调度器适配器/BFF 限制。
- SSE：`maxStreams=20`；heartbeat 15s；`idleTimeout=30s`。
- O-11 富事件只在内存 ring（1000），历史看 O-07 preview + O-08 raw。

## 6. 已知

- `health.status` 在事件/归档连续失败 3 次后为 `degraded`，成功一次恢复。
- `Accept-Ranges: bytes` 已声明；v1 不实现 Range 切片，带 Range 请求按 200 全量返回。
