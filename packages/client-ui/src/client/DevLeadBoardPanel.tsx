/**
 * Read-only right-Sidebar project board. All mutations remain with the lead
 * AI's Host tools; this surface contains only refresh and disclosure controls.
 */
import { useEffect, useState, type ReactNode } from 'react'
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
  groupDevLeadBoardProjects,
  projectStatusTone,
  taskProgress,
  taskStatusTone,
  truncateSessionId,
  unlistedDevLeadWorkspaces,
  type DevLeadBoardConfig,
  type DevLeadUnlistedWorkspace,
  type DevLeadBoardProject,
  type DevLeadBoardProjectStatus,
  type DevLeadBoardTaskStatus,
} from './board.ts'
import {
  useBoardFile,
  type DevLeadBoardFileState,
  type DevLeadBoardFiles,
  type DevLeadBoardWatchStatus,
} from './useBoardFile.ts'

/** Dependencies supplied by the tab registration. */
export interface DevLeadBoardPanelInjected {
  readonly config: DevLeadBoardConfig | undefined
  readonly files: DevLeadBoardFiles
}

/** Full right-Sidebar body props. */
export type DevLeadBoardPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'devlead'>
  & InjectFace<DevLeadBoardPanelInjected>

/** Live board body; hook lifetime equals the tab body's mounted lifetime. */
export function DevLeadBoardPanel({ sessionId, config, files, useWorkspaces, useSessions, t }: DevLeadBoardPanelProps) {
  const { refresh, watch, ...state } = useBoardFile({ sessionId, config, files })
  const workspaces = useWorkspaces((snapshot: WorkspaceSnapshot) => snapshot)
  const sessions = useSessions((snapshot: SessionListState) => snapshot)
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
}

/** Localize one relative timestamp without translating any board free text. */
function RelativeTime({ iso, now, t }: { readonly iso: string; readonly now: number; readonly t: DevLeadBoardPanelViewProps['t'] }) {
  const relative = boardRelativeTime(iso, now)
  const text = relative.unit === 'now'
    ? t('board.time.now')
    : t(`board.time.${relative.unit}`, { count: relative.n })
  return <time dateTime={iso} title={iso}>{text}</time>
}

/** One labelled long-text field, omitted while empty. */
function ProjectField({ label, text, className = '' }: {
  readonly label: string
  readonly text: string
  readonly className?: string
}) {
  if (text.trim().length === 0) return null
  return (
    <div className={`devlead-board-field ${className}`.trim()}>
      <span className="devlead-board-field-label">{label}</span>
      <p>{text}</p>
    </div>
  )
}

/** Render one project without any write or Session-navigation action. */
function ProjectCard({ project, now, t }: {
  readonly project: DevLeadBoardProject
  readonly now: number
  readonly t: DevLeadBoardPanelViewProps['t']
}) {
  const progress = taskProgress(project)
  return (
    <article className="devlead-board-card" data-devlead-board-project={project.id} data-status={project.status}>
      <header className="devlead-board-card-header">
        <div className="devlead-board-card-heading">
          <h5>{project.workspace.title}</h5>
          <code className="devlead-board-project-id" title={project.id}>{project.id}</code>
        </div>
        <div className="devlead-board-card-badges">
          <span data-board-status={project.status}>
            <Pill className="devlead-board-status">{t(`board.status.${project.status}`)}</Pill>
          </span>
          <Tag tone="outline">{t(`board.priority.${project.priority}`)}</Tag>
        </div>
      </header>
      <code className="devlead-board-workspace" title={project.workspace.path}>{project.workspace.path}</code>
      <ProjectField label={t('board.field.goal')} text={project.goal} />
      <ProjectField label={t('board.field.focus')} text={project.focus} />
      <ProjectField label={t('board.field.next')} text={project.next} />
      {project.blockers.length > 0 && (
        <section className="devlead-board-blockers" aria-label={t('board.blockers')}>
          <h6><IconWarningOutlineRegular size={14} />{t('board.blockers')}</h6>
          <ul>
            {project.blockers.map(blocker => (
              <li key={blocker.id}>
                <span>{blocker.text}</span>
                <span className="devlead-board-blocker-since">
                  {t('board.blocker.since')} <RelativeTime iso={blocker.since} now={now} t={t} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <details className="devlead-board-tasks" data-devlead-board-tasks={project.id}>
        <summary>{t('board.tasks.summary', { done: progress.done, total: progress.total })}</summary>
        {project.tasks.length === 0 ? <p className="devlead-board-muted">{t('board.tasks.empty')}</p> : (
          <ul>
            {project.tasks.map(task => (
              <li key={task.id} data-task-status={task.status}>
                <div className="devlead-board-task-heading">
                  <span className="devlead-board-task-title">{task.title}</span>
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
}: DevLeadBoardPanelViewProps): ReactNode {
  if (state.status === 'disabled') return null
  const board = state.board
  const blocked = board?.projects.filter(project => project.status === 'blocked').length ?? 0
  const groups = board === undefined ? [] : groupDevLeadBoardProjects(board)
  const refreshState = state.status === 'error'
    ? 'error'
    : watch === 'ended'
      ? 'warning'
      : state.refreshing || state.status === 'loading' || watch === 'connecting'
        ? 'ongoing'
        : state.status === 'ready'
          ? 'done'
          : 'idle'
  const statusText = state.status === 'error'
    ? t('board.refresh.error')
    : watch === 'ended'
      ? t('board.watch.ended')
      : state.refreshing || state.status === 'loading'
        ? t('board.refresh.loading')
        : watch === 'connecting'
          ? t('board.watch.connecting')
          : state.status === 'ready'
            ? t('board.refresh.ready')
            : t('board.refresh.empty')
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
        <div className="devlead-board-meta">
          {board !== undefined && <span className="devlead-board-revision">{t('board.revision', { revision: board.revision })}</span>}
          {board !== undefined && <RelativeTime iso={board.updatedAt} now={now} t={t} />}
          <span className="devlead-board-refresh-state" role="status" aria-live="polite">
            <StateDot state={refreshState} size={9} />
            {statusText}
          </span>
        </div>
      </header>

      <div className="devlead-board-content">
        {state.status === 'loading' && (
          <div className="devlead-board-placeholder" role="status">{t('board.loading')}</div>
        )}
        {state.status === 'empty' && (
          <div className="devlead-board-placeholder" data-devlead-board-empty="file">
            <h4>{t('board.empty.title')}</h4>
            <p>{t('board.empty.description')}</p>
          </div>
        )}
        {state.status === 'error' && (
          <div className="devlead-board-error" role="alert" data-devlead-board-error={state.error?.kind ?? 'read'}>
            <h4>{t(state.error?.kind === 'parse' ? 'board.error.parse' : 'board.error.read')}</h4>
            {state.lastSuccessAt !== undefined && (
              <p>{t('board.lastSuccess')} <RelativeTime iso={state.lastSuccessAt} now={now} t={t} /></p>
            )}
            {state.error !== undefined && <code className="devlead-board-error-detail">{state.error.message}</code>}
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={state.refreshing}>
              <IconRefreshOutlineRegular size={14} />{t('board.retry')}
            </Button>
          </div>
        )}
        {state.status === 'ready' && board !== undefined && (
          <>
            {blocked > 0 && (
              <div className="devlead-board-blocked-notice" role="status">
                <IconWarningOutlineRegular size={15} />
                {t('board.blocked.notice', { count: blocked })}
              </div>
            )}
            {board.projects.length === 0 && (
              <div className="devlead-board-placeholder" data-devlead-board-empty="projects">
                <h4>{t('board.emptyProjects.title')}</h4>
                <p>{t('board.emptyProjects.description')}</p>
              </div>
            )}
            {groups.map(group => (
              <section
                className="devlead-board-group"
                key={group.status}
                data-board-group={group.status}
                aria-labelledby={`devlead-board-group-${group.status}`}
              >
                <header className="devlead-board-group-header">
                  <h4 id={`devlead-board-group-${group.status}`}>{t(`board.status.${group.status}`)}</h4>
                  <Tag tone={projectStatusTone(group.status)}>{group.projects.length}</Tag>
                </header>
                <div className="devlead-board-cards">
                  {group.projects.map(project => <ProjectCard key={project.id} project={project} now={now} t={t} />)}
                </div>
              </section>
            ))}
          </>
        )}
        <details className="devlead-board-unlisted" data-devlead-board-unlisted="true">
          <summary>{t('board.unlisted.title')}</summary>
          <div className="devlead-board-unlisted-body">
            {state.status !== 'ready' && <p>{t('board.unlisted.unavailable')}</p>}
            {state.status === 'ready' && workspacePhase === 'pending' && <p>{t('board.unlisted.pending')}</p>}
            {state.status === 'ready' && workspacePhase === 'ready' && workspaceError && (
              <p role="alert">{t('board.unlisted.error')}</p>
            )}
            {state.status === 'ready' && workspacePhase === 'ready' && !workspaceError && unlisted.length === 0 && (
              <p>{t('board.unlisted.empty')}</p>
            )}
            {state.status === 'ready' && workspacePhase === 'ready' && !workspaceError && unlisted.length > 0 && (
              <ul className="devlead-board-unlisted-list">
                {unlisted.map(workspace => (
                  <li key={workspace.workspaceId} data-devlead-board-unlisted-project={workspace.workspaceId}>
                    <strong>{workspace.title}</strong>
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
