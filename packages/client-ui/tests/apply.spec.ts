/**
 * Registration wiring of the browser half.
 *
 * The slot declarations live in the DSH shell; this test drives `apply()` with
 * a fake client context and pins what the plugin registers into them — the two
 * conversation surfaces plus the sidebar Session-row mark and its hover-card
 * explanation, each with its own stable id, ordering, and locale seat. It
 * catches a renamed slot, a lost registration, or a component swapped between
 * seats without needing a browser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

// The primitives package is a browser platform module whose own dependencies
// (e.g. `clsx`) are supplied by the DSH shell bundle, not by this workspace's
// node_modules; registration wiring only needs the component identities.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Placeholder = (): null => null
  return {
    Button: Placeholder,
    Tooltip: Placeholder,
    IconGoalOutlineRegular: Placeholder,
    IconUsersOutlineRegular: Placeholder,
    IconFlatListOutlineRegular: Placeholder,
    IconRefreshOutlineRegular: Placeholder,
    IconWarningOutlineRegular: Placeholder,
    Pill: Placeholder,
    Tag: Placeholder,
    StateDot: Placeholder,
  }
})

import { apply, inject as clientInject } from '../src/client/index.tsx'

/** One recorded `slots.register` call. */
interface RecordedRegistration {
  readonly name: string
  readonly id: string | undefined
  readonly key: string | undefined
  readonly order: number | undefined
  readonly locale: string | undefined
  readonly inject: unknown
  readonly component: unknown
}

/** Minimal client context surface `apply()` touches during registration. */
interface FakeContext {
  readonly effects: string[]
  readonly injects: string[]
  readonly registrations: RecordedRegistration[]
  readonly conditionalInjects: string[][]
  readonly tabDefinitions: Record<string, unknown>[]
  readonly openTabs: string[]
}

/**
 * Build a fake client root context that records effects, slot injections, and
 * registrations without starting a renderer.
 * @returns the fake context and its record of the plugin's calls.
 */
function fakeContext(): { ctx: ClientContext; state: FakeContext } {
  const state: FakeContext = {
    effects: [],
    injects: [],
    registrations: [],
    conditionalInjects: [],
    tabDefinitions: [],
    openTabs: [],
  }
  const register = (options: Omit<RecordedRegistration, 'component'>, component: unknown): (() => void) => {
    state.registrations.push({ ...options, component })
    return () => {}
  }
  const ctx = {
    effect(effect: () => unknown, label?: string) {
      state.effects.push(label ?? '')
      const dispose = effect()
      return typeof dispose === 'function' ? dispose : () => {}
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
    sidebarRightTabs: {
      register(definition: Record<string, unknown>) {
        state.tabDefinitions.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTab(kind: string) {
        state.openTabs.push(kind)
      },
    },
    slots: {
      inject(name: string, callback: () => () => void) {
        state.injects.push(name)
        return callback()
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
  }
  return { ctx: ctx as unknown as ClientContext, state }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__DSH_DEVLEAD_BOARD__')
})

describe('client apply', () => {
  it('registers the dictionaries and the stylesheet as effects', () => {
    const { ctx, state } = fakeContext()
    apply(ctx)
    expect(state.effects).toEqual(['devlead: dictionaries', 'devlead: styles'])
  })

  it('registers both conversation surfaces', () => {
    const { ctx, state } = fakeContext()
    apply(ctx)
    expect(state.injects).toEqual([
      'conversation.input.left',
      'conversation.input.dock',
      'sidebar.session.row.trailing',
      'sidebar.session.row.hover',
    ])
    expect(state.registrations.filter(entry => entry.name.startsWith('conversation.input'))).toHaveLength(2)
    // Only the toolbar toggle owns the command control; the status strip must
    // not receive the command face at all.
    const toggle = state.registrations.find(entry => entry.name === 'conversation.input.left')
    const bar = state.registrations.find(entry => entry.name === 'conversation.input.dock')
    expect(toggle?.inject).toBeTypeOf('function')
    expect(bar?.inject).toBeUndefined()
  })

  it('registers the sidebar row mark and its hover-card explanation', () => {
    const { ctx, state } = fakeContext()
    apply(ctx)
    const rowMark = state.registrations.find(entry => entry.name === 'sidebar.session.row.trailing')
    const hoverMark = state.registrations.find(entry => entry.name === 'sidebar.session.row.hover')
    expect(rowMark).toMatchObject({ id: 'devlead', order: 20, locale: 'devlead' })
    expect(hoverMark).toMatchObject({ id: 'devlead', order: 20, locale: 'devlead' })
    // The row seats are different React components; the mark must not be
    // mounted into the hover-card section (it is inline-only there).
    expect(rowMark?.component).not.toBe(hoverMark?.component)
  })

  it('registers no board tab, body, title, or header button without the Host global', () => {
    const { ctx, state } = fakeContext()
    apply(ctx)
    expect(state.conditionalInjects).toEqual([])
    expect(state.tabDefinitions).toEqual([])
    expect(state.injects).not.toContain('sidebar.right.pane.tab')
    expect(state.injects).not.toContain('conversation.session.header.utilities')
    // Regression anchor for the packaging contract: the board-only services
    // stay statically declared because the DSH client loader seeds the module
    // table from `dsh.client.inject` at boot. A disabled board therefore
    // registers nothing and performs no Remote I/O; it does not hide its
    // service declarations, which every default web-app composition satisfies.
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
    expect(state.registrations).toHaveLength(4)
    expect(state.registrations.map(entry => entry.name)).toEqual([
      'conversation.input.left',
      'conversation.input.dock',
      'sidebar.session.row.trailing',
      'sidebar.session.row.hover',
    ])
    expect(state.effects).toEqual(['devlead: dictionaries', 'devlead: styles'])
  })

  it('registers the board type, keyed body, guide entry, and opening header action when configured', () => {
    Object.defineProperty(globalThis, '__DSH_DEVLEAD_BOARD__', {
      value: { boardPath: '/work/.dsh/devlead/board.json', schemaVersion: 1, pathPlatform: 'posix' },
      configurable: true,
    })
    const { ctx, state } = fakeContext()
    apply(ctx)
    // Same static declarations as the disabled case: the global only gates
    // registrations, never the service table.
    expect(clientInject).toEqual(expect.arrayContaining(['remote.workspaceFiles', 'sidebarRight', 'sidebarRightTabs', 'workspaces']))
    expect(state.conditionalInjects).toEqual([])
    expect(state.tabDefinitions).toHaveLength(1)
    expect(state.tabDefinitions[0]).toMatchObject({
      id: '@yankeguo/dsh-client-ui-devlead/board',
      kind: 'devlead-board',
    })
    const body = state.registrations.find(entry => entry.name === 'sidebar.right.pane.tab')
    expect(body).toMatchObject({ key: '@yankeguo/dsh-client-ui-devlead/board', locale: 'devlead' })
    const title = state.registrations.find(entry => entry.name === 'sidebar.right.pane.tab.title')
    expect(title).toMatchObject({ key: '@yankeguo/dsh-client-ui-devlead/board', locale: 'devlead' })
    const header = state.registrations.find(entry => entry.name === 'conversation.session.header.utilities')
    expect(header).toMatchObject({ id: 'devlead-board', order: -4, locale: 'devlead' })
    const injected = (header?.inject as () => { onOpen: () => void })()
    injected.onOpen()
    expect(state.openTabs).toEqual(['devlead-board'])
  })
})
