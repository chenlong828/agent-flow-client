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

- Bun 安装在 `~/.bun/bin`（1.4.4），通过 `PATH` 全局可用；项目不携带本地工具链。
- 首次安装依赖：`bun install`。
- 常用命令：`bun run src/cli.ts --help`、`bun test`、`bun run typecheck`。

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
