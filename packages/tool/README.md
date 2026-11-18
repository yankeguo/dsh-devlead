# @yankeguo/dsh-tool-devlead

The thirteen model-facing lead tools, one watched-Session report tool, and the conditional DevLead system-prompt sections.

The thirteen lead tools are registered with `when: ({ agent }) => ctx.devLead.isEnabled(agent)`,
so an ordinary Session never sees them. They become visible only after a human enables DevLead mode
with `/devlead on` or the composer-toolbar toggle (shown in both states). `devlead_report` is the
inverse condition: `ctx.devLead.isSupervised(agent)` — a non-DevLead Session watched by the unique
active lead.

## Tools

- `devlead_list_workspaces`
- `devlead_list_models` (compact Host model catalog for dispatch pinning)
- `devlead_list_agent_presets` (Host Agent preset roster: id, name/description, default marker, broken reason)
- `devlead_use_workspace`
- `devlead_list_sessions`
- `devlead_create_session` (optional `isolation: "none" | "worktree"`; creation-time
  `provider`/`model`/`reasoning_effort` and `agent_teams`)
- `devlead_get_session` (when reading the lead itself, includes its newest report digest)
- `devlead_prompt_session`
- `devlead_watch_session`
- `devlead_notifications` (notification digest + mid-turn report digest)
- `devlead_report` (watched child only: one-way `message`, `kind?`, `summary?`)
- `devlead_remove_workspace` (DSH remove: unregister only, Sessions become ungrouped)
- `devlead_archive_session` (DSH archive; `stop_running` asks the Host to stop running work)
- `devlead_unarchive_session` (restore to the recorded Workspace position)

Every lead tool requires an enabled DevLead mode; `devlead_report` requires the inverse supervised
state. Every tool except `devlead_list_workspaces` also requires a live calling Agent (`exec.agent`). Since 0.2.0 `devlead_use_workspace` forwards the live Agent to the core
`useWorkspace(agent, { path, title?, create? }, signal)`; `create` defaults to `false` (a missing
directory is `DEVLEAD_DIRECTORY_MISSING`), and `create: true` is only for a human-explicit request
to create the directory. Domain failures are translated to `HarnessError` with a stable
`DEVLEAD_*` code. Tool outputs are canonical JSON validated against their declared output
schemas.

`devlead_list_models` reports the compact Host model catalog (default selection, providers,
models, reasoning efforts, and provider failures). `devlead_list_agent_presets` reports the
Host's actual preset roster: the ids accepted by `devlead_create_session`'s `preset`, published
name/description, the `default` marker (the effective default: `selectedDefault` when configured,
otherwise the base default), and a `broken` reason for a preset that cannot compose a Session. A
Host that composes no roster returns `available: false` with a reason; the tool never invents
preset ids. The `preset` argument is always a Host-defined id; omitted or blank values fall back
to the plugin `defaultAgentPreset`, then the Host default/selectedDefault, and an invalid or
unusable id fails creation with a structured error instead of being silently ignored.

`devlead_create_session` inherits the Host default model unless the human explicitly asked for a
route or the brief needs cost/capability routing or reproducibility; when pinning, call
`devlead_list_models` first and pass `provider` + `model` (optional `reasoning_effort`). Agent
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
`devlead_archive_session` reports `{ sessionId, archived: true, stopped }` and refuses a Session
with running work as `DEVLEAD_SESSION_ACTIVE` unless `stop_running` is true;
`devlead_unarchive_session` reports `{ sessionId, archived: false }`. A lead Session cannot archive
itself (`DEVLEAD_INVALID_INPUT`).

`devlead_report` sends a one-way mid-turn update from a watched, non-DevLead Session to the
single active lead that watches it. It has no target argument: the core resolves the supervisor
from the durable watch/mode state and refuses with `DEVLEAD_NOT_SUPERVISED` when the caller is a
lead, is no longer watched, the lead is off/archived, or several historical watchers leave no
unique supervisor. The message is plain text (max 4000 code points), `kind` is
`progress|blocked|decision|fyi` (default progress), and `summary` is an optional 200-code-point
title. Reports are durable receipts in the lead's log; they appear in the status strip,
`/devlead` status, and `devlead_notifications`. Delivery reuses the notification hub's coalescing,
queueing, and cold-lead wake path, so the reporter returns immediately and never waits for a reply.
Identical messages in one turn are idempotent; more than four distinct reports in a turn fails
`DEVLEAD_REPORT_RATE_LIMITED`; empty/oversized fields fail `DEVLEAD_INVALID_INPUT`. A separate
`devlead:report-policy` prompt section tells the child when to use it and that the final turn still
uses the normal turn-end notification; the lead policy explains how to act on incoming reports.

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

`@yankeguo/dsh-tool-devlead` 提供 13 个主工具 + 1 个 `devlead_report` 与两段条件 system prompt。主工具只在 DevLead 模式开启时可见；`devlead_report` 只在非 DevLead、被唯一 active lead 监督的会话可见。除 `devlead_list_workspaces` 外都需要 live 调用者（`exec.agent`）。0.2.0 起
`devlead_use_workspace` 把 live Agent 转发给 core 的 `useWorkspace(agent, request, signal)`，
`create` 默认 `false`（缺目录报 `DEVLEAD_DIRECTORY_MISSING`，只有人类明确要求建目录时才传
`true`）。`devlead_create_session` 还支持创建时指定 `provider`+`model`（可选
`reasoning_effort`）与 `agent_teams`：模型在创建前按 Host 当前 provider 目录校验，只记录在该
子 Session 上（不走会改写 profile 默认模型的 controller 路径），省略时不动 Host 默认，且均为
仅创建时生效。`devlead_list_agent_presets` 返回 Host 的真实 preset roster（id、名称/描述、
`default` 有效默认标记、`broken` 原因；Host 未组合 roster 时返回 `available: false` 与原因，
不虚构 id）。`preset` 是 Host 定义的 id；省略/空白先回退插件 `defaultAgentPreset`，再回退
Host 默认/selectedDefault；无效 id 在创建阶段返回结构化错误，不会被静默忽略。领域错误翻译为
稳定的 `DEVLEAD_*` code。`devlead_report` 是被监督子会话的单向上报：`message`（≤4000 码点）、
可选 `kind`（progress/blocked/decision/fyi）与 `summary`（≤200），无 target 参数；相同消息同轮
幂等，每轮最多 4 条，超限报 `DEVLEAD_REPORT_RATE_LIMITED`，关系不成立报
`DEVLEAD_NOT_SUPERVISED`。报告写入 lead 的 durable receipt，进入状态条、`/devlead` 状态与
`devlead_notifications`，并复用通知的合并唤醒/冷启动队列。关闭类工具（remove / archive / unarchive）
都不是破坏性操作，且采用判断式自主：合理收尾时可自行关闭自己创建/派发且已完成的 Session、
明显陈旧/重复/空置或由自己创建的 Workspace 注册；但不得关闭人类正在使用/对话的 Session 或
Workspace、不得用关闭掩盖失败，并且每次自主关闭都要汇报原因与影响面。remove 只注销 Workspace、
其 Session 变为未分组；archive 保留日志、可恢复，运行中工作默认报 `DEVLEAD_SESSION_ACTIVE`，
传 `stop_running` 才会先归档再请求停止；lead 不能归档自己的 Session。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
