---
layer: works
module: runtime
status: closed
updated: 2026-11-03
---

# 工序 Brief：ACP 会话记录与跨 profile 可见性调研

> 研究型工序（P3，无产品代码改动）。目标是把「ACP 跑多个 Session 后日志怎么记、是否只属于 ACP、web/desktop 能不能看到」这三个问题用源码 + 实测钉死，为 `DSH_HOME` 隔离粒度提供依据。

## 1. 背景

S0 验证（`docs/works/2026-11-03-s0-acp-verification/result.md`）已经确认 ACP 能并发跑多个 session、关闭与崩溃后的行为，但没有回答「记录落在哪、归谁」。用户明确希望：ACP 产生的会话记录不要出现在当前 desktop profile 或 web profile 中。

这个期望不能靠 profile 名字保证；需要确认 DSH 的 session 存储到底是按 profile 分区，还是按 `DSH_HOME` 分区。

## 2. 研究问题

| ID | 问题 | 期望产出 |
|---|---|---|
| Q1 | ACP 执行多个 Session 后，日志/记录以什么目录、文件、格式落盘？ | 路径布局、文件格式、写入时机 |
| Q2 | 这些记录是 ACP 专属，还是复用 DSH 通用 session 持久化？ | 与 desktop/web 的存储关系 |
| Q3 | 共用同一个 `DSH_HOME` 时，web/desktop 能否看到 ACP 会话？从哪些入口看到？ | 实测可见性与入口 |
| Q4 | 反过来，ACP 的 `session/list` 能否看到 desktop/web 的普通会话？ | 双向可见性 |
| Q5 | 要满足「看不到」，隔离边界应设在哪？还有哪些风险？ | 设计建议与风险 |

## 3. 验收标准

- 给出 ACP 会话的完整落盘路径、文件名、压缩/追加方式、文件权限。
- 至少实测两种 `DSH_HOME` 关系：ACP 与 web 共用同一 home、ACP 使用独立 home。
- 共用 home 时，用 web 的 `session/list` 接口实际取到 ACP 会话（sessionId/cwd 对得上）。
- 明确回答是否 ACP 专属，并说明 profile 目录与 session 存储的关系。
- 给出可复现命令；不写任何凭据；临时 home 用完清理。
- 结论回写 `plan/open-questions.md` 与 `plan/risks.md`。

## 4. 环境与隔离

| 项 | 值 / 做法 |
|---|---|
| dsh 入口 | `/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js`（源码 checkout，HEAD `ce7073d512`，已重建） |
| ACP 调用 | `node <entry> --profile acp`，ACP over stdio |
| 共用 home 实验 | `DSH_HOME=/tmp/dsh-s0/home-final2`（S0 最终 home，内含 37 个 ACP session 日志） |
| 对照 home | 用户真实 `~/.dsh`（desktop/web 正在使用）；只读检查，不写入 |
| web 启动 | `DSH_HOME=<同一 home> node <entry> web --host 127.0.0.1 --port 0 --no-open` |
| web API | 带 token 的 URL 换 cookie 后，POST `/api/session/list`（RPC 信封） |
| 凭据 | 实验不复制真实模型凭据；只做 `session/new` + `close` 的空会话，不触发模型调用 |
| 临时产物 | `/tmp/dsh-s0-vis/`、`/tmp/acp-empty-session.mjs`；不进入仓库 |

## 5. 任务表

| ID | 类型 | 内容 | 组件/对象 | 状态 |
|---|---|---|---|---|
| T1 | 源码阅读 | session 持久化路径、zstd 帧、flush/lock、`session/list` 过滤 | `session-persistence-jsonl`、`acp` | 完成 |
| T2 | 实测 | 同一 home 下启动 web，调 `session/list`，核对 ACP sessionId/cwd | web host、session-controller | 完成 |
| T3 | 实测 | 已初始化 home 下新建 ACP 空会话，区分「列表可见」与「workspace 采纳」 | workspace registry | 完成 |
| T4 | 对照 | 独立 home 与 `~/.dsh` 的隔离检查；ACP `session/list` 的反向可见性 | 文件系统、ACP | 完成 |
| T5 | 文档 | 汇总结果，回写 OQ-009/风险/导航 | docs | 完成 |

## 6. 边界

- 只做调研与只读检查，不改产品代码、不改 DSH 源码、不提交。
- 不向用户真实 `~/.dsh` 写入；web 只对临时 home 启动。
- 不把任何 `.credentials.yaml` 内容写入文档或日志；实验结束停止 web 进程。
- 不对 UI 做浏览器截图；「侧栏是否渲染」按 workspace 注册表的数据源推断，并明确标注推断与实测的边界。
