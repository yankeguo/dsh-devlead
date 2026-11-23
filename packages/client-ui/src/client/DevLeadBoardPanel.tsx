/**
 * Read-only right-Sidebar project board. All mutations remain with the lead
 * AI's Host tools; this surface contains only refresh and disclosure controls.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  IconRefreshOutlineRegular,
  IconWarningOutlineRegular,
  Pill,
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
  groupDevLeadBoardProjects,
  projectStatusTone,
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

/**
 * Dependencies supplied by the tab registration.
 *
 * The board path is deliberately not injected: it follows the tab Session's own
 * workspace root (and the Host global's current lead), so the body resolves it
 * from live Session-list data instead of freezing a deployment-time value.
 */
export interface DevLeadBoardPanelInjected {
  readonly files: DevLeadBoardFiles
}

/** Full right-Sidebar body props. */
export type DevLeadBoardPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'devlead'>
  & InjectFace<DevLeadBoardPanelInjected>

/** Live board body; hook lifetime equals the tab body's mounted lifetime. */
export function DevLeadBoardPanel({ sessionId, files, useWorkspaces, useSessions, useTabInfo, t }: DevLeadBoardPanelProps) {
  const sessions = useSessions((snapshot: SessionListState) => snapshot)
  const visible = useTabInfo().tab.visible
  const summary = sessions.byId[sessionId]
  // Resolve on every render, but hand `useBoardFile` the previous reference
  // while the real path/platform are unchanged: unrelated list/status updates
  // must not restart the read/watch cycle. Eligibility is part of the
  // resolution, so a lingering tab whose Session is no longer a lead resolves
  // no config and stops all I/O. A lead switch or a changed default path does
  // change the pair, and the next read follows the new file while the previous
  // request and stream are aborted.
  const resolved = resolveDevLeadBoardSessionConfig(sessionId, summary, currentDevLeadBoardConfig())
  const config = useMemo(() => resolved, [resolved?.boardPath, resolved?.pathPlatform])
  const { refresh, watch, autoRefresh, ...state } = useBoardFile({ sessionId, config, files, visible })
  const workspaces = useWorkspaces((snapshot: WorkspaceSnapshot) => snapshot)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])
  const unlisted = state.status === 'ready' && state.board !== undefined
    ? unlistedDevLeadWorkspaces(state.board, workspaces.items, sessions.byId, config?.pathPlatform)
    : []
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
    />
  )
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
}

/** Localize one relative timestamp without translating any board free text. */
function RelativeTime({ iso, now, t }: { readonly iso: string; readonly now: number; readonly t: DevLeadBoardPanelViewProps['t'] }) {
  const relative = boardRelativeTime(iso, now)
  const text = relative.unit === 'now'
    ? t('board.time.now')
    : t(`board.time.${relative.unit}`, { count: relative.n })
  return <time dateTime={iso} title={iso}>{text}</time>
}

/** One compact long-text field; its native title always retains the full text. */
function ProjectField({ label, text, className = '', arrow = '→' }: {
  readonly label: string
  readonly text: string
  readonly className?: string
  readonly arrow?: string
}) {
  if (text.trim().length === 0) return null
  return (
    <div className={`devlead-board-field ${className}`.trim()}>
      <span className="devlead-board-field-label">
        <span className="devlead-board-field-arrow" aria-hidden="true">{arrow}</span>
        {label}
      </span>
      <p title={text}>{text}</p>
    </div>
  )
}

/** Render one project without any write or Session-navigation action. */
function ProjectCard({ project, now, t }: {
  readonly project: DevLeadBoardProject
  readonly now: number
  readonly t: DevLeadBoardPanelViewProps['t']
}) {
  const idPrefix = useId()
  const progress = taskProgress(project)
  const progressText = t('board.tasks.progress', { done: progress.done, total: progress.total })
  return (
    <article
      className="devlead-board-card"
      data-devlead-board-project={project.id}
      data-status={project.status}
      tabIndex={0}
      aria-labelledby={`${idPrefix}-title`}
    >
      <header className="devlead-board-card-header">
        <div className="devlead-board-card-heading">
          <h5 id={`${idPrefix}-title`} title={project.workspace.title}>{project.workspace.title}</h5>
          <code className="devlead-board-project-id" title={project.id}>{project.id}</code>
        </div>
      </header>
      <code className="devlead-board-workspace" title={project.workspace.path}>{project.workspace.path}</code>
      <div className="devlead-board-card-badges">
        <span data-board-status={project.status}>
          <Pill className="devlead-board-status">{t(`board.status.${project.status}`)}</Pill>
        </span>
        <Tag tone="outline">{t(`board.priority.${project.priority}`)}</Tag>
      </div>
      <ProjectField label={t('board.field.focus')} text={project.focus} className="devlead-board-field-focus" />
      <ProjectField label={t('board.field.next')} text={project.next} className="devlead-board-field-next" arrow="↗" />
      <ProjectField label={t('board.field.goal')} text={project.goal} className="devlead-board-field-goal" arrow="·" />
      {project.blockers.length > 0 && (
        <section className="devlead-board-blockers" aria-label={t('board.blockers')}>
          <h6><IconWarningOutlineRegular size={14} />{t('board.blockers')}</h6>
          <ul>
            {project.blockers.map(blocker => (
              <li key={blocker.id}>
                <span title={blocker.text}>{blocker.text}</span>
                <span className="devlead-board-blocker-since">
                  {t('board.blocker.since')} <RelativeTime iso={blocker.since} now={now} t={t} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="devlead-board-progress">
        <div className="devlead-board-progress-heading">
          <span>{t('board.tasks.label')}</span>
          <strong>{t('board.tasks.count', { done: progress.done, total: progress.total })}</strong>
        </div>
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
      >
        <summary id={`${idPrefix}-tasks`}>{t('board.tasks.summary', { done: progress.done, total: progress.total })}</summary>
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
                    <code title={task.ownerSessionId}>
                      {t('board.task.owner')} {truncateSessionId(task.ownerSessionId)}
                    </code>
                  )}
                  <RelativeTime iso={task.updatedAt} now={now} t={t} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
      <footer className="devlead-board-card-footer">
        {t('board.project.updated')} <RelativeTime iso={project.updatedAt} now={now} t={t} />
      </footer>
    </article>
  )
}

/** Primary groups stay expanded; settled groups are native disclosures. */
function ProjectGroup({ group, idPrefix, now, t }: {
  readonly group: DevLeadBoardGroup
  readonly idPrefix: string
  readonly now: number
  readonly t: DevLeadBoardPanelViewProps['t']
}) {
  const headingId = `${idPrefix}-group-${group.status}`
  const secondary = group.status === 'paused' || group.status === 'done'
  const cards = (
    <div className="devlead-board-cards">
      {group.projects.map(project => <ProjectCard key={project.id} project={project} now={now} t={t} />)}
    </div>
  )
  if (secondary) {
    return (
      <details
        className="devlead-board-group devlead-board-secondary"
        data-board-group={group.status}
        aria-labelledby={headingId}
      >
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
    <section
      className="devlead-board-group"
      data-board-group={group.status}
      aria-labelledby={headingId}
    >
      <header className="devlead-board-group-header">
        <h4 id={headingId}>{t(`board.status.${group.status}`)}</h4>
        <Tag tone={projectStatusTone(group.status)}>{group.projects.length}</Tag>
      </header>
      {cards}
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
}: DevLeadBoardPanelViewProps): ReactNode {
  // Scope generated ids per mounted panel so two open Sidebar panes never share
  // heading ids; the hook must run before the disabled early return below.
  const idPrefix = useId()
  if (state.status === 'disabled') return null
  const board = state.board
  const groups = board === undefined ? [] : groupDevLeadBoardProjects(board)
  const counts: Record<DevLeadBoardProjectStatus, number> = { active: 0, blocked: 0, paused: 0, done: 0 }
  for (const project of board?.projects ?? []) counts[project.status] += 1
  const blocked = counts.blocked
  const refreshState = state.status === 'error'
    ? 'error'
    : autoRefresh === 'paused' || watch === 'ended'
      ? 'warning'
      : state.refreshing || state.status === 'loading' || watch === 'connecting'
        ? 'ongoing'
        : autoRefresh === 'active' && state.status === 'ready'
          ? 'done'
          : 'idle'
  const endedKey = autoRefresh === 'active'
    ? 'board.watch.ended'
    : autoRefresh === 'paused'
      ? 'board.watch.ended.paused'
      : 'board.watch.ended.disabled'
  const statusText = state.status === 'error'
    ? t('board.refresh.error')
    : watch === 'ended'
      ? t(endedKey)
      : autoRefresh === 'paused'
        ? t('board.autoRefresh.paused')
        : state.refreshing || state.status === 'loading'
          ? t('board.refresh.loading')
          : watch === 'connecting'
            ? t('board.watch.connecting')
            : t(`board.autoRefresh.${autoRefresh}`)
  return (
    <div className="devlead-board" data-devlead-board="true" data-state={state.status}>
      <header className="devlead-board-header">
        <div className="devlead-board-title-row">
          <div className="devlead-board-title-group">
            <h3>{t('board.title')}</h3>
            <Tag tone="quiet">{t('board.readonly')}</Tag>
          </div>
          <Tooltip label={t('board.refresh.action')} side="left" delayMs={300}>
            <Button
              variant="ghost"
              size="sm"
              className="devlead-board-refresh"
              aria-label={t('board.refresh.action')}
              aria-busy={state.refreshing}
              disabled={state.refreshing}
              onClick={onRefresh}
            >
              <IconRefreshOutlineRegular size={15} />
            </Button>
          </Tooltip>
        </div>
        <div
          className="devlead-board-live"
          data-auto-refresh={autoRefresh}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <StateDot state={refreshState} size={9} />
          <strong>{t('board.live')}</strong>
          <span>{statusText}</span>
        </div>
        {board !== undefined && (
          <dl className="devlead-board-kpis" aria-label={t('board.kpi.aria')}>
            {(['active', 'blocked', 'paused', 'done'] as const).map(status => {
              const count = counts[status]
              return (
                <div key={status} data-devlead-board-kpi={status} data-tone={status}>
                  <dt>{t(`board.status.${status}`)}</dt>
                  <dd aria-label={t('board.kpi.value', { status: t(`board.status.${status}`), count })}>{count}</dd>
                </div>
              )
            })}
          </dl>
        )}
        {board !== undefined && (
          <div className="devlead-board-meta">
            <span className="devlead-board-updated">
              {t('board.updated')} <RelativeTime iso={board.updatedAt} now={now} t={t} />
            </span>
            <span className="devlead-board-revision" title={t('board.revision.full', { revision: board.revision })}>
              {t('board.revision', { revision: board.revision })}
            </span>
          </div>
        )}
      </header>

      <div className="devlead-board-content">
        {state.status === 'loading' && (
          <div className="devlead-board-placeholder" role="status" data-devlead-board-loading="true">
            <span className="devlead-board-state-mark" aria-hidden="true">···</span>
            <h4>{t('board.loading')}</h4>
            <p>{t('board.loading.description')}</p>
          </div>
        )}
        {state.status === 'empty' && (
          <div className="devlead-board-placeholder" data-devlead-board-empty="file">
            <span className="devlead-board-state-mark" aria-hidden="true">○</span>
            <h4>{t('board.empty.title')}</h4>
            <p>{t('board.empty.description')}</p>
          </div>
        )}
        {state.status === 'error' && (
          <div className="devlead-board-error" role="alert" data-devlead-board-error={state.error?.kind ?? 'read'}>
            <span className="devlead-board-state-mark" aria-hidden="true"><IconWarningOutlineRegular size={20} /></span>
            <h4>{t(state.error?.kind === 'parse' ? 'board.error.parse' : 'board.error.read')}</h4>
            {state.lastSuccessAt !== undefined && (
              <p>{t('board.lastSuccess')} <RelativeTime iso={state.lastSuccessAt} now={now} t={t} /></p>
            )}
            {state.error !== undefined && <code className="devlead-board-error-detail" title={state.error.message}>{state.error.message}</code>}
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={state.refreshing}>
              <IconRefreshOutlineRegular size={14} />{t('board.retry')}
            </Button>
          </div>
        )}
        {state.status === 'ready' && board !== undefined && (
          <>
            {blocked > 0 && (
              <div className="devlead-board-blocked-notice" role="status">
                <IconWarningOutlineRegular size={16} />
                <strong>{t('board.blocked.notice', { count: blocked })}</strong>
              </div>
            )}
            {board.projects.length === 0 && (
              <div className="devlead-board-placeholder" data-devlead-board-empty="projects">
                <span className="devlead-board-state-mark" aria-hidden="true">✓</span>
                <h4>{t('board.emptyProjects.title')}</h4>
                <p>{t('board.emptyProjects.description')}</p>
              </div>
            )}
            {groups.map(group => (
              <ProjectGroup key={group.status} group={group} idPrefix={idPrefix} now={now} t={t} />
            ))}
          </>
        )}
        <details
          className="devlead-board-unlisted devlead-board-secondary"
          data-devlead-board-unlisted="true"
          aria-labelledby={`${idPrefix}-unlisted`}
        >
          <summary id={`${idPrefix}-unlisted`}>
            <span>{t('board.unlisted.title')}</span>
            {unlisted.length > 0 && <Tag tone="quiet">{unlisted.length}</Tag>}
          </summary>
          <div className="devlead-board-unlisted-body">
            {state.status !== 'ready' && <p>{t('board.unlisted.unavailable')}</p>}
            {state.status === 'ready' && workspaceError && (
              <p role="alert">{t('board.unlisted.error')}</p>
            )}
            {state.status === 'ready' && !workspaceError && workspacePhase === 'pending' && <p>{t('board.unlisted.pending')}</p>}
            {state.status === 'ready' && !workspaceError && workspacePhase === 'ready' && unlisted.length === 0 && (
              <p>{t('board.unlisted.empty')}</p>
            )}
            {state.status === 'ready' && !workspaceError && workspacePhase === 'ready' && unlisted.length > 0 && (
              <ul className="devlead-board-unlisted-list">
                {unlisted.map(workspace => (
                  <li key={workspace.workspaceId} data-devlead-board-unlisted-project={workspace.workspaceId}>
                    <strong title={workspace.title}>{workspace.title}</strong>
                    <code title={workspace.path}>{workspace.path}</code>
                    <span>
                      {t('board.unlisted.sessions', { count: workspace.sessionCount })}
                      {' · '}
                      {sessionPhase === 'pending' && workspace.sessionCount > 0
                        ? t('board.unlisted.activityPending')
                        : workspace.lastActivityAt === undefined
                          ? t('board.unlisted.noActivity')
                          : <RelativeTime iso={workspace.lastActivityAt} now={now} t={t} />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}

/** Raw status unions stay exported for tests and future full-page rendering. */
export type { DevLeadBoardProjectStatus, DevLeadBoardTaskStatus }
