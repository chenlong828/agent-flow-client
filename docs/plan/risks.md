---
layer: plan
module: global
status: current
updated: 2026-11-03
---

# 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| ~~DSH 在 session 创建时固化技能~~ | 已实测排除：prompt 时读取技能 | 2026-11-03 验证通过；保留 S0 回归用例，防止版本回退 |
| 实例绑定 client，client 离线 | 实例停摆 | 明确为产品约束；先做等待/失败，不做迁移 |
| 契约漂移 | 两侧字段/语义不一致 | 契约先行、版本协商、共用样例 |
| 远程 prompt/脚本的执行信任 | 调度器可影响本机执行 | 凭据、审计、用户授权、必要白名单 |
| 本地产物不可见 | 调度器无法直接审计产物 | 依赖节点结果与评审节点；后续再评估 |
| 技能刷新竞态 | 并发 session 看到错误组合 | 调度器保证同一容器并发节点同技能集；client 按 digest 幂等安装，违约显式失败（D9） |
| DSH/平台差异 | 脚本、路径、进程行为不一致 | 先 macOS/Linux；Windows 后补 |
| 开发环境的 DSH 构建落后源码 | 插件静默缺失（实测 7 个 bundle 跳过），能力与生产不一致 | 固定发行版与版本 pin；`doctor` 检查加载结果；不用源码 checkout 的陈旧 `lib/` 做验收。S0 验证前已重建 checkout（install + build:lib） |
| 崩溃后工具子进程变孤儿 | 重启后残留 sleep/脚本进程，可能占端口、写文件或泄漏资源 | client 杀进程组/作业树或加 supervisor；重启前清理；S0-11 实测 dsh 被 SIGKILL 后 bash 子进程仍存活 |
| 默认技能根串味 | 节点看到用户级/打包技能，行为不可控 | 实例 profile 保留 `includeDefaultRoots`，把 `dshHome` / `agentsHome` / `bundledSkillDir` 指向三个真实空目录；项目 `.dsh` / `.agents` 保留；不用 `DSH_HOME` 关技能（S0-05 的严格隔离只作探针） |
| 容器根位于外层 git 仓库下 | `projectRoot` 上浮，`.dsh/skills` 不可见，模型看不到节点技能 | 容器根放 client 自有目录、位于任何仓库之外；`doctor` 校验 `findProjectRoot(容器根) === 容器根`；不给容器根建 `.git` |
| 长轮询被代理/NAT 空闲断开 | 误判离线、控制事件延迟 | 心跳间隔 30s（小于空闲超时）；自动重连 + 退避；最终以租约过期裁决 |
| 嵌套沙箱下 bash 后台/越界命令失败 | 验证与运行环境受限，工具调用报 SANDBOX_UNAVAILABLE | 让 dsh 运行在非嵌套沙箱；脚本/命令写工作区内；S0-06/11 已验证工作区内前台脚本可用 |
| 权限请求缺少工具标识 | 无法按工具名做细粒度白名单 | 按会话/节点整体授权；必要时从 `tool_call` update 关联工具；S0-06 实测 title/kind 为 null |
| 共享 `DSH_HOME` 导致跨 profile 会话暴露 | ACP 会话（含 system prompt、推理、工具 I/O、审批）会出现在 web/desktop 的 `session/list`；home 首次初始化时还会被 workspace bootstrap 登记成工作区。反向 ACP 也能列出 desktop/web 会话，client 直接展示会把用户私人历史带给上层 | 一实例一 home，spawn 时显式传 `DSH_HOME`，绝不指向 `~/.dsh`；client 只展示/恢复本实例记录的 sessionId；不以 profile 名或 `session-` 前缀做隔离；实例回收删 home。详见 `docs/works/2026-11-03-acp-session-records/result.md` |
