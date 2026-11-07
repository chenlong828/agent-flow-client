---
layer: design
module: execution-plane
status: designed
updated: 2026-11-04
flow: FLOW-CONFIG-001
scenario: SCN-0002
domain: 执行面
valueStream: 运行准备
title: 配置 client 并完成自检
entries:
  - component: CMP-cli
    path: src/components/cli/main.ts
    symbol: main
  - component: CMP-cli
    path: src/components/cli/config.ts
    symbol: loadConfig
  - component: CMP-observability
    path: src/components/observability/doctor.ts
    symbol: collect
docs:
  - path: docs/design/architecture.md
    heading: 3. 对外接口面
  - path: docs/design/architecture.md
    heading: 4. 组件与分层
  - path: docs/design/architecture.md
    heading: 10. 失败与恢复
  - path: docs/requirements/REQ-0001-acp-dsh-home-config.md
    heading: 5. 影响场景
tests:
  - role: R1
    id: TC-CONFIG-001
  - role: R2
    id: TC-CONFIG-002
  - role: R3
    id: TC-CONFIG-003
  - role: N1
    id: TC-CONFIG-004
---

# 配置 client 并完成自检

## 1. 场景与价值

操作员在首次安装、换机器、修改配置或排障时，先让 client 加载配置并做一次自检，确认“这台机器当前能不能执行节点”。

结果：配置被校验并冻结，`doctor` 给出可用/阻塞结论；操作员知道关键配置的生效值、来源和下一步动作。

角色与阶段：

- 生产：操作员在 `serve` 前执行配置与 `doctor`。
- S0：无调度器，配置与自检同样成立；`doctor` 不依赖网络。

本场景不覆盖：节点执行（`SCN-0001`）、调度器契约字段（M1）、安装打包（S3）、凭据签发（S3）、热加载、多实例 home 派生（OQ-009）。

## 2. 入口

入口待实现。计划入口：

- `CMP-cli` `doctor`：纯检查入口，输出生效配置、检查项与结论。
- `CMP-cli` 配置加载：`run` / `serve` 启动时复用同一套加载、校验、冻结逻辑。

只做“解析 `.config`”不构成场景；本场景的价值在“配置 + 自检 + 可判定结论”。落地后回填 `entries`。

## 3. 运行序

流程定义：`FLOW-CONFIG-001`。

1. 读取：CLI 参数 + 环境变量 + `<runDir>/.config`。
2. 优先级：环境变量 > `.config` > 默认；S0 只覆盖 `[acp].dsh_home`，其余键随 `CMP-cli` 规格扩展。
3. 归一化与校验：TOML 语法、空值、相对路径转绝对、目录可写、禁止指向 `~/.dsh`；非法即失败，不回退默认。
4. 冻结：启动时生成生效配置快照；运行期改 `.config` 不切换。
5. 准备 home：创建/确认 `AF_DSH_HOME` 或配置值；只建目录，不建 session。
6. 自检：`doctor` 检查 DSH 二进制/版本、home 来源与可写、容器根（如提供）、凭据存在性、残留 session/lock/孤儿进程；S1 增加调度器连通性。
7. 输出：生效配置（脱敏）+ 来源 + 检查项 + 结论；退出码按架构 §3.2。
8. 失败：配置错误退出 2、版本/鉴权 3、DSH 4、工作区 5；不静默回退、不启动执行。

## 4. 不可变引用

- `docs/design/architecture.md` §3.2：CLI 命令、配置一次性加载/校验/冻结、退出码。
- `REQ-0001`：`[acp].dsh_home` 的默认值与环境变量 > `.config` > 默认优先级。
- `DSH_HOME` 语义：session 按 home 归属，不按 profile；home 不得指向 `~/.dsh`（会话记录调研）。
- `doctor` 是本地检查，不依赖调度器；S0 不检查网络。
- DSH 基线 `0.2.2-alpha.2`；版本不兼容按退出码 3。

## 5. 测试映射

> UC/用例 → 测试文件的完整映射见 [`docs/design/test-matrix.md`](../../../../test-matrix.md)。

| 角色 | 测试 ID | 断言 |
|---|---|---|
| R1 | `TC-CONFIG-001` | 无 `.config`、无 env：默认 `<runDir>/AF_DSH_HOME` 生效；`doctor` 全绿；退出 0 |
| R2 | `TC-CONFIG-002` | `.config` 绝对/相对路径：生效值为绝对路径；DSH 子进程拿到同一路径 |
| R3 | `TC-CONFIG-003` | env 覆盖 `.config`：生效值与来源均为 env；启动后改 `.config` 不切换 |
| N1 | `TC-CONFIG-004` | 非法 TOML/空值/不可写/指向 `~/.dsh`：退出 2，不回退默认，不启动执行 |

补充检查（不替代 3+1）：

- `doctor` 缺 DSH → 退出 4，报告缺失项。
- DSH 版本不兼容 → 退出 3。
- 容器根非法 → 退出 5。
- 残留 session/lock/孤儿进程 → 报告并给出清理建议/退出 4。
- 凭据缺失 → `doctor` 报阻塞项（不误报全绿）；S0 测试注入测试凭据。
- 生效配置输出脱敏；凭据只显示“已配置/未配置”。

## 6. 覆盖边界

| 阶段 | 覆盖 |
|---|---|
| S0 | 配置加载/优先级/校验/冻结；`[acp].dsh_home`；`doctor` 的 DSH/home/凭据存在性/残留 session；退出码 2/3/4/5 |
| S1 | 调度器地址、凭据、版本协商；`doctor` 连通性检查 |
| S3 | 凭据存储与完整脱敏；安装/打包后的默认路径 |

不覆盖：热加载、多实例 home 派生与回收（OQ-009）、调度器契约字段（M1）、凭据签发、UI。

## 7. 变更记录

| 时间 | 变更 |
|---|---|
| 2026-11-04 | 新建：系统配置从“`SCN-0001` 的准备步骤”提升为独立操作员场景；配置矩阵与 `doctor` 归本场景，`SCN-0001` 只保留端到端 home 断言。 |
| 2026-11-04 | 范围限定：S0 只覆盖 `[acp].dsh_home`；调度器配置/凭据留 S1，凭据存储留 S3。 |
