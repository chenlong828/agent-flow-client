---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 结果：client 开发期自报身份（`X-Client-Id`）

> 输入：[`brief.md`](brief.md)（P2）、调度器侧 `client-proposal.md`、[`review.md`](review.md)。
> 结论：**client 已支持自报身份**——一行 `[scheduler] client_id` 启动即被调度器认出并登记，无需建 Harness 资产、`API-41` 或 token；有 token 时 Bearer 与身份头共存。`TC-CLT-ENR-1`～`4` 全绿。

## 1 完成项

| 任务 | 状态 | 落点 |
|---|---|---|
| `T-ENR-01` 配置 | 完成 | `src/components/cli/config.ts`、`src/components/cli/client-identity.ts`：`client_id`（`AF_CLIENT_ID` > 配置 > `hostname()`）、`allow_unauthenticated`、形状校验（与服务端同正则）、非 loopback 无 token 的放宽 |
| `T-ENR-02` 请求头 | 完成 | `src/components/gateway/transport.ts`：公共头层新增 `X-Client-Id` / `X-Client-Address`；`src/components/cli/serve-compose.ts` 注入 |
| `T-ENR-03` doctor | 完成 | `src/components/cli/doctor-checks.ts`：`scheduler.client_id`（取值+来源）、`scheduler.identity`（无 token 时 warn 开发期身份方式） |
| `T-ENR-04` 测试 | 完成 | `tests/components/cli/config.test.ts`、`tests/components/cli/commands.test.ts`、`tests/components/gateway/transport.test.ts`、`tests/scenarios/v3-serve.test.ts` |
| `T-ENR-05` 文档 | 完成 | 契约副本（§3 开发期旁路 + 401 行）、`CMP-cli`/`CMP-gateway` 规格、`architecture.md` 契约表、`test-matrix`、`SCN-0002`、README、`.env.example` |
| `T-ENR-06` 验收 | 完成 | `bun test` 127 通过、`bun run typecheck`、`docs:check`、质量门 0 违规 |

## 2 验收结果

| ID | 断言 | 证据 |
|---|---|---|
| `TC-CLT-ENR-1` | 有 `client_id`、无 token：配置通过、请求带身份且不被拒 | `config.test.ts`（三种来源）；`transport.test.ts`（无 token 五端点请求均非 401）；`v3-serve.test.ts`（真实 serve 跑完一次任务） |
| `TC-CLT-ENR-2` | 结果/日志/包/归档同样带 `X-Client-Id` | `transport.test.ts` 对五个端点请求头逐一断言 |
| `TC-CLT-ENR-3` | `client_id` 空/全空白/超长/含空白 → `config_invalid` 退出 2 | `config.test.ts` 表驱动四个变体 + env 变体 |
| `TC-CLT-ENR-4` | 有 token 时仍带 `Bearer`，与身份头共存 | `transport.test.ts`；既有 token 用例未变 |

补充：`allow_unauthenticated` 默认 `false` 仍拒绝非 loopback 无 token；置 `true` 后放行；非布尔值退出 2。`doctor` 报告 `dev-node-01（来源 env）` / `node-7（来源 config）`，无 token 时 `scheduler.identity` 为 `WARN`。

真实调度器（`127.0.0.1:3100`）实测：

- `curl` 无 token、只带 `x-client-id: chenlong-mac-01` → `200` 空批；
- 常驻 client 切到 `client_id = "chenlong-mac-01"`、去掉 token 后重启（监督进程第 2 次拉起，无 `poll.failed`）；
- Harness 列表新增并保持一行：`chenlong-mac-01`、`address=MacBookPro-M3Max.local`、`health=online`；再次请求后 `total=2` 不变（另一行是既有 `client-local-01`）。

## 3 配置用法

```toml
[scheduler]
url = "http://127.0.0.1:3100"
client_id = "chenlong-mac-01"     # 跨重启稳定；缺省取 hostname()
# token 可留空（开发期）；非 loopback 且无 token 时还需：
# allow_unauthenticated = true
```

`AF_CLIENT_ID` 优先于配置文件。`X-Client-Address` 取本机 `hostname()`，仅供服务端展示。

## 4 结论落点

| 内容 | 落点 |
|---|---|
| 配置键与校验、`doctor` 检查 | `docs/design/components/CMP-cli/spec.md` §2.3/§2.6 |
| 请求头与共存语义 | `docs/design/components/CMP-gateway/spec.md` §2/§3 |
| 契约增量（开发期身份旁路） | `docs/design/contracts/executor-http-v3.md` §3/§3.1 |
| 测试映射 | `docs/design/test-matrix.md` §2/§3 |
| 场景覆盖 | `docs/design/scenarios/.../configure-and-self-check/scenario.md` §5/§6 |
| 使用说明 | `README.md`「与调度器联调」、`.env.example` |

## 5 未决与后续

| 项 | 说明 |
|---|---|
| 真实调度器联调 | 已完成一次（见 §2）；后续跑任务类联调按同一配置继续 |
| 契约镜像残余差异 | `archiveRequests` 措辞与 `architecture.md` 的协议版本行（`H-01`/`H-02`），下次文档同步处理 |
| 生产收口 | `EXECUTOR_AUTH=on` 属调度器侧部署动作；client 默认不放开身份旁路（`H-04`） |
