/** Read-only board header button and right-Sidebar view rendering. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import {
  DevLeadBoardButton,
  DevLeadBoardTitle,
  type DevLeadBoardButtonProps,
  type DevLeadBoardTitleProps,
} from '../src/client/DevLeadBoardButton.tsx'
import {
  DevLeadBoardPanelView,
  type DevLeadBoardPanelViewProps,
} from '../src/client/DevLeadBoardPanel.tsx'
import type { DevLeadBoard, DevLeadBoardProject } from '../src/client/board.ts'
import { en, zh } from '../src/client/locales.ts'
import type { DevLeadBoardFileState } from '../src/client/useBoardFile.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Button = ({ children, ...rest }: { readonly children?: ReactNode } & Record<string, unknown>) => (
    <button {...rest}>{children}</button>
  )
  const Tooltip = ({ label, children }: { readonly label?: string; readonly children?: ReactNode }) => (
    <span data-mock-tooltip={label}>{children}</span>
  )
  const Pill = ({ children, className }: { readonly children?: ReactNode; readonly className?: string }) => (
    <span className={className} data-mock-pill="true">{children}</span>
  )
  const Tag = ({ children, tone }: { readonly children?: ReactNode; readonly tone?: string }) => (
    <span data-mock-tag={tone}>{children}</span>
  )
  const StateDot = ({ state }: { readonly state: string }) => <span data-mock-state-dot={state} aria-hidden="true" />
  const Icon = () => <span data-mock-icon="true" aria-hidden="true" />
  return {
    Button,
    Tooltip,
    Pill,
    Tag,
    StateDot,
    IconRefreshOutlineRegular: Icon,
    IconWarningOutlineRegular: Icon,
    IconFlatListOutlineRegular: Icon,
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

function view(state: DevLeadBoardFileState, overrides: Partial<DevLeadBoardPanelViewProps> = {}): ReactElement {
  return <DevLeadBoardPanelView state={state} onRefresh={() => {}} now={NOW} t={t} {...overrides} />
}

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  vi.restoreAllMocks()
})

describe('DevLeadBoardButton', () => {
  it('opens the board from an icon-only, localized header action', async () => {
    const onOpen = vi.fn()
    const renderer = await mount(<DevLeadBoardButton {...{ onOpen, t } as unknown as DevLeadBoardButtonProps} />)
    const button = renderer.root.findByType('button')
    expect(button.props['aria-label']).toBe(zh['board.open'])
    expect(button.props['data-devlead-board-open']).toBe('true')
    expect(renderer.root.findByProps({ 'data-mock-tooltip': zh['board.open'] })).toBeDefined()
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

  it('warns instead of claiming up-to-date content after live updates end', async () => {
    const renderer = await mount(view(READY, { watch: 'ended' }))
    expect(textOf(renderer.root)).toContain(zh['board.watch.ended'])
    expect(textOf(renderer.root)).not.toContain(zh['board.refresh.ready'])
    expect(renderer.root.findByProps({ 'data-mock-state-dot': 'warning' })).toBeDefined()
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
    const groups = renderer.root.findAllByProps({ className: 'devlead-board-group' })
    expect(groups.map(group => group.props['data-board-group'])).toEqual(['blocked', 'active', 'paused', 'done'])
    const card = renderer.root.findByProps({ 'data-devlead-board-project': 'blocked' })
    expect(textOf(card)).toContain('Project blocked')
    expect(textOf(card)).toContain('/work/blocked')
    expect(textOf(card)).toContain('Focus blocked')
    expect(textOf(card)).toContain('Next blocked')
    expect(textOf(card)).toContain('Waiting for review')
    expect(textOf(card)).toContain('高优先级')
    const tasks = renderer.root.findByProps({ 'data-devlead-board-tasks': 'blocked' })
    expect(tasks.type).toBe('details')
    expect(textOf(tasks)).toContain('任务 1/2 已完成')
    expect(textOf(tasks)).toContain('Verify panel')
    expect(textOf(tasks)).toContain('session-12…bcdef')
    // The only buttons in a healthy board are refresh controls, never writes.
    expect(renderer.root.findAllByType('button')).toHaveLength(1)
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
    expect(textOf(english.root)).toContain('Project board')
    expect(textOf(english.root)).toContain('Read-only')
    expect(textOf(english.root)).toContain('Tasks 1/2 done')
  })
})
