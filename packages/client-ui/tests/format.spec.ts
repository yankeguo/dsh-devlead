/** Unit tests for the pure strip helpers of the DevLeadBar dock. */

import { describe, expect, it } from 'vitest'
import { notificationLine } from '@yankeguo/dsh-devlead-protocol/client'
import type { DevLeadNotification } from '@yankeguo/dsh-devlead-protocol/client'
import {
  latestNotification,
  notificationSummary,
  summarizeWatched,
  transitionLabelKey,
} from '../src/client/format.ts'

/** One notification fixture; individual tests override fields. */
const BASE_NOTIFICATION: DevLeadNotification = {
  id: 'session-1:3:completed',
  sessionId: 'session-1',
  sessionTitle: 'Fix the parser',
  transition: 'completed',
  turn: 3,
  at: Date.UTC(2026, 0, 5, 12, 0, 0),
}

describe('transitionLabelKey', () => {
  it('maps every known transition to its dictionary key', () => {
    expect(transitionLabelKey('completed')).toBe('transition.completed')
    expect(transitionLabelKey('error')).toBe('transition.error')
    expect(transitionLabelKey('blocked')).toBe('transition.blocked')
    expect(transitionLabelKey('aborted')).toBe('transition.aborted')
    expect(transitionLabelKey('max-tokens')).toBe('transition.max-tokens')
    expect(transitionLabelKey('interrupted')).toBe('transition.interrupted')
    expect(transitionLabelKey('forked')).toBe('transition.forked')
  })

  it('falls back to the neutral label for a transition a newer Host reports', () => {
    expect(transitionLabelKey('paused')).toBe('transition.unknown')
    expect(transitionLabelKey('')).toBe('transition.unknown')
  })
})

describe('notificationSummary', () => {
  it('renders the folded title, turn, transition, and the Host canonical tooltip', () => {
    expect(notificationSummary(BASE_NOTIFICATION)).toEqual({
      tooltip: notificationLine(BASE_NOTIFICATION),
      who: 'Fix the parser',
      turn: 3,
      transition: 'completed',
      labelKey: 'transition.completed',
      error: undefined,
    })
  })

  it('falls back to the raw Session id when the title is blank or absent', () => {
    expect(notificationSummary({ ...BASE_NOTIFICATION, sessionTitle: '   ' }).who).toBe('session-1')
    const untitled: DevLeadNotification = {
      id: 'session-1:3:completed',
      sessionId: 'session-1',
      transition: 'completed',
      turn: 3,
      at: 0,
    }
    expect(notificationSummary(untitled).who).toBe('session-1')
  })

  it('clamps an unusable turn value instead of rendering it', () => {
    for (const turn of [0, -2, 2.5, Number.NaN]) {
      expect(notificationSummary({ ...BASE_NOTIFICATION, turn }).turn).toBe(0)
    }
  })

  it('keeps a real failure excerpt and drops whitespace-only ones', () => {
    expect(notificationSummary({
      ...BASE_NOTIFICATION,
      transition: 'error',
      error: 'tool crashed',
    })).toMatchObject({ labelKey: 'transition.error', error: 'tool crashed' })
    expect(notificationSummary({ ...BASE_NOTIFICATION, error: '  ' }).error).toBeUndefined()
  })

  it('degrades a future transition literal to the neutral label and a raw tooltip', () => {
    // Simulate a newer Host sending a transition this bundle does not know:
    // the wire value crossed the Remote boundary, so the strip must not throw.
    const drifted = { ...BASE_NOTIFICATION, transition: 'paused' } as unknown as DevLeadNotification
    expect(notificationSummary(drifted)).toMatchObject({
      labelKey: 'transition.unknown',
      transition: 'paused',
      tooltip: 'Fix the parser — paused',
    })
  })
})

describe('latestNotification', () => {
  it('returns null while nothing is retained', () => {
    expect(latestNotification([])).toBeNull()
  })

  it('returns the newest retained notification, which the fold keeps last', () => {
    const first = { ...BASE_NOTIFICATION, id: 'a', turn: 1 }
    const second = { ...BASE_NOTIFICATION, id: 'b', turn: 2 }
    expect(latestNotification([first, second])).toBe(second)
    expect(latestNotification([first])).toBe(first)
  })
})

describe('summarizeWatched', () => {
  it('counts the projection watch set and reports rows the catalog lost', () => {
    expect(summarizeWatched(
      ['a', 'ghost'],
      { a: { running: false } },
      undefined,
    )).toEqual({ watched: 2, running: 0, missing: 1 })
  })

  it('prefers the live UI status over the catalog running flag', () => {
    const statuses = new Map([['a', { running: true }], ['b', { running: false }]])
    expect(summarizeWatched(
      ['a', 'b'],
      { a: { running: false }, b: { running: true } },
      statuses,
    )).toEqual({ watched: 2, running: 1, missing: 0 })
  })

  it('falls back to the catalog row while a Session has no observed status yet', () => {
    const statuses = new Map([['a', { running: undefined }]])
    expect(summarizeWatched(
      ['a', 'b'],
      { a: { running: false }, b: { running: true } },
      statuses,
    )).toEqual({ watched: 2, running: 1, missing: 0 })
  })

  it('deduplicates ids and ignores unusable watch-set entries', () => {
    // The raw array is `unknown[]` because the value crossed the Remote
    // boundary; blank and non-string entries must not become phantom counts.
    expect(summarizeWatched(
      ['a', 'a', '', 'b', 42, null],
      { a: { running: false }, b: { running: false } },
      undefined,
    )).toEqual({ watched: 2, running: 0, missing: 0 })
  })

  it('summarizes an empty watch set as zero everywhere', () => {
    expect(summarizeWatched([], {}, new Map())).toEqual({ watched: 0, running: 0, missing: 0 })
  })
})
