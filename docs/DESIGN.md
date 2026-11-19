# dsh-devlead 设计说明

一套面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：
把**一个普通会话**升级成 **DevLead 会话**，让它能直接操纵 DSH 的 **Workspace**（工作区）与
**Session**（会话），创建/续写其他会话、读取会话状态、在会话状态变化时被唤醒，从而在一个
人类可见、可参与的标准界面里统管多个仓库。

设计与实现的**唯一强信源**是官方 DeepSeek Harness 源码
（`/Users/guoyk/Workspace/src/deepseek-harness`，以及 npm 上 `0.2.2-rc.1` – `0.2.2-rc.5`
的已安装 `@deepseek-ai/*` 声明）。类型检查以 rc.1 devDependencies 为准（最旧支持面），
运行验证覆盖 rc.1–rc.5（见 §10）。任何第三方插件——包括早期参考过的
`dsh-infini-goal`——只算线索，不作为依据；每条 DSH API 行为都以官方源码或已安装的
`@deepseek-ai/*` 声明为准。

## 1. 产品定位

- **DevLead 会话 = 普通会话 + 一个持久开关**。打开开关后，该会话额外获得一组
  `devlead_*` 工具和一段系统提示，composer 上方出现 DevLead 状态条；开关本身是 composer
  工具条上的一个带 DevLead 文本的小图标按钮，两种状态都在，开启时才多出状态条（不显示常驻状态条）。
- **默认调度而非实现**：DevLead 会话先判定请求归属的 Workspace（依据已注册 Workspace 元数据
  与人类给出的目录，不靠翻别的仓库代码），只做**有界可行性判断**（归属、当前行为与目标结果的
  高层事实、验证方式），把自包含简报（允许带开放问题）派发给对应 Session；进一步细化调研与
  实现都属于被派发的 Session，lead 不读完整模块、不做完整复现/根因分析、不预先设计实现方案。
  即使目标是自己所在的 Workspace 也默认派发，除非人类在本对话中明确授权直接做（并在汇报中
  说明）。写入（改文件、构建、提交、推送、部署）属于对应 Workspace 的 Session；lead 自己仓库
  的记录类文件可依该仓库说明直接维护，但不构成实现授权。subagent / Agent Team 不能替代人类
  可打开接管的普通 Session，本会话也不为别人的请求拉起长周期目标或自治计划。
- **产出物必须是标准 DSH 实体**：Workspace 是真实注册进 `ctx.workspaceRegistry` 的工作区，
  会话是真实的普通 Session（出现在侧边栏、可被人类打开、继续对话、归档），**不是 subagent**。
  这样人类始终能看见、介入、接管 Agent 的工作。
- **通知回路**：DevLead 关注若干子会话；子会话的 turn 结束（完成/失败/取消）时，Host 把
  通知写入 DevLead 会话的持久日志，并在 DevLead Agent 存活时以一条 `devlead` 来源的消息
  唤醒它，让它决定下一步（继续追问、派发新任务、向人类汇报）。
- 开关本身是**人类专属操作**：命令 `/devlead on|off` 或 composer 工具条开关（两态都显示）；模型工具不能自行打开模式。

## 1.1 术语：watch / 关注

DevLead 的 watch 是 **lead 关注一个 Session 的单向关系**，不是权限、所有权或上下级角色：

| 英文 | 中文 | 含义 |
| --- | --- | --- |
| watch (verb) | 关注 | lead 把某个 Session 加入自己的关注关系，以接收其 turn 结束通知与中途报告 |
| watched / watched session | 已关注会话 | 被某个 active lead 关注的普通（非 DevLead）Session |
| watch set | 关注集合 | 一个 lead 当前关注的全部 Session |
| watch relationship | 关注关系 | lead → Session 的单向关系；不授予读写、所有权或任意操作权 |
| unwatch | 取消关注 | 从关注集合移除；立即停止该 Session 的通知/报告投递 |
| watcher / active lead that watches it | 关注该会话的 active lead | 当前唯一 enabled、且 watch 了目标 Session 的 lead |

- 不再用「监督」表示关注关系；历史 release notes（v0.1.0 / v0.2.4）保留原文作为已发布
  快照，v0.2.6 起的新文案统一使用「关注」。
- 内部代码标识 `supervisorOf` / `isSupervised` / `DEVLEAD_NOT_SUPERVISED` 是既有 API 与错误码，
  不改名；错误文案已经用 “not watched by the unique active DevLead” 表达同一含义。
- watch 不是权限授予：lead 仍只能通过既有工具创建/续写/归档 Session；不能因此读写子 Session
  的文件或绕过 Workspace/Session 权限。模型 policy 与 `devlead_watch_session` 描述显式写出
  这一句。

## 2. 包结构

pnpm workspace，`packages/*`：

| 目录 | 包名 | 角色 |
| --- | --- | --- |
| `protocol` | `@yankeguo/dsh-devlead-protocol` | 纯类型 + 常量 + 格式化（host 与浏览器共用），并声明 `devLead` / `devLeadMode` / `devLeadWatch` projection 的类型 |
| `devlead` | `@yankeguo/dsh-devlead` | 核心 Service `ctx.devLead`：模式状态、Workspace/Session 编排、关注关系索引、通知投递、`devLead` 与两个 summary 级 projection（`devLeadMode` / `devLeadWatch`）的 fold |
| `tool` | `@yankeguo/dsh-tool-devlead` | 模型工具 `devlead_*` + 条件系统提示 |
| `command` | `@yankeguo/dsh-command-devlead` | 人类命令 `/devlead` |
| `client-ui` | `@yankeguo/dsh-client-ui-devlead` | 浏览器 UI：两态都显示的图标 + 文本工具条开关 + 开启后的只读 DevLead 状态条 + 侧边栏会话行标记 |
| `bundle` | `@yankeguo/dsh-devlead-bundle` | bundle：`cordis.patch.yml` 插入全部插件 |

依赖方向：`protocol ← devlead ← {tool, command}`；`client-ui` 只依赖 `protocol`（浏览器侧）。
构建时 host 入口 external `@deepseek-ai/*`、`@yankeguo/*`、`node:*`；浏览器入口只 external
DSH shell 的 platform singletons（单一来源 `scripts/client-externals.mjs`）。构建期守卫会
拒绝任何不在 module table 里的 `@deepseek-ai/*` 浏览器导入（第三方纯库会按需内联，
platform singleton 不能内联）。除构建外，`scripts/` 还提供 `check-packages.mjs`（包不变式）、
`install-profile.mjs`（profile 安装）、`dev-patch.mjs`（开发 overlay + linked root）、
`e2e-smoke.mjs`（本地 E2E）。

**运行时单实例（linked root）**：绝对路径插入的插件若没有 linked root，会从本仓库自己的
pnpm `node_modules` 解析 `@deepseek-ai/*`，在同一进程里产生第二份 DSH 运行时；跨副本的私有
类检查（例如写 Session 插件记录）会抛
`gateway/internal: Receiver must be an instance of class Session`。DSH `app-boot` 的 profile
resolution 把「profile `node_modules` 下指向 profiles 树之外的符号链接」视为 linked root，
对链接目标下的导入方按 `peerDependencies` 把每个 `@deepseek-ai/*` 名字解析到安装实例。
因此：

- `install-profile.mjs` 的包符号链接本身即 linked roots；
- `dev-patch.mjs` 必须给目标 profile 写 `<profile>/node_modules/devlead-repo -> 本仓库`，
  否则生成的 overlay 是半坏的（见 §10）。

## 3. 持久状态（Session log）

第三方插件无法扩充 DSH 的 `SessionEventMap` 词表（仓库内生成），因此所有持久状态都写
**可忽略的插件记录** `appendPluginRecord(session, type, payload)`，类型名必须以 `plugin:` 开头。
DSH 的所有读取路径会保留并重放这些记录，但不会把它们投射到模型可见的对话面。

| 记录类型 | payload | 语义 |
| --- | --- | --- |
| `plugin:devlead/mode` | `DevLeadModeRecord` | 整个开关状态（`{ kind, version:1, enabled, at }`） |
| `plugin:devlead/watch` | `DevLeadWatchRecord` | **完整**关注集合（`{ sessions: string[] }`，whole-value 替换） |
| `plugin:devlead/notification` | `DevLeadNotificationRecord` | 追加一条通知（`{ notification }`） |
| `plugin:devlead/report` | `DevLeadReportRecord` | 追加一条已关注会话的中途汇报（`{ report }`） |
| `plugin:devlead/reset` | `DevLeadResetRecord` | 丢弃该会话**更早**的全部 DevLead 记录，三个 projection 回到空状态（`{ kind, version:1, at }`；见下） |

- 记录 payload 必须 JSON-safe、带 `kind` + `version`；fold 对未知 `kind`/`version` **以及
  多余/缺失字段**一律拒绝（严格字段集解码，见 `domain.ts`）。持久插件记录是折叠的唯一信任
  边界：手工编辑 / 迁移后的日志必须让 replay 失败（`failure`），而不是被静默丢弃或强制转换。
- **`reset` 是唯一在冻结检查之前应用的记录**：合法 reset 让三个 projection（`devLead`、
  `devLeadMode`、`devLeadWatch`）都从 `init` 重新开始（`enabled:false`、空关注集合、空 digest、`failure:null`），
  因此一条先前损坏的 `plugin:devlead/*` 记录不再永久锁死该会话。reset 自身也做同样严格的
  字段集解码：**坏 reset 不能解冻任何状态**（否则一条损坏的 marker 就能丢弃可修复的状态），
  冻结状态保持冻结。reset 由人类命令 `/devlead reset`（以及 `/devlead off` 在折叠冻结时的
  恢复路径）写入，模型工具永远不会写它；旧版本的 fold 会把该类型当作未知插件记录忽略
  （不崩溃，但无法执行恢复）。投影刷新后旧通知记录仍留在日志里，只是不再进入 fold。
- 时间戳必须是非负安全整数且落在 `Date` 可表示范围内（≤ 8.64e15），turn 必须是正安全整数；
  否则 `formatInstant` 之类的渲染会在 UI 侧抛 `RangeError`。
- notification 的 `id` 必须等于 `notificationId(sessionId, turn, transition)`；`sessionTitle` /
  `error` / `summary` 必须是 ≤240 码点的非空字符串；一条 projection 最多保留 64 条通知。这些
  不变量同时由 decoder、state schema 与 wire schema 守卫。
- report 的 `id` 必须等于 `devLeadReportId(senderSessionId, turn, kind, message)`；`kind` 是
  `progress|blocked|decision|question|fyi`；`message` 1–4000 码点，`summary` 1–200 码点，sender/lead id
  非空；`turn` 允许 0（命令调用常发生在首个 turn 之前）。最多保留 64 条 report，按 `id` 去重。
- 新类型 `plugin:devlead/report` 对旧版本是未知插件记录：旧 fold 忽略、不冻结，因此回滚不会
  因新记录损坏日志；旧版本也读不到 report（预期降级）。`devLead` projection 的
  `stateVersion` 从 1 升到 2（state 新增 `reports`），旧 projection-cache 行会失效并从 durable
  log 重新 fold；`devLeadMode` 未变，保持 1。
- 每次变更都是**先追加日志，后发通知**。
- 通知条数在 projection 里按常量 `DEVLEAD_DEFAULT_NOTIFICATION_RETENTION`（64）截断：
  fold 必须是**纯函数**，不能依赖部署 config，否则重放会分叉。

### `devLead` Session projection

- key：`devLead`（常量 `DEVLEAD_PROJECTION_KEY`），wire 值
  `DevLeadProjection = { enabled, sessions, notifications, reports }`。
- Host 侧 fold state 额外带 `failure: string | null`（首条损坏记录），wire 不带；只有
  `failure` 变化时复用上一次 wire view 对象，让 registry 的 `Object.is` 比较抑制无意义推送。
- projection 标记为 `SessionProjectionSummaryExcluded` 且 unit 声明 `wire.summary: false`：
  保留的通知摘要（≤64 条）与中途汇报（≤64 条）只服务打开中的会话，不进入 Session 列表 /
  summary payload。
- 浏览器通过 `useProjection('devLead')` 读取；无需自定义 Remote API（第三方插件无法走 Typert
  生成管线）。

### `devLeadMode` Session projection（summary 级）

- key：`devLeadMode`（`DEVLEAD_MODE_PROJECTION_KEY`），wire 值 `DevLeadModeProjection =
  { enabled: boolean }`，**不**标记 `SessionProjectionSummaryExcluded`、unit 不声明
  `wire.summary: false`，因此每个 Session summary / 列表行都携带它。
- 为什么需要第二个 unit：侧边栏每一行都要判断该会话是否开启 DevLead，而 `devLead` 因通知
  摘要被排除出 summary；把 `enabled` 放进 summary 的唯一干净路径是一个 summary 级小 unit。
  fold 与 `devLead` 同为严格解码：mode/watch/notification 记录都解码，首条损坏记录冻结
  （host 侧只留 `{ enabled, failure }`，不保留 watch/通知数据）；wire view 是两个共享常量对象，
  保证 registry 的 `Object.is` 比较只在 `enabled` 真正变化时推送。
- 更新路径：live 会话走 control baseline / projection frame；cold 会话走 Session 列表的
  cached block（`summaryKeys()` 天然包含本 key，由 projection cache 的 checkpoint 行恢复）。
  页面刷新 / Host 重启后由投影缓存行恢复。升级前已处于开启状态的会话在 cache 出现本 key
  之前不会显示标记（打开该会话一次，或再做一次开/关即可回填）。

### `devLeadWatch` Session projection（summary 级）

- key：`devLeadWatch`（`DEVLEAD_WATCH_PROJECTION_KEY`），wire 值 `DevLeadWatchProjection =
  { sessions: string[] }`，同样不声明 `wire.summary: false`，每个 Session summary 都携带。
- 为什么需要第三个 unit：watch 关系记录在 **lead** 的日志里，而不在 watched Session 的日志里；
  侧边栏行标记只有每一行的 summary，不能写被关注会话的日志，也不能依赖被排除的 `devLead` digest。
  把 lead 的完整 watch 集合做成 summary 级小 unit 后，任何一行都可以从当前 enabled lead 的
  `devLeadWatch.sessions` 判断自己是否被关注；对 cold 行、列表分页和重启后的 cache 行都成立。
  搜索态使用另一套搜索结果行（不挂载 `sidebar.session.row.trailing`），因此搜索时不显示行
  标记；清空搜索回到普通列表后恢复。
- fold 与 `devLead` 同样严格解码 mode/watch/notification/report 记录，首条损坏记录冻结；
  reset 清空。wire view 返回 state 自己的 `sessions` 数组，未变化时复用。
- 更新路径与 `devLeadMode` 相同：live 会话走 projection frame，cold 会话走 cached summary；
  watch/unwatch/off/reset 都从 lead 自己的 durable 记录自动 fold，客户端不需要轮询或额外 Remote。
- 单活约束保证最多一个 enabled lead；客户端在多个历史 enabled 摘要中按“任一 enabled 且包含本行”
  处理，服务端仍负责恢复时消除重复。

## 4. 核心 Service `ctx.devLead`

```ts
export class DevLeadService extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections']
  static Config = z.object({
    notificationBatchMs: z.number().step(1).min(0).max(2_147_483_647).default(400), // 通知合并窗口（Node timer 上限）
    maxWatchedSessions: z.number().step(1).min(1).default(64),
    maxListedSessions: z.number().step(1).min(1).default(200),
    wakeColdSession: z.boolean().default(true),                  // 冷 lead 是否 resume 投递（默认 true，见 §4.1）
    defaultAgentPreset: z.string().default(''),                  // 创建会话的默认 preset
  })

  // 模式（仅人类路径调用：命令 / UI 开关）
  isEnabled(agent: Agent): boolean
  setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>
  reset(agent: Agent, signal?: AbortSignal): Promise<void>              // 丢弃损坏状态的人类恢复路径
  view(agent: Agent): DevLeadProjection            // 读本会话 projection 的 wire 值

  // Workspace
  listWorkspaces(signal?: AbortSignal): Promise<DevLeadWorkspaceView[]>
  useWorkspace(agent: Agent, request: DevLeadUseWorkspaceRequest, signal?: AbortSignal): Promise<DevLeadWorkspaceView>
  removeWorkspace(agent: Agent, workspace: string, signal?: AbortSignal): Promise<DevLeadRemovedWorkspace>

  // Session
  listSessions(agent: Agent, options?: { workspace?: string; watchedOnly?: boolean; limit?: number; signal?: AbortSignal }): Promise<DevLeadSessionView[]>
  listModels(agent: Agent, signal?: AbortSignal): Promise<DevLeadModelCatalog>
  listAgentPresets(agent: Agent, signal?: AbortSignal): Promise<DevLeadAgentPresetCatalog>
  getSession(agent: Agent, sessionId: string, signal?: AbortSignal): Promise<DevLeadSessionView>
  createSession(agent: Agent, request: DevLeadCreateSessionRequest, signal?: AbortSignal): Promise<DevLeadCreatedSession>
  promptSession(agent: Agent, sessionId: string, prompt: string, options?: DevLeadPromptSessionOptions): Promise<DevLeadPromptedSession>
  watchSession(agent: Agent, sessionId: string, watching: boolean, signal?: AbortSignal): Promise<DevLeadWatchMutation>
  archiveSession(agent: Agent, sessionId: string, options?: DevLeadArchiveSessionOptions): Promise<DevLeadArchivedSession>
  unarchiveSession(agent: Agent, sessionId: string, signal?: AbortSignal): Promise<DevLeadUnarchivedSession>

  // 通知
  notifications(agent: Agent, options?: { limit?: number }): DevLeadNotification[]

  // 可选能力（不是 inject；只做只读探测，见 §4.3）
  get worktreeIsolationAvailable(): boolean
}
```

`DevLeadUseWorkspaceRequest = { path: string; title?: string; create?: boolean }`（protocol 导出）；
`create` 缺省 `false`。`DevLeadCreateSessionRequest` 另含
`model?: DevLeadModelSelection = { provider: string; model: string; reasoningEffort?: string }` 与
`agentTeams?: boolean`；`DevLeadCreatedSession` 在请求并成功应用后带上同形的 `model` 与
`agentTeams` 字段（未请求的字段省略）。模型目录的 protocol 类型：
`DevLeadModelCatalog = { default: DevLeadModelSelection; routableProviders: string[];
providers: { id; name; models: { id; name; reasoning?: { efforts: { id; name }[]; defaultEffort? } }[] }[];
failures: { id; name; message }[] }`（省略 model description/badge 等展示字段）。Agent preset
目录：`DevLeadAgentPresetCatalog = { available: boolean; presets: { id; name?; description?;
default: boolean; broken? }[]; reason? }`；`default` 是 Host 有效默认（`selectedDefault`
优先，否则基础默认），`available: false` 表示 Host 未组合 roster。关闭语义的 protocol 类型：
`DevLeadRemovedWorkspace = { workspace: DevLeadWorkspaceView; removed: boolean }`、
`DevLeadArchiveSessionOptions = { stopRunning?: boolean; signal?: AbortSignal }`、
`DevLeadArchivedSession = { sessionId: string; archived: true; stopped: boolean }`、
`DevLeadUnarchivedSession = { sessionId: string; archived: false }`。

约束：

- 所有接收 Agent 的写方法先 `assertLive(agent)`（`ctx.agents.get(agent.id) === agent`），并
  校验模式已开启（`DEVLEAD_NOT_ENABLED`）；`setEnabled` / `reset` 是人类恢复入口，只要求
  live，不要求模式已开启（损坏状态下 `strictStateOf` 会抛 `DEVLEAD_PROJECTION_INVALID`，
  `setEnabled(false)` 与 `reset` 必须仍能工作）。0.2.0 起 `useWorkspace` 也接收 live lead
  Agent 并走 `assertReady`（live + 模式开启），不再有 caller-free 例外：Workspace 注册是
  Host 级副作用，必须由已授权、已开启模式的 lead 发起。
- 所有需要关注集合或"当前 lead"的读接口都显式接收 `agent`（工具调用传 `exec.agent`，
  命令调用传 `invocation.agent`）；服务不依赖 initiator 推断调用者。
- 读接口把 `signal` 传给支持取消的 `sessionQuery` 读取（列表 / 标题）；`readSession`
  本身没有 signal 参数，`sessionLogFacts` 在读取前后检查取消；写接口只在阶段边界做协作式
  取消检查
  （Session 创建 / `resolveAgent` 本身不可中断）。取消按 `AbortSignal` 语义抛出
  `AbortError`，不伪装成领域错误。取消不回滚已经发生的副作用：`createSession` 在创建后、
  watch 后收到取消会留下该 Session / watch，但不会继续执行 isolation 或投递 prompt。
- `promptSession` 的自动 watch 是**可补偿语义**：`added = (watch ?? true) && !alreadyWatched`
  时，watch 必须在 admission **之前**提交（否则子会话一个非常快的 `turn/end` 可能落在
  watch 提交之前，第一次唤醒就丢了）；admission/resume 失败或取消时，只用不带 signal 的
  `setWatching(false)` 补偿移除**本次新增**的 watch（补偿失败只 warning），然后按原错误抛出。
  已有显式 watch（`alreadyWatched`）与 `watch:false` 不改变 watch。成功路径返回的 `watched`
  仍从 durable state 读取，并发下如实反映。即：promptSession 要么"投递成功且 watch 保持"，
  要么"失败且不留下本次新增的 watch"；`createSession` 保持原有语义（创建后的副作用不回滚）。
  **interrupt 例外**：一旦 `interrupt:true` 已对运行中的 turn 发出 stop（`stopSessionActivity`
  已请求），停止本身不可回滚；此后若 `followup` 投递失败，抛出的是
  `DevLeadInterruptedAdmissionError`（仍是 `DEVLEAD_SESSION_UNAVAILABLE`，文案注明"已要求停止、
  保留 watch、请重试 prompt"），**不做 watch 补偿**——否则会把一个已被停止的子会话留在无人
  关注、无人重试的状态。lead 仍需观察被取消 turn 的通知并重试替代 prompt。
- `useWorkspace`：先 `assertReady(agent)`（live + 模式开启）；绝对路径校验交给
  `workspaceRegistry.create`（它做 realpath 规范化、相对路径拒绝、目录存在性检查、已注册路径
  复用）。**`create` 默认 `false`**：默认绝不 mkdir，缺少目录时返回
  `DEVLEAD_DIRECTORY_MISSING`（文案提示 retry with `create: true`）；只有显式 `create: true`
  才 `mkdir -p` 后重试一次。错误映射：目录缺失（且未允许创建 / 创建失败）→
  `DEVLEAD_DIRECTORY_MISSING`；相对路径、文件、不可用父目录、registry 写入失败 →
  `DEVLEAD_INVALID_INPUT`。`title` 只作用于**新注册**的 Workspace，已存在的记录保留原标题。
  默认不建目录的理由：Host 侧目录创建是高影响副作用，模型必须先显式征得人类同意。
- `setEnabled` / `reset`（人类恢复入口）：正常路径写 mode 记录。读到 `failure !== null` 时：
  `setEnabled(false)` 改为追加一条 reset 记录（强制关闭并清除冻结状态）后 flush、幂等成功；
  `setEnabled(true)` 抛 `DEVLEAD_PROJECTION_INVALID` 并提示先运行 `/devlead reset`（不隐式
  丢弃人类可能还想检查的记录）；`reset(agent)` 只 `assertLive`，追加 reset 记录后 flush。
  恢复后投影回到默认 disabled、关注关系索引清空，需要重新 watch；持久日志里的旧记录保留但不再
  fold。hub 在 `session/event` 看到 reset 记录时也 `syncLead`（状态变 disabled → `removeLead`）。
- **全局单活准入**：DevLead 模式是 Host 级资源，同一时刻最多一个 Session 可 enabled（跨全部
  Workspace）。`setEnabled(true)` 在 Host 服务内的 `admissionTail` 临界区里执行“扫描占用者 →
  必要时释放 archived 占用者 → 写 mode 记录”，因此同一进程内两个并发 `on` 只有一个能成功；
  `setEnabled(false)` / `reset` 也走同一临界区，关闭立即释放。扫描来源：
  - live Session/Agent 直接读 `projectionHandle.stateOf`（权威）；
  - 持久语料经 `sessionQuery.listSessions()` 遍历；projection cache 的 active 行（`devLead`
    enabled，含空 watch）精确 fold，inactive 行零 I/O 跳过，其余行有界读取（64 条上限）并
    warning；
  - 启动阶段的冷语料由 rehydration 扫描顺带产出 active 列表（不重复读），与 live 扫描合并。

  错误码 `DEVLEAD_ALREADY_ACTIVE`，消息给出占用者 `title (sessionId)` 或裸 id，并提示先执行
  `/devlead off`。被拒绝方的 projection 不变（按钮 off、状态条不渲染），失败文本走既有
  UI 失败通道。
- **释放与重启恢复**：`off`/`reset` 立即释放；**archived 占用者视为非 active**：准入/启动
  仍 best-effort 写 mode-off（live 直接写；冷 Session 尝试 `sessionController.resolveAgent`
  后写），但写不掉时只 warning、写入 tombstone，并继续准入，**绝不因 archived 占用者永久拒绝
  新 lead**。tombstone 持久在 outbox domain 的 `ignored` 表，重启后仍生效；被忽略的 Session
  若 unarchive/打开，`agent/created` 触发 reconciliation，能在 live Session 上写 mode-off 时
  自动关闭并清除 tombstone，避免双活。未归档且 cold、无法 resume 的占用者仍会阻塞准入（它是
  真实 enabled lead，不打开无法改写状态）；archived 分支是无需运行 Session 即可解除的路径。
  永久删除的 Session 因扫描不可见而自然释放；turn 结束、
  冷 detach、Agent dispose **不释放**（durable 模式仍在）。启动时 `reconcileActiveSessions`
  合并 live + rehydration active，archived/已 tombstone 的占用者只尝试释放但不参与
  keeper/blocker 排序；其余按 `rankActiveSessions` 保留一个（优先
  incumbent/live/running/最近 enable/creator/id），对其余写 mode-off 并 warning。恢复扫描只
  处理 archived/重复占用，不改变唯一一个正常 lead 的 watch/通知状态。`/devlead status` 的
  `Archived DevLead holders` 段列出 archived 占用者并给出 unarchive + `/devlead off` / 删除
  的可执行路径。
- **单活边界**：临界区是单 Host 进程内的；共享同一持久存储的多个 Host 进程仍可能并发通过扫描
  （没有跨进程锁）。无 `sessionQuery` 的 Host 只能核对 live；projection cache 的
  stale-negative 窗口与冷 lead 恢复共用同一“mode 写后 eager checkpoint”保障，极端崩溃窗口
  仍无法数学消除。这些边界在 README 已知限制中说明。
- `listModels`：`assertReady(agent)` 后取 `ctx.get('sessionController')` 的
  `modelCatalog()`，映射为精简的 `DevLeadModelCatalog`（default / routableProviders /
  providers+models+reasoning efforts+defaultEffort / failures），丢弃 description/badge 等
  展示字段；provider 或 model 缺 id 的条目、非字符串 routableProviders 防御性丢弃。Host 未组合
  controller 或读取失败 → `DEVLEAD_SESSION_UNAVAILABLE`。controller 方法不接受 signal，因此
  只在调用前后检查取消。
- `createSession`：先在第一个 await 之前**同步预留** watch 槽位（并发调用不会都通过预检后
  才在 setWatching 报超限；槽位在 watch 提交后立即释放，`finally` 兜底）→ 解析目标 Workspace
  （id / 注册路径 / 精确 title / 缺省用 lead 自己的 cwd 并自动注册）→ 校验 `workspace.status() === 'ok'`
  （已注册但目录消失时返回 `DEVLEAD_DIRECTORY_MISSING`，不让 controller 的自动 mkdir
  把空目录"复活"）→ `ctx.sessionController.create({ workspaceId })`（该调用会把 Session
  挂进 Workspace 的账目）→ **可选的创建时 dispatch 设置**（模型 / Agent Teams，见下）→ 可选
  `ctx.sessionTitle.rename(session, title)` → 可选 watch → **可选 worktree 隔离（见 §4.3）**
  → 可选 prompt。隔离失败不会让创建失败；结果里的 `isolation` 字段如实上报
  `none` / `worktree` / `unavailable` / `failed`。注意：空白 Session 在第一次 turn
  开始前不会出现在侧边栏，因此"创建+prompt"是常规用法。
- **创建时 preset**：`preset` 是 Host 定义的 Agent preset id（不能假设只有 `standard`/`ptc`）。
  `createSession` 使用 `request.preset?.trim() ?? resolved.defaultAgentPreset`；工具层先把空格/
  空白转为省略，因此省略或空白 = 插件 `defaultAgentPreset` → Host 的有效默认（`selectedDefault`
  优先，否则基础 `default`）。有效 id 原样作为 `agentPreset` 传给 `sessionController.create`；
  Host 拒绝未知/不可用 id 时，创建失败并被归类为 `DEVLEAD_SESSION_UNAVAILABLE`（消息保留 Host
  文本），不会静默忽略或替换。`listAgentPresets` 用 `ctx.get('agentPresets')` duck-typing 探测
  可选 roster：服务缺席返回 `available: false` + reason，读取失败返回结构化错误，行按 Host
  `list()` 顺序映射、无 id 行丢弃，`default` 取 Host `defaultId`。
- **创建时模型与 Agent Teams**：默认继承 Host 默认模型；`provider`/`model` 必须成对，
  `reasoning_effort` 只能与成对模型一起用（否则 `DEVLEAD_INVALID_INPUT`），并且只在人类明确
  要求或简报需要成本/能力路由、可复现性时才应指定（policy 口径）。创建前按与 Session controller 的
  `selectModel` 相同的口径校验：provider 已注册、model 在该 provider 当前可用模型列表内、
  `ctx.llm.resolveCallConfig` 接受该 route/effort（失败 `DEVLEAD_MODEL_UNAVAILABLE`，消息含
  provider/model/effort），因此不可用配置**不会**创建出 Session。`agent_teams: true` 要求
  Host 组合 `ctx.agentTeams`（否则创建前 `DEVLEAD_TEAM_UNAVAILABLE`）；`false` 显式关闭；
  省略则不触碰 Host 默认（`defaultEnabled`）。Session 创建后、title/watch/隔离/prompt 之前，
  模型通过 **`agent.model.select`**（durable `model/selection` 事件）记录在子 Session 上，
  **绝不**走会改写 profile 默认模型的 `sessionController.selectModel` /
  `agentDefaultModel.saveSelection`；Team 通过 `agentTeams.setEnabled(childAgent, enabled)`
  （durable `team/mode` 事件，内部 flush）。两者都是 **creation-time only**，
  `promptSession` 不会重新指定。应用阶段失败（竞态/持久化）的错误消息必须带出已创建的
  sessionId 并说明 Session 仍存在；按既有"创建后副作用不回滚"契约不做自动归档，也不留下
  watch（watch 在其后提交，预留槽位由 `finally` 释放）。结果只带实际请求并成功的
  `model` / `agentTeams`。模型不可用错误（创建前与创建后）都提示调用
  `devlead_list_models` 查看可用 provider/model/effort；Team 是否开启由 lead 按任务判断
  （复杂/多步/并行可开，简单线性省略，人类明确开/关照做）。Team 能力用
  `ctx.get('agentTeams')` duck-typing 探测，**没有**静态 import：DSH 0.2.2-rc.1 的默认组合
  没有该服务，`agent_teams: true` 在创建前报 `DEVLEAD_TEAM_UNAVAILABLE`（提示自 rc.2 起提供
  并默认组合），`false`/省略照常；rc.2+ 组合了服务时按上述路径应用。
- `promptSession`：先校验归档与冷会话激活能力（避免"缺 controller 时先 watch 再报错"的
  半应用）→ 自动 watch 在 admission 前提交（失败/取消按上文的补偿语义撤销本次新增）→
  `sessionController.resolveAgent(sessionId)` 拿 live Agent（冷会话会被 resume）→
  `agent.followup(createUserMessage({ content, source: { kind: 'devlead', form: 'relay', senderSessionId: lead.id } }))`
  + `ctx.sessions.flush(agent.session)`。默认自动 watch。
- **prompt interrupt（显式 opt-in）**：`interrupt: true` 且目标 live Agent
  `status === 'running'` 时，先 `await ctx.parallel('workspace/session-stop', { sessionId })`
  ——与 `archiveSession(stopActivity: true)` 相同的 provider fan-out：Agent registry 取消
  运行中的 turn、Job registry kill 所属 job、Subagent runtime 取消运行中的后代、Schedule
  删除活跃行——再执行 `followup`。该事件是 fire-and-forget：provider 只发出取消/停止请求，
  不等待 settle；`followup` 在 aborted phase 上被 Agent 重新归类为 `next-turn` 并 latch
  wake，等被取消的活动收敛后启动，因此不会进入正在取消的 turn，也不需要 `whenIdle()`。
  turn provider 使用 `agent.cancel({ kind: 'user' })`（不带 `keepInbox`），会丢弃子会话排队
  输入；被中断的 turn 以 `aborted` 结束，watched 通知显示 cancelled，替换 turn 结束后再单独
  通知。空闲或冷目标没有运行中的 turn，跳过 stop，`interrupt` 是无害 no-op。结果
  `interrupted` 表示是否真的请求过 stop；stop provider 抛错只 warning，不阻塞替换 prompt。
  一旦 stop 已请求，之后的取消不会回滚 stop，替换 prompt 与 stop 一起提交；若此时 `followup`
  仍失败，按上文的 interrupt 例外保留本次新增的 watch（不补偿），错误文案提示重试 prompt。
- `watchSession`：追加完整 watch 记录；上限 `maxWatchedSessions`；不能 watch 自己。
- **关闭语义（remove / archive / unarchive）**：`removeWorkspace` / `archiveSession` / `unarchiveSession` 都先
  `assertReady(agent)` 并转发 signal，Host 未组合 registry 时统一走 `requireWorkspaceRegistry`
  的 `DEVLEAD_WORKSPACE_NOT_FOUND`。`removeWorkspace` 用 `resolveWorkspaceReference` 解析
  id、canonical path 或精确 title，在删除前取 `devLeadWorkspaceView` 快照（返回视图即注销前状态），
  再调 `workspaceRegistry.delete(id)`——只注销注册记录，**不删目录、文件或 Session 日志**；
  这些 Session 变为未分组（ungrouped），仍可打开/续写，重新注册同一目录会得到全新
  Workspace、不继承旧 Session。`archiveSession` 复用 `resolveSessionReference`（完整 id /
  唯一前缀 / 省略 `session-` 的 uuid 前缀），拒绝归档 lead 自己的 Session
  （`DEVLEAD_INVALID_INPUT`，提示人类从侧边栏关闭），已归档 id 直接幂等返回
  `{ archived: true, stopped: false }`；否则调
  `workspaceRegistry.archiveSession(id, { stopActivity: stopRunning })`。Host 的
  `WorkspaceActiveSessionError` 映射为 `DEVLEAD_SESSION_ACTIVE`（消息列出活动种类，每个种类的
  item 最多 3 条，其余以 `+N more` 截断），`WorkspaceUnknownSessionError` 映射为
  `DEVLEAD_SESSION_NOT_FOUND`；两者都按 `error.name` 结构判定（dsh-workspace 是可选 peer，
  且重复加载的模块实例仍能映射）。`stopRunning: true` 时由 Host 先写归档、再经
  `workspace/session-stop` providers 请求停止（与人类点停止同一路径），**不等待 settle**，
  结果 `stopped: true`。`unarchiveSession` 幂等调用 `workspaceRegistry.unarchiveSession(id)`，
  返回 `{ archived: false }`；归档从未触碰 Workspace 账目，恢复后回到原位置。
- `notifications`：返回本会话 projection 里保留的通知（最新 limit 条；非法 limit 退回默认 20）。
- `ctx.sessions.flush()` 返回 `false` 只表示"没有组合任何持久化参与者"（headless / SDK
  组合），不是失败；参与者抛出的错误只记 warning，不会让已提交的内存 append 变成抛错。

**Workspace 引用解析（所有带 `workspace` 参数的工具共用）**：`resolveWorkspaceReference`
按 **id → 注册路径 → 精确 title** 解析。id 是注册表的稳定唯一键；注册路径经
`workspaceRegistry.resolveByPath` 按 canonical path 唯一匹配（symlink、尾斜杠会先规范化）；
title 是展示元数据，DSH 0.2.2-rc.1–rc.5 的 WorkspaceRegistry 明确允许不同 canonical path
共用 display title（源码注释 `Different canonical paths may share a display title`），所以只
在前两者都不命中时才用。title 匹配对引用与存储值都做 trim，再做**大小写敏感的精确匹配**：
不做大小写折叠，避免把仅大小写不同的 title 变成第二层歧义与静默近似匹配；`devlead_list_workspaces`
已经给出精确 title。多个 Workspace 同 title 时抛 `DEVLEAD_WORKSPACE_AMBIGUOUS`，按 registry
顺序列出每个候选的 `id (path)`，绝不静默选第一个；未命中时 `DEVLEAD_WORKSPACE_NOT_FOUND`
文案同时说明三种寻址方式，并且只在"仓库尚未注册"的语义下提示 `devlead_use_workspace`，不再
暗示已注册目录未注册。

错误类：`DevLeadError extends Error { code: DevLeadErrorCode }`，稳定 code 见第 8 节。

### 4.1 关注关系索引与通知投递

持久日志是权威，hub 的内存索引 `watched → Set<leadSessionId>` 只是加速器；lead 的 enabled 与关注集合始终来自其 Session 日志的严格 fold。Host 重启 / 插件重新加载后，service init 从持久
记录**重建索引**（cold rehydration，§4.1.1），因此尚未打开的冷 lead 仍能看到已关注会话的
`turn/end`、写入持久通知，并在合并窗口结束时按 `wakeColdSession` 策略投递。

启动与监听：

0. `[Service.init]`：注册三个 projection unit → 创建 hub → `hub.start()`（安装监听器并对当前
   live Agent 做一次 `bootstrap`）→ 冷扫描 `await hub.rehydrate(await persistedLeadRecords(...))`
   （就绪条件与重试见 §4.1.1）。rehydrate 的任何异常只记 warning，**绝不让插件加载失败**。
1. `ctx.on('agent/created')`：若新 Agent 的 session projection `enabled` 为真，把它的 watch
   集合注册进内存索引 `watched → Set<leadSessionId>`；若存在 `unsaved` 队列还要立即调度
   flush（覆盖"人类打开冷 lead"的补写与投递路径）。持久 watch 记录若含 lead 自身 id（只可能
   来自手工编辑），索引时忽略并 warning 一次；写侧仍由 self-watch guard 拒绝。
2. `ctx.on('session/event', (session, event))`：
   - 若 `session` 是某个 lead 自己的会话：重新同步该 lead 的关注集合（mode / watch / reset
     记录变化时）；
   - 若 `session.id` 被至少一个 lead 关注，且 `event.type === 'turn/end'`：为每个 lead 生成
     `DevLeadNotification`（`turn`、`transition`=reason.kind、`error` 摘要、`sessionTitle`），
     写入 lead 会话的 notification 记录，并排队唤醒。
3. 唤醒水泵（每 lead 一个）：
   - 通知在 lead Session 日志可写时**先写持久记录再入队**（cold lead 则先入 `unsaved`），按
     `notificationBatchMs` 合并；窗口结束时若 lead Agent 仍存活：
     `agent.followup(createUserMessage({ content: 渲染的摘要, source: { kind: 'devlead', form: 'notice' } }))`
     + flush。Agent 正在运行也无妨：followup 排队到下一 turn。
   - 同一确定性 id 的通知在 `pending` / `unsaved` 里已存在时跳过入队（重放的 `turn/end` 不会
     重复唤醒；持久记录仍两条都在，audit 完整）。
   - **inbox 已有未投递 notice 时不丢 batch**：`hasQueuedNotice(agent)` 为真（`inbox.nextTurn` /
     `inbox.nextStep` 里已有 `kind:'devlead'` + `form:'notice'` 的消息）时，不取走该批，保留
     `pending`，清掉 `flushing` 并 arm 一个 1s recheck timer（`DELIVERY_RETRY_MS`）；recheck 时
     重新 flush：notice 已被消费/取消则正常投递新 batch，仍排队则继续等。`agent/status` 变为
     idle 时的 flush 钩子会立即重试（不必等满 1s）。持久 digest 仍是权威：记录始终先写，wake
     文本只覆盖本批。
   - 投递失败（`followup` 抛错）时把该批重新入队，并按上限 1s 重试，而不是丢弃或按合并窗口
     空转；`notificationBatchMs: 0` 下模式关闭 / Agent dispose 后不会再唤醒（微任务 flush 有
     代际守卫）。
   - **冷 lead（runtime 仍被索引、Agent 不在注册表）**：`wakeColdSession === false` 时只保留
     持久记录与 `unsaved` 队列，等人类打开 lead；为 `true`（默认）时先
     `sessionController.resolveAgent(leadId)`，resume 成功后 `syncLead` 触发补写与投递。
   - lead 会话处于归档状态时：live 时先把 `unsaved` 持久化，再清空 `pending`/`unsaved`；持久
     记录保留，恢复会话后状态视图仍能看到。
   - `agent/status` 变为 idle 时也尝试冲一次队列（例如窗口结束前 Agent 刚好在忙）。
   - **`agent/disposed` 不再移除 lead 的 runtime / 反向索引**（0.2.0）：dispose 之后已关注
     会话的 `turn/end` 仍会写入持久通知并排队；区别只在投递侧——lead Session 日志仍 attached
     （`ctx.sessions` 里有）时记录立即持久化进 `pending`，已脱离（cold）时进 `unsaved` 等
     resume/打开后补写。索引只在以下情况消失：持久状态变为 disabled（mode off / reset，
     经 `session/event` 的 `syncLead`）、unwatch 使集合变化（runtime 保留、只是不再 watch）、
     或 hub/插件卸载（重新加载时由 persisted records 重建；卸载期间结束的 turn 因为内存
     transport 不存在而丢失，不会补发）。`setWatched` 同时过滤 `pending` 与 `unsaved`
     （最近的关注集合是权威）。
   - 写入侧自检：不可表示的 turn / 时间戳宁可不写记录，也不写一条自己的严格 fold 会拒绝的
     记录。
4. 会话日志里写入的通知记录会驱动 projection，UI 状态条实时更新。

#### 4.1.1 冷 lead 索引重建（cold rehydration）

`hub.rehydrate(leads)` 对每条 `DevLeadPersistedLead`（`{ sessionId, watched: string[] }`）执行
`ensureLead` + `setWatched`；可重复调用（幂等），不要求 Agent / Session live。service 的私有
`persistedLeadRecords(scanPersisted)` 用可选服务重建这份列表（全部 `ctx.get`，缺席即降级）：

- **live 会话兜底**：`ctx.sessions.list()` 里没有 Agent 的 live Session 直接
  `projectionHandle.stateOf(session)`；`failure === null && enabled && sessions.length > 0` 即
  记录。这样 attach-only lead（有 Session、无 Agent）也能在重启后恢复观察。
- **cold 候选预筛**：`sessionQuery.listSessions()` 的 `SessionRecord[]`，跳过 live（上面已处理）
  与 `header.origin === 'subagent'` 的记录；用可选 `sessionProjectionCache` 的
  `cachedSnapshot(header)?.values?.devLead` 做零 I/O 预筛：明确 `enabled === true` 且 watch 非空
  → 候选；明确 disabled / 空 watch → 跳过；`undefined`（cache 无行/无该 key）→ 候选（unknown，
  仅当 cache 服务存在时）。
- **精确折叠**：对候选 `await sessionQuery.readSession(id)`，用 `applyDevLeadProjection` 从空
  状态折叠事件得到含 `failure` 的权威状态；`failure !== null` → 首个损坏候选 warning 一次并跳过；
  `enabled && sessions.length > 0` → 记录（关注集合以精确折叠为准，cache 只作预筛）。
- **读取上限**：unknown 候选的全量日志读取有上限常量（64），超过后停止读取并 warning，避免
  Host 重启扫描成千上万历史会话；已知 enabled 的候选不计入该上限（它们是真正的 lead，必须
  恢复）。
- 没有 projection cache 服务时：仍处理 live 会话；cold 不做全量日志读取，只记录一次
  debug/warning（cold rehydration 依赖 projection cache 预筛）。
- **就绪条件与 corpus-readiness barrier（真实 Host 上的关键点）**：真实 query engine 通过
  自己的 `ctx.inject` 回调**异步**绑定 `sessionPersistence`，服务先可见、绑定后
  `listSessions()` 才返回持久语料；绑定前只返回 live-only 行（Host 重启后为空），所以
  "`sessionQuery` 存在"**不等于**可以扫描持久语料。`[Service.init]` 因此**await** 一个精确的
  就绪屏障后才完成：先同步跑 live-attach 回退 → 等一个 macrotask（让 query engine 自己的
  optional-service 绑定先运行）→ 用新增的私有探针 `persistedSessionsOf(ctx)`
  （`src/persistence.ts`：可选 `sessionPersistence.list()` 返回的**完整存储会话 id 集合**；
  服务缺失或没有可调用 `list` → 不可验证；调用抛错 → "已组合但未就绪"）做比对：
  - persistence 报告 0 个存储会话 → 立即就绪（全新 Host 直接通过）；
  - 否则每 100ms 轮询一次、**有界 2s**，直到 `sessionQuery.listSessions()` 的 persisted 行
    包含全部存储 id（稳定 Host 只付一次语料比对）；超时则 warning 一次并 best-effort 继续；
  - 然后执行**唯一一次**权威 cold scan → 标记 `rehydrated`、解绑全部重试；之后事件不再重复
    列语料（并发去重 + `rehydrate` 幂等）。
  语义后果：Host 在关注关系索引重建完成前不会报告 application-ready；init 时若
  `sessionPersistence` 尚未组合，则通过一次性 `ctx.inject(['sessionPersistence'], ...)` 等待，
  它出现时再走同一屏障；从未组合 persistence 的 Host 不扫描持久语料、也不会 per-event 扫描
  （`agent/created` / `session/event` 一次性监听只在 `sessionQuery` 本身缺失时才 arm）。
  两个服务都只读 `ctx.get` 探测，不新增 `static inject`、不新增依赖，缺失时仍可加载并仅恢复
  live lead。
- 恢复的只是关注关系索引：**插件卸载期间**结束的 `turn/end` 不会补发（内存 transport 只在
  插件运行期间存在；事件只发生一次），Host 重启/重载后新的 `turn/end` 正常写入持久通知并
  投递；`agent/disposed` 不卸载插件，索引保留，因此不丢观察。

通知消息形如（英文，面向模型）：

```
[DEV LEAD NOTIFICATION]
Watched session activity changed outside this conversation. This is a runtime notice, not a human instruction.
- webapp (session-xxx) — turn 3 completed: "Implemented the login form and tests pass."
- api (session-yyy) — turn 1 failed: provider quota exhausted
Call devlead_notifications for the retained digest, or devlead_get_session for one session in detail. ...
```

通知记录携带 `summary`（turn 结束前最后一条 assistant 文本的 240 字符摘要），
DevLead 无需额外工具调用即可判断是否要介入。

### 4.1.2 中途汇报（watched child → active lead）

已关注、但**不是** DevLead 的 Session 需要一个不阻塞自己的上行动道。`devlead_report` 是唯一
入口，参数只有 `message`、`kind?`、`summary?`，没有 target：目标由服务端从当前全局单活约束与关注关系解析，绝不能由模型指定。

可见性：

- tool registration 的 `when` 为 `ctx.devLead.isSupervised(agent)`；该查询是同步的：
  `!isEnabled(agent)` + hub 反向索引中恰好一个未被归档的 active lead（多于一个时优先
  `activeSessionId`，否则视为无唯一关注该会话的 active lead）。
- 系统提示另有 `devlead:report-policy` 段，只对已关注的普通会话注入；内容明确「单向、最终
  turn 结束仍走原通知、普通 report 每轮最多 4 条；`question` 是受支持的提问通道，发完后结束
  turn 等 lead 的新 turn；watched 子会话直接 `ask_user_question` 会被工具层拦截并转给 lead」；
  并收窄调用范围：turn 结束自带通知，常规进度/最终总结不得用 report 重复播报，report 只用于
  长任务途中 lead 必须在轮次结束前知道的关键节点，短任务/线性任务默认不调用。
- lead 侧 policy 增加收到 `[DEV LEAD REPORT]` 后的处理口径：当作 runtime fact；`question`
  report 表示子会话需要决策，lead 自行回答或先向人类提问，再用 `devlead_prompt_session`
  转回；普通 report 必要时用 steering，不用汇报通道回复。

投递状态机（`DevLeadService.reportProgress` → outbox → `DevLeadNotificationHub.persistReport`）：

1. 校验 live / 非 DevLead / 唯一关注该会话的 active lead；解析 reporter 的当前 turn（命令调用可为 0）。
2. 校验 message 非空且 ≤4000 码点、kind 枚举、summary ≤200；同轮同一 kind+message 复用已有
   receipt（幂等；同文不同 kind 是新报告），不同普通 report 超过 4 条返回
   `DEVLEAD_REPORT_RATE_LIMITED`；`question` 是
   控制流通道，不计入普通 report 预算，也不受第 5 条限制。
3. 构造 sender id/title、workspace id/title、lead id、`at`，**先写 durable outbox**
   （`devlead_report_outbox` storage-domain，`pending` 表，per-record、写入 resolve 即 durable），
   成功后工具即可安全返回。随后尝试把 receipt 写入 lead 日志：
   - lead 日志 attached 且 enabled：append `plugin:devlead/report`，进入 `pendingReports`；
     **await `ctx.sessions.flush(leadSession)` 成功后**才删除 outbox 行；
   - lead cold / 未 attached / 归档 / 关注关系暂时消失：outbox 行保留，hub 只做内存唤醒队列；
     不把“已入内存”当作 durable 交付；
   - 若 flush 失败，outbox 行保留，receipt 已 append 的状态会在 replay 时再次 flush 并清理。
4. `scheduleFlush` 与 turn 通知共用合并窗口 / `hasQueuedNotice` 避让 / 1s 重试；lead 空闲时唤醒，
   运行中排到下一步。报告与通知同批时合并为一条 `[DEV LEAD NOTIFICATION] + [DEV LEAD REPORT]`。
5. **Replay**：service init、storage-domain 晚挂载、`agent/created`、`setEnabled(true)`、
   `watchSession(true)` 时扫描 outbox；对每条 report 重新执行
   `hub.persistReport`，只有 lead 日志 flush 成功才删除。cold lead 的 resume 由同一 hub 水泵
   处理；归档 lead 不自动 resume。outbox 行按 7 天 retention 清理；`/devlead reset` 丢弃该
   lead 的待投递行；lead 被删除且不返回到期后清理。
6. `report` 记录驱动 `devLead` projection，状态条、`/devlead` status、`devlead_notifications`
   读取同一份 durable digest；重启后从 lead 日志折叠恢复。
7. 若 Host 未组合 `storageDomain`（或被显式禁用），工具回执为
   `{ durable: false, queued: true, warning }`，文案明确告知可能丢；这是唯一允许的非持久路径。
   默认 Host 的 e2e 断言 `durable: true`。

释放关系：unwatch / mode off / reset / lead 归档后 `supervisorOf` 返回 undefined，下一次 tool
`when` 隐藏，伪造调用返回 `DEVLEAD_NOT_SUPERVISED`；已经写入的 report 仍保留到 retention。

#### 4.1.3 问题路由（watched child → lead）

watched 子会话是真实 Session，它自带的 `ask_user_question` 会直接打开子会话自己的问题 UI，
绕过 lead。工具插件在根上下文注册 `tools/pre-execute` waterfall（rc.1–rc.5 均存在；它在
`agent-loop` 执行工具前由 tools pipeline 派发），对每个待执行调用做如下判断：

1. 只处理 `name === 'ask_user_question'` 且带 `agent` 的调用；
2. `ctx.devLead.isSupervised(agent)` 为 false（未关注 / lead 自己）时直接 `next()`，完全不影响
   原有路径；
3. 若当前 turn 中最近一条可执行 user message 的 `source.kind === 'user'`（人类直接在子会话
   对话 / steer；`runtime-context` 与 `tool-registry` 注入跳过），也放行——人类已经在场，问题
   就地由人类回答；
4. 否则把 `questions` 格式化为文本（问题、id、header、options、multi-select），通过
   `reportProgress({ kind: 'question' })` 写入与普通 report 相同的 durable outbox / lead digest /
   唤醒通道；随后返回 `{ kind: 'deny', reason }`，工具 body 不执行，子会话 UI 不出现。拒绝文案
   明确要求子会话**结束当前 turn**，不要重试、不要轮询，lead 会用 `devlead_prompt_session`
   在新 turn 里回答。转发失败只 warning，并退化为“结束 turn，在最终 assistant 消息里写明问题”。

`question` 是 `DevLeadReportKind` 的新增成员（protocol / outbox / fold / UI label 均派生同一
枚举），但不计入普通 report 的每轮 4 条预算；同轮相同 kind+message 仍幂等。UI 的 report chip 对
`question` 使用“提问 / question”标签和 warning 色。

**为什么结束 turn 而不是挂起工具调用**：挂起会依赖 lead 及时响应，冷 lead / 人类离开时会形成
死等；而 report 本身是 durable 的，lead 的回答作为 `devlead_prompt_session` 的新 user turn
到达，子会话可能已在等待中被 resume。`tools/pre-execute` 的 deny 不会强行终止 turn，但拒绝文案
与两侧 policy 都要求模型结束 turn；这是硬拦截（问题 UI 一定不会出现）+ 软收尾（模型决定何时
结束）的组合。

**自然语言提问**：轮次结尾直接说“请问……”无法在工具层拦截。普通 watched-turn 通知已带
assistant excerpt（`summary`，完整内容可由 `devlead_get_session.lastAssistant` 读取），lead
policy 要求把这类结尾问题当成待回答问题，用与 `question` report 相同的方式回答。该路径比
`question` report 慢且依赖 lead 识别，是已知差距，不是静默失败。

**豁免**：未关注会话、lead 自己的 `ask_user_question`、以及当前 turn 由人类直接发起的子会话
均不受拦截。被关注子会话若被 lead 的 relay 提示词驱动，则问题必须绕回 lead。

### 4.2 状态视图

`DevLeadSessionView` 由 `DevLeadService` 组装，列表路径刻意分成「便宜事实 → 排序截断 →
昂贵视图」三步：

- 候选集合（`collectSessionIds`）：live Agents、store 中的 live Sessions、Workspace 账目、
  lead 的关注集合，以及（组合了 `sessionQuery` 时）持久化 Session。列表模式下进入候选的
  持久化 ID 窗口受 `maxListedSessions` 限制；rc.1 的 `sessionQuery.listSessions` 没有 limit
  参数，底层仍会读取完整持久语料后才截断候选（这是 API 限制，不是逐行日志读取）。
  **身份解析**（`resolveSessionReference`）走穷尽模式，列表窗口从不是"能否寻址"的上限；解析
  同时接受省略 `session-` 的 uuid 第一段（见 §5）。
- 便宜排序事实：watched / `agent.status === 'running'` / header `createdAt`；按
  watched → running → createdAt 降序、id 兜底排序后**先截断**，只有保留下来的行才组装完整
  视图。`limit` 必须是正安全整数，并 cap 在 `maxListedSessions`；`watchedOnly` 列表不会截断
  到小于关注集合（关注集合本身已有 `maxWatchedSessions` 上限）。
- 批量事实（`readSessionFacts`）：标题/header（live 用 `sessionTitle.get`，cold 一次
  `sessionQuery.readTitleSnapshots` 批量）、Workspace 归属（一次 `workspaceRegistry.list()`
  建 map，不再按行反查）、归档集合。
- 精确 id 解析有快路径：关注集合 → live Session/Agent → 单 id `readTitleSnapshot`；只有
  前缀匹配才需要列出持久化语料。
- 日志摘要（仅 `getSession`）：`ctx.get('sessionQuery')?.readSession(id)` → 末条
  `assistant/message` 文本摘要 + 末条 `turn/end` 的 reason；未知的未来 reason kind 归为
  `interrupted`（与通知一致）。
- 所有可选服务都用 `ctx.get(...)` 判空，缺席时降级而不是报错（headless/SDK 组合可能没有）；
  读取被取消时重新抛出 `AbortError`，不把取消降级成"事实未知"。

### 4.3 可选 worktree 隔离（能力检测与退化）

同一 checkout 里多个被派发 Session 并发写文件时，工作区会出现交错的 hunk；hunk 级拆分提交
成本高且易错。DSH 提供实验性的 Git worktree 设施（`ctx.worktrees`，默认不组合）可以把一个
Session 的工作目录切到独立分支/检出，DevLead 用它**可选地**隔离新建 Session——但本套件不依赖
该实验包。

**能力检测（无硬依赖）**

- 不用 `inject`、不 import 任何 `@deepseek-ai/dsh-experimental-*`（**连 type-only import 也不
  允许**），`package.json` 里也没有该包的任何依赖/peer 声明。
- `DevLeadService` 在调用点用 cordis 的无类型重载 `this.ctx.get('worktrees')` 取服务，再用本
  地结构化接口 + 运行时 duck typing（对象且 `create` 是函数）收窄；服务缺席/不兼容时一律视为
  `unavailable`。
- 公开只读 getter `worktreeIsolationAvailable` 供工具层判断是否渲染 worktree 相关提示；它也
  只反映"Host 当前是否组合了兼容服务"，不是配置项。
- 能力可在运行时出现/消失（插件行被 reload）；每次派发重新探测，不缓存跨 turn 的结论。

**调用时序与作用对象**

1. `sessionController.create({ workspaceId })` 创建普通 Session，并挂入 Workspace 账目；
2. 等创建返回的 Agent 已是 live（`ctx.agents.get(created.sessionId)`；这正是 `admitPrompt`
   已有的前提），取该 **子 Agent** 作为 worktree 服务的调用者；
3. 调 `worktrees.create(childAgent, {}, signal)`（名字由服务基于 Session id 生成并带随机
   后缀、基线 `HEAD`），
   服务内部对该子 Agent 执行 `workingDirectory.set`，把子会话的工作目录切进检出；
4. 之后才 `admitPrompt` 投递首条 prompt，因此子会话的第一个 turn 从 worktree 开始。

安全顺序的关键是"子会话在首个 prompt 之前是空白、不会自己跑 turn"，所以第 2/3 步与创建之间
不存在并发窗口；反过来先 prompt 再切目录会让首批工具调用落在共享 checkout，因此禁止。

**归属与路径影响**

- 服务改的是"有效工作目录"（`working-directory/change` 事件），**不改** Session header 的 cwd，
  因此 Workspace 成员关系、侧边栏分组、项目归属都不变；会话列表里的 `cwd` 仍是 Workspace 路径，
  隔离结果由 `DevLeadCreatedSession.isolation`（`path`/`branch`/`baseCommit`）单独上报。
- 默认位置 `<源 checkout 根>/.agents/worktrees/<自动名>`；未提交/暂存/未跟踪/被忽略的文件**不会**
  复制到 worktree。分支由 lead 审阅后自行 merge / cherry-pick，插件不自动合并。
- Git 操作在**子会话的 sandbox/file policy**下执行（`sandboxPolicy.resolve({ session: child })`）：
  子会话策略必须允许写检出目录与共享 Git 管理目录，否则创建失败。受限策略、非 Git 目录、
  重名分支/已存在的检出路径等都属于可预期失败（脏工作区本身不是失败原因，只是未提交内容不会
  被复制）。
- 隔离只适用于**新建** Session：已有 Session 的 header cwd 不可重挂，`attachSession` 也拒绝
  与 Workspace 路径不等的 cwd；已有会话之间靠串行化规避冲突。

**退化与诊断**

| 情形 | `isolation` 结果 | 行为 |
| --- | --- | --- |
| 未请求（默认） | `{requested:'none',status:'none'}` | 与旧行为完全一致 |
| 服务组合且创建成功 | `{requested:'worktree',status:'worktree',path,branch,baseCommit}` | 子会话在 worktree 中开始第一个 turn |
| 服务未组合 / 不兼容 | `{requested:'worktree',status:'unavailable',reason}` | 不抛错；Session 仍创建、仍 prompt，在共享 checkout 工作 |
| 子 Agent 非 live（防御性） | `{requested:'worktree',status:'unavailable',reason}` | Session 已创建；若同一次调用还要求 prompt，则走既有的 `DEVLEAD_SESSION_UNAVAILABLE`（发行版 controller 返回 live Agent，不会出现该状态） |
| 服务存在但创建抛错 | `{requested:'worktree',status:'failed',reason}` | 记 warning；Session 仍创建、仍 prompt；可能残留分支/检出（服务语义） |
| 服务返回畸形 checkout | `{requested:'worktree',status:'failed',reason}` | 记 warning；不把不完整 path/branch 当作成功结果；Session 仍创建、仍 prompt |
| isolation 期间取消 | 调用以 `AbortError` 拒绝 | Session 已创建且可能已 watch；不投递 prompt（见 §4 取消语义） |

`/devlead status` 始终打印 `Worktree isolation: available|unavailable`，人类与 E2E 都能直接
判断当前 profile 是否具备该能力。系统提示只在能力存在时教模型使用 `isolation: "worktree"`，
缺失时改为要求"同一 checkout 的写入型 Session 必须串行派发"，不会无条件声称支持。

## 5. 模型工具（`@yankeguo/dsh-tool-devlead`）

13 个主工具都带 `when: ({ agent }) => ctx.devLead.isEnabled(agent)`，只在 DevLead 会话可见；
`devlead_report` 是唯一的反向面：`when` 为 `ctx.devLead.isSupervised(agent)`，只在被唯一 active lead
关注的非 DevLead 会话可见（见下文「中途汇报工具」）。

| 工具 | 参数 | 返回（canonical JSON） |
| --- | --- | --- |
| `devlead_list_workspaces` | `{}` | `{ workspaces: DevLeadWorkspaceView[] }` |
| `devlead_list_models` | `{}` | `DevLeadModelCatalog`（default / routableProviders / providers / failures，精简） |
| `devlead_list_agent_presets` | `{}` | `DevLeadAgentPresetCatalog`（available / presets[id,name?,description?,default,broken?] / reason?） |
| `devlead_use_workspace` | `path`(必填，绝对路径), `title?`, `create?`(默认 false；显式 true 才 mkdir) | `{ workspace }` |
| `devlead_list_sessions` | `workspace?`(id / 注册路径 / 精确 title), `watched_only?`, `limit?` | `{ sessions, watched: string[] }` |
| `devlead_create_session` | `workspace?`(id / 注册路径 / 精确 title), `prompt?`, `title?`, `watch?`(默认 true), `preset?`(Host 定义 id；空白回退插件默认再 Host 默认), `isolation?`(默认 `none`；`worktree` = 尽力隔离), `provider?`+`model?`(成对；可选 `reasoning_effort?`), `agent_teams?` | `DevLeadCreatedSession`（含 `isolation`；请求时含已应用的 `model`/`agentTeams`） |
| `devlead_get_session` | `session`(必填) | `{ session, reports? }`（读取 lead 自身时携带最近 5 条 retained reports） |
| `devlead_prompt_session` | `session`(必填), `prompt`(必填), `watch?`(默认 true), `interrupt?`(默认 false；true = 先经 `workspace/session-stop` 停止运行中工作再投递；idle/cold no-op) | `DevLeadPromptedSession`（含 `interrupted`） |
| `devlead_watch_session` | `session`(必填), `watching`(必填 bool) | `DevLeadWatchMutation` |
| `devlead_notifications` | `limit?`(默认 20，分别作用于通知与汇报两个 digest) | `{ notifications, reports, watched: string[] }` |
| `devlead_report` | `message`(必填，≤4000 码点), `kind?`(默认 progress；progress/blocked/decision/question/fyi), `summary?`(≤200 码点) | `{ report, durable, queued, warning? }`（仅已关注非 lead 会话可见；`when: isSupervised`） |
| `devlead_remove_workspace` | `workspace`(必填，id / 注册路径 / 精确 title) | `{ workspace, removed }`（注销前快照） |
| `devlead_archive_session` | `session`(必填), `stop_running?`(默认 false) | `{ sessionId, archived: true, stopped }` |
| `devlead_unarchive_session` | `session`(必填) | `{ sessionId, archived: false }` |

要点：

- 输出 schema 用 `defineTool` 的 `ValueSchemaSpec`；`output.render` 把 canonical JSON 以文本
  返回（模型可读），`presentCall` 返回 `{ card: 'generic', title, kind }`（`kind` 取
  `read`/`search` 类似语义），只依赖已解析参数，保持 replay 纯函数。schema 与 protocol 视图
  类型有编译期一致性约束，运行时还会用编译出的 output schema 校验每个投影值（可选字段按
  lossless JSON 规则省略）。
- 参数里的 `workspace` 接受 Workspace id、注册路径或精确 title（解析顺序与歧义策略见 §4）；
  `session` 接受完整 id 或唯一前缀匹配；`session` 还接受
  省略 `session-` 前缀的 uuid 第一段/前缀（`views.ts` 的 `matchSessionIds`：例如 `e59ab350`
  解析到 `session-e59ab350-…`），只有在可寻址集合内唯一时才解析。同第一段的多个 Session 仍报
  `DEVLEAD_INVALID_INPUT` 并列出候选（最多 8 个），不猜；零命中仍报 `DEVLEAD_SESSION_NOT_FOUND`，
  但文案提示 id 可能不完整/被截断、用 `devlead_list_sessions` 查完整 id 后重试。五个
  `devlead_*` 工具的 `session` 参数描述与 `devlead_get_session` 的工具描述同步此口径。除
  `devlead_list_workspaces` 外的工具都要求 live 调用
  者（缺失时 `DEVLEAD_AGENT_NOT_LIVE`）；写工具（`devlead_use_workspace` /
  `devlead_create_session` / `devlead_prompt_session` / `devlead_watch_session` 与三个关闭
  工具）都在 core 中重新校验 live + 模式。`devlead_use_workspace` 0.2.0 起转发 live lead Agent
  给 core 的 `useWorkspace(agent, request, signal)`，`create` 默认
  `false`，仅当人类明确要求建目录时才传 `create: true`（工具 schema 与 policy 文案同步）。
- 关闭语义工具（共 3 个；0.2.0 时工具数 8 → 12，后续新增 `devlead_list_agent_presets` 后为 13 个主工具；本次另增 1 个 `devlead_report`，总计 14）：`devlead_remove_workspace` 执行 DSH **remove**：
  只注销 Workspace 记录，目录、文件与 Session 日志保留，其 Session 变未分组；返回注销前快照
  与 `removed`。`devlead_archive_session` 执行 DSH **archive**：日志保留、可恢复；带运行中
  工作（turn / subagent / job / schedule）的 Session 默认报 `DEVLEAD_SESSION_ACTIVE`，
  `stop_running: true` 时先写归档、再由 Host 的 `workspace/session-stop` providers 请求停止
  （不等待 settle），结果 `stopped: true`；已归档是 no-op（不检查活动、不请求停止，结果
  `stopped: false`）。`devlead_unarchive_session` 幂等恢复。
  lead 不能归档自己的 Session（`DEVLEAD_INVALID_INPUT`，提示人类在侧边栏操作），subagent
  Session 不在可寻址集合内、自然报 not found。授权口径是**判断式自主**（judgment-based
  autonomy）：合理收尾时模型可自行归档自己创建/派发且已完成的临时 Session、注销明显陈旧/
  重复/空置或由自己创建的 Workspace 注册，人类说"整理/收尾/清理"时自行定范围；边界是不关闭
  人类正在使用/对话的对象、不用关闭掩盖失败或跳过汇报、不做无关大范围清理；清理时优先归档
  已完成的 Session、保留其 Workspace 注册，注销影响面更大所以仅限陈旧/重复/空置/自己创建；
  `stop_running` 等于主动取消运行中工作；每次自主关闭都要汇报关闭了什么、为什么、影响面
  （哪些 Session 变未分组、是否停止运行中工作）与可恢复性。
- lead policy 明确「按需介绍」：创建/继续一个已关注 Session 时，仅当是长任务且途中节点对调度
  重要，简报才邀请它用 `devlead_report` 发真实阻塞/需 lead 决策的分叉/等待会影响调度正确性的
  关键进展；短线性任务不邀请，不强制每条简报都写，`watch:false` 时工具不可见所以不要写；报告是
  单向的，不替代最终 turn 通知。子会话侧 policy 与工具描述同时收窄调用范围：turn 结束自带通知，
  常规进度/最终总结不得用 report 重复播报；report 只用于长任务途中 lead 必须在轮次结束前知道的
  关键节点，短任务/线性任务默认不调用。
- **中途汇报工具** `devlead_report` 是唯一不要求 DevLead 模式的工具：`when` 为
  `ctx.devLead.isSupervised(agent)`（非 enabled + 唯一 active lead 的 watch），schema 只有
  `message` / `kind?` / `summary?`，没有 target。kind 含 `question`（lead 用新 turn 回答）；
  普通 report 单向、不等待回复、最终 turn 仍走原通知、每轮最多 4 条不同普通报告、同轮相同
  kind+消息幂等，`question` 不计入该预算。执行转发 `reportProgress` 并把 receipt 投影成
  `{ report, durable, queued, warning? }`（durable 为真才代表已落 durable outbox；queued 表示 lead receipt 尚未 flush）。`devlead_get_session` 读取 lead 自身时额外返回 `reports`（最近 5 条），
  读取其他 Session 时输出形状不变。参数长度/kind 由 core 再校验，错误码 `DEVLEAD_INVALID_INPUT` /
  `DEVLEAD_NOT_SUPERVISED` / `DEVLEAD_REPORT_RATE_LIMITED` 由统一翻译层转成 `HarnessError`。
- **watched 子会话问题闸门**：`registerQuestionRouting` 在根上下文监听 `tools/pre-execute`；
  watched 非 lead 子会话的 `ask_user_question` 被格式化为 `kind: 'question'` report 后 deny
  （详见 §4.1.3）。它不注册新工具、不新增错误码；人类正在直接对话的子会话与未关注会话放行。
- `systemPrompt` 另注册 `devlead:report-policy` 段，条件为 `ctx.devLead.isSupervised(agent)`；
  文案明确单向汇报、普通 report 每轮 4 条与限流错误码、`question` 是受支持提问通道、直接
  `ask_user_question` 会被拦截转给 lead。lead 的 `devlead:policy` 增加接收
  `[DEV LEAD REPORT]`（尤其 `question`）后的处理口径（自行回答或代问人类，再用
  `devlead_prompt_session` 转回；普通报告按需 steering）。
- 工具把领域失败翻译成 `HarnessError(message, code)`；需要调用者的工具在 `exec.agent` 缺失
  （条件可见性被绕过）时也走结构化错误 `DEVLEAD_AGENT_NOT_LIVE`，基础设施错误原样重抛。所有异步写调用转发
  `exec.signal`（`create_session` / `prompt_session` / `watch_session` / `remove_workspace` /
  `archive_session` / `unarchive_session`），读调用同样转发。
- `systemPrompt.section({ name: 'devlead:policy', order: TOOL_SUBAGENT, text: ({ agent }) =>
  ctx.devLead.isEnabled(agent) ? POLICY : '' })` 提供 DevLead 行为指导：依据注册元数据判定
  归属、默认调度而非亲自实现（写入归归属 Workspace 的 Session，本 Workspace 也默认派发；
  lead 自己仓库的记录类文件可依仓库说明直接维护）、**只读检查严格限于有界可行性判断**
  （归属、当前行为与目标结果的高层事实、验证方式；不读完整模块、不做完整复现/根因分析、不预先
  设计实现方案），简报允许带开放问题、进一步细化调研与实现交给 Session、已有同请求 live
  Session 时续写而不是重复创建、未注册归属先问或注册、无空会话、创建时模型/Agent Teams 的
  简短提示（默认继承 Host 模型、需要 pin 时先查 `devlead_list_models`、Team 由 lead 按任务
  判断、仅创建时生效、不改 profile 默认），以及工作流、通知处理、汇报格式；每次组装按
  当前 Agent 重新求值，关闭模式后下一步即消失。`devlead_create_session`
  的工具描述与 `workspace`/`prompt`/模型/Agent Teams 参数说明同步强调「把工作派发到归属
  Workspace 的 Session、简报可带开放问题」，避免模型把「创建 + prompt」当成本会话的直接实现入口。
- 派发后的等待契约（模型可见文案）：派发是异步的，`devlead_create_session` /
  `devlead_prompt_session` 返回后模型不得在同一个 turn 内等待——不得用 shell `sleep`，不得用
  `devlead_list_sessions` / `devlead_get_session` / `devlead_notifications` 轮询，也不得用
  Agent Teams 的 `wait_agent` 等被派发的 Session；正确做法是**结束本轮**（end the turn）。
  子会话继续独立运行，已关注会话的 turn 结束后运行时以**新 turn** 恢复本会话（冷 lead
  默认 resume，见 §4.1）；读工具只用于唤醒之后或人类明确询问时的状态检查，永远不是等待
  机制；人类期望唤醒前就得到答复时，模型先说明已派发、将在唤醒结果到达时汇报。
  `devlead_create_session` 描述自身回答「派发后我该等吗」，`devlead_prompt_session` /
  `devlead_list_sessions` / `devlead_get_session` / `devlead_notifications` 描述同步声明不要
  把它们当等待手段。
- **创建时模型 / Agent Teams**：`devlead_list_models` 暴露真实模型目录供 pin 前查询（只读、
  精简）。默认**继承 Host 默认模型**：仅当人类明确要求或简报需要成本/能力路由、可复现性时才
  传 `provider`+`model`+可选 `reasoning_effort`；成对/effort 规则与创建前校验同上，不可用报
  `DEVLEAD_MODEL_UNAVAILABLE` 并提示先查 `devlead_list_models`，且不创建 Session。成功后
  在子 Session 的 Agent 上 `model.select`（durable `model/selection`），不触碰 profile 默认；
  `agent_teams` 由 lead 自主判断（复杂/多步/并行可开，简单线性省略，人类明确开/关照做），
  显式 true/false，缺服务时 true 报 `DEVLEAD_TEAM_UNAVAILABLE`，false 视为已关闭，省略不动
  Host 默认；Team 用 `agentTeams.setEnabled` 追加 durable `team/mode`。两者 creation-time
  only，工具描述与 policy 同步说明；结果只在请求时带 `model`/`agentTeams`。
- `isolation` 参数只接受 `'none'` / `'worktree'`（其余报 `DEVLEAD_INVALID_INPUT`），默认不发；
  结果 schema 含必填 `isolation` 对象（`requested` 必填 `none|worktree`；`status` 必填
  `none|worktree|unavailable|failed`；可选 `path`/`branch`/`baseCommit`/`reason`；0.2.0 起
  `isolation` 是 `DevLeadCreatedSession` 的必填字段）。工具描述写明"默认 none、`worktree`
  是尽力而为、缺少能力时结果里如实上报而不是报错"。
- policy 文案变成能力条件化：仅在 `ctx.devLead.worktreeIsolationAvailable` 为真时追加「并发
  写入型 Session 用 `isolation:'worktree'` 隔离；会话仍属原 Workspace；文件在新分支
  `<checkout>/.agents/worktrees/<name>`；未提交改动不复制；由 lead 审阅/合并该分支；结果为
  unavailable/failed 时改串行」；为假时追加「没有 worktree 隔离；同一 checkout 的写入型
  Session 必须串行派发」。每次组装按当前 Agent 与当前能力重新求值，不会无条件声称支持。

## 6. 人类命令（`@yankeguo/dsh-command-devlead`）

`/devlead` 语法：

```
/devlead                  # 状态：模式状态、worktree 能力、关注的会话（标题/状态）、最近通知/汇报、帮助
/devlead on               # 打开当前会话的 DevLead 模式
/devlead off              # 关闭；fold 冻结时也会强制关闭并清理冻结状态（见下）
/devlead reset            # 人类专属恢复：丢弃该会话的全部 DevLead 持久状态并回到默认 disabled
/devlead watch <session>  # 关注某个会话（完整 id / 唯一前缀 / 省略 session- 的 uuid 前缀）
/devlead unwatch <session>
```

- 语法解析严格按 DSH 的 `CommandInvocation.rawInput` 契约：值 = 命令名之后的文本（可能带分隔
  空白），**不接受**完整命令行；多余参数、未知子命令、空参数、成对/不配对引号都有明确错误。
- 状态输出用普通文本行（`CommandResult { kind: 'success', text }`），且模式 / 关注集合 /
  通知摘要来自**同一次 projection 读取**，避免列表 await 期间看到更新的 digest 与更旧的
  watch 行。状态固定包含 `Worktree isolation: available|unavailable`（读
  `ctx.devLead.worktreeIsolationAvailable`），让人类与 E2E 直接看到 Host 是否组合了可选的
  worktree 隔离能力；该行只是能力说明，不改变任何状态。
- Session 寻址先用有界列表 + 关注集合给出带标题的候选；**前缀引用（非精确 id）** 还会再用
  core 的穷尽 resolver 确认唯一性，然后才执行 watch/unwatch，避免列表窗口外的同前缀 Session
  被静默遮蔽（精确 id 直接命中，不走额外读取）。core resolver 也接受省略 `session-` 的 uuid
  第一段，因此 `/devlead watch e59ab350` 这类截断输入会经由该回退解析到完整 id；同第一段的
  歧义与缺失仍由 core 的错误文案转为友好提示。
- `on` 需要当前 Agent live；`off` 立即生效（正在投递的通知保留在日志里）。
- **损坏 fold 的恢复（0.2.0）**：`/devlead reset` 调用 core 的 `reset(agent)`，追加一条
  `plugin:devlead/reset` 记录，三个 projection 的 fold 都从空状态重新开始（模式关闭、watch
  集合与通知 digest 丢弃、`failure` 清除）；它不要求模式开启，是冻结状态下唯一能写日志的
  命令，也就是人工修复坏记录的路径。`/devlead off` 在折叠冻结时也会成功：handler 先读
  view，若抛 `DEVLEAD_PROJECTION_INVALID` 且请求是 off，直接调
  `ctx.devLead.setEnabled(agent, false)`（core 走 reset 恢复），再用新快照渲染；`on` 仍返回
  带 `/devlead reset` 提示的友好错误，避免隐式丢弃人类可能还想检查的记录。恢复后投影回到
  默认 disabled、关注关系索引清空（需要重新 watch），持久日志里的旧记录保留但不再 fold。
- **标题与正文一致（并发）**：`executeMode` / `executeWatch` 在变更后重新取一次快照，标题由
  该 post-mutation 快照的真实状态派生、正文永远来自同一快照；并发（另一个命令/UI 开关在
  期间改变状态）时输出形如 "DevLead mode is off (another command changed it)."，不会出现
  "标题说已关闭、正文显示开启" 的分裂。
- 附件由 `CommandRuntime` 在 handler 之前拒绝（定义不声明 `input.attachments`），handler 不
  重复实现该策略。
- 全部领域错误码都映射成可操作的友好文本；`DEVLEAD_*` 新增码会让穷尽 switch 编译失败。
  `DEVLEAD_PROJECTION_INVALID` 的文案明确说明"记录损坏、状态无法读取"并提示运行
  `/devlead reset`（同时说明会丢弃关注集合与通知 digest）。
- UI 开关只调用 `/devlead on|off`（`ctx.remote.commands.execute`），因此命令是唯一的人类入口。

## 7. 浏览器 UI（`@yankeguo/dsh-client-ui-devlead`）

状态条在原有最新通知 chip 之外合并 `projection.reports` 的最新一条：按 `at` 比较通知与
report，新者胜出；report chip 显示 sender、`report.kind.*` 本地化 kind、summary 或 message
摘要，tooltip 为 `reportLine`，并以 `data-report-kind` 提供 kind 色点。这样 UI 无需新增通道就
能看到最近一次中途汇报，同时保留原有 transition chip。

UI 有一个开关、两种状态，避免在每个会话上显示常驻条：

- **两种状态都存在**：`conversation.input.left`（composer 工具条，权限下拉旁）里一个 ghost
  图标 + 可见 DevLead 文本按钮 `DevLeadIconToggle`。它只读 projection，projection 未加载时
  不渲染；`enabled=false` 时点击发送 `/devlead on`，`enabled=true` 时点击发送
  `/devlead off`。按钮在两种状态下保持同一位置、28px 内容高度与自适应宽度（本地化
  `DevLead` 文本来自 locale，不占用固定方形 seat），`aria-label`/tooltip 随状态切换；
  pending 时禁用并置 `aria-busy`，
  失败时按钮保留原位，错误文本进入 tooltip、aria-label 和隐藏的 `role=status` live region
  （toolbar 没有内联错误位）；失败态 tooltip 点击/触摸可固定阅读，便于无 hover 设备。
  按钮不会自行翻转状态。
- **已开启**：`conversation.input.dock`（composer 上方）里的只读 `DevLeadBar`。
  - `useProjection('devLead')`：`undefined`（加载中）或 `enabled=false` → 不渲染；
    `enabled=true` → 已关注会话数/运行中数（标准 props `useSessions`/`useSessionStatus` 与
    projection 的 `sessions` 计算）+ 最近一条通知摘要 + 帮助提示。状态条不含 Switch，也不
    调用命令；关闭模式时它从 projection 消失，但工具条开关仍在原位——不会出现“开关把自己
    藏起来”的交互。
  - `Button`/`Tooltip` 组件来自 `@deepseek-ai/dsh-client-ui-primitives`；样式走本插件
    注入的 `<style>` 标签（`ensureStyleTag`），颜色只用 DSH theme 中真实存在的 `--dsw-*`
    token 并提供中性 fallback；状态条采用 shell 的 menu-surface 模式（无重复 hairline、
    `--dsw-menu-backdrop-filter`），宽度按 composer dock 的 side-clearance / dock-inset 公式。
    `ensureStyleTag` 用**跨模块实例**的引用计数（`Symbol.for(...)` 为 key 的
    `globalThis` 单例 `{ refs, element }`）：首个实例创建 `<style>`，后续实例复用并刷新 `textContent`，每个
    disposer 递减，归零才移除。这样 HMR 新旧模块实例交替时，旧实例如的 disposer 不会删掉新
    实例仍在使用的标签。
  - 工具条开关使用准入状态机：纯函数 gate + reducer（`results.ts`）+ 薄 React hook
    （`useDevLeadAdmission.ts`）——同渲染周期双击只会提交一条命令，未挂载后不再 setState，
    模式变化会作废旧失败提示。准入门面把 `ok:true` 但 `value: undefined`（Host 没有解析到
    命令）也当作失败（`unresolved`），不会把死入口当成功。0.2.0 起这两个组件与 hook 有
    **React 渲染测试**（`react-test-renderer`，devDependency，纯 node、无 jsdom）：用 `act`
    驱动，覆盖状态条只读且无开关、开关两态的可见 DevLead 文本 / label / 命令、SR live
    region、pending 禁用、开启/关闭失败文案，以及 hook 的单击提交、双击单次提交、卸载后不
    setState、失败保留与 `resetKey` 清空。
  - `role=status` live region 覆盖状态条提示 / 最新通知，以及工具条开关的开启/关闭失败文本，
    保证屏幕阅读器能听到通知与错误；`aria-busy` / label 与 pending 状态一致。
  - 开关不随状态条出现/消失而消失；同一时刻只有一个模式开关。
- **侧边栏会话行标记**：
  - **当前激活的 lead** 行用 `::after` overlay 画 business-accent ring（1px border + 轻
    outer halo），颜色与 composer 工具栏开关一致，不增加 padding/margin/height，因此 32px
    行盒、标题省略和布局不位移；**不再显示行尾图标**，active 事实由 ring + hover 文案 +
    视觉隐藏的 aria status 表达。
    根因：shell 行只有 `border-inline: 3px solid transparent`（`--dsh-sidebar-paint-inset`，
    上下 border 为 0）。给行加 `border-color` 会让左右多出 3px 色条；`inset box-shadow` 又被
    裁到 padding box，左右同样内缩 3px、上下不缩，二者都会造成左右/上下视觉不一致。因此
    overlay 用 `inset: 0 calc(-1 * var(--dsh-sidebar-paint-inset))` 对齐**border box**，四边
    同宽、`border-radius: inherit`，绝不改 row 的 border/padding/height。实现只能走 CSS：shell
    的行是 `<div data-row-key="session:<id>">`，没有行级装饰 slot；插件用
    `[data-row-key^="session:"]:has([data-devlead-active-mark="true"])` 限定在会话行，不靠
    哈希类名。
  - **被当前 lead 关注的普通 Session** 在行尾显示弱化准星图标
    （`IconGoalOutlineRegular`，13px；`sidebar.session.row.trailing`；非交互、不绑定/不激活
    Session），谓词读 lead 的 summary 级 `devLeadWatch`，不读被排除的 digest，也不给被关注
    会话写日志；cold 行/重启 cache 行同样成立。未 watched 不渲染。
  - `:has` 依赖 shell 的稳定 `data-row-key` 属性（`Rows.tsx` 明确写入）；`:has` 在目标 Web
    浏览器可用。trailing seat 在悬停/聚焦时被 shell 隐藏，但 mark 仍挂载在 DOM 中，所以
    `:has` 的 active ring 不会在 hover 时消失；`sidebar.session.row.hover` 另提供
    「已关注/激活 DevLead」说明（i18n `row.watched.aria` / `row.hover.watched` /
    `row.mark.aria` / `row.hover.enabled`）。active 行视觉隐藏的 status 仍带
    `aria-label`，屏幕阅读器不依赖边框或颜色。
  - rc.1 对 blank（尚无 turn）行不渲染 trailing seat：空白新会话上的标记/hover 说明要等第一次
    turn；active ring 也随 mark 无法显示，这是 shell seat 限制。搜索视图复用另一套结果行，同
    样不挂载该 seat；搜索期间不显示 active/watched 标识。
- i18n：namespace `devlead`，`zh`/`en` 词典；`locale/zh.json`、`locale/en.json` 提供
  `meta.title`/`meta.description`（插件市场展示）。
- 客户端 bundle 构建：esbuild CJS + `window.__ModuleLoader__.load({ id, factory })` 包装；
  external 列表唯一来源是 `scripts/client-externals.mjs`，必须与 DSH shell 的 platform
  seed（`packages/client/web/src/{platform,seed}.ts`）逐项且同序一致；构建期守卫会让任何
  module-table 之外的 `@deepseek-ai/*` 浏览器导入直接失败。
- 包 `package.json` 的 `dsh.client.inject` 列出运行期依赖（api-remotes、api-session-controller、
  client-locale、client-ui-conversation、client-ui-primitives、client-ui-renderer、
  client-ui-session、client-ui-workspace），`platform: "web"`。`client-ui-workspace` 只以
  type-only 导入进程序（取 Session 行 seat 的 SlotMap 声明），构建期 module-table 守卫不会
  把它当成浏览器运行期依赖。loader 只对真实 client entry 的 inject 名字做工厂等待，platform
  module 名字（如 primitives）会被忽略；`check-packages.mjs` 断言 `@deepseek-ai/*` 浏览器
  导入全部落在 module table 内，并校验 `dsh.client.inject` 与 root devDeps / module table 的
  一致性。

## 8. 稳定错误码

| code | 含义 |
| --- | --- |
| `DEVLEAD_INVALID_INPUT` | 参数不可用：空 prompt、相对路径、文件路径、空引用、`limit` 非法、前缀歧义、非法 prompt 目标、空/超长 report message、超长 summary、未知 report kind 等 |
| `DEVLEAD_NOT_ENABLED` | 当前会话未开启 DevLead 模式 |
| `DEVLEAD_ALREADY_ACTIVE` | 另一个 Session 已占用 Host 级 DevLead 模式；消息含占用者 `title (id)`（或裸 id）与“先 /devlead off”的指引。**archived 占用者不再抛出该错误**：它被视为非 active，准入继续；`/devlead status` 会列出并给出 unarchive + off / 删除路径 |
| `DEVLEAD_NOT_SUPERVISED` | 当前 Session 不是「非 DevLead + 被唯一 active lead watch」；包括自身是 lead、lead off/归档、unwatch、或历史多 watcher 无唯一关注该会话的 active lead |
| `DEVLEAD_REPORT_RATE_LIMITED` | 已关注 Session 同一 turn 已发送 4 条不同的**非 question** 报告；`question` 报告不计入该预算；同轮相同 kind+message 幂等，不计数 |
| `DEVLEAD_AGENT_NOT_LIVE` | 传入的 Agent 不是注册表中的 live 实例（工具侧绕过 `when` 时也走该码） |
| `DEVLEAD_WORKSPACE_NOT_FOUND` | 指定 Workspace 引用无法解析，或 Host 未组合 Workspace registry；消息说明 id / 注册路径 / 精确 title 三种寻址方式 |
| `DEVLEAD_WORKSPACE_AMBIGUOUS` | 引用按精确 title 命中多个 Workspace；消息按 registry 顺序列出每个候选的 `id (path)`，要求改用 id 或注册路径 |
| `DEVLEAD_DIRECTORY_MISSING` | 目录不存在且未显式允许创建（文案提示 retry with `create: true`），或允许创建但创建失败 |
| `DEVLEAD_MODEL_UNAVAILABLE` | 请求的 provider/model/effort 不可用：Host 未组合 LLM registry、provider 未注册、model 不在该 provider 当前可用列表、或 `resolveCallConfig` 拒绝；消息含完整 route |
| `DEVLEAD_TEAM_UNAVAILABLE` | 请求 `agent_teams: true` 但 Host 未组合 Agent Teams 服务，或应用 Team 模式失败；消息说明该能力自 DSH 0.2.2-rc.2 起提供/默认组合（rc.1 上可预期），应用阶段还带出已创建的 sessionId |
| `DEVLEAD_SESSION_NOT_FOUND` | 指定 Session 不存在（含 Host 侧 `session/not-found` 映射） |
| `DEVLEAD_SESSION_ARCHIVED` | Session 已归档，不能续写 |
| `DEVLEAD_SESSION_ACTIVE` | Session 仍有活动（turn / subagent / job / schedule），未传 `stop_running` 时拒绝归档；消息列出活动种类（item 最多 3 条） |
| `DEVLEAD_SESSION_UNAVAILABLE` | 无法 resume / 没有 sessionController / 没有 create 能力 / followup 被拒 |
| `DEVLEAD_WATCH_LIMIT` | 关注集合超过上限 |
| `DEVLEAD_SELF_WATCH` | `watchSession` 试图关注自己（`promptSession` 向自己投递使用 `DEVLEAD_INVALID_INPUT`） |
| `DEVLEAD_PROJECTION_INVALID` | 持久记录损坏（fold failure）；人类可用 `/devlead reset`（或冻结时的 `/devlead off`）恢复，`setEnabled(true)` 会拒绝并提示先 reset |

取消（`AbortSignal`）不映射到上面任何码：调用按标准 `AbortError` 拒绝。

## 9. 测试策略

- `protocol`：格式化 / excerpt 边界（码点预算、代理对、非法预算）/ 转场表 / 持久记录词表 /
  projection map 类型增强与 summary 排除等纯函数与类型契约。
- `devlead`：真实 `SessionStore` + 真实 `SessionProjectionRegistry`（service spec；notification
  hub spec 直接用 fold 读取状态，见 §4.1），只把 `agents` /
  `workspaceRegistry` / `sessionController` / `sessionTitle` / `sessionQuery` 换成内存 fake，
  因此每次持久写、日志事件、projection drive 与监听器派发都按生产方式跑。覆盖严格解码器
  （字段漂移 / 缺失字段 / 时间范围）、fold identity 复用、fold **reset 解冻**（合法 reset
  清空状态、坏 reset 不解冻、reset 后记录正常 fold）、通知泵（合并窗口 / 去重 / 重试 /
  冷会话 / 归档 / dispose / 零延迟代际守卫 / **queued notice 保留与 1s recheck**）、
  **冷 lead 索引重建**（`FakeSessionQuery` + `FakeProjectionCache`：cache 预筛 enabled /
  disabled、精确折叠遇损坏记录跳过 + warning、live 无 Agent 也索引、`wakeColdSession` 默认
  true 时 resume；**corpus-readiness barrier**：等待 optional persistence 绑定、stale corpus
  等到一致、永不就绪时 warning + best-effort、readiness 扫描只做一次、query engine 晚到、
  无 projection cache 只恢复 live、persisted scan 抛错不阻加载）、Workspace 与 Session 编排、
  列表排序与截断、列表窗口外的身份解析、**截断 Session 引用解析**（完整 id / `session-` 前缀
  部分 id / 裸 uuid 第一段 / 裸完整 uuid / 首尾空白；同第一段歧义列候选且不猜、零命中给出
  可恢复提示、subagent origin 仍不可寻址）、
  **promptSession 自动 watch 的补偿语义**（admission/resume 失败与取消时移除本次新增、
  已 watch 不受影响、`watch:false` 不变）、**prompt interrupt**（运行中目标派发
  `workspace/session-stop`、idle/cold no-op、stop provider 失败不阻塞投递、被中断 turn 的
  aborted 通知）、**watched 问题路由**（问题格式化、人类直聊豁免、未关注/lead 放行、
  `tools/pre-execute` 转发后 deny、转发失败降级、`question` report 绕过普通 report 预算）、
  写路径的取消语义，以及可选 worktree 隔离的两种
  形态（fake `ctx.worktrees` 存在时按"创建→隔离→prompt"顺序调用子 Agent 的 `create`；
  缺席/畸形/抛错时降级为 `unavailable`/`failed`，Session 仍创建并 prompt，绝不抛错），以及
  可选 Agent preset roster 的映射（`defaultId` 标记、无 id 行丢弃）与缺席/空/读取失败路径；
  **全局单活**（第二会话被 `DEVLEAD_ALREADY_ACTIVE` 拒绝且消息含占用者、并发 on 只成功一个、
  off 立即释放、archived 占用者释放、启动时多个 live enabled 只保留一个、冷持久占用者拒绝
  新开启、冷占用者删除后释放、archived 冷占用者经 controller resume 后释放、无法 resume 时的专门文案）。另有独立
  `active.spec.ts` 覆盖 `lastEnabledAt`（reset/坏记录）、`rankActiveSessions` 的确定性排序、
  `activeSessionLabel` 与两种 refusal 文案。
- `tool`：用 fake `ctx.devLead` + fake `ctx.tools`/`ctx.systemPrompt` 捕获工具定义，验证
  `when` gating、参数校验、值渲染、编译期 schema↔protocol 一致性、运行时 output schema
  校验、错误翻译、13 个主工具 + 1 个汇报工具的 execute 转发与取消信号转发（含 `listAgentPresets` 的 roster /
  unavailable / 失败投影）、presentCall replay 纯净性，以及
  policy 文案的角色边界契约（默认调度、写入归属、归属未明时先问或注册、无空会话）与派发后的
  等待契约（结束本轮、不 shell `sleep` / 不轮询 / 不用 `wait_agent`、唤醒以新 turn 恢复本
  会话、读工具不是等待机制，`devlead_create_session` 等工具描述自身回答「派发后我该等吗」）；
  另覆盖 `isolation` 参数映射与非法值、创建结果四种 `isolation` 状态的投影，以及 policy 按
  `worktreeIsolationAvailable` 真/假两种形态的条件文案。
- `command`：解析（rawInput 契约 / 引号 / 空白 / 未知子命令 / `reset`）、前缀寻址（唯一 /
  歧义 / 缺失 / 列表窗口外回退）、渲染、穷尽错误码映射、单次 projection 快照、`/devlead reset`
  的恢复渲染、`/devlead off` 在冻结状态下恢复、`/devlead on` 在冻结状态下返回带 reset 提示的
  友好错误、`DEVLEAD_ALREADY_ACTIVE` 的占用者文案透传，以及并发变更时 title/body 来自同一
  post-mutation 快照；状态里的
  `Worktree isolation: available|unavailable` 行也按 fake 能力断言。
- `client-ui`：纯函数（format / 准入状态机 gate+reducer / results 分类 / 样式 token 契约 /
  侧边栏行标记 predicate / locale 完整性与占位符一致）；组件保持薄，逻辑都下沉到可测纯函数。
  0.2.0 起另有 **React 渲染测试**（`react-test-renderer`，devDependency，纯 node、无 jsdom，
  组件把 `useProjection`/`useSessions`/`useSessionStatus` 作为 props 传入，因此只 mock
  `@deepseek-ai/dsh-client-ui-primitives`）：覆盖 DevLeadBar enabled/disabled 且无开关、
  SR live region 与 label、DevLeadIconToggle 两态 label/命令、pending 禁用、开启/关闭失败
  文案与隐藏失败活区，SessionMark/HoverMark，以及 `useDevLeadAdmission` 的单击提交、双击
  单次提交、卸载不 setState、失败保留与 `resetKey` 清空。`ensureStyleTag` 的跨模块实例引用计数用
  `vi.resetModules()` + 动态 import 模拟第二个模块实例，断言旧实例 dispose 后标签仍在、
  全部 dispose 后移除。
- 全仓 `pnpm typecheck && pnpm test && pnpm build` 是 `pnpm verify`；`pnpm check:packages`
  校验包不变式；`pnpm e2e` 是本机真实 DSH 的端到端冒烟（见 §10）。

## 10. 部署与验证

- `pnpm build` → `pnpm install:profile [--profile desktop]` 链接包并选中 bundle（包符号链接
  同时充当 linked roots）；profile HMR 加载 host 插件，刷新 Web 页面加载浏览器插件。
- 开发 / 手动 E2E 用绝对路径 overlay，必须先准备一个**专用 profile**（默认 `web` 通常不存在；
  已启用本 bundle 的 profile 会因 loader row id 重复被拒绝）：

  ```sh
  dsh devlead --from-default-profile web --dump-config   # 一次性创建
  pnpm dev:patch --profile devlead                       # overlay + linked root
  dsh --profile devlead --patch .tmp/cordis.patch.yml --no-open --port 34000
  ```

  `dev-patch.mjs` 写 `<profile>/node_modules/devlead-repo -> 本仓库`（linked root）；缺了它
  会在第一次写 Session 插件记录时报
  `gateway/internal: Receiver must be an instance of class Session`。`--no-link` 仅供检查。
- 自动化验收：`pnpm e2e`（默认 `--flow patch`；`--flow installed` 走 install-profile 流）在
  `os.tmpdir()` 下的隔离 `DSH_HOME` 启动真实 DSH Web，用浏览器同款 HTTP API 断言：client
  plugin 进入 boot graph、`/devlead` 命令注册、`devLead` projection 默认值、summary 不携带
  digest 的 `devLeadMode` 行、`on/off` 翻转、真实子会话关注、已关注会话 `turn/end` →
  持久通知 → 投影可见、以及自 watch 拒绝。子会话的 provider/infrastructure 凭据按名称模式
  清除，因此 turn 稳定以 provider error 结束（真实 `turn/end`，不花 token）；实例在结束时
  按 PID 关闭。该命令只在本地跑，CI 不含。**0.2.0 起 E2E 分多个阶段**（同一条 scratch root /
  profile；阶段 1 与 1b 还共享同一个一次性 `DSH_HOME`，实例按阶段启停、从不并存）：阶段 1
  走完默认组合断言（发行版默认 Web 组合，额外断言 `/devlead status` 里
  `Worktree isolation: unavailable`，证明可选能力缺席时插件照常工作，并把 enabled 模式 /
  关注集合 / digest 留在持久日志里）；阶段 1b 用**同一加载流、同一 scratch home 重启**，
  验证冷 lead 索引重建（冷 lead 投影从持久日志折叠、冷子会话被 resume、重启后的
  `turn/end` 产生新通知、`/devlead status` 与 `/devlead off` 在 resume 后正常），这是 D2 的
  端到端证据；阶段 2 停掉实例 → 向 profile 的 `dsh.profile.bundles` 追加
  `@deepseek-ai/dsh-experimental-forge-bundle`（官方 app 内置 inventory 可解析，无需 pnpm
  安装）→ 用同一加载流叠加 probe patch 重启 → 通过 probe 命令调用
  `ctx.devLead.useWorkspace` + `createSession({ isolation: 'worktree' })`，断言
  `Worktree isolation: available`、结果 `status:'worktree'` 且 `path`/`branch`/`baseCommit`
  非空、`git worktree list --porcelain` 与 `refs/heads/<branch>` 存在、`baseCommit ==
  git rev-parse HEAD`、子会话有效工作目录切到 worktree 而 header cwd 不变、Session 仍归属原
  Workspace，然后停实例。probe 是私有测试资产 `scripts/e2e-probe/**`
  （`@yankeguo/dsh-devlead-e2e-probe`，0.0.0），不发布、不进 workspace/build/check-packages；
  scratch workspace 被初始化成真实 git 仓库（一次 seed commit），因此是真实 Git happy path。
  阶段 3 停实例 → 链接同一个 probe 包并叠加 probe patch 重启（关闭工具不需要实验 bundle，
  因此 `--no-worktree` 也会运行）→ probe 的 `devlead-e2e-inspect` 用真实
  `ctx.tools.resolve` 报告该 Agent 一步可见的工具集（模式开启时恰好 13 个主 `devlead_*`，已关注子会话恰好 1 个 `devlead_report`，
  模式关闭时为 0），用 `ctx.systemPrompt.assemble` 取 `devlead:policy` section（判断式自主
  关闭、安全边界、有限可行性判断/开放问题/深挖交接；关闭时为空文本）；`devlead-e2e-close`
  通过 `ctx.devLead` 归档一个已 prompt 的子会话（durable archive 集合 + archived 视图/列表行、
  重复归档幂等 `stopped:false`、unarchive 恢复且 `sessionQuery` 读到的持久日志事件数不变），
  再用临时 `workspace/session-activity` provider 让活跃会话被 `DEVLEAD_SESSION_ACTIVE` 拒绝，
  `stop_running` 归档并观察到 Host `workspace/session-stop` 派发，最后验证 lead 自归档报
  `DEVLEAD_INVALID_INPUT`；随后注销 scratch Workspace（注册表移除、目录/标记文件/Session
  日志仍在、Session 变未分组）并重新注册同一目录（新 Workspace id、不继承旧 Session）。
  `devlead-e2e-dispatch` 读取真实 `ctx.devLead.listModels` 的精简目录（default/providers/
  failures，无凭据时 providers 为空也如实上报）、`controller.modelCatalog()`（目录为空时回退到
  部署默认 route 再尝试）与 `agentDefaultModel`：创建“模型固定 / Agent Teams / 显式关闭 / 省略设置”四类子
  Session，断言结果字段、子 Agent `model.current()`、durable `model/selection` 与 `team/mode`
  事件、省略时结果字段不出现、不可用 model id 在创建前报 `DEVLEAD_MODEL_UNAVAILABLE` 且不新增
  Session、profile 默认模型前后完全一致；若 Host 无 provider 凭据导致模型目录为空，正向模型
  检查记为 **SKIP** 并报告原因（不伪造），Team 与负路径仍真实校验。Team 分支按运行时版本
  自适应：rc.1（默认组合无 `agent-team`）断言 `agent_teams:true` 报 `DEVLEAD_TEAM_UNAVAILABLE`
  且不创建 Session、错误文案含 rc.2 要求、显式 false 仍可用；rc.2+ 断言启用成功、durable
  `team/mode` 与 false 关闭。版本与探测不一致会直接失败（rc.1 出现服务或 rc.2+ 缺少服务都能
  暴露）。
  patch 与 installed 两条加载流都跑完整多阶段；`--no-worktree` 跳过阶段 2（阶段 1、1b、3 仍
  运行，调试用）。两条加载流完整组合的计数为 **146/146**（阶段 1 27 + 阶段 1b 12 + 阶段 2 23
  + 阶段 3 84，阶段 3 含 agent preset roster 与 watched-Session 问题路由检查）；跳过阶段 2 时
  **123/123**（阶段 1 + 1b + 3）。
- 本轮最终验证数字（工作树，0.2.6+ 工具面审计轮，见 [AUDIT](AUDIT.md) §12）：`pnpm verify` =
  typecheck 通过 + **26 文件 / 821 tests** + 7 个构建产物；`node scripts/check-packages.mjs` →
  `OK (6 packages)`；E2E 在安装版 rc.5 实跑 installed 与 patch **完整双流各 146/146**
  （phase 1 27 + 1b 12 + 2 23 + 3 84）。
- **DSH 版本兼容矩阵（本轮真实 E2E，npm 临时安装 CLI + `DSH_BIN`）**：

  | DSH | flow | checks | Team 分支 / 其他 |
  | --- | --- | --- | --- |
  | 0.2.2-rc.1 | installed（`--no-worktree`） | **120/120** | 预期不可用：`DEVLEAD_TEAM_UNAVAILABLE`、无 Session、文案含 rc.2 |
  | 0.2.2-rc.2 | installed（`--no-worktree`） | **120/120** | 成功：child enabled、durable `team/mode`、false 关闭 |
  | 0.2.2-rc.3 | installed（`--no-worktree`） | **120/120** | 成功（同上） |
  | 0.2.2-rc.4 | installed（完整） | **143/143** | 成功；含实验 worktree 阶段 23/23 |
  | 0.2.2-rc.4 | patch（完整） | **143/143** | 成功；含实验 worktree 阶段 23/23 |
  | 0.2.2-rc.5 | installed（`--no-worktree`） | **120/120** | 成功；phase 1 27 + 1b 12 + 3 81 |
  | 0.2.2-rc.5 | installed（`--no-worktree`，下一版 0.2.7 的问题路由 harness） | **123/123** | 成功；phase 3 84，含真实 `ask_user_question` gate + question report |
  | 0.2.2-rc.5 | installed（完整，0.2.6+ 审计轮重跑） | **146/146** | 成功；含实验 worktree 阶段 23/23 与 question gate |
  | 0.2.2-rc.5 | patch（完整，0.2.6+ 审计轮重跑） | **146/146** | 成功；含实验 worktree 阶段 23/23 与 question gate |

  表中 rc.1–rc.4 与 rc.5 的 120/143 行是各自发布时点的 harness 计数。下一版（0.2.7，未发布，
  含 question 路由）给 phase 3 新增 3 条 question gate checks；0.2.6+ 审计轮（AUDIT §12）已按
  当前 harness 重跑 rc.5 installed `--no-worktree`（123/123）与 installed/patch 完整（各 146/146）。
  发布前仍需按 PUBLISHING 重跑完整组合。

  每条版本使用独立 throwaway `DSH_HOME`，结束后清理；rc.1–rc.3 跳过 phase 2（实验组合不与
  内置 worktree bundle 绑定，阶段 1/1b/3 全跑），rc.4 / rc.5 两条加载流都跑完整四个阶段。所有版本
  均因无 provider 凭据有 3 条正向模型检查 SKIP；`devlead_list_models` 与
  `devlead_list_agent_presets` 在所有版本通过。rc.3→rc.4 的 `dsh-base` / `dsh-web-app`
  组合文件逐字节一致，唯一 upgrade-guide 条目是 LLM 错误码 `CONTENT_REFUSED`（DevLead 不
  分类该码），因此 rc.4 无降级项。rc.5 只改 web search provider 选择：`dsh-web` 未配置
  provider 时对 DeepSeek 路由走服务端 Messages search、对其他路由走 `deepseek-search-api`，
  `WebSearchRequest` 新增可选 `llmProvider`；DevLead 不 import `dsh-web` / `dsh-tool-web`，
  也没有 web search 代码或配置路径，rc.5 完整 E2E 通过，无降级项。依据：`agent-team` 仅
  rc.2+ 发布、rc.1 的 `dsh-base`
  无对应组合行、rc.2–rc.5 实现相同；模型 API（`modelCatalog`、`Agent.model.select`、
  `model/selection`、`llm.*`）rc.1 已具备（devDeps 固定 rc.1，按最旧类型检查）。
- 手动验收路径：开一个会话 → `/devlead on`（或点开关）→ 让模型
  `devlead_use_workspace` 注册一个仓库 → `devlead_create_session` 创建子会话并下发任务 →
  子会话跑完后 DevLead 被唤醒 → 状态条显示关注列表与通知；人类可打开子会话继续参与。
- 可选 worktree 隔离的手动验收（需要实验性组合）：本地 E2E 的**阶段 2 已自动完成**下面这条
  路径（真实实验组合下 `createSession({ isolation: 'worktree' })` 的 happy path）。手动复现：
  在 profile 里启用 "Change requests & worktrees" 实验 bundle（或挂载
  `@deepseek-ai/dsh-experimental-worktree` + `@deepseek-ai/dsh-tool-worktree`）→ `/devlead status`
  应显示 `Worktree isolation: available` → 对一个真实 git 仓库
  `devlead_create_session` 传 `isolation: "worktree"` → 结果应带 `path`/`branch`/`baseCommit`，
  git 仓库里出现该 worktree、子会话首个 turn 从该路径开始，且会话仍归属原 Workspace。
  没有实验性组合时，同一条调用应返回 `unavailable` 且子会话在共享 checkout 正常运行。

## 11. 非目标（本版本）

- 不做 git 仓库创建/clone/通用 worktree 管理（用 shell 工具完成，然后注册 Workspace）。
  可选的 per-Session 隔离（§4.3）只借用已组合的实验性 DSH worktree 服务：插件本身不执行任何
  Git 操作——不创建仓库、不 clone/fetch/merge、不管理分支；隔离分支的审阅与 merge/cherry-pick
  由 lead 安排（派给 Session 或交给人类），且已有 Session 不能迁进 worktree。缺少该服务时仍走
  单 checkout；与旧版相比新增的只是 `isolation` 结果字段、状态行的能力展示与串行派发提示。
- 不做跨进程/跨 DSH 实例编排。
- 不新增 Remote API（第三方不可用 Typert 生成管线），UI 只读 projection + 走命令。
- 不新增"常驻后台调度"：冷 lead 的 resume 只为投递已有通知（Host 重启后索引从持久记录重建，
  `wakeColdSession` 默认 true，可显式关闭）；不会为 DevLead 拉起计划任务或长周期自治目标，
  也不会在恢复时补发重建前错过的 turn。
- 不替人类做权限决策：模式开关只由人类命令/UI 改变；损坏状态的丢弃（`/devlead reset`）也是
  人类专属动作，模型工具没有对应入口。
- 不做跨进程 / 跨 DSH 实例的 Session 发现；身份解析只在本 Host 的 SessionStore /
  SessionQuery 语料内穷尽。

## 12. 审计与验证记录

本轮全面审计（对照官方 DSH `0.2.2-rc.1` 源码逐项核验 API 语义）发现并修复的问题、行为变更与
验证证据记录在 [`AUDIT.md`](AUDIT.md)；0.2.0 的决策、落地位置与验证见同一文件的 §10 与
[`releases/v0.2.0.md`](releases/v0.2.0.md)。

**可选插件的硬依赖审计**：本套件面向默认 DSH Web 组合（`dsh-base` + `dsh-web-app`）构建，
不硬依赖任何实验性 bundle 或第三方插件；Workspace registry / Session controller / 标题服务
走可选 `ctx.get(...)`，实验性 worktree 服务只在显式 `isolation` 请求时借用（§4.3）。逐包判定
表、`dsh.client.inject` 核验、证据 file:line 与「默认 profile 可安装/构建/运行」的验证方式见
[`OPTIONAL-DEPENDENCIES.md`](OPTIONAL-DEPENDENCIES.md)。
