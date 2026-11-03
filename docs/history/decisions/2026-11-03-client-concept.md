---
layer: history
module: global
status: frozen
updated: 2026-11-03
---

# 2026-11-03 客户端概念设计定稿

## 背景

S0 P0 阻断项验证（12 项 11 通过）确认了 DSH 的技能读取时机、技能根约定、项目根解析与并发 session 行为后，client 需要冻结「对外接口面 + 内部模块划分 + 主流程与不变量」，作为组件规格与 M1 契约的输入。

本决策记录概念设计 P1 确认时的关键取舍；完整论证与源码依据见已冻结的
`docs/history/works/2026-11-03-client-concept-design/design.md`，现行系统真相见
`docs/design/architecture.md`。

## 决策

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 不提供本地 HTTP / IPC 服务 | 沿用上游出站租约模型；服务端化会引入端口、鉴权、推送与 NAT 问题，属两侧边界变更 |
| D2 | 9 个组件，`CMP-result` 独立 | 结果语义与错误分类是独立变化轴；并入 executor 会混两个变化轴，并入 runtime 会让适配器懂业务 |
| D3 | `serve` 循环暂放 `CMP-cli`，不独立 `CMP-daemon` | 当前只有单进程单循环；拆分触发条件已写明 |
| D4 | 端口定义在 `CMP-executor`（L1b），L0 实现 | 依赖倒置；L0 只依赖 L1 契约，便于替换与测试 |
| D5 | 结果三段：runtime 提取 / result 语义 / gateway 传输 | 每个组件只封一个易变决策 |
| D6 | 冻结「先建 session、再取技能、再刷新、再 prompt」 | 技能读取时机已验证；备选顺序不再需要 |
| D7 | 工作区单写 + 路径约束（拒绝越界/符号链接逃逸） | 远程 prompt 与脚本具有执行影响力，路径是安全基线 |
| D8 | 节点作用域是整个容器，可跨仓库 | 实际任务常跨多个仓库；`NodeRequest` 带容器路径（编排层参数），仓库清单由目录本身表达 |
| D9 | fan-out 分支共享同一容器与同一技能集，不做工作区复制 | 并发分析类任务同容器即可；复制无收益且放大技能刷新竞态 |
| D10 | 专家由调度器装配，client 只落技能集 | persona 进 prompt、工具随技能包；client 不读取专家结构 |
| D11 | workspace 由准备阶段预置（仓库已在目录中），client 只校验与清理 | 准备动作在 client 之外；client 不承担 clone 的凭据/网络/失败语义 |
| D12 | 取消以实例（含整个 fan-out）为单位，立即终止 | 用户确认 fan-out 取消即整体取消；一处收口、无孤儿；不做单分支取消 |

## 关键约束

1. **技能可见性**：只屏蔽全局根（`dshHome` / `agentsHome` / `bundledSkillDir` 指向空目录），保留 `includeDefaultRoots: true` 与项目 `.dsh` / `.agents`；补丁整份替换 config，不深合并。
2. **容器根即技能根**：session `cwd` 固定为容器根；容器根不建 `.git`、必须位于任何仓库之外；`doctor` 校验 `findProjectRoot(容器根) === 容器根`。
3. **通知不推送**：编排事件随 30s 心跳长轮询下发；请求到达即续租，连接断开/超时是离线信号，租约过期裁决；事件按 `seq` 至少一次、幂等应用。
4. **并发同集**：同一容器的并发节点由调度器保证同一技能集；client 按 digest 幂等安装，违约显式失败。
5. **取消立即终止**：不等 prompt 自然结算；已结算的结果按实际上报，已上报的取消只 ack。

## 未决（M1）

- `NodeRequest` / `NodeResult` / `SkillSet` 字段与结果大小上限；
- 技能集下发形态：包 URL + 校验和，还是技能清单 + 下载端点；
- 容量单位：实例数还是 session 数；
- 鉴权方式、版本兼容窗口、租约 TTL（> 30s）；
- OQ-009 `DSH_HOME` 粒度：一实例一 home（方向已定，S0 落地回收策略）。
