/**
 * Unit coverage of the in-memory answer lifecycle tracker (Phase 1d): the
 * latest-per-question seed semantics that survive a restart, terminal-state
 * handling, bounded insert, and the claimed/presented/discarded transitions.
 */

import { describe, expect, it } from 'vitest'
import { DEVLEAD_MESSAGE_KIND } from '@yankeguo/dsh-devlead-protocol'
import { DevLeadAnswerTracker, DevLeadChildAnswerObserver, entryOfRecord, recordOfEntry } from '../src/answers.ts'
import { answer, sessionEvent } from './fixtures.ts'

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

  it('round-trips a sequenced entry through the record projection', () => {
    const record = answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'admitted', at: 10, answerSeq: 2 })
    expect(recordOfEntry(entryOfRecord(record))).toEqual(record)
    expect(entryOfRecord(record).answerSeq).toBe(2)
  })
})

describe('DevLeadAnswerTracker admission sequence (delayed lifecycle facts)', () => {
  it('a late discard of an older answer never replaces a newer re-answer', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'admitted', at: 10, answerSeq: 1 }))
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm2', status: 'admitted', at: 20, answeredAt: 10, answerSeq: 2 }))
    // The old answer's discard drains late: its lifecycle `at` is newer, but
    // its admission sequence is older, so the re-answer stays latest.
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'discarded', at: 999, answeredAt: 10, answerSeq: 1 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.messageId).toBe('m2')
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.status).toBe('admitted')
  })

  it('a higher sequence replaces even when its lifecycle instant is older', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'discarded', at: 100, answerSeq: 1 }))
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm2', status: 'admitted', at: 20, answeredAt: 10, answerSeq: 2 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.messageId).toBe('m2')
  })

  it('legacy (no-sequence) ties compare admission instants, never lifecycle at', () => {
    const tracker = new DevLeadAnswerTracker()
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'admitted', at: 10 }))
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm2', status: 'admitted', at: 20, answeredAt: 10 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.messageId).toBe('m2')
    // A legacy late discard of m1 carries the question's first admission in
    // answeredAt, not its discard instant, so it cannot outrank the re-answer.
    tracker.seed(answer({ reportId: REPORT, leadSessionId: LEAD, sessionId: CHILD, messageId: 'm1', status: 'discarded', at: 999, answeredAt: 10 }))
    expect(tracker.entryOfQuestion(LEAD, REPORT)?.messageId).toBe('m2')
  })
})

describe('DevLeadChildAnswerObserver (durable child-log reconstruction)', () => {
  /** One runtime-stamped answer message shape as the inbox splices carry it. */
  function answerMessage(id: string, questionId = REPORT, leadId = LEAD): unknown {
    return {
      id,
      source: { kind: DEVLEAD_MESSAGE_KIND, form: 'relay', intent: 'answer', questionId, senderSessionId: leadId },
      content: [{ type: 'text', text: 'use staging' }],
    }
  }

  /** One plain human message (no answer metadata). */
  function humanMessage(id: string): unknown {
    return { id, source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
  }

  it('derives a discard from a canceled splice with the source identities', () => {
    const observer = new DevLeadChildAnswerObserver()
    expect(observer.observe(sessionEvent(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [answerMessage('m1')] }, 10))).toEqual([])
    const derived = observer.observe(sessionEvent(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }, 20))
    expect(derived).toEqual([{ messageId: 'm1', questionId: REPORT, leadId: LEAD, at: 20 }])
  })

  it('a claimed then presented answer derives nothing at turn/end', () => {
    const observer = new DevLeadChildAnswerObserver()
    observer.observe(sessionEvent(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [answerMessage('m1')] }, 10))
    // A claim removes without outcome:'canceled'.
    expect(observer.observe(sessionEvent(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 20))).toEqual([])
    observer.observe(sessionEvent(3, 'user/message', { ...answerMessage('m1') as object, turn: 1, step: 1 }, 30))
    expect(observer.observe(sessionEvent(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 40))).toEqual([])
  })

  it('a claimed answer that never presented is discarded at turn/end (rejected pre-step)', () => {
    const observer = new DevLeadChildAnswerObserver()
    observer.observe(sessionEvent(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [answerMessage('m1')] }, 10))
    observer.observe(sessionEvent(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 20))
    expect(observer.observe(sessionEvent(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 40)))
      .toEqual([{ messageId: 'm1', questionId: REPORT, leadId: LEAD, at: 40 }])
    // The claim observation is consumed: a second turn/end derives nothing.
    expect(observer.observe(sessionEvent(4, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 50))).toEqual([])
  })

  it('suppresses canceled-removal derivations during the interrupt window and tracks the restore', () => {
    const observer = new DevLeadChildAnswerObserver()
    observer.observe(sessionEvent(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [answerMessage('m1')] }, 10))
    // keep/clear-own stop clears the inbox, then restores the same message.
    expect(observer.observe(sessionEvent(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }, 20), true)).toEqual([])
    observer.observe(sessionEvent(3, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [answerMessage('m1')] }, 30))
    // The restored answer is pending again: a later real discard still derives.
    expect(observer.observe(sessionEvent(4, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }, 40)))
      .toEqual([{ messageId: 'm1', questionId: REPORT, leadId: LEAD, at: 40 }])
  })

  it('resolves splice indices across mixed answer/human input and both boundaries', () => {
    const observer = new DevLeadChildAnswerObserver()
    observer.observe(sessionEvent(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [humanMessage('h1'), answerMessage('m1')] }, 10))
    observer.observe(sessionEvent(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [answerMessage('m2')] }, 15))
    // The pre-step claims all next-step plus one next-turn: m2 and h1 removed.
    expect(observer.observe(sessionEvent(3, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 20))).toEqual([])
    expect(observer.observe(sessionEvent(4, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }, 21))).toEqual([])
    // m2 presented; h1 is not an answer; m1 still pending at next-turn.
    observer.observe(sessionEvent(5, 'user/message', { ...answerMessage('m2') as object, turn: 1, step: 1 }, 30))
    expect(observer.observe(sessionEvent(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 40))).toEqual([])
    // A later clear-all cancels the remaining next-turn answer m1.
    expect(observer.observe(sessionEvent(7, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }, 50)))
      .toEqual([{ messageId: 'm1', questionId: REPORT, leadId: LEAD, at: 50 }])
  })

  it('replays a complete log into the same observations (boot reconstruction)', () => {
    const events = [
      sessionEvent(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [answerMessage('m1')] }, 10),
      sessionEvent(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 20),
      sessionEvent(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 40),
      sessionEvent(4, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [answerMessage('m2')] }, 50),
      sessionEvent(5, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }, 60),
    ]
    const observer = new DevLeadChildAnswerObserver()
    expect(observer.replay(events)).toEqual([
      { messageId: 'm1', questionId: REPORT, leadId: LEAD, at: 40 },
      { messageId: 'm2', questionId: REPORT, leadId: LEAD, at: 60 },
    ])
    // A replay replaces prior state rather than accumulating it.
    expect(observer.replay(events)).toEqual([
      { messageId: 'm1', questionId: REPORT, leadId: LEAD, at: 40 },
      { messageId: 'm2', questionId: REPORT, leadId: LEAD, at: 60 },
    ])
  })

  it('ignores messages without a correlatable question source', () => {
    const observer = new DevLeadChildAnswerObserver()
    const noQuestion = { id: 'm1', source: { kind: DEVLEAD_MESSAGE_KIND, form: 'relay', intent: 'answer', senderSessionId: LEAD }, content: [] }
    observer.observe(sessionEvent(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [noQuestion, humanMessage('h1')] }, 10))
    expect(observer.observe(sessionEvent(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 2, inserted: [], outcome: 'canceled' }, 20))).toEqual([])
  })
})
