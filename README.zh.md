# dsh-devlead

[English](README.md) · **简体中文**

一套面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：
把**一个普通会话**升级成 **DevLead 会话**，让它能直接操纵 DSH 的 **Workspace**（工作区）与
**Session**（会话），创建/续写其他会话、读取会话状态、在会话状态变化时被唤醒，从而在一个
人类可见、可参与的标准界面里统管多个仓库。

- **DevLead 会话 = 普通会话 + 一个持久开关**：打开后该会话额外获得 8 个 `devlead_*` 工具、
  一段 DevLead 系统提示，composer 上方出现状态条 UI；开关本身是**人类专属操作**，模型不能
  自行打开。未开启时界面里只有 composer 工具条上的一个小图标，不会在每个会话上显示常驻状态条。
- **产出物必须是标准 DSH 实体**：Workspace 真实注册进 `ctx.workspaceRegistry`，会话是真实的
  普通 Session（出现在侧边栏、可被人类打开、继续对话、归档），**不是 subagent**。这样人类
  始终能看见、介入、接管 Agent 的工作。
- **通知回路**：DevLead 监督若干子会话；子会话的 turn 结束（完成/失败/阻塞/取消等）时，Host
  把通知写入 DevLead 会话的持久日志；DevLead Agent 存活时以一条 `devlead` 来源的消息唤醒
  它，让它决定下一步（继续追问、派发新任务、向人类汇报）。

文档导航：[设计说明](docs/DESIGN.md) · [发布指南](docs/PUBLISHING.md) ·
[审计记录](docs/AUDIT.md) · [v0.1.1 release notes](docs/releases/v0.1.1.md) ·
[Bundle 说明](packages/bundle/README.md)

## 特性

| 能力 | 说明 |
| --- | --- |
| DevLead 模式 | 每个会话一个持久开关；开启后多出 `devlead_*` 工具、DevLead 系统提示与状态条 |
| 标准 DSH 实体 | 子会话是普通 Session（侧边栏可见、人类可打开接管），Workspace 走 `workspaceRegistry`，不是 subagent |
| 8 个模型工具 | 注册/列出 Workspace，创建/读取/续写/监督 Session，读取通知摘要（见[模型工具](#模型工具)） |
| 人类命令 | `/devlead`（状态）、`/devlead on|off`、`/devlead watch|unwatch <session>`；会话支持完整 id 或唯一前缀 |
| 通知回路 | 被监督会话的 `turn/end` 写入持久通知记录，按合并窗口唤醒 DevLead（可配置窗口与冷会话策略） |
| 事件溯源 | 模式/watch 集合/通知全部是可忽略的 `plugin:devlead/*` 记录，严格回放校验，可跨重启 / 恢复 / fork |
| Session projection | `devLead` projection（`{ enabled, sessions, notifications }`）把状态同步到浏览器，无需自定义 Remote API |
| 界面 | 未开启时只有 composer 工具条里的一个小图标（不显眼、无常驻条）；开启后 composer 上方出现 DevLeadBar：开关、监督会话数/运行中数、最近一条通知；界面只发 `/devlead on|off` 命令 |
| 权限模型 | 模式开关只能由人类命令/UI 触发；通知是运行时提示而非人类指令（见[权限模型](#权限模型)） |
| 一键安装 | bundle 的 `cordis.patch.yml` 插入全部 4 个运行时插件行，也可单独安装某个包 |

## 界面

UI 分两态，插件**不会**在每个会话上摆一条明显的常驻条：

- **未开启**：composer 工具条里（权限下拉旁，槽位 `conversation.input.left`）只有一个很小的
  用户图标按钮，悬停显示「开启 DevLead 模式」；点击即发送 `/devlead on`。会话里没有状态条。
  也可以用 `/devlead on` 命令打开。
- **已开启**：图标隐藏，composer 上方出现完整的 DevLeadBar（槽位
  `conversation.input.dock`）：模式开关（点击即 `/devlead off`）、监督会话数、运行中数、
  最近一条通知；没有通知时显示帮助提示。

未开启（只有工具条里的小图标）：

![未开启：composer 工具条里的 DevLead 图标](docs/screenshots/devlead-toggle-off.png)

已开启（完整状态条）：

![已开启：composer 上方的 DevLead 状态条](docs/screenshots/devlead-bar.png)

一次真实的多会话编排（DevLead 会话创建 `summary test` 子会话 → 子会话结束 → 通知带回
最后一条 assistant 摘要 → DevLead 继续汇报）：

![DevLead 会话示例](docs/screenshots/devlead-conversation.jpg)

| 状态 | 界面 | 交互 |
| --- | --- | --- |
| `devLead` projection 尚未加载 | 什么都不渲染 | — |
| 模式关闭 | composer 工具条里的小图标按钮 | 点击发送 `/devlead on`，随后从 projection 重渲染 |
| 模式开启，无监督会话 | DevLeadBar：开关 + 监督 0 个会话 + 帮助提示 | 拨动开关发送 `/devlead off` |
| 模式开启 | DevLeadBar：开关 + 监督 N 个会话 / 运行中 M，另附最近一条通知摘要 | 同上；命令执行中开关禁用 |
| 命令返回逻辑错误 | 开启时：状态条内联错误行；未开启时：图标 tooltip 显示错误文本 | 修正后重试 |

- 状态条与图标只读 `useProjection('devLead')` 与标准 Session 列表，**不新增 Remote API**；
  两者都调用注入的 `executeCommand('/devlead on'|'/devlead off')`，不会乐观翻转，一律以
  projection 为准。
- 浏览器侧只在 Web 端渲染；i18n namespace 为 `devlead`，提供 `zh` / `en` 词典。

## 与 subagent / agent-team 的区别

| 维度 | subagent / agent-team | 本插件（DevLead） |
| --- | --- | --- |
| 产物身份 | 派发方内部的子 Agent，通常不作为一个可独立打开的普通会话存在 | 真实注册的 Workspace + 普通 Session，出现在侧边栏，人类可打开、继续对话、归档 |
| 人机可见性 | 人类通常只看到最终汇总 | 人类全程可见，并可随时接管任意子会话 |
| 交互方式 | 模型在单个 turn 内调用工具派发、等待结果 | DevLead 会话本身是普通会话；模型用 `devlead_*` 跨 turn 编排，人类可以在同一界面介入 |
| 生命周期 | 随父 turn / 父 Agent 结束 | 子会话独立存在，可续写；`turn/end` 持久通知，可跨重启 |
| 唤醒机制 | 父 Agent 阻塞等待或 team 消息 | 被 watch 会话的 `turn/end` → 持久通知 → 合并窗口唤醒 DevLead（Agent 存活时） |
| 开关 | 无 | **人类专属** `/devlead on|off` 或界面开关（composer 工具条图标 / 状态条 Switch）；模型无工具可开启 |
| 适用场景 | 一次性并行子任务 | 跨仓库、长周期、需要人类持续参与和审查的統管工作 |

选择建议：只需要并行跑一次性子任务时用 subagent / agent-team；要让 Agent 长期负责多个仓库、
且人类希望随时看到并接管每一个子会话时，用 DevLead。

## 包结构

pnpm workspace，`packages/*`：

```
packages/
  protocol/    @yankeguo/dsh-devlead-protocol     纯类型 + 常量 + 格式化（host 与浏览器共用），devLead projection 类型
  devlead/     @yankeguo/dsh-devlead              核心服务：模式、Workspace/Session 编排、监督索引、通知投递、严格 fold
  tool/        @yankeguo/dsh-tool-devlead         8 个模型工具 + 条件 system prompt
  command/     @yankeguo/dsh-command-devlead      /devlead 人类命令
  client-ui/   @yankeguo/dsh-client-ui-devlead    浏览器 UI：工具条开关 + 开启后的 DevLeadBar 状态条
  bundle/      @yankeguo/dsh-devlead-bundle       bundle：cordis.patch.yml + 依赖
```

依赖方向：`protocol ← devlead ← {tool, command}`；`client-ui` 只依赖 `protocol`（浏览器侧）。
`pnpm build` 产出 7 个 `lib/*.js`：protocol 的 `index`/`client`、core、tool、command、
client-ui 的 `index`/`client`；`bundle` 只有 patch 文件与 icon，不产出 JS。构建用 esbuild：
host 入口把 `@deepseek-ai/*`、`@yankeguo/*` 与 `node:*` 保持为外部依赖——工作区包互相外置，
确保整个进程共享同一份 protocol/core 实例。浏览器入口的 platform singletons 单一来源于
`scripts/client-externals.mjs`（必须与 DSH shell 的模块表一致，构建期有守卫）。

`scripts/` 提供构建（`build.mjs`）、包不变式检查（`check-packages.mjs`）、profile 安装
（`install-profile.mjs`）、开发 overlay（`dev-patch.mjs`）与本地 E2E（`e2e-smoke.mjs`）。

## 快速开始

### 前置条件

| 项 | 要求 |
| --- | --- |
| DSH | `0.2.2-rc.1`（插件 / bundle 包声明 `engines.dsh: >=0.2.2-rc.1 <0.3.0`） |
| Node.js | ≥ 24.9（仅本地构建 / 发布需要；从 npm 安装插件不需要本机 Node） |
| pnpm | 12.x（CI 固定 `pnpm@12.16.1`） |
| Web UI | DSH 桌面端或 `dsh web`；DevLead 界面只在 Web 端渲染 |
| 本地 E2E | 已安装的 DSH 桌面端运行时（`dsh` 在 PATH，或设置 `DSH_BIN`）；`pnpm e2e` 用它启动隔离实例 |

### 安装：从 npm（发布后，推荐）

```sh
# 主 bundle：核心服务 + 模型工具 + 命令 + 状态条
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

也可以在 Web 的 **Plugins → Add plugin** 中输入 `@yankeguo/dsh-devlead-bundle` 安装。
安装后在 **Plugins** 页面确认 bundle 已启用（新安装的 bundle 通常默认启用；若显示为未启用，
勾选即可），然后刷新 Web 页面。进阶用法也可以单独安装某个包，并在 profile 的
`cordis.patch.yml` 里自行插入对应的 loader row；日常使用推荐直接装主 bundle。

### 安装：本地 checkout（开发 / 验收）

```sh
pnpm install
pnpm build
pnpm install:profile                  # 默认 --profile desktop
# 或指定 profile / DSH home
node scripts/install-profile.mjs --profile desktop --dsh-home ~/.dsh
```

脚本做四件事（`--dry-run` 只打印计划）：

1. 把全部 6 个 workspace 包符号链接到 `$DSH_HOME/profiles/<profile>/node_modules/@yankeguo/`；
2. 把 `@yankeguo/dsh-devlead-bundle` 追加进 profile 的 `dsh.profile.bundles`；
3. 写入前备份 profile 的 `package.json`（内容有变化时；重复执行是幂等的）；
4. 写入前先校验每个包的 `exports`/`main` 产物与 bundle 的 patch/icon，失败时不做任何改动；

这些符号链接同时让 DSH 把本仓库当作 **linked root**：插件导入的 `@deepseek-ai/*` 会按
`peerDependencies` 解析到安装实例，避免进程里出现第二份 DSH 运行时（见下文的开发 overlay）。
DSH 的 profile HMR 会实时加载 Host 插件；浏览器侧刷新页面后出现 DevLead 界面。
卸载：`pnpm uninstall:profile`。

不写 profile 依赖安装的调试路径（开发 / E2E）：绝对路径 overlay 需要一个**专用 dev profile**
作为 linked root 的落点（默认 `web` profile 通常不存在；已启用本 bundle 的 profile 会因
loader row id 重复而被拒绝）：

```sh
pnpm build

# 1. 一次性创建专用 dev profile（从随安装包提供的 web 模板复制）
dsh devlead --from-default-profile web --dump-config

# 2. 生成 overlay，并把本仓库注册为该 profile 的 linked root
pnpm dev:patch --profile devlead        # 可选 --dsh-home / --no-link

# 3. 用脚本打印的命令启动
dsh --profile devlead --patch .tmp/cordis.patch.yml --no-open --port 34000
```

为什么需要 linked root：绝对路径插入的插件如果没有 linked root，会从本仓库的 pnpm
`node_modules` 解析 `@deepseek-ai/*`，进程里出现第二份 DSH 运行时；第一次跨副本的私有类
检查（例如写 Session 插件记录）会以
`gateway/internal: Receiver must be an instance of class Session` 这样的错误炸出来。
linked root 让 DSH 把这些 `peerDependencies` 解析到安装实例（官方 `app-boot` 的 profile
resolution 机制）。`--no-link` 只生成 overlay 供检查，不能用于真实启动。撤销链接：删除
`<profile>/node_modules/devlead-repo`。

### 升级 / 卸载

```sh
# 升级到指定版本（发布到 npm 后）
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle@0.1.1

# 卸载（DSH 下次加载 profile 时会清理已移除 bundle 的选择）
dsh plugin --profile desktop remove @yankeguo/dsh-devlead-bundle

# 本地 checkout
pnpm install:profile                  # 先 pnpm build，再重新链接即生效
pnpm uninstall:profile                # 移除链接与 bundle 选择
```

升级 DSH 大版本（0.3）前需要更新插件 / bundle 的 `engines.dsh` 并回归；不兼容的 bundle 会被
DSH 跳过。

## 使用

### 打开 / 关闭模式

模式开关是**人类专属**的：在任意会话里执行命令，或点击界面上的开关——未开启时是 composer
工具条里的 DevLead 图标，已开启时是状态条上的 Switch。

```
/devlead on        # 打开当前会话的 DevLead 模式（需要 Agent live）
/devlead off       # 关闭；立即停止通知投递，已保留的通知记录仍在 Session 日志里
/devlead           # 查看状态：开关、监督会话（标题/状态）、最近通知、帮助
/devlead status    # 上一条的显式别名
```

### 命令

| 命令 | 作用 |
| --- | --- |
| `/devlead` | 状态：模式、监督会话（标题 / live / running / 最近 turn）、最近通知、帮助行 |
| `/devlead status` | 同 `/devlead` |
| `/devlead on` | 打开当前会话的 DevLead 模式 |
| `/devlead off` | 关闭当前会话的 DevLead 模式 |
| `/devlead watch <session>` | 监督某个会话（完整 id 或唯一前缀） |
| `/devlead unwatch <session>` | 取消监督 |

- 会话寻址支持**完整 id 或唯一 id 前缀**；前缀命中多个时返回友好错误并列出候选（带标题），
  请改用更长的前缀或完整 id。引用中不能有空格，成对引号会被剥掉一层。
- `watch` / `unwatch` 需要当前会话已开启 DevLead 模式；不能 watch 自己；监督集合有上限
  （默认 64，见[配置](#配置)）。
- 命令不接受 composer 附件；所有领域错误（`DEVLEAD_*` 稳定错误码）都会渲染成友好文本而不是
  抛异常。命令优先在会话列表（默认最多 200 行）与当前 watch 集合内寻址并列出候选；列表之外的
  会话会回退到 core 的 `getSession` 解析（完整 id 或唯一前缀均可）。

### 推荐工作流

1. 在准备統管多个仓库的那个会话里执行 `/devlead on`（或点 composer 工具条里的 DevLead 图标）。
2. 让模型注册工作区：`devlead_use_workspace` 传入仓库的**绝对路径**；`create` 默认 `true`，
   目录不存在时会 `mkdir -p`，重复注册是幂等的。
3. 让模型派发任务：`devlead_create_session`（可选 `workspace` / `title` / `preset`），并给一个
   **自包含的 prompt**——子会话看不到当前对话，所有必要事实都要在 prompt 里重述。新会话默认
   被 watch 并立即开始第一个 turn（空白 Session 在第一个 turn 前不会出现在侧边栏，所以
   "创建 + prompt"是常规用法）。
4. 子会话独立运行；人类可以随时在侧边栏打开它、继续对话或接管。
5. 子会话的 turn 结束（完成/失败/阻塞/取消等）后，DevLead 会话收到通知摘要并被唤醒；模型用
   `devlead_list_sessions` / `devlead_get_session` 查看状态，用 `devlead_prompt_session`
   继续追问或派发新任务，用 `devlead_notifications` 读取通知摘要。
6. 模型在结束 turn 前向人类汇报：创建/改动了哪些 Workspace 与 Session、每个子会话被要求做
   什么、最近一轮如何结束、有什么需要人类决策。

一个可直接使用的请求示例（人类对 DevLead 会话说）：

```
打开 DevLead 模式后：把 /Users/me/Workspace/src/api 和 /Users/me/Workspace/src/webapp
注册成工作区，各开一个子会话分别修 CI 失败和补 README；子会话结束后汇总结果，
失败的要继续追问，不要自己臆造成功。
```

### 模型工具

全部工具都带 `when: ({ agent }) => ctx.devLead.isEnabled(agent)`，只在 DevLead 会话中可见：

| 工具 | 参数 | 返回（canonical JSON） |
| --- | --- | --- |
| `devlead_list_workspaces` | `{}` | `{ workspaces }` |
| `devlead_use_workspace` | `path`（必填，绝对路径）、`title?`、`create?`（默认 true） | `{ workspace }` |
| `devlead_list_sessions` | `workspace?`、`watched_only?`、`limit?` | `{ sessions, watched }` |
| `devlead_create_session` | `workspace?`、`prompt?`、`title?`、`watch?`（默认 true）、`preset?` | 创建结果 |
| `devlead_get_session` | `session`（必填） | `{ session }` |
| `devlead_prompt_session` | `session`、`prompt`（必填）、`watch?`（默认 true） | 续写结果 |
| `devlead_watch_session` | `session`、`watching`（必填 bool） | watch 变更结果 |
| `devlead_notifications` | `limit?`（默认 20） | `{ notifications, watched }` |

工具把 core 的 `DevLeadError` 翻译成带稳定 code 的 `HarnessError`；阅读状态时请以
`lastTurn` / `lastTransition` / `lastError` / `lastAssistant` 等字段为准，不要靠猜。

## 通知机制

- **监督集合是持久状态**：`plugin:devlead/watch` 记录整值替换 watch 集合；只有被 watch 的
  会话才会产生通知。
- **通知的触发**：被监督会话每次 `turn/end`（完成 / 失败 / 阻塞 / 取消 / 超 token 等）都会
  在 DevLead 会话日志里追加一条 `plugin:devlead/notification` 记录，包含确定性 id、会话
  标题、turn 序号、转场类型，以及失败摘要或 turn 结束前最后一条 assistant 文本摘要
  （单行、最长 240 字符，写入通知的 `summary` 字段）。
- **保留条数**：projection 内按常量保留最近 64 条；更早的记录仍在 Session 日志里，
  `/devlead` 与状态条展示的是最近的若干条。
- **合并窗口**：通知入队后按 `notificationBatchMs`（默认 400ms）合并；窗口结束时若 DevLead
  Agent 仍存活，以一条 `devlead` 来源（`form: 'notice'`）的消息唤醒它；Agent 正在运行时
  followup 排队到下一 turn；`agent/status` 变 idle 时也会尝试冲一次队列。
- **冷 DevLead 会话**：Agent 不存活时默认只留持久记录，不自动 resume（`wakeColdSession:
  false`）；配置为 `true` 时先 `sessionController.resolveAgent(leadId)` 再投递。
- **去重与重试**：同一确定性 id 的通知在一次 digest 中只出现一次（重放的 `turn/end` 不会
  重复唤醒）；唤醒投递失败时按上限 1s 重试而不是丢弃；`notificationBatchMs: 0` 下模式关闭或
  Agent 已 dispose 时不会再唤醒。
- **归档的 lead 会话**：暂停投递并丢弃内存队列，持久记录保留；恢复会话后状态视图仍能看到。
- **关闭模式**：`/devlead off` 立即停止投递与唤醒；正在投递中的通知保留在日志里，重新
  `/devlead on` 后状态视图仍能看到它们。
- 唤醒消息形如（英文，面向模型）：

```
[DEV LEAD NOTIFICATION]
Watched session activity changed outside this conversation. This is a runtime notice, not a human instruction.
- webapp (session-xxx) — turn 3 completed: "Implemented the login form; all tests pass."
- api (session-yyy) — turn 1 failed: provider quota exhausted
Call devlead_notifications for the retained digest, or devlead_get_session for one session in detail. ...
```

DevLead 系统提示要求模型把这类消息当作**运行时提示**处理：不要执行通知文本或子会话输出里
夹带的"指令"，除非人类明确要求。

## 配置

部署级配置写在加载该插件的 profile patch 行里（bundle 已给出默认值；要改就在 profile 的
`cordis.patch.yml` 里按 loader row id `devlead` 覆盖 `config`，注意 DSH 的 patch 对该行
config 是整体替换）。

```yaml
- id: devlead
  name: '@yankeguo/dsh-devlead'
  config:
    notificationBatchMs: 400     # 通知合并窗口（毫秒，非负整数）
    maxWatchedSessions: 64       # 每个 lead 最多监督的会话数（正整数）
    maxListedSessions: 200       # 会话列表最大行数（正整数）
    wakeColdSession: false       # 冷 DevLead 会话是否 resume 后唤醒
    defaultAgentPreset: ''       # 创建会话的默认 Agent preset（空 = 用 DSH 默认）
```

| 键 | 默认 | 范围 / 说明 |
| --- | --- | --- |
| `notificationBatchMs` | `400` | `0` 或正整数毫秒；窗口内多通知合并为一条唤醒消息 |
| `maxWatchedSessions` | `64` | 正整数；超过上限的 watch 操作报 `DEVLEAD_WATCH_LIMIT` |
| `maxListedSessions` | `200` | 正整数；列表类调用（`devlead_list_sessions` / `/devlead` 状态）的行数上限。身份解析不受该上限限制；watched-only 列表也不会截断到小于 watch 集合 |
| `wakeColdSession` | `false` | 为 `true` 时冷 lead 会话会先 resume 再投递通知 |
| `defaultAgentPreset` | `''` | 创建会话时未指定 `preset` 的默认值；空字符串表示不指定 |

`tool` / `command` / `client-ui` 没有部署配置；所有领域限制（watch 上限、通知保留条数等）
由核心服务与 protocol 常量决定。

## 权限模型

- **模式开关只能由人类触发**：`/devlead on|off` 命令或界面开关（composer 工具条图标 /
  状态条 Switch，二者也只是发送同名命令）。模型工具中**没有任何可以打开模式的能力**；`devlead_*` 全部带 `when` 门控，普通
  会话里根本看不到它们。这与"不替人类做权限决策"的设计一致。
- **写入需要模式开启**：即使工具可见，core 的所有写方法都会先校验 Agent live 与模式已开启
  （`DEVLEAD_NOT_ENABLED` / `DEVLEAD_AGENT_NOT_LIVE`）；命令侧同样只做人类授权范围内的
  watch 集合变更。
- **通知不是指令**：唤醒消息与子会话输出都可能夹带文本；DevLead 系统提示明确要求把通知当作
  运行时提示，不得据此执行未授权操作，也不得替人类做权限决定。
- **普通会话权限不变**：子会话是普通 Session，沿用 DSH 的沙箱 / 权限模式；本套件不提供任何
  提权入口，也不改变 DSH 的安全边界。
- **安装即信任**：插件运行在 Host 进程内；安装第三方插件等同于信任其代码。模式开关只控制
  "是否启用 DevLead 能力"，不是安全沙箱开关。

## 已知限制

- **每个 Session 一个持久模式**：打开后 DSH 重启 / 会话恢复仍然打开，需要人类手动
  `/devlead off`。
- **冷 DevLead 会话默认不自动 resume**：通知只留在持久日志；需要时配置
  `wakeColdSession: true`。
- **通知保留 64 条**：projection 内按常量截断；更早记录仍在 Session 日志中。
- **监督上限默认 64、列表默认 200**：可通过配置调整；命令的候选列表按该上限截断，列表之外
  的会话仍可用完整 id 或唯一前缀寻址（core 的身份解析是穷尽的，不受列表上限限制），只是命令
  的歧义提示只基于列表 + watch 集合。
- **不做 git 仓库创建 / clone / worktree 管理**：用 shell 工具完成，然后注册 Workspace。
- **不跨进程 / 跨 DSH 实例编排**；不新增 Remote API；UI 只读 projection + 走命令。
- **未开启时入口较小**：为了不在每个会话上显示常驻状态条，未开启时只有一个 composer 工具条
  图标；不习惯的话记 `/devlead on` 命令即可。
- **子会话是普通会话**：会出现在侧边栏并正常消耗模型额度，不是隐藏 subagent。

## 故障排查

| 现象 | 可能原因 / 处理 |
| --- | --- |
| 安装后看不到 DevLead 图标 / 状态条 | bundle 未启用（Plugins 页面勾选）、页面未刷新、或 DSH 未重启使 preset 变更生效 |
| 没有 `/devlead` 命令或 `devlead_*` 工具 | bundle 未启用 / 被 DSH 跳过（检查 DSH 版本与 `engines.dsh`）；本地 checkout 需先 `pnpm build` |
| 本地安装脚本报 `run "pnpm build" first` | 先执行 `pnpm build` 再 `pnpm install:profile` |
| `/devlead on` 报 "no longer live" | 当前 Agent 已不是注册表中的 live 实例；从侧边栏重新打开会话后重试 |
| `/devlead watch` 报歧义 | 前缀命中多个会话；按错误里的候选改用更长前缀或完整 id |
| `/devlead watch` 报模式未开启 | 先 `/devlead on`；watch 集合变更需要模式开启 |
| 子会话 turn 结束但没有唤醒 DevLead | 模式已关闭、该会话未被 watch、DevLead Agent 不存活（冷会话默认只留记录），或通知还在合并窗口内 |
| DevLead 开关点了没反应 | 命令可能仍在执行（开关禁用）；开启失败时错误会显示在状态条内联行或图标 tooltip 里 |
| 状态条显示的数量与侧边栏不一致 | 状态条按 projection 的 watch 集合与标准 Session 列表计算；刚变更时可能有短暂延迟，刷新页面可重读 |
| 未开启时找不到开关 | 开关是 composer 工具条里的用户图标（权限下拉旁），悬停有「开启 DevLead 模式」提示；也可直接 `/devlead on` |
| 重启后 DevLead 状态仍在 | 预期行为：模式 / watch 集合 / 通知都是持久记录；不需要时 `/devlead off` |
| 开发 overlay 下 `/devlead on` 报 `gateway/internal: Receiver must be an instance of class Session` | overlay 缺少 linked root（旧版生成物、手写 patch，或 profile 被换过）。重新执行 `pnpm dev:patch --profile <dev>`，确认 `<profile>/node_modules/devlead-repo` 存在后重启；或用 `pnpm e2e` 复现正确流程 |
| `pnpm dev:patch` 报 profile not found / already enables bundle | 需要专用 dev profile：`dsh devlead --from-default-profile web --dump-config`；已启用本 bundle 的 profile 不能再插入同 id 的 loader row |
| 对已注册 Workspace 再传 `title` 不生效 | 预期行为：`title` 只用于新注册的 Workspace 记录；已存在的记录保留原标题 |

## 开发与验证

```sh
pnpm typecheck      # 全仓 TS 检查（strict + exactOptionalPropertyTypes + noUnused*）
pnpm test           # 单元测试（vitest）
pnpm build          # esbuild 产物（7 个 lib/*.js）
pnpm check:packages # 包不变式：版本 / engines.dsh / peer 规则 / 模块表 / 路径别名 / lockfile / CI pin
pnpm verify         # typecheck + test + build
pnpm e2e            # 本地 E2E：隔离 DSH_HOME + 真实 DSH Web + /devlead on/watch/通知/off
pnpm dev:patch      # 生成 overlay 并注册 linked root（见「安装：本地 checkout」）
```

`pnpm e2e` 默认走 `patch` 加载流（等价于上面的 dev overlay）；`pnpm e2e --flow installed`
走 `install-profile` 的包链接流。它只在本地运行（需要已安装的 DSH 运行时），CI 不包含；
两种加载流都用真实浏览器 HTTP API 驱动，并断言 `/devlead on`、投影翻转、真实子会话 watch、
被 watch 会话的 `turn/end` → 持久通知 → 投影可见、`/devlead off`。

测试布局（详见 [`docs/DESIGN.md`](docs/DESIGN.md) §9）：

- `protocol`：格式化 / 转场判定 / 共享类型等纯函数；
- `devlead`：严格 fold（模式 / watch / 通知 / 损坏记录 / 截断）、严格解码器（字段集 / 时间
  范围）、通知泵（合并窗口 / 去重 / 重试 / dispose / 冷会话）、Workspace 与 Session 编排
  （fake 服务）、列表排序与截断、身份解析（列表窗口外仍可寻址）；
- `tool`：`when` 门控、参数校验、值渲染、错误翻译、每个工具的 execute 转发与取消信号转发；
- `command`：`/devlead` 语法解析、会话前缀寻址（唯一 / 歧义 / 缺失）、状态渲染、全部错误路径；
- `client-ui`：格式化 / 命令结果提取 / 准入状态机 / 样式注入契约等纯函数。

本地端到端验收：`pnpm verify && pnpm e2e`。E2E 会启动一个隔离 DSH，走完
`/devlead on` → 真实子会话 watch → 子会话 turn 结束 → 通知进入 lead 投影 → `/devlead off`；
`--flow patch` 与 `--flow installed` 分别覆盖两条加载路径。

## 发布

包已推送到 npm 时可一条命令安装：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

PR / push 到 main 由 [`verify.yml`](.github/workflows/verify.yml) 跑
`pnpm install --frozen-lockfile` → typecheck → test → build → `check:packages`。

CI 发布采用 **npm Trusted Publishing（Keyless OIDC）**：推 `v*` tag 触发
[`.github/workflows/publish.yml`](.github/workflows/publish.yml)，由 GitHub Actions 的
`id-token: write` 换取 npm 短时 token，**不需要 `NPM_TOKEN` secret**，公开仓库下自动附带
provenance。CI 还会先校验 `v*` tag 与全部 6 个可发布包与根 `package.json` 的 `version`
完全一致，不一致直接失败，避免 tag 与 npm 版本错位。每个包需一次性配置 trusted publisher：

```sh
npm login
scripts/trusted-publishers.sh          # 批量配置全部 6 个包（--dry-run / --list 可选）
```

完整发版流程（版本升级、dry-run、本地/CI 发布、GitHub Release、故障处理）见
[`docs/PUBLISHING.md`](docs/PUBLISHING.md)。

## License

[MIT](LICENSE)
