/** Read-only lead board and immersive project-notes reader. */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Button,
  IconCheckCircleOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconClockOutlineRegular,
  IconListPenOutlineRegular,
  IconPauseOutlineRegular,
  IconPlanOutlineRegular,
  IconPlayOutlineRegular,
  IconRefreshOutlineRegular,
  IconWarningOutlineRegular,
  StateDot,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  boardRelativeTime,
  currentDevLeadBoardConfig,
  projectStatusTone,
  summarizeDevLeadBoardProjects,
  resolveDevLeadBoardSessionConfig,
  taskProgress,
  taskStatusTone,
  truncateSessionId,
  unlistedDevLeadWorkspaces,
  type DevLeadUnlistedWorkspace,
  type DevLeadBoardGroup,
  type DevLeadBoardProject,
  type DevLeadBoardProjectStatus,
  type DevLeadBoardTaskStatus,
} from './board.ts'
import {
  useBoardFile,
  type DevLeadBoardAutoRefreshStatus,
  type DevLeadBoardFileState,
  type DevLeadBoardFiles,
  type DevLeadBoardWatchStatus,
} from './useBoardFile.ts'
import {
  deriveDevLeadNotesPaths,
  devLeadNotesForProject,
  resolveDevLeadNotePath,
  sortDevLeadNotes,
  useDevLeadNote,
  useDevLeadNotesIndex,
  type DevLeadNoteMetadata,
  type DevLeadNoteResult,
  type DevLeadNotesIndexResult,
  type DevLeadNotesPaths,
  type DevLeadNotesProject,
} from './notes.ts'
import { DevLeadMarkdown } from './Markdown.tsx'

/** Dependencies supplied by the tab registration. */
export interface DevLeadBoardPanelInjected {
  readonly files: DevLeadBoardFiles
}

export type DevLeadBoardPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'devlead'>
  & InjectFace<DevLeadBoardPanelInjected>

interface NotesSelection {
  readonly projectId: string
  readonly noteId: string
}

/** Live board body; board, index, and current note each reuse one file state machine. */
export function DevLeadBoardPanel({ sessionId, files, useWorkspaces, useSessions, useTabInfo, t }: DevLeadBoardPanelProps) {
  const sessions = useSessions((snapshot: SessionListState) => snapshot)
  const visible = useTabInfo().tab.visible
  const summary = sessions.byId[sessionId]
  const resolved = resolveDevLeadBoardSessionConfig(sessionId, summary, currentDevLeadBoardConfig())
  const config = useMemo(() => resolved, [resolved?.boardPath, resolved?.pathPlatform])
  const { refresh, watch, autoRefresh, ...state } = useBoardFile({ sessionId, config, files, visible })
  const notesPaths = useMemo(() => config === undefined ? undefined : deriveDevLeadNotesPaths(config), [config])
  const notesIndex = useDevLeadNotesIndex({ sessionId, config, files, visible })
  const [selection, setSelection] = useState<NotesSelection | undefined>()
  useEffect(() => { setSelection(undefined) }, [config?.boardPath])
  const readerProjectId = selection?.projectId
  const previousReaderProject = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (readerProjectId !== undefined) {
      document.querySelector<HTMLButtonElement>('.devlead-notes-back')?.focus()
    } else if (previousReaderProject.current !== undefined) {
      const trigger = previousReaderProject.current
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-devlead-notes-chip]')) {
        if (button.dataset.devleadNotesChip === trigger) {
          button.focus()
          break
        }
      }
    }
    previousReaderProject.current = readerProjectId
  }, [readerProjectId])
  const boardProject = selection === undefined || state.board === undefined
    ? undefined
    : state.board.projects.find(project => project.id === selection.projectId)
  const notesProject = boardProject === undefined || notesIndex.value === undefined
    ? undefined
    : devLeadNotesForProject(notesIndex.value, boardProject)
  const projectNotes = sortDevLeadNotes(notesProject?.notes ?? [])
  const metadata = projectNotes.find(note => note.id === selection?.noteId) ?? projectNotes[0]
  const note = useDevLeadNote({ sessionId, paths: notesPaths, metadata, files, visible: visible && selection !== undefined })
  const workspaces = useWorkspaces((snapshot: WorkspaceSnapshot) => snapshot)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])
  const unlisted = state.status === 'ready' && state.board !== undefined
    ? unlistedDevLeadWorkspaces(state.board, workspaces.items, sessions.byId, config?.pathPlatform)
    : []
  const openNotes = (projectId: string): void => {
    const project = state.board?.projects.find(candidate => candidate.id === projectId)
    if (project === undefined || notesIndex.value === undefined) return
    const latest = sortDevLeadNotes(devLeadNotesForProject(notesIndex.value, project)?.notes ?? [])[0]
    if (latest !== undefined) setSelection({ projectId, noteId: latest.id })
  }
  return (
    <DevLeadBoardPanelView
      state={state}
      onRefresh={refresh}
      now={now}
      t={t}
      unlisted={unlisted}
      workspacePhase={workspaces.phase}
      workspaceError={workspaces.state === 'error'}
      sessionPhase={sessions.phase}
      watch={watch}
      autoRefresh={autoRefresh}
      notes={notesPaths === undefined ? undefined : {
        paths: notesPaths,
        index: notesIndex,
        note,
        selection,
        onOpen: openNotes,
        onSelect: noteId => { setSelection(current => current === undefined ? current : { ...current, noteId }) },
        onClose: () => { setSelection(undefined) },
      }}
    />
  )
}

export interface DevLeadBoardNotesView {
  readonly paths: DevLeadNotesPaths
  readonly index: DevLeadNotesIndexResult
  readonly note: DevLeadNoteResult
  readonly selection?: NotesSelection | undefined
  onOpen(projectId: string): void
  onSelect(noteId: string): void
  onClose(): void
}

/** Pure view props, separated so rendering tests need no Remote or timers. */
export interface DevLeadBoardPanelViewProps {
  readonly state: DevLeadBoardFileState
  readonly onRefresh: () => void
  readonly now: number
  readonly t: DevLeadBoardPanelProps['t']
  readonly unlisted?: readonly DevLeadUnlistedWorkspace[]
  readonly workspacePhase?: WorkspaceSnapshot['phase']
  readonly workspaceError?: boolean
  readonly sessionPhase?: SessionListState['phase']
  readonly watch?: DevLeadBoardWatchStatus
  readonly autoRefresh?: DevLeadBoardAutoRefreshStatus
  readonly notes?: DevLeadBoardNotesView | undefined
}

/** Localize one relative timestamp without translating board or note free text. */
function RelativeTime({ iso, now, t, label }: {
  readonly iso: string
  readonly now: number
  readonly t: DevLeadBoardPanelViewProps['t']
  readonly label?: string | undefined
}) {
  const relative = boardRelativeTime(iso, now)
  const text = relative.unit === 'now' ? t('board.time.now') : t(`board.time.${relative.unit}`, { count: relative.n })
  return <time dateTime={iso} title={label === undefined ? iso : `${label}: ${iso}`} aria-label={label === undefined ? undefined : `${label} ${text}`}>{text}</time>
}

/** Labels remain accessible, while typography and position carry visible meaning. */
function ProjectField({ label, text, className = '', arrow }: {
  readonly label: string
  readonly text: string
  readonly className?: string
  readonly arrow?: string | undefined
}) {
  if (text.trim().length === 0) return null
  return (
    <div className={`devlead-board-field ${className}`.trim()} aria-label={label}>
      <span className="devlead-sr-only">{label}</span>
      {arrow !== undefined && <span className="devlead-board-field-arrow" aria-hidden="true">{arrow}</span>}
      <p title={text}>{text}</p>
    </div>
  )
}

function statusDot(status: DevLeadBoardProjectStatus): 'warning' | 'ongoing' | 'done' | 'idle' {
  switch (status) {
    case 'blocked': return 'warning'
    case 'active': return 'ongoing'
    case 'done': return 'done'
    case 'paused': return 'idle'
  }
}

/** Repeated status glyph: the text label remains visible and accessible. */
function ProjectStatusIcon({ status }: { readonly status: DevLeadBoardProjectStatus }): ReactNode {
  switch (status) {
    case 'active': return <IconPlayOutlineRegular size={13} />
    case 'blocked': return <IconWarningOutlineRegular size={13} />
    case 'paused': return <IconPauseOutlineRegular size={13} />
    case 'done': return <IconCheckCircleOutlineRegular size={13} />
  }
}

/** One project with native task disclosure and an optional notes entry point. */
function ProjectCard({ project, now, t, notesProject, onOpenNotes }: {
  readonly project: DevLeadBoardProject
  readonly now: number
  readonly t: DevLeadBoardPanelViewProps['t']
  readonly notesProject?: DevLeadNotesProject | undefined
  readonly onOpenNotes?: ((projectId: string) => void) | undefined
}) {
  const idPrefix = useId()
  const [tasksOpen, setTasksOpen] = useState(false)
  const progress = taskProgress(project)
  const progressText = t('board.tasks.progress', { done: progress.done, total: progress.total })
  const latestNote = sortDevLeadNotes(notesProject?.notes ?? [])[0]
  return (
    <article
      className="devlead-board-card"
      data-devlead-board-project={project.id}
      data-status={project.status}
      data-priority={project.priority}
      aria-labelledby={`${idPrefix}-title`}
    >
      <header className="devlead-board-card-header">
        <div className="devlead-board-card-heading">
          <span className="devlead-board-card-status" title={t(`board.status.${project.status}`)} aria-label={t(`board.status.${project.status}`)}>
            <StateDot state={statusDot(project.status)} size={8} />
          </span>
          <h5 id={`${idPrefix}-title`} title={project.workspace.title}>{project.workspace.title}</h5>
          <code className="devlead-board-project-id" title={project.id}>{project.id}</code>
        </div>
      </header>
      <code className="devlead-board-workspace" title={project.workspace.path}>{project.workspace.path}</code>
      <div className="devlead-board-card-badges">
        <Tag tone="outline">{t(`board.priority.${project.priority}`)}</Tag>
        {latestNote !== undefined && onOpenNotes !== undefined && (
          <button
            type="button"
            className="devlead-board-notes-chip"
            data-devlead-notes-chip={project.id}
            aria-label={t('board.notes.open', { count: notesProject?.notes.length ?? 0, title: latestNote.title })}
            title={t('board.notes.open', { count: notesProject?.notes.length ?? 0, title: latestNote.title })}
            onClick={() => { onOpenNotes(project.id) }}
          >
            <IconPlanOutlineRegular size={13} />
            <span className="devlead-board-notes-chip-label">{t('board.notes.short')}</span>
            <strong>{notesProject?.notes.length ?? 0}</strong>
            <span title={latestNote.title}>{latestNote.title}</span>
          </button>
        )}
      </div>
      <ProjectField label={t('board.field.focus')} text={project.focus} className="devlead-board-field-focus" />
      <ProjectField label={t('board.field.next')} text={project.next} className="devlead-board-field-next" arrow="→" />
      <ProjectField label={t('board.field.goal')} text={project.goal} className="devlead-board-field-goal" />
      {project.blockers.length > 0 && (
        <section className="devlead-board-blockers" aria-label={t('board.blockers')}>
          <h6><IconWarningOutlineRegular size={14} />{t('board.blockers')}</h6>
          <ul>
            {project.blockers.map(blocker => (
              <li key={blocker.id}>
                <span title={blocker.text}>{blocker.text}</span>
                <span className="devlead-board-blocker-since">
                  <RelativeTime iso={blocker.since} now={now} t={t} label={t('board.blocker.since')} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="devlead-board-progress" title={progressText}>
        <span className="devlead-sr-only">{progressText}</span>
        <progress
          data-devlead-board-progress={project.id}
          max={Math.max(1, progress.total)}
          value={progress.done}
          aria-label={progressText}
          aria-valuetext={progressText}
        />
      </div>
      <details
        className="devlead-board-tasks"
        data-devlead-board-tasks={project.id}
        aria-labelledby={`${idPrefix}-tasks`}
        open={tasksOpen}
        onToggle={event => { setTasksOpen(event.currentTarget.open) }}
      >
        <summary id={`${idPrefix}-tasks`} aria-label={t('board.tasks.summary', { done: progress.done, total: progress.total })}>
          <span>{t('board.tasks.details')}</span>
          <strong>{t('board.tasks.count', { done: progress.done, total: progress.total })}</strong>
        </summary>
        {project.tasks.length === 0 ? <p className="devlead-board-muted">{t('board.tasks.empty')}</p> : (
          <ul>
            {project.tasks.map(task => (
              <li key={task.id} data-task-status={task.status}>
                <div className="devlead-board-task-heading">
                  <span className="devlead-board-task-title" title={task.title}>{task.title}</span>
                  <Tag tone={taskStatusTone(task.status)}>{t(`board.task.status.${task.status}`)}</Tag>
                </div>
                <div className="devlead-board-task-meta">
                  {task.ownerSessionId !== undefined && (
                    <code title={task.ownerSessionId} aria-label={t('board.task.owner')}>{truncateSessionId(task.ownerSessionId)}</code>
                  )}
                  <RelativeTime iso={task.updatedAt} now={now} t={t} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
      <footer className="devlead-board-card-footer">
        <IconClockOutlineRegular size={12} />
        <RelativeTime iso={project.updatedAt} now={now} t={t} label={t('board.project.updated')} />
      </footer>
    </article>
  )
}

/** Blocked/active are primary; settled groups remain native disclosures. */
function ProjectGroup({ group, idPrefix, now, t, notes }: {
  readonly group: DevLeadBoardGroup
  readonly idPrefix: string
  readonly now: number
  readonly t: DevLeadBoardPanelViewProps['t']
  readonly notes?: DevLeadBoardNotesView | undefined
}) {
  const headingId = `${idPrefix}-group-${group.status}`
  const secondary = group.status === 'paused' || group.status === 'done'
  const cards = (
    <div className="devlead-board-cards">
      {group.projects.map(project => (
        <ProjectCard
          key={project.id}
          project={project}
          now={now}
          t={t}
          notesProject={notes?.index.value === undefined ? undefined : devLeadNotesForProject(notes.index.value, project)}
          onOpenNotes={notes?.onOpen}
        />
      ))}
    </div>
  )
  if (secondary) {
    return (
      <details className="devlead-board-group devlead-board-secondary" data-board-group={group.status} aria-labelledby={headingId}>
        <summary>
          <h4 id={headingId}>
            <span>{t(`board.status.${group.status}`)}</span>
            <Tag tone={projectStatusTone(group.status)}>{group.projects.length}</Tag>
          </h4>
        </summary>
        {cards}
      </details>
    )
  }
  return (
    <section className="devlead-board-group" data-board-group={group.status} aria-labelledby={headingId}>
      <header className="devlead-board-group-header">
        <h4 id={headingId}>{t(`board.status.${group.status}`)}</h4>
        <Tag tone={projectStatusTone(group.status)}>{group.projects.length}</Tag>
      </header>
      {cards}
    </section>
  )
}

function NotesState({ kind, t, message }: {
  readonly kind: 'loading' | 'empty' | 'error' | 'note-empty'
  readonly t: DevLeadBoardPanelViewProps['t']
  readonly message?: string | undefined
}) {
  const error = kind === 'error'
  return (
    <div className="devlead-notes-state" data-devlead-notes-state={kind} role={error ? 'alert' : 'status'}>
      <span className="devlead-board-state-mark" aria-hidden="true">{error ? '!' : kind === 'loading' ? '···' : '○'}</span>
      <h4>{t(`board.notes.${kind}`)}</h4>
      {message !== undefined && <code title={message}>{message}</code>}
    </div>
  )
}

function NoteList({ notes, selected, now, t, onSelect }: {
  readonly notes: readonly DevLeadNoteMetadata[]
  readonly selected: string
  readonly now: number
  readonly t: DevLeadBoardPanelViewProps['t']
  onSelect(noteId: string): void
}) {
  return (
    <nav className="devlead-notes-list" aria-label={t('board.notes.list')}>
      <ul>
        {notes.map(note => (
          <li key={note.id}>
            <button
              type="button"
              data-devlead-note={note.id}
              aria-current={note.id === selected ? 'page' : undefined}
              onClick={() => { onSelect(note.id) }}
            >
              <strong title={note.title}>{note.title}</strong>
              {note.summary.length > 0 && <span title={note.summary}>{note.summary}</span>}
              <RelativeTime iso={note.updatedAt} now={now} t={t} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** Full-column reader: project notes list plus safe Markdown, never a new route. */
export function DevLeadNotesReader({ project, notesProject, notes, now, t }: {
  readonly project: DevLeadBoardProject
  readonly notesProject: DevLeadNotesProject | undefined
  readonly notes: DevLeadBoardNotesView
  readonly now: number
  readonly t: DevLeadBoardPanelViewProps['t']
}) {
  const idPrefix = useId()
  const sorted = sortDevLeadNotes(notesProject?.notes ?? [])
  const metadata = sorted.find(note => note.id === notes.selection?.noteId) ?? sorted[0]
  const expectedPath = metadata === undefined ? undefined : resolveDevLeadNotePath(notes.paths, metadata)
  const documentReady = notes.note.status === 'ready' && notes.note.value !== undefined && notes.note.valuePath === expectedPath
  // Native edits can leave index metadata stale. Only the selected, ready
  // document uses its own live stat observation; list rows and chips keep the
  // index ordering/metadata contract and never borrow another note's time.
  const liveObservedAt = documentReady ? notes.note.observedAt : undefined
  return (
    <section className="devlead-notes-reader" data-devlead-notes-reader={project.id} aria-labelledby={`${idPrefix}-title`}>
      <header className="devlead-notes-reader-header">
        <Tooltip label={t('board.notes.back')} side="right" delayMs={300}>
          <Button variant="ghost" size="sm" className="devlead-notes-back" aria-label={t('board.notes.back')} onClick={notes.onClose}>
            <IconChevronLeftOutlineRegular size={16} />
          </Button>
        </Tooltip>
        <div>
          <h3 id={`${idPrefix}-title`} title={project.workspace.title}>{project.workspace.title}</h3>
          <span>{t('board.notes.count', { count: sorted.length })}</span>
        </div>
      </header>
      {notes.index.status === 'loading' || notes.index.status === 'disabled' ? <NotesState kind="loading" t={t} />
        : notes.index.status === 'empty' ? <NotesState kind="empty" t={t} />
          : notes.index.status === 'error' ? <NotesState kind="error" t={t} message={notes.index.error?.message} />
            : metadata === undefined ? <NotesState kind="empty" t={t} />
              : (
                <div className="devlead-notes-reader-body">
                  <NoteList notes={sorted} selected={metadata.id} now={now} t={t} onSelect={notes.onSelect} />
                  <article className="devlead-note-document" data-devlead-note-document={metadata.id}>
                    <header>
                      <h4 title={metadata.title}>{metadata.title}</h4>
                      {metadata.summary.length > 0 && <p>{metadata.summary}</p>}
                      <RelativeTime iso={liveObservedAt ?? metadata.updatedAt} now={now} t={t} label={t('board.project.updated')} />
                    </header>
                    {notes.note.status === 'error' ? <NotesState kind="error" t={t} message={notes.note.error?.message} />
                      : notes.note.status === 'empty' ? <NotesState kind="note-empty" t={t} />
                        : !documentReady ? <NotesState kind="loading" t={t} />
                          : <DevLeadMarkdown markdown={notes.note.value?.markdown ?? ''} />}
                  </article>
                </div>
              )}
    </section>
  )
}

/** Pure read-only view, including all loading/empty/error branches. */
export function DevLeadBoardPanelView({
  state,
  onRefresh,
  now,
  t,
  unlisted = [],
  workspacePhase = 'ready',
  workspaceError = false,
  sessionPhase = 'ready',
  watch = 'live',
  autoRefresh = 'active',
  notes,
}: DevLeadBoardPanelViewProps): ReactNode {
  const idPrefix = useId()
  if (state.status === 'disabled') return null
  const board = state.board
  const summary = board === undefined ? undefined : summarizeDevLeadBoardProjects(board)
  const groups = summary?.groups ?? []
  const counts = summary?.counts ?? { active: 0, blocked: 0, paused: 0, done: 0 }
  const blocked = counts.blocked
  const refreshState = state.status === 'error' ? 'error'
    : autoRefresh === 'paused' || watch === 'ended' ? 'warning'
      : state.refreshing || state.status === 'loading' || watch === 'connecting' ? 'ongoing'
        : autoRefresh === 'active' && state.status === 'ready' ? 'done' : 'idle'
  const endedKey = autoRefresh === 'active' ? 'board.watch.ended'
    : autoRefresh === 'paused' ? 'board.watch.ended.paused' : 'board.watch.ended.disabled'
  const statusText = state.status === 'error' ? t('board.refresh.error')
    : watch === 'ended' ? t(endedKey)
      : autoRefresh === 'paused' ? t('board.autoRefresh.paused')
        : state.refreshing || state.status === 'loading' ? t('board.refresh.loading')
          : watch === 'connecting' ? t('board.watch.connecting') : t(`board.autoRefresh.${autoRefresh}`)
  // Polling flips `refreshing` every five seconds. Keep that visual busy text
  // out of the live region; announce only health/lifecycle transitions/errors.
  const announcementText = state.status === 'error' ? t('board.refresh.error')
    : watch === 'ended' ? t(endedKey)
      : autoRefresh === 'paused' ? t('board.autoRefresh.paused')
        : watch === 'connecting' ? t('board.watch.connecting') : t(`board.autoRefresh.${autoRefresh}`)
  const readerProject = notes?.selection === undefined || board === undefined
    ? undefined
    : board.projects.find(project => project.id === notes.selection?.projectId)
  const readerNotesProject = readerProject === undefined || notes?.index.value === undefined
    ? undefined
    : devLeadNotesForProject(notes.index.value, readerProject)
  return (
    <div className="devlead-board" data-devlead-board="true" data-state={state.status}>
      <header className="devlead-board-header">
        <div className="devlead-board-title-row">
          <div className="devlead-board-title-group">
            <h3>{t('board.title')}</h3>
            <Tag tone="quiet">{t('board.readonly')}</Tag>
          </div>
          <Tooltip label={t('board.refresh.action')} side="left" delayMs={300}>
            <Button variant="ghost" size="sm" className="devlead-board-refresh" aria-label={t('board.refresh.action')}
              aria-busy={state.refreshing} disabled={state.refreshing} onClick={onRefresh}>
              <IconRefreshOutlineRegular size={15} />
            </Button>
          </Tooltip>
        </div>
        <div className="devlead-board-header-strip">
          <div className="devlead-board-live" data-auto-refresh={autoRefresh} title={`${t('board.live')}: ${statusText}`}>
            <StateDot state={refreshState} size={8} />
            <span className="devlead-board-live-label" aria-hidden="true">{t('board.live')}</span>
            <span className="devlead-board-live-status" aria-hidden="true">{statusText}</span>
            <span
              className="devlead-sr-only"
              data-devlead-board-live-announcement="true"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >{announcementText}</span>
          </div>
          {board !== undefined && (
            <div className="devlead-board-meta">
              <span className="devlead-board-updated" title={`${t('board.updated')}: ${board.updatedAt}`}>
                <IconClockOutlineRegular size={11} />
                <RelativeTime iso={board.updatedAt} now={now} t={t} label={t('board.updated')} />
              </span>
              <span className="devlead-board-revision" title={t('board.revision.full', { revision: board.revision })}>
                {t('board.revision', { revision: board.revision })}
              </span>
            </div>
          )}
        </div>
        {board !== undefined && (
          <dl className="devlead-board-kpis" aria-label={t('board.kpi.aria')} tabIndex={0}>
            {(['blocked', 'active', 'paused', 'done'] as const).map(status => {
              const count = counts[status]
              return (
                <div
                  key={status}
                  data-devlead-board-kpi={status}
                  data-tone={status}
                  data-empty={count === 0 ? 'true' : 'false'}
                  data-emphasis={status === 'blocked' && count > 0 ? 'true' : 'false'}
                >
                  <dt>
                    <span className="devlead-board-kpi-icon" aria-hidden="true"><ProjectStatusIcon status={status} /></span>
                    <span>{t(`board.status.${status}`)}</span>
                  </dt>
                  <dd aria-label={t('board.kpi.value', { status: t(`board.status.${status}`), count })}>{count}</dd>
                </div>
              )
            })}
          </dl>
        )}
      </header>

      <div className="devlead-board-content">
        {state.status === 'loading' && (
          <div className="devlead-board-placeholder" role="status" data-devlead-board-loading="true">
            <span className="devlead-board-state-mark" aria-hidden="true">···</span>
            <h4>{t('board.loading')}</h4><p>{t('board.loading.description')}</p>
          </div>
        )}
        {state.status === 'empty' && (
          <div className="devlead-board-placeholder" data-devlead-board-empty="file">
            <span className="devlead-board-state-mark" aria-hidden="true">○</span>
            <h4>{t('board.empty.title')}</h4><p>{t('board.empty.description')}</p>
          </div>
        )}
        {state.status === 'error' && (
          <div className="devlead-board-error" role="alert" data-devlead-board-error={state.error?.kind ?? 'read'}>
            <span className="devlead-board-state-mark" aria-hidden="true"><IconWarningOutlineRegular size={20} /></span>
            <h4>{t(state.error?.kind === 'parse' ? 'board.error.parse' : 'board.error.read')}</h4>
            {state.lastSuccessAt !== undefined && <p>{t('board.lastSuccess')} <RelativeTime iso={state.lastSuccessAt} now={now} t={t} /></p>}
            {state.error !== undefined && <code className="devlead-board-error-detail" title={state.error.message}>{state.error.message}</code>}
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={state.refreshing}>
              <IconRefreshOutlineRegular size={14} />{t('board.retry')}
            </Button>
          </div>
        )}
        {state.status === 'ready' && board !== undefined && readerProject !== undefined && notes !== undefined && (
          <DevLeadNotesReader project={readerProject} notesProject={readerNotesProject} notes={notes} now={now} t={t} />
        )}
        {state.status === 'ready' && board !== undefined && readerProject === undefined && (
          <>
            {blocked > 0 && (
              <div className="devlead-board-blocked-notice" role="status">
                <IconWarningOutlineRegular size={16} /><strong>{t('board.blocked.notice', { count: blocked })}</strong>
              </div>
            )}
            {notes?.index.status === 'error' && (
              <div className="devlead-board-notes-notice" role="status" title={notes.index.error?.message}>
                <IconListPenOutlineRegular size={13} /><span>{t('board.notes.unavailable')}</span>
              </div>
            )}
            {board.projects.length === 0 && (
              <div className="devlead-board-placeholder" data-devlead-board-empty="projects">
                <span className="devlead-board-state-mark" aria-hidden="true">✓</span>
                <h4>{t('board.emptyProjects.title')}</h4><p>{t('board.emptyProjects.description')}</p>
              </div>
            )}
            {groups.map(group => <ProjectGroup key={group.status} group={group} idPrefix={idPrefix} now={now} t={t} notes={notes} />)}
          </>
        )}
        {readerProject === undefined && (
          <details className="devlead-board-unlisted devlead-board-secondary" data-devlead-board-unlisted="true" aria-labelledby={`${idPrefix}-unlisted`}>
            <summary id={`${idPrefix}-unlisted`}>
              <span>{t('board.unlisted.title')}</span>{unlisted.length > 0 && <Tag tone="quiet">{unlisted.length}</Tag>}
            </summary>
            <div className="devlead-board-unlisted-body">
              {state.status !== 'ready' && <p>{t('board.unlisted.unavailable')}</p>}
              {state.status === 'ready' && workspaceError && <p role="alert">{t('board.unlisted.error')}</p>}
              {state.status === 'ready' && !workspaceError && workspacePhase === 'pending' && <p>{t('board.unlisted.pending')}</p>}
              {state.status === 'ready' && !workspaceError && workspacePhase === 'ready' && unlisted.length === 0 && <p>{t('board.unlisted.empty')}</p>}
              {state.status === 'ready' && !workspaceError && workspacePhase === 'ready' && unlisted.length > 0 && (
                <ul className="devlead-board-unlisted-list">
                  {unlisted.map(workspace => (
                    <li key={workspace.workspaceId} data-devlead-board-unlisted-project={workspace.workspaceId}>
                      <strong title={workspace.title}>{workspace.title}</strong><code title={workspace.path}>{workspace.path}</code>
                      <span>
                        {t('board.unlisted.sessions', { count: workspace.sessionCount })}{' · '}
                        {sessionPhase === 'pending' && workspace.sessionCount > 0 ? t('board.unlisted.activityPending')
                          : workspace.lastActivityAt === undefined ? t('board.unlisted.noActivity')
                            : <RelativeTime iso={workspace.lastActivityAt} now={now} t={t} />}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

export type { DevLeadBoardProjectStatus, DevLeadBoardTaskStatus }
