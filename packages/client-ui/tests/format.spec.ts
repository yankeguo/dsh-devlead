/** Unit tests for the pure strip helpers of the DevLeadBar dock. */

import { describe, expect, it } from 'vitest'
import {
  DEVLEAD_TRANSITIONS,
  notificationLine,
  reportLine,
} from '@yankeguo/dsh-devlead-protocol/client'
import type { DevLeadNotification, DevLeadReport } from '@yankeguo/dsh-devlead-protocol/client'
import {
  epochMillis,
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
      summary: undefined,
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

  it('exposes the settled turn assistant summary as a bounded single line', () => {
    const summary = notificationSummary({
      ...BASE_NOTIFICATION,
      summary: ' implemented\nthe parser ',
    })
    expect(summary.summary).toBe('implemented the parser')
    expect(summary.summary).not.toContain('\n')
    // A whitespace-only stored summary is absent, not an empty chip detail.
    expect(notificationSummary({ ...BASE_NOTIFICATION, summary: ' \t ' }).summary).toBeUndefined()
    // A real failure excerpt wins at render time, but the summary field stays
    // available for callers that inspect both facts.
    const failed = notificationSummary({
      ...BASE_NOTIFICATION,
      transition: 'error',
      error: 'quota exhausted',
      summary: 'tried the fix',
    })
    expect(failed.error).toBe('quota exhausted')
    expect(failed.summary).toBe('tried the fix')
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
    // A missing/non-array collection from the wire boundary is unusable, not
    // an empty digest: the strip must degrade instead of throwing.
    expect(latestNotification(undefined)).toBeNull()
    expect(latestNotification({} as unknown as readonly DevLeadNotification[])).toBeNull()
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

  it('degrades a missing or non-array watch set to zero counts', () => {
    expect(summarizeWatched(undefined, {}, undefined)).toEqual({ watched: 0, running: 0, missing: 0 })
    expect(summarizeWatched({} as unknown as readonly unknown[], {}, undefined))
      .toEqual({ watched: 0, running: 0, missing: 0 })
  })

  it('keeps a live status fact for a Session the catalog lost', () => {
    // The catalog row can vanish before the status map drops its last fact; the
    // watched entry is still reported as missing while its running fact counts.
    const statuses = new Map([['ghost', { running: true }]])
    expect(summarizeWatched(['ghost'], {}, statuses)).toEqual({ watched: 1, running: 1, missing: 1 })
  })

  it('counts prototype-key watch entries as lost rows, not inherited catalog members', () => {
    // A plain-object catalog answers `rows['toString']` with an inherited
    // function; the own-property guard must still report the row as missing.
    expect(summarizeWatched(['toString', 'constructor'], {}, undefined))
      .toEqual({ watched: 2, running: 0, missing: 2 })
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
    expect(reportLabelKey('question')).toBe('report.kind.question')
    expect(reportLabelKey('fyi')).toBe('report.kind.fyi')
    expect(reportLabelKey('urgent')).toBe('report.kind.unknown')
    expect(reportLabelKey('')).toBe('report.kind.unknown')
  })

  it('covers the whole report vocabulary', () => {
    const keys: DevLeadReportKey[] = ['progress', 'blocked', 'decision', 'question', 'fyi'].map(reportLabelKey)
    expect(new Set(keys).size).toBe(5)
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
    expect(latestReport(undefined)).toBeNull()
    expect(latestReport({} as unknown as readonly DevLeadReport[])).toBeNull()
  })

  it('sanitizes an unusable report instant instead of poisoning the newest-row comparison', () => {
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(reportSummary({ ...BASE_REPORT, at }).at).toBe(0)
    }
    const drifted = { ...BASE_REPORT, at: 'yesterday' } as unknown as DevLeadReport
    expect(reportSummary(drifted).at).toBe(0)
    const { at: _at, ...withoutAt } = BASE_REPORT
    expect(reportSummary(withoutAt as DevLeadReport).at).toBe(0)
  })

  it('degrades a drifted report in the tooltip path instead of throwing', () => {
    // The chip fields guard their own types; the canonical tooltip rides the
    // shared protocol line, which must tolerate the same drift (missing
    // message, non-string summary, unknown kind) without a render crash.
    const drifted = {
      ...BASE_REPORT,
      message: undefined,
      summary: 42,
      kind: 'urgent',
    } as unknown as DevLeadReport
    const summary = reportSummary(drifted)
    expect(summary.detail).toBeUndefined()
    expect(summary.labelKey).toBe('report.kind.unknown')
    // An unknown kind takes the client's own raw fallback (title-only who);
    // a known kind with drifted text rides the guarded protocol line instead
    // (covered by the render tests).
    expect(summary.tooltip).toBe('Fix the parser — report urgent')
  })
})

describe('epochMillis', () => {
  it('keeps finite numbers and degrades everything else to 0', () => {
    expect(epochMillis(0)).toBe(0)
    expect(epochMillis(Date.UTC(2026, 0, 5))).toBe(Date.UTC(2026, 0, 5))
    expect(epochMillis(-1)).toBe(-1)
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '123', {}]) {
      expect(epochMillis(value)).toBe(0)
    }
  })
})
