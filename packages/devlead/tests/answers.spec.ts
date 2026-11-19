/**
 * Unit coverage of the in-memory answer lifecycle tracker (Phase 1d): the
 * latest-per-question seed semantics that survive a restart, terminal-state
 * handling, bounded insert, and the claimed/presented/discarded transitions.
 */

import { describe, expect, it } from 'vitest'
import { DevLeadAnswerTracker, entryOfRecord, recordOfEntry } from '../src/answers.ts'
import { answer } from './fixtures.ts'

const LEAD = 'lead-1'
const CHILD = 'child-1'
const REPORT = 'child-1:1:report:question:abc'

describe('DevLeadAnswerTracker seed (restart semantics)', () => {
  it('seeds a terminal discarded record as discarded (question stays open)', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'discarded', at: 10 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.status).toBe('discarded')
  })

  it('does not rewind an observed presentation with a durable admitted record of the same message', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.remember(entryOfRecord(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'admitted', at: 10 })))
    tracker.presented(CHILD, 'm1', 20)
    // A re-seed of the durable admitted row must not rewind the presentation.
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'admitted', at: 10 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.status).toBe('presented')
  })

  it('lets a durable terminal discard win over a stale memory admission', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.remember(entryOfRecord(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'admitted', at: 10 })))
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'discarded', at: 20 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.status).toBe('discarded')
  })

  it('replaces an older entry with a newer different-message answer, but not an older one', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'admitted', at: 10 }))
    // Newer re-answer replaces m1.
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm2', status: 'admitted', at: 20 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.messageId).toBe('m2')
    expect(tracker.entryOfMessage(CHILD, 'm1')).toBeUndefined()
    // An older record does not replace the newer m2.
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm0', status: 'admitted', at: 5 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.messageId).toBe('m2')
  })

  it('bounds the tracked answers when seeding many questions', () => {
    const tracker = new DevLeadAnswerTracker()
    for (let index = 0; index < 600; index += 1) {
      tracker.seed(answer({ reportId: `q${index}`, leadSessionId: LEAD, sessionId: CHILD, messageId: `m${index}`, at: index }))
    }
    // The newest questions survive; the tracker stays bounded (FIFO eviction).
    expect(tracker.entryOfQuestion(LEAD, 'q599')).toBeDefined()
    expect(tracker.entryOfQuestion(LEAD, 'q0')).toBeUndefined()
    let count = 0
    for (let index = 0; index < 600; index += 1) {
      if (tracker.entryOfQuestion(LEAD, `q${index}`) !== undefined) count += 1
    }
    expect(count).toBeLessThanOrEqual(512)
  })
})

describe('DevLeadAnswerTracker lifecycle', () => {
  it('advances admitted → claimed → presented and guards terminal transitions', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.remember(entryOfRecord(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', at: 10 })))
    expect(tracker.claimed(CHILD, 'm1', 20)).toBe(true)
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.status).toBe('claimed')
    expect(tracker.presented(CHILD, 'm1', 30)).toBe(true)
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.status).toBe('presented')
    // presented is terminal: a later discard does not reopen it.
    expect(tracker.discarded(CHILD, 'm1', 40)).toBeUndefined()
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.status).toBe('presented')
  })

  it('reconciles a claimed answer that never presented at turn/end (rejected pre-step)', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.remember(entryOfRecord(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', at: 10 })))
    tracker.claimed(CHILD, 'm1', 20)
    const discarded = tracker.reconcileTurnEnd(CHILD, 30)
    expect(discarded).toHaveLength(1)
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.status).toBe('discarded')
  })

  it('remember replaces the previous answer of the same question', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.remember(entryOfRecord(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', at: 10 })))
    tracker.remember(entryOfRecord(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm2', at: 20 })))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.messageId).toBe('m2')
    expect(tracker.entryOfMessage(CHILD, 'm1')).toBeUndefined()
  })

  it('round-trips an entry through the record projection', () => {
    const record = answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'presented', at: 10, presentedAt: 30, idempotencyKey: 'k' })
    expect(recordOfEntry(entryOfRecord(record))).toEqual(record)
  })
})