# dsh-devlead 设计说明

一套面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：
把**一个普通会话**升级成 **DevLead 会话**，让它能直接操纵 DSH 的 **Workspace**（工作区）与
**Session**（会话），创建/续写其他会话、读取会话状态、在会话状态变化时被唤醒，从而在一个
人类可见、可参与的标准界面里统管多个仓库。

参考实现：[`dsh-infini-goal`](../dsh-infini-goal)（同作者插件，第三方插件的包结构、构建、
bundle、安装、发布流程以它为准）。

## 1. 产品定位

- **DevLead 会话 = 普通会话 + 一个持久开关**。打开开关后，该会话额外获得一组
  `devlead_*` 工具和一段系统提示，UI 上出现 DevLead 状态条。
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
| `protocol` | `@yankeguo/dsh-devlead-protocol` | 纯类型 + 常量 + 格式化（host 与浏览器共用），并声明 `devLead` projection 的类型 |
| `devlead` | `@yankeguo/dsh-devlead` | 核心 Service `ctx.devLead`：模式状态、Workspace/Session 编排、监督索引、通知投递、projection fold |
| `tool` | `@yankeguo/dsh-tool-devlead` | 模型工具 `devlead_*` + 条件系统提示 |
| `command` | `@yankeguo/dsh-command-devlead` | 人类命令 `/devlead` |
| `client-ui` | `@yankeguo/dsh-client-ui-devlead` | 浏览器 UI：composer 上方的 DevLead 状态条与开关 |
| `bundle` | `@yankeguo/dsh-devlead-bundle` | bundle：`cordis.patch.yml` 插入全部插件 |

依赖方向：`protocol ← devlead ← {tool, command}`；`client-ui` 只依赖 `protocol`（浏览器侧）。
构建时 host 入口 external `@deepseek-ai/*`、`@yankeguo/*`、`node:*`，确保同一 profile 内只有
一份 `protocol`/`devlead` 实例。

## 3. 持久状态（Session log）

第三方插件无法扩充 DSH 的 `SessionEventMap` 词表（仓库内生成），因此所有持久状态都写
**可忽略的插件记录** `appendPluginRecord(session, type, payload)`，类型名必须以 `plugin:` 开头。
DSH 的所有读取路径会保留并重放这些记录，但不会把它们投射到模型可见的对话面。

| 记录类型 | payload | 语义 |
| --- | --- | --- |
| `plugin:devlead/mode` | `DevLeadModeRecord` | 整个开关状态（`{ kind, version:1, enabled, at }`） |
| `plugin:devlead/watch` | `DevLeadWatchRecord` | **完整**监督集合（`{ sessions: string[] }`，whole-value 替换） |
| `plugin:devlead/notification` | `DevLeadNotificationRecord` | 追加一条通知（`{ notification }`） |

- 记录 payload 必须 JSON-safe、带 `kind` + `version`；fold 对未知 `kind`/`version` 拒绝。
- 每次变更都是**先追加日志，后发通知**（与 infini-goal 一致）。
- 通知条数在 projection 里按常量 `DEVLEAD_DEFAULT_NOTIFICATION_RETENTION`（64）截断：
  fold 必须是**纯函数**，不能依赖部署 config，否则重放会分叉。

### `devLead` Session projection

- key：`devLead`，wire 值 `DevLeadProjection = { enabled, sessions, notifications }`。
- Host 侧 fold state 额外带 `failure: string | null`（首条损坏记录），wire 不带。
- 浏览器通过 `useProjection('devLead')` 读取；无需自定义 Remote API（第三方插件无法走 Typert
  生成管线，infini-goal 同样如此）。

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
  createSession(agent: Agent, request: DevLeadCreateSessionRequest): Promise<DevLeadCreatedSession>
  promptSession(agent: Agent, sessionId: string, prompt: string, options?: { watch?: boolean }): Promise<DevLeadPromptedSession>
  watchSession(agent: Agent, sessionId: string, watching: boolean): Promise<DevLeadWatchMutation>

  // 通知
  notifications(agent: Agent, options?: { limit?: number }): DevLeadNotification[]
}
```

约束：

- 所有写方法先 `assertLive(agent)`（`ctx.agents.get(agent.id) === agent`），并校验模式已开启
  （`DEVLEAD_NOT_ENABLED`）。
- 所有需要 watch 集合或"当前 lead"的读接口都显式接收 `agent`（工具调用传 `exec.agent`，
  命令调用传 `invocation.agent`）；服务不依赖 initiator 推断调用者。
- `useWorkspace`：路径必须是绝对路径；`create: true` 时缺失目录用 `mkdir -p` 创建；随后
  `ctx.workspaceRegistry.create(canonicalPath, title?)`（已存在则复用）。
- `createSession`：解析目标 Workspace（id / path / 缺省用 lead 自己的 cwd 并自动注册）→
  `ctx.sessionController.create({ workspaceId })`（该调用会自动 mkdir 并把 Session 挂进
  Workspace 的账目）→ 可选 `ctx.sessionTitle.rename(session, title)` → 可选 `promptSession`。
  注意：空白 Session 在第一次 turn 开始前不会出现在侧边栏，因此"创建+prompt"是常规用法。
- `promptSession`：先 `sessionController.resolveAgent(sessionId)` 拿到 live Agent（冷会话会被
  resume）；归档会话拒绝（`DEVLEAD_SESSION_ARCHIVED`）；然后
  `agent.followup(createUserMessage({ content, source: { kind: 'devlead', form: 'relay', senderSessionId: lead.id } }))`
  + `ctx.sessions.flush(agent.session)`。默认自动 watch。
- `watchSession`：追加完整 watch 记录；上限 `maxWatchedSessions`；不能 watch 自己。
- `notifications`：返回本会话 projection 里保留的通知（最新 limit 条）。

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
     `agent.followup(createUserMessage({ content: 渲染的摘要, source: { kind: 'devlead', form: 'notice', senderSessionId? } }))`
     + flush。Agent 正在运行也无妨：followup 排队到下一 turn。
   - lead Agent 不存活时：默认只留持久记录（`wakeColdSession: false`）；为 true 时先
     `sessionController.resolveAgent(leadId)` 再投递。
   - `agent/status` 变为 idle 时也尝试冲一次队列（例如窗口结束前 Agent 刚好在忙）。
   - `agent/disposed` 时丢弃该 lead 的内存队列（记录已持久化）。
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

`DevLeadSessionView` 由 `DevLeadService` 组装：

- live 信息：`ctx.agents.get(id)` → `running = agent.status === 'running'`，`pendingInputs` 来自
  `agent.inbox['next-turn'|'next-step']` 长度，`lastTurn` 来自
  `ctx.agents.turnBoundaryOf(agent.session).lastTurn`。
- 标题：`ctx.get('sessionTitle')?.get(agent.session)`（live）或
  `ctx.get('sessionQuery')?.readTitleSnapshots([...])`（cold，批量）。
- 日志摘要（仅 `getSession`）：`ctx.get('sessionQuery')?.readSession(id)` → 末条
  `assistant/message` 文本摘要 + 末条 `turn/end` 的 reason；读不到时省略这些字段。
- Workspace 归属：`workspaceRegistry.list()` 反查（`workspace.sessionIds`）。
- 归档：`workspaceRegistry.archivedSessionIds`。
- 所有可选服务都用 `ctx.get(...)` 判空，缺席时降级而不是报错（headless/SDK 组合可能没有）。

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
  `read`/`search` 类似语义），保持 replay 纯函数。
- 参数里的 `session`/`workspace` 接受完整 id、路径，或（会话）唯一前缀匹配；多个前缀命中时报
  `DEVLEAD_INVALID_INPUT` 并列出候选。
- 工具必须把领域错误翻译成 `HarnessError(message, code)`（模式同 infini-goal 的
  `translateToolError`）。
- `systemPrompt.section({ name: 'devlead:policy', order: ...,
  text: ({ agent }) => ctx.devLead.isEnabled(agent) ? POLICY : '' })` 提供 DevLead 行为指导
  （工作流、通知处理、汇报格式）。

## 6. 人类命令（`@yankeguo/dsh-command-devlead`）

`/devlead` 语法：

```
/devlead                  # 状态：开关、监督的会话（标题/状态）、最近通知、帮助
/devlead on               # 打开当前会话的 DevLead 模式
/devlead off              # 关闭
/devlead watch <session>  # 监督某个会话（支持唯一前缀）
/devlead unwatch <session>
```

- 状态输出用普通文本行（`CommandResult { kind: 'success', text }`）。
- `on` 需要当前 Agent live；`off` 立即生效（正在投递的通知保留在日志里）。
- UI 开关只调用 `/devlead on|off`（`ctx.remote.commands.execute`），因此命令是唯一的人类入口。

## 7. 浏览器 UI（`@yankeguo/dsh-client-ui-devlead`）

- 槽位：`conversation.input.dock`（composer 上方，infini-goal 同槽位），`order` 取一个稳定值。
- 组件 `DevLeadBar`：
  - `useProjection('devLead')`：`undefined`（加载中）→ 不渲染；`enabled=false` → 紧凑一行
    “DevLead + Switch”；`enabled=true` → 开关 + 监督会话数/运行中数（用标准 props
    `useSessions` 和 projection 的 `sessions` 计算）+ 最近一条通知摘要 + 帮助提示。
  - 开关调用注入的 `executeCommand('/devlead on'|'/devlead off')`，pending 时禁用；
    命令逻辑错误（`kind: 'error'`）在内联错误行显示。
  - `Switch` 组件来自 `@deepseek-ai/dsh-client-ui-primitives`；样式走本插件注入的 `<style>`
    标签（参考 infini-goal 的 `ensureStyleTag`），颜色用 `--dsw-*` token 并提供中性 fallback。
- i18n：namespace `devlead`，`zh`/`en` 词典；`locale/zh.json`、`locale/en.json` 提供
  `meta.title`/`meta.description`（插件市场展示）。
- 客户端 bundle 构建：esbuild CJS + `window.__ModuleLoader__.load({ id, factory })` 包装；
  external 列表必须与 DSH shell 的 platform seed 完全一致（见参考仓库 `scripts/build.mjs`）。
- 包 `package.json` 的 `dsh.client.inject` 列出运行期依赖（api-remotes、api-session-controller、
  client-locale、client-ui-conversation、client-ui-primitives、client-ui-renderer、
  client-ui-session），`platform: "web"`。

## 8. 稳定错误码

| code | 含义 |
| --- | --- |
| `DEVLEAD_INVALID_INPUT` | 参数不可用（空 prompt、坏路径、前缀歧义等） |
| `DEVLEAD_NOT_ENABLED` | 当前会话未开启 DevLead 模式 |
| `DEVLEAD_AGENT_NOT_LIVE` | 传入的 Agent 不是注册表中的 live 实例 |
| `DEVLEAD_WORKSPACE_NOT_FOUND` | 指定 Workspace 不存在 / 无法解析 |
| `DEVLEAD_DIRECTORY_MISSING` | 目录不存在且未允许创建 |
| `DEVLEAD_SESSION_NOT_FOUND` | 指定 Session 不存在 |
| `DEVLEAD_SESSION_ARCHIVED` | Session 已归档，不能续写 |
| `DEVLEAD_SESSION_UNAVAILABLE` | 无法 resume / 没有 sessionController / writer 冲突 |
| `DEVLEAD_WATCH_LIMIT` | 监督集合超过上限 |
| `DEVLEAD_SELF_WATCH` | 试图监督自己 |
| `DEVLEAD_PROJECTION_INVALID` | 持久记录损坏（fold failure） |

## 9. 测试策略

- `protocol`：纯函数单测（format/excerpt/transition 判定）。
- `devlead`：fold 单测（模式/watch/通知/损坏记录/截断）；通知泵单测（fake Agent：状态、
  followup 内容、合并窗口、dispose）；workspace/session 编排用 fake 服务单测（避免真实
  `sessionController`）；真实服务集成测试可参照 infini-goal 的 driver harness。
- `tool`：用 fake `ctx.devLead` + fake `ctx.tools`/`ctx.systemPrompt` 捕获工具定义，验证
  `when` gating、参数校验、值渲染、错误翻译、每个工具的 execute 转发。
- `command`：解析/渲染/错误路径单测。
- `client-ui`：纯函数（format/styles/results）单测；组件逻辑保持薄。
- 全仓 `pnpm typecheck && pnpm test && pnpm build` 是 `pnpm verify`。

## 10. 部署与验证

- `pnpm build` → `pnpm install:profile [--profile desktop]` 链接包并选中 bundle；
  profile HMR 加载 host 插件，刷新 Web 页面加载浏览器插件。
- 开发/E2E 也可用 `pnpm dev:patch` 生成 overlay：
  `dsh web --patch .tmp/cordis.patch.yml --port 34000 --no-open`。
- 验收路径：开一个会话 → `/devlead on`（或点开关）→ 让模型
  `devlead_use_workspace` 注册一个仓库 → `devlead_create_session` 创建子会话并下发任务 →
  子会话跑完后 DevLead 被唤醒 → 状态条显示监督列表与通知；人类可打开子会话继续参与。

## 11. 非目标（本版本）

- 不做 git 仓库创建/clone/worktree 管理（用 shell 工具完成，然后注册 Workspace）。
- 不做跨进程/跨 DSH 实例编排。
- 不新增 Remote API（第三方不可用 Typert 生成管线），UI 只读 projection + 走命令。
- 不自动 resume 冷 DevLead 会话（可配置 `wakeColdSession`，默认关闭）。
- 不替人类做权限决策：模式开关只由人类命令/UI 改变。
