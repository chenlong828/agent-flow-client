---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 评审：多技能包安装布局（P2）

> 对象：[`brief.md`](brief.md) 与 `TC-ASSET-001`～`004`。按 `arch-design-spec` 第 8 步四档裁决。
> 结论：**通过**（P2 合并前需用户最终确认）。

## 1 Blocker

无。附件包从「必然失败」变为可安装；多包从「静默覆盖」变为「各自归位或显式冲突」；旧集在失败时保持完整。

## 2 Decision now

| ID | 决定 | 选项与代价 | 已落 |
|---|---|---|---|
| `D-01` | 目录名取包内 frontmatter `name`（DSH 技能名） | 备选：`pkg.name`（展示名，实测为中文，不可作目录名/DSH 名）、`skillId`（UUID，不可读） | `skill-layout.ts#mergePackageRoot`；`TC-ASSET-001` |
| `D-02` | 重名技能**报错**，不覆盖 | 备选：后者覆盖 + 告警（仍会丢技能）。用户已确认报错 | 同上；`TC-ASSET-003` |
| `D-03` | 新增 `.dsh/.skills-layout = dir-v1` 参与幂等短路 | 代价：升级后首次任务多一次重装。收益：旧平铺容器不会因同 digest 永久停在旧布局 | `assets.ts#layoutCurrent`/`#swap`；`TC-ASSET-004` |
| `D-04` | 保留「包根无 `SKILL.md` → 按多技能树逐项并入」 | 供 S0 本地目录来源与既有测试沿用；编排侧包永远走单技能分支 | `mergePackageRoot`；既有 assets 测试全绿 |

## 3 Verified sound

| 区域 | 证据 |
|---|---|
| DSH 认目录形态且技能名取 frontmatter | 核对本机 Harness `dsh-skill-filesystem` 插件：目录 → `<dir>/SKILL.md`，`name` 取 frontmatter；`resourceBase` 指向技能目录 |
| 真实包落独立目录 | 用调度器上两张真实包（`basic-test`、`workflow-init`，zip 根仅 `SKILL.md`）执行 `install`：树为两个目录，`layout=dir-v1` |
| 附件包可安装 | `TC-ASSET-002`：`scripts/run.sh` 与 `references/notes.md` 落在技能目录内，脚本可执行位保留 |
| 冲突不破坏旧集 | `TC-ASSET-003`：同名两包 → `invalid_skill_format`，旧 `alpha` 目录与 digest 不变 |
| 旧布局迁移 | `TC-ASSET-004`：平铺 `SKILL.md` + 无布局标记 → 同 digest 重装为目录布局 |
| 兼容既有语义 | 替换不叠加、digest 幂等、签名/摘要校验、符号链接拒绝、回滚路径的既有测试全绿（`assets.test.ts`/`package.test.ts`） |
| 落盘路径安全 | 目录名经 kebab-case 正则校验，不可能出现 `..`/分隔符；包内路径仍走 `assertSafeZipEntries` |

## 4 Hold

| ID | 事项 | 为什么不阻塞 | 去向 |
|---|---|---|---|
| `H-01` | 编排侧 `OQ-33` 状态未在其仓库标记关闭 | 跨仓库文档由其维护；client 侧已给出结论与落点 | 由调度器侧工序收口时关闭 |
| `H-02` | 未跑真实 DSH 会话断言 catalog 同时含两个技能 | 布局是 DSH 的目录形态，loader 源码已核对，S0-02 历史实测过目录形态；真实 run 需要模型调用 | 下次真实 run 时确认 catalog |
| `H-03` | `.skills-digest` 与 `.skills-layout` 写入之间失败 → 标记缺失，下次重装 | fail-safe：不回滚已生效技能，最坏多装一次 | 保持现状 |
| `H-04` | 本机既存容器会在下一任务重装一次 | 预期迁移成本（每个容器一次） | 无需处理 |
