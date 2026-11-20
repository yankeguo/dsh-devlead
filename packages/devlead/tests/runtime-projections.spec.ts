import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DEVLEAD_MESSAGE_KIND } from '@yankeguo/dsh-devlead-protocol'
import {
  applyDevLeadInboxTimes,
  emptyDevLeadInboxTimesState,
  inboxEnqueuedAtOf,
  isHumanDirectedTurn,
} from '../src/runtime-projections.ts'
import {
  applyDevLeadChildAnswers,
  childAnswerClaimedAt,
  childAnswerPending,
  childAnswerPresentedAt,
  childAnswerUnknown,
  DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX,
  devLeadChildAnswersStateSchema,
  emptyDevLeadChildAnswersState,
  finalizeDevLeadChildAnswerCandidates,
} from '../src/child-answer-projection.ts'
import { T0 } from './harness.ts'

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: T0 + seq, type, data } as SessionEvent
}

function answerMessage(id: string, questionId = 'question-1', leadId = 'lead-1') {
  return {
    id,
    source: { kind: DEVLEAD_MESSAGE_KIND, questionId, senderSessionId: leadId },
  }
}

describe('turn source projection', () => {
  it('tracks the latest actionable source without reading a Session log', () => {
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'user/message', { source: { kind: 'user' } }),
      event(2, 'user/message', { source: { kind: 'runtime-context' } }),
      event(3, 'user/message', { source: { kind: DEVLEAD_MESSAGE_KIND, form: 'notice', lane: 'background', wakeRequested: false } }),
    ]
    expect(isHumanDirectedTurn(events)).toBe(true)
    expect(isHumanDirectedTurn([
      ...events,
      event(4, 'user/message', { source: { kind: DEVLEAD_MESSAGE_KIND, form: 'relay' } }),
    ])).toBe(false)
    expect(isHumanDirectedTurn([
      event(0, 'user/message', { source: { kind: 'user' } }),
    ])).toBe(false)
  })
})

describe('inbox enqueue-time projection', () => {
  it('keeps only pending ids and preserves their original splice times', () => {
    let state = emptyDevLeadInboxTimesState()
    state = applyDevLeadInboxTimes(state, event(0, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, inserted: [{ id: 'a' }, { id: 'b' }],
    }))
    state = applyDevLeadInboxTimes(state, event(1, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 1, inserted: [],
    }))
    state = applyDevLeadInboxTimes(state, event(2, 'agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [{ id: 'c' }],
    }))
    expect(inboxEnqueuedAtOf(state, 'a')).toBeUndefined()
    expect(inboxEnqueuedAtOf(state, 'b')).toBe(T0)
    expect(inboxEnqueuedAtOf(state, 'c')).toBe(T0 + 2)
    expect(state.nextStep).toHaveLength(1)
  })
})

describe('child answer projection', () => {
  it('reconstructs cancellation/restore, claims, presentation and tail discards', () => {
    let state = emptyDevLeadChildAnswersState()
    state = applyDevLeadChildAnswers(state, event(0, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, inserted: [answerMessage('m1')],
    }))
    state = applyDevLeadChildAnswers(state, event(1, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    }))
    expect(state.cancelCandidates).toHaveLength(1)
    state = applyDevLeadChildAnswers(state, event(2, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, inserted: [answerMessage('m1')],
    }))
    expect(state.cancelCandidates).toHaveLength(0)
    expect(childAnswerPending(state, 'm1')).toBe(true)
    state = applyDevLeadChildAnswers(state, event(3, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 1, inserted: [],
    }))
    expect(childAnswerClaimedAt(state, 'm1')).toBe(T0 + 3)
    state = applyDevLeadChildAnswers(state, event(4, 'user/message', { id: 'm1' }))
    expect(childAnswerPresentedAt(state, 'm1')).toBe(T0 + 4)
    expect(state.discards).toHaveLength(0)

    state = applyDevLeadChildAnswers(state, event(5, 'agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [answerMessage('m2', 'question-2')],
    }))
    state = applyDevLeadChildAnswers(state, event(6, 'agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    }))
    expect(finalizeDevLeadChildAnswerCandidates(state)).toEqual([
      { messageId: 'm2', questionId: 'question-2', leadId: 'lead-1', at: T0 + 6, seq: 0 },
    ])
    expect(devLeadChildAnswersStateSchema.parse(state)).toEqual(state)
  })

  it('derives rejected-claim discards and scopes overflow to unprovable messages', () => {
    let state = emptyDevLeadChildAnswersState()
    state = applyDevLeadChildAnswers(state, event(0, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, inserted: [answerMessage('m1')],
    }))
    state = applyDevLeadChildAnswers(state, event(1, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 1, inserted: [],
    }))
    state = applyDevLeadChildAnswers(state, event(2, 'turn/end', { turn: 1, reason: 'completed' }))
    expect(state.discards).toEqual([
      { messageId: 'm1', questionId: 'question-1', leadId: 'lead-1', at: T0 + 2, seq: 2 },
    ])
    for (let index = 0; index <= DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX; index += 1) {
      state = applyDevLeadChildAnswers(state, event(3 + index, 'user/message', answerMessage(`presented-${String(index)}`)))
    }
    expect(state.overflow.presented).toBe(true)
    expect(childAnswerUnknown(state, 'evicted-before-bound')).toBe(true)
    expect(childAnswerUnknown(state, 'presented-1')).toBe(false)
    expect(state.presented).toHaveLength(DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX)
  })

  it('ignores ordinary user messages for answer-presentation accounting', () => {
    let state = emptyDevLeadChildAnswersState()
    for (let index = 0; index <= DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX; index += 1) {
      state = applyDevLeadChildAnswers(state, event(index, 'user/message', { id: `ordinary-${String(index)}` }))
    }
    expect(state.presented).toHaveLength(0)
    expect(state.overflow.presented).toBe(false)
    expect(childAnswerUnknown(state, 'ordinary-0')).toBe(false)
  })
})
