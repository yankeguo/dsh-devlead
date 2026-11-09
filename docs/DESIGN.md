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
DSH shell 的 platform singletons（单一来源 `scripts/client-externals.mjs`，构建期守卫失败
而不是静默内联）。除构建外，`scripts/` 还提供 `check-packages.mjs`（包不变式）、
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

- 记录 payload 必须 JSON-safe、带 `kind` + `version`；fold 对未知 `kind`/`version` **以及
  多余/缺失字段**一律拒绝（严格字段集解码，见 `domain.ts`）。持久插件记录是折叠的唯一信任
  边界：手工编辑 / 迁移后的日志必须让 replay 失败（`failure`），而不是被静默丢弃或强制转换。
- 时间戳必须是非负安全整数且落在 `Date` 可表示范围内（≤ 8.64e15），turn 必须是正安全整数；
  否则 `formatInstant` 之类的渲染会在 UI 侧抛 `RangeError`。
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
    notificationBatchMs: z.number().step(1).min(0).default(400), // 通知合并窗口
    maxWatchedSessions: z.number().step(1).min(1).default(64),
    maxListedSessions: z.number().step(1).min(1).default(200),
    wakeColdSession: z.boolean().default(false),                 // 冷会话是否 resume 后唤醒
    defaultAgentPreset: z.string().default(''),                  // 创建会话的默认 preset
  })

  // 模式（仅人类路径调用：命令 / UI 开关）
  isEnabled(agent: Agent): boolean
  setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>
  view(agent: Agent): DevLeadProjection            // 读本会话 projection 的 wire 值

  // Workspace
  listWorkspaces(signal?: AbortSignal): Promise<DevLeadWorkspaceView[]>
  useWorkspace(path: string, options?: { title?: string; create?: boolean; signal?: AbortSignal }): Promise<DevLeadWorkspaceView>

  // Session
  listSessions(agent: Agent, options?: { workspace?: string; watchedOnly?: boolean; limit?: number; signal?: AbortSignal }): Promise<DevLeadSessionView[]>
  getSession(agent: Agent, sessionId: string, signal?: AbortSignal): Promise<DevLeadSessionView>
  createSession(agent: Agent, request: DevLeadCreateSessionRequest, signal?: AbortSignal): Promise<DevLeadCreatedSession>
  promptSession(agent: Agent, sessionId: string, prompt: string, options?: { watch?: boolean; signal?: AbortSignal }): Promise<DevLeadPromptedSession>
  watchSession(agent: Agent, sessionId: string, watching: boolean, signal?: AbortSignal): Promise<DevLeadWatchMutation>

  // 通知
  notifications(agent: Agent, options?: { limit?: number }): DevLeadNotification[]
}
```

约束：

- 所有写方法先 `assertLive(agent)`（`ctx.agents.get(agent.id) === agent`），并校验模式已开启
  （`DEVLEAD_NOT_ENABLED`）；`setEnabled` 是人类开关本身，不要求模式已开启。
- 所有需要 watch 集合或"当前 lead"的读接口都显式接收 `agent`（工具调用传 `exec.agent`，
  命令调用传 `invocation.agent`）；服务不依赖 initiator 推断调用者。
- 读接口把 `signal` 一路传给 `sessionQuery` 读取；写接口只在阶段边界做协作式取消检查
  （Session 创建 / `resolveAgent` 本身不可中断）。取消按 `AbortSignal` 语义抛出
  `AbortError`，不伪装成领域错误。
- `useWorkspace`：绝对路径校验交给 `workspaceRegistry.create`（它做 realpath 规范化、
  相对路径拒绝、目录存在性检查、已注册路径复用）；`create: true` 且目录缺失时先
  `mkdir -p` 再重试一次。错误映射：目录缺失（且未允许创建 / 创建失败）→
  `DEVLEAD_DIRECTORY_MISSING`；相对路径、文件、不可用父目录、registry 写入失败 →
  `DEVLEAD_INVALID_INPUT`。`title` 只作用于**新注册**的 Workspace，已存在的记录保留原标题。
- `createSession`：先做 watch 容量预检（避免创建成功后才发现超限）→ 解析目标 Workspace
  （id / path / 缺省用 lead 自己的 cwd 并自动注册）→ `ctx.sessionController.create({ workspaceId })`
  （该调用会自动 mkdir 并把 Session 挂进 Workspace 的账目）→ 可选
  `ctx.sessionTitle.rename(session, title)` → 可选 prompt。注意：空白 Session 在第一次 turn
  开始前不会出现在侧边栏，因此"创建+prompt"是常规用法。
- `promptSession`：先校验归档与冷会话激活能力（避免半应用的 watch 副作用）→
  `sessionController.resolveAgent(sessionId)` 拿 live Agent（冷会话会被 resume）→
  `agent.followup(createUserMessage({ content, source: { kind: 'devlead', form: 'relay', senderSessionId: lead.id } }))`
  + `ctx.sessions.flush(agent.session)`。默认自动 watch。
- `watchSession`：追加完整 watch 记录；上限 `maxWatchedSessions`；不能 watch 自己。
- `notifications`：返回本会话 projection 里保留的通知（最新 limit 条；非法 limit 退回默认 20）。
- `ctx.sessions.flush()` 返回 `false` 只表示"没有组合任何持久化参与者"（headless / SDK
  组合），不是失败；参与者抛出的错误只记 warning，不会让已提交的内存 append 变成抛错。

错误类：`DevLeadError extends Error { code: DevLeadErrorCode }`，稳定 code 见第 8 节。

### 4.1 监督索引与通知投递

启动后：

1. `ctx.on('agent/created')`：若新 Agent 的 session projection `enabled` 为真，把它的 watch
   集合注册进内存索引 `watched → Set<leadSessionId>`。
2. `ctx.on('session/event', (session, event))`：
   - 若 `session` 是某个 lead 自己的会话：重新同步该 lead 的 watch 集合（watch 记录变化时）；
   - 若 `session.id` 被至少一个 lead 监督，且 `event.type === 'turn/end'`：为每个 lead 生成
     `DevLeadNotification`（`turn`、`transition`=reason.kind、`error` 摘要、`sessionTitle`），
     写入 lead 会话的 notification 记录，并排队唤醒。
3. 唤醒水泵（每 lead 一个）：
   - 通知入队，`setTimeout(notificationBatchMs)` 合并；窗口结束时若 lead Agent 仍存活：
     `agent.followup(createUserMessage({ content: 渲染的摘要, source: { kind: 'devlead', form: 'notice' } }))`
     + flush。Agent 正在运行也无妨：followup 排队到下一 turn。
   - 同一确定性 id 的通知在一次 digest 里只出现一次（重放的 `turn/end` 不会重复唤醒；持久
     记录仍两条都在，audit 完整）。
   - 投递失败（`followup` 抛错）时把该批重新入队，并按上限 1s 重试，而不是丢弃或按合并窗口
     空转；`notificationBatchMs: 0` 下模式关闭 / Agent dispose 后不会再唤醒（微任务 flush 有
     代际守卫）。
   - lead Agent 不存活时：默认只留持久记录（`wakeColdSession: false`）；为 true 时先
     `sessionController.resolveAgent(leadId)` 再投递。
   - lead 会话处于归档状态时暂停投递并丢弃内存队列，持久记录保留；恢复会话后状态视图仍能看到。
   - `agent/status` 变为 idle 时也尝试冲一次队列（例如窗口结束前 Agent 刚好在忙）。
   - `agent/disposed` 时丢弃该 lead 的内存队列与 timer（记录已持久化）。
   - 写入侧自检：不可表示的 turn / 时间戳宁可不写记录，也不写一条自己的严格 fold 会拒绝的
     记录；损坏的 lead replay 每个 Session 只 warning 一次。
4. 会话日志里写入的通知记录会驱动 projection，UI 状态条实时更新。

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
  lead 的 watch 集合，以及（组合了 `sessionQuery` 时）持久化 Session。列表模式下持久化窗口
  受 `maxListedSessions` 限制；**身份解析**（`resolveSessionReference`）走穷尽模式，列表窗口
  从不是"能否寻址"的上限。
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

## 5. 模型工具（`@yankeguo/dsh-tool-devlead`）

全部工具都带 `when: ({ agent }) => ctx.devLead.isEnabled(agent)`，只在 DevLead 会话可见。

| 工具 | 参数 | 返回（canonical JSON） |
| --- | --- | --- |
| `devlead_list_workspaces` | `{}` | `{ workspaces: DevLeadWorkspaceView[] }` |
| `devlead_use_workspace` | `path`(必填，绝对路径), `title?`, `create?`(默认 true，缺失目录 mkdir) | `{ workspace }` |
| `devlead_list_sessions` | `workspace?`(id 或 path), `watched_only?`, `limit?` | `{ sessions, watched: string[] }` |
| `devlead_create_session` | `workspace?`, `prompt?`, `title?`, `watch?`(默认 true), `preset?` | `DevLeadCreatedSession` |
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
  `DEVLEAD_INVALID_INPUT` 并列出候选。
- 工具把领域失败翻译成 `HarnessError(message, code)`；`exec.agent` 缺失（条件可见性被绕过）
  也走结构化错误 `DEVLEAD_AGENT_NOT_LIVE`，基础设施错误原样重抛。所有异步写调用转发
  `exec.signal`（`create_session` / `prompt_session` / `watch_session`），读调用同样转发。
- `systemPrompt.section({ name: 'devlead:policy', order: TOOL_SUBAGENT, text: ({ agent }) =>
  ctx.devLead.isEnabled(agent) ? POLICY : '' })` 提供 DevLead 行为指导：依据注册元数据判定
  归属、默认调度而非亲自实现（写入归归属 Workspace 的 Session，本 Workspace 也默认派发；
  lead 自己仓库的记录类文件可依仓库说明直接维护）、只读检查以简报与审阅为界、已有同请求
  live Session 时续写而不是重复创建、未注册归属先问或注册、无空会话，以及工作流、通知处理、
  汇报格式；每次组装按当前 Agent 重新求值，关闭模式后下一步即消失。`devlead_create_session`
  的工具描述与 `workspace` 参数说明同步强调「把工作派发到归属 Workspace 的 Session」，避免
  模型把「创建 + prompt」当成本会话的直接实现入口。

## 6. 人类命令（`@yankeguo/dsh-command-devlead`）

`/devlead` 语法：

```
/devlead                  # 状态：开关、监督的会话（标题/状态）、最近通知、帮助
/devlead on               # 打开当前会话的 DevLead 模式
/devlead off              # 关闭
/devlead watch <session>  # 监督某个会话（支持唯一前缀）
/devlead unwatch <session>
```

- 语法解析严格按 DSH 的 `CommandInvocation.rawInput` 契约：值 = 命令名之后的文本（可能带分隔
  空白），**不接受**完整命令行；多余参数、未知子命令、空参数、成对/不配对引号都有明确错误。
- 状态输出用普通文本行（`CommandResult { kind: 'success', text }`），且模式 / watch 集合 /
  通知摘要来自**同一次 projection 读取**，避免列表 await 期间看到更新的 digest 与更旧的
  watch 行。
- `on` 需要当前 Agent live；`off` 立即生效（正在投递的通知保留在日志里）。
- 附件由 `CommandRuntime` 在 handler 之前拒绝（定义不声明 `input.attachments`），handler 不
  重复实现该策略。
- 全部领域错误码都映射成可操作的友好文本；`DEVLEAD_*` 新增码会让穷尽 switch 编译失败。
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
  - 两个入口共享一个准入状态机：纯函数 gate + reducer（`results.ts`）+ 薄 React hook
    （`useDevLeadAdmission.ts`）——同渲染周期双击只会提交一条命令，未挂载后不再 setState，
    模式变化会作废旧失败提示。准入门面把 `ok:true` 但 `value: undefined`（Host 没有解析到
    命令）也当作失败（`unresolved`），不会把死入口当成功。
  - `roles=status` live region 覆盖状态条提示 / 最新通知 / 图标失败文本，保证屏幕阅读器能听到
    通知与错误；`aria-busy` / label 与 pending 状态一致。
  - 两态互斥：开启时图标隐藏，关闭时状态条消失，因此同一个开关不会同时出现两份。
- **侧边栏会话行标记**：开启 DevLead 的会话在 Session 列表行尾部显示一个盾形标记
  （`sidebar.session.row.trailing`；非交互、不绑定/不激活 Session，只按 `sessionId` 读
  summary 级 `devLeadMode`）。DSH 0.2.2-rc.1 没有“始终可见”的行 seat：`leading` seat 在
  运行中 / 有未读 / 有待处理交互时会被状态点替换，因此不用它；`trailing` seat 在桌面端
  行被悬停 / 聚焦 / 菜单打开时被 shell 隐藏，所以 `sidebar.session.row.hover` 再提供一行
  「DevLead 模式已启用」说明（i18n key `row.mark.aria` / `row.hover.enabled`），标记的
  `aria-label` 让屏幕阅读器同样能听到。图标与说明均不改变行高、不压缩标题截断宽度。
- i18n：namespace `devlead`，`zh`/`en` 词典；`locale/zh.json`、`locale/en.json` 提供
  `meta.title`/`meta.description`（插件市场展示）。
- 客户端 bundle 构建：esbuild CJS + `window.__ModuleLoader__.load({ id, factory })` 包装；
  external 列表唯一来源是 `scripts/client-externals.mjs`，必须与 DSH shell 的 platform
  seed（`packages/client/web/src/{platform,seed}.ts`）逐项且同序一致；构建期守卫会让任何
  module-table 之外的浏览器导入直接失败。
- 包 `package.json` 的 `dsh.client.inject` 列出运行期依赖（api-remotes、api-session-controller、
  client-locale、client-ui-conversation、client-ui-primitives、client-ui-renderer、
  client-ui-session、client-ui-workspace），`platform: "web"`。`client-ui-workspace` 只以
  type-only 导入进程序（取 Session 行 seat 的 SlotMap 声明），构建期 module-table 守卫不会
  把它当成浏览器运行期依赖。loader 只对真实 client entry 的 inject 名字做工厂等待，platform
  module 名字（如 primitives）会被忽略；`check-packages.mjs` 断言浏览器导入全部落在 module
  table 内。

## 8. 稳定错误码

| code | 含义 |
| --- | --- |
| `DEVLEAD_INVALID_INPUT` | 参数不可用：空 prompt、相对路径、文件路径、空引用、`limit` 非法、前缀歧义、非法 prompt 目标等 |
| `DEVLEAD_NOT_ENABLED` | 当前会话未开启 DevLead 模式 |
| `DEVLEAD_AGENT_NOT_LIVE` | 传入的 Agent 不是注册表中的 live 实例（工具侧绕过 `when` 时也走该码） |
| `DEVLEAD_WORKSPACE_NOT_FOUND` | 指定 Workspace 引用无法解析，或 Host 未组合 Workspace registry |
| `DEVLEAD_DIRECTORY_MISSING` | 目录不存在且未允许创建，或允许创建但创建失败 |
| `DEVLEAD_SESSION_NOT_FOUND` | 指定 Session 不存在（含 Host 侧 `session/not-found` 映射） |
| `DEVLEAD_SESSION_ARCHIVED` | Session 已归档，不能续写 |
| `DEVLEAD_SESSION_UNAVAILABLE` | 无法 resume / 没有 sessionController / 没有 create 能力 / followup 被拒 |
| `DEVLEAD_WATCH_LIMIT` | 监督集合超过上限 |
| `DEVLEAD_SELF_WATCH` | 试图监督或续写自己 |
| `DEVLEAD_PROJECTION_INVALID` | 持久记录损坏（fold failure） |

取消（`AbortSignal`）不映射到上面任何码：调用按标准 `AbortError` 拒绝。

## 9. 测试策略

- `protocol`：格式化 / excerpt 边界（码点预算、代理对、非法预算）/ 转场表 / 持久记录词表 /
  projection map 类型增强与 summary 排除等纯函数与类型契约。
- `devlead`：真实 `SessionStore` + 真实 `SessionProjectionRegistry`，只把 `agents` /
  `workspaceRegistry` / `sessionController` / `sessionTitle` / `sessionQuery` 换成内存 fake，
  因此每次持久写、日志事件、projection drive 与监听器派发都按生产方式跑。覆盖严格解码器
  （字段漂移 / 缺失字段 / 时间范围）、fold identity 复用、通知泵（合并窗口 / 去重 / 重试 /
  冷会话 / 归档 / dispose / 零延迟代际守卫）、Workspace 与 Session 编排、列表排序与截断、
  列表窗口外的身份解析、写路径的取消语义。
- `tool`：用 fake `ctx.devLead` + fake `ctx.tools`/`ctx.systemPrompt` 捕获工具定义，验证
  `when` gating、参数校验、值渲染、编译期 schema↔protocol 一致性、运行时 output schema
  校验、错误翻译、每个工具的 execute 转发与取消信号转发、presentCall replay 纯净性，以及
  policy 文案的角色边界契约（默认调度、写入归属、归属未明时先问或注册、无空会话）。
- `command`：解析（rawInput 契约 / 引号 / 空白 / 未知子命令）、前缀寻址（唯一 / 歧义 / 缺失
  / 列表窗口外回退）、渲染、穷尽错误码映射、单次 projection 快照。
- `client-ui`：纯函数（format / 准入状态机 gate+reducer / results 分类 / 样式 token 契约 /
  侧边栏行标记 predicate / locale 完整性与占位符一致）；组件保持薄，逻辑都下沉到可测纯函数。
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
  `/tmp` 下的隔离 `DSH_HOME` 启动真实 DSH Web，用浏览器同款 HTTP API 断言：client plugin 进入
  boot graph、`/devlead` 命令注册、`devLead` projection 默认值、`on/off` 翻转、真实子会话
  watch、被 watch 会话 `turn/end` → 持久通知 → 投影可见、以及自 watch 拒绝。子会话的模型
  凭据被剥掉，因此 turn 稳定以 provider error 结束（真实 `turn/end`，不花 token）；实例在
  结束时按 PID 关闭。该命令只在本地跑，CI 不含。
- 手动验收路径：开一个会话 → `/devlead on`（或点开关）→ 让模型
  `devlead_use_workspace` 注册一个仓库 → `devlead_create_session` 创建子会话并下发任务 →
  子会话跑完后 DevLead 被唤醒 → 状态条显示监督列表与通知；人类可打开子会话继续参与。

## 11. 非目标（本版本）

- 不做 git 仓库创建/clone/worktree 管理（用 shell 工具完成，然后注册 Workspace）。
- 不做跨进程/跨 DSH 实例编排。
- 不新增 Remote API（第三方不可用 Typert 生成管线），UI 只读 projection + 走命令。
- 不自动 resume 冷 DevLead 会话（可配置 `wakeColdSession`，默认关闭）。
- 不替人类做权限决策：模式开关只由人类命令/UI 改变。
- 不做跨进程 / 跨 DSH 实例的 Session 发现；身份解析只在本 Host 的 SessionStore /
  SessionQuery 语料内穷尽。

## 12. 审计与验证记录

本轮全面审计（对照官方 DSH `0.2.2-rc.1` 源码逐项核验 API 语义）发现并修复的问题、行为变更与
验证证据记录在 [`AUDIT.md`](AUDIT.md)。
