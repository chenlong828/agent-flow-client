---
layer: plan
module: global
status: current
updated: 2026-11-03
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
| OQ-010 | 租约 TTL 与心跳长轮询超时？ | 离线判定与取消延迟 | 心跳间隔已定 30s（2026-11-03）；TTL 必须大于 30s，M1 定具体值 |
| OQ-011 | 容量单位：实例数还是 session 数？ | `serve` 循环与领取 | M1 定；当前按实例数设计 |
