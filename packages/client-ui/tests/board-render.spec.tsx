/** Read-only board header button, live body wiring, and right-Sidebar view rendering. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import {
  DevLeadBoardButton,
  DevLeadBoardTitle,
  type DevLeadBoardButtonProps,
  type DevLeadBoardTitleProps,
} from '../src/client/DevLeadBoardButton.tsx'
import {
  DevLeadBoardPanel,
  DevLeadBoardPanelView,
  type DevLeadBoardPanelProps,
  type DevLeadBoardPanelViewProps,
  type DevLeadBoardNotesView,
} from '../src/client/DevLeadBoardPanel.tsx'
import { deriveDevLeadNotesPaths, type DevLeadNotesIndex } from '../src/client/notes.ts'
import type { DevLeadBoard, DevLeadBoardProject } from '../src/client/board.ts'
import { en, zh } from '../src/client/locales.ts'
import type {
  DevLeadBoardChangeStream,
  DevLeadBoardFileState,
  DevLeadBoardFiles,
} from '../src/client/useBoardFile.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Button = ({ children, ...rest }: { readonly children?: ReactNode } & Record<string, unknown>) => (
    <button {...rest}>{children}</button>
  )
  const Tooltip = ({ label, children, openOnClick = false, portal = false }: {
    readonly label?: string
    readonly children?: ReactNode
    readonly openOnClick?: boolean
    readonly portal?: boolean
  }) => (
    <span data-mock-tooltip={label} data-open-on-click={openOnClick || undefined} data-portal={portal || undefined}>{children}</span>
  )
  const Pill = ({ children, className }: { readonly children?: ReactNode; readonly className?: string }) => (
    <span className={className} data-mock-pill="true">{children}</span>
  )
  const Tag = ({ children, tone }: { readonly children?: ReactNode; readonly tone?: string }) => (
    <span data-mock-tag={tone}>{children}</span>
  )
  const StateDot = ({ state }: { readonly state: string }) => <span data-mock-state-dot={state} aria-hidden="true" />
  const Icon = ({ size }: { readonly size?: number }) => <span data-mock-icon="true" data-icon-size={size} aria-hidden="true" />
  const GaugeIcon = ({ size }: { readonly size?: number }) => <span data-mock-icon="gauge" data-icon-size={size} aria-hidden="true" />
  const ChevronUpIcon = ({ size }: { readonly size?: number }) => <span data-mock-icon="chevron-up" data-icon-size={size} aria-hidden="true" />
  const ChevronDownIcon = ({ size }: { readonly size?: number }) => <span data-mock-icon="chevron-down" data-icon-size={size} aria-hidden="true" />
  return {
    Button,
    Tooltip,
    Pill,
    Tag,
    StateDot,
    IconRefreshOutlineRegular: Icon,
    IconWarningOutlineRegular: Icon,
    IconFlatListOutlineRegular: Icon,
    IconGaugeOutlineRegular: GaugeIcon,
    IconClockOutlineRegular: Icon,
    IconListPenOutlineRegular: Icon,
    IconPlanOutlineRegular: Icon,
    IconPlayOutlineRegular: Icon,
    IconPauseOutlineRegular: Icon,
    IconCheckCircleOutlineRegular: Icon,
    IconChevronLeftOutlineRegular: Icon,
    IconChevronUpOutlineRegular: ChevronUpIcon,
    IconChevronDownOutlineRegular: ChevronDownIcon,
  }
})

function translate(dictionary: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>) =>
    (dictionary[key] ?? key).replace(/\{([a-z]+)\}/gu, (placeholder, name: string) => {
      const value = params?.[name]
      return value === undefined ? placeholder : String(value)
    })
}

const t = translate(zh) as DevLeadBoardPanelViewProps['t']
const NOW = Date.UTC(2026, 10, 23, 8, 0, 0)
const ISO = '2026-11-23T07:58:00.000Z'

function project(id: string, status: DevLeadBoardProject['status'], priority: DevLeadBoardProject['priority'] = 'medium'): DevLeadBoardProject {
  return {
    id,
    workspace: { path: `/work/${id}`, title: `Project ${id}` },
    status,
    priority,
    goal: `Goal ${id}`,
    focus: `Focus ${id}`,
    next: `Next ${id}`,
    blockers: status === 'blocked' ? [{ id: 'b1', text: 'Waiting for review', since: ISO }] : [],
    tasks: [
      { id: 't1', title: 'Ship UI', status: 'done', updatedAt: ISO },
      { id: 't2', title: 'Verify panel', status: 'doing', ownerSessionId: 'session-1234567890abcdef', updatedAt: ISO },
    ],
    updatedAt: ISO,
  }
}

const BOARD: DevLeadBoard = {
  schemaVersion: 1,
  revision: 42,
  updatedAt: ISO,
  updatedBy: { sessionId: 'session-lead', title: 'Lead' },
  projects: [
    project('active', 'active', 'low'),
    project('blocked', 'blocked', 'high'),
    project('paused', 'paused'),
    project('done', 'done'),
  ],
}

const READY: DevLeadBoardFileState = { status: 'ready', board: BOARD, lastSuccessAt: ISO, refreshing: false }
const NOTES_PATHS = deriveDevLeadNotesPaths({ boardPath: '/work/project/.dsh/devlead/board.json', schemaVersion: 1, pathPlatform: 'posix' })
const NOTES_INDEX: DevLeadNotesIndex = {
  schemaVersion: 1,
  revision: 1,
  updatedAt: ISO,
  projects: [{
    id: 'active',
    directory: 'active-dir',
    notes: [
      { id: 'n1', title: 'Older note', summary: 'Summary one', updatedAt: '2026-11-23T06:00:00.000Z', bytes: 20, path: 'active-dir/n1.md' },
      { id: 'n2', title: 'Latest note', summary: 'Summary two', updatedAt: ISO, bytes: 40, path: 'active-dir/n2.md' },
    ],
  }],
}

function notesView(overrides: Partial<DevLeadBoardNotesView> = {}): DevLeadBoardNotesView {
  return {
    paths: NOTES_PATHS,
    index: { status: 'ready', value: NOTES_INDEX, valuePath: NOTES_PATHS.indexPath, refreshing: false, watch: 'live', autoRefresh: 'active', refresh: () => {} },
    note: { status: 'ready', value: { markdown: '# Safe title\n\nBody **bold**.' }, valuePath: `${NOTES_PATHS.root}/active-dir/n2.md`, refreshing: false, watch: 'live', autoRefresh: 'active', refresh: () => {} },
    onOpen: () => {},
    onSelect: () => {},
    onClose: () => {},
    ...overrides,
  }
}

const mounted: ReactTestRenderer[] = []

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined
  await act(async () => { renderer = create(element) })
  if (renderer === undefined) throw new Error('no renderer')
  mounted.push(renderer)
  return renderer
}

function textOf(instance: ReactTestInstance): string {
  return instance.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
}

function visibleTextOf(instance: ReactTestInstance): string {
  if (typeof instance.props.className === 'string' && instance.props.className.split(' ').includes('devlead-sr-only')) return ''
  return instance.children.map(child => typeof child === 'string' ? child : visibleTextOf(child)).join('')
}

function view(state: DevLeadBoardFileState, overrides: Partial<DevLeadBoardPanelViewProps> = {}): ReactElement {
  return <DevLeadBoardPanelView state={state} onRefresh={() => {}} now={NOW} t={t} {...overrides} />
}

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** One Session-list row carrying the board gate facts. */
type GateRows = Record<string, {
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly projectionValues?: { readonly devLeadMode?: { readonly enabled?: boolean } }
}>

/** Slot props for the gated header action. */
function buttonProps(rows: GateRows, onOpen: () => void): DevLeadBoardButtonProps {
  return {
    sessionId: 'session-1',
    useSessions: (selector: (state: SessionListState) => unknown) =>
      selector({ byId: rows } as unknown as SessionListState),
    onOpen,
    t,
  } as unknown as DevLeadBoardButtonProps
}

const LEAD_ROW = { cwd: '/work/project', projectionValues: { devLeadMode: { enabled: true } } }

describe('DevLeadBoardButton', () => {
  it('renders nothing for a Session that is not an eligible lead', async () => {
    for (const rows of [
      {},
      { 'session-1': { cwd: '/work/project' } },
      { 'session-1': { cwd: '/work/project', projectionValues: { devLeadMode: { enabled: false } } } },
      { 'session-1': { cwd: '/work/project', origin: 'subagent' as const, projectionValues: { devLeadMode: { enabled: true } } } },
      { 'session-1': { projectionValues: { devLeadMode: { enabled: true } } } },
    ]) {
      const renderer = await mount(<DevLeadBoardButton {...buttonProps(rows, () => {})} />)
      expect(renderer.toJSON()).toBeNull()
    }
  })

  it('opens the board from an icon-only, localized header action', async () => {
    const onOpen = vi.fn()
    const renderer = await mount(<DevLeadBoardButton {...buttonProps({ 'session-1': LEAD_ROW }, onOpen)} />)
    const button = renderer.root.findByType('button')
    expect(button.props['aria-label']).toBe(zh['board.open'])
    expect(button.props['data-devlead-board-open']).toBe('true')
    expect(renderer.root.findByProps({ 'data-mock-tooltip': zh['board.open'] })).toBeDefined()
    expect(renderer.root.findByProps({ 'data-mock-icon': 'gauge' }).props['data-icon-size']).toBe(18)
    button.props.onClick()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('rerenders the tab-chip title when the locale changes', async () => {
    const props = { t } as unknown as DevLeadBoardTitleProps
    const renderer = await mount(<DevLeadBoardTitle {...props} />)
    expect(textOf(renderer.root)).toBe(zh['board.title'])
    await act(async () => {
      renderer.update(<DevLeadBoardTitle {...{ t: translate(en) } as unknown as DevLeadBoardTitleProps} />)
    })
    expect(textOf(renderer.root)).toBe(en['board.title'])
  })
})

describe('DevLeadBoardPanelView', () => {
  it('renders nothing while disabled', async () => {
    const renderer = await mount(view({ status: 'disabled', refreshing: false }))
    expect(renderer.toJSON()).toBeNull()
  })

  it('renders initial loading and file-not-found states distinctly', async () => {
    const loading = await mount(view({ status: 'loading', refreshing: true }))
    expect(textOf(loading.root)).toContain(zh['board.loading'])
    expect(loading.root.findByProps({ 'data-mock-state-dot': 'ongoing' })).toBeDefined()
    const empty = await mount(view({ status: 'empty', refreshing: false }))
    expect(textOf(empty.root.findByProps({ 'data-devlead-board-empty': 'file' }))).toContain('还没有看板数据')
    expect(textOf(empty.root)).toContain(zh['board.unlisted.unavailable'])
    expect(empty.root.findAllByProps({ 'data-devlead-board-error': 'read' })).toHaveLength(0)
  })

  it('keeps automatic polling explicit when the file watch ends', async () => {
    const renderer = await mount(view(READY, { watch: 'ended', autoRefresh: 'active' }))
    expect(textOf(renderer.root)).toContain(zh['board.watch.ended'])
    expect(textOf(renderer.root)).toContain('自动轮询仍开启')
    expect(textOf(renderer.root)).not.toContain(zh['board.watch.ended.disabled'])
    expect(renderer.root.findByProps({ 'data-auto-refresh': 'active' }).findByProps({ 'data-mock-state-dot': 'warning' })).toBeDefined()
  })

  it('renders active, paused, and disabled auto-refresh states distinctly', async () => {
    for (const autoRefresh of ['active', 'paused', 'disabled'] as const) {
      const renderer = await mount(view(READY, { autoRefresh }))
      const live = renderer.root.findByProps({ 'data-auto-refresh': autoRefresh })
      expect(textOf(live)).toContain(zh['board.live'])
      expect(textOf(live)).toContain(zh[`board.autoRefresh.${autoRefresh}`])
    }
    const pausedEnded = await mount(view(READY, { autoRefresh: 'paused', watch: 'ended' }))
    expect(textOf(pausedEnded.root)).toContain(zh['board.watch.ended.paused'])
    const disabledEnded = await mount(view(READY, { autoRefresh: 'disabled', watch: 'ended' }))
    expect(textOf(disabledEnded.root)).toContain(zh['board.watch.ended.disabled'])
    const pausedConnecting = await mount(view(READY, { autoRefresh: 'paused', watch: 'connecting' }))
    expect(textOf(pausedConnecting.root)).toContain(zh['board.autoRefresh.paused'])
    expect(textOf(pausedConnecting.root)).not.toContain(zh['board.watch.connecting'])
  })

  it('keeps polling busy text out of the polite live region', async () => {
    const renderer = await mount(view(READY))
    const announcement = renderer.root.findByProps({ 'data-devlead-board-live-announcement': 'true' })
    expect(announcement.props.role).toBe('status')
    expect(announcement.props['aria-live']).toBe('polite')
    expect(textOf(announcement)).toBe(zh['board.autoRefresh.active'])
    expect(renderer.root.findByProps({ 'data-auto-refresh': 'active' }).props.role).toBeUndefined()
    await act(async () => {
      renderer.update(view({ ...READY, refreshing: true }))
    })
    expect(textOf(renderer.root.findByProps({ 'data-devlead-board-live-announcement': 'true' })))
      .toBe(zh['board.autoRefresh.active'])
    expect(textOf(renderer.root.findByProps({ 'data-auto-refresh': 'active' }))).toContain(zh['board.refresh.loading'])
    await act(async () => {
      renderer.update(view(READY, { autoRefresh: 'paused' }))
    })
    expect(textOf(renderer.root.findByProps({ 'data-devlead-board-live-announcement': 'true' })))
      .toBe(zh['board.autoRefresh.paused'])
  })

  it('renders parse failure, last success, technical detail, and a working retry', async () => {
    const onRefresh = vi.fn()
    const renderer = await mount(view({
      status: 'error',
      error: { kind: 'parse', message: 'Unexpected token' },
      lastSuccessAt: ISO,
      refreshing: false,
    }, { onRefresh }))
    const error = renderer.root.findByProps({ 'data-devlead-board-error': 'parse' })
    expect(textOf(error)).toContain('看板文件解析失败')
    expect(textOf(error)).toContain('Unexpected token')
    expect(textOf(error)).toContain('2 分钟前')
    expect(renderer.root.findAllByProps({ 'data-devlead-board-project': 'blocked' })).toHaveLength(0)
    const retry = error.findByType('button')
    retry.props.onClick()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('renders blocked first, project details, native task disclosure, and revision metadata', async () => {
    const renderer = await mount(view(READY))
    expect(textOf(renderer.root)).toContain('r42')
    expect(textOf(renderer.root)).toContain('2 分钟前')
    expect(textOf(renderer.root.findByProps({ className: 'devlead-board-blocked-notice' }))).toContain('1 个项目已阻塞')
    const groups = renderer.root.findAll(instance => instance.props['data-board-group'] !== undefined)
    expect(groups.map(group => group.props['data-board-group'])).toEqual(['blocked', 'active', 'paused', 'done'])
    const card = renderer.root.findByProps({ 'data-devlead-board-project': 'blocked' })
    expect(card.children.slice(0, 3).map(child => typeof child === 'string' ? child : child.props.className)).toEqual([
      'devlead-board-card-header', 'devlead-board-workspace', 'devlead-board-card-badges',
    ])
    expect(textOf(card)).toContain('Project blocked')
    expect(textOf(card)).toContain('/work/blocked')
    expect(textOf(card)).toContain('Focus blocked')
    expect(textOf(card)).toContain('Next blocked')
    expect(textOf(card)).toContain('Waiting for review')
    expect(visibleTextOf(card.findByProps({ className: 'devlead-board-card-badges' }))).not.toContain('高优先级')
    expect(card.findByProps({ 'data-devlead-board-priority': 'high' }).props['aria-label']).toBe('高优先级')
    const tasks = renderer.root.findByProps({ 'data-devlead-board-tasks': 'blocked' })
    expect(tasks.type).toBe('details')
    expect(tasks.findByType('summary').props['aria-label']).toBe(zh['board.tasks.summary'].replace('{done}', '1').replace('{total}', '2'))
    expect(textOf(tasks)).toContain('Verify panel')
    expect(textOf(tasks)).toContain('session-12…bcdef')
    // The only buttons in a healthy board are refresh controls, never writes.
    expect(renderer.root.findAllByType('button')).toHaveLength(1)
  })

  it('uses one compact header row without duplicating the tab title or read-only tag', async () => {
    const renderer = await mount(view(READY))
    const board = renderer.root.findByProps({ 'data-devlead-board': 'true' })
    expect(board.props['aria-label']).toBe(zh['board.title'])
    const header = board.findByProps({ className: 'devlead-board-header' })
    expect(header.findAllByType('h3')).toHaveLength(0)
    expect(header.findAllByProps({ className: 'devlead-board-title-row' })).toHaveLength(0)
    expect(visibleTextOf(header)).not.toContain(zh['board.title'])
    expect(visibleTextOf(header)).not.toContain(zh['board.readonly'])
    const strip = header.findByProps({ className: 'devlead-board-header-strip' })
    expect(strip.children.map(child => typeof child === 'string' ? child : child.props.className)).toEqual([
      'devlead-board-live', 'devlead-board-header-actions',
    ])
    const actions = strip.findByProps({ className: 'devlead-board-header-actions' })
    expect(actions.findByProps({ className: 'devlead-board-meta' })).toBeDefined()
    const lastAction = actions.children.at(-1)!
    expect(typeof lastAction === 'string' ? undefined : lastAction.findByProps({ className: 'devlead-board-refresh' }).props['aria-label'])
      .toBe(zh['board.refresh.action'])
  })

  it('keeps ten stable card sections and replaces status dots and priority text with title-row glyphs', async () => {
    const renderer = await mount(view({
      ...READY,
      board: {
        ...BOARD,
        projects: [
          { ...project('active-high', 'active', 'high'), goal: '', focus: 'short', next: 'a much longer next action '.repeat(12) },
          { ...project('active-medium', 'active', 'medium'), focus: 'a much longer focus '.repeat(12), next: 'short' },
          project('active-low', 'active', 'low'),
        ],
      },
    }))
    const expectedSections = ['title', 'workspace', 'meta', 'focus', 'next', 'goal', 'blockers', 'progress', 'tasks', 'footer']
    for (const [id, priority, upCount, downCount] of [
      ['active-high', 'high', 2, 0],
      ['active-medium', 'medium', 1, 0],
      ['active-low', 'low', 0, 1],
    ] as const) {
      const card = renderer.root.findByProps({ 'data-devlead-board-project': id })
      expect(card.findAll(instance => instance.props['data-devlead-board-section'] !== undefined)
        .map(instance => instance.props['data-devlead-board-section'])).toEqual(expectedSections)
      expect(card.findAllByProps({ className: 'devlead-board-card-status' })).toHaveLength(0)
      expect(card.findAllByProps({ 'data-mock-state-dot': 'ongoing' })).toHaveLength(0)
      const header = card.findByProps({ className: 'devlead-board-card-header' })
      const priorityIcon = header.findByProps({ 'data-devlead-board-priority': priority })
      expect(priorityIcon.props.role).toBe('img')
      expect(priorityIcon.props['aria-label']).toBe(zh[`board.priority.${priority}`])
      expect(priorityIcon.props.title).toBe(zh[`board.priority.${priority}`])
      expect(priorityIcon.props.tabIndex).toBe(0)
      const priorityTooltip = header.findByProps({ 'data-mock-tooltip': zh[`board.priority.${priority}`] })
      expect(priorityTooltip.props['data-open-on-click']).toBe(true)
      expect(priorityTooltip.props['data-portal']).toBe(true)
      expect(priorityIcon.findAllByProps({ 'data-mock-icon': 'chevron-up' })).toHaveLength(upCount)
      expect(priorityIcon.findAllByProps({ 'data-mock-icon': 'chevron-down' })).toHaveLength(downCount)
      const lastHeaderChild = header.children.at(-1)!
      expect(typeof lastHeaderChild === 'string' ? undefined : lastHeaderChild.findByProps({ 'data-devlead-board-priority': priority }))
        .toBeDefined()
      expect(visibleTextOf(card.findByProps({ className: 'devlead-board-card-badges' }))).not.toContain(zh[`board.priority.${priority}`])
      expect(card.findByProps({ 'data-devlead-board-section': 'focus' }).findByType('p').props.title).toContain(id === 'active-medium' ? 'longer focus' : id === 'active-high' ? 'short' : 'Focus')
    }
    const emptyGoal = renderer.root.findByProps({ 'data-devlead-board-project': 'active-high' })
      .findByProps({ 'data-devlead-board-section': 'goal' })
    expect(emptyGoal.props['data-empty']).toBe('true')
    expect(emptyGoal.props['aria-hidden']).toBe(true)
  })

  it('removes redundant visible field labels while retaining their accessible semantics', async () => {
    const renderer = await mount(view(READY))
    const card = renderer.root.findByProps({ 'data-devlead-board-project': 'blocked' })
    const visible = visibleTextOf(card)
    for (const key of ['board.field.focus', 'board.field.goal', 'board.field.next', 'board.tasks.label', 'board.project.updated'] as const) {
      expect(visible).not.toContain(zh[key])
      expect(textOf(card)).toContain(key === 'board.tasks.label' ? '1/2' : key === 'board.project.updated' ? '2 分钟前' : ({
        'board.field.focus': 'Focus blocked',
        'board.field.goal': 'Goal blocked',
        'board.field.next': 'Next blocked',
      } as Record<string, string>)[key])
    }
    expect(card.findAllByProps({ className: 'devlead-board-field-label' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-devlead-board-progress': 'blocked' }).props['aria-label']).toContain(zh['board.tasks.label'])
    const updated = card.findByProps({ className: 'devlead-board-card-footer' }).findByType('time')
    expect(updated.props['aria-label']).toContain(zh['board.project.updated'])
  })

  it('renders labelled KPI counts for every project status', async () => {
    const renderer = await mount(view(READY))
    const overview = renderer.root.findByProps({ className: 'devlead-board-kpis' })
    expect(overview.type).toBe('dl')
    expect(overview.props['aria-label']).toBe(zh['board.kpi.aria'])
    expect(overview.props.tabIndex).toBe(0)
    const kpis = renderer.root.findAll(instance => instance.props['data-devlead-board-kpi'] !== undefined)
    expect(kpis.map(kpi => kpi.props['data-devlead-board-kpi'])).toEqual(['blocked', 'active', 'paused', 'done'])
    expect(kpis.map(kpi => textOf(kpi.findByType('dd')))).toEqual(['1', '1', '1', '1'])
    expect(kpis.map(kpi => kpi.props['data-empty'])).toEqual(['false', 'false', 'false', 'false'])
    expect(kpis.map(kpi => kpi.props['data-emphasis'])).toEqual(['true', 'false', 'false', 'false'])
    expect(kpis.map(kpi => kpi.findByProps({ className: 'devlead-board-kpi-icon' }).props['aria-hidden'])).toEqual(['true', 'true', 'true', 'true'])
    expect(kpis[1]?.findByType('dd').props['aria-label']).toBe('进行中：1 个项目')
  })

  it('renders all-zero KPIs with neutral emphasis and accurate accessible counts', async () => {
    const renderer = await mount(view({ ...READY, board: { ...BOARD, projects: [] } }))
    const kpis = renderer.root.findAll(instance => instance.props['data-devlead-board-kpi'] !== undefined)
    expect(kpis.map(kpi => kpi.props['data-devlead-board-kpi'])).toEqual(['blocked', 'active', 'paused', 'done'])
    expect(kpis.map(kpi => textOf(kpi.findByType('dd')))).toEqual(['0', '0', '0', '0'])
    expect(kpis.map(kpi => kpi.props['data-empty'])).toEqual(['true', 'true', 'true', 'true'])
    expect(kpis.map(kpi => kpi.props['data-emphasis'])).toEqual(['false', 'false', 'false', 'false'])
    expect(kpis.map(kpi => kpi.findByType('dd').props['aria-label'])).toEqual([
      '已阻塞：0 个项目',
      '进行中：0 个项目',
      '已暂停：0 个项目',
      '已完成：0 个项目',
    ])
    expect(renderer.root.findAllByProps({ className: 'devlead-board-blocked-notice' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-board-group': 'blocked' })).toHaveLength(0)
    expect(renderer.root.findAll(instance => instance.props['data-board-group'] !== undefined)).toHaveLength(0)
  })

  it('counts only status=blocked as blocked, even when another status has blockers', async () => {
    const activeWithBlockers = {
      ...project('active-blockers', 'active'),
      blockers: [{ id: 'risk', text: 'A risk that has not blocked the project', since: ISO }],
    }
    const renderer = await mount(view({
      ...READY,
      board: { ...BOARD, revision: 43, projects: [activeWithBlockers] },
    }))
    const blockedKpi = renderer.root.findByProps({ 'data-devlead-board-kpi': 'blocked' })
    expect(textOf(blockedKpi.findByType('dd'))).toBe('0')
    expect(blockedKpi.props['data-empty']).toBe('true')
    expect(blockedKpi.props['data-emphasis']).toBe('false')
    expect(renderer.root.findAllByProps({ className: 'devlead-board-blocked-notice' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-board-group': 'blocked' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-devlead-board-project': 'active-blockers' }).props['data-status']).toBe('active')
  })

  it('keeps card status semantics independent from priority', async () => {
    const renderer = await mount(view({
      ...READY,
      board: {
        ...BOARD,
        projects: [project('active-high', 'active', 'high'), project('active-low', 'active', 'low'), project('blocked-high', 'blocked', 'high')],
      },
    }))
    for (const id of ['active-high', 'active-low']) {
      const card = renderer.root.findByProps({ 'data-devlead-board-project': id })
      expect(card.props['data-status']).toBe('active')
      expect(card.props.style).toBeUndefined()
    }
    expect(renderer.root.findByProps({ 'data-devlead-board-project': 'active-high' }).props['data-priority']).toBe('high')
    expect(renderer.root.findByProps({ 'data-devlead-board-project': 'active-low' }).props['data-priority']).toBe('low')
    expect(renderer.root.findByProps({ 'data-devlead-board-kpi': 'blocked' }).props['data-emphasis']).toBe('true')
  })

  it('exposes native task progress with explicit values and accessible copy', async () => {
    const renderer = await mount(view(READY))
    const progress = renderer.root.findByProps({ 'data-devlead-board-progress': 'blocked' })
    expect(progress.type).toBe('progress')
    expect(progress.props.value).toBe(1)
    expect(progress.props.max).toBe(2)
    expect(progress.props['aria-label']).toBe('任务进度：2 项中已完成 1 项')
    expect(progress.props['aria-valuetext']).toBe(progress.props['aria-label'])
    const card = renderer.root.findByProps({ 'data-devlead-board-project': 'blocked' })
    const tasks = card.findByProps({ 'data-devlead-board-tasks': 'blocked' })
    expect(tasks.type).toBe('details')
    expect(textOf(tasks.findByType('summary'))).toContain('1/2')
    expect(card.findAllByProps({ className: 'devlead-board-progress-heading' })).toHaveLength(0)
  })

  it('collapses paused, done, and unlisted into native secondary disclosures', async () => {
    const renderer = await mount(view(READY))
    for (const status of ['paused', 'done']) {
      const group = renderer.root.findByProps({ 'data-board-group': status })
      expect(group.type).toBe('details')
      expect(group.props.open).not.toBe(true)
      expect(group.props.className).toContain('devlead-board-secondary')
      expect(group.findAllByType('summary').length).toBeGreaterThan(0)
    }
    for (const status of ['blocked', 'active']) {
      expect(renderer.root.findByProps({ 'data-board-group': status }).type).toBe('section')
    }
    const unlisted = renderer.root.findByProps({ 'data-devlead-board-unlisted': 'true' })
    expect(unlisted.type).toBe('details')
    expect(unlisted.props.open).not.toBe(true)
  })

  it('renders a valid empty project list separately from a missing file', async () => {
    const renderer = await mount(view({ ...READY, board: { ...BOARD, projects: [] } }))
    expect(textOf(renderer.root.findByProps({ 'data-devlead-board-empty': 'projects' })))
      .toContain(zh['board.emptyProjects.title'])
    expect(renderer.root.findAllByProps({ 'data-devlead-board-empty': 'file' })).toHaveLength(0)
  })

  it('renders real unlisted workspaces, session counts, activity, and no-activity rows', async () => {
    const renderer = await mount(view(READY, {
      unlisted: [
        {
          workspaceId: 'w-recent', path: '/work/recent', title: 'Recent', sessionIds: ['s1', 's2'],
          sessionCount: 2, lastActivityAt: ISO,
        },
        { workspaceId: 'w-idle', path: '/work/idle', title: 'Idle', sessionIds: [], sessionCount: 0 },
      ],
    }))
    const recent = renderer.root.findByProps({ 'data-devlead-board-unlisted-project': 'w-recent' })
    expect(textOf(recent)).toContain('Recent')
    expect(textOf(recent)).toContain('2 个会话')
    expect(textOf(recent)).toContain('2 分钟前')
    const idle = renderer.root.findByProps({ 'data-devlead-board-unlisted-project': 'w-idle' })
    expect(textOf(idle)).toContain('暂无会话活动')
  })

  it('does not claim no activity while the Session catalog is still pending', async () => {
    const renderer = await mount(view(READY, {
      sessionPhase: 'pending',
      unlisted: [{
        workspaceId: 'w-recent', path: '/work/recent', title: 'Recent', sessionIds: ['s1'], sessionCount: 1,
      }],
    }))
    const row = renderer.root.findByProps({ 'data-devlead-board-unlisted-project': 'w-recent' })
    expect(textOf(row)).toContain(zh['board.unlisted.activityPending'])
    expect(textOf(row)).not.toContain(zh['board.unlisted.noActivity'])
  })

  it('keeps workspace pending/error states honest and supports English copy', async () => {
    const pending = await mount(view(READY, { workspacePhase: 'pending' }))
    expect(textOf(pending.root)).toContain(zh['board.unlisted.pending'])
    const failed = await mount(view(READY, { workspaceError: true }))
    expect(textOf(failed.root)).toContain(zh['board.unlisted.error'])
    const english = await mount(view(READY, { t: translate(en) as DevLeadBoardPanelViewProps['t'] }))
    expect(english.root.findByProps({ 'data-devlead-board': 'true' }).props['aria-label']).toBe('Project board')
    expect(visibleTextOf(english.root.findByProps({ className: 'devlead-board-header' }))).not.toContain('Project board')
    expect(visibleTextOf(english.root.findByProps({ className: 'devlead-board-header' }))).not.toContain('Read-only')
    expect(english.root.findByProps({ 'data-devlead-board-priority': 'high' }).props['aria-label']).toBe('High priority')
    expect(english.root.findByProps({ 'data-devlead-board-tasks': 'blocked' }).findByType('summary').props['aria-label'])
      .toBe('View task details (1/2 done)')
    expect(textOf(english.root)).toContain('Auto refresh on')
  })

  it('reports a workspace-list failure ahead of pending and unavailable hints', async () => {
    const errored = await mount(view(READY, { workspacePhase: 'pending', workspaceError: true }))
    const erroredUnlisted = errored.root.findByProps({ 'data-devlead-board-unlisted': 'true' })
    expect(textOf(erroredUnlisted.findByProps({ role: 'alert' }))).toBe(zh['board.unlisted.error'])
    expect(textOf(erroredUnlisted)).not.toContain(zh['board.unlisted.pending'])
    expect(textOf(erroredUnlisted)).not.toContain(zh['board.unlisted.empty'])
    // A missing board file still wins: no workspace list is claimable yet.
    const unavailable = await mount(view({ status: 'loading', refreshing: true }, { workspaceError: true }))
    const unavailableUnlisted = unavailable.root.findByProps({ 'data-devlead-board-unlisted': 'true' })
    expect(textOf(unavailableUnlisted)).toContain(zh['board.unlisted.unavailable'])
    expect(unavailableUnlisted.findAllByProps({ role: 'alert' })).toHaveLength(0)
  })

  it('renders hostile board text literally without mounting markup or event handlers', async () => {
    const imageMarkup = '<img src=x onerror="alert(1)">'
    const scriptMarkup = '<script>alert(1)</script>'
    const loaderMarkup = '<img src=x onload="alert(2)">'
    const hostile: DevLeadBoard = {
      ...BOARD,
      projects: [{
        ...project('hostile', 'blocked'),
        workspace: { path: '/work/hostile', title: `Title ${imageMarkup}` },
        goal: `Goal ${scriptMarkup}`,
        focus: `Focus ${loaderMarkup}`,
        next: `Next ${scriptMarkup}`,
        blockers: [{ id: 'b1', text: `Blocker ${imageMarkup}`, since: ISO }],
        tasks: [{ id: 't1', title: `Task ${scriptMarkup}`, status: 'doing', updatedAt: ISO }],
      }],
    }
    const renderer = await mount(view({ ...READY, board: hostile }))
    const rendered = textOf(renderer.root)
    for (const markup of [imageMarkup, scriptMarkup, loaderMarkup]) {
      expect(rendered).toContain(markup)
    }
    expect(renderer.root.findAllByType('img')).toHaveLength(0)
    expect(renderer.root.findAllByType('script')).toHaveLength(0)
    const rawMarkupProps = renderer.root.findAll(instance =>
      Object.hasOwn(instance.props, 'onerror')
      || Object.hasOwn(instance.props, 'onload')
      || Object.hasOwn(instance.props, 'dangerouslySetInnerHTML'))
    expect(rawMarkupProps).toHaveLength(0)
  })

  it('pins refresh, live status, error, disclosure, and read-only accessibility semantics', async () => {
    const renderer = await mount(view(READY))
    const refresh = renderer.root.findByType('button')
    expect(refresh.props['aria-label']).toBe(zh['board.refresh.action'])
    expect(refresh.props['aria-busy']).toBe(false)
    const busy = await mount(view({ status: 'loading', refreshing: true }))
    expect(busy.root.findByType('button').props['aria-busy']).toBe(true)
    const live = renderer.root.findByProps({ role: 'status', 'aria-live': 'polite' })
    expect(textOf(live)).toContain(zh['board.autoRefresh.active'])
    expect(live.props['aria-atomic']).toBe('true')
    expect(renderer.root.findByProps({ className: 'devlead-board-blocked-notice' }).props.role).toBe('status')
    const groups = renderer.root.findAll(instance => instance.props['data-board-group'] !== undefined)
    expect(groups).toHaveLength(4)
    for (const group of groups) {
      const headingId = String(group.props['aria-labelledby'])
      const heading = renderer.root.findByProps({ id: headingId })
      expect(heading.type).toBe('h4')
      expect(group.findAllByType('h4')).toHaveLength(1)
      expect(group.findByType('h4').props.id).toBe(headingId)
    }
    // Native task and unlisted disclosures keep their details/summary pairing.
    const disclosures = renderer.root.findAllByType('details')
    expect(disclosures.length).toBeGreaterThanOrEqual(5)
    expect(renderer.root.findAllByType('summary')).toHaveLength(disclosures.length)
    expect(disclosures.some(disclosure => disclosure.props.className === 'devlead-board-tasks')).toBe(true)
    expect(disclosures.some(disclosure => disclosure.props['data-devlead-board-unlisted'] === 'true')).toBe(true)
    // Read-only: no editable control, and every button is a refresh action.
    for (const control of ['input', 'textarea', 'select'] as const) {
      expect(renderer.root.findAllByType(control)).toHaveLength(0)
    }
    expect(renderer.root.findAll(instance => instance.props.contentEditable !== undefined)).toHaveLength(0)
    const buttons = renderer.root.findAllByType('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.props['aria-label']).toBe(zh['board.refresh.action'])
    // Both parse and read failures expose an assertive alert block.
    const parseFailure = await mount(view({ status: 'error', error: { kind: 'parse', message: 'Unexpected token' }, refreshing: false }))
    expect(parseFailure.root.findByProps({ 'data-devlead-board-error': 'parse' }).props.role).toBe('alert')
    const readFailure = await mount(view({ status: 'error', error: { kind: 'read', message: 'ENOENT' }, refreshing: false }))
    expect(readFailure.root.findByProps({ 'data-devlead-board-error': 'read' }).props.role).toBe('alert')
  })

  it('scopes generated group heading ids to each mounted panel', async () => {
    const first = await mount(view(READY))
    const second = await mount(view(READY))
    const groupIds = (renderer: ReactTestRenderer): string[] =>
      renderer.root.findAll(instance => instance.props['data-board-group'] !== undefined)
        .map(group => String(group.props['aria-labelledby']))
    const firstIds = groupIds(first)
    const secondIds = groupIds(second)
    expect(firstIds).toHaveLength(4)
    expect(secondIds).toHaveLength(4)
    expect(new Set(firstIds).size).toBe(firstIds.length)
    expect(new Set(secondIds).size).toBe(secondIds.length)
    // The same four statuses pair up across views, but no heading id overlaps.
    expect(firstIds.filter(id => secondIds.includes(id))).toHaveLength(0)
    expect(new Set([...firstIds, ...secondIds]).size).toBe(8)
    for (const [renderer, ids] of [[first, firstIds], [second, secondIds]] as const) {
      for (const id of ids) {
        expect(renderer.root.findByProps({ id }).type).toBe('h4')
      }
    }
  })

  it('shows a compact notes count/latest chip and opens the immersive reader', async () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const onSelect = vi.fn()
    const notes = notesView({ onOpen, onClose, onSelect })
    const board = await mount(view(READY, { notes }))
    const chip = board.root.findByProps({ 'data-devlead-notes-chip': 'active' })
    expect(textOf(chip)).toContain('2')
    expect(textOf(chip)).toContain('Latest note')
    expect(chip.props['aria-label']).toContain('Latest note')
    chip.props.onClick({ stopPropagation: () => {} })
    expect(onOpen).toHaveBeenCalledWith('active')

    const reader = await mount(view(READY, { notes: notesView({ ...notes, selection: { projectId: 'active', noteId: 'n2' } }) }))
    expect(reader.root.findByProps({ 'data-devlead-notes-reader': 'active' })).toBeDefined()
    expect(reader.root.findAllByProps({ 'data-board-group': 'active' })).toHaveLength(0)
    expect(textOf(reader.root.findByProps({ 'data-devlead-note-document': 'n2' }))).toContain('Safe title')
    expect(reader.root.findAllByType('h1')).toHaveLength(1)
    reader.root.findByProps({ 'data-devlead-note': 'n1' }).props.onClick()
    expect(onSelect).toHaveBeenCalledWith('n1')
    reader.root.findByProps({ className: 'devlead-notes-back' }).props.onClick()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses live stat time only for the selected ready document, never list order or chips', async () => {
    const liveObservedAt = '2026-11-24T08:00:00.000Z'
    const notes = notesView({
      selection: { projectId: 'active', noteId: 'n1' },
      note: {
        ...notesView().note,
        value: { markdown: '# Older note body' },
        valuePath: `${NOTES_PATHS.root}/active-dir/n1.md`,
        observedAt: liveObservedAt,
        observedBytes: 17,
      },
    })
    const reader = await mount(view(READY, { notes }))
    const document = reader.root.findByProps({ 'data-devlead-note-document': 'n1' })
    expect(document.findByType('header').findByType('time').props.dateTime).toBe(liveObservedAt)
    // The selected row still exposes the stale index timestamp, as do its siblings.
    expect(reader.root.findByProps({ 'data-devlead-note': 'n1' }).findByType('time').props.dateTime)
      .toBe('2026-11-23T06:00:00.000Z')
    expect(reader.root.findByProps({ 'data-devlead-note': 'n2' }).findByType('time').props.dateTime).toBe(ISO)
    const rows = reader.root.findAll(instance => instance.props['data-devlead-note'] !== undefined)
    expect(rows.map(row => row.props['data-devlead-note'])).toEqual(['n2', 'n1'])

    const board = await mount(view(READY, { notes: notesView({ note: notes.note }) }))
    const chip = board.root.findByProps({ 'data-devlead-notes-chip': 'active' })
    expect(textOf(chip)).toContain('Latest note')
    expect(textOf(chip)).not.toContain('Older note')
  })

  it('degrades empty, bad-index, missing-note, and bad-note states without harming the board', async () => {
    const emptyIndex = { ...NOTES_INDEX, projects: [] }
    const empty = await mount(view(READY, { notes: notesView({
      index: { ...notesView().index, value: emptyIndex },
      selection: { projectId: 'active', noteId: 'n2' },
    }) }))
    expect(empty.root.findByProps({ 'data-devlead-notes-state': 'empty' })).toBeDefined()
    expect(empty.root.findAllByProps({ 'data-devlead-notes-chip': 'active' })).toHaveLength(0)

    const badIndex = await mount(view(READY, { notes: notesView({
      index: { ...notesView().index, status: 'error', error: { kind: 'parse', message: 'bad index' } },
    }) }))
    expect(badIndex.root.findByProps({ 'data-devlead-board-project': 'active' })).toBeDefined()
    expect(textOf(badIndex.root)).toContain(zh['board.notes.unavailable'])

    const missing = await mount(view(READY, { notes: notesView({
      selection: { projectId: 'active', noteId: 'n2' },
      note: { ...notesView().note, status: 'empty' },
    }) }))
    expect(missing.root.findByProps({ 'data-devlead-notes-state': 'note-empty' })).toBeDefined()

    const badNote = await mount(view(READY, { notes: notesView({
      selection: { projectId: 'active', noteId: 'n2' },
      note: { ...notesView().note, status: 'error', error: { kind: 'parse', message: 'bad UTF-8' } },
    }) }))
    expect(badNote.root.findByProps({ 'data-devlead-notes-state': 'error' }).props.role).toBe('alert')
    expect(badNote.root.findByProps({ 'data-devlead-notes-reader': 'active' })).toBeDefined()
  })
})

/**
 * Minimal change-stream stand-in for the live panel body: frames are optional,
 * disposal is observable, and aborting the request ends iteration.
 */
class PanelStream implements DevLeadBoardChangeStream {
  disposed = false
  private ended = false
  private wake: (() => void) | undefined
  private readonly frames: WorkspaceFileWatchFrame[] = []

  dispose = (): void => {
    this.disposed = true
    this.ended = true
    this.wake?.()
  }

  push(frame: WorkspaceFileWatchFrame): void {
    this.frames.push(frame)
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WorkspaceFileWatchFrame> {
    while (!this.ended) {
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

/** Fake Workspace Files seat plus the calls it observed. */
interface PanelFilesHarness {
  readonly files: DevLeadBoardFiles
  readonly stat: ReturnType<typeof vi.fn>
  readonly readBytes: ReturnType<typeof vi.fn>
  readonly changes: ReturnType<typeof vi.fn>
  readonly streams: PanelStream[]
}

function panelFiles(currentBoard: () => DevLeadBoard = () => BOARD): PanelFilesHarness {
  const streams: PanelStream[] = []
  const encoded = (): Uint8Array => new TextEncoder().encode(JSON.stringify(currentBoard()))
  const stat = vi.fn(async (_sessionId: string, path: string) => ({
    ok: true as const,
    value: { absolutePath: path, version: 'v1', bytes: encoded().byteLength },
  }))
  const readBytes = vi.fn(async (_sessionId: string, path: string) => {
    const data = encoded()
    return {
      ok: true as const,
      value: { absolutePath: path, version: 'v1', bytes: data.byteLength, offset: 0, data, eof: true },
    }
  })
  const changes = vi.fn((_sessionId: string, _path: string, signal?: AbortSignal) => {
    const stream = new PanelStream()
    signal?.addEventListener('abort', () => { stream.dispose() }, { once: true })
    streams.push(stream)
    return stream
  })
  return {
    files: { stat, readBytes, changes } as unknown as DevLeadBoardFiles,
    stat,
    readBytes,
    changes,
    streams,
  }
}

/** Fake Workspace catalog snapshot; the panel only reads its three top fields. */
const WORKSPACES = { items: [], phase: 'ready', state: 'ready' } as unknown as WorkspaceSnapshot

/** Props of the live board body for one Session-list snapshot. */
function panelProps(rows: GateRows, files: DevLeadBoardFiles): DevLeadBoardPanelProps {
  return {
    sessionId: 'session-1',
    files,
    t,
    useSessions: (selector: (state: SessionListState) => unknown) =>
      selector({ byId: rows } as unknown as SessionListState),
    useWorkspaces: (selector: (snapshot: WorkspaceSnapshot) => unknown) => selector(WORKSPACES),
    useTabInfo: () => ({ tab: { visible: true } }),
  } as unknown as DevLeadBoardPanelProps
}

/** Flush the hook's sequenced Remote reads and React state updates. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

describe('DevLeadBoardPanel wiring', () => {
  it('reads the default board path derived from the tab Session root', async () => {
    const harness = panelFiles()
    const renderer = await mount(<DevLeadBoardPanel {...panelProps({ 'session-1': LEAD_ROW }, harness.files)} />)
    await flush()
    expect(harness.stat).toHaveBeenCalledWith(
      'session-1', '/work/project/.dsh/devlead/board.json', expect.any(AbortSignal),
    )
    expect(harness.readBytes).toHaveBeenCalledWith(
      'session-1', '/work/project/.dsh/devlead/board.json', {}, expect.any(AbortSignal),
    )
    expect(renderer.root.findByProps({ 'data-devlead-board': 'true' })).toBeDefined()
  })

  it('never reads a board for a tab Session that is not an eligible lead', async () => {
    for (const rows of [
      { 'session-1': { cwd: '/work/project', projectionValues: { devLeadMode: { enabled: false } } } },
      { 'session-1': { cwd: '/work/project', origin: 'subagent' as const, projectionValues: { devLeadMode: { enabled: true } } } },
      { 'session-1': { cwd: '/work/project' } },
      {},
    ] as GateRows[]) {
      const harness = panelFiles()
      const renderer = await mount(<DevLeadBoardPanel {...panelProps(rows, harness.files)} />)
      await flush()
      expect(harness.stat).not.toHaveBeenCalled()
      expect(harness.changes).not.toHaveBeenCalled()
      expect(renderer.toJSON()).toBeNull()
    }
  })

  it('re-reads the new file when the tab Session root changes', async () => {
    const harness = panelFiles()
    const first = panelProps({ 'session-1': { ...LEAD_ROW, cwd: '/work/a' } }, harness.files)
    const renderer = await mount(<DevLeadBoardPanel {...first} />)
    await flush()
    expect(harness.stat).toHaveBeenCalledWith(
      'session-1', '/work/a/.dsh/devlead/board.json', expect.any(AbortSignal),
    )
    expect(harness.streams.length).toBeGreaterThan(0)
    const staleStream = harness.streams[0]
    await act(async () => {
      renderer.update(<DevLeadBoardPanel {...panelProps({ 'session-1': { ...LEAD_ROW, cwd: '/work/b' } }, harness.files)} />)
    })
    await flush()
    expect(harness.stat.mock.calls.map((call: unknown[]) => call[1]).filter(path => String(path).endsWith('/board.json'))).toEqual([
      '/work/a/.dsh/devlead/board.json',
      '/work/b/.dsh/devlead/board.json',
    ])
    // The previous watch is torn down, so the new root is the only file read.
    expect(staleStream?.disposed).toBe(true)
    expect(harness.streams.length).toBeGreaterThan(1)
  })

  it('updates blocked KPI, banner, group, and revision together after automatic polling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    let current: DevLeadBoard = { ...BOARD, revision: 42, projects: [project('active', 'active')] }
    const harness = panelFiles(() => current)
    const renderer = await mount(<DevLeadBoardPanel {...panelProps({ 'session-1': LEAD_ROW }, harness.files)} />)
    await flush()
    expect(textOf(renderer.root.findByProps({ 'data-devlead-board-kpi': 'blocked' }).findByType('dd'))).toBe('0')
    expect(renderer.root.findAllByProps({ 'data-board-group': 'blocked' })).toHaveLength(0)

    current = {
      ...current,
      revision: 43,
      projects: [project('active', 'active'), project('blocked-now', 'blocked'), project('paused', 'paused')],
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    await flush()
    const blockedKpi = renderer.root.findByProps({ 'data-devlead-board-kpi': 'blocked' })
    expect(textOf(blockedKpi.findByType('dd'))).toBe('1')
    expect(blockedKpi.props['data-emphasis']).toBe('true')
    expect(renderer.root.findByProps({ 'data-board-group': 'blocked' }).findAllByProps({ 'data-devlead-board-project': 'blocked-now' })).toHaveLength(1)
    expect(textOf(renderer.root.findByProps({ className: 'devlead-board-blocked-notice' }))).toContain('1 个项目已阻塞')
    expect(textOf(renderer.root.findByProps({ className: 'devlead-board-revision' }))).toBe('r43')
  })

  it('recovers blocked KPI and cards after a never-settling automatic stat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    let current: DevLeadBoard = { ...BOARD, revision: 42, projects: [project('project', 'active')] }
    const harness = panelFiles(() => current)
    let hangBoardStat = false
    harness.stat.mockImplementation(async (_sessionId: string, path: string) => {
      if (hangBoardStat && path.endsWith('/board.json')) {
        hangBoardStat = false
        return await new Promise(() => {})
      }
      const data = new TextEncoder().encode(JSON.stringify(current))
      return { ok: true as const, value: { absolutePath: path, version: 'v1', bytes: data.byteLength } }
    })
    const renderer = await mount(<DevLeadBoardPanel {...panelProps({ 'session-1': LEAD_ROW }, harness.files)} />)
    await flush()
    expect(textOf(renderer.root.findByProps({ 'data-devlead-board-kpi': 'blocked' }).findByType('dd'))).toBe('0')

    hangBoardStat = true
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    await flush()
    current = { ...current, revision: 43, projects: [project('project', 'blocked')] }
    await act(async () => {
      harness.streams[0]?.push({ kind: 'change', change: { absolutePath: '/work/project/.dsh/devlead/board.json', version: 'v43' } })
      await vi.advanceTimersByTimeAsync(30_000)
    })
    await flush()
    const card = renderer.root.findByProps({ 'data-devlead-board-project': 'project' })
    expect(card.props['data-status']).toBe('blocked')
    expect(textOf(renderer.root.findByProps({ 'data-devlead-board-kpi': 'blocked' }).findByType('dd'))).toBe('1')
    expect(textOf(renderer.root.findByProps({ className: 'devlead-board-revision' }))).toBe('r43')
    expect(renderer.root.findByProps({ className: 'devlead-board-blocked-notice' })).toBeDefined()
  })

  it('stops reading and renders nothing when the tab Session leaves DevLead mode', async () => {
    const harness = panelFiles()
    const renderer = await mount(<DevLeadBoardPanel {...panelProps({ 'session-1': LEAD_ROW }, harness.files)} />)
    await flush()
    const callsWhileEnabled = harness.stat.mock.calls.length
    expect(callsWhileEnabled).toBeGreaterThan(0)
    const staleStream = harness.streams[0]
    await act(async () => {
      renderer.update(<DevLeadBoardPanel {...panelProps({
        'session-1': { cwd: '/work/project', projectionValues: { devLeadMode: { enabled: false } } },
      }, harness.files)} />)
    })
    await flush()
    expect(harness.stat.mock.calls.length).toBe(callsWhileEnabled)
    expect(staleStream?.disposed).toBe(true)
    expect(renderer.toJSON()).toBeNull()
  })

  it('derives notes paths and automatically refreshes both index metadata and the open note', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const indexPath = '/work/project/.dsh/devlead/notes/index.json'
    const notePath = '/work/project/.dsh/devlead/notes/active-dir/n2.md'
    let index: DevLeadNotesIndex = {
      ...NOTES_INDEX,
      projects: [{
        ...NOTES_INDEX.projects[0]!,
        notes: [NOTES_INDEX.projects[0]!.notes[0]!, { ...NOTES_INDEX.projects[0]!.notes[1]!, bytes: 1 }],
      }],
    }
    let markdown = '# First body'
    const encode = (value: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)) as Uint8Array<ArrayBuffer>
    const valueFor = (path: string): unknown => path.endsWith('/board.json') ? BOARD : path.endsWith('/notes/index.json') ? index : markdown
    const stat = vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const,
      value: { absolutePath: path, version: 'v1', bytes: encode(valueFor(path)).byteLength },
    }))
    const readBytes = vi.fn(async (_sessionId: string, path: string) => {
      const data = encode(valueFor(path))
      return { ok: true as const, value: { absolutePath: path, version: 'v1', bytes: data.byteLength, offset: 0, data, eof: true } }
    })
    const streams = new Map<string, PanelStream>()
    const changes = vi.fn((_sessionId: string, path: string, signal?: AbortSignal) => {
      const stream = new PanelStream()
      signal?.addEventListener('abort', () => { stream.dispose() }, { once: true })
      streams.set(path, stream)
      return stream
    })
    const files = { stat, readBytes, changes } as unknown as DevLeadBoardFiles
    const renderer = await mount(<DevLeadBoardPanel {...panelProps({ 'session-1': LEAD_ROW }, files)} />)
    await flush()
    expect(stat).toHaveBeenCalledWith('session-1', indexPath, expect.any(AbortSignal))
    expect(renderer.root.findByProps({ 'data-devlead-notes-chip': 'active' })).toBeDefined()
    await act(async () => {
      renderer.root.findByProps({ 'data-devlead-notes-chip': 'active' }).props.onClick({ stopPropagation: () => {} })
    })
    await flush()
    expect(readBytes).toHaveBeenCalledWith('session-1', notePath, {}, expect.any(AbortSignal))
    expect(textOf(renderer.root)).toContain('First body')
    const documentTime = () => renderer.root.findByProps({ 'data-devlead-note-document': 'n2' })
      .findByType('header').findByType('time')
    const initialObservedAt = new Date(Date.now()).toISOString()
    expect(documentTime().props.dateTime).toBe(initialObservedAt)

    const noteReadsBeforeMetadataPoll = readBytes.mock.calls.filter((call: unknown[]) => call[1] === notePath).length
    const noteWatchesBeforeMetadataPoll = changes.mock.calls.filter((call: unknown[]) => call[1] === notePath).length
    const noteStreamBeforeMetadataPoll = streams.get(notePath)
    index = {
      ...index,
      revision: 2,
      projects: [{ ...index.projects[0]!, notes: [{ ...index.projects[0]!.notes[1]!, title: 'Fresh title', bytes: 999 }, index.projects[0]!.notes[0]!] }],
    }
    await act(async () => {
      streams.get(indexPath)?.push({ kind: 'change', change: { absolutePath: indexPath, version: 'v2' } })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(120)
    })
    await flush()
    expect(textOf(renderer.root)).toContain('Fresh title')
    expect(readBytes.mock.calls.filter((call: unknown[]) => call[1] === notePath).length).toBe(noteReadsBeforeMetadataPoll)
    expect(changes.mock.calls.filter((call: unknown[]) => call[1] === notePath).length).toBe(noteWatchesBeforeMetadataPoll)
    expect(streams.get(notePath)).toBe(noteStreamBeforeMetadataPoll)
    expect(documentTime().props.dateTime).toBe(initialObservedAt)
    expect(renderer.root.findByProps({ 'data-devlead-note': 'n2' }).findByType('time').props.dateTime).toBe(ISO)

    markdown = '# Second body'
    vi.setSystemTime(NOW + 60_000)
    await act(async () => {
      streams.get(notePath)?.push({ kind: 'change', change: { absolutePath: notePath, version: 'v2' } })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(120)
    })
    await flush()
    expect(textOf(renderer.root.findByProps({ 'data-devlead-note-document': 'n2' }))).toContain('Second body')
    expect(textOf(renderer.root.findByProps({ 'data-devlead-note-document': 'n2' }))).not.toContain('First body')
    expect(documentTime().props.dateTime).toBe(new Date(Date.now()).toISOString())
    expect(documentTime().props.dateTime).not.toBe(initialObservedAt)
    expect(renderer.root.findByProps({ 'data-devlead-note': 'n2' }).findByType('time').props.dateTime).toBe(ISO)
    const watchedObservedAt = String(documentTime().props.dateTime)

    markdown = '# Polled body'
    vi.setSystemTime(NOW + 120_000)
    index = {
      ...index,
      revision: 3,
      projects: [{ ...index.projects[0]!, notes: [{ ...index.projects[0]!.notes[0]!, title: 'Polled title' }, index.projects[0]!.notes[1]!] }],
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    await flush()
    expect(textOf(renderer.root)).toContain('Polled title')
    expect(textOf(renderer.root.findByProps({ 'data-devlead-note-document': 'n2' }))).toContain('Polled body')
    expect(Date.parse(String(documentTime().props.dateTime))).toBeGreaterThan(Date.parse(watchedObservedAt))
    expect(renderer.root.findByProps({ 'data-devlead-note': 'n2' }).findByType('time').props.dateTime).toBe(ISO)

    // Switch workspace while the reader is open and hold the replacement reads.
    // Neither the old index metadata nor its open document may flash under the
    // new path, even before the new network requests settle.
    let releaseNextReads!: () => void
    const nextReads = new Promise<void>(resolve => { releaseNextReads = resolve })
    stat.mockImplementation(async (_sessionId: string, path: string) => {
      if (path.startsWith('/work/next/')) await nextReads
      const data = encode(valueFor(path))
      return { ok: true as const, value: { absolutePath: path, version: 'v1', bytes: data.byteLength } }
    })
    const oldNoteReads = readBytes.mock.calls.filter((call: unknown[]) => call[1] === notePath).length
    act(() => {
      renderer.update(<DevLeadBoardPanel {...panelProps({
        'session-1': { ...LEAD_ROW, cwd: '/work/next' },
      }, files)} />)
    })
    expect(textOf(renderer.root)).not.toContain('Polled title')
    expect(textOf(renderer.root)).not.toContain('Polled body')
    expect(renderer.root.findAllByProps({ 'data-devlead-note-document': 'n2' })).toHaveLength(0)
    expect(readBytes.mock.calls.filter((call: unknown[]) => call[1] === notePath).length).toBe(oldNoteReads)
    await act(async () => { releaseNextReads() })
    await flush()
    expect(stat).toHaveBeenCalledWith('session-1', '/work/next/.dsh/devlead/notes/index.json', expect.any(AbortSignal))
    expect(textOf(renderer.root)).toContain('Polled title')
    expect(readBytes.mock.calls.filter((call: unknown[]) => call[1] === '/work/next/.dsh/devlead/notes/active-dir/n2.md')).toHaveLength(0)
  })
})
