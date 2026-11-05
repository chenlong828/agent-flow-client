---
layer: requirements
module: cli
status: accepted
updated: 2026-11-04
---

# REQ-0001：ACP 模式的可配置 DSH_HOME

**类型**：feature

## 1. 场景叙述

当 agent-flow-client 以 ACP 模式启动 DSH 时，配置模块读取**运行目录**下的 `.config`（TOML），把 `[acp].dsh_home` 解析为 ACP 进程使用的 `DSH_HOME`；没有配置时使用 `<运行目录>/AF_DSH_HOME`。操作员可以用环境变量 `DSH_HOME` 临时覆盖。

结果是：ACP 的会话记录落在 client 自己的目录里，不会进入 desktop/web 共用的 `~/.dsh`，也不随启动时的当前工作目录漂移。

## 2. 价值

不做这件事的后果不是「少一个配置项」，而是 ACP 默认写进用户主目录 `~/.dsh`：

- 调研实测：共用 `DSH_HOME` 时，web 的 `session/list` 会返回 ACP 会话；home 首次初始化时这些会话还会被 workspace bootstrap 按 cwd 登记成工作区。
- 反向同样成立：ACP 的 `session/list` 会列出 desktop/web 的普通会话，client 若直接展示，会把用户私人历史带到上层。
- 会话记录包含完整 system prompt、用户消息、assistant reasoning、工具参数/输出与审批记录；共用 home 不是「多几个文件」，是完整的跨 profile 暴露。

默认 `<运行目录>/AF_DSH_HOME` 让每个 checkout/安装目录天然拥有独立的会话存储，操作员不需要每次 `export DSH_HOME`，也不依赖启动 cwd。

## 3. 非目标

- 不改 DSH/ACP 协议，不改 desktop/web profile，不修改用户 `~/.dsh`。
- 不做实例级 home 的清理、保留、TTL、容量上限或历史会话迁移。
- 不做多实例并发调度、租约或跨 client 迁移；本需求只解决「一个 ACP 进程的 home 从哪来」。
- 不做多实例 per-instance home 派生：本卡只解析出一个 home；架构允许 client 承载多实例，多实例如何分目录另立需求，本卡不声称已支持。
- 不做凭据管理；不把 API key/token 写进 `.config`。
- 不引入新的第三方运行时依赖；不新增顶层组件，`config` 作为 `CMP-cli` 的内部模块。
- 不做 `.config` 热加载；启动时一次加载、校验、冻结，运行期不重读。
- 不配置调度器地址、client 身份等其它键；本需求只定义 `[acp].dsh_home`。
- 不保证「同一份代码从不同 cwd 启动得到同一个默认 home」；默认值跟随运行目录，不跟随 cwd。

## 4. 行为约定

### 4.1 运行目录 `<runDir>`

`<runDir>` 按本需求定义为 **client CLI 可执行文件所在目录**：

- 打包态：`agent-flow-client` 可执行文件所在目录；
- 源码态：client 包根（`package.json` 所在目录），**不是** `process.cwd()`，**不是** `src/`，**不是** bun/node 解释器安装目录；
- 如果实现只能拿到 CLI 入口文件路径，启动器需要向上解析到包根；具体解析方式由 design 任务落实并写进组件规格。

`.config` 与默认 `AF_DSH_HOME` 都以 `<runDir>` 为基准。

### 4.2 配置文件

- 路径：`<runDir>/.config`。
- 格式：TOML，UTF-8。
- 最小键位：

  ```toml
  [acp]
  dsh_home = "AF_DSH_HOME"
  ```

- `[acp].dsh_home`：可选字符串；可以是绝对路径，也可以是相对 `<runDir>` 的路径；解析后统一归一化为绝对路径。
- 不做 `~` 展开；需要用户目录时写绝对路径。
- 文件不存在：不是错误，按默认值处理。
- TOML 语法错误、`[acp].dsh_home` 类型不是字符串、值为空/全空白：启动失败，不静默回退默认值。
- 未知键：忽略，保持向前兼容；是否告警由 design 决定。

### 4.3 优先级

从高到低：

1. 非空的 `DSH_HOME` 环境变量；
2. `.config` 的 `[acp].dsh_home`；
3. `<runDir>/AF_DSH_HOME`。

说明：

- 空字符串环境变量按「未设置」处理。
- 环境变量和配置文件里的相对路径，都按 `<runDir>` 解析，再归一化为绝对路径。
- 优先级是**用户显式覆盖**语义：环境变量存在时，即使 `.config` 有值也以环境变量为准。
- client 启动时不得把 `~/.dsh` 作为隐式默认；只有用户显式配置或显式设置环境变量时才使用它。

### 4.4 目录生命周期与传给 DSH

- 启动时确保解析出的 home 目录存在：不存在则以 `0700` 创建；已存在则必须是目录且可写。
- 创建失败、路径是文件、不可写：启动失败；配置类错误退出码 `2`，运行时目录类错误退出码 `4`，不静默改用默认目录。
- 把归一化后的绝对路径作为 `DSH_HOME` 传给 DSH 子进程；client 自身不直接读写会话日志。
- 启动日志记录最终 home 路径与来源（`env` / `config` / `default`），不打印凭据或配置内容。
- 配置在进程启动时加载一次并冻结；serving/执行期间不因文件变化而切换 home。

## 5. 影响场景

| 场景 | 状态 | 本次新增/修改的断言 |
|---|---|---|
| `SCN-0002`：配置 client 并完成自检 | designed（已建卡） | 配置矩阵：默认值、`.config` 绝对/相对路径、环境变量覆盖、非法 TOML/空值/不可写/指向 `~/.dsh`；`doctor` 检查 home 来源与可写性 |
| `SCN-0001`：执行节点并回传结果 | designed（已建卡） | 端到端断言：节点执行时会话落 client home，`~/.dsh/sessions` 无新增；不重复配置矩阵 |

配置矩阵归 `SCN-0002`；`SCN-0001` 只保留“执行时使用生效配置的 home 落点”这一条端到端断言。这样既让配置/自检有独立入口和结果，也避免执行场景承担配置校验的职责。

涉及组件（不改组件切分）：

- `CMP-cli`：配置加载、校验、优先级解析、启动日志；
- `CMP-runtime`：确保 home 目录存在、把解析结果注入 DSH 子进程；
- 不新增顶层组件；`CMP-observability` 只消费启动日志。

对外契约不变：不改调度器字段，不改 ACP 协议，只改 client 启动 DSH 时注入的 `DSH_HOME`。

## 6. 验收归属

本需求不另立测试。验收 = `SCN-0002` 的 3 正 1 反 + `SCN-0001` 的 R1（home 落点）+ 第 4 节约束未被违反。

`SCN-0002` 的 3 正 1 反即配置矩阵：

- 断言 1：没有 `.config`、没有 `DSH_HOME` 环境变量 → 使用 `<runDir>/AF_DSH_HOME`，`doctor` 全绿，退出 0。端到端“会话日志落在这里、`~/.dsh/sessions` 不新增”由 `SCN-0001` R1 断言。
- 断言 2：`.config` 配置绝对路径 / 相对路径 → 生效值与 DSH 子进程入参为解析后的绝对路径；端到端 home 落点由 `SCN-0001` R1 断言。
- 断言 3：环境变量与 `.config` 同时存在 → 环境变量胜出。
- 断言 4：非法 TOML、空值、不可写目录 → 启动失败且不回退默认值；错误码符合约定。

跨 profile 断言：用 `~/.dsh` 启动的 desktop/web `session/list` 不包含 AF_DSH_HOME 下的测试会话（复用会话记录调研的验证方法）。

## 7. 澄清记录

| 时间 | 问题 | 结论 |
|---|---|---|
| 2026-11-03 22:05 | `.config` 的格式与文件名？ | 文件名 `.config`，TOML |
| 2026-11-03 22:05 | 「agent-flow-client 运行目录」按哪个基准？ | CLI 可执行文件所在目录；源码态按 client 包根解释（见 4.1），不按 cwd |
| 2026-11-03 22:05 | `DSH_HOME` 的优先级？ | 环境变量 > `.config` > 默认 `<runDir>/AF_DSH_HOME` |
| 2026-11-03 23:20 | 是否需要独立的配置解析场景？ | 不需要。配置解析是执行场景的准备步骤；验收挂到 `SCN-0001` + `doctor`，配置矩阵作为附加断言 |
| 2026-11-04 | 系统配置是否单独成场景？ | 需要，但不是“配置解析”，而是“配置 client 并完成自检”。新增 `SCN-0002`；配置矩阵与 `doctor` 归它，`SCN-0001` 只保留端到端 home 断言 |

## 8. 依赖与待确认

- 依赖：`SCN-0002`（配置与自检）、`SCN-0001`（执行时 home 落点）、`docs/works/2026-11-03-acp-session-records/result.md` 的会话归属结论；S0 实现尚未开始。
- 待确认（进入 design 时解决，不阻塞本卡）：
  - 源码态如何稳定解析到包根，避免 `bun run src/cli.ts` 时把 bun 安装目录当成 `<runDir>`；
  - Bun 内置 TOML 解析是否满足「不新增依赖」，以及未知键告警策略；
  - 多实例并发时的 per-instance home 派生：本卡只给单 home，架构允许一个 client 承载多实例，需在 S 阶段确认是否另立需求。
- 提醒：如果部署环境本身导出了 `DSH_HOME`，它会按优先级覆盖 `.config` 和默认值；部署文档应明确不要全局导出，除非就是要覆盖。

## 9. 状态

`accepted`。已建 `SCN-0002`（designed）、`SCN-0001`（designed）与 `REQ-0002`；配置矩阵归 `SCN-0002`；下一步补 `CMP-cli` / `CMP-runtime` 组件规格并拆 S0 任务；本卡不直接对应代码改动。
