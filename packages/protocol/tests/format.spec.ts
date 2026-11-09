/**
 * Pure-function coverage of the shared protocol format helpers: the exact
 * prompt/UI digest spelling the Host and browser must agree on, and the edge
 * cases of the bounded text helpers.
 */

import { describe, expect, it } from 'vitest'
import {
  DEVLEAD_DEFAULT_MAX_WATCHED,
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_PROJECTION_KEY,
  DEVLEAD_RECORD_VERSION,
  DEVLEAD_TRANSITIONS,
  excerptLine,
  formatInstant,
  isDevLeadTransition,
  notificationDigest,
  notificationId,
  notificationLine,
  transitionLabel,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadTransition } from '@yankeguo/dsh-devlead-protocol'

/** Fixed epoch milliseconds used by every fixture. */
const T0 = 1_700_000_000_000

/** Build one notification with explicit deterministic fields. */
function notification(overrides: Partial<DevLeadNotification> = {}): DevLeadNotification {
  return {
    id: 'session-alpha:3:completed',
    sessionId: 'session-alpha',
    transition: 'completed',
    turn: 3,
    at: T0,
    ...overrides,
  }
}

describe('isDevLeadTransition', () => {
  it('accepts every transition the protocol reports', () => {
    for (const transition of DEVLEAD_TRANSITIONS) expect(isDevLeadTransition(transition)).toBe(true)
    expect(DEVLEAD_TRANSITIONS).toEqual([
      'completed',
      'error',
      'blocked',
      'aborted',
      'max-tokens',
      'interrupted',
      'forked',
    ])
  })

  it('rejects labels, casing, and non-string values', () => {
    for (const value of ['failed', 'cancelled', 'Completed', 'COMPLETED', '', ' completed', 'blocked ', undefined, null, 0, 1, true, {}, []]) {
      expect(isDevLeadTransition(value)).toBe(false)
    }
  })

  it('narrows an unknown value to the transition union', () => {
    const value: unknown = 'blocked'
    if (!isDevLeadTransition(value)) throw new Error('expected a transition')
    const transition: DevLeadTransition = value
    expect(transition).toBe('blocked')
  })
})

describe('transitionLabel', () => {
  it('renders one stable English label per transition', () => {
    expect(DEVLEAD_TRANSITIONS.map(transitionLabel)).toEqual([
      'completed',
      'failed',
      'blocked',
      'cancelled',
      'hit the output-token limit',
      'interrupted',
      'forked',
    ])
  })
})

describe('notificationId', () => {
  it('joins the Session, turn, and transition deterministically', () => {
    expect(notificationId('session-alpha', 3, 'completed')).toBe('session-alpha:3:completed')
    expect(notificationId('session-alpha', 3, 'completed')).toBe(notificationId('session-alpha', 3, 'completed'))
  })

  it('distinguishes every identity component', () => {
    const base = notificationId('session-alpha', 3, 'completed')
    expect(notificationId('session-beta', 3, 'completed')).not.toBe(base)
    expect(notificationId('session-alpha', 4, 'completed')).not.toBe(base)
    expect(notificationId('session-alpha', 3, 'error')).not.toBe(base)
  })

  it('does not normalize or escape a Session id', () => {
    expect(notificationId(' Session Alpha ', 0, 'interrupted')).toBe(' Session Alpha :0:interrupted')
    expect(notificationId('a:b', 1, 'forked')).toBe('a:b:1:forked')
  })
})

describe('notificationLine', () => {
  it('names a titled Session with its id and turn outcome', () => {
    expect(notificationLine(notification({ sessionTitle: 'webapp' }))).toBe(
      'webapp (session-alpha) — turn 3 completed',
    )
  })

  it('falls back to the raw Session id when no title was folded', () => {
    expect(notificationLine(notification())).toBe('session-alpha — turn 3 completed')
  })

  it('appends the bounded failure excerpt when one was recorded', () => {
    expect(notificationLine(notification({ transition: 'error', error: 'provider quota exhausted' }))).toBe(
      'session-alpha — turn 3 failed: provider quota exhausted',
    )
    expect(notificationLine(notification({ transition: 'blocked', error: 'waiting for a human' }))).toBe(
      'session-alpha — turn 3 blocked: waiting for a human',
    )
  })

  it('appends the latest assistant summary when no failure excerpt is recorded', () => {
    expect(notificationLine(notification({ summary: 'implemented the parser' }))).toBe(
      'session-alpha — turn 3 completed: implemented the parser',
    )
    expect(notificationLine(notification({ transition: 'blocked', summary: 'waiting on review' }))).toBe(
      'session-alpha — turn 3 blocked: waiting on review',
    )
  })

  it('prefers the failure excerpt over the assistant summary', () => {
    expect(
      notificationLine(notification({ transition: 'error', error: 'quota exhausted', summary: 'tried the fix' })),
    ).toBe('session-alpha — turn 3 failed: quota exhausted')
  })

  it('renders every transition with its stable label', () => {
    for (const transition of DEVLEAD_TRANSITIONS) {
      const line = notificationLine(notification({ transition, turn: 1 }))
      expect(line.startsWith('session-alpha — turn 1 ')).toBe(true)
      expect(line).toBe(`session-alpha — turn 1 ${transitionLabel(transition)}`)
    }
  })
})

describe('notificationDigest', () => {
  it('renders one line per notification, oldest first', () => {
    const lines = notificationDigest([
      notification({ sessionTitle: 'webapp', summary: 'wrote the parser' }),
      notification({ sessionId: 'session-beta', turn: 1, transition: 'error', error: 'boom' }),
    ])
    expect(lines).toEqual([
      'webapp (session-alpha) — turn 3 completed: wrote the parser',
      'session-beta — turn 1 failed: boom',
    ])
  })

  it('returns an empty list for an empty digest', () => {
    expect(notificationDigest([])).toEqual([])
  })
})

describe('formatInstant', () => {
  it('renders a compact UTC second spelling', () => {
    expect(formatInstant(0)).toBe('1970-01-01T00:00:00Z')
    expect(formatInstant(T0)).toBe('2023-11-14T22:13:20Z')
  })

  it('drops the millisecond fraction without rounding up', () => {
    expect(formatInstant(T0 + 999)).toBe('2023-11-14T22:13:20Z')
    expect(formatInstant(T0 + 1_000)).toBe('2023-11-14T22:13:21Z')
    expect(formatInstant(1)).toBe('1970-01-01T00:00:00Z')
  })

  it('keeps the compact spelling parseable back to the truncated instant', () => {
    const formatted = formatInstant(T0 + 250)
    expect(Date.parse(formatted)).toBe(T0)
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u)
  })
})

describe('excerptLine', () => {
  it('collapses every whitespace run into one space and trims', () => {
    expect(excerptLine('  hello \n\t world  ', 40)).toBe('hello world')
    expect(excerptLine('a\r\nb\u00a0c', 40)).toBe('a b c')
  })

  it('returns undefined when nothing remains', () => {
    expect(excerptLine('', 10)).toBeUndefined()
    expect(excerptLine(' \n\t\r ', 10)).toBeUndefined()
  })

  it('returns the text unchanged when it fits', () => {
    expect(excerptLine('12345', 5)).toBe('12345')
    expect(excerptLine('1234', 5)).toBe('1234')
  })

  it('truncates with an ellipsis inside the budget', () => {
    expect(excerptLine('abcdef', 4)).toBe('abc…')
    expect(excerptLine('abcdef', 4)).toHaveLength(4)
    expect(excerptLine('abcdef', 2)).toBe('a…')
    expect(excerptLine('abcdef', 1)).toBe('…')
  })

  it('documents the zero-budget edge: one ellipsis character is still returned', () => {
    // The docstring calls `max` the maximum retained characters including the
    // ellipsis, but a zero budget still yields the ellipsis itself. Not
    // reachable from production callers, which pass DEVLEAD_ERROR_EXCERPT_MAX.
    expect(excerptLine('abcdef', 0)).toBe('…')
  })
})

describe('protocol constants', () => {
  it('pins the shared vocabulary both faces compile against', () => {
    expect(DEVLEAD_PROJECTION_KEY).toBe('devLead')
    expect(DEVLEAD_RECORD_VERSION).toBe(1)
    expect(DEVLEAD_DEFAULT_MAX_WATCHED).toBe(64)
    expect(DEVLEAD_DEFAULT_NOTIFICATION_RETENTION).toBe(64)
    expect(DEVLEAD_ERROR_EXCERPT_MAX).toBe(240)
    expect(DEVLEAD_TRANSITIONS).toHaveLength(7)
  })
})
