# @yankeguo/dsh-tool-devlead

The seventeen model-facing lead tools, one watched-Session report tool, and the conditional DevLead system-prompt sections/context.

The seventeen lead tools are registered with `when: ({ agent }) => ctx.devLead.isEnabled(agent)`,
so an ordinary Session never sees them. They become visible only after a human enables DevLead mode
with `/devlead on` or the composer-toolbar toggle (shown in both states). `devlead_report` is the
inverse condition: `ctx.devLead.isSupervised(agent)` — a non-DevLead Session watched by the unique
active lead.

## Tools

- `devlead_list_workspaces`
- `devlead_list_models` (compact Host model catalog for dispatch pinning)
- `devlead_list_agent_presets` (Host Agent preset roster: id, name/description, default marker, broken reason)
- `devlead_board_read` (user-visible project board, on by default for the active lead; id/title/workspace-path selection and bounded listings)
- `devlead_board_update` (lead-only project create/set, blockers, tasks, and expected-revision CAS)
- `devlead_board_note_read` (`project`, optional `note`; metadata only, with Host-derived `absolutePath` for native body reads)
- `devlead_board_note_write` (`project`, `operation: create|update-metadata|delete`, optional `note`, `title`, `summary`, and `expected_revision` CAS; create is empty and no operation accepts a body)
- `devlead_use_workspace`
- `devlead_list_sessions`
- `devlead_create_session` (optional `isolation: "none" | "worktree"`; creation-time
  `provider`/`model`/`reasoning_effort` and `agent_teams`)
- `devlead_get_session` (`last_assistant_limit` defaults to 4096 with truncation state; lead read includes its 5 newest reports; live targets include `queuedInputs`)
- `devlead_prompt_session` (`interrupt?` defaults to false: queue behind the running turn; true stops the running work and replaces it with this prompt; `interrupt_inbox?` defaults to `clear-all`, `keep`/`clear-own` restore pending inputs after the stop)
- `devlead_retract_input` (withdraw one queued inbox input by id before it runs; only this lead's own relay prompts; idempotent)
- `devlead_watch_session`
- `devlead_notifications` (notification digest + mid-turn report digest; `limit` applies to each digest separately, default 20)
- `devlead_report` (watched child only: one-way `message`, `kind?`, `summary?`)
- `devlead_remove_workspace` (DSH remove: unregister only, Sessions become ungrouped)
- `devlead_archive_session` (archive by default, restore with `archived:false`; single/ordered batch/`workspace` + `settled_only`; successful archive implies unwatch)

Every lead tool requires an enabled DevLead mode; `devlead_report` requires the inverse watched state. Mutations and Host-identity reads require a live calling Agent (`exec.agent`); `devlead_list_workspaces` does not inspect its identity. The two board tools are **lead-only**: the caller must be the current active lead that owns the board file, otherwise they fail with `BOARD_DISABLED` (no active lead, no absolute workspace root, a recorded workspace root that no longer exists, or a different Session than the active lead). Since 0.2.0 `devlead_use_workspace` forwards the live Agent to the core
`useWorkspace(agent, { path, title?, create? }, signal)`; `create` defaults to `false` (a missing
directory is `DEVLEAD_DIRECTORY_MISSING`), and `create: true` is only for a human-explicit request
to create the directory. Domain failures are translated to `HarnessError` with a stable
`DEVLEAD_*` code (board failures use `BOARD_*`). Tool outputs are canonical JSON validated against
their declared output schemas.

The board tools follow the board's default-on lifecycle: the active lead Session's original
workspace root owns `<header.cwd>/.dsh/devlead/board.json` (the optional deployment `boardPath` wins
when configured), and with no active lead / workspace root they report `BOARD_DISABLED`. A derived
(non-override) board also requires that recorded workspace root to still exist as a directory: the
Host never recreates a deleted or moved workspace just to host the board, so the tools report
`BOARD_DISABLED` until the workspace comes back or an explicit `boardPath` covers it. They never
accept a board file path argument — the path is derived by the Host or set by deployment config only.
`devlead_board_read` defaults to project summaries without tasks; a selected project includes at most
50 tasks by default and reports `truncated:true` beyond that. The whole serialized result is also
capped at 64 KiB (`DEVLEAD_BOARD_READ_MAX_BYTES`): tasks, then blockers, then whole project rows are
trimmed from the tail and `truncated:true` is set when anything was removed.
`devlead_board_update` requires explicit `create:true` plus `set.workspace.path` for a new project,
supports blocker/task patches and per-project CAS (other projects do not advance the expected revision), and returns
only the changed project without tasks. Optional `commit:true` commits only `.dsh/devlead`, returning `commitHash`
or a non-fatal `warning`. Project
references (id, workspace title, absolute workspace path) are resolved against the locked disk
snapshot and the write preflight validates against a fixed synthetic project id, so a long
workspace path/title used as the reference no longer false-fails with `BOARD_LIMIT_EXCEEDED`; unknown
references still report `BOARD_PROJECT_NOT_FOUND`/`BOARD_PROJECT_AMBIGUOUS`. A board start failure
degrades the board only: the tools report `BOARD_IO_ERROR` while DevLead keeps working. The human is
read-only; only the enabled lead AI writes.
`devlead:board-summary` is a cache-safe `systemPrompt.context()` snapshot capped at 1536 UTF-8
bytes; active-project rows include note counts and the latest note title when available. The independent lead-only
`devlead:board-policy` section tells the model to maintain the board proactively, batch updates at dispatch/close and
material project changes, prefer note list/read before resuming or briefing, create/update metadata/delete through the
tool and then edit bodies with native file tools, reconcile stale state before reporting, and report board degradation
once instead of repeatedly retrying. Ordinary Sessions see neither text nor board tools.

The two notes tools use the same active-lead gate and board-project id/title/absolute-path resolver,
but never accept a notes file path argument. They read and manage only `dirname(boardPath)/notes/`: the strict
schema-v1 `index.json` contains `{ revision, updatedAt, projects:[{ id, directory, notes[] }] }` and
metadata only, while each body is `<directory>/<note-id>.md`. Every read/create/update-metadata/delete result adds a
Host-derived `absolutePath` to returned note metadata; it is not persisted in the disk index. `create` makes an
empty body, `update-metadata` changes only title/summary, and `delete` removes the note. These tools never accept
or return Markdown bodies: all body reads/edits use DSH-native `read`/`write`/`edit` on `absolutePath`, never direct
edits to `notes/index.json`.
Tool-managed index/metadata/deletion writes use a cross-process file lock, atomic replacement, and index
`expected_revision` CAS. The index is limited to 128 KiB, each note to 256 KiB of valid UTF-8, and each project to
100 notes. The committed index is the source of truth; unindexed/orphan Markdown files are ignored. See
[docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md) for operation-specific
arguments, stable `BOARD_*` errors, and corruption semantics.

`devlead_list_models` reports the compact Host model catalog (default selection, providers,
models, reasoning efforts, and provider failures). `devlead_list_agent_presets` reports the
Host's actual preset roster: the ids accepted by `devlead_create_session`'s `preset`, published
name/description, the `default` marker (the effective default: `selectedDefault` when configured,
otherwise the base default), and a `broken` reason for a preset that cannot compose a Session. A
Host that composes no roster returns `available: false` with a reason; the tool never invents
preset ids. The `preset` argument is always a Host-defined id; omitted or blank values fall back
to the plugin `defaultAgentPreset`, then the Host default/selectedDefault, and an invalid or
unusable id fails creation with a structured error instead of being silently ignored.

`devlead_create_session` resolves an explicit `provider` + `model` (optional `reasoning_effort`) first,
then the matching `workspaceModels` entry, then `defaultModel`, then the Host default. Call
`devlead_list_models` first when pinning or configuring a route; every inherited or explicit selection is reported
in the creation result. Agent
Teams is the lead's judgment for complex, multi-step,
or parallel work (`agent_teams: true`); simple linear work omits it, and an explicit human on/off
is obeyed. The model is validated before the Session exists, the selection is recorded on the
child Session only (never through the controller's profile-default-writing path), and omitted
settings leave the Host default untouched; both settings are creation-time only. Agent Teams
requires DSH 0.2.2-rc.2 or newer with the Agent Teams service composed; on an rc.1 or otherwise
Team-less Host, `agent_teams: true` fails with `DEVLEAD_TEAM_UNAVAILABLE` and no Session is
created, so omit it (or pass `false`) and continue.

The closing tools are non-destructive and judgment-based: their descriptions and the policy text
allow autonomous, reasonable wrap-up closes (finished Sessions the lead created or dispatched,
clearly stale/duplicate/empty or self-created Workspace registrations, or a human "tidy up" request),
while forbidding closing a Session or Workspace the human is using, hiding a failure, or starting
an unrelated large cleanup; every autonomous close is reported with its rationale and impact.
`devlead_remove_workspace` returns the pre-removal Workspace snapshot plus `removed`;
`devlead_archive_session` returns ordered `{ sessions:[{ sessionId, archived, stopped?, watched? }] }` rows and
refuses running work as `DEVLEAD_SESSION_ACTIVE` unless `stop_running` is true. Successful archives unwatch;
`archived:false` restores explicit targets. `workspace` + `settled_only:true` archives all settled, unarchived
Sessions in that Workspace without a separate cleanup tool. A lead Session cannot archive itself
(`DEVLEAD_INVALID_INPUT`).

`devlead_report` sends a one-way mid-turn update from a watched, non-DevLead Session to the
single active lead that watches it. Its result is `{ report, durable, queued, warning? }`: `durable`
is true only after a durable plugin outbox write, and `warning` (with `durable: false`) is the
explicit fallback for a Host without storage-domain. It has no target argument: the core resolves the active lead that
watches it from the durable watch/mode state and refuses with `DEVLEAD_NOT_SUPERVISED` when the caller is a
lead, is no longer watched, the lead is off/archived, or several historical watchers leave no unique
active lead watching it. The message is plain text (max 4000 code points), `kind` is
`progress|blocked|decision|question|fyi` (default progress), and `summary` is an optional 200-code-point
title. Reports are first written to a durable outbox and then to the lead's log; they appear in the status strip,
`/devlead` status, and `devlead_notifications`. Delivery reuses the notification hub's coalescing,
queueing, and cold-lead wake path, so the reporter returns immediately and never waits for a reply.
Identical kind+message pairs in one turn are idempotent (the same text under a different kind is a new
report); more than four distinct non-question reports in a turn fails
`DEVLEAD_REPORT_RATE_LIMITED` (`question` reports are exempt from that budget); empty/oversized fields fail
`DEVLEAD_INVALID_INPUT`. A separate
`devlead:report-policy` prompt section tells the child when to use it and that the final turn still
uses the normal turn-end notification; the lead policy explains how to act on incoming reports and
when to invite them in a brief: optionally for a long-running watched Session whose mid-turn
milestones matter, never for short linear work, never when `watch` is false, and never as a
replacement for the final turn notice. The tool description and the child policy narrow the call
scope: the settled turn already notifies the lead, so a report is only a long-running task's
mid-turn milestone the lead must know before the turn ends (a real blocker, a decision fork,
scheduling-critical progress, or a question) — never routine progress or a final summary, and a
short or linear task should not call it.
The outbox is replayed after a restart/lead activation and cleared only after the lead log flush;
rows are pruned after seven days, and `/devlead reset` drops that lead's pending rows.

The plugin also installs a hard `tools/pre-execute` question gate: an `ask_user_question` call from a
watched non-lead Session is denied before the child's own question UI runs, formatted into a durable
`kind: question` report for the active lead, and the child is told to end its turn and wait for the
lead to answer via `devlead_prompt_session`. The gate exempts unwatched Sessions, the lead's own
questions, and a child turn whose latest actionable user message came directly from a human (the
human is already in the child conversation and may answer there). Question reports are exempt from
the four-per-turn budget; routing adds no new error code, and a failed forward degrades to "end your
turn and state the question in your final assistant message".

Queued inbox inputs are visible, retractable, and survivable across an interrupt. While the target
Session is live, `devlead_get_session` adds `queuedInputs`: each pending message's stable id, inbox
boundary (`next-turn` / `next-step`), source kind/form/sender, a bounded text excerpt, and the
enqueue instant folded from the durable `agent/inbox/spliced` log — so a stale or duplicate queued
instruction can be identified before it runs. `devlead_retract_input(session, input_id)` withdraws
one such input through the Host's per-message `inbox.remove`; only relay prompts this lead Session
authored are retractable (human, scheduled, and other producers' inputs are refused with an
explanation), the call is idempotent (`retracted: false` once consumed or withdrawn), and the target
must be live and not the lead itself. `devlead_prompt_session` accepts
`interrupt_inbox: "clear-all" | "keep" | "clear-own"` (default `clear-all`, the historical
behavior): the Host stop providers always clear the inbox, so retention is a snapshot before the
stop and a restore of the same identified messages after it — `keep` restores everything,
`clear-own` everything except this lead's own relays — in their original queue order ahead of the
replacement prompt; the result reports `retainedInputs` when a retention policy ran. The policy is
ignored without `interrupt: true` and for idle/cold targets. No new error code is added.

## Install

Normally installed as part of the bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

The package peer-depends on the default DSH composition; see the repository README for the
supported platform.

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes: tools, behavior policy, presentation](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)

## 中文

`@yankeguo/dsh-tool-devlead` 提供 17 个主工具 + 1 个 `devlead_report` 与条件 system prompt/context。主工具只在 DevLead 模式开启时可见；`devlead_report` 只在非 DevLead、被唯一 active lead 关注的会话可见。写操作与需要调用者身份的读取要求 live Agent（`exec.agent`）；`devlead_list_workspaces` 不读取其身份。两个看板工具是 **lead-only**：调用者必须是持有看板文件的当前 active lead，否则返回 `BOARD_DISABLED`（没有 active lead、没有绝对 workspace 根、记录的 workspace 根已不存在，或调用者不是 active lead）。0.2.0 起
`devlead_use_workspace` 把 live Agent 转发给 core 的 `useWorkspace(agent, request, signal)`，
`create` 默认 `false`（缺目录报 `DEVLEAD_DIRECTORY_MISSING`，只有人类明确要求建目录时才传
`true`）。`devlead_create_session` 还支持创建时指定 `provider`+`model`（可选
`reasoning_effort`）与 `agent_teams`：模型在创建前按 Host 当前 provider 目录校验，只记录在该
子 Session 上（不走会改写 profile 默认模型的 controller 路径），省略时不动 Host 默认，且均为
仅创建时生效。`devlead_list_agent_presets` 返回 Host 的真实 preset roster（id、名称/描述、
`default` 有效默认标记、`broken` 原因；Host 未组合 roster 时返回 `available: false` 与原因，
不虚构 id）。`preset` 是 Host 定义的 id；省略/空白先回退插件 `defaultAgentPreset`，再回退
Host 默认/selectedDefault；无效 id 在创建阶段返回结构化错误，不会被静默忽略。领域错误翻译为
稳定的 `DEVLEAD_*` code（看板为 `BOARD_*`）。`devlead_board_read` / `devlead_board_update` 提供
用户可见项目看板：默认启用，由唯一 active lead 的 `SessionHeader.cwd` 派生
`<cwd>/.dsh/devlead/board.json`，`boardPath` 仅作可选绝对路径 override；没有 lead 时返回
`BOARD_DISABLED`。工具从不接受看板文件路径参数。读取结果按 64 KiB 上限（tasks → blockers →
project 行从尾部裁剪，`truncated:true`）；update 使用 per-project revision CAS，可选 `commit:true`
只提交 `.dsh/devlead` 并返回 `commitHash` 或非致命 warning；project 引用在锁内快照上解析，长
workspace path/title 不再误报 `BOARD_LIMIT_EXCEEDED`，未知引用仍是
`BOARD_PROJECT_NOT_FOUND`/`BOARD_PROJECT_AMBIGUOUS`。start 失败只降级看板（`BOARD_IO_ERROR`），
不阻塞 DevLead。用户只读，只有 enabled lead AI 可通过工具写入。
动态 `devlead:board-summary` 使用 cache-safe `systemPrompt.context()`，上限 1536 UTF-8 bytes；active
项目行在有数据时附带 note 数与最近标题。独立 lead-only `devlead:board-policy` 引导模型主动维护看板，在派发/收口和
实质变化时批量更新，恢复/派发前优先用工具 list/read notes，用工具 create/更新 metadata/delete 后以原生文件工具
编辑正文，汇报前对齐过期状态，看板降级只报告一次而不反复重试；普通 Session 看不到该文案或看板工具。
`devlead_board_note_read(project,note?)` 只读取项目 notes metadata，不返回 Markdown 正文；
`devlead_board_note_write` 接收 `project`、`operation`（create/update-metadata/delete）、可选
`note/title/summary` 与 `expected_revision` CAS，任何 operation 都不接受 content。create 始终创建空文件，
update-metadata 只改 title/summary。read/create/update-metadata/delete 返回的每个 note metadata 都增加
Host 派生的 `absolutePath`（不写入磁盘 index），所有正文读写都用 DSH 原生 `read`/`write`/`edit` 作用于
该绝对路径，不要手改 `notes/index.json`。project 仍按看板 id/title/绝对 path 解析，
两个工具都不接受文件路径参数。notes 根目录固定为 `dirname(boardPath)/notes/`，index 只含 metadata，正文路径固定为
`<directory>/<note-id>.md`；工具管理的 index/metadata/删除写入使用跨进程文件锁、原子替换与
`expected_revision` CAS，index 是提交事实、orphan Markdown 忽略。index ≤128 KiB、单 note ≤256 KiB 合法 UTF-8、
每项目 ≤100 条。详见
[docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md)。`devlead_report` 返回 `{ report, durable, queued, warning? }`：报告先写入
durable outbox，lead 日志 flush 成功后才清理；Host 无 storage 时 `durable:false` 并带 warning。
报告参数：`message`（≤4000 码点）、
可选 `kind`（progress/blocked/decision/question/fyi，默认 progress）与 `summary`（≤200），无 target
参数；同轮相同 kind+消息幂等（同文不同 kind 视为新报告），每轮最多 4 条不同普通报告（`question`
报告不计入该预算），超限报
`DEVLEAD_REPORT_RATE_LIMITED`，关系不成立报 `DEVLEAD_NOT_SUPERVISED`。报告写入 lead 的 durable receipt，进入状态条、`/devlead` 状态与
`devlead_notifications`，并复用通知的合并唤醒/冷启动队列。lead 仅可在长任务且途中节点重要的
已关注会话简报中按需介绍 `devlead_report`（短线性任务不邀请）；`watch=false` 时不要写，报告也
不能替代最终 turn 通知。工具描述与子会话侧 policy 同时收窄调用范围：turn 结束自带通知，report
只用于长任务途中 lead 必须在轮次结束前知道的关键节点（真实阻塞/需 lead 决策的分叉/等待会影响
调度正确性的关键进展/提问），常规进度与最终总结不重复播报，短任务/线性任务默认不调用。
工具插件还安装硬性 `tools/pre-execute` 问题闸门：已关注非 lead 子会话的 `ask_user_question` 在其
问题 UI 运行前被拒绝，格式化为发给 active lead 的 durable `kind: question` report，子会话被要求
结束 turn、等 lead 用 `devlead_prompt_session` 在新 turn 里回答；未关注会话、lead 自己的提问、
以及当前 turn 由人类直接发起的子会话放行。问题路由不新增错误码，转发失败退化为「结束 turn 并在
最终 assistant 消息里写明问题」。`devlead_prompt_session` 支持 `interrupt?`（默认 false：排在运行中
turn 之后；true：先停止运行中工作再投递替换 prompt）。
排队 inbox 输入可见、可撤、可在 interrupt 中保留：目标 live 时 `devlead_get_session` 附带
`queuedInputs`（稳定 id、boundary next-turn/next-step、来源 kind/form/sender、≤240 码点文本摘要、
从 durable `agent/inbox/spliced` 日志反查的入队时间），便于在执行前识别过期/重复的排队指示。
`devlead_retract_input(session, input_id)` 经 Host 按条 `inbox.remove` 撤回一条排队输入；仅限
本 lead 自投的 relay prompt（人类/scheduled/其他来源拒绝并文案说明），幂等（已消费/已撤回 →
`retracted:false`），目标须 live 且非 lead 自身。`interrupt_inbox`（默认 `clear-all` 即历史行为；
`keep` 恢复全部、`clear-own` 恢复除本 lead 自投 relay 外的全部）：Host stop provider 固定清队列，
保留实现为「停止前快照 → 照常 stop → 以原 id/原 boundary 恢复」，恢复消息按原队列顺序排在替换
prompt 之前；策略实际执行时结果含 `retainedInputs`；无 interrupt 或 idle/cold 目标时忽略。不新增
错误码。
关闭类工具（remove / archive）都不是破坏性操作，且采用判断式自主：合理收尾时可自行关闭自己创建/派发
且已完成的 Session、明显陈旧/重复/空置或由自己创建的 Workspace 注册；但不得关闭人类正在使用/对话的
Session 或 Workspace、不得用关闭掩盖失败，并且每次自主关闭都要汇报原因与影响面。remove 只注销 Workspace、
其 Session 变为未分组；archive 保留日志、成功后自动 unwatch，可用 `archived:false` 恢复，支持显式批量
或 `workspace` + `settled_only:true` 清理。运行中工作默认报 `DEVLEAD_SESSION_ACTIVE`，传 `stop_running`
才会先归档再请求停止；lead 不能归档自己的 Session。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
