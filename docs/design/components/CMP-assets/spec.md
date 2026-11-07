---
layer: design
module: execution-plane
component: CMP-assets
status: active
updated: 2026-11-07
---

# CMP-assets 组件规格

> 状态：`active`（2026-11-08，T3 落地）。S0 本地目录来源的校验、原子替换、脚本权限与失败回滚已实现；HTTP 下载/缓存留 S1。
>
> 上游：`docs/design/architecture.md` §5、§8、§10；`SCN-0001` UC-04/06/25；`REQ-0002` R-05/R-10；决策 D9（同容器并发同集）。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L0 基础设施；技术边界（包格式、校验、文件替换）。
- **业务价值**：保证模型只看到当前节点的技能组合，且失败不留半套；没有它，「替换不是叠加」会散进 executor。
- **负责 X**：
  - 技能包获取（本地路径 / 调度器托管 HTTP，来源由 manifest 注入）；
  - 完整性校验（SHA-256）与安全解包（拒绝路径穿越/符号链接逃逸）；
  - 技能格式校验（顶层 bundle 或 flat `.md`，frontmatter `name`/`description`）；
  - 暂存 → 原子替换 → 回滚；
  - digest 幂等与容器级安装锁；
  - 脚本赋可执行位；
  - 技能缓存与失效。
- **不负责 Y**：
  - 选择技能集（调度器）；
  - 执行脚本、判断脚本结果（模型/DSH）；
  - 工作区布局校验（`CMP-workspace`）；
  - 调度器鉴权策略本身（只消费组合根注入的 `AuthProvider` / `SchedulerEndpoint`，见 §3.5）。
- **变化轴**：包格式、来源与校验方式。
- **删除测试**：删掉后「替换不是叠加」「失败不留半套」会散进 executor——真边界。

## 2. 内部功能

### 2.1 安装流程

1. **计算/确认 digest**：以 `SkillSet` 的 digest 为准；若同时给了包清单，校验 digest 与清单一致（不一致 → `checksum_mismatch`）。
2. **幂等短路**：`currentDigest(container) === digest` 且 `.dsh/skills` 存在 → `noop`，不替换。
3. **取容器锁**：`<container>/.dsh/.install.lock` 独占创建；已有锁且未超时 → `io_error`/忙等；超时视为陈旧锁，记录并接管。
4. **暂存**：`<container>/.dsh/.staging/<digest>/`；逐个包获取/解包/校验，全部成功后才进入替换。
5. **格式校验**：只接受顶层 `<name>/SKILL.md` 或 `<name>.md`；frontmatter 必须有 `name`（kebab-case）与 `description`；嵌套 `**/SKILL.md` 跳过/判非法（按包严格模式）。
6. **脚本赋权**：`<bundle>/scripts/**` 置 `0755`；其余文件 `0644`；不改变工作区其他文件。
7. **原子替换**：
   - 现有 `.dsh/skills` → `.dsh/.skills.previous`；
   - 暂存 `skills` → `.dsh/skills`；
   - 写 `.dsh/.skills-digest`；
   - 删除 `.skills.previous`；
   - 任一步失败 → 恢复 `.skills.previous`，清理暂存，返回错误。
8. **释放锁**；失败路径也必须释放。

### 2.2 包来源

```ts
type SkillPackageRef = {
  name: string;
  source: string;   // file:// 或 https://；S0 本地路径
  checksum: string; // sha256:<hex>
};
```

- 来源与鉴权由组合根注入；assets 不依赖 `CMP-gateway`。
- `C-05` 走调度器托管端点：`GET /api/v1/executor/skill-packages/{packageId}/download`；请求带 `Authorization` 与 `X-Client-Run-Id`，条件请求用 `If-None-Match`（304 视为缓存命中）。
- **跨 host 不带凭据**：只有 URL host 与 `SchedulerEndpoint.baseUrl` 相同才附 `Authorization`；外链必须短期签名且不带 client token。
- `packageId` 不可变：同 id 的内容不可替换；内容变更必须换 id。
- 大小上限取 `limits.maxSkillPackageBytes`（v1 默认 64 MiB）；超限 `download_failed`。
- 不把包内容写进日志；只记录 name/digest/大小。

### 2.3 安全解包

- 拒绝绝对路径、`..` 段、盘符、NUL；解包后再次校验目标在暂存目录内。
- 拒绝符号链接/硬链接指向暂存目录外；不跟随链接写入。
- 单包文件数/解压后总大小上限可配；超限 `unpack_failed`。
- 解包失败清理整个暂存目录，不触碰当前 `.dsh/skills`。

### 2.4 缓存

- 缓存目录：`<stateRoot>/cache/skills/<digest>/`（`stateRoot` 由组合根注入；不放在容器内）。
- 命中条件：digest + 校验和一致；命中后复制/硬链接到暂存区，仍需格式校验。
- 失效：digest 不再被引用时按保留策略清理；损坏缓存删除并重新获取。
- 缓存是派生状态，不是真相；容器内 `.dsh/skills` 才是当前生效集。

### 2.5 并发与冲突

- 同一容器同一时刻只允许一个安装临界区（锁文件 + 进程内 Mutex）。
- 同 digest 并发安装：后来者等待/短路 `noop`。
- 不同 digest 且存在活跃 session：由 `CMP-executor` 判 `asset_skill_set_conflict`；assets 不改写正在使用的技能集。
- 锁文件记录 `{pid, digest, startedAt}`；进程崩溃后由下一次安装或 `doctor` 清理陈旧锁。

## 3. 契约

### 3.1 实现 `AssetPort`

签名见 `CMP-executor` §3.4；本组件补充：

| 方法 | 语义 | 错误 |
|---|---|---|
| `install` | 幂等安装；原子替换；失败回滚 | `download_failed`、`checksum_mismatch`、`unpack_failed`、`invalid_skill_format`、`io_error` |
| `verify` | 校验包 checksum，不解包 | `checksum_mismatch` |
| `currentDigest` | 读 `.skills-digest`；不存在返回 `null` | `io_error` |

### 3.2 前置/后置/不变量

- 前置：`container` 来自 `CMP-workspace.ensureContainer`；`skillSet.digest` 非空；包清单可解析。
- 后置：成功时 `.dsh/skills` 与 digest 一致；失败时保持安装前状态；锁已释放。
- 不变量：
  1. 替换不是叠加：安装后只存在当前 skillSet 的技能。
  2. 原子生效：任何时刻 `.dsh/skills` 要么是旧集，要么是新集，不出现半套。
  3. 失败回滚：下载/校验/解包/替换任一失败，当前技能集不被破坏。
  4. 同 digest 重复安装为空操作。
  5. 脚本落地即可执行；权限不扩散到工作区其他文件。
  6. 不把包内容或凭据写入日志。

### 3.3 错误模式

| 错误 | 触发 | 可重试 | 调用方应对 |
|---|---|---|---|
| `download_failed` | 网络/文件读取/超限 | 是 | 节点失败（asset）；不 prompt |
| `checksum_mismatch` | 摘要不符 | 是（重新获取） | 节点失败；不 prompt |
| `unpack_failed` | 损坏包/路径穿越/超限 | 是（换包） | 节点失败；不 prompt |
| `invalid_skill_format` | 缺 frontmatter/嵌套/非法 name | 否 | 节点失败；不 prompt |
| `io_error` | 锁/rename/权限/磁盘 | 否（同机） | 节点失败；不 prompt |
| `asset_skill_set_conflict` | 同容器不同 digest 并发 | 否 | 显式失败；调度器换实例/重排 |

### 3.4 下载鉴权与共享值对象

```ts
// 定义在 CMP-executor 的 ports；组合根注入同一实例给 gateway 与 assets
interface AuthProvider {
  authorizationFor(url: string): Promise<string | null>;
}
```

- token 单一来源：组合根注入同一个 `AuthProvider` / `SchedulerEndpoint`；`CMP-assets` 只读这两个值类型，不 import `CMP-gateway`。
- 判断规则只有一条：同 `baseUrl` host 才带 `Authorization`；跨 host 一律不带，即使 manifest 给了 URL。
- TLS/超时配置与 gateway 共用 `SchedulerEndpoint`；S1 联调核对两套 HTTP 栈，避免“下载能连、上报不能连”（`AH-06`）。
- 凭据不进日志、不进错误 message、不写进容器。

### 3.5 `AssetAdmin`（L0 管理面）

```ts
interface AssetAdmin {
  diagnose(container?: ContainerPaths): Promise<CheckResult[]>;
  clearCache(digest?: string): Promise<void>;
}
```

- 由 `CMP-cli` 在 `doctor`/维护命令中调用；executor 不依赖。

## 4. 依赖与分层

- 依赖：`AssetPort` 类型、`CMP-observability`、标准库 `fs` / `path` / `crypto` / `fetch`。
- 禁止边：不得 import `CMP-cli`、`CMP-executor` 具体实现、`CMP-runtime`、`CMP-gateway`、`CMP-workspace` 具体实现；只可只读导入 `CMP-executor` ports 的 `AuthProvider`/`SchedulerEndpoint` 值类型；不得读 journal/store 业务数据。
- 组合根注入：缓存根、`AuthProvider` / `SchedulerEndpoint`、大小上限、日志器。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性/保留 |
|---|---|---|---|
| `.dsh/skills`（当前技能集） | `CMP-assets`（唯一写入口） | DSH/runtime、executor | 原子替换；失败保持旧集 |
| `.dsh/.staging` / `.skills.previous` | `CMP-assets` | 自身 | 临时；成功/失败后清理 |
| `.dsh/.skills-digest` | `CMP-assets` | executor、assets | 与 skills 同步 |
| 技能缓存 | `CMP-assets` | assets | 派生；可失效/清理 |

## 6. 冷热与资源

- 冷路径：下载/解压/替换；分钟级，可能大文件。
- 不阻塞心跳：大包解压/校验分片或异步，S0 实测；必要时 worker/流式。
- 独立暂存目录与缓存；不与 journal/日志共享锁。
- 大小上限与文件数上限防止磁盘/内存放大。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| 正常 | 首次安装、同 digest 重装、切换 A→B→A | 只看到当前集；幂等 |
| 失败 | 损坏包、checksum 不符、路径穿越、符号链接、缺 frontmatter | 回滚无半套；不触碰旧集 |
| 原子性 | 替换中断（注入 rename 失败） | 旧集完整；无 `.skills.previous` 残留 |
| 脚本 | `scripts/**` 权限、非 scripts 不变 | `0755` / `0644` |
| 并发 | 同容器并发安装、不同 digest 并发 | 锁串行；冲突显式失败 |
| 缓存 | 命中、损坏、清理 | 命中不重复下载；损坏重建 |
| 安全 | 包内含凭据/大文件/大量文件 | 不写日志；超限拒绝 |

## 8. 预算与单独运行

- 预算：目标 ≤30k token，上限 120k。
- 单独运行：`bun test tests/components/assets/`；用本地夹具包，不联网。
- 实现入口（T3）：`src/components/assets/assets.ts#LocalAssets`、`digest.ts#digestDirectory`、`format.ts#validateSkillsTree`、`copy.ts#copyTree`、`local-source.ts#resolveLocalSource`、`admin.ts#AssetAdmin`；测试 `tests/components/assets/`。
- 状态：`active`（S0 本地目录来源；HTTP 下载/缓存待 S1）。

## 9. 开放问题

- 技能包分发形态已冻结：调度器托管 `C-05` 下载端点，`packageId` 不可变，`limits.maxSkillPackageBytes` 限制大小；外链仅作已评估备选。
- 解压后文件数上限未定（M1 观测后补）；包大小上限已冻结。
- 解包实现是否引入依赖；若引入，按 P2 依赖审批。
- 缓存保留策略与磁盘上限（OQ-005）。
- 脚本权限是否只限 `scripts/`，还是按 shebang 识别（当前只限 `scripts/`）。
