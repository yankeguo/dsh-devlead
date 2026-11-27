# @yankeguo/dsh-devlead

Core Host service of the DevLead suite (`ctx.devLead`): the durable mode switch, damage-recovery
`reset()`, Workspace and Session orchestration (including `useWorkspace(agent, request, signal?)`
with directory creation opt-in), the watched-session notification hub with cold-lead rehydration, the mid-turn report channel for watched Sessions,
and the `devLead` / `devLeadMode` / `devLeadWatch` Session projections. `ctx.devLead.board` also
owns the strict, atomically written project-board JSON file. The board is **on by default**: the
unique active lead Session's original workspace root owns `<header.cwd>/.dsh/devlead/board.json`;
a non-blank `boardPath` is a relative-only override resolved against that same original
`SessionHeader.cwd`, never the worktree checkout. Both default and explicit paths require the
original workspace root to exist; the Host never recreates a missing root. With no active lead, no
absolute workspace root, or a missing root, the board is disabled (`BOARD_DISABLED`, empty summary,
no browser global), and turning the lead off or switching leads releases the old store/watcher
before the new file is read. A board start/pre-create failure is logged and surfaced as
`boardStartError` but never rejects service activation: the board reports `BOARD_IO_ERROR` while
the rest of DevLead keeps working. `updateBoard` stamps the calling lead identity and requires the
caller to be the current active lead. The file is lead-AI-writable and human/browser-read-only.
The same Host-owned board service also owns `ctx.devLead.notes`, a `DevLeadBoardNotesStore` rooted at
`dirname(boardPath)/notes/` and swapped/closed with the board lifecycle. Tool-facing service methods are
`readBoardNote(agent, { project, note? })` and
`writeBoardNote(agent, { project, operation, note?, title?, summary?, expectedRevision? }, signal?)`;
both recheck the active lead and accept no filesystem path input. Results contain metadata only and derive an
`absolutePath` for all native DSH `read`/`write`/`edit` body work; it is never persisted in the index. Operations are
`create` (always an empty body), `update-metadata`, and `delete`; neither operation accepts or returns body content.
The store
exposes `path` / `indexPath` / `enabled`, `start()` / `close()`, cache-only `summaryIndex()`, and logical `read()` /
`write()`. Its strict schema-v1 `index.json` is the committed source of truth and contains only project/note
metadata; Markdown bodies live at `<sanitized project>/<note-id>.md`, and orphan files are ignored. Every index
mutation resolves the board project by id/title/absolute workspace path, fresh-reads under the cross-process file
lock, checks `expected_revision`, validates the complete next index, and atomically replaces it. Reads/lists also
serialize through that lock, stat stable body snapshots within 256 KiB without reading them, and lazily repair `bytes`
and file-mtime `updatedAt`; any missing/oversized body aborts the repair and preserves the old index. The index is capped at 128 KiB and each project at 100 notes. A bad index is never overwritten from a stale
cache and does not block the board or DevLead; notes operations still require a valid board project. The synchronous board summary
reads the valid board + notes caches and adds
active-project note counts/latest titles within its existing 1536-byte cap. Humans and browsers stay
read-only.
See [docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md) for both schema
v1 contracts, store/service APIs, CAS, corruption handling, read caps, and the dynamic summary contract.

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
  composition). The board file uses the peer library `@deepseek-ai/dsh-atomic-write`
  (`writeFileAtomic` / `withFileLock`), which the installed DSH runtime provides.
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
(used when a created Session names no preset; an invalid id fails creation), and the optional `boardPath` override. The board is enabled by default: a trimmed-blank / omitted `boardPath` derives
`<active lead Session header cwd>/.dsh/devlead/board.json`. A non-blank value accepts only a relative
path such as `.dsh/devlead/board.json` or `custom/board.json`, resolved with `path.resolve` against
the active lead's original `SessionHeader.cwd` (not its worktree checkout). Absolute POSIX paths and
Windows drive/UNC paths fail fast with `BOARD_INVALID` at both Loader and direct-construction
boundaries, with errors directing users to a relative path. Backslashes, empty segments, and `..`
root escapes are also rejected; after `path.resolve`, the path must remain inside the root and its
final component cannot be a symlink.
Existing absolute-path deployments fail on startup after upgrade and must migrate to a relative
path. No tool argument can redirect the board file.
See the
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
项目看板默认启用：空白/缺省 `boardPath` 由唯一 active lead 的原始 workspace 根
`SessionHeader.cwd`（不是 worktree checkout）派生 `<cwd>/.dsh/devlead/board.json`；非空只接受
`.dsh/devlead/board.json`、`custom/board.json` 等相对该根的路径。绝对 POSIX、Windows 盘符/UNC 在
Loader/直接构造时以 `BOARD_INVALID` fail-fast，错误提示改用相对路径；反斜杠、空段与 `..` 逃逸同样
被拒绝，`path.resolve` 后必须仍在根内，最终组件不能是 symlink。默认与 override 都要求原始根存在，缺失时
不重建；没有 lead、没有绝对 workspace 根或根缺失时禁用。既有绝对路径部署升级后会启动失败，必须
迁移为相对路径。lead off/切换会释放旧 store/watcher，start/预创建失败只记 warning + degraded、不阻塞服务加载
（board 工具报 `BOARD_IO_ERROR`，其余功能照常）。看板与 notes 写入都使用
`@deepseek-ai/dsh-atomic-write`（安装运行时提供）。同一 Host board service 拥有随 board
切换/关闭的 `ctx.devLead.notes`（`DevLeadBoardNotesStore`，root 固定
`dirname(boardPath)/notes/`）。工具侧 service 方法是 `readBoardNote(agent,{project,note?})` 与
`writeBoardNote(agent,patch,signal?)`，patch 含 create/update-metadata/delete operation、可选
note/title/summary 与 expectedRevision，均不接受文件路径或正文 content；create 始终创建空文件。返回的
absolutePath 供 DSH 原生 read/write/edit 读写正文，不写入 index，工具不接收也不返回正文。store
暴露 path/indexPath/enabled、start/close、summaryIndex 与逻辑 read/write。严格 schema-v1 `index.json`
是提交事实、只存 metadata，正文位于 `<sanitized project>/<note-id>.md`，orphan 忽略。每次 index 修改在
跨进程文件锁内 fresh read，校验 `expected_revision`，验证完整 next index 后原子替换；read/list 也串行
进入该锁，只 stat 稳定、≤256 KiB 的正文快照（不读取正文）并惰性修复 bytes/文件 mtime updatedAt，绝不重写正文；
缺失/超限正文会中止修复并保留旧 index。index ≤128 KiB、每项目 ≤100 条。坏 index 不会用旧缓存覆盖，也不阻塞 board/DevLead；
notes 操作仍要求能解析合法 board project。同步 board summary 从合法缓存为 active 项目附加 note 数/
最近标题，整体仍 ≤1536 bytes。人类与浏览器
只读。
`agents`、`sessions`、`sessionProjections` 为必需 peer；Workspace registry、Session controller、
标题/查询服务、projection cache、`sessionPersistence`（冷重建就绪屏障）与实验性 worktree 能力
均为可选探测。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
