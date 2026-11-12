---
layer: plan
module: global
status: current
updated: 2026-11-08
---

# 开放问题

| ID | 问题 | 影响 | 下一步 |
|---|---|---|---|
| OQ-001 | DSH 在 prompt 时还是 session 创建时读取技能？ | 决定主流程顺序 | **已关闭**（2026-11-03 实测：每次 `session/prompt` 重新读取工作区技能）；S0-03 复验：建 session 后立即写技能 3/3 可见，同 session 替换后 catalog 与加载内容同步更新；主流程仍用「先写后建」优先，S0 保留回归用例 |
| OQ-002 | DSH 工作区技能目录的准确约定？ | 技能是否被识别 | **已关闭**（2026-11-03 S0 实测）：根为 `<projectRoot>/.dsh/skills`（rank 100）与 `<projectRoot>/.agents/skills`（200），`projectRoot` = 最近含 `.git` 的祖先（`.git` 文件也算），否则 cwd；只认顶层 `<name>/SKILL.md` 或 `<name>.md`，嵌套与缺 `description` 跳过；同名按 rank 取 `.dsh`。隔离方案按产品要求定为「只屏蔽全局根、保留项目根」：三个全局根指到空目录，`includeDefaultRoots` 保持 true（见 `docs/design/architecture.md` §8） |
| OQ-003 | DSH 二进制如何供给与升级？ | 安装与版本一致性 | 预研：源码 checkout 可直接启动，但当时 `lib/` 落后 HEAD（7 个插件跳过）；S0 验证前已重建（install + build:lib）。生产仍应固定发行版而非 checkout；S0 定安装方式与版本 pin |
| OQ-004 | client 凭据如何发放与保存？ | 安全与接入成本 | 预研：ACP 读 `$DSH_HOME/.credentials.yaml`，也认 `DEEPSEEK_API_KEY` 启动环境变量。倾向一实例一 home + env 注入，不落盘 |
| OQ-005 | 工作区/日志保留多久？ | 磁盘与排障 | S1 前定默认 |
| OQ-006 | 结果大小上限？ | 传输与解析 | **已关闭**：256 KiB 常量（v2 不经接口协商）；见 `docs/design/contracts/executor-http-v3.md` §3。 |
| OQ-007 | 目标平台范围？ | 脚本/路径/进程实现 | 先 macOS/Linux |
| OQ-008 | client 与 DSH 的版本兼容窗口？ | 升级策略 | 实测 ACP v1、dsh 0.2.2-alpha.2；兼容窗口待 S1 契约冻结时定 |
| OQ-009 | DSH_HOME 隔离粒度：一实例一 home 还是一 client 一 home？ | 会话可见性、凭据与磁盘占用 | 预研建议一实例一 home；S0-11 补充：崩溃后 lock 残留、`session/list` 会列出崩溃会话、孤儿进程需清理，隔离粒度需一并考虑回收策略；2026-11-03 会话记录调研：session 按 `DSH_HOME` 归属、profile 目录不含 session，共用 home 时 web/desktop `session/list` 实测返回 ACP 会话（首次初始化还会被 workspace bootstrap 采纳），ACP 反向也能列出 desktop 会话；因此必须一实例一 home，client 只展示/恢复本实例记录的 id（详见 `docs/works/2026-11-03-acp-session-records/result.md`） |
| OQ-010 | 租约 TTL 与心跳长轮询超时？ | 离线判定与取消延迟 | **v2 作废**：v2 无租约/心跳，判活由 poll 长轮询承担；旧结论只保留在 v1 归档。 |
| OQ-011 | 容量单位：实例数还是 session 数？ | `serve` 循环与领取 | **v2 更新**：容量以 `capacity.free`（= `maxConcurrent - running.length`）上报；同实例多任务并发为默认语义。 |
| OQ-012 | 崩溃后调度器如何识别并重派？同一 attemptId 还是新 attempt？ | 恢复触发、幂等与结果归属 | **v2 更新**：静默 120s 或超 `timeoutMs+60s` 回队，`attempt + 1`，`taskId` 不变；client 不自动重跑。 |
| OQ-013 | 取消/超时强杀前是否抓取已产生的部分输出？ | 结果完整性与排障 | **已关闭**：不额外抓取，但已产生的输出填入 `message`（截断）；空串只表示确实没有输出；v2 保留。 |
| OQ-014 | 除 `[acp].dsh_home` 外，配置键清单与优先级何时冻结？ | `SCN-0002` 的范围、`CMP-cli` 规格与部署文档 | **已关闭**（2026-11-08）：`[acp].dsh_home`/`permission`、`[state].root`、`[logging].level`、`[capacity].max_instances`；优先级 CLI flag > `DSH_HOME` > config > default。`stateRoot` 默认 `<runDir>/.agent-flow-client`，不可写退出 4，不静默回退。见 `CMP-cli` §2.3。 |
| OQ-015 | `run` 的非成功节点结果是否用退出码 `1`，SIGTERM 是否用 `143`？ | CLI 契约、S0 测试与 CI 判定 | **已关闭**（2026-11-08 用户确认）：按 `architecture.md` §3.2 冻结 `0/1/2/3/4/5/6/7/130/143`；`run` 非成功 `NodeResult` 用 `1`，SIGINT `130`、SIGTERM `143`。见 `docs/history/works/2026-11-08-s0-local-loop/brief.md` §2.2。 |
| OQ-016 | 迟到结果用 `409 late_result` 还是 `200 disposition=late`？ | 结果重试、审计与调度器状态推进 | **v2 作废**：v2 用 `200 {accepted:false}` 表达重复/迟到结果，无 `late_result`。 |
| OQ-017 | 启动恢复是否由调度器下发实例绑定（`register.assignments`）？ | 崩溃后容器校验/清理与恢复路径 | **v2 作废**：无 register/assignments；任务随 poll 下发，client 按 journal `settled` 补报。 |
| OQ-018 | 技能包分发通道：调度器托管端点还是签名外链？ | 下载鉴权、缓存与凭据泄漏 | **v2 确认**：`P-03 GET /skill-packages/{packageId}`；跨 host 不带 token，按 digest 缓存。 |
| OQ-019 | `claim` 是否长轮询？空闲客户端的轮询形态？ | 领取延迟、服务端连接数与空转 | **v2 作废**：由 `poll` 30s 长轮询承担，空结果始终 200 + `tasks: []`。 |
| OQ-020 | 客户端认证方式与轮换；`run_superseded` 的退出码？ | 安全、双跑 fencing 与 CLI 契约 | **v2 更新**：Bearer + TLS；无 `runId` fencing/`run_superseded`，退出码 7 作废；轮换留下一版。 |
| OQ-021 | 「已上报但服务端未确认」的结果在 journal 保留多久？ | 磁盘占用、凭据吊销后的滞留与可重报窗口 | 评审 `H-01` 提出；属 client 内部存储策略，不改调度器契约。M1 后仍开放：S1 按「attempt 未重派且未关闭即可重报」实现，保留窗口在 S1 期间按实测磁盘占用定；不阻塞契约。 |
| OQ-022 | 只读观测 HTTP 的绑定地址、端口、token 与调度器发现方式？ | 调度器能否访问、原始 session 暴露面、部署方式 | P1 设计稿：默认 `0.0.0.0:17890`（CLI 可改）；token 可选，空则不鉴权并告警；v1 调度器侧静态配置 base URL，不自动发现。调度器附评 `OB-01` 建议 v1 只 loopback；当前按产品决策保留 `0.0.0.0` 并记为已接受风险，P1 确认门签字。见 `docs/works/2026-11-06-observability-http/review.md`。 |
| OQ-023 | `claimRequestId` 幂等记录的保留窗口取多少？ | 窗口过短会产生影子租约（丢包重试多租一个 attempt） | **v2 作废**：无 claim/claimRequestId；由 `S-03` 未确认重发兜底。 |
| OQ-024 | 场景 UC → 测试目录/文件的映射表何时补？ | 场景覆盖证明、S0 验收 | **已关闭**（2026-11-08）：见 `docs/design/test-matrix.md`；每个 S0 UC 至少一个计划测试文件，测试 ID 在工序中回填。 |
| OQ-025 | `CleanupAck.failed` + `retryable=false` 的终止规则？ | 调度器是否永久重发清理、告警噪声 | **v2 作废**：无 cleanupPending/cleanupAcks；工作区默认保留，回收转运维。 |
| OQ-026 | S0 的模型路由（`hundsun-public/hs-deepseek-flash-latest`）由谁下发、如何与调度器节点参数解耦？ | 生产环境的模型选择与调度器契约 | S0 用实例 profile 补丁固定 `llm-pi-ai` + `agent-default-model` + `acp` 三处，`AF_MODEL`/`AF_LLM_BASE_URL` 可覆盖；S1 决定进配置键还是由 `NodeRequest` 携带（后者需改契约）。见 `docs/history/works/2026-11-08-s0-local-loop/result.md` §5。 |
| OQ-027 | Agent 执行任务的容错语义（不承诺 exactly-once、允许顺序重试、同容器单写者）与卡死/超时归属，需调度层确认 | client 重试/超时实现、契约可选字段、容量与清理策略 | 已整理提议 `docs/works/2026-11-10-execution-semantics-proposal/proposal.md`，待 Q1–Q8 结论；结论前按现行 A 方案与既有契约执行。 |
