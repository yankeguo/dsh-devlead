/** Unit tests for the pure strip helpers of the DevLeadBar dock. */

import { describe, expect, it } from 'vitest'
import {
  DEVLEAD_TRANSITIONS,
  notificationLine,
  reportLine,
} from '@yankeguo/dsh-devlead-protocol/client'
import type { DevLeadNotification, DevLeadReport } from '@yankeguo/dsh-devlead-protocol/client'
import {
  latestNotification,
  latestReport,
  notificationSummary,
  reportLabelKey,
  reportSummary,
  summarizeWatched,
  transitionLabelKey,
  type DevLeadReportKey,
  type DevLeadTransitionKey,
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

  it('covers exactly the protocol transition vocabulary', () => {
    // The label table is exhaustive by type, so a protocol transition without a
    // localized label fails to compile; this runtime twin keeps the mapping
    // itself pinned to the shared vocabulary.
    const keys: DevLeadTransitionKey[] = DEVLEAD_TRANSITIONS.map(transitionLabelKey)
    expect(keys).toEqual([
      'transition.completed',
      'transition.error',
      'transition.blocked',
      'transition.aborted',
      'transition.max-tokens',
      'transition.interrupted',
      'transition.forked',
    ])
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

  it('keeps the chip fields on one bounded line', () => {
    const summary = notificationSummary({
      ...BASE_NOTIFICATION,
      sessionTitle: 'Fix\nthe parser',
      error: 'tool\rcrashed',
    })
    expect(summary.who).toBe('Fix the parser')
    expect(summary.error).toBe('tool crashed')
    expect(summary.who).not.toContain('\n')
    expect(summary.error).not.toContain('\r')
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

  it('keeps a live status fact for a Session the catalog lost', () => {
    // The catalog row can vanish before the status map drops its last fact; the
    // watched entry is still reported as missing while its running fact counts.
    const statuses = new Map([['ghost', { running: true }]])
    expect(summarizeWatched(['ghost'], {}, statuses)).toEqual({ watched: 1, running: 1, missing: 1 })
  })
})


/** One report fixture; individual tests override fields. */
const BASE_REPORT: DevLeadReport = {
  id: 'session-1:3:report:progress:abc',
  kind: 'progress',
  message: 'halfway through the parser',
  summary: 'parser progress',
  senderSessionId: 'session-1',
  senderSessionTitle: 'Fix the parser',
  leadSessionId: 'lead-1',
  turn: 3,
  at: Date.UTC(2026, 0, 5, 12, 0, 1),
}

describe('reportLabelKey', () => {
  it('maps every known report kind and falls back for wire drift', () => {
    expect(reportLabelKey('progress')).toBe('report.kind.progress')
    expect(reportLabelKey('blocked')).toBe('report.kind.blocked')
    expect(reportLabelKey('decision')).toBe('report.kind.decision')
    expect(reportLabelKey('fyi')).toBe('report.kind.fyi')
    expect(reportLabelKey('urgent')).toBe('report.kind.unknown')
    expect(reportLabelKey('')).toBe('report.kind.unknown')
  })

  it('covers the whole report vocabulary', () => {
    const keys: DevLeadReportKey[] = ['progress', 'blocked', 'decision', 'fyi'].map(reportLabelKey)
    expect(new Set(keys).size).toBe(4)
  })
})

describe('reportSummary', () => {
  it('uses the folded title, kind, summary, and canonical tooltip', () => {
    expect(reportSummary(BASE_REPORT)).toEqual({
      tooltip: reportLine(BASE_REPORT),
      who: 'Fix the parser',
      kind: 'progress',
      labelKey: 'report.kind.progress',
      detail: 'parser progress',
      at: BASE_REPORT.at,
    })
  })

  it('falls back to the message and raw sender when optional fields are absent', () => {
    const { summary: _summary, ...withoutSummary } = BASE_REPORT
    const summary = reportSummary({ ...withoutSummary, senderSessionTitle: '   ' })
    expect(summary.who).toBe('session-1')
    expect(summary.detail).toBe('halfway through the parser')
  })

  it('returns the newest retained report', () => {
    expect(latestReport([])).toBeNull()
    expect(latestReport([BASE_REPORT])).toBe(BASE_REPORT)
  })
})
