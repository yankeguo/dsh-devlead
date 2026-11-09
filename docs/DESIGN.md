# dsh-devlead 设计说明

一套面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：
把**一个普通会话**升级成 **DevLead 会话**，让它能直接操纵 DSH 的 **Workspace**（工作区）与
**Session**（会话），创建/续写其他会话、读取会话状态、在会话状态变化时被唤醒，从而在一个
人类可见、可参与的标准界面里统管多个仓库。

设计与实现的**唯一强信源**是官方 DeepSeek Harness `0.2.2-rc.1` 源码
（`/Users/guoyk/Workspace/src/deepseek-harness`，与本套件安装的 `@deepseek-ai/*` 同一版本）。
任何第三方插件——包括早期参考过的 `dsh-infini-goal`——只算线索，不作为依据；每条 DSH API
行为都以官方源码或已安装的 `@deepseek-ai/*` 声明为准。

## 1. 产品定位

- **DevLead 会话 = 普通会话 + 一个持久开关**。打开开关后，该会话额外获得一组
  `devlead_*` 工具和一段系统提示，composer 上方出现 DevLead 状态条；未打开时界面里只有
  composer 工具条上的一个小图标，不显示常驻状态条。
- **默认调度而非实现**：DevLead 会话先判定请求归属的 Workspace（依据已注册 Workspace 元数据
  与人类给出的目录，不靠翻别的仓库代码），把自包含简报派发给对应 Session，自己只做有边界的
  只读检查（写简报、审阅交付），更深的调查属于被派发的 Session；即使目标是自己所在的
  Workspace 也默认派发，除非人类在本对话中明确授权直接做（并在汇报中说明）。写入（改文件、
  构建、提交、推送、部署）属于对应 Workspace 的 Session；lead 自己仓库的记录类文件可依该仓库
  说明直接维护，但不构成实现授权。subagent / Agent Team 不能替代人类可打开接管的普通
  Session，本会话也不为别人的请求拉起长周期目标或自治计划。
- **产出物必须是标准 DSH 实体**：Workspace 是真实注册进 `ctx.workspaceRegistry` 的工作区，
  会话是真实的普通 Session（出现在侧边栏、可被人类打开、继续对话、归档），**不是 subagent**。
  这样人类始终能看见、介入、接管 Agent 的工作。
- **通知回路**：DevLead 监督若干子会话；子会话的 turn 结束（完成/失败/取消）时，Host 把
  通知写入 DevLead 会话的持久日志，并在 DevLead Agent 存活时以一条 `devlead` 来源的消息
  唤醒它，让它决定下一步（继续追问、派发新任务、向人类汇报）。
- 开关本身是**人类专属操作**：命令 `/devlead on|off` 或 UI 开关；模型工具不能自行打开模式。

## 2. 包结构

pnpm workspace，`packages/*`：

| 目录 | 包名 | 角色 |
| --- | --- | --- |
| `protocol` | `@yankeguo/dsh-devlead-protocol` | 纯类型 + 常量 + 格式化（host 与浏览器共用），并声明 `devLead` / `devLeadMode` projection 的类型 |
| `devlead` | `@yankeguo/dsh-devlead` | 核心 Service `ctx.devLead`：模式状态、Workspace/Session 编排、监督索引、通知投递、`devLead` 与 summary 级 `devLeadMode` 两个 projection fold |
| `tool` | `@yankeguo/dsh-tool-devlead` | 模型工具 `devlead_*` + 条件系统提示 |
| `command` | `@yankeguo/dsh-command-devlead` | 人类命令 `/devlead` |
| `client-ui` | `@yankeguo/dsh-client-ui-devlead` | 浏览器 UI：未开启时的工具条开关 + 开启后的 DevLead 状态条 + 侧边栏会话行标记 |
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
| `plugin:devlead/watch` | `DevLeadWatchRecord` | **完整**监督集合（`{ sessions: string[] }`，whole-value 替换） |
| `plugin:devlead/notification` | `DevLeadNotificationRecord` | 追加一条通知（`{ notification }`） |
| `plugin:devlead/reset` | `DevLeadResetRecord` | 丢弃该会话**更早**的全部 DevLead 记录，两个 projection 回到空状态（`{ kind, version:1, at }`；见下） |

- 记录 payload 必须 JSON-safe、带 `kind` + `version`；fold 对未知 `kind`/`version` **以及
  多余/缺失字段**一律拒绝（严格字段集解码，见 `domain.ts`）。持久插件记录是折叠的唯一信任
  边界：手工编辑 / 迁移后的日志必须让 replay 失败（`failure`），而不是被静默丢弃或强制转换。
- **`reset` 是唯一在冻结检查之前应用的记录**：合法 reset 让两个 projection（`devLead` 与
  `devLeadMode`）都从 `init` 重新开始（`enabled:false`、空 watch 集合、空 digest、`failure:null`），
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
- 每次变更都是**先追加日志，后发通知**。
- 通知条数在 projection 里按常量 `DEVLEAD_DEFAULT_NOTIFICATION_RETENTION`（64）截断：
  fold 必须是**纯函数**，不能依赖部署 config，否则重放会分叉。

### `devLead` Session projection

- key：`devLead`（常量 `DEVLEAD_PROJECTION_KEY`），wire 值
  `DevLeadProjection = { enabled, sessions, notifications }`。
- Host 侧 fold state 额外带 `failure: string | null`（首条损坏记录），wire 不带；只有
  `failure` 变化时复用上一次 wire view 对象，让 registry 的 `Object.is` 比较抑制无意义推送。
- projection 标记为 `SessionProjectionSummaryExcluded` 且 unit 声明 `wire.summary: false`：
  保留的通知摘要（≤64 条）只服务打开中的会话，不进入 Session 列表 / summary payload。
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

  // Session
  listSessions(agent: Agent, options?: { workspace?: string; watchedOnly?: boolean; limit?: number; signal?: AbortSignal }): Promise<DevLeadSessionView[]>
  getSession(agent: Agent, sessionId: string, signal?: AbortSignal): Promise<DevLeadSessionView>
  createSession(agent: Agent, request: DevLeadCreateSessionRequest, signal?: AbortSignal): Promise<DevLeadCreatedSession>
  promptSession(agent: Agent, sessionId: string, prompt: string, options?: { watch?: boolean; signal?: AbortSignal }): Promise<DevLeadPromptedSession>
  watchSession(agent: Agent, sessionId: string, watching: boolean, signal?: AbortSignal): Promise<DevLeadWatchMutation>

  // 通知
  notifications(agent: Agent, options?: { limit?: number }): DevLeadNotification[]

  // 可选能力（不是 inject；只做只读探测，见 §4.3）
  get worktreeIsolationAvailable(): boolean
}
```

`DevLeadUseWorkspaceRequest = { path: string; title?: string; create?: boolean }`（protocol 导出）；
`create` 缺省 `false`。

约束：

- 所有接收 Agent 的写方法先 `assertLive(agent)`（`ctx.agents.get(agent.id) === agent`），并
  校验模式已开启（`DEVLEAD_NOT_ENABLED`）；`setEnabled` / `reset` 是人类恢复入口，只要求
  live，不要求模式已开启（损坏状态下 `strictStateOf` 会抛 `DEVLEAD_PROJECTION_INVALID`，
  `setEnabled(false)` 与 `reset` 必须仍能工作）。0.2.0 起 `useWorkspace` 也接收 live lead
  Agent 并走 `assertReady`（live + 模式开启），不再有 caller-free 例外：Workspace 注册是
  Host 级副作用，必须由已授权、已开启模式的 lead 发起。
- 所有需要 watch 集合或"当前 lead"的读接口都显式接收 `agent`（工具调用传 `exec.agent`，
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
  恢复后投影回到默认 disabled、watch 索引清空，需要重新 watch；持久日志里的旧记录保留但不再
  fold。hub 在 `session/event` 看到 reset 记录时也 `syncLead`（状态变 disabled → `removeLead`）。
- `createSession`：先在第一个 await 之前**同步预留** watch 槽位（并发调用不会都通过预检后
  才在 setWatching 报超限；槽位在 watch 提交后立即释放，`finally` 兜底）→ 解析目标 Workspace
  （id / path / 缺省用 lead 自己的 cwd 并自动注册）→ 校验 `workspace.status() === 'ok'`
  （已注册但目录消失时返回 `DEVLEAD_DIRECTORY_MISSING`，不让 controller 的自动 mkdir
  把空目录"复活"）→ `ctx.sessionController.create({ workspaceId })`（该调用会把 Session
  挂进 Workspace 的账目）→ 可选
  `ctx.sessionTitle.rename(session, title)` → 可选 watch → **可选 worktree 隔离（见 §4.3）**
  → 可选 prompt。隔离失败不会让创建失败；结果里的 `isolation` 字段如实上报
  `none` / `worktree` / `unavailable` / `failed`。注意：空白 Session 在第一次 turn
  开始前不会出现在侧边栏，因此"创建+prompt"是常规用法。
- `promptSession`：先校验归档与冷会话激活能力（避免"缺 controller 时先 watch 再报错"的
  半应用）→ 自动 watch 在 admission 前提交（失败/取消按上文的补偿语义撤销本次新增）→
  `sessionController.resolveAgent(sessionId)` 拿 live Agent（冷会话会被 resume）→
  `agent.followup(createUserMessage({ content, source: { kind: 'devlead', form: 'relay', senderSessionId: lead.id } }))`
  + `ctx.sessions.flush(agent.session)`。默认自动 watch。
- `watchSession`：追加完整 watch 记录；上限 `maxWatchedSessions`；不能 watch 自己。
- `notifications`：返回本会话 projection 里保留的通知（最新 limit 条；非法 limit 退回默认 20）。
- `ctx.sessions.flush()` 返回 `false` 只表示"没有组合任何持久化参与者"（headless / SDK
  组合），不是失败；参与者抛出的错误只记 warning，不会让已提交的内存 append 变成抛错。

错误类：`DevLeadError extends Error { code: DevLeadErrorCode }`，稳定 code 见第 8 节。

### 4.1 监督索引与通知投递

持久日志是权威，hub 的内存索引 `watched → Set<leadSessionId>` 只是加速器；lead 的 enabled 与
watch 集合始终来自其 Session 日志的严格 fold。Host 重启 / 插件重新加载后，service init 从持久
记录**重建索引**（cold rehydration，§4.1.1），因此尚未打开的冷 lead 仍能看到被 watch 会话的
`turn/end`、写入持久通知，并在合并窗口结束时按 `wakeColdSession` 策略投递。

启动与监听：

0. `[Service.init]`：注册两个 projection unit → 创建 hub → `hub.start()`（安装监听器并对当前
   live Agent 做一次 `bootstrap`）→ 冷扫描 `await hub.rehydrate(await persistedLeadRecords(...))`
   （就绪条件与重试见 §4.1.1）。rehydrate 的任何异常只记 warning，**绝不让插件加载失败**。
1. `ctx.on('agent/created')`：若新 Agent 的 session projection `enabled` 为真，把它的 watch
   集合注册进内存索引 `watched → Set<leadSessionId>`；若存在 `unsaved` 队列还要立即调度
   flush（覆盖"人类打开冷 lead"的补写与投递路径）。持久 watch 记录若含 lead 自身 id（只可能
   来自手工编辑），索引时忽略并 warning 一次；写侧仍由 self-watch guard 拒绝。
2. `ctx.on('session/event', (session, event))`：
   - 若 `session` 是某个 lead 自己的会话：重新同步该 lead 的 watch 集合（mode / watch / reset
     记录变化时）；
   - 若 `session.id` 被至少一个 lead 监督，且 `event.type === 'turn/end'`：为每个 lead 生成
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
   - **`agent/disposed` 不再移除 lead 的 runtime / 反向索引**（0.2.0）：dispose 之后被 watch
     会话的 `turn/end` 仍会写入持久通知并排队；区别只在投递侧——lead Session 日志仍 attached
     （`ctx.sessions` 里有）时记录立即持久化进 `pending`，已脱离（cold）时进 `unsaved` 等
     resume/打开后补写。索引只在以下情况消失：持久状态变为 disabled（mode off / reset，
     经 `session/event` 的 `syncLead`）、unwatch 使集合变化（runtime 保留、只是不再 watch）、
     或 hub/插件卸载（重新加载时由 persisted records 重建；卸载期间结束的 turn 因为内存
     transport 不存在而丢失，不会补发）。`setWatched` 同时过滤 `pending` 与 `unsaved`
     （最近的 watch 集合是权威）。
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
  `enabled && sessions.length > 0` → 记录（watch 集合以精确折叠为准，cache 只作预筛）。
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
  语义后果：Host 在 watch 索引重建完成前不会报告 application-ready；init 时若
  `sessionPersistence` 尚未组合，则通过一次性 `ctx.inject(['sessionPersistence'], ...)` 等待，
  它出现时再走同一屏障；从未组合 persistence 的 Host 不扫描持久语料、也不会 per-event 扫描
  （`agent/created` / `session/event` 一次性监听只在 `sessionQuery` 本身缺失时才 arm）。
  两个服务都只读 `ctx.get` 探测，不新增 `static inject`、不新增依赖，缺失时仍可加载并仅恢复
  live lead。
- 恢复的只是 watch 索引：**插件卸载期间**结束的 `turn/end` 不会补发（内存 transport 只在
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

### 4.2 状态视图

`DevLeadSessionView` 由 `DevLeadService` 组装，列表路径刻意分成「便宜事实 → 排序截断 →
昂贵视图」三步：

- 候选集合（`collectSessionIds`）：live Agents、store 中的 live Sessions、Workspace 账目、
  lead 的 watch 集合，以及（组合了 `sessionQuery` 时）持久化 Session。列表模式下进入候选的
  持久化 ID 窗口受 `maxListedSessions` 限制；rc.1 的 `sessionQuery.listSessions` 没有 limit
  参数，底层仍会读取完整持久语料后才截断候选（这是 API 限制，不是逐行日志读取）。
  **身份解析**（`resolveSessionReference`）走穷尽模式，列表窗口从不是"能否寻址"的上限。
- 便宜排序事实：watched / `agent.status === 'running'` / header `createdAt`；按
  watched → running → createdAt 降序、id 兜底排序后**先截断**，只有保留下来的行才组装完整
  视图。`limit` 必须是正安全整数，并 cap 在 `maxListedSessions`；`watchedOnly` 列表不会截断
  到小于 watch 集合（watch 集合本身已有 `maxWatchedSessions` 上限）。
- 批量事实（`readSessionFacts`）：标题/header（live 用 `sessionTitle.get`，cold 一次
  `sessionQuery.readTitleSnapshots` 批量）、Workspace 归属（一次 `workspaceRegistry.list()`
  建 map，不再按行反查）、归档集合。
- 精确 id 解析有快路径：watch 集合 → live Session/Agent → 单 id `readTitleSnapshot`；只有
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

全部工具都带 `when: ({ agent }) => ctx.devLead.isEnabled(agent)`，只在 DevLead 会话可见。

| 工具 | 参数 | 返回（canonical JSON） |
| --- | --- | --- |
| `devlead_list_workspaces` | `{}` | `{ workspaces: DevLeadWorkspaceView[] }` |
| `devlead_use_workspace` | `path`(必填，绝对路径), `title?`, `create?`(默认 false；显式 true 才 mkdir) | `{ workspace }` |
| `devlead_list_sessions` | `workspace?`(id 或 path), `watched_only?`, `limit?` | `{ sessions, watched: string[] }` |
| `devlead_create_session` | `workspace?`, `prompt?`, `title?`, `watch?`(默认 true), `preset?`, `isolation?`(默认 `none`；`worktree` = 尽力隔离) | `DevLeadCreatedSession`（含 `isolation` 结果） |
| `devlead_get_session` | `session`(必填) | `{ session }` |
| `devlead_prompt_session` | `session`(必填), `prompt`(必填), `watch?`(默认 true) | `DevLeadPromptedSession` |
| `devlead_watch_session` | `session`(必填), `watching`(必填 bool) | `DevLeadWatchMutation` |
| `devlead_notifications` | `limit?`(默认 20) | `{ notifications, watched: string[] }` |

要点：

- 输出 schema 用 `defineTool` 的 `ValueSchemaSpec`；`output.render` 把 canonical JSON 以文本
  返回（模型可读），`presentCall` 返回 `{ card: 'generic', title, kind }`（`kind` 取
  `read`/`search` 类似语义），只依赖已解析参数，保持 replay 纯函数。schema 与 protocol 视图
  类型有编译期一致性约束，运行时还会用编译出的 output schema 校验每个投影值（可选字段按
  lossless JSON 规则省略）。
- 参数里的 `session`/`workspace` 接受完整 id、路径，或（会话）唯一前缀匹配；多个前缀命中时报
  `DEVLEAD_INVALID_INPUT` 并列出候选。除 `devlead_list_workspaces` 外的工具都要求 live 调用
  者（缺失时 `DEVLEAD_AGENT_NOT_LIVE`）；`devlead_use_workspace` 是唯一的写工具，0.2.0 起它
  转发 live lead Agent 给 core 的 `useWorkspace(agent, request, signal)`，`create` 默认
  `false`，仅当人类明确要求建目录时才传 `create: true`（工具 schema 与 policy 文案同步）。
- 工具把领域失败翻译成 `HarnessError(message, code)`；需要调用者的工具在 `exec.agent` 缺失
  （条件可见性被绕过）时也走结构化错误 `DEVLEAD_AGENT_NOT_LIVE`，基础设施错误原样重抛。所有异步写调用转发
  `exec.signal`（`create_session` / `prompt_session` / `watch_session`），读调用同样转发。
- `systemPrompt.section({ name: 'devlead:policy', order: TOOL_SUBAGENT, text: ({ agent }) =>
  ctx.devLead.isEnabled(agent) ? POLICY : '' })` 提供 DevLead 行为指导：依据注册元数据判定
  归属、默认调度而非亲自实现（写入归归属 Workspace 的 Session，本 Workspace 也默认派发；
  lead 自己仓库的记录类文件可依仓库说明直接维护）、只读检查以简报与审阅为界、已有同请求
  live Session 时续写而不是重复创建、未注册归属先问或注册、无空会话，以及工作流、通知处理、
  汇报格式；每次组装按当前 Agent 重新求值，关闭模式后下一步即消失。`devlead_create_session`
  的工具描述与 `workspace` 参数说明同步强调「把工作派发到归属 Workspace 的 Session」，避免
  模型把「创建 + prompt」当成本会话的直接实现入口。
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
/devlead                  # 状态：开关、worktree 能力、监督的会话（标题/状态）、最近通知、帮助
/devlead on               # 打开当前会话的 DevLead 模式
/devlead off              # 关闭；fold 冻结时也会强制关闭并清理冻结状态（见下）
/devlead reset            # 人类专属恢复：丢弃该会话的全部 DevLead 持久状态并回到默认 disabled
/devlead watch <session>  # 监督某个会话（支持唯一前缀）
/devlead unwatch <session>
```

- 语法解析严格按 DSH 的 `CommandInvocation.rawInput` 契约：值 = 命令名之后的文本（可能带分隔
  空白），**不接受**完整命令行；多余参数、未知子命令、空参数、成对/不配对引号都有明确错误。
- 状态输出用普通文本行（`CommandResult { kind: 'success', text }`），且模式 / watch 集合 /
  通知摘要来自**同一次 projection 读取**，避免列表 await 期间看到更新的 digest 与更旧的
  watch 行。状态固定包含 `Worktree isolation: available|unavailable`（读
  `ctx.devLead.worktreeIsolationAvailable`），让人类与 E2E 直接看到 Host 是否组合了可选的
  worktree 隔离能力；该行只是能力说明，不改变任何状态。
- Session 寻址先用有界列表 + watch 集合给出带标题的候选；**前缀引用（非精确 id）** 还会再用
  core 的穷尽 resolver 确认唯一性，然后才执行 watch/unwatch，避免列表窗口外的同前缀 Session
  被静默遮蔽（精确 id 直接命中，不走额外读取）。
- `on` 需要当前 Agent live；`off` 立即生效（正在投递的通知保留在日志里）。
- **损坏 fold 的恢复（0.2.0）**：`/devlead reset` 调用 core 的 `reset(agent)`，追加一条
  `plugin:devlead/reset` 记录，两个 projection 的 fold 都从空状态重新开始（模式关闭、watch
  集合与通知 digest 丢弃、`failure` 清除）；它不要求模式开启，是冻结状态下唯一能写日志的
  命令，也就是人工修复坏记录的路径。`/devlead off` 在折叠冻结时也会成功：handler 先读
  view，若抛 `DEVLEAD_PROJECTION_INVALID` 且请求是 off，直接调
  `ctx.devLead.setEnabled(agent, false)`（core 走 reset 恢复），再用新快照渲染；`on` 仍返回
  带 `/devlead reset` 提示的友好错误，避免隐式丢弃人类可能还想检查的记录。恢复后投影回到
  默认 disabled、watch 索引清空（需要重新 watch），持久日志里的旧记录保留但不再 fold。
- **标题与正文一致（并发）**：`executeMode` / `executeWatch` 在变更后重新取一次快照，标题由
  该 post-mutation 快照的真实状态派生、正文永远来自同一快照；并发（另一个命令/UI 开关在
  期间改变状态）时输出形如 "DevLead mode is off (another command changed it)."，不会出现
  "标题说已关闭、正文显示开启" 的分裂。
- 附件由 `CommandRuntime` 在 handler 之前拒绝（定义不声明 `input.attachments`），handler 不
  重复实现该策略。
- 全部领域错误码都映射成可操作的友好文本；`DEVLEAD_*` 新增码会让穷尽 switch 编译失败。
  `DEVLEAD_PROJECTION_INVALID` 的文案明确说明"记录损坏、状态无法读取"并提示运行
  `/devlead reset`（同时说明会丢弃 watch 集合与通知 digest）。
- UI 开关只调用 `/devlead on|off`（`ctx.remote.commands.execute`），因此命令是唯一的人类入口。

## 7. 浏览器 UI（`@yankeguo/dsh-client-ui-devlead`）

UI 分两态，避免在每个会话上显示常驻条：

- **未开启**：`conversation.input.left`（composer 工具条，权限下拉旁）里一个 ghost 图标按钮
  `DevLeadIconToggle`。它只读 projection，`enabled=true` 或 projection 未加载时不渲染。
  点击发送 `/devlead on`；失败时错误文本进入按钮 tooltip（toolbar 没有内联错误位）。
- **已开启**：`conversation.input.dock`（composer 上方）里的
  `DevLeadBar`。
  - `useProjection('devLead')`：`undefined`（加载中）或 `enabled=false` → 不渲染；
    `enabled=true` → 开关（点击发 `/devlead off`）+ 监督会话数/运行中数（标准 props
    `useSessions`/`useSessionStatus` 与 projection 的 `sessions` 计算）+ 最近一条通知摘要
    + 帮助提示。
  - 开关调用注入的 `executeCommand('/devlead on'|'/devlead off')`，pending 时禁用；
    命令逻辑错误（`kind: 'error'`）在内联错误行显示。
  - `Switch`/`Button`/`Tooltip` 组件来自 `@deepseek-ai/dsh-client-ui-primitives`；样式走本插件
    注入的 `<style>` 标签（`ensureStyleTag`），颜色只用 DSH theme 中真实存在的 `--dsw-*`
    token 并提供中性 fallback；状态条采用 shell 的 menu-surface 模式（无重复 hairline、
    `--dsw-menu-backdrop-filter`），宽度按 composer dock 的 side-clearance / dock-inset 公式。
    `ensureStyleTag` 用**跨模块实例**的引用计数（`Symbol.for(...)` 为 key 的
    `globalThis` 单例 `{ refs, element }`）：首个实例创建 `<style>`，后续实例复用并刷新 `textContent`，每个
    disposer 递减，归零才移除。这样 HMR 新旧模块实例交替时，旧实例如的 disposer 不会删掉新
    实例仍在使用的标签。
  - 两个入口共享一个准入状态机：纯函数 gate + reducer（`results.ts`）+ 薄 React hook
    （`useDevLeadAdmission.ts`）——同渲染周期双击只会提交一条命令，未挂载后不再 setState，
    模式变化会作废旧失败提示。准入门面把 `ok:true` 但 `value: undefined`（Host 没有解析到
    命令）也当作失败（`unresolved`），不会把死入口当成功。0.2.0 起这两个组件与 hook 有
    **React 渲染测试**（`react-test-renderer`，devDependency，纯 node、无 jsdom）：用 `act`
    驱动，覆盖两态分支、SR live region / label、pending 禁用、失败文案，以及 hook 的单击提交、
    双击单次提交、卸载后不 setState、失败保留与 `resetKey` 清空。
  - `role=status` live region 覆盖状态条提示 / 最新通知 / 图标失败文本，保证屏幕阅读器能听到
    通知与错误；`aria-busy` / label 与 pending 状态一致。
  - 两态互斥：开启时图标隐藏，关闭时状态条消失，因此同一个开关不会同时出现两份。
- **侧边栏会话行标记**：开启 DevLead 的会话在 Session 列表行尾部显示一个盾形标记
  （`sidebar.session.row.trailing`；非交互、不绑定/不激活 Session，只按 `sessionId` 读
  summary 级 `devLeadMode`）。rc.1 对 blank（尚无 turn）行不渲染 trailing seat，因此在空白
  新会话上开启模式后要等第一次 turn 才显示标记；该限制无法在插件侧补 seat。DSH 0.2.2-rc.1
  没有“始终可见”的行 seat：`leading` seat 在运行中 / 有未读 / 有待处理交互时会被状态点替换，
  因此不用它；`trailing` seat 在桌面端
  行被悬停 / 聚焦 / 菜单打开时被 shell 隐藏，所以 `sidebar.session.row.hover` 再提供一行
  「DevLead 模式已启用」说明（i18n key `row.mark.aria` / `row.hover.enabled`），标记的
  `aria-label` 让屏幕阅读器同样能听到。图标与说明均不改变行高、不压缩标题截断宽度。
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
| `DEVLEAD_INVALID_INPUT` | 参数不可用：空 prompt、相对路径、文件路径、空引用、`limit` 非法、前缀歧义、非法 prompt 目标等 |
| `DEVLEAD_NOT_ENABLED` | 当前会话未开启 DevLead 模式 |
| `DEVLEAD_AGENT_NOT_LIVE` | 传入的 Agent 不是注册表中的 live 实例（工具侧绕过 `when` 时也走该码） |
| `DEVLEAD_WORKSPACE_NOT_FOUND` | 指定 Workspace 引用无法解析，或 Host 未组合 Workspace registry |
| `DEVLEAD_DIRECTORY_MISSING` | 目录不存在且未显式允许创建（文案提示 retry with `create: true`），或允许创建但创建失败 |
| `DEVLEAD_SESSION_NOT_FOUND` | 指定 Session 不存在（含 Host 侧 `session/not-found` 映射） |
| `DEVLEAD_SESSION_ARCHIVED` | Session 已归档，不能续写 |
| `DEVLEAD_SESSION_UNAVAILABLE` | 无法 resume / 没有 sessionController / 没有 create 能力 / followup 被拒 |
| `DEVLEAD_WATCH_LIMIT` | 监督集合超过上限 |
| `DEVLEAD_SELF_WATCH` | `watchSession` 试图监督自己（`promptSession` 向自己投递使用 `DEVLEAD_INVALID_INPUT`） |
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
  无 projection cache 只恢复 live、persisted scan 抛错不阻加载）、Workspace 与 Session 编排、列表排序与截断、列表窗口外的身份解析、
  **promptSession 自动 watch 的补偿语义**（admission/resume 失败与取消时移除本次新增、
  已 watch 不受影响、`watch:false` 不变）、写路径的取消语义，以及可选 worktree 隔离的两种
  形态（fake `ctx.worktrees` 存在时按"创建→隔离→prompt"顺序调用子 Agent 的 `create`；
  缺席/畸形/抛错时降级为 `unavailable`/`failed`，Session 仍创建并 prompt，绝不抛错）。
- `tool`：用 fake `ctx.devLead` + fake `ctx.tools`/`ctx.systemPrompt` 捕获工具定义，验证
  `when` gating、参数校验、值渲染、编译期 schema↔protocol 一致性、运行时 output schema
  校验、错误翻译、每个工具的 execute 转发与取消信号转发、presentCall replay 纯净性，以及
  policy 文案的角色边界契约（默认调度、写入归属、归属未明时先问或注册、无空会话）；另覆盖
  `isolation` 参数映射与非法值、创建结果四种 `isolation` 状态的投影，以及 policy 按
  `worktreeIsolationAvailable` 真/假两种形态的条件文案。
- `command`：解析（rawInput 契约 / 引号 / 空白 / 未知子命令 / `reset`）、前缀寻址（唯一 /
  歧义 / 缺失 / 列表窗口外回退）、渲染、穷尽错误码映射、单次 projection 快照、`/devlead reset`
  的恢复渲染、`/devlead off` 在冻结状态下恢复、`/devlead on` 在冻结状态下返回带 reset 提示的
  友好错误，以及并发变更时 title/body 来自同一 post-mutation 快照；状态里的
  `Worktree isolation: available|unavailable` 行也按 fake 能力断言。
- `client-ui`：纯函数（format / 准入状态机 gate+reducer / results 分类 / 样式 token 契约 /
  侧边栏行标记 predicate / locale 完整性与占位符一致）；组件保持薄，逻辑都下沉到可测纯函数。
  0.2.0 起另有 **React 渲染测试**（`react-test-renderer`，devDependency，纯 node、无 jsdom，
  组件把 `useProjection`/`useSessions`/`useSessionStatus` 作为 props 传入，因此只 mock
  `@deepseek-ai/dsh-client-ui-primitives`）：覆盖 DevLeadBar enabled/disabled、SR live
  region 与 label、pending 禁用、失败文案，DevLeadIconToggle 分支与隐藏失败活区，
  SessionMark/HoverMark，以及 `useDevLeadAdmission` 的单击提交、双击单次提交、卸载不
  setState、失败保留与 `resetKey` 清空。`ensureStyleTag` 的跨模块实例引用计数用
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
  digest 的 `devLeadMode` 行、`on/off` 翻转、真实子会话 watch、被 watch 会话 `turn/end` →
  持久通知 → 投影可见、以及自 watch 拒绝。子会话的 provider/infrastructure 凭据按名称模式
  清除，因此 turn 稳定以 provider error 结束（真实 `turn/end`，不花 token）；实例在结束时
  按 PID 关闭。该命令只在本地跑，CI 不含。**0.2.0 起 E2E 分多个阶段**（同一条 scratch root /
  profile；阶段 1 与 1b 还共享同一个一次性 `DSH_HOME`，实例按阶段启停、从不并存）：阶段 1
  走完默认组合断言（发行版默认 Web 组合，额外断言 `/devlead status` 里
  `Worktree isolation: unavailable`，证明可选能力缺席时插件照常工作，并把 enabled 模式 /
  watch 集合 / digest 留在持久日志里）；阶段 1b 用**同一加载流、同一 scratch home 重启**，
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
  patch 与 installed 两条加载流都跑完整多阶段；`--no-worktree` 跳过阶段 2（只跑阶段 1 + 1b，
  调试用）。两条加载流各 **61/61**（阶段 1 27 + 阶段 1b 12 + 阶段 2 22）；跳过阶段 2 时
  **39/39**（阶段 1 + 1b）。
- 本轮最终验证数字（工作树）：`pnpm verify` = typecheck 通过 + **22 文件 / 558 tests** +
  7 个构建产物；`node scripts/check-packages.mjs` → `OK (6 packages)`；E2E patch / installed
  各 **61/61**（阶段 1 27 + 阶段 1b 12 + 阶段 2 22）。
- 手动验收路径：开一个会话 → `/devlead on`（或点开关）→ 让模型
  `devlead_use_workspace` 注册一个仓库 → `devlead_create_session` 创建子会话并下发任务 →
  子会话跑完后 DevLead 被唤醒 → 状态条显示监督列表与通知；人类可打开子会话继续参与。
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
