---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 评审：client 开发期自报身份（P2）

> 对象：[`brief.md`](brief.md) 的改动与 `TC-CLT-ENR-1`～`4`；定级 P2，四档按 `arch-design-spec` 第 8 步裁剪（blocker / decision now / verified sound / hold）。
> 结论：**通过**（P2 合并前需用户最终确认）。

## 1 Blocker

无。改动为兼容扩展：不加配置时仍可启动（身份取 hostname），服务端 `EXECUTOR_AUTH=on` 时身份头被忽略，Bearer 路径与错误语义不变。

## 2 Decision now

| ID | 决定 | 选项与代价 | 已落 |
|---|---|---|---|
| `D-01` | client **总是**带 `X-Client-Id`（即使有 token） | 只在该头缺失时才需要区分模式；总是带避免「有 token 但泄漏/失效」时行为分叉，代价是多一个请求头 | `transport.ts`；`transport.test.ts` Bearer 共存用例 |
| `D-02` | `X-Client-Address` 取 `hostname()`，不做配置键 | 备选：`ip:port`（client 无常驻监听端口，值不真实）、省略（Harness 列表只剩 auto）；hostname 零配置且可读 | `client-identity.ts`（`clientAddress`）、`serve-compose.ts` |
| `D-03` | 用 `allow_unauthenticated` 作为回补开关，默认 `false` | 备选：直接删掉 token 校验（回补要改代码）、按 `EXECUTOR_AUTH` 推断（client 不该读服务端配置） | `config.ts`；`TC-CLT-ENR` 放开/拒绝用例 |

## 3 Verified sound

| 区域 | 证据 |
|---|---|
| `client_id` 优先级 env > config > hostname | `config.test.ts` `TC-CLT-ENR-1`（三种来源与空 env 回退） |
| 形状校验与服务端同正则 | `client-identity.ts` 的 `CLIENT_ID_PATTERN` 与调度器侧 `harness/service.ts` 一致；`TC-CLT-ENR-3` 覆盖空/全空白/含空格/超长 |
| 五个端点都带身份头 | `transport.test.ts` `TC-CLT-ENR-1/2` 逐一断言 poll/result/session-log/skill-packages/archive 请求头 |
| 有 token 时 Bearer 与身份头共存 | `transport.test.ts` `TC-CLT-ENR-4`；`v3-serve.test.ts` 既有 token 用例未变 |
| 无 token 端到端可跑完 | `v3-serve.test.ts` 新增自报身份用例：serve 完成一次任务，所有请求 `x-client-id=e2e-node-01`、无 `authorization` |
| `doctor` 展示取值/来源 | `commands.test.ts`：`scheduler.client_id` 报 env/config 来源，`scheduler.identity` 无 token 时 `WARN` |
| 不影响 `run` 路径 | `LocalScheduler` 不触网；`s0-config`/`s0-exec` 用例全绿 |
| 真实调度器按身份头放行 | `curl` 无 token + `x-client-id: chenlong-mac-01` → `200`；常驻 client 去掉 token 重启后 Harness `health=online`、`total` 不增 |
| 配置加载仍冻结、非法不回退 | 既有 `TC-CONFIG-004` 与新增 `client_id` 反例 |

## 4 Hold

| ID | 事项 | 为什么不阻塞 | 去向 |
|---|---|---|---|
| `H-01` | client 契约镜像里 `archiveRequests` 一段与调度器侧权威仍有一处措辞差异（「本地无 task-space 时忽略、不回报」） | 客户端行为已与调度器侧一致，纯文档同步，不涉及本次身份改动 | 下次契约同步或调度器侧工序收口时一并处理 |
| `H-02` | `architecture.md` §4.4 组件表仍写 `X-Executor-Protocol: 2`（v3 迁移遗留） | 与本次身份改动无关，改动会扩大 diff | 记入后续文档清理 |
| `H-04` | 生产收口（`EXECUTOR_AUTH=on` + 移除 `allow_unauthenticated`） | 属调度器侧部署动作，client 默认值已保持关闭 | 上线前 checklist |
