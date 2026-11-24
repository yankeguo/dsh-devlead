/**
 * Registration wiring of the browser half.
 *
 * The slot declarations live in the DSH shell; this test drives `apply()` with
 * a fake client context and pins what the plugin registers into them — the two
 * conversation surfaces, the sidebar Session-row mark and its hover-card
 * explanation, and the statically registered board header action plus the
 * lead-only dynamic board tab/guide/body/title group. The fake context models
 * the three observables the board manager follows (`sidebarRight.mounted`,
 * `sessions.list`, `sidebarRight.openTabs`) so mode-off and Session-switch
 * disposal can be asserted without a browser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The primitives package is a browser platform module whose own dependencies
// (e.g. `clsx`) are supplied by the DSH shell bundle, not by this workspace's
// node_modules; registration wiring only needs the component identities.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Placeholder = (): null => null
  const GaugeIcon = ({ size }: { readonly size?: number }) => createElement('span', {
    'data-mock-icon': 'gauge',
    'data-icon-size': size,
  })
  return {
    Button: Placeholder,
    Tooltip: Placeholder,
    IconGoalOutlineRegular: Placeholder,
    IconSparkleRegular: Placeholder,
    IconUsersOutlineRegular: Placeholder,
    IconFlatListOutlineRegular: Placeholder,
    IconGaugeOutlineRegular: GaugeIcon,
    IconRefreshOutlineRegular: Placeholder,
    IconWarningOutlineRegular: Placeholder,
    Pill: Placeholder,
    Tag: Placeholder,
    StateDot: Placeholder,
  }
})

import { apply, inject as clientInject } from '../src/client/index.tsx'

/** One recorded `slots.register` call; still active unless its disposer ran. */
interface RecordedRegistration {
  readonly name: string
  readonly id: string | undefined
  readonly key: string | undefined
  readonly order: number | undefined
  readonly locale: string | undefined
  readonly inject: unknown
  readonly component: unknown
}

/** One open right-Sidebar tab as the inventory observable reports it. */
interface FakeOpenTab {
  readonly sessionId: string
  readonly tabId: string
  readonly kind: string
  readonly contentId: string
}

/** Registered guide entry, including the icon component consumed by the shell. */
interface FakeGuideEntry {
  readonly id: string
  readonly order: number
  readonly title: () => string
  readonly description?: () => string
  readonly icon?: ComponentType<{ readonly size?: number; readonly className?: string }>
}

/**
 * Controlled stand-in for the shipped GuideBody EntryBox rendering contract.
 * DSH rc.1 and current master pass 26px with a description and 22px without;
 * the separate Session-header menu action owns the 18px gauge assertion.
 */
function ShellGuideEntry({ entry }: { readonly entry: FakeGuideEntry }) {
  const Icon = entry.icon
  if (Icon === undefined) throw new Error('guide entry has no icon')
  const description = entry.description?.()
  return createElement('button', { 'data-sidebar-right-guide-entry': 'devlead-board' },
    createElement(Icon, { size: description === undefined ? 22 : 26 }),
    createElement('span', null, entry.title()),
    description === undefined ? null : createElement('span', null, description))
}

/** Summary facts the board manager reads from one Session-list row. */
interface FakeSummary {
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly projectionValues?: {
    readonly devLeadMode?: { readonly enabled?: boolean }
  }
}

/** Read-only observable snapshot source, mirroring the shell store contract. */
interface FakeStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** One observable plus its test-side publisher. */
interface FakeStoreHandle<T> {
  readonly source: FakeStore<T>
  set(next: T): void
}

function fakeStore<T>(initial: T): FakeStoreHandle<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => value,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Everything the fake context recorded. */
interface FakeState {
  readonly effects: string[]
  /** Disposers returned by the recorded effects, newest last. */
  readonly effectDisposers: (() => void)[]
  readonly injects: string[]
  readonly registrations: RecordedRegistration[]
  readonly conditionalInjects: string[][]
  readonly tabDefinitions: Record<string, unknown>[]
  readonly openedTabs: string[]
  readonly closedTabs: string[]
  /** Slot names whose next `slots.inject` call throws, for rollback tests. */
  readonly failInjects: Set<string>
  readonly mounted: FakeStoreHandle<string | undefined>
  readonly rows: FakeStoreHandle<{ readonly byId: Record<string, FakeSummary> }>
  readonly inventory: FakeStoreHandle<readonly FakeOpenTab[]>
}

/** Fake client context plus the observables a test drives. */
interface Harness {
  readonly ctx: ClientContext
  readonly state: FakeState
  /** Publish the on-screen Session and notify subscribers. */
  mount(sessionId: string | undefined): void
  /** Publish the Session-list catalog and notify subscribers. */
  publishRows(rows: Record<string, FakeSummary>): void
  /** Publish the open-tab inventory and notify subscribers. */
  publishTabs(tabs: readonly FakeOpenTab[]): void
  /** Run every recorded effect's disposer, newest first. */
  disposeEffects(): void
}

/** Active-key collision check, like the real keyed/list slot registries. */
function assertNoDuplicateRegistration(
  active: readonly RecordedRegistration[],
  options: Omit<RecordedRegistration, 'component'>,
): void {
  const clash = active.some(entry => entry.name === options.name
    && (options.key === undefined ? entry.id === options.id : entry.key === options.key))
  if (clash) throw new Error(`slots: duplicate registration for ${options.name}`)
}

/**
 * Build a fake client root context that records effects, slot injections, and
 * registrations without starting a renderer.
 * @returns the fake context, its record, and the observable publishers.
 */
function fakeContext(): Harness {
  const state: FakeState = {
    effects: [],
    effectDisposers: [],
    injects: [],
    registrations: [],
    conditionalInjects: [],
    tabDefinitions: [],
    openedTabs: [],
    closedTabs: [],
    failInjects: new Set<string>(),
    mounted: fakeStore<string | undefined>(undefined),
    rows: fakeStore<{ readonly byId: Record<string, FakeSummary> }>({ byId: {} }),
    inventory: fakeStore<readonly FakeOpenTab[]>([]),
  }
  const register = (options: Omit<RecordedRegistration, 'component'>, component: unknown): (() => void) => {
    assertNoDuplicateRegistration(state.registrations, options)
    const entry: RecordedRegistration = { ...options, component }
    state.registrations.push(entry)
    return () => {
      const index = state.registrations.indexOf(entry)
      if (index >= 0) state.registrations.splice(index, 1)
    }
  }
  const ctx = {
    effect(effect: () => unknown, label?: string) {
      state.effects.push(label ?? '')
      const dispose = effect()
      const disposer = typeof dispose === 'function' ? () => { dispose() } : () => {}
      state.effectDisposers.push(disposer)
      return disposer
    },
    inject(services: string[], callback: () => void) {
      state.conditionalInjects.push(services)
      callback()
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
      provideRoot: () => () => {},
    },
    sessions: {
      list: state.rows.source,
    },
    sidebarRightTabs: {
      register(definition: Record<string, unknown>) {
        if (state.tabDefinitions.some(active => active.id === definition.id)) {
          throw new Error(`sidebarRight: tab type id "${String(definition.id)}" is already registered`)
        }
        state.tabDefinitions.push(definition)
        return () => {
          const index = state.tabDefinitions.indexOf(definition)
          if (index >= 0) state.tabDefinitions.splice(index, 1)
        }
      },
    },
    sidebarRight: {
      mounted: state.mounted.source,
      openTabs: state.inventory.source,
      openTab(kind: string) {
        state.openedTabs.push(kind)
      },
      close(tabId: string) {
        if (state.closedTabs.includes(tabId)) return
        state.closedTabs.push(tabId)
        // Model the shell: a closed tab leaves the inventory and notifies
        // subscribers, so a sweep cannot act on the same tab twice.
        state.inventory.set(state.inventory.source.getSnapshot().filter(tab => tab.tabId !== tabId))
      },
    },
    slots: {
      inject(name: string, callback: () => () => void) {
        state.injects.push(name)
        if (state.failInjects.delete(name)) throw new Error(`slots: declared slot ${name} is unavailable`)
        let dispose: (() => void) | undefined = callback()
        return () => {
          dispose?.()
          dispose = undefined
        }
      },
      register,
      provideRoot: () => () => {},
    },
    remote: {
      commands: { execute: () => Promise.resolve({ ok: true, value: undefined }) },
      workspaceFiles: {
        stat: () => Promise.resolve({ ok: true, value: {} }),
        readBytes: () => Promise.resolve({ ok: true, value: {} }),
        changes: () => ({ async *[Symbol.asyncIterator]() {}, dispose() {} }),
      },
    },
  } as unknown as ClientContext
  return {
    ctx,
    state,
    mount(sessionId) { state.mounted.set(sessionId) },
    publishRows(byId) { state.rows.set({ byId }) },
    publishTabs(tabs) { state.inventory.set(tabs) },
    disposeEffects() {
      for (const dispose of state.effectDisposers.splice(0).reverse()) dispose()
    },
  }
}

/** Summary of an eligible top-level lead Session with a derivable board root. */
const LEAD: FakeSummary = {
  cwd: '/work/project',
  projectionValues: { devLeadMode: { enabled: true } },
}
/** Summary of a normal Session with DevLead mode off. */
const IDLE: FakeSummary = {
  cwd: '/work/idle',
  projectionValues: { devLeadMode: { enabled: false } },
}
/** Summary of a subagent Session that carries a stale enabled mode. */
const SUBAGENT: FakeSummary = {
  cwd: '/work/subagent',
  origin: 'subagent',
  projectionValues: { devLeadMode: { enabled: true } },
}
/** Summary of an eligible lead whose workspace root is not known yet. */
const ROOTLESS_LEAD: FakeSummary = {
  projectionValues: { devLeadMode: { enabled: true } },
}

const TAB_ID = '@yankeguo/dsh-client-ui-devlead/board'

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__DSH_DEVLEAD_BOARD__')
})

describe('client apply', () => {
  it('registers the dictionaries, stylesheet, and board manager as effects', () => {
    const { ctx, state } = fakeContext()
    apply(ctx)
    expect(state.effects).toEqual(['devlead: dictionaries', 'devlead: styles', 'devlead: board surfaces'])
  })

  it('registers every static surface and the board header action', () => {
    const { ctx, state } = fakeContext()
    apply(ctx)
    expect(state.injects).toEqual([
      'conversation.input.left',
      'conversation.input.dock',
      'sidebar.session.row.trailing',
      'sidebar.session.row.leading',
      'sidebar.session.row.hover',
      'conversation.session.header.utilities',
    ])
    expect(state.registrations).toHaveLength(6)
    expect(state.registrations.map(entry => entry.name)).toEqual([
      'conversation.input.left',
      'conversation.input.dock',
      'sidebar.session.row.trailing',
      'sidebar.session.row.leading',
      'sidebar.session.row.hover',
      'conversation.session.header.utilities',
    ])
    // Only the toolbar toggle owns the command control; the status strip must
    // not receive the command face at all.
    const toggle = state.registrations.find(entry => entry.name === 'conversation.input.left')
    const bar = state.registrations.find(entry => entry.name === 'conversation.input.dock')
    expect(toggle?.inject).toBeTypeOf('function')
    expect(bar?.inject).toBeUndefined()
    // The header action stays registered for every Session; its component gates
    // the render on the row summary, and opening repairs the registration.
    const header = state.registrations.find(entry => entry.name === 'conversation.session.header.utilities')
    expect(header).toMatchObject({ id: 'devlead-board', order: -4, locale: 'devlead' })
    expect(header?.inject).toBeTypeOf('function')
    expect(state.conditionalInjects).toEqual([])
  })

  it('registers distinct visible, accessible-leading, and hover Session-row components', () => {
    const { ctx, state } = fakeContext()
    apply(ctx)
    const rowMark = state.registrations.find(entry => entry.name === 'sidebar.session.row.trailing')
    const leadingMark = state.registrations.find(entry => entry.name === 'sidebar.session.row.leading')
    const hoverMark = state.registrations.find(entry => entry.name === 'sidebar.session.row.hover')
    expect(rowMark).toMatchObject({ id: 'devlead', order: 20, locale: 'devlead' })
    expect(leadingMark).toMatchObject({ id: 'devlead-accessible', order: 20, locale: 'devlead' })
    expect(hoverMark).toMatchObject({ id: 'devlead', order: 20, locale: 'devlead' })
    // Each seat owns a distinct React component: the visible glyph cannot be
    // reused as the visually-hidden leading text or the hover explanation.
    expect(leadingMark?.component).not.toBe(rowMark?.component)
    expect(leadingMark?.component).not.toBe(hoverMark?.component)
    expect(rowMark?.component).not.toBe(hoverMark?.component)
  })

  it('registers no board tab, guide, body, or title without an eligible lead', () => {
    const { ctx, state } = fakeContext()
    apply(ctx)
    expect(state.tabDefinitions).toEqual([])
    expect(state.injects).not.toContain('sidebar.right.pane.tab')
    expect(state.injects).not.toContain('sidebar.right.pane.tab.title')
    // Regression anchor for the packaging contract: the board-only services
    // stay statically declared because the DSH client loader seeds the module
    // table from `dsh.client.inject` at boot. A page without a lead therefore
    // registers no board surfaces and performs no Remote I/O.
    expect(clientInject).toEqual([
      'slots',
      'sessions',
      'remote',
      'remote.commands',
      'remote.workspaceFiles',
      'locale',
      'sidebarRight',
      'sidebarRightTabs',
      'workspaces',
    ])
  })

  it('installs the board surfaces for the on-screen eligible lead from its cwd alone', () => {
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    // A cold page: rows and on-screen Session land after boot. No Host global
    // exists because the page was loaded before any lead existed; the default
    // path is still derivable from the Session summary's original root.
    publishRows({ 'session-lead': LEAD })
    expect(state.tabDefinitions).toEqual([])
    mount('session-lead')
    expect(state.tabDefinitions).toHaveLength(1)
    const definition = state.tabDefinitions[0] as {
      id: string
      kind: string
      title: () => string
      guide: readonly FakeGuideEntry[]
    }
    expect(definition.id).toBe(TAB_ID)
    expect(definition.kind).toBe('devlead-board')
    expect(definition.title()).toBe('board.title')
    expect(definition.guide).toHaveLength(1)
    expect(definition.guide[0]).toMatchObject({ id: 'open', order: 30 })
    expect(definition.guide[0]?.title()).toBe('board.title')
    expect(definition.guide[0]?.description?.()).toBe('board.guide')
    const body = state.registrations.find(entry => entry.name === 'sidebar.right.pane.tab')
    expect(body).toMatchObject({ key: TAB_ID, locale: 'devlead' })
    const title = state.registrations.find(entry => entry.name === 'sidebar.right.pane.tab.title')
    expect(title).toMatchObject({ key: TAB_ID, locale: 'devlead' })
    // The body's injected face carries the shared read-only Remote only; the
    // path is resolved live inside the component.
    const injected = (body?.inject as () => Record<string, unknown>)()
    expect(Object.keys(injected)).toEqual(['files'])
    expect(injected['files']).toBeTypeOf('object')
  })

  it('registers the gauge guide icon and renders it at the real described-card size', async () => {
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': LEAD })
    mount('session-lead')
    const definition = state.tabDefinitions[0] as { guide: readonly FakeGuideEntry[] }
    const entry = definition.guide[0]!
    // The named component and unique gauge output pin the registration without
    // adding a runtime DSH import to this linked-root packaging test.
    expect(entry.icon?.name).toBe('GaugeIcon')
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(ShellGuideEntry, { entry }))
    })
    if (renderer === undefined) throw new Error('no renderer')
    const guideRenderer = renderer
    const card = guideRenderer.root.findByProps({ 'data-sidebar-right-guide-entry': 'devlead-board' })
    expect(card.findByProps({ 'data-mock-icon': 'gauge' }).props['data-icon-size']).toBe(26)
    await act(async () => { guideRenderer.unmount() })
  })

  it('installs the board surfaces for a lead named by the Host global, with no workspace root', () => {
    Object.defineProperty(globalThis, '__DSH_DEVLEAD_BOARD__', {
      value: {
        boardPath: '/deploy/board.json',
        schemaVersion: 1,
        pathPlatform: 'posix',
        leadSessionId: 'session-lead',
        override: false,
      },
      configurable: true,
    })
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': ROOTLESS_LEAD })
    mount('session-lead')
    expect(state.tabDefinitions).toHaveLength(1)
  })

  it('derives for a lead the stale Host global does not name', () => {
    Object.defineProperty(globalThis, '__DSH_DEVLEAD_BOARD__', {
      value: {
        boardPath: '/stale/board.json',
        schemaVersion: 1,
        pathPlatform: 'posix',
        leadSessionId: 'session-previous',
        override: false,
      },
      configurable: true,
    })
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': LEAD })
    mount('session-lead')
    // Eligibility only needs a resolvable path; the stale global belongs to
    // another lead, so the surfaces exist from the derived default.
    expect(state.tabDefinitions).toHaveLength(1)
  })

  it('never registers a board surface for an idle or subagent Session', () => {
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({ 'session-idle': IDLE, 'session-subagent': SUBAGENT })
    mount('session-idle')
    expect(state.tabDefinitions).toEqual([])
    expect(state.injects).not.toContain('sidebar.right.pane.tab')
    mount('session-subagent')
    expect(state.tabDefinitions).toEqual([])
    expect(state.injects).not.toContain('sidebar.right.pane.tab')
  })

  it('registers once across repeated notifications and repeated opens', () => {
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': LEAD })
    mount('session-lead')
    const injectsAfterFirst = state.injects.length
    // The same eligible Session keeps publishing: no churn, no duplicate ids.
    publishRows({ 'session-lead': LEAD })
    publishRows({ 'session-lead': { ...LEAD, cwd: '/work/project' } })
    expect(state.tabDefinitions).toHaveLength(1)
    expect(state.injects).toHaveLength(injectsAfterFirst)
    const header = state.registrations.find(entry => entry.name === 'conversation.session.header.utilities')
    const inject = header?.inject as (sessionId: string) => { onOpen: () => void }
    inject('session-lead').onOpen()
    inject('session-lead').onOpen()
    expect(state.openedTabs).toEqual(['devlead-board', 'devlead-board'])
    expect(state.tabDefinitions).toHaveLength(1)
    expect(state.injects).toHaveLength(injectsAfterFirst)
  })

  it('does not open a board tab for a Session that is not an eligible lead', () => {
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({ 'session-idle': IDLE })
    mount('session-idle')
    const header = state.registrations.find(entry => entry.name === 'conversation.session.header.utilities')
    const inject = header?.inject as (sessionId: string) => { onOpen: () => void }
    inject('session-idle').onOpen()
    expect(state.openedTabs).toEqual([])
    expect(state.tabDefinitions).toEqual([])
  })

  it('switches between two eligible leads without re-registering', () => {
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({
      'session-a': { ...LEAD, cwd: '/work/a' },
      'session-b': { ...LEAD, cwd: '/work/b' },
    })
    mount('session-a')
    const injectsAfterFirst = state.injects.length
    mount('session-b')
    expect(state.tabDefinitions).toHaveLength(1)
    expect(state.injects).toHaveLength(injectsAfterFirst)
  })

  it('disposes on mode off and closes the on-screen Session’s lingering board tabs', () => {
    const { ctx, state, mount, publishRows, publishTabs } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': LEAD })
    mount('session-lead')
    expect(state.tabDefinitions).toHaveLength(1)
    publishTabs([
      { sessionId: 'session-lead', tabId: 'tab-board', kind: 'devlead-board', contentId: 'devlead-board' },
      { sessionId: 'session-other', tabId: 'tab-other-session', kind: 'devlead-board', contentId: 'devlead-board' },
      { sessionId: 'session-lead', tabId: 'tab-guide', kind: 'guide', contentId: 'sidebar://guide' },
    ])
    publishRows({ 'session-lead': { ...LEAD, projectionValues: { devLeadMode: { enabled: false } } } })
    expect(state.tabDefinitions).toEqual([])
    // The inject call history stays; the registrations themselves are gone.
    expect(state.registrations.some(entry => entry.name === 'sidebar.right.pane.tab')).toBe(false)
    expect(state.registrations.some(entry => entry.name === 'sidebar.right.pane.tab.title')).toBe(false)
    expect(state.registrations).toHaveLength(6)
    // Only the on-screen Session's own board tab is closed; another Session's
    // store is unreachable from `ctx.sidebarRight.close` and the guide stays.
    expect(state.closedTabs).toEqual(['tab-board'])
  })

  it('disposes on a switch to a non-lead Session and re-registers on return', () => {
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': LEAD, 'session-idle': IDLE })
    mount('session-lead')
    expect(state.tabDefinitions).toHaveLength(1)
    mount('session-idle')
    expect(state.tabDefinitions).toEqual([])
    expect(state.registrations).toHaveLength(6)
    mount('session-lead')
    expect(state.tabDefinitions).toHaveLength(1)
    expect(state.registrations.filter(entry => entry.name === 'sidebar.right.pane.tab')).toHaveLength(1)
  })

  it('rolls back a partially registered board group so a retry cannot double-register', () => {
    const { ctx, state, mount, publishRows } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': LEAD })
    // The third registration fails: the tab type and the keyed body were
    // already registered and must be disposed before the manager gives up.
    state.failInjects.add('sidebar.right.pane.tab.title')
    mount('session-lead')
    expect(state.tabDefinitions).toEqual([])
    expect(state.registrations.some(entry => entry.name === 'sidebar.right.pane.tab')).toBe(false)
    expect(state.registrations.some(entry => entry.name === 'sidebar.right.pane.tab.title')).toBe(false)
    // The next list notification retries from a clean slate and succeeds: a
    // leaked registration would throw "id is already registered" here.
    publishRows({ 'session-lead': LEAD })
    expect(state.tabDefinitions).toHaveLength(1)
    expect(state.registrations.filter(entry => entry.name === 'sidebar.right.pane.tab')).toHaveLength(1)
    expect(state.registrations.filter(entry => entry.name === 'sidebar.right.pane.tab.title')).toHaveLength(1)
  })

  it('disposes and does not close anything when the on-screen Session goes away', () => {
    const { ctx, state, mount, publishRows, publishTabs } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': LEAD })
    mount('session-lead')
    publishTabs([{ sessionId: 'session-lead', tabId: 'tab-board', kind: 'devlead-board', contentId: 'devlead-board' }])
    mount(undefined)
    expect(state.tabDefinitions).toEqual([])
    // Without an on-screen Session there is no close target to act on.
    expect(state.closedTabs).toEqual([])
  })

  it('closes a restored board tab on the initial sync when the on-screen Session is not a lead', () => {
    // Page restore: the inventory and the on-screen Session exist before this
    // plugin instance ever registered the board tab type, so the usual
    // dispose-time sweep has no surface group to trigger it. The initial sync
    // still closes the on-screen Session's board tab best-effort.
    const { ctx, state, mount, publishRows, publishTabs } = fakeContext()
    mount('session-idle')
    publishRows({ 'session-idle': IDLE })
    publishTabs([
      { sessionId: 'session-idle', tabId: 'tab-restored', kind: 'devlead-board', contentId: 'devlead-board' },
      { sessionId: 'session-other', tabId: 'tab-other-session', kind: 'devlead-board', contentId: 'devlead-board' },
    ])
    apply(ctx)
    expect(state.tabDefinitions).toEqual([])
    // Another Session's inventory entry is not reachable from this pane.
    expect(state.closedTabs).toEqual(['tab-restored'])
  })

  it('closes the on-screen board tab when the plugin is disposed', () => {
    const { ctx, state, mount, publishRows, publishTabs, disposeEffects } = fakeContext()
    apply(ctx)
    publishRows({ 'session-lead': LEAD })
    mount('session-lead')
    publishTabs([{ sessionId: 'session-lead', tabId: 'tab-board', kind: 'devlead-board', contentId: 'devlead-board' }])
    disposeEffects()
    expect(state.tabDefinitions).toEqual([])
    expect(state.registrations).toHaveLength(6)
    expect(state.closedTabs).toEqual(['tab-board'])
  })
})
