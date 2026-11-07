---
layer: plan
module: global
status: current
updated: 2026-11-07
---

# 开放问题

| ID | 问题 | 影响 | 下一步 |
|---|---|---|---|
| OQ-001 | DSH 在 prompt 时还是 session 创建时读取技能？ | 决定主流程顺序 | **已关闭**（2026-11-03 实测：每次 `session/prompt` 重新读取工作区技能）；S0-03 复验：建 session 后立即写技能 3/3 可见，同 session 替换后 catalog 与加载内容同步更新；主流程仍用「先写后建」优先，S0 保留回归用例 |
| OQ-002 | DSH 工作区技能目录的准确约定？ | 技能是否被识别 | **已关闭**（2026-11-03 S0 实测）：根为 `<projectRoot>/.dsh/skills`（rank 100）与 `<projectRoot>/.agents/skills`（200），`projectRoot` = 最近含 `.git` 的祖先（`.git` 文件也算），否则 cwd；只认顶层 `<name>/SKILL.md` 或 `<name>.md`，嵌套与缺 `description` 跳过；同名按 rank 取 `.dsh`。隔离方案按产品要求定为「只屏蔽全局根、保留项目根」：三个全局根指到空目录，`includeDefaultRoots` 保持 true（见 `docs/design/architecture.md` §8） |
| OQ-003 | DSH 二进制如何供给与升级？ | 安装与版本一致性 | 预研：源码 checkout 可直接启动，但当时 `lib/` 落后 HEAD（7 个插件跳过）；S0 验证前已重建（install + build:lib）。生产仍应固定发行版而非 checkout；S0 定安装方式与版本 pin |
| OQ-004 | client 凭据如何发放与保存？ | 安全与接入成本 | 预研：ACP 读 `$DSH_HOME/.credentials.yaml`，也认 `DEEPSEEK_API_KEY` 启动环境变量。倾向一实例一 home + env 注入，不落盘 |
| OQ-005 | 工作区/日志保留多久？ | 磁盘与排障 | S1 前定默认 |
| OQ-006 | 结果大小上限？ | 传输与解析 | 接口设计阶段定 |
| OQ-007 | 目标平台范围？ | 脚本/路径/进程实现 | 先 macOS/Linux |
| OQ-008 | client 与 DSH 的版本兼容窗口？ | 升级策略 | 实测 ACP v1、dsh 0.2.2-alpha.2；兼容窗口待 S1 契约冻结时定 |
| OQ-009 | DSH_HOME 隔离粒度：一实例一 home 还是一 client 一 home？ | 会话可见性、凭据与磁盘占用 | 预研建议一实例一 home；S0-11 补充：崩溃后 lock 残留、`session/list` 会列出崩溃会话、孤儿进程需清理，隔离粒度需一并考虑回收策略；2026-11-03 会话记录调研：session 按 `DSH_HOME` 归属、profile 目录不含 session，共用 home 时 web/desktop `session/list` 实测返回 ACP 会话（首次初始化还会被 workspace bootstrap 采纳），ACP 反向也能列出 desktop 会话；因此必须一实例一 home，client 只展示/恢复本实例记录的 id（详见 `docs/works/2026-11-03-acp-session-records/result.md`） |
| OQ-010 | 租约 TTL 与心跳长轮询超时？ | 离线判定与取消延迟 | 心跳间隔已定 30s（2026-11-03）；TTL 必须大于 30s。提案拆成客户端租约（90s）与尝试租约（120s），见 `docs/history/works/2026-11-04-scheduler-contract-proposal/proposal.md` §2.3/§15（Q8）；M1 定最终值。 |
| OQ-011 | 容量单位：实例数还是 session 数？ | `serve` 循环与领取 | M1 定；提案 §11 给 A/B/C 三候选，S1 推荐「实例数 + 同实例串行」（Q1），并由 `SCH-19` 钉死同实例单活跃 attempt（等价 Q1 选 A；选 B 须改 `SCH-19` 并升 `protocolVersion`）。当前按实例数设计。 |
| OQ-012 | 崩溃后调度器如何识别并重派？同一 attemptId 还是新 attempt？ | 恢复触发、幂等与结果归属 | S1 契约冻结时定；提案建议重跑必须新 `attemptId`，同 attemptId 只做传输重放；已结算结果按 `clientId + attemptId` 重报（`SCH-11`）。client 只清理并重新注册，不自动重跑（`REQ-0002` R-04）。 |
| OQ-013 | 取消/超时强杀前是否抓取已产生的部分输出？ | 结果完整性与排障 | 当前默认不抓，报 `cancelled`/`timeout`；若需要，M1 结果契约加 partial 字段（`REQ-0002` R-03）。提案维持不带；`message` 有输出就填，空串仅表示确实没有输出（`RD-04`）。 |
| OQ-014 | 除 `[acp].dsh_home` 外，配置键清单与优先级何时冻结？ | `SCN-0002` 的范围、`CMP-cli` 规格与部署文档 | 组件规格已提案 `[acp].permission`（默认 `deny`）与 `state.root`（默认 `<runDir>/.agent-flow-client`），并给 `run/serve --permission`；键名与优先级待 P1 确认 / M1 冻结。S0 只强制 `[acp].dsh_home`。 |
| OQ-015 | `run` 的非成功节点结果是否用退出码 `1`，SIGTERM 是否用 `143`？ | CLI 契约、S0 测试与 CI 判定 | 组件规格暂定 `1`（非成功 `NodeResult`）与 `143`（SIGTERM）；已写入 `architecture.md` §3.2，待 P1 确认。 |
| OQ-016 | 迟到结果用 `409 late_result` 还是 `200 disposition=late`？ | 结果重试、审计与调度器状态推进 | 提案推荐 `409`（与 `CMP-gateway` 现有错误表一致），client 按终态处理、只审计；见提案 §15 Q3。 |
| OQ-017 | 启动恢复是否由调度器下发实例绑定（`register.assignments`）？ | 崩溃后容器校验/清理与恢复路径 | 提案推荐可选下发；client 无则按 journal 恢复，不阻塞领取；见提案 §5.1/§15 Q4。 |
| OQ-018 | 技能包分发通道：调度器托管端点还是签名外链？ | 下载鉴权、缓存与凭据泄漏 | 提案推荐调度器托管 `GET /api/v1/executor/skill-packages/{packageId}/download`；外链必须短期签名且不带 client token；见提案 §5.5/§15 Q6。 |
| OQ-019 | `claim` 是否长轮询？空闲客户端的轮询形态？ | 领取延迟、服务端连接数与空转 | 提案推荐 `claim` 长轮询 20s，`204` 可带 `Retry-After`；见提案 §4.6/§15 Q5。 |
| OQ-020 | 客户端认证方式与轮换；`run_superseded` 的退出码？ | 安全、双跑 fencing 与 CLI 契约 | 提案推荐 Bearer + TLS、轮换下一版；`run_superseded` 按评审建议新增退出码 7（不复用 2），待 M1 确认；见提案 §4.2/§15 Q7、Q18。 |
| OQ-021 | 「已上报但服务端未确认」的结果在 journal 保留多久？ | 磁盘占用、凭据吊销后的滞留与可重报窗口 | 评审 `H-01` 提出；属 client 内部存储策略，不改调度器契约。S1 先按「attempt 未重派且未关闭即可重报」实现，M1 前定保留窗口/上限与清理策略。 |
| OQ-022 | 只读观测 HTTP 的绑定地址、端口、token 与调度器发现方式？ | 调度器能否访问、原始 session 暴露面、部署方式 | P1 设计稿：默认 `0.0.0.0:17890`（CLI 可改）；token 可选，空则不鉴权并告警；v1 调度器侧静态配置 base URL，不自动发现。调度器附评 `OB-01` 建议 v1 只 loopback；当前按产品决策保留 `0.0.0.0` 并记为已接受风险，P1 确认门签字。见 `docs/works/2026-11-06-observability-http/review.md`。 |
| OQ-023 | `claimRequestId` 幂等记录的保留窗口取多少？ | 窗口过短会产生影子租约（丢包重试多租一个 attempt） | 提案建议 `>= 尝试租约 TTL + 结果确认窗口`（120s + 60s，取 10min 更稳）；属调度器实现参数，不进对外契约。M1 写进 `CMP-gateway` 实现说明。 |
