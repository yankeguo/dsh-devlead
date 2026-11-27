# dsh-devlead

**English** · [简体中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)

A plugin suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that
upgrades **one ordinary session** into a **DevLead session**: it can operate DSH **Workspaces** and
**Sessions** directly, create and continue other Sessions, read their state, and be woken when
their state changes — so one agent can orchestrate multiple repositories inside a standard
interface the human can see and interact with.

Current release candidate **0.4.3-rc.2** (prerelease, npm dist-tag `next`; stable `latest` stays
**0.4.2**) · DSH **0.2.2-rc.1 – 0.2.2-rc.5** · one `dsh plugin` command installs everything.

## What you get

| Capability | What it means for you |
| --- | --- |
| **One durable switch per session** | `/devlead on` turns the current session into a DevLead. The switch is human-only and host-wide: at most one session can hold it, and it survives restarts until a human turns it off. |
| **A dispatcher, not an implementer** | The DevLead decides which Workspace owns a request from registered metadata, sends a self-contained brief to a Session there, watches it, reviews the delivery, and reports. Deeper investigation and implementation stay in the child Session. |
| **Real DSH entities** | Workspaces go through `ctx.workspaceRegistry`; children are ordinary Sessions visible in the sidebar that you can open, continue, archive — not hidden subagents. |
| **Notification loop** | When a watched Session's turn settles, a durable notification wakes the DevLead so it can follow up, dispatch new work, or report. The watch index is rebuilt from durable records after a restart. |
| **17 lead tools + 1 report tool** | Register/list/remove Workspaces, list Host models and Agent presets, create/read/continue/archive/restore/watch Sessions, inspect and retract queued inbox inputs, read the notification and report digest, and maintain the user-visible project board and per-project Markdown notes that are on by default for the active lead. Watched children get a one-way `devlead_report`. |
| **Human commands** | `/devlead`, `/devlead on\|off`, `/devlead reset`, `/devlead watch\|unwatch <session>` — Sessions are addressable by full id or unique prefix. |
| **Optional worktree isolation** | When the Host composes DSH's experimental Git worktree service, a dispatched Session can get its own branch and checkout instead of sharing the Workspace checkout. Missing capability degrades to the shared checkout with a reported status. |
| **Web UI** | A labelled DevLead toggle, a status-only DevLeadBar, active/watched sidebar marks, and a lead-only read-only project board with visibility-aware automatic refresh, a single-line KPI pill strip, compact responsive 2/3/1-column cards with row-aligned sections and title-row priority glyphs, per-project notes chips, and a safe full-pane Markdown notes reader in the right Sidebar. |

## How it compares with subagent / agent-team

| Dimension | subagent / agent-team | DevLead |
| --- | --- | --- |
| Identity of the work product | internal child agents of the dispatching side, usually not independently openable ordinary sessions | genuinely registered Workspaces + ordinary Sessions, visible in the sidebar, openable/continuable/archivable by humans |
| Human visibility | the human usually only sees the final summary | the human sees everything and can take over any child session at any time |
| Interaction model | the model dispatches and waits inside a single turn | the DevLead session is itself an ordinary session; the model orchestrates across turns with `devlead_*` — it dispatches, ends its turn, and a settle wake-up starts a new turn — while the human can join in the same UI |
| Lifecycle | ends with the parent turn / parent agent | child sessions exist independently and can be continued; `turn/end` notifications are durable and survive restarts |
| Switch | none | **human-only** `/devlead on\|off` or the composer-toolbar toggle; no model tool can enable it |
| Best for | one-off parallel subtasks | cross-repository, long-running orchestration that needs continuous human participation and review |

Rule of thumb: use subagent / agent-team for one-off parallel subtasks; use DevLead when an agent
should own several repositories over time and the human wants to see and take over every child
session.

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | **0.2.2-rc.1 – 0.2.2-rc.5** (the plugin and bundle packages declare `engines.dsh: >=0.2.2-rc.1 <0.3.0`; DSH's loader skips bundles whose range does not match) |
| UI platform | the DSH desktop app or `dsh web`; the DevLead UI renders on the **Web** platform only |
| Experimental bundles | none required. DevLead is built for the default Web composition (`dsh-base` + `dsh-web-app`) |
| Agent Teams (optional) | `agent_teams: true` on dispatch needs DSH 0.2.2-rc.2+ and a Host that composes `agent-team` |
| Worktree isolation (optional) | needs an experimental DSH worktree service composed in the profile; off by default |
| Node.js / pnpm | only needed to build from source — see [docs/CONTRIBUTING.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/CONTRIBUTING.md) |

The full compatibility matrix (per DSH release, including upstream API caveats and upgrade gates)
is in [docs/COMPATIBILITY.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/COMPATIBILITY.md).

## Install

### From npm (recommended)

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

This installs the main bundle: the core Host service, the model tools, the `/devlead` command, and
the browser UI. You can also install it from the Web UI via **Plugins → Add plugin** with the name
`@yankeguo/dsh-devlead-bundle`. Afterwards, confirm the bundle is enabled on the **Plugins** page
(freshly installed bundles are usually enabled by default; tick it if not), then reload the Web
page.

To pin an exact version:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle@0.4.3-rc.2
```

0.4.3-rc.2 is the currently published prerelease candidate. The next candidate, 0.4.3-rc.3 (not yet
published), retains the rc.1/rc.2 contract changes and adds another **breaking configuration change**:
deployment key `boardPath` is renamed to `statePath`, whose value is now a **relative directory**,
defaulting to `.dsh/devlead`. It is resolved against the active lead Session's original workspace root
(`SessionHeader.cwd`, not a worktree checkout): board data is `<workspace>/<statePath>/board.json`, and
notes are `<workspace>/<statePath>/notes/{index.json,<project>/<note-id>.md}`. The value names a directory,
not an exact board JSON file, and there is no separate notes-path setting. The browser global's resolved
absolute `boardPath` field is also renamed to `boardFilePath`, and the Host's `boardPathOverride` observation
field becomes `statePathOverride`; mixed pre-rc.3/rc.3 Host and client versions are not guaranteed to keep
this global compatible. Absolute POSIX, Windows drive and UNC paths, backslashes, empty segments and `..`
escapes are likewise rejected. See the
[0.4.3-rc.3 release-notes draft](https://github.com/yankeguo/dsh-devlead/blob/main/docs/releases/v0.4.3-rc.3.md);
rc.1's tool migrations and rc.2's workspace-relative location requirement still apply, and the previous
stable patch is documented in the
[0.4.2 release notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/releases/v0.4.2.md).

Advanced users can install individual packages and insert the corresponding loader rows into the
profile's `cordis.patch.yml` themselves; the bundle is the recommended path.

### Upgrade

```sh
# upgrade the bundle to the latest release
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle

# or pin a specific version (required for prereleases)
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle@0.4.3-rc.2
```

> **Upgrading from an older release (below 0.4.0):** 0.4.0 intentionally discards older DevLead
> session state (mode, watch set, notification digest, answer state) instead of migrating it. After
> upgrading, open each affected DevLead session and run the human-only `/devlead reset`, then
> `/devlead on` again. See
> [0.4.0 release notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/releases/v0.4.0.md)
> and [docs/COMPATIBILITY.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/COMPATIBILITY.md)
> for the full upgrade notes.

### Uninstall

```sh
dsh plugin --profile desktop remove @yankeguo/dsh-devlead-bundle
```

DSH cleans up the removed bundle selection the next time it loads the profile.

Release history and per-version notes live in
[GitHub Releases](https://github.com/yankeguo/dsh-devlead/releases) and
[docs/releases/](https://github.com/yankeguo/dsh-devlead/tree/main/docs/releases).

## Quick start

1. Open the session that should orchestrate several repositories and run `/devlead on` (or click
   the DevLead button in the composer toolbar). Only one Session per Host can hold the mode.
2. Ask in natural language. The DevLead decides which registered Workspace owns the request,
   registers repositories when needed (`devlead_use_workspace` takes an absolute path and never
   creates a missing directory unless explicitly asked), and asks instead of guessing when
   ownership is unclear.
3. The DevLead dispatches a **self-contained brief** to a child Session in the owning Workspace:
   background, target result, open questions the child must confirm or refine, deliverables, how
   to verify them, and what not to touch. The child cannot see the lead's conversation, so every
   necessary fact is restated in the brief.
4. The child runs independently. You can open it from the sidebar, continue the conversation, or
   take over at any time. The DevLead ends its turn instead of waiting.
5. When the child's turn settles (completed / failed / blocked / cancelled / …), the DevLead is
   woken with a durable notification. It inspects state, follows up, or reports back to you.
6. The DevLead reports which Workspaces and Sessions it created, changed, or closed, what each
   child was asked to do, how the latest turn ended, and anything that needs a human decision.

A request you can paste at a DevLead session:

```text
Turn DevLead mode on for this session. Register /Users/me/Workspace/src/api and
/Users/me/Workspace/src/webapp as workspaces, then open one child session in each — fix the
CI failure in the first and add the missing README in the second. Summarize when both finish;
follow up on failures instead of claiming success.
```

## Using the DevLead session

### Turn the mode on and off

The mode switch is **human-only**: run the command in any session, or click the DevLead button in
the composer toolbar. For a top-level Session the button is present in both states: it sends
`/devlead on` while the mode is off and `/devlead off` while it is on. A subagent Session never
shows the button (nor the status bar); it cannot become a DevLead.

```text
/devlead on        # enable DevLead mode for the current session (requires a live Agent)
/devlead off       # disable; stops notification delivery immediately, retained records stay in the Session log
/devlead reset     # human-only recovery: discard this session's DevLead state (also recovers a frozen fold)
/devlead           # show status: mode state, worktree capability, watched sessions, latest notifications
/devlead status    # explicit alias of the above
```

### Commands

| Command | Purpose |
| --- | --- |
| `/devlead` | status: mode, whether optional worktree isolation is available, watched sessions (title / live / running / latest turn when known), latest notifications, help line |
| `/devlead status` | alias of `/devlead` |
| `/devlead on` | enable DevLead mode for the current session |
| `/devlead off` | disable it; on a frozen (damaged) fold this also performs the implicit reset and recovers the session |
| `/devlead reset` | human-only recovery: discard this session's mode / watch set / notification digest / frozen failure and return to the default disabled state |
| `/devlead watch <session>` | watch a session (full id, unique prefix, or uuid first segment without `session-`) |
| `/devlead unwatch <session>` | stop watching it |

### One active lead at a time

DevLead mode is a Host-wide resource: at most one Session may be enabled, regardless of Workspace.
`/devlead on` in a second Session fails with `DEVLEAD_ALREADY_ACTIVE`; the error names the
occupying Session and tells the human to run `/devlead off` there first. The refused Session's own
projection stays disabled, so its toolbar button stays off and no status strip appears.

Release and recovery semantics:

- `/devlead off` (and `/devlead reset`) releases the slot immediately.
- **Archiving the holder releases it.** An archived Session is not an active lead and never blocks
  a new `on`; DevLead records a durable mode-off or a tombstone and warns. `/devlead status` lists
  such holders under `Archived DevLead holders (ignored for admission)`; unarchive and run
  `/devlead off` there, or delete it.
- A cold, unresumable holder that is **not** archived still blocks admission: it is a real enabled
  lead whose state cannot be changed without opening it.
- **Permanently deleting** the holder releases the slot naturally.
- A settled turn, a cold detach, or an Agent disposal **does not** release the slot: the Session
  and its durable mode still exist until the human turns it off, archives it, or deletes it.
- On restart DevLead rereads live projections plus the durable corpus, keeps one enabled Session,
  and writes mode-off for the rest with a warning. If the Host cannot prove the occupancy state,
  admission fails closed with `DEVLEAD_SESSION_UNAVAILABLE` instead of risking a second active
  lead.

### Watch and address sessions

- `watch` / `unwatch` require the current session to have DevLead mode enabled; you cannot watch
  yourself; the watch set is capped (default 64).
- Session references accept a **full id, a unique id prefix, or the uuid first segment with the
  `session-` prefix omitted** (`e59ab350` addresses `session-e59ab350-…`). An ambiguous reference
  returns a friendly error with the candidates; use a longer prefix or the full id.
- Only watched Sessions produce notifications.

### Dispatch work to child sessions

The lead tools are **model-facing**; humans never call them directly. What matters when you talk
to a DevLead session:

- **Workspace references** accept a Workspace id, its registered canonical directory path, or its
  exact display title. A title shared by several Workspaces fails as ambiguous instead of picking
  one.
- **`devlead_create_session`** takes a self-contained prompt plus optional `title`, `workspace`,
  `preset`, `provider`/`model`/`reasoning_effort`, `agent_teams`, and `isolation`. New Sessions are
  watched by default and start their first turn immediately; a blank Session is not visible in the
  sidebar, so "create + prompt" is the normal usage.
- **Agent presets** are Host-defined ids: the lead calls `devlead_list_agent_presets` first and
  never assumes a fixed list. Omitting `preset` falls back to the plugin default, then the Host
  default.
- **Models** are inherited from the Host default unless you explicitly ask for a different one or
  the brief needs cost/capability routing or reproducibility. Model selection and `agent_teams`
  are creation-time only and never change the Host/profile defaults.
- If a child is already working on the request in that Workspace, the lead continues it with
  `devlead_prompt_session` instead of opening a duplicate.

### Follow up, answer questions, and steer

`devlead_prompt_session` delivers a prompt to a child Session. Its `intent` selects the delivery
semantics: `instruction` (default) queues behind the running turn; `answer` (requires
`question_id`) and `correction` steer the child's next step; `background` injects context without
requesting a wake. A new prompt is queued behind a running turn by default — `interrupt: true`
replaces the child's current work (stopping the running turn, subagent descendants, owned jobs,
and active schedule rows) and `interrupt_inbox` decides what happens to queued input
(`clear-all` by default, `keep`, or `clear-own`, which keeps pending answers).

Queued inputs are visible and retractable while the target is live: `devlead_get_session` lists
`queuedInputs` (id, boundary, source, bounded text excerpt, enqueue time) and
`devlead_retract_input` withdraws one of the lead's own inputs before it runs. Answers are not
retractable — use `interrupt: true` with `interrupt_inbox: "clear-all"` to discard one and reopen
its question.

**Questions from watched children.** A watched child cannot ask the human directly: its
`ask_user_question` call is intercepted before the question UI runs and forwarded to the active
lead as a durable `question` report; the lead then answers from context (or asks the human from the
lead) and relays the answer with `devlead_prompt_session intent: "answer"`, `question_id` set to
the report id. The answer steers the child's next step — next-step priority, not preemption. The
gate is skipped when the child's turn was opened by a direct human message, because the human is
already in that conversation.

**Mid-turn reports.** A watched non-lead Session can send one-way updates with `devlead_report`.
Use it only for milestones the lead must know before the turn ends: `blocked`/`decision` steer an
action-required wake, `progress`/`fyi` inject non-urgent background context without a wake, and a
durably forwarded `question` requests the end of the child's turn. A settled turn already notifies
the lead, so routine progress and final summaries are not reported. Limits: at most four distinct
non-question reports per child turn (`question` reports are exempt), and at most 16 pending
action-required reports per lead/child pair.

### Read state, notifications, and reports

- `devlead_list_sessions` lists Sessions (optionally filtered by Workspace or watched only).
- `devlead_get_session` reads one Session in detail, including `lastTurn`, `lastTransition`,
  `lastError`, and `lastAssistant`; when reading the lead itself it also carries its five newest
  retained reports.
- `devlead_notifications` returns the notification digest and the mid-turn report digest. Report
  rows carry diagnostic `lane`/`deliveryState` fields; question reports carry `questionStatus`
  (`open`/`answered`/`expired`/`cancelled`) and, when answered, `answerStatus`
  (`admitted`/`claimed`/`presented`/`discarded`). Only `presented` means the answer reached the
  child; `answered` alone does not.
- The projection keeps the latest **64** notifications; older records remain in the Session log.

### Close sessions and workspaces

The two closing tools use DSH's own vocabulary and are never destructive:
`devlead_remove_workspace` unregisters the Workspace only (files and Session logs stay; its
Sessions become ungrouped). `devlead_archive_session` archives with `archived:true` (the default) and restores with
`archived:false`; successful archives also unwatch. Each call handles exactly one `session`; use the runtime's
orchestration for multiple Sessions instead of a separate batch API. A Session with running
work is refused as `DEVLEAD_SESSION_ACTIVE` unless `stop_running: true` is passed, which archives
first and then asks the Host to stop that work.

Closing is **judgment-based**: the model may archive finished wrap-up Sessions it created or
dispatched, or remove clearly stale, duplicate, or empty Workspace registrations it created,
without item-by-item instructions. The guardrails are: never close a Session or Workspace the human
is using now, never hide a failure or skip reporting, never start an unrelated large cleanup, and
prefer archiving over unregistering. Every autonomous close is reported with its rationale and
impact. The lead cannot archive its own Session.

### Optional worktree isolation

Multiple Sessions dispatched into the same checkout can interleave their edits. When the Host
composes DSH's **experimental Git worktree** facility, `devlead_create_session` accepts
`isolation: "worktree"` and gives the new Session its own branch and checkout before its first
prompt is admitted. The Session keeps its Workspace membership in the sidebar; only its working
directory moves into `<checkout root>/.agents/worktrees/<generated name>`. The result reports
`path` / `branch` / `baseCommit` on success.

Key constraints:

- **Off by default.** The default Web composition does not provide the worktree service; enable it
  only by composing the experimental worktree bundle in the profile. No extra package is installed
  for DevLead.
- **Best-effort.** A missing service or a failed `git worktree` never fails the dispatch: the
  Session stays in the Workspace checkout and the creation result carries
  `isolation: { requested: 'worktree', status: 'unavailable' | 'failed', reason }`. When the
  outcome is not `worktree`, serialize writing Sessions instead of running them concurrently in
  the same checkout.
- **Only new Sessions.** The worktree starts at the source checkout's `HEAD`; uncommitted, staged,
  untracked, and ignored files are not copied, so commit or stash anything the isolated Session
  must see. The child's sandbox policy must allow writing the checkout and the shared Git
  administration directory.
- **The lead owns the branch.** Review the diff and merge or cherry-pick it when accepted; nothing
  is merged automatically.

`/devlead status` always prints `Worktree isolation: available|unavailable`, so a human can tell
whether the Host could isolate at all.

## Tool reference

The seventeen lead tools are visible only in a DevLead session; `devlead_report` is visible only in
a watched non-lead Session. All `workspace` arguments accept an id, a registered path, or an exact
title. All `session` arguments accept a full id, a unique prefix, or the uuid first segment. Board-note
`project` arguments accept a board project id, workspace title, or absolute workspace path; neither
notes tool accepts a file path.

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `devlead_list_workspaces` | list registered Workspaces | — |
| `devlead_list_models` | compact Host model catalog (default, providers, failures) | — |
| `devlead_list_agent_presets` | Host Agent preset roster with the effective default | — |
| `devlead_board_read` | read the user-visible project board (bounded result) | `project?`, `include_tasks?`, `limit?` |
| `devlead_board_update` | lead-only project status/blocker/task update | `project`, `expected_revision?`, `create?`, `set?`, `blockers?`, `tasks?` |
| `devlead_board_note_read` | read one project's note metadata and native body paths | `project`, `note?` |
| `devlead_board_note_write` | create an empty note, update metadata, or delete it with index CAS | `project`, `operation: create/update-metadata/delete`, `note?`, `title?`, `summary?`, `expected_revision?` |
| `devlead_use_workspace` | register a Workspace (idempotent) | `path` (absolute), `title?`, `create?` (default false) |
| `devlead_list_sessions` | list Sessions | `workspace?`, `watched_only?`, `limit?` |
| `devlead_create_session` | create + optionally prompt a child Session | `workspace?`, `prompt?`, `title?`, `watch?`, `preset?`, `isolation?`, `provider?`+`model?`, `agent_teams?` |
| `devlead_get_session` | read one Session (lead read includes newest reports) | `session`, `last_assistant_limit?` (default 4096) |
| `devlead_prompt_session` | prompt / answer / steer a child | `session`, `prompt`, `intent?`, `question_id?`, `idempotency_key?`, `watch?`, `interrupt?`, `interrupt_inbox?` |
| `devlead_retract_input` | withdraw one queued inbox input before it runs | `session`, `input_id` |
| `devlead_watch_session` | add/remove a watch | `session`, `watching` |
| `devlead_notifications` | notification + report digests | `limit?` |
| `devlead_report` | one-way mid-turn report (watched child only) | `message`, `kind?`, `summary?` |
| `devlead_remove_workspace` | unregister a Workspace (files and logs untouched) | `workspace` |
| `devlead_archive_session` | archive/restore one Session; archive implies unwatch | `session`, `archived?`, `stop_running?` |

Domain failures use stable `DEVLEAD_*` / `BOARD_*` error codes (including notes CAS and missing-note
failures) and are rendered as friendly text. Read state from `lastTurn` / `lastTransition` / `lastError` /
`lastAssistant` instead of guessing.

## Waiting, waking, and reports

- **End the turn instead of waiting.** Dispatch is asynchronous: after
  `devlead_create_session` / `devlead_prompt_session` the DevLead must not wait inside the same
  turn (no `sleep`, no polling with the read tools, no Agent Teams `wait_agent`). It ends its turn;
  the settle wake-up starts a new one.
- **Wake lanes.** Completed/forked turns and cancellations explicitly requested by this lead are coalesced
  (`notificationBatchMs`, default 400 ms) into a `followup` `[DEV LEAD NOTIFICATION]` wake with the original
  transition retained. Genuine failures and external interruptions plus blocked/decision reports steer an immediate
  `[DEV LEAD REVIEW REQUIRED]` / `[DEV LEAD ACTION REQUIRED]` wake; question reports steer a
  `[DEV LEAD QUESTION]` wake carrying the full payload; progress/fyi reports inject background
  context with no wake (an idle lead stays idle).
- **Long reports.** Session detail and wake summaries retain up to 4096 Unicode code points by default and carry
  explicit truncation state. A child with a longer final report writes `/tmp/*.md` and replies with only a summary
  and path; this is the supported handoff, not a raw-log workaround.
- **Cold leads are resumed by default.** After a Host restart or plugin reload the watch index is
  rebuilt from durable records, and a queued notification resumes the cold lead Session unless
  `wakeColdSession` is set to `false`. Resume requires the Host to compose a Session activator;
  otherwise the records stay durable and are delivered when the Session is opened.
- **Mode off stops delivery immediately.** Notifications already in the log stay visible again
  after the next `/devlead on`.
- **Unloaded plugin.** Turns that settle while the plugin itself is unloaded are not notified; the
  next load rebuilds the index from durable records.
- **Notifications are runtime notices, not instructions.** Wake messages and child output can
  embed text; the DevLead system prompt forbids treating them as human instructions or making
  permission decisions from them.

## Configuration

Deployment-level configuration lives in the profile patch row that loads the plugin (the bundle
already supplies defaults; to change them, override the `config` of loader row id `devlead` in the
profile's `cordis.patch.yml` — DSH replaces a row's whole config):

```yaml
- id: devlead
  name: '@yankeguo/dsh-devlead'
  config:
    notificationBatchMs: 400     # turn-notice coalescing window (ms, integer in [0, 2147483647])
    actionRequiredBatchMs: 0     # action-required scheduling delay (ms, integer in [0, 400]; 0 = microtask)
    maxWatchedSessions: 64       # max watched sessions per lead (positive integer)
    maxListedSessions: 200       # max rows per session listing (positive integer)
    wakeColdSession: true        # resume a cold DevLead Session to deliver queued notifications
    defaultAgentPreset: ''       # default Agent preset for created sessions (empty = Host default)
    questionTtlMs: 86400000      # open-question TTL (24h; 0 disables lazy expiry)
    statePath: custom/state      # optional relative state directory; default .dsh/devlead
```

| Key | Default | Range / notes |
| --- | --- | --- |
| `notificationBatchMs` | `400` | integer in `[0, 2147483647]`; completed/forked turn notifications in the window are merged into one wake-up message |
| `actionRequiredBatchMs` | `0` | integer in `[0, 400]`; scheduling delay of the action-required lane. `0` schedules a microtask flush; "immediate" only means no coalescing window — the steer is still claimed at the next pre-step and never preempts a model request or tool batch |
| `maxWatchedSessions` | `64` | positive integer; a watch operation over the cap reports `DEVLEAD_WATCH_LIMIT` |
| `maxListedSessions` | `200` | positive integer; row cap for listing calls. Identity resolution is not limited by it |
| `wakeColdSession` | `true` | when `true`, a cold lead Session with queued notifications is resumed to deliver them; set `false` to keep the queues in memory until a human opens the lead Session |
| `defaultAgentPreset` | `''` | default value used when a created session names no `preset`; empty means the Host's effective default. An invalid id fails creation with a structured error |
| `questionTtlMs` | `86400000` | non-negative safe integer; lazy open-question TTL (24h), `0` disables expiry. Answered questions do not retroactively expire |
| `statePath` | `.dsh/devlead` | optional **relative directory** resolved against the active lead Session's original workspace root (`SessionHeader.cwd`, not a worktree checkout). The board is `<workspace>/<statePath>/board.json`; notes are `<workspace>/<statePath>/notes/{index.json,<project>/<note-id>.md}`. This key names the state directory, not the JSON file, and there is no independent notes-path setting. Omitting it uses the default; blank is not a fallback alias. Absolute POSIX paths, Windows drive/UNC paths, backslashes, empty segments, and `..` escapes fail fast at Loader/direct construction with structured `BOARD_INVALID` and `/statePath`. The final derived `board.json` must not be a symlink; symlinks in the parent directory chain are fine. Only the lead AI writes through tools; humans/browser clients are read-only. See [docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md) |

The board is enabled by default and follows the single active lead: that Session's original workspace
root (its `SessionHeader.cwd`, not a worktree checkout) owns the file, and turning the lead off, switching
leads or changing the workspace releases the old store and reads the new file immediately. With no active
lead or no absolute original workspace root (including when a custom `statePath` is configured) the board is disabled: the tools report `BOARD_DISABLED`, the summary
is empty and no board UI appears. Both the default and a custom state directory require that the lead's
recorded original workspace root still exists as a directory: if it was deleted or moved, the Host keeps
the board disabled (`boardDisabledReason = missing-workspace`), logs one warning and **never recreates the
workspace** just to host the board; returning the original workspace lets the next
lead sync/switch resolve either the default or custom state path again. A start failure (for example an unwritable directory) degrades only the
board — DevLead keeps loading and the board tools report `BOARD_IO_ERROR`; the next lead sync (even to the
same path) or path switch retries `start()`.

The board uses locked fresh reads and per-project `expected_revision` CAS: each project carries the board generation
that last changed it, so updates to another project do not cause false conflicts. Legacy missing project revisions are
backfilled from the file revision and persisted on first Host read. Update results omit tasks; a
selected-project read includes at most 50 tasks and sets `truncated:true` when more exist. Read results are
also capped at 64 KiB (`DEVLEAD_BOARD_READ_MAX_BYTES`): tasks, then blockers, then whole project rows are
trimmed from the tail and the result sets `truncated:true` when anything was removed. I/O failures use
`BOARD_IO_ERROR`; re-read before retrying because a post-replace `stat` failure can occur after the new
revision has committed. See [docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md)
for the strict schema, corruption handling, and durability boundary. The wire schema and limits are
owned by `@yankeguo/dsh-devlead-protocol` and shared by the Host validator and the browser decoder.

Project notes share the configured state directory: the board is `<workspace>/<statePath>/board.json`, the
strict schema-v1 metadata-only index is `<workspace>/<statePath>/notes/index.json`, and each Markdown body is
`<workspace>/<statePath>/notes/<sanitized project>/<note-id>.md`. There is no independent notes path. The index is capped at 128 KiB, each note at
256 KiB, and each project at 100 notes; `board.json` itself is unchanged. The lead uses
`devlead_board_note_write` only to create an empty note, update title/summary, or delete; `expected_revision`
protects index metadata writes. **Note tools never accept or return Markdown bodies.** All body reads/edits use
DSH-native `read`/`write`/`edit` on the returned `absolutePath`, never direct `notes/index.json` edits. Humans and
browser clients remain read-only. Host note reads/lists stat bodies to reconcile `bytes` and file `updatedAt` under
the index lock, without reading or rewriting them; missing files or a body over 256 KiB return structured errors
and leave the index untouched. The browser derives the notes root from the already-resolved board path and uses
only the existing Workspace Files Remote; it never accepts an arbitrary path or exposes a write API. Note ids and
paths collide case-insensitively and Windows reserved device names are rejected.
See [docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md) for the complete index schema,
error codes, malformed-index recovery, orphan/GC cleanup after board rebuilds, and durability boundary.

For an enabled lead, the separate `devlead:board-policy` system-prompt section makes this an active workflow:
batch board updates at dispatch/close and material project changes, read notes before resuming or briefing work,
create/index notes through the tool, edit their Markdown through native file tools, and reconcile stale state before reporting. It also avoids transcript/log
dumps and repeated retries after `BOARD_DISABLED` / `BOARD_IO_ERROR`; ordinary Sessions never see this guidance.

`tool` / `command` / `client-ui` have no deployment configuration; domain limits (watch cap,
notification retention, etc.) are owned by the core service and protocol constants. Optional
worktree isolation has **no configuration key**: it exists only when the profile composes the
experimental worktree service, and it is used per dispatch via the `isolation` argument.

## UI

The UI has two states and one switch. The plugin deliberately never puts an attention-grabbing
permanent bar on every conversation:

- **Top-level Sessions always show a composer-toolbar toggle** (a small users icon + `DevLead`
  label, next to the permission dropdown). Off: hovering shows "Turn on DevLead mode" and clicking
  sends `/devlead on`. On: the same button stays in place, gains the business-accent border and a
  light halo, and clicking sends `/devlead off`. Subagent Sessions never render the toggle or the
  bar.
- **On:** a status-only DevLeadBar appears above the composer: the brand, watched/running counts,
  and the latest notification or report (or a help hint). Question/blocked/decision chips use the
  warning color and show the question lifecycle; progress/fyi chips are weakened background
  context. The bar owns no switch, so turning the mode off never hides the control that did it.
- **Sidebar marks:** the active DevLead row gets a small sparkle + `LEAD` corner badge with a localized
  aria-label/title, never a whole-row highlight or a change to the shell's selected/hover/focus treatment;
  watched non-lead rows get a quieter target glyph. Both come from summary projections, so they render for
  cold rows and after a restart without per-row Host reads. DSH 0.2.2-rc.1 does not render the trailing seat on
  a blank (no-turn-yet) Session row, so a brand-new Session shows its mark after the first turn;
  search results use a separate row surface and show no mark.
- **Project board (lead-only, on by default):** the tab, its guide entry and the Session-header
  button exist only in the on-screen Session that is the active DevLead; other Sessions (and off/old
  leads) show no board entry, and opening the board requires the lead. With the default `statePath`,
  the file is `<lead Session header cwd>/.dsh/devlead/board.json`, published to the browser while the
  lead owns it. If the page was loaded before the lead was enabled, the client derives that default
  path from the lead Session's summary `cwd`; a deployment that sets a custom `statePath` needs a page refresh
  in that late-enable case, because only a fresh page load carries the custom resolved path. Turning the mode
  off or switching leads re-renders immediately and never keeps reading the old file and closes the
  on-screen Session's lingering board tab (including a tab restored from a previous page load). The panel
  reads the board file directly — the schema's 256 KiB file cap applies, not the model tool's 64 KiB
  read cap. The header and guide use a clear dashboard icon with a localized tooltip/aria-label. The panel keeps
  blocked/active/paused/done KPIs with status icons in a single-line pill strip beside compact revision/updated and
  visible Live metadata. Zero counts are neutral; only blocked>0 earns the strong warning emphasis, and KPIs, groups,
  and the banner share one summary. Four-side card borders and light surfaces depend only on status (active=business,
  blocked=warning, paused=neutral, done=success); priority stays in its independent badge. Blocked projects lead with
  a strong warning; compact active cards use responsive two- or three-column layouts (one column when narrow), avoid redundant visible field labels,
  retain focus/next/blockers and task progress, and give icons accessible tooltips. Paused/done and
  unlisted projects use secondary disclosures.
  File changes retain a 120 ms debounce, and every state is polled: ready/loading at a fixed 5 s
  cadence by default, empty/error with 5 s exponential backoff capped at 30 s. Polling runs only
  while the document is visible and focused; resume triggers an immediate coalesced read, while blur,
  hidden, unmount, and path changes clear timers. Watch/poll/resume reads share one in-flight request, bounded by a
  10-second stat/readBytes watchdog: a Remote that never settles is aborted so a later automatic trigger can recover
  instead of leaving stale KPIs forever. An ended watch does not reconnect silently, but polling continues; manual refresh still forces a
  read and reconnects it. The panel distinguishes missing files from read/parse failures; the unlisted
  section shows registered Workspaces with Session counts and recent activity, and reports catalog
  failures as errors, never as pending reads. People can refresh and expand
  disclosures, but cannot edit the board. If the lead's
  recorded workspace root is gone, the Host keeps the board disabled without recreating it; the
  client-side derived entry may still render an empty/read-error state, which never writes to disk.

  Project cards also expose note count and latest-title chips when the notes index provides them. Opening
  a note uses the full right-Sidebar pane rather than a card column. The reader renders a safe Markdown
  subset as React text/elements (no raw-HTML sink), turns only explicit HTTP(S) destinations into links,
  and remains read-only. The index and currently open note each follow the same Workspace Files watch +
  visibility/focus-gated polling state machine as the board, so native/external edits refresh automatically. Path
  generation checks hide the old workspace's value during switches, and primitive note id/path memo keys avoid
  reopening a watch on every index poll; stale index bytes never determine body freshness. The ready reader header
  prefers its successful-stat observation time (not a parsed opaque stat version), while list/chip metadata stays
  index-driven. Visual refreshing text is aria-hidden from the separate polite live region,
  which announces health transitions rather than every five-second poll. A malformed index or note degrades only that
  notes surface and does not hide or corrupt the board.

Off (the toolbar toggle is the only control):

![Off: the DevLead icon + label in the composer toolbar](https://raw.githubusercontent.com/yankeguo/dsh-devlead/main/docs/screenshots/devlead-toggle-off.png)

On (the same toggle stays in the toolbar; the strip is status-only):

![On: the DevLead status strip above the composer](https://raw.githubusercontent.com/yankeguo/dsh-devlead/main/docs/screenshots/devlead-bar.png)

A real multi-session orchestration (the DevLead creates a child, the child settles, the
notification carries its last assistant excerpt back, and the DevLead reports):

![DevLead conversation example](https://raw.githubusercontent.com/yankeguo/dsh-devlead/main/docs/screenshots/devlead-conversation.jpg)

| State | UI | Interaction |
| --- | --- | --- |
| `devLead` projection not loaded yet | nothing renders | — |
| Mode off | the small DevLead toolbar button (icon + label) | click sends `/devlead on`; the surface re-renders from the projection |
| Mode on, no watched sessions | status bar: watched 0 + help hint | the toolbar toggle sends `/devlead off` |
| Mode on | status bar: watched N / running M + latest notification excerpt | same; the toggle is disabled while a command is in flight |
| A command settles with a logical error | the error text in the toggle's tooltip, aria-label, and live region | fix and retry |

## Permissions and safety

- **Only humans can flip the mode:** `/devlead on|off`, or the composer-toolbar toggle (shown in
  both states of a top-level Session and merely sending the same command). **No model tool can
  enable it**; every `devlead_*` tool is gated by `when`, so an ordinary session never sees them.
- **Writes require the mode:** every `devlead_*` write tool requires a live calling Agent and is
  only visible while the mode is enabled; the core revalidates live + mode
  (`DEVLEAD_NOT_ENABLED` / `DEVLEAD_AGENT_NOT_LIVE`). Workspace registration never creates a
  missing directory unless the caller explicitly passes `create: true`.
- **Closing is judgment-based, with guardrails:** the closing tools are non-destructive (remove
  unregisters, archive is reversible), must not target a Session or Workspace the human is using,
  hide a failure, or start an unrelated large cleanup; `stop_running` cancels running work; a lead
  Session cannot archive itself; every autonomous close is reported with its rationale and impact.
- **Notifications are not instructions:** both wake-up messages and child output can embed text;
  the DevLead system prompt requires treating notifications as runtime notices and never
  performing unauthorized work or making permission decisions from them.
- **Ordinary session permissions are unchanged:** child sessions are ordinary Sessions following
  DSH's sandbox / permission mode; this suite offers no privilege-escalation path and does not
  change DSH's security boundary.
- **Installing is trusting:** plugins run in the Host process; installing a third-party plugin is
  equivalent to trusting its code. The mode switch only controls whether DevLead capability is
  enabled — it is not a security sandbox switch.

## Known limitations

- **One Host-wide active lead:** the mode is durable and survives restarts; a human must run
  `/devlead off` in the holder (or archive/delete it) before another Session can be enabled.
- **Waking a cold lead requires a Session activator:** without one, queued notifications stay
  durable and are delivered when the Session is opened.
- **The watch index is process-local transport:** a disposed lead keeps observing and recording
  notifications, and the index is rebuilt after a restart/reload; only while the plugin itself is
  unloaded are settled turns unobserved.
- **64 retained notifications:** the projection truncates at that constant; older records remain
  in the Session log.
- **Default caps of 64 watched / 200 listed:** configurable; Sessions beyond the listing are still
  addressable by full id or unique prefix.
- **No Git repository creation / clone / general worktree management:** use shell tools, then
  register the Workspace. Worktree isolation is best-effort, only for newly created Sessions, and
  never merges anything automatically.
- **No cross-process / cross-DSH-instance orchestration;** no custom Remote API; the UI only reads
  projections and goes through commands.
- **Sidebar mark limitations:** marks appear after the Session's projection cache carries the
  summary keys; DSH rc.1 renders no trailing seat on blank Session rows before the first turn, and
  search results show no mark.
- **Child sessions are ordinary sessions:** they appear in the sidebar and consume model quota
  normally — they are not hidden subagents.
- **Damaged DevLead records fail closed but are recoverable:** a corrupt `plugin:devlead/*` record
  freezes replay and reads/writes report `DEVLEAD_PROJECTION_INVALID`; the human-only
  `/devlead reset` recovers the session (`/devlead on` refuses until then).
- **Unknown legacy events have a narrow read-only fallback:** when DSH rejects a whole log only for an
  unrelated non-ignorable event unknown to the current Harness, DevLead can recover the complete current
  v4 JSONL log and strictly fold its DevLead records without modifying it. Historical formats, non-JSONL
  backends, physical corruption, and unreadable files still fail closed with bounded retries; this fallback
  never ignores a corrupt DevLead record or a foreign watch.
- **Plugin records are exported with the canonical Session log and may be uploaded:** DevLead's
  notification/report summaries and titles are canonical session-log events, and DSH's
  default-enabled `session-log-deepseek` path can attach complete canonical events to eligible
  official DeepSeek model requests. Treat exported ZIPs as sensitive; disable
  `session-log-deepseek` in the DSH profile if that upload path is unwanted. DevLead does not add
  a separate uploader or change that DSH default.
- **No DSH upstream modification:** DevLead consumes published `@deepseek-ai/*` packages through
  its peer range; it does not fork, vendor, or require a modified DSH.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| No DevLead button / strip after installing | bundle not enabled (tick it on the Plugins page), page not reloaded, or DSH not restarted so bundle changes take effect |
| No `/devlead` command or `devlead_*` tools | bundle not enabled / skipped by DSH (check the DSH version and `engines.dsh`) |
| `/devlead on` says "no longer live" | the Agent is no longer the live instance in the registry; reopen the session from the sidebar and retry |
| `/devlead watch` reports ambiguity | the prefix matches several sessions; use a longer prefix or the full id from the candidates in the error |
| `/devlead watch` reports the mode is off | run `/devlead on` first; watch-set changes require the mode |
| A child's turn settled but the DevLead was not woken | the mode is off, the session is not watched, the lead is cold and `wakeColdSession: false` (queues wait for the Session to be opened), the Host composes no Session activator, the notification is still inside the coalescing window, or the wake is waiting for an undelivered notice to leave the inbox (retried within 1 s) |
| The DevLead switch seems to do nothing | the command may still be running (the toggle is disabled); when enabling or disabling fails, the error shows in the toggle's tooltip, aria-label, and live region |
| The status strip's counts disagree with the sidebar | the strip computes from the projection's watch set and the standard Session list; a just-changed value can lag briefly — reload the page to re-read |
| Cannot find the switch | it is the users icon + "DevLead" label button in the composer toolbar (next to the permission dropdown) and is shown in both states of a top-level Session; `/devlead on\|off` also works |
| DevLead state survives a restart | expected: mode / watch set / notifications are durable records; run `/devlead off` when no longer needed |
| Passing `title` to an already-registered Workspace has no effect | expected: `title` only applies when registering a new Workspace record; an existing record keeps its title |
| `/devlead on` reports `DEVLEAD_ALREADY_ACTIVE` | another Session already holds the Host-wide DevLead mode. The error names it; run `/devlead off` there first. An **archived** holder does not block a new enable: open it and run `/devlead off`, or delete it |
| `devlead_report` reports `DEVLEAD_NOT_SUPERVISED` | the Session is a DevLead itself, the lead stopped watching it, the lead is archived, the lead's mode is off, or several historical watchers leave no unique active lead watching it. Re-watch it from the active lead |
| `devlead_prompt_session` reports `DEVLEAD_FOREIGN_SUPERVISOR` / `DEVLEAD_MULTIPLE_SUPERVISORS` | the target belongs to another lead, or historical state leaves conflicting watchers. Continue from the owning lead, or disable the other lead / remove the conflicting watch; the prompt is rejected before delivery |
| `devlead_prompt_session` cannot prove the complete supervisor set | no prompt was delivered. Transient reads/listings/timeouts retry automatically; an unrelated unknown legacy event in a current v4 JSONL log is recovered read-only. Otherwise follow the error's concrete Session id, path, and cause: repair any raw format/read blocker first (or restore a readable backup), then use `/devlead reset` only for corrupt DevLead records after the named Session can open. Do not delete logs merely to bypass the check |
| `devlead_prompt_session` reports `DEVLEAD_DELIVERY_RATE_LIMITED` | this lead/child pair reached 4 corrections or 8 background prompts in the current child turn. Merge the context or wait for the next child turn; an idempotent replay of the original receipt remains allowed |
| `devlead_report` reports `DEVLEAD_REPORT_RATE_LIMITED` | the child already sent four distinct non-question reports in this turn (`question` reports are exempt). Wait for its next turn; the lead can still steer it |
| `devlead_report` reports `DEVLEAD_INVALID_INPUT` | the message is empty or over 4000 code points, the summary is over 200, or the kind is not `progress` / `blocked` / `decision` / `question` / `fyi` |
| A watched child tried to call `ask_user_question` | the call is intercepted and forwarded to the active lead as a `question` report; the child gets a tool error telling it to end its turn. Answer with `devlead_prompt_session`, or ask the human from the lead first. The one exception is a child turn opened by a direct human message, which may ask in place |
| `/devlead` / tools report `DEVLEAD_PROJECTION_INVALID` | a `plugin:devlead/*` record in this Session's log is corrupt and replay froze. Run `/devlead reset` (human-only) — `/devlead off` does that implicitly, `/devlead on` refuses until the reset |
| `devlead_use_workspace` reports `DEVLEAD_DIRECTORY_MISSING` | the directory does not exist and creation is not allowed by default. Create it first, or retry with `create: true` once the human explicitly asked for that directory |
| A Workspace argument reports `DEVLEAD_WORKSPACE_AMBIGUOUS` | several Workspaces share that display title. Use the id or registered path from the candidates listed in the error |
| A cold lead was resumed unexpectedly after a restart | expected default: `wakeColdSession` is `true`; set it to `false` to keep queued notifications in memory until a human opens the lead Session |
| `devlead_create_session` reports `isolation.status: "unavailable"` | the profile does not compose DSH's experimental worktree service (the default Web profile never does); enable the experimental worktree bundle or dispatch writing Sessions serially — the Session was still created and works in the shared checkout |
| `devlead_create_session` reports `isolation.status: "failed"` | the worktree service is present but creation failed (restrictive sandbox, existing branch name, non-Git checkout, existing checkout path); the `reason` carries the Git/service error, and the Session continues in the shared checkout |

## Documentation

- [docs/DESIGN.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md) — architecture,
  persistent records, service API, notification pump, permission model (Chinese)
- [docs/COMPATIBILITY.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/COMPATIBILITY.md) —
  DSH compatibility matrix, experimental extension points, upgrade gates and E2E evidence (Chinese)
- [docs/OPTIONAL-DEPENDENCIES.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/OPTIONAL-DEPENDENCIES.md) —
  package-by-package optional-dependency audit (Chinese)
- [docs/CONTRIBUTING.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/CONTRIBUTING.md) —
  development environment, repository layout, build/test/E2E, release discipline (Chinese)
- [docs/PUBLISHING.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/PUBLISHING.md) —
  staged-publish release flow (Chinese)
- [docs/UI-VERIFICATION.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/UI-VERIFICATION.md) —
  visual acceptance checklist (Chinese)
- [docs/AUDIT.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/AUDIT.md) — audit record
  (Chinese)
- [docs/e2e-evidence/](https://github.com/yankeguo/dsh-devlead/tree/main/docs/e2e-evidence) — raw
  E2E evidence logs and summaries
- [docs/releases/](https://github.com/yankeguo/dsh-devlead/tree/main/docs/releases) — per-version
  release notes
- [AGENTS.md](https://github.com/yankeguo/dsh-devlead/blob/main/AGENTS.md) — working agreements for
  agents in this repository (Chinese)
- Package READMEs:
  [protocol](https://github.com/yankeguo/dsh-devlead/blob/main/packages/protocol/README.md) ·
  [devlead](https://github.com/yankeguo/dsh-devlead/blob/main/packages/devlead/README.md) ·
  [tool](https://github.com/yankeguo/dsh-devlead/blob/main/packages/tool/README.md) ·
  [command](https://github.com/yankeguo/dsh-devlead/blob/main/packages/command/README.md) ·
  [client-ui](https://github.com/yankeguo/dsh-devlead/blob/main/packages/client-ui/README.md) ·
  [bundle](https://github.com/yankeguo/dsh-devlead/blob/main/packages/bundle/README.md)
- Version history: [GitHub Releases](https://github.com/yankeguo/dsh-devlead/releases)

## License

[MIT](https://github.com/yankeguo/dsh-devlead/blob/main/LICENSE)
