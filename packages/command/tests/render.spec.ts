import { describe, expect, it } from 'vitest'
import type { DevLeadNotification } from '@yankeguo/dsh-devlead-protocol'
import {
  HELP_LINE,
  errorResult,
  modeLabel,
  renderStatus,
  sessionLabel,
  sessionStateLabel,
  statusLines,
} from '../src/render.ts'
import type { DevLeadStatusSnapshot } from '../src/render.ts'
import { NOW, notification, sessionView } from './fake.ts'

/** Build one status snapshot with deterministic inactive defaults. */
function snapshot(overrides: Partial<DevLeadStatusSnapshot> = {}): DevLeadStatusSnapshot {
  return {
    enabled: true,
    worktreeIsolation: false,
    watched: [],
    missingWatched: [],
    notifications: [],
    ...overrides,
  }
}

/** Render one command result's text. */
function text(result: { readonly text?: string }): string {
  return result.text ?? ''
}

describe('modeLabel', () => {
  it('renders both switch states', () => {
    expect(modeLabel(true)).toBe('on')
    expect(modeLabel(false)).toBe('off')
  })
})

describe('sessionLabel', () => {
  it('names a Session by title and id when a title is folded', () => {
    expect(sessionLabel(sessionView('session-alpha', { title: 'webapp' }))).toBe('webapp (session-alpha)')
  })

  it('falls back to the bare id without a title', () => {
    expect(sessionLabel(sessionView('session-alpha'))).toBe('session-alpha')
    expect(sessionLabel(sessionView('session-alpha', { title: '   ' }))).toBe('session-alpha')
  })
})

describe('sessionStateLabel', () => {
  it('renders the live lifecycle states', () => {
    expect(sessionStateLabel(sessionView('session-alpha', { live: true, running: true }))).toBe('running')
    expect(sessionStateLabel(sessionView('session-alpha', { live: true }))).toBe('idle')
    expect(sessionStateLabel(sessionView('session-alpha'))).toBe('cold')
    expect(sessionStateLabel(sessionView('session-alpha', { archived: true, live: true }))).toBe('archived')
  })

  it('reports queued input while running', () => {
    expect(sessionStateLabel(sessionView('session-alpha', { live: true, running: true, pendingInputs: 2 })))
      .toBe('running · 2 queued')
    expect(sessionStateLabel(sessionView('session-alpha', { live: true, running: true, pendingInputs: 0 })))
      .toBe('running')
  })

  it('reports the latest settled turn and its outcome', () => {
    expect(sessionStateLabel(sessionView('session-alpha', { live: true, lastTurn: 3 })))
      .toBe('idle · last turn 3')
    expect(sessionStateLabel(sessionView('session-alpha', { live: true, lastTurn: 3, lastTransition: 'completed' })))
      .toBe('idle · last turn 3 completed')
    expect(sessionStateLabel(sessionView('session-alpha', {
      live: true,
      lastTurn: 4,
      lastTransition: 'error',
      lastError: 'provider quota exhausted',
    }))).toBe('idle · last turn 4 failed: provider quota exhausted')
  })
})

describe('statusLines', () => {
  it('renders the off state with no watch set and no notifications', () => {
    expect(statusLines(snapshot({ enabled: false }))).toEqual([
      'DevLead mode: off',
      'Worktree isolation: unavailable',
      'Watched sessions: none',
      'Recent notifications: none',
      'DevLead mode is off: no notification wakes this Session until it is turned on again.',
      'Turn DevLead mode on with: /devlead on',
      HELP_LINE,
    ])
  })

  it('reports whether optional worktree isolation is composed', () => {
    expect(statusLines(snapshot({ worktreeIsolation: true }))).toContain('Worktree isolation: available')
    expect(statusLines(snapshot({ worktreeIsolation: false }))).toContain('Worktree isolation: unavailable')
  })

  it('renders the mode, counted watch set, and running rows in watch order', () => {
    const lines = statusLines(snapshot({
      watched: [
        sessionView('session-alpha', {
          title: 'webapp',
          live: true,
          running: true,
          watched: true,
          pendingInputs: 1,
          lastTurn: 3,
          lastTransition: 'completed',
        }),
        sessionView('session-beta', {
          title: 'api',
          live: true,
          watched: true,
          lastTurn: 1,
          lastTransition: 'error',
          lastError: 'provider quota exhausted',
        }),
        sessionView('session-gamma', { watched: true }),
      ],
    }))
    expect(lines).toContain('DevLead mode: on')
    expect(lines).toContain('Watched sessions: 3 (1 running)')
    expect(lines).toContain('  - webapp (session-alpha) — running · 1 queued · last turn 3 completed')
    expect(lines).toContain('  - api (session-beta) — idle · last turn 1 failed: provider quota exhausted')
    expect(lines).toContain('  - session-gamma — cold')
    expect(lines).not.toContain('Turn DevLead mode on with: /devlead on')
    expect(lines[lines.length - 1]).toBe(HELP_LINE)
  })

  it('renders watched ids the host could not describe as not found', () => {
    const lines = statusLines(snapshot({
      watched: [sessionView('session-alpha', { title: 'webapp', live: true })],
      missingWatched: ['session-stale'],
    }))
    expect(lines).toContain('Watched sessions: 2')
    expect(lines).toContain('  - session-stale — not found')
  })

  it('renders the notification digest oldest first with portable instants', () => {
    const notifications: DevLeadNotification[] = [
      notification({ title: 'webapp', turn: 2, at: NOW - 60_000 }),
      notification({ title: 'api', turn: 1, transition: 'error', error: 'quota exhausted', at: NOW }),
    ]
    const lines = statusLines(snapshot({ notifications }))
    expect(lines).toContain('Recent notifications:')
    expect(lines).toContain('  - 2026-11-09T01:59:00Z webapp (session-alpha) — turn 2 completed')
    expect(lines).toContain('  - 2026-11-09T02:00:00Z api (session-alpha) — turn 1 failed: quota exhausted')
    expect(lines.indexOf('  - 2026-11-09T01:59:00Z webapp (session-alpha) — turn 2 completed'))
      .toBeLessThan(lines.indexOf('  - 2026-11-09T02:00:00Z api (session-alpha) — turn 1 failed: quota exhausted'))
  })
})

describe('renderStatus', () => {
  it('prepends an optional outcome title above the status body', () => {
    const result = renderStatus(snapshot(), 'Now watching webapp (session-alpha).')
    expect(result.kind).toBe('success')
    expect(text(result).startsWith('Now watching webapp (session-alpha).\n\nDevLead mode: on')).toBe(true)
  })

  it('renders the bare status body without a title', () => {
    expect(text(renderStatus(snapshot()))).toBe(statusLines(snapshot()).join('\n'))
  })
})

describe('errorResult', () => {
  it('renders a friendly error instead of a thrown failure', () => {
    expect(errorResult('No Session matches "abc".')).toEqual({
      kind: 'error',
      text: 'No Session matches "abc".',
    })
  })
})
