---
layer: plan
module: global
status: current
updated: 2026-11-12
---

# 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| ~~DSH 在 session 创建时固化技能~~ | 已实测排除：prompt 时读取技能 | 2026-11-03 验证通过；保留 S0 回归用例，防止版本回退 |
| 实例绑定 client，client 离线 | 实例停摆 | 明确为产品约束；先做等待/失败，不做迁移 |
| 契约漂移 | 两侧字段/语义不一致 | 契约先行、版本协商、共用样例；冻结后字段/语义变更必须升 `protocolVersion`，组件规格不得自行扩展 |
| 远程 prompt/脚本的执行信任 | 调度器可影响本机执行 | 凭据、审计、用户授权、必要白名单 |
| 本地产物不可见 | 调度器无法直接审计产物 | 依赖节点结果与评审节点；后续再评估 |
| 技能刷新竞态 | 并发 session 看到错误组合 | 调度器保证同一容器并发节点同技能集；client 按 digest 幂等安装，违约显式失败（D9） |
| 重派与旧副本重叠（v2） | 同一任务可能短暂跑两份，工作区 last-write-wins | v2 接受该成本；调度器按 `timeoutMs + 60s` / 静默 120s 回队；结果以首份为准 |
| 旧控制事件重放到新 run | 重启后旧 `cancel`/`shutdown` 杀掉新 attempt | 控制事件按 `(clientId, runId)` 队列；新 run 丢弃旧 run 未 ack 事件；事件按 `issuedAt` 只作用于旧于它的 attempt |
| DSH/平台差异 | 脚本、路径、进程行为不一致 | 先 macOS/Linux；Windows 后补 |
| 开发环境的 DSH 构建落后源码 | 插件静默缺失（实测 7 个 bundle 跳过），能力与生产不一致 | 固定发行版与版本 pin；`doctor` 检查加载结果；不用源码 checkout 的陈旧 `lib/` 做验收。S0 验证前已重建 checkout（install + build:lib） |
| 崩溃后工具子进程变孤儿 | 重启后残留 sleep/脚本进程，可能占端口、写文件或泄漏资源 | client 取消/关闭/崩溃统一按进程组/作业树强杀，重启前清理；S0-11 实测 dsh 被 SIGKILL 后 bash 子进程仍存活 |
| 默认技能根串味 | 节点看到用户级/打包技能，行为不可控 | 实例 profile 保留 `includeDefaultRoots`，把 `dshHome` / `agentsHome` / `bundledSkillDir` 指向三个真实空目录；项目 `.dsh` / `.agents` 保留；不用 `DSH_HOME` 关技能（S0-05 的严格隔离只作探针） |
| 容器根位于外层 git 仓库下 | `projectRoot` 上浮，`.dsh/skills` 不可见，模型看不到节点技能 | 容器根放 client 自有目录、位于任何仓库之外；`doctor` 校验 `findProjectRoot(容器根) === 容器根`；不给容器根建 `.git` |
| 长轮询被代理/NAT 空闲断开 | 误判离线、控制事件延迟 | 心跳间隔 30s（小于空闲超时）；自动重连 + 退避；最终以租约过期裁决 |
| 嵌套沙箱下 bash 后台/越界命令失败 | 验证与运行环境受限，工具调用报 SANDBOX_UNAVAILABLE | 让 dsh 运行在非嵌套沙箱；脚本/命令写工作区内；S0-06/11 已验证工作区内前台脚本可用 |
| 权限请求缺少工具标识 | 无法按工具名做细粒度白名单 | 按会话/节点整体授权；必要时从 `tool_call` update 关联工具；S0-06 实测 title/kind 为 null |
| 共享 `DSH_HOME` 导致跨 profile 会话暴露 | ACP 会话（含 system prompt、推理、工具 I/O、审批）会出现在 web/desktop 的 `session/list`；home 首次初始化时还会被 workspace bootstrap 登记成工作区。反向 ACP 也能列出 desktop/web 会话，client 直接展示会把用户私人历史带给上层 | 一实例一 home，spawn 时显式传 `DSH_HOME`，绝不指向 `~/.dsh`；client 只展示/恢复本实例记录的 sessionId；不以 profile 名或 `session-` 前缀做隔离；实例回收删 home。详见 `docs/works/2026-11-03-acp-session-records/result.md` |
| client 不自动重跑，依赖调度器重派 | 崩溃/重启后节点停摆或延迟到下次重派；调度器不重派时实例卡住 | 已在 `SCN-0001`/`REQ-0002` 锁定“等重派”；调度器侧需定义崩溃识别与重派策略（OQ-012）；client 记录未收口 attempt 供排障 |
| 取消立即强杀丢失最终输出 | 模型已产生的部分输出来不及回传，结果只能报 `cancelled` | 取消以收敛为先；journal 保留已收事件供本地排障；若 prompt 已结算则按实际结果上报（`REQ-0002` R-03） |
| 工作区不自动清理（v2） | 容器/目录长期占用磁盘 | v2 无清理指令，工作区默认保留；由运维按 `instanceId` 回收 |
| 观测 HTTP 暴露原始 DSH session | 原始文件含 system prompt、推理、工具 I/O；误暴露或无限保留会泄漏/撑爆磁盘 | 默认 `0.0.0.0` 且 token 可空，必须限定受控网络；token 非空时强制 Bearer；raw 响应 `no-store` 并审计；`retentionDays`/`maxBytes` 清理；归档失败不删实例 home，先重试再清理 |
| 观测面明文传 raw（`OB-01`） | 非 loopback + 明文 + 长期静态 token：token 被嗅探即可重放，所有 client 的 session 全文泄露 | 已接受风险（产品决策 `0.0.0.0`）；关闭方式 `--observability-bind 127.0.0.1` 或后续 TLS/mTLS；`raw_enabled=false` 可先关全文下载；审计 + `no-store` |
| 观测写盘阻塞执行（`OB-02`） | 单线程同步写/`fsync` 拖慢心跳与 `renew`，把观测面变成租约过期原因 | 执行路径只入内存队列，后台批量落盘，不 `fsync`；队列 10k 溢出计数丢弃；退出 flush 上限 2s |
| 配置错误被静默回退 | 非法 `.config`、空值或不可写目录回退默认，操作员以为配置生效，节点用错 home | `SCN-0002` 校验失败即退出 2，不回退默认；`doctor` 输出生效值与来源；启动日志记录来源 |
| 会话日志完整透传（v3） | 日志含模型输出与工具 I/O，可能带密钥/凭据；上传到调度器即离开本机 | 已接受风险（2026-11-12 决策）：客户端不做脱敏，服务端只存不解析，排障时离线处理；后续如收紧再由契约定义脱敏规则 |
| 会话日志超过 `maxSessionLogBytes`（v3） | 日志被 `413` 拒绝后没有日志，结果被 `409 session_log_missing` 拒绝，任务卡住不结算 | 本期按原样打包上传、不做截断/分包（2026-11-12 决策）；发生即人工处理；后续版本评估提高上限或分包 |
