# agent-flow-client 协作约定

本文件只写项目内的稳定规则。项目定位见 `README.md`，文档组织见 `docs/README.md`。

## 定位

执行面客户端：Bun + TypeScript CLI；负责本地工作区、技能落地、DSH/ACP 执行与少量结果回传。编排决策在调度器侧，不在本仓库。

## 语言

- 文档、注释、commit message 用中文；代码标识符、API 名、目录名用英文。
- 不为了节约 token 自创缩写；行业通用缩写与项目已定义 ID 除外。

## 技能

`.agents/skills/` 于 2026-11-03 从 `../agent-flow-orchaster/.agents/skills/` 复制，包含：

- `req-scenario-spec`
- `design-before-coding`
- `arch-design-spec`
- `dev-execution-spec`
- `doc-layout-spec`

升级方式：覆盖同名目录，并在 `docs/history/decisions/` 记一条。不直接手改技能正文。

## 工具链

- Bun 安装在 `~/.bun/bin`（1.4.4）；不是每个 shell 的 `PATH` 都有它，`scripts/serve-dev.sh` 会自己找（`BUN_BIN` 可指定），其他命令先 `export PATH="$HOME/.bun/bin:$PATH"`。项目不携带本地工具链。
- 首次安装依赖：`bun install`。
- 常用命令：`bun run src/cli.ts --help`、`bun test`、`bun run typecheck`。

## 本机联调：client 常驻在系统终端里

联调期间 `client` 是**长期常驻在系统终端里的一个实例**：你在终端起它一次，DSH 这边的会话就用这个实例跑任务；开发中改代码后重启的动作是「杀掉它」，由监督进程自动拉起。这条与日常开发习惯相反，先按本节做，不要改流程。

入口是 `scripts/serve-dev.sh`（包装 `scripts/serve-bg.ts --dev`；默认读 `.agent-flow-client/orchaster-stub/client.toml`，`--config <path>` 或 `AF_CLIENT_CONFIG` 可覆盖）。

- 起一次（在系统终端里）：`./scripts/serve-dev.sh`。`serve` 被任何方式杀掉都会自动拉起，这是默认工作方式。
- 重启（改完代码）：杀掉 `status` 里显示的 `serve pid`（`kill`、`kill -9` 都行），监督进程发现退出后自动拉起新进程，新代码立即生效；也可以 `./scripts/serve-dev.sh reload`（只发信号）。日志里的 `重启次数` 会加一。
- 不要杀监督进程：`status` 第一行 `pid:` 是监督进程，它一死就没人拉起了；可杀的只有 `serve pid:`。
- 查看：`./scripts/serve-dev.sh status`、`./scripts/serve-dev.sh logs --follow`；监督进程的退出与重启记录在 `<state.root>/logs/supervise.out`。
- 收工：`./scripts/serve-dev.sh stop`，这是唯一「停了不会再起来」的入口。
- 为什么必须在系统终端：在 DSH 会话里启动会继承 DSH 文件沙箱，写容器目录时报 `permission_denied：容器不可写`（`EPERM`）。`start`/`restart` 在 DSH 会话里会被直接拒绝；`status`/`logs`/`reload`/`stop` 只收发信号，任何环境都能执行。脚本会自动忽略 DSH 会话导出的 `DSH_HOME=~/.dsh`。

## 文档

- 五态分离：`docs/requirements|plan|design|works|history`；位置即状态。
- 每份内容文档带 frontmatter：`layer` / `module` / `status` / `updated`。
- 导航页是 `docs/README.md`；不预建空目录，内容诞生时创建。
- 需求、场景、组件、工序的写法按已安装技能执行。

## 边界

- 不做编排决策（下一节点、评审、分支、fan-out 拆分、回退）。
- 不读调度器数据库，不上传产物，不改 DSH。
- 跨项目只按 HTTP 契约；契约权威在调度器侧。
- 上游边界设计：`../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`。

## 门禁

- 改动级别按 `arch-design-spec` 的 P0–P3；未定级不抢跑。
- 提交前跑 `bun test` 与 `bun run typecheck`；新增契约或 schema 先走设计。
- 密钥只进 `.env`；不进 README、日志、注释、commit。
- 删除、覆盖、外发先确认。
