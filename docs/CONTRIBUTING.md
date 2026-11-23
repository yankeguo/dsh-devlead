# 开发与贡献指南

本文件面向**在本仓库开发、构建、测试或发布 dsh-devlead 的人**（包括第一次接触代码的 agent）。
插件使用者请先读用户文档：[README.md（英文）](../README.md) · [README.zh.md（中文）](../README.zh.md)。
本页只是开发者入口；架构、发布、兼容性与 UI 验收以既有文档为准，不在这里重复全文：

- [DESIGN.md](DESIGN.md)：架构、持久记录、Service API、通知与消息通道（§2 包结构、§9 测试策略、§10 部署与验证）
- [PUBLISHING.md](PUBLISHING.md)：完整发布流程与故障恢复
- [COMPATIBILITY.md](COMPATIBILITY.md)：DSH 兼容矩阵、升级门禁、逐 rc 可执行 recipe
- [UI-VERIFICATION.md](UI-VERIFICATION.md)：浏览器视觉行为的隔离 profile 人工验收
- [OPTIONAL-DEPENDENCIES.md](OPTIONAL-DEPENDENCIES.md)：可选依赖审计
- [e2e-evidence/](e2e-evidence/)：E2E 原始日志与证据；[releases/](releases/)：逐版本 release notes
- [AGENTS.md](../AGENTS.md)：在本仓库工作的 agent 约定（门禁、发布纪律、UI 约定）

## 仓库结构

pnpm workspace（`packages/*`，根 `package.json` 为私有、不发布），下面 6 个可发布包版本锁步；
另有 1 个不属于 workspace 的私有测试包 `scripts/e2e-probe/`：

| 发布顺序 | 目录 | 包名 | 角色 |
| --- | --- | --- | --- |
| 1 | `protocol` | `@yankeguo/dsh-devlead-protocol` | 纯类型 + 常量 + 格式化（host 与浏览器共用），声明 `devLead`/`devLeadMode`/`devLeadWatch` projection 类型 |
| 2 | `client-ui` | `@yankeguo/dsh-client-ui-devlead` | 浏览器 UI：composer 工具条开关、只读 DevLeadBar、侧边栏标记、右侧栏只读项目看板 |
| 3 | `devlead` | `@yankeguo/dsh-devlead` | 核心 Service `ctx.devLead`：模式、Workspace/Session 编排、watch 索引、通知投递、projection fold |
| 4 | `command` | `@yankeguo/dsh-command-devlead` | `/devlead` 人类命令 |
| 5 | `tool` | `@yankeguo/dsh-tool-devlead` | 模型工具 `devlead_*` + 条件系统提示 |
| 6 | `bundle` | `@yankeguo/dsh-devlead-bundle` | 安装入口：`cordis.patch.yml` 装齐全部插件 |

依赖方向：`protocol ← devlead ← {tool, command}`；`client-ui` 只依赖 `protocol`（浏览器侧）；
`bundle` 依赖全部运行时包、最后发布。完整领域模型与 projection 契约见 [DESIGN.md](DESIGN.md)
§2（包结构）与 §3（持久状态）。

`pnpm build` 用 esbuild 产出 7 个 `lib/*.js`：protocol 的 `index`/`client`、devlead、tool、
command、client-ui 的 `index`/`client`；`bundle` 只有 `cordis.patch.yml` 与 icon，不产出 JS。
host 入口把 `@deepseek-ai/*`、`@yankeguo/*`、`node:*` 保持 external，整个进程共享同一份
protocol/core 实例；浏览器入口的 platform singletons 单一来源于 `scripts/client-externals.mjs`
（必须与 DSH shell 的模块表一致，构建期拒绝表外的 `@deepseek-ai/*` 导入）。

每个可发布包都带 DSH 插件管理器 / 插件市场的展示元数据：`locale/en.json` 与 `locale/zh.json`
里的 `{"meta":{"title":"…","description":"…"}}`，通过 `files: ["locale/*.json"]` 与
`"./locale/*.json"` export 接线，bundle 另保留 manifest `icon`。`pnpm check:packages` 校验
locale 文件、打包接线与文案（不得使用营销最高级词），新增可发布包必须补齐两个 locale 文件。

`scripts/` 各脚本职责：

| 脚本 | 职责 |
| --- | --- |
| `build.mjs` | esbuild 构建全部包到 `lib/`，并校验 bundle 目标 |
| `client-externals.mjs` | 浏览器 platform singletons 的唯一来源（构建与 check 共用） |
| `check-packages.mjs` | 包不变式：版本/engines 锁步、依赖与 peer 规则、`dsh.client.inject` 覆盖、路径别名、lockfile、CI pin、locale、license、`packageManager`，以及 README 发布契约（无 frontmatter、绝对链接、随包发布 README） |
| `install-profile.mjs` | 把构建产物链接进 DSH profile 并选中 bundle（`--uninstall` / `--dry-run`） |
| `dev-patch.mjs` | 生成绝对路径 dev overlay，并把本仓库注册为目标 profile 的 linked root |
| `e2e-smoke.mjs` | 本机真实 DSH 的多阶段 E2E |
| `stage-release.mjs` | 按依赖拓扑打包并 stage 6 个包（不发布任何内容） |
| `trusted-publishers.sh` | 一次性配置 npm trusted publisher（只允许 staged publishing） |
| `clean.mjs` | 删除全部 `lib/` 与生成的 overlay |
| `e2e-probe/` | 私有测试包 `@yankeguo/dsh-devlead-e2e-probe`（0.0.0），不发布，不进 workspace/build/check-packages |

## 开发环境

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 24.9 |
| pnpm | 12.16.1（仓库 `packageManager` 固定；用 `corepack enable` 获取） |
| 本地 E2E / 验收 | 已安装的 DSH：`dsh` 在 PATH，或用 `DSH_BIN` 指向 DSH CLI |

```sh
corepack enable
pnpm install
```

构建与单测不需要 DSH；只有 `pnpm e2e` 与 UI 验收需要一个已安装的 DSH 运行时。DSH 兼容范围与
升级门禁见 [COMPATIBILITY.md](COMPATIBILITY.md)。

## 常用命令与门禁矩阵

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | 全仓 TS 检查（strict + `exactOptionalPropertyTypes` + `noUnused*`） |
| `pnpm test` | vitest 单元测试 |
| `pnpm build` | esbuild 构建 7 个产物 |
| `pnpm check:packages` | 包不变式校验（见上节脚本表） |
| `pnpm verify` | typecheck + test + build，**最低门禁** |
| `pnpm e2e` | 本机真实 DSH 多阶段 E2E（CI 不含，见下节） |
| `pnpm dev:patch` | 生成 dev overlay 并注册 linked root |
| `pnpm release:dry` | `pnpm build` + `stage-release.mjs --dry-run`：本地打包 + npm 预检，不上传、不产生 stage id（默认 `latest`；prerelease 预检需显式 `--dist-tag next`） |

按改动范围加跑门禁：

| 改动 | 额外门禁 |
| --- | --- |
| 任意改动 | `pnpm verify` |
| 包边界、`exports`、`dsh.client.inject`、包元数据 | `pnpm check:packages` |
| Session、命令、projection、通知、浏览器加载路径、board 写路径/global | `pnpm e2e`（完整流 225/225；调试可用 `--no-worktree`，须说明跳过阶段 2 的理由） |
| 浏览器端视觉行为 | 自动化断言之外，按 [UI-VERIFICATION.md](UI-VERIFICATION.md) 在隔离 profile 人工验收 |

CI 的 [`verify.yml`](../.github/workflows/verify.yml) 在 PR 与 main push 上跑
`pnpm install --frozen-lockfile` → typecheck → test → build → `check:packages`；它不接触 registry。

## 从本地 checkout 安装（开发 / 验收）

```sh
pnpm install
pnpm build
pnpm install:profile                  # 默认 --profile desktop
node scripts/install-profile.mjs --profile desktop --dsh-home ~/.dsh   # 指定 profile / DSH home
```

`pnpm install:profile` 做四件事（`--dry-run` 只打印计划、不写任何文件）：

1. 把 6 个 workspace 包符号链接到 `$DSH_HOME/profiles/<profile>/node_modules/@yankeguo/`；
2. 把 `@yankeguo/dsh-devlead-bundle` 追加进 profile 的 `dsh.profile.bundles`；
3. 写入前备份 profile 的 `package.json`（仅内容变化时；重复执行是幂等的）；
4. 写入前校验每个包的 `exports`/`main` 产物与 bundle 的 patch/icon，失败时不做任何改动。

profile 里已由插件管理器安装的同名包保持不动，脚本只链接缺失的包并报告。这些符号链接同时让
DSH 把本仓库当作 **linked root**：插件导入的 `@deepseek-ai/*` 按 `peerDependencies` 解析到安装
实例，避免进程里出现第二份 DSH 运行时。装好后 profile HMR 实时加载 host 插件；浏览器侧刷新
Web 页面后出现 DevLead 界面。卸载：`pnpm uninstall:profile`（移除链接与 bundle 选择）。

### 开发 overlay（调试 / 手动验收）

绝对路径 overlay 不需要 profile 依赖安装，但需要一个**专用 dev profile** 作为 linked root 的
落点（默认 `web` profile 通常不存在；已启用本 bundle 的 profile 会因 loader row id 重复被拒绝）：

```sh
pnpm build

# 1. 一次性创建专用 dev profile（从随安装包提供的 web 模板复制）
dsh devlead --from-default-profile web --dump-config

# 2. 生成 overlay，并把本仓库注册为该 profile 的 linked root
pnpm dev:patch --profile devlead        # 可选 --dsh-home / --no-link

# 3. 用脚本打印的命令启动
dsh --profile devlead --patch .tmp/cordis.patch.yml --no-open --port 34000
```

`--no-link` 只生成 overlay 供检查，不能用于真实启动。撤销链接：删除
`<profile>/node_modules/devlead-repo`。

| 现象 | 处理 |
| --- | --- |
| overlay 下 `/devlead on` 报 `gateway/internal: Receiver must be an instance of class Session` | 缺 linked root（旧 overlay、手写 patch，或 profile 被换过）。重跑 `pnpm dev:patch --profile <dev>`，确认 `<profile>/node_modules/devlead-repo` 存在后重启；或用 `pnpm e2e` 跑正确流程 |
| `pnpm dev:patch` 报 profile not found / already enables bundle | 需要专用 dev profile：先 `dsh devlead --from-default-profile web --dump-config`；已启用本 bundle 的 profile 不能再插入同 id 的 loader row |

## E2E（本机真实 DSH）

```sh
pnpm e2e                        # 默认 patch 加载流，等价于上面的 dev overlay
pnpm e2e --flow installed       # install-profile 的包链接流
pnpm e2e --no-worktree          # 跳过阶段 2（实验 forge bundle 组合），调试用；可加 --no-build 复用已有 lib
```

两条加载流都用浏览器同款 HTTP API 驱动隔离实例：脚本在 `os.tmpdir()` 下创建一次性 `DSH_HOME`
与一次性 profile，结束时按 PID 关闭，期间不执行 pnpm install、不联网、不改 lockfile。子会话的
provider / 基础设施凭据按名称模式从环境清除，turn 稳定以 provider error 结束（真实 `turn/end`，
不消耗 token）。**阶段**（同一 scratch root/profile，实例按阶段启停、从不并存）：

- **阶段 1**：默认组合（`dsh-base` + `dsh-web-app`，无实验 bundle）验证 `/devlead` 命令注册、
  `devLead` projection 默认值、summary 级 `devLeadMode`/`devLeadWatch`、`/devlead on` 翻转投影、
  真实子会话关注、已关注会话 `turn/end` → 持久通知 → 投影可见，以及 `Worktree isolation: unavailable`
  证明可选能力缺席时插件照常工作。
- **阶段 1b**：同一 scratch home 重启，验证**冷 lead 索引重建**——冷 lead 投影仍从持久日志折叠、
  冷子会话被 resume、重启后的下一次 `turn/end` 产生新通知、`/devlead status` 与 `/devlead off`
  在 resume 后正常。
- **阶段 2**：向一次性 profile 追加官方实验 forge bundle，验证 worktree happy path：结果
  `status: 'worktree'` 且 `path`/`branch`/`baseCommit` 非空、`git worktree list` 与分支存在、
  `baseCommit` 等于 checkout `HEAD`、子会话有效 cwd 切到 worktree 而 header cwd 仍指向
  Workspace、Session 仍归属该 Workspace。
- **阶段 3**：真实 Host 上验证工具与关闭生命周期——模式开启时恰好 16 个主 `devlead_*`、关闭时
  为 0，`devlead:policy` 文案契约，archive/unarchive/`stop_running`，注销 Workspace 的 durable
  行为，模型目录与创建时的模型 / Agent Teams 设置，以及 watched child 的 `devlead_report` 与
  `ask_user_question` 转发。保留全部旧检查，另含 4 项 board 检查：真实
  `ctx.devLead.updateBoard` 两次写入且第二次使用 CAS、`webserver/index-inject` 发布的 board
  global，以及独立磁盘 read-back 的 revision/内容。
- **阶段 1e**：消息通道——progress/fyi background 不唤醒、blocked/decision 的 action steer、
  真实 completed/review steer、question+turn-end 合并抑制、16-pending action 上限与低基数指标。

每阶段总数已 pin（`scripts/e2e-smoke.mjs` 的 `EXPECTED_CHECKS`，删/增 check 未更新 pin 会失败），
PASS 与 SKIP 分开输出：

| 流 | pin | 阶段 |
| --- | --- | --- |
| `pnpm e2e`（patch，默认） | **225/225** | 1 + 1b + 2 + 3 + 1e |
| `pnpm e2e --flow installed` | **225/225** | 同上 |
| `pnpm e2e --no-worktree` | **202/202** | 1 + 1b + 3 + 1e（跳过阶段 2） |

阶段 pin 为 27 / 12 / 23 / **132** / 31。基线 DSH `0.2.2-rc.5` 的完整流目标计数是
**222 PASS + 3** 条无 provider 凭据的正向模型检查 SKIP；SKIP 未执行、不能算通过。原始日志与
证据在 [e2e-evidence/](e2e-evidence/)；逐 rc 升级门禁与可执行 recipe 见
[COMPATIBILITY.md](COMPATIBILITY.md)。probe 是 `scripts/e2e-probe/` 下的私有测试包，不发布；
profile 变更只发生在系统临时目录的一次性 profile 里。

## 测试布局摘要

5 个包各自的测试重点（完整清单见 [DESIGN.md](DESIGN.md) §9）：

- `protocol`：格式化 / excerpt 边界、转场表、持久记录词表、projection 类型契约等纯函数。
- `devlead`：严格 fold 与解码器、通知泵、冷 lead 索引重建、promptSession 自动 watch 补偿、
  Workspace/Session 编排、全局单活与消息路由（真实 `SessionStore`/`SessionProjectionRegistry`，
  外部服务用内存 fake）。
- `tool`：`when` 门控、参数校验、值渲染、错误翻译、execute 与取消信号转发、policy 文案契约。
- `command`：`/devlead` 语法解析、前缀寻址、状态渲染、冻结 fold 恢复、全部错误路径。
- `client-ui`：纯函数（格式化、准入状态机、样式 token、locale 完整性），以及
  `react-test-renderer` 组件渲染测试与跨实例 style tag 引用计数。

## 发布纪律摘要

发布分三段：CI **stage** → 维护者在 **npmjs.com 网页 approve**（登录 + 2FA）→ **手动创建
GitHub Release**。推 `v*` tag（或 `workflow_dispatch` 传入已存在的 `release_tag`）触发
[`publish.yml`](../.github/workflows/publish.yml)：先校验 tag 与根 `package.json` 及 6 个包的
`version` 一致，再 install/typecheck/test/build/check:packages，最后按依赖拓扑顺序用 GitHub
Actions OIDC 短时 token 执行 `npm stage publish`（无 `NPM_TOKEN`，公开仓库自动附 provenance）。
**stage 不公开任何包**；approve 只能由维护者在 npmjs.com 网页批量完成，approve 即公开且不可撤销。
6 个包全部公开后，用已存在的 tag 手动创建 Release：

```sh
gh release create v<version> --repo yankeguo/dsh-devlead --title v<version> \
  --notes-file docs/releases/v<version>.md --verify-tag --latest
# prerelease：--prerelease --latest=false
```

- 仓库**不再提供** `scripts/promote-release.mjs` / `pnpm release:promote`（approve 改为网页操作，
  Release 改手动；stage 辅助脚本只有 `stage-release.mjs` 与 `trusted-publishers.sh`）。
- tag 一旦推送**不移动、不删除、不重建**；`--verify-tag` 只接受已存在的 tag。修复后重新 stage
  用 `workflow_dispatch` 指向同一个 tag。
- **没有人类明确指示，不 push、不打 tag、不 stage/approve、不创建 GitHub Release。**
- 完整流程（一次性 trusted publisher 配置、版本升级、预检、部分失败恢复与故障排查）见
  [PUBLISHING.md](PUBLISHING.md)。
- 每次发版同步：中英 README 面向使用者的段落、`docs/releases/v<version>.md` 与
  `docs/e2e-evidence/` 下的实跑证据。

## 文档约定

- 用户文档只有两份：`README.md`（英文）与 `README.zh.md`（中文），**只面向插件使用者**；开发
  内容写入本文件与 `docs/`，不写回 README。
- 仓库内**所有 README 一律不得在顶部放 YAML frontmatter**。npmjs.com 不渲染 frontmatter，会把
  `---` 元数据块当正文显示在包页面上。DSH 内部文档规范里 bundle README 的 `description` /
  `kind: package-bundle` frontmatter 约定只适用于 DSH 内部 bundle，**不适用于发布到 npm 的
  第三方包**。
- 发布到 npm 的 package README 中，指向仓库文档 / 图片的链接必须用绝对 GitHub URL
  （`https://github.com/yankeguo/dsh-devlead/blob/main/...` 或
  `https://raw.githubusercontent.com/...`）：npmjs.com 不在仓库上下文里渲染 README。
- 以上 README 约定由 `pnpm check:packages` 强制（也检查每个可发布包的 `files` 含
  `README.md`，且 README 不出现已删除的 promote-release 字样）；违反时 CI 的 verify / publish
  都会失败。
- 版本变化与历史写入 `docs/releases/`，README 只给链接。
- `docs/` 用中文；架构、发布、兼容性分别落在已有文件里，不新开平行说明。行为变化同步 README
  中英的对应使用者段落。
- 根 README 之外的各包 README 随包发布，改动包行为时一并更新。

## 提交前检查清单

- [ ] `pnpm verify` 通过（typecheck + test + build）。
- [ ] 触及包边界、导出、`dsh.client.inject` 或包元数据：`pnpm check:packages` 通过。
- [ ] 触及 Session、命令、projection、通知、浏览器加载路径或 board 写路径/global：`pnpm e2e`
  两条流通过（完整流 225/225；只跑 `--no-worktree` 时说明 202/202 与跳过阶段 2 的理由）。
- [ ] 浏览器端视觉行为：按 [UI-VERIFICATION.md](UI-VERIFICATION.md) 在隔离 profile 人工验收并
  记录结论（`pnpm e2e` 的自动化断言不能替代）。
- [ ] 文档同步：README 中英面向使用者的段落、对应 docs、版本变化时的 `docs/releases/` 与证据。
- [ ] 未收到人类明确指示：没有 bump 版本、没有 push/tag、没有 stage/approve/发布。
- [ ] `git status --short` 只包含预期文件。
