---
layer: works
module: runtime
status: closed
updated: 2026-11-03
---

# 工序结果：ACP 会话记录与跨 profile 可见性调研

## 结论摘要

- **没有 ACP 专属日志**。ACP 的 `session/new` / `session/prompt` 产生的是普通 DSH session，写入 `$DSH_HOME/sessions/...`，与 desktop/web 共用同一套 session 持久化；`profiles/acp/` 下只有 profile 配置，没有会话数据。
- **一个 session 一个文件**：`$DSH_HOME/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd`。首个 zstd 帧是 header，之后每个追加批次一个帧；live 写入最多缓冲 200 ms，close/flush 时落盘；文件权限 `0600`、目录 `0700`。
- **隔离边界是 `DSH_HOME`，不是 profile 名**。共用 home 时，web 的 `session/list` 实测返回全部 ACP 会话；如果这个 home 的 workspace 注册表尚未初始化，web 启动还会把这些会话按 cwd 批量登记成 workspace。已初始化的 home 不会自动登记新 ACP 会话，但它们仍在同一个 session store 里，`session/list` 照样返回。
- **反向也成立**：ACP 的 `session/list` 读取同一 home 下全部普通会话，只排除 subagent、本进程活跃、无 cwd/非绝对 cwd 的会话，没有 profile 或归属过滤。共用 home 是双向暴露，不只是 ACP 污染 desktop/web。
- **建议**：一个 client/实例一个专用 `DSH_HOME`，在 spawn 时显式传入，绝不指向 `~/.dsh`；不要用 profile 名或 `session-` id 前缀当隔离边界。S0 一直使用的 `/tmp/dsh-s0/home-*` 就是这种隔离方式，所以当前 desktop profile 里没有 S0 的测试会话。

## 1. 记录机制

### 1.1 目录与文件

```
$DSH_HOME/
├── sessions/
│   └── --private-tmp-dsh-s0-ws-final2-s0-12--/
│       └── 6af9b888-7170-45cd-ae4d-f2785d5425b8/
│           ├── session.v4.jsonl.zstd     # header 帧 + 事件批次帧
│           └── session.lock               # flock 用的锁文件
├── storages/
│   ├── session_projcache/sessions/<sessionId>.json
│   └── workspace.json                     # web/desktop 的 workspace 注册表
└── profiles/
    ├── acp/                               # 只有 cordis.yml 等配置
    └── web/
```

- 路径由 `packages/session/session-persistence-jsonl/src/format.ts` 生成：
  - `projectKey(cwd)` 把 cwd 转成一个可读目录名：`/`、`\`、`:` 变成 `-`，非 `[A-Za-z0-9._-]` 的 code unit 变成 `~XXXX`，超长截断到 251 字符。例如 `/private/tmp/dsh-s0/ws-final2/s0 ws ü` → `--private-tmp-dsh-s0-ws-final2-s0~0020ws~0020~00FC--`。
  - `sessionDir(root, cwd, id)` 再拼上 `encodeSegment(id)`；同一个 cwd 的多个 session 共享 project 目录，各自有独立 session 目录。
  - 当前格式文件名为 `session.v4.jsonl.zstd`；压缩关闭时后缀是 `.jsonl`。
- 实测权限：session 目录 `drwx------`，日志文件 `-rw-------`（`0600`）。同一 OS 用户下的其他进程仍可读，这是「用户级隔离」而不是「应用级隔离」。

### 1.2 写入方式

- 首次产生持久写入时「物化」（materialize）：先写 header 帧，再把第一批事件写成单独的帧；通过临时文件 + `link()` 发布，避免覆盖已存在的日志。临时文件以 `0600` 创建并 `fsync`（`packages/session/session-persistence-jsonl/src/index.ts` 的 `writeSyncedTempFile` / 发布逻辑）。
- 后续追加是 `open(path, 'a')` + 写入一个 zstd 帧 + `fsync`；失败时回滚到追加前的文件长度（同文件 `appendLines` / `rollbackAppend`）。
- 这是 **concatenated zstd frames** 容器，不是单个 zstd 流：每批事件一帧，帧带 checksum；读取端先扫帧边界，再逐帧解码。`zstd -dc` 可以顺序解出全部内容，但只解第一帧的库会读不完整。
- 路由到持久化的 live 事件在内存中最多缓冲 `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200` ms，然后按批落盘；显式 `append`/`flush`/`close` 会走同一条串行链。进程崩溃最多丢掉最后一个未落盘的批次（≤200 ms 量级），并可能留下不完整的尾帧；下次写入前会扫描并截断/恢复尾部。
- 跨进程写互斥用 `session.lock` 上的 `flock(2)`（POSIX；Windows 用命名内核信号量）。锁由内核在进程死亡时释放，所以崩溃后锁文件还在，但不会永久阻塞后继写入；S0-11 观察到的「lock 保留 + 重启可用」就是这个机制。
- 没有看到按时间/大小的自动保留或清理逻辑；实例回收需要自己删除对应的 `DSH_HOME`。

### 1.3 记录内容

落盘的是 DSH 的语义 session 事件，不是 ACP 的原始 JSON-RPC 帧。实测一个多轮 session 包含：

- `system/message`（完整 system prompt）、`user/message`、`assistant/message`（文本 + reasoning 块）；
- `request/header`（模型、工具 schema、配置）、`request/context`；
- `tool/call`、`tool/result`（工具参数与输出）；
- `approval/asked`、`approval/decided`、`approval/policy`、`permission/preset`；
- `session/title`、`usage`、`turn/start|end`、`step/start|end`、`agent/inbox/spliced` 等控制事件；
- 首行 `type:"session"` header：`version`、`id`、`createdAt`、`cwd`、`isSeeded`、`delegationDepth` 等。

因此日志里会有完整对话、推理内容、工具读写内容和审批记录；压缩只是编码，不是加密。

### 1.4 多个 Session 如何组织

- ACP 一个进程可以同时/先后跑多个 session；每个 session 独立一个目录和日志文件，不合并成「ACP 日志」。
- 同一 cwd 的多个 session 落在同一个 project 目录下；不同 cwd 落在不同 project 目录。
- `session/new` 使用 `randomUUID()` 生成 id（`packages/acp/acp/src/index.ts`），是普通 UUID，没有 `session-` 前缀；desktop UI 创建的会话常见 `session-<uuid>`。这只是命名习惯，不是存储分区。
- `close` 会 drain 缓冲、flush 并释放写锁；`session/list` 按 `createdAt` 倒序返回。

### 1.5 除日志之外的相关产物

- `storages/session_projcache/sessions/<sessionId>.json`：每个 session 一份 projections 缓存（标题、token usage、context 压力等）。实测 37 个 session 日志对应 37 份缓存；web 的 session 列表会直接读它，所以 ACP 会话的标题和用量在 web 侧也可见。
- `storages/workspace.json`：web/desktop 的 workspace 注册表，记录 `path`、`title`、`sessionIds`、归档/置顶状态。ACP 自己不写它，但 web 启动时会读同一 home 的 session 列表并可能写入（见 3.1）。
- `profiles/<name>/`：只有 `cordis.yml`、`cordis.patch.yml`、`package.json` 等配置；切换 profile 不改变 session 存储位置。
- `logs/`：desktop 的启动日志在 `~/.dsh/logs/startup-*.log`；ACP 的临时 home 下没有 `logs/` 目录。ACP 的告警走 `ctx.logger`（stderr），DSH 不持久化 ACP 的原始协议流。需要协议级审计时，client 必须自己捕获 ACP 的 stdout/stderr。

## 2. 是否 ACP 专属

不是。可以从三个层面确认：

1. **存储层**：ACP 与 web/desktop 都通过 `sessionPersistence` 写同一个 `$DSH_HOME/sessions`；没有 `acp/` 子目录或 per-profile 数据库。
2. **列表层**：ACP 的 `listSessions` 直接调用 `persistence.list()`，只做「排除本进程活跃 session、排除 `origin === 'subagent'`、排除无 cwd/非绝对 cwd、可选的 cwd 过滤」；web 的 `session/list` 读同一个 session 查询 corpus。两边都没有 profile 过滤。
3. **进程层**：ACP 的 stderr 日志是运行诊断，不落 session store；ACP 进程退出后，会话仍留在 home 里，下次可 `session/list` / `session/resume`。

所以「ACP 的日志」实际上就是「这个 `DSH_HOME` 的普通 session 记录」。唯一和 ACP 相关的差异是 id 生成方式（plain UUID）和没有 `agentPreset` header 字段，二者都不是隔离机制。

## 3. 跨 profile 可见性实测

### 3.1 实验 A：全新 home，先有 ACP 会话，再启动 web

- home：`/tmp/dsh-s0/home-final2`，S0 最终 home，web 启动时含 35 个 ACP session 日志和对应的 projcache（实验 B 又加了 2 个空会话，最终 37 个）；web 启动前**没有** `storages/workspace.json`。
- 用同一 home 启动 web profile，然后带 cookie 调 `POST /api/session/list`：

  ```json
  {
    "type": "client-request",
    "rpcId": "r1",
    "method": "session/list",
    "payload": { "args": { "_request": {} } }
  }
  ```

- 返回的 items 包含全部 ACP 会话，例如：
  - `4c11d520-ecf4-439a-9583-02695ee8a79d`，cwd `/private/tmp/dsh-s0/ws-final2/s0-11`，标题 `Use the skill tool to`，带 tokenUsage；
  - `6af9b888-7170-45cd-ae4d-f2785d5425b8`，cwd `/private/tmp/dsh-s0/ws-final2/s0-12`。
- 同时 web 启动创建了 `storages/workspace.json`（9451 字节，`initialized: true`，23 个 workspace）。其中 `path=/private/tmp/dsh-s0/ws-final2/s0-11` 的记录 `sessionIds` 同时包含 `8e9fcaaa-...` 和 `4c11d520-...`。
- **含义**：在这个 home 第一次被 web/desktop 初始化时，workspace registry 的 bootstrap 会把所有未登记的 session 按真实 cwd 分组，创建 workspace 记录。也就是说，不仅 session 列表能看到，ACP 会话还会作为「工作区」进入 web/desktop 侧栏的数据源。

### 3.2 实验 B：已初始化 home，web 运行中新建 ACP 会话

在 workspace 注册表已经 `initialized: true` 之后，用 `probe/empty-session.mjs` 新建两个空 ACP 会话（只 `session/new` + `close`，不调用模型）：

- `494e6b22-1268-4c16-a69d-3ef1b88e1b66`，cwd `/tmp/dsh-s0-vis/acp-new`（全新的 cwd）；
- `8cdbef01-7e05-4554-8a60-b15cbfe0c47c`，cwd `/tmp/dsh-s0/ws-final2/s0-12`（已有 workspace 的 cwd）。

结果：

- web 的 `session/list` 返回 37 条，**两个新 session 都在**；说明数据层没有归属过滤。
- `workspace.json` 没有变化：没有为 `/private/tmp/dsh-s0-vis/acp-new` 新建 workspace；`s0-12` 那条 workspace 的 `sessionIds` 仍然只有原来的 `6af9b888-...`，没有加入 `8cdbef01-...`。
- **含义**：workspace bootstrap 只在注册表未初始化时跑一次；之后由别的 profile 创建的 session 不会被自动登记进 workspace。侧栏是否显示取决于 UI 是否另外按 cwd 查询 session，但「不进 workspace 注册表」不能当成隔离——`session/list` 已经能拿到，按 id 打开/恢复也没有归属校验。

### 3.3 实验 C：独立 home 与用户真实 home

- S0 的所有 ACP 会话都在 `/tmp/dsh-s0/home-*`；在 `~/.dsh/sessions`、`~/.dsh/storages` 中检索本文用到的测试 sessionId，均无命中。
- 用户当前的 desktop profile 使用 `~/.dsh`；因为 home 不同，它不会列出这些 ACP 会话。
- 反过来，如果 ACP 不显式设置 `DSH_HOME`，默认就是 `~/.dsh`，会直接与 desktop/web 共用同一个 store；这正是需要避免的部署方式。

### 3.4 可见性矩阵

| 条件 | web/desktop `session/list` | workspace 注册表 / 侧栏数据源 | ACP `session/list` | 磁盘 |
|---|---|---|---|---|
| 同一 home，workspace 首次初始化 | 返回全部 ACP 会话 | 启动时按 cwd 批量采纳，ACP 会话成为 workspace | 返回同 home 的全部普通会话 | 可读 |
| 同一 home，workspace 已初始化 | 返回全部 ACP 会话 | 不自动采纳新会话；已有 workspace 也不加 `sessionIds` | 同上 | 可读 |
| 不同 home | 不返回 | 不采纳 | 不返回 | 文件系统层面隔离 |

补充：`session/search` 在本次部署里被配置为关闭（`session-query index openAt "never"`，调用返回 `session search is disabled`），所以这次没有把搜索当入口验证；如果部署开启索引，它读取的是同一批 session，ACP 内容同样可被搜到。

## 4. 风险

| 风险 | 说明 |
|---|---|
| 跨 profile 暴露完整对话 | 共用 home 时，ACP 的系统提示、用户输入、assistant 推理、工具参数/输出、审批记录都可被 web/desktop 的列表和按 id 打开读取。 |
| 不是「ACP 污染桌面」的单向问题 | ACP 的 `session/list` 也会列出用户 desktop/web 的历史；client 若直接展示列表，会把用户私人会话暴露给远端/上层。 |
| profile 名不是边界 | session 不存放在 `profiles/` 下；换 profile、改 profile 名都不改变可见性。 |
| id 前缀不是边界 | ACP 用 plain UUID，desktop 常见 `session-<uuid>`；没有过滤逻辑依赖前缀，且其他 client 也可能用 plain UUID。 |
| workspace 首次初始化会「收养」ACP 会话 | 在一个全新 home 里先跑 ACP、再开 web/desktop，ACP 会话会被当成用户工作区出现；这是 UX 污染，也会扩大误打开面。 |
| 同 home 还混放其他状态 | `workspace.json`、`session_projcache`、`.credentials.yaml`（web 启动会写入 browser-session secret）都在 home 级；共享 home 不只共享对话。 |
| 静态数据无加密、无自动保留 | 日志是 `0600` 的压缩 JSONL，不是加密；没有看到 TTL/容量清理，长期运行会持续增长。 |
| 崩溃/回收 | 写锁由内核释放，但孤儿工具进程（S0-11）仍需 client 杀进程组；home 删除前要确保没有活跃写者。 |

## 5. 建议

1. **一个 client/实例一个专用 `DSH_HOME`**（例如 `/var/lib/agent-flow/instances/<id>/dsh-home`，或用户态 `~/.local/state/agent-flow/instances/<id>`），spawn ACP 时用环境变量显式传入；不要依赖默认 `~/.dsh`。
2. **不要把用户真实 `~/.dsh` 挂给 ACP**，也不要把多个 tenant/client 指向同一 home；home 是数据所有权边界，profile 不是。
3. **client 侧收紧列表语义**：除非产品明确要「查看本机全部会话」，否则不要直接把 `session/list` 的结果展示给上层；只展示本实例创建/记录的 sessionId，`session/resume` 也只接受自己记录过的 id。注意这只是产品约束，不是安全隔离。
4. **隔离要落到 OS/容器层**（需要强隔离时）：不同 OS 用户、容器或沙箱；同用户下的 API 过滤挡不住直接读文件。
5. **实例回收**：停进程组（含工具子进程）→ 删 home → 删凭据；不要把实例 home 跨租户复用。
6. **保留策略**：DSH 没有内置清理；client 需要按 TTL/容量做删除，并把「删除会话」与「删除 home」区分开。
7. **凭据**：不要把真实 `.credentials.yaml` 复制进实例 home；用每实例凭据或环境变量。web/desktop 与 ACP 共用 home 时，`.credentials.yaml` 会同时承载多类 secret。
8. **验证基线**：S0 的隔离方式（`DSH_HOME=/tmp/dsh-s0/home-*`）应保留为集成测试的默认做法；新增用例覆盖「共用 home 时 web 列表可见」这一负向断言。

## 6. 证据与复现

### 6.1 建一个空 ACP 会话（不调用模型）

```bash
node docs/works/2026-11-03-acp-session-records/probe/empty-session.mjs \
  /Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js \
  /tmp/dsh-s0/home-final2 \
  /tmp/dsh-s0-vis/acp-new
```

### 6.2 用同一 home 启动 web 并调列表

```bash
DSH_HOME=/tmp/dsh-s0/home-final2 \
  node /Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js \
  web --host 127.0.0.1 --port 0 --no-open
# 用启动输出里带 token 的 URL 换 cookie（token 不入文档）
curl -c /tmp/dsh-web.jar 'http://127.0.0.1:<port>/?token=<token>'
curl -b /tmp/dsh-web.jar -X POST 'http://127.0.0.1:<port>/api/session/list' \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"r1","method":"session/list","payload":{"args":{"_request":{}}}}'
```

### 6.3 检查 workspace 是否采纳

```bash
node -e "const w=require('/tmp/dsh-s0/home-final2/storages/workspace.json');
console.log(w.global.initialized, Object.keys(w.tables.workspaces).length);
for (const r of Object.values(w.tables.workspaces))
  if (r.path.includes('s0-11')) console.log(r.path, r.sessionIds)"
```

### 6.4 判断是否 ACP 专属

```bash
# profile 目录只有配置
find /tmp/dsh-s0/home-final2/profiles -maxdepth 2 -type f

# session 日志与 projcache 一一对应
find /tmp/dsh-s0/home-final2/sessions -name 'session.v4.jsonl.zstd' | wc -l
ls /tmp/dsh-s0/home-final2/storages/session_projcache/sessions | wc -l
```

### 6.5 关键源码位置

| 行为 | 位置 |
|---|---|
| ACP session id 生成 / 列表过滤 | `packages/acp/acp/src/index.ts`（`randomUUID()`、`listSessions`） |
| web session 列表 | `packages/api/session-controller/src/list.ts` |
| session 查询 corpus | `packages/session-query/session-query/src/corpus.ts` |
| 路径/转义/文件名 | `packages/session/session-persistence-jsonl/src/format.ts` |
| zstd 帧扫描/解码 | `packages/session/session-persistence-jsonl/src/zstd.ts` |
| 追加、物化、锁 | `packages/session/session-persistence-jsonl/src/index.ts`、`storage.ts`、`lease.ts` |
| workspace bootstrap | `packages/workspace/workspace/src/index.ts`（`initialized` 分支与 `bootstrap`） |

## 7. 结论落点

| 结论 | 落点 |
|---|---|
| 会话记录按 `DSH_HOME` 归属，不按 profile；共用 home 会被 web/desktop 列表读取 | `plan/open-questions.md` OQ-009 更新 |
| 共用 home 的跨 profile 暴露与 workspace 收养风险 | `plan/risks.md` 新增一行 |
| S0 验证继续使用专用 home | 现有 S0 harness 已如此，无需改代码 |
| 本工序证据与复现 | 本目录 `probe/` 与本文第 6 节 |

## 8. 局限

- 没有做浏览器截图；「侧栏是否渲染」是基于 workspace 注册表数据源的推断，已与「API 实测可见」区分。
- 没有启动 desktop Electron 应用；desktop 与 web 共用同一套 host/API 和持久化，本文的 web 实测加源码用于推断 desktop，未做端到端 GUI 验证。
- `session/search` 在本次部署被配置为关闭，未验证搜索入口；只在报告中标注条件。
- 结论基于 macOS + 当前 checkout HEAD `ce7073d512`；Windows 的锁实现不同（命名信号量），路径转义在 Windows 上还需单独验证。
- 空会话探针不触发模型，因此实验 B 不覆盖「有模型输出/工具调用时」的差异；记录内容分析来自 S0 的真实会话日志。
