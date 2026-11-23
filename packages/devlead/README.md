# @yankeguo/dsh-devlead

Core Host service of the DevLead suite (`ctx.devLead`): the durable mode switch, damage-recovery
`reset()`, Workspace and Session orchestration (including `useWorkspace(agent, request, signal?)`
with directory creation opt-in), the watched-session notification hub with cold-lead rehydration, the mid-turn report channel for watched Sessions,
and the `devLead` / `devLeadMode` / `devLeadWatch` Session projections. When `boardPath` is
configured, `ctx.devLead.board` also owns the strict, atomically written project-board JSON file;
`updateBoard` stamps the calling lead identity. The file is lead-AI-writable and human/browser-read-only.
See [docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md) for schema v1,
CAS, corruption handling, and the dynamic summary contract.

DevLead mode is **globally single-active**: at most one Session (across every Workspace) may be
enabled. `setEnabled(agent, true)` throws `DEVLEAD_ALREADY_ACTIVE` naming the occupant when another
Session holds it; `off`/`reset` release immediately, archiving or deleting the holder makes it
releasable, and a restart/rehydration reconciles historical duplicates and keeps one Session.
Admission is serialized in-process and scans live projections plus the durable corpus.

`sessionQueuedInputs(agent, sessionId, signal?)` projects a live Session's pending inbox inputs
(id, boundary, source kind/form/sender, bounded text excerpt, enqueue instant from the durable
`agent/inbox/spliced` log); a cold target reports undefined. `retractQueuedInput(agent, sessionId,
inputId, signal?)` withdraws one queued input this lead authored (devlead relay with its own
sender id) through the Host's per-message `inbox.remove`; other producers' inputs are refused,
an already-gone input is idempotent (`retracted: false`), and the target must be live and not the
lead itself. `promptSession` accepts `interruptInbox: 'clear-all' | 'keep' | 'clear-own'`
(default `clear-all`): because the Host stop providers always clear the inbox, retention is a
snapshot before the stop and a restore of the same identified messages after it, ahead of the
replacement prompt; the result reports `retainedInputs` when a retention policy ran.

`reportProgress(agent, { message, kind?, summary? }, signal?)` lets a watched, non-DevLead Session
send a one-way report to its unique active lead. It resolves the active lead that watches it through
the hub's reverse index, validates size/kind, deduplicates identical kind+message pairs within a turn, enforces four
distinct non-question reports per turn (`DEVLEAD_REPORT_RATE_LIMITED`; `question` reports are exempt
from that budget), and otherwise refuses with `DEVLEAD_NOT_SUPERVISED`. The receipt is `{ report, durable, queued, warning? }`.

The report is first written to a durable outbox (`devlead_report_outbox` over the optional
`storageDomain` KV facility), then a `plugin:devlead/report` receipt is appended to the lead's
Session log. The outbox row is removed only after the lead log flush succeeds; a cold/archived/
unattached lead leaves it for replay on the next boot/lead activation. Rows are pruned after seven
days, and `/devlead reset` drops that lead's pending rows. A Host without storage-domain returns
`durable: false` with an explicit warning. `supervisorOf(agent)` / `isSupervised(agent)` are
synchronous tool-gating queries; `reports(agent, { limit? })` reads the lead digest.

Archived holders are not active leads: admission ignores them, writes a durable tombstone when the
mode-off cannot be written, and `/devlead status` exposes them with the unarchive/off/delete
recovery path. Opening an unarchived holder reconciles it back to one active lead.

Normally installed as part of the bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

## Requirements

- DSH `0.2.2-rc.1`–`0.2.2-rc.5` (the package declares `engines.dsh: >=0.2.2-rc.1 <0.3.0`; this checkout's devDependencies pin rc.1 for the oldest-API typecheck).
- Peer services `agents`, `sessions`, `sessionProjections` (provided by the default `dsh-base`
  composition).
- Optional, probed at call time: `workspaceRegistry`, `sessionController`, `sessionTitle`,
  `agentPresets` (read-only preset roster discovery), `sessionQuery`, `sessionProjectionCache`
  (cold-lead rehydration pre-filter), `sessionPersistence` (durable-corpus readiness barrier),
  `storageDomain` (durable report outbox and archived-holder tombstones), and the experimental
  `worktrees` capability. Missing optional services degrade to fewer features or
  structured domain errors; no experimental package is imported, injected, or declared.
- Cold-lead rehydration: at plugin load the hub rebuilds its watch index from durable state
  (`sessionQuery` listing → projection-cache pre-filter → exact fold; unclassified rows are capped
  at 64 full-log reads per bounded attempt, with a saved cursor). Without a projection cache every cold
  candidate uses the same bounded exact fold. A precise unknown-non-ignorable legacy event can trigger
  read-only recovery of the complete current v4 JSONL artifact; all DevLead records still use the strict
  fold, and other formats/read failures stay fail closed. A disposed lead keeps observing;
  `wakeColdSession` defaults to `true`, so a queued notification resumes the cold lead before delivering.

## Configuration

The Loader row id `devlead` accepts `notificationBatchMs`, `maxWatchedSessions`,
`maxListedSessions`, `wakeColdSession` (default `true` since 0.2.0), `defaultAgentPreset`
(used when a created Session names no preset; an invalid id fails creation), and `boardPath`
(empty by default; the only source of the board file path). See the
[configuration section](https://github.com/yankeguo/dsh-devlead/blob/main/README.md#configuration) for defaults and ranges; all limits are
validated at both the Loader and direct-construction boundaries.

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes: service API, projections, notification pump, worktree isolation](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)
- [Optional-dependency audit](https://github.com/yankeguo/dsh-devlead/blob/main/docs/OPTIONAL-DEPENDENCIES.md)

## 中文

`@yankeguo/dsh-devlead` 是套件的 Host 核心服务 `ctx.devLead`：模式开关、损坏状态恢复
`reset()`、Workspace/Session 编排（`useWorkspace(agent, request, signal?)`，目录创建 opt-in）、
带冷 lead 索引重建的关注关系索引与通知投递，以及 `devLead` / `devLeadMode` / `devLeadWatch` projection。
`agents`、`sessions`、`sessionProjections` 为必需 peer；Workspace registry、Session controller、
标题/查询服务、projection cache、`sessionPersistence`（冷重建就绪屏障）与实验性 worktree 能力
均为可选探测。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
