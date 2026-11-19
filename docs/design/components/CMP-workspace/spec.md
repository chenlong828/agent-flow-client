---
layer: design
module: execution-plane
component: CMP-workspace
status: active
updated: 2026-11-18
---

# CMP-workspace 组件规格

> 状态：`active`（2026-11-08，T3 落地）。容器校验、路径约束、清理与诊断已实现；大目录清理分片与磁盘阈值留 S1。
>
> 上游：`docs/design/architecture.md` §2、§7、§8；`SCN-0001` UC-05/08/28/29；`REQ-0002` R-07/R-10；决策 D7/D8/D11。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L0 基础设施；技术边界（文件系统与路径约束）。
- **业务价值**：保证工作区单写、路径不越界、容器根即技能根；没有它，路径约束会散进 assets 与 runtime。
- **负责 X**：
  - 接收预置容器路径，校验布局（含 git 超项目根与子模块告警）；
  - 维护 `.dsh` 安装点与暂存目录；
  - 路径解析与容器内约束（拒绝越界、拒绝跟随越界符号链接）；
  - task-space（`taskSpacePath` 指定，当前为 `<workspace>/task-spaces/<日期-时间>`）校验/创建（只建目录）与 tar.gz 打包（v3）；
  - `<task-space>/inputs/` 的受控写入（`WorkspaceInputsPort`：建目录、state、原子写只读文件）；
  - 清理与保留策略；
  - 工作区诊断（`doctor`）。
- **不负责 Y**：
  - 仓库 clone/检出/初始化，以及任何 git 命令（`git submodule update`、`git commit` 等）；由准备阶段或节点内的人/模型在项目目录内完成；
  - 技能包内容与安装（`CMP-assets`）；
  - 仓库内容语义、产物解析；
  - session/进程管理。
- **变化轴**：容器布局校验（普通容器 / git 超项目）、清理策略、路径约束。
- **删除测试**：删掉后路径约束会散进 assets 与 runtime——真边界。

## 2. 内部功能

### 2.1 容器模型

```text
<containerRoot>/                 ← 容器根：技能根、session cwd
├── .git/ (.gitmodules)          ← 可选：git 超项目根；client 不执行任何 git 命令
├── .dsh/
│   ├── skills/                  ← 当前节点技能集（由 assets 原子替换）
│   └── .staging/                ← 技能暂存（client 生成，可清理）
├── repo-a/ (.git)               ← 预置仓库（client 不 clone/检出）
├── uumail/ (.git)               ← 子模块；未初始化只告警，不阻断
└── repo-b/ (.git)
```

- 容器由准备阶段预置；`NodeRequest.workspacePath` 指向容器根。
- 容器根有两种形态：
  - `layout=container`：根自身不是 git 仓库，下面有 0..N 个仓库/子目录；
  - `layout=superproject`：根是 git 超项目，有 `.git` 与 `.gitmodules`，用子模块指针固定多项目版本组合。
- 两种形态都必须满足 `findProjectRoot(容器根) === 容器根`：根不能位于别人的仓库内，否则 DSH 的 `projectRoot` 上浮，`.dsh/skills` 不可见。
- 子仓库/子模块可有 0..N 个，`.git` 可以是目录或文件（worktree、submodule 指针）。
- `.gitmodules` 列出的子模块若目录不存在、为空或缺 `.git`，`validate` 只产生 `warnings`，不阻断任务；由人或节点在项目目录内执行 `git submodule update --init`。
- client 不执行任何 git 命令（不 clone、不 submodule update、不 commit）；git 操作由人/节点在项目目录内完成。
- `.dsh` 必须是 root 内的真实目录，不能是符号链接或文件。
- `.dsh/skills` 由 `CMP-assets` 替换；workspace 只保证安装点存在且受路径约束。

### 2.2 `ensureContainer`

1. 路径必须是绝对路径、存在、是目录；否则 `not_prepared`。
2. `realpath` 解析；记录 root。
3. 检查可写（创建 `.dsh`/`.staging` 或 access W_OK）；失败 `permission_denied` / `disk_full`。
4. 先做只读布局校验：`findProjectRoot(root) === root`（根不在其它仓库内）、`.dsh` 不是符号链接/文件；根自身可以是 git 仓库或超项目。`layout=superproject` 且子模块未初始化时只记 `warnings`，不阻断。存在 `issues` 则**不创建任何目录**，返回 `layout_invalid`。
5. 创建 `<root>/.dsh` 与 `<root>/.dsh/.staging`（`0700`，幂等）。
6. 不创建 `.dsh/skills`、不创建仓库、不写仓库内容。
7. 返回 `ContainerPaths { root, skillRoot, stagingRoot }`。

### 2.3 `validate`

| 检查 | 失败码 |
|---|---|
| root 存在、目录、绝对路径 | `not_prepared` |
| root 不是文件、可读 | `layout_invalid` / `permission_denied` |
| `findProjectRoot(root) === root`（根不在其它仓库内） | `layout_invalid` |
| `layout=superproject` 时 `.gitmodules` 的子模块已初始化 | 仅 `warnings`（warn 不 block） |
| `.dsh` 不是符号链接/文件；`.dsh` 在 root 内 | `layout_invalid` / `path_escape` |
| 子仓库不越界；不跟随越界符号链接 | `path_escape` |
| 磁盘可写 | `disk_full` |

`LayoutReport` 返回 `ok`、`root`、`layout`（`superproject` / `container`）、`repos`（含 `.git` 的子目录）、`issues`、`warnings`。`ok` 只由 `issues` 决定，`warnings` 不影响 `ok`；`repos` 只用于诊断，不作为节点参数。

### 2.4 `resolve`

- `resolve(container, relPath, opts)`：`path.resolve(root, relPath)` → `realpath`（或对不存在的写目标解析父目录）→ 必须仍以 `root` 为前缀（按路径段比较，不做字符串前缀）。
- 拒绝 `..` 逃逸；拒绝符号链接指向容器外；允许进入子仓库。
- 越界返回 `path_escape`；不返回未经校验的路径。

### 2.5 `cleanup`

| 策略 | 行为 |
|---|---|
| `keep`（默认） | 不动容器；只清 client 临时文件（如有） |
| `clean-skills` | 删除 `.dsh/skills`、`.staging`、`.skills-digest`、`.skills-layout`；保留 `.dsh` 目录 |
| `clean-client` | 在 `clean-skills` 基础上清 client 生成的临时目录；不删预置仓库与产物 |

- 幂等；不跟随符号链接删除；不删除子仓库内容。
- 清理失败记录并继续；不因清理失败覆盖节点结果。
- 实例结束/取消时由 CLI/executor 按配置策略调用。

### 2.6 诊断

`WorkspaceAdmin.diagnose(container?)`：

- 容器布局（`layout=superproject` / `layout=container`）、`findProjectRoot`、`.dsh` 安装点、可写性；
- 未初始化/未跟踪的子模块告警（`workspace.submodules`，status=warn，不阻断）；
- 路径穿越负例；
- 磁盘可用空间（报告，不设硬阈值）；
- 清理残留（`.staging`、旧 `.skills.previous`）。

### 2.7 初始资料写入（`inputs` 子能力）

`FileWorkspace.inputs`（`TaskSpaceInputs`）负责 `<task-space>/inputs/<name>`，供 `CMP-executor` 在种子阶段调用：

- `ensureDir(taskSpacePath)`：task-space 必须已存在；`inputs/` 必须是普通目录（符号链接/文件 → `path_escape`），创建为 `0700`；删除上次中断残留的 `.<name>.<uuid>.part`。
- `stat(taskSpacePath, name)`：不存在返回 `null`；普通文件返回 `{ size }`；符号链接/目录/非法名 → `path_escape`。
- `write(taskSpacePath, name, bytes)`：先写同目录 `.<name>.<uuid>.part`（`0600`）→ `rename` → `chmod 0400`；失败清理临时文件；Windows 先删目标再改名。
- 名称二次校验：非空、非 `.`/`..`、不以点开头、无 `/`、`\`、NUL/控制字符、非绝对路径、`basename(name) === name`、≤255 字符。

## 3. 契约

### 3.1 实现 `WorkspacePort`

签名见 `CMP-executor` §3.4；本组件补充：

| 方法 | 语义 | 错误 |
|---|---|---|
| `ensureContainer` | 幂等；只建 `.dsh`/`.staging` | `not_prepared`、`permission_denied`、`disk_full` |
| `validate` | 纯检查；不修改文件系统 | `layout_invalid`、`path_escape` |
| `resolve` | 容器内路径解析 | `path_escape` |
| `cleanup` | 按策略清理；幂等 | 记录并返回 |
| `inputs` | `WorkspaceInputsPort`：`ensureDir`/`stat`/`write`；task-space 内受控写入，原子、只读 | `path_escape`、`not_prepared`、`permission_denied`、`disk_full` |

### 3.2 前置/后置/不变量

- 前置：`path` 是编排层下发的容器路径；`ContainerPaths` 来自 `ensureContainer`。
- 后置：`cleanup` 后不残留 client 生成的技能/暂存；预置仓库保持。
- 不变量：
  1. 工作区单写：client 只写 `.dsh` 下自己生成的内容，不改预置仓库。
  2. 容器根即技能根；session cwd 固定为 root。
  3. 所有路径限制在容器内；符号链接不得逃逸。
  4. `cleanup` 幂等；不删预置仓库。
  5. 不 clone、不检出、不建仓库、不执行任何 git 命令。
  6. `inputs/` 内的文件只由 client 写入；已存在的同名符号链接/目录一律拒绝，不跟随。

### 3.3 错误模式

| 错误 | 触发 | 可重试 | 调用方应对 |
|---|---|---|---|
| `not_prepared` | 路径不存在/不是目录 | 否 | 节点失败（workspace） |
| `layout_invalid` | projectRoot 上浮、`.dsh` 非法 | 否 | 节点失败（workspace） |
| `path_escape` | `..`/符号链接逃逸 | 否 | 拒绝访问；节点失败 |
| `permission_denied` | 不可写/不可读 | 否 | 节点失败（workspace） |
| `disk_full` | 写盘失败 | 否（同机） | 节点失败；调度器换实例 |

### 3.4 `WorkspaceAdmin`（L0 管理面）

```ts
interface WorkspaceAdmin {
  diagnose(target?: string | ContainerPaths): Promise<CheckResult[]>;
}
```

- 由 `CMP-cli` 在 `doctor` 时调用；`CMP-executor` 不依赖。
- `diagnose` 只读：不创建 `.dsh`，不修改容器；传字符串时按裸路径做布局检查。

## 4. 依赖与分层

- 依赖：`WorkspacePort` 类型、`CMP-observability`、标准库 `fs` / `path`。
- 禁止边：不得 import `CMP-cli`、`CMP-executor` 具体实现、`CMP-runtime`、`CMP-assets`、`CMP-gateway`；不得读写 journal/store。
- 组合根注入：容器路径、清理策略、日志器。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性/保留 |
|---|---|---|---|
| 容器根 + 子仓库工作树 + 产物 | 预置阶段 + 模型/工具（经 DSH） | runtime、assets、executor、observability | 本地强一致；按策略保留，默认不删 |
| `.dsh` 安装点 / `.staging` | `CMP-workspace` | assets、executor | 幂等创建；清理可回收 |
| `.dsh/skills` | `CMP-assets`（唯一写入口） | runtime/DSH | 原子替换；workspace 只提供路径 |
| `task-spaces/<日期-时间>`（task-space，路径由调度器下发） | `CMP-workspace` 只建目录；内容由节点内模型/工具写 | executor、CLI 归档 | 绝对路径且位于工作区内；清理策略不覆盖（v3 `C-12`） |

## 6. 冷热与资源

- 冷路径：容器校验、清理、诊断；分钟级，不参与心跳热路径。
- 文件系统操作可能阻塞事件循环；大目录扫描/清理分片/异步，避免阻塞心跳（S0 实测）。
- 每容器独立；fan-out 分支共享同一容器，不做复制。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| 布局 | 普通容器、根是 superproject（子模块已初始化/目录为空/缺 `.git`）、根 `.git` 为文件、根在外层仓库下、`.dsh` 为符号链接、路径含空格/Unicode | `validate` 的 `ok`/`layout`/`warnings` 与错误码 |
| 路径 | `..`、绝对路径、符号链接逃逸、子仓库内合法路径 | `path_escape` 与放行 |
| 清理 | `keep`/`clean-skills`/`clean-client`；重复调用 | 预置仓库保留；幂等 |
| 并发 | 同容器多 session；跨实例容器 | 互不干扰；共享容器只读/技能单写 |
| 磁盘 | 只读目录、磁盘满（注入） | 明确错误，不破坏已有产物 |
| 诊断 | superproject 显示 `layout`、未初始化子模块 warn、非法容器 fail、残留 staging | `doctor` 检查项与退出码 |

## 8. 预算与单独运行

- 预算：目标 ≤20k token，上限 120k。
- 单独运行：`bun test tests/components/workspace/`；用临时目录夹具，不启动 DSH。
- 实现入口（T3）：`src/components/workspace/workspace.ts#FileWorkspace`、`project-root.ts#findProjectRoot`、`superproject.ts#readLayout/submoduleWarnings`、`admin.ts#WorkspaceAdmin`；测试 `tests/components/workspace/`。
- 状态：`active`。

## 9. 开放问题

- 清理策略默认值与保留时长（OQ-005）。
- 大目录清理是否分片/后台化，需 S0 实测。
- 磁盘空间阈值与低空间行为（M1）。
- 是否在 `doctor` 增加 `.gitignore` 缺项提示（可选，本版未做）。

## 观测面 v1（2026-11-17）

- 新增只读 `WorkspaceFileReader`：`list` 一层目录、`read` 文本前 1 MiB；供 `O-09`/`O-10`。
- 路径只接受 run-scoped 相对 POSIX 路径；拒绝 `..`/`.`/空段/绝对路径/反斜杠/NUL/超长；符号链接读取拒绝，realpath 必须仍在根内。
- 二进制/非法 UTF-8 返回 `content=null,binary=true`；目录/符号链接当文件读返回 `unsupported_file`。
- 不写、不缓存、不做一致性快照；读操作异步，单请求不阻塞 poll/SSE。
- 验证：`tests/components/observer/files.test.ts`。
