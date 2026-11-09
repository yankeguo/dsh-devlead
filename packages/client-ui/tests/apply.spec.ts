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

import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

// The primitives package is a browser platform module whose own dependencies
// (e.g. `clsx`) are supplied by the DSH shell bundle, not by this workspace's
// node_modules; registration wiring only needs the component identities.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Placeholder = (): null => null
  return {
    Button: Placeholder,
    Switch: Placeholder,
    Tooltip: Placeholder,
    IconShieldOutlineRegular: Placeholder,
    IconUsersOutlineRegular: Placeholder,
  }
})

import { apply } from '../src/client/index.tsx'

/** One recorded `slots.register` call. */
interface RecordedRegistration {
  readonly name: string
  readonly id: string
  readonly order: number | undefined
  readonly locale: string | undefined
  readonly component: unknown
}

/** Minimal client context surface `apply()` touches during registration. */
interface FakeContext {
  readonly effects: string[]
  readonly injects: string[]
  readonly registrations: RecordedRegistration[]
}

/**
 * Build a fake client root context that records effects, slot injections, and
 * registrations without starting a renderer.
 * @returns the fake context and its record of the plugin's calls.
 */
function fakeContext(): { ctx: ClientContext; state: FakeContext } {
  const state: FakeContext = { effects: [], injects: [], registrations: [] }
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
    locale: {
      register: () => () => {},
      provideRoot: () => () => {},
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
    },
  }
  return { ctx: ctx as unknown as ClientContext, state }
}

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
})
