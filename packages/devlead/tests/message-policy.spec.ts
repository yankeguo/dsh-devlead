/**
 * Exhaustive pure coverage of the message-passing policy table. These tests
 * construct only values: no Session, service, timer, storage, or tool schema is
 * involved, and no answer/question lifecycle transition is implemented here.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  childReportCategory,
  childTurnCategory,
  planChildReport,
  planChildToLead,
  planLeadToChild,
} from '../src/message-policy.ts'
import type {
  AnswerStatus,
  ChildReportKind,
  ChildToLeadCategory,
  DeliveryBoundary,
  DeliveryHeader,
  DeliveryLane,
  DeliveryPlan,
  DeliveryPrimitive,
  FailedTurnTransition,
  LeadToChildIntent,
  LeadToChildPolicyInput,
  PlannedDelivery,
  QuestionPolicyState,
  TargetState,
} from '../src/message-policy.ts'

const CATEGORIES = ['T1', 'T2', 'P1', 'P2', 'P3', 'P4', 'Q1', 'Q2'] as const
const LIVE_STATES = ['running', 'idle', 'cold'] as const

interface ExpectedTransport {
  readonly lane: DeliveryLane
  readonly primitive: DeliveryPrimitive
  readonly boundary: DeliveryBoundary
  readonly wakeRequested: boolean
  readonly header: DeliveryHeader
}

/** Independent expected values, rather than expectations derived from the implementation table. */
const CHILD_TRANSPORTS: Readonly<Record<ChildToLeadCategory, ExpectedTransport>> = {
  T1: {
    lane: 'turn-notice', primitive: 'followup', boundary: 'next-turn', wakeRequested: true,
    header: '[DEV LEAD NOTIFICATION]',
  },
  T2: {
    lane: 'action-required', primitive: 'steer', boundary: 'next-step', wakeRequested: true,
    header: '[DEV LEAD REVIEW REQUIRED]',
  },
  P1: {
    lane: 'background', primitive: 'inject', boundary: 'next-step', wakeRequested: false,
    header: '[DEV LEAD REPORT]',
  },
  P2: {
    lane: 'background', primitive: 'inject', boundary: 'next-step', wakeRequested: false,
    header: '[DEV LEAD REPORT]',
  },
  P3: {
    lane: 'action-required', primitive: 'steer', boundary: 'next-step', wakeRequested: true,
    header: '[DEV LEAD ACTION REQUIRED]',
  },
  P4: {
    lane: 'action-required', primitive: 'steer', boundary: 'next-step', wakeRequested: true,
    header: '[DEV LEAD ACTION REQUIRED]',
  },
  Q1: {
    lane: 'action-required', primitive: 'steer', boundary: 'next-step', wakeRequested: true,
    header: '[DEV LEAD QUESTION]',
  },
  Q2: {
    lane: 'turn-notice', primitive: 'followup', boundary: 'next-turn', wakeRequested: true,
    header: '[DEV LEAD NOTIFICATION]',
  },
}

const CHILD_MATRIX = CATEGORIES.flatMap(category => LIVE_STATES.map(targetState => ({
  category,
  targetState,
  expected: CHILD_TRANSPORTS[category],
})))

/** Narrow a result after asserting that it is executable. */
function expectPlanned(plan: DeliveryPlan): PlannedDelivery {
  expect(plan.status).toBe('planned')
  if (plan.status !== 'planned') throw new Error(`expected planned delivery, got ${plan.status}`)
  return plan
}

/** Canonical open-question facts for answer planning. */
function openQuestion(answerStatus?: 'discarded' | 'failed'): QuestionPolicyState {
  return answerStatus === undefined ? { questionStatus: 'open' } : { questionStatus: 'open', answerStatus }
}

/** Canonical answered-question facts for retry/different-answer guards. */
function answeredQuestion(answerStatus: 'admitted' | 'claimed' | 'presented'): QuestionPolicyState {
  return { questionStatus: 'answered', answerStatus }
}

/** Answer input that satisfies the two required references before state planning. */
function answerInput(targetState: TargetState, extra: Partial<LeadToChildPolicyInput> = {}): LeadToChildPolicyInput {
  return {
    targetState,
    intent: 'answer',
    questionId: 'child-1:4:report:question:abc',
    question: openQuestion(),
    ...extra,
  }
}

describe('child category classifiers', () => {
  it('maps completed/forked to T1 and every failed transition to T2', () => {
    expect(childTurnCategory('completed')).toBe('T1')
    expect(childTurnCategory('forked')).toBe('T1')
    const failed: readonly FailedTurnTransition[] = [
      'failed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted',
    ]
    for (const transition of failed) expect(childTurnCategory(transition)).toBe('T2')
  })

  it('maps all report kinds and defaults an omitted kind to non-waking progress', () => {
    const expected: Readonly<Record<ChildReportKind, ChildToLeadCategory>> = {
      progress: 'P1', fyi: 'P2', blocked: 'P3', decision: 'P4', question: 'Q1',
    }
    for (const [kind, category] of Object.entries(expected)) {
      expect(childReportCategory(kind as ChildReportKind)).toBe(category)
    }
    expect(childReportCategory()).toBe('P1')
    expect(expectPlanned(planChildReport({ targetState: 'idle' }))).toMatchObject({
      lane: 'background', primitive: 'inject', boundary: 'next-step', wakeRequested: false,
      header: '[DEV LEAD REPORT]',
    })
  })
})

describe('child-to-lead full matrix', () => {
  it.each(CHILD_MATRIX)('$category × $targetState', ({ category, targetState, expected }) => {
    const plan = planChildToLead({ category, targetState })
    if (targetState === 'cold' && (category === 'P1' || category === 'P2')) {
      expect(plan).toMatchObject({
        status: 'digest-only', lane: expected.lane, primitive: null, boundary: null,
        wakeRequested: false, resumeRequired: false, cancelRequested: false,
        turnEndRequested: false, header: null, reason: 'cold-background',
      })
      return
    }
    expect(expectPlanned(plan)).toMatchObject({
      ...expected,
      resumeRequired: targetState === 'cold',
      cancelRequested: false,
      turnEndRequested: category === 'Q1',
    })
  })

  it.each(CATEGORIES)('%s × archived lead retains only the digest', category => {
    const plan = planChildToLead({ category, targetState: 'archived' })
    expect(plan).toMatchObject({
      status: 'digest-only', lane: CHILD_TRANSPORTS[category].lane,
      primitive: null, boundary: null, wakeRequested: false,
      resumeRequired: false, cancelRequested: false,
      turnEndRequested: category === 'Q1', header: null, reason: 'archived-lead',
    })
  })

  it.each(CATEGORIES)('%s × cold lead with wake disabled never resumes or sends', category => {
    const plan = planChildToLead({ category, targetState: 'cold', wakeColdSession: false })
    expect(plan).toMatchObject({
      status: 'digest-only', lane: CHILD_TRANSPORTS[category].lane,
      primitive: null, boundary: null, wakeRequested: false,
      resumeRequired: false, cancelRequested: false,
      turnEndRequested: category === 'Q1', header: null,
      reason: category === 'P1' || category === 'P2' ? 'cold-background' : 'cold-lead-wake-disabled',
    })
  })

  it('keeps natural-language Q2 on turn-notice instead of upgrading it to steer', () => {
    for (const targetState of LIVE_STATES) {
      expect(expectPlanned(planChildToLead({ category: 'Q2', targetState }))).toMatchObject({
        lane: 'turn-notice', primitive: 'followup', boundary: 'next-turn', wakeRequested: true,
      })
    }
  })

  it('preserves immediate-scheduling semantics without claiming steer preempts or isolates', () => {
    for (const category of ['T2', 'P3', 'P4', 'Q1'] as const) {
      const plan = expectPlanned(planChildToLead({ category, targetState: 'running' }))
      expect(plan.diagnostics).toContain('next-step-does-not-preempt')
      expect(plan.diagnostics).toContain('next-step-does-not-isolate')
    }
  })
})

describe('Q1 durable fallback policy', () => {
  it.each(LIVE_STATES)('requests turn end for durable questions at %s lead state', targetState => {
    expect(expectPlanned(planChildReport({ kind: 'question', targetState, durable: true }))).toMatchObject({
      turnEndRequested: true,
    })
  })

  it.each(LIVE_STATES)('does not request turn end for a non-durable question at %s lead state', targetState => {
    const plan = expectPlanned(planChildReport({ kind: 'question', targetState, durable: false }))
    expect(plan.turnEndRequested).toBe(false)
    expect(plan.diagnostics).toContain('question-nondurable-fallback')
  })

  it.each(['cold', 'archived'] as const)('retains the durable-only turn-end rule during %s fallback', targetState => {
    const durable = planChildReport({ kind: 'question', targetState, durable: true, wakeColdSession: false })
    const nonDurable = planChildReport({ kind: 'question', targetState, durable: false, wakeColdSession: false })
    expect(durable).toMatchObject({ status: 'digest-only', turnEndRequested: true })
    expect(nonDurable).toMatchObject({ status: 'digest-only', turnEndRequested: false })
    expect(nonDurable.diagnostics).toContain('question-nondurable-fallback')
  })
})

interface LeadMatrixCase {
  readonly intent: LeadToChildIntent
  readonly input: (targetState: TargetState) => LeadToChildPolicyInput
  readonly expected: Omit<ExpectedTransport, 'header'>
}

const LEAD_INTENTS: readonly LeadMatrixCase[] = [
  {
    intent: 'instruction',
    input: targetState => ({ targetState }),
    expected: {
      lane: 'turn-notice', primitive: 'followup', boundary: 'next-turn', wakeRequested: true,
    },
  },
  {
    intent: 'answer',
    input: targetState => answerInput(targetState),
    expected: {
      lane: 'action-required', primitive: 'steer', boundary: 'next-step', wakeRequested: true,
    },
  },
  {
    intent: 'correction',
    input: targetState => ({ targetState, intent: 'correction' }),
    expected: {
      lane: 'action-required', primitive: 'steer', boundary: 'next-step', wakeRequested: true,
    },
  },
  {
    intent: 'background',
    input: targetState => ({ targetState, intent: 'background' }),
    expected: {
      lane: 'background', primitive: 'inject', boundary: 'next-step', wakeRequested: false,
    },
  },
]

const LEAD_MATRIX = LEAD_INTENTS.flatMap(testCase => LIVE_STATES.map(targetState => ({
  ...testCase,
  targetState,
})))

describe('lead-to-child full matrix', () => {
  it.each(LEAD_MATRIX)('$intent × $targetState', ({ input, targetState, expected, intent }) => {
    const plan = planLeadToChild(input(targetState))
    if (intent === 'background' && targetState === 'cold') {
      expect(plan).toMatchObject({ status: 'rejected', reason: 'background-cold-target' })
      return
    }
    expect(expectPlanned(plan)).toMatchObject({
      ...expected,
      resumeRequired: targetState === 'cold',
      cancelRequested: false,
      turnEndRequested: false,
      header: null,
    })
  })

  it.each(LEAD_INTENTS)('$intent × archived target is rejected without delivery', ({ input }) => {
    expect(planLeadToChild(input('archived'))).toEqual({
      status: 'rejected', lane: null, primitive: null, boundary: null,
      wakeRequested: false, resumeRequired: false, cancelRequested: false,
      turnEndRequested: false, header: null, reason: 'target-archived', diagnostics: [],
    })
  })

  it('uses instruction/followup when intent and interrupt are omitted', () => {
    expect(expectPlanned(planLeadToChild({ targetState: 'running' }))).toMatchObject({
      lane: 'turn-notice', primitive: 'followup', boundary: 'next-turn', wakeRequested: true,
      resumeRequired: false, cancelRequested: false,
    })
  })

  it('keeps idle answer/correction on next-step while warning that it is not isolation', () => {
    for (const input of [answerInput('idle'), { targetState: 'idle', intent: 'correction' } as const]) {
      const plan = expectPlanned(planLeadToChild(input))
      expect(plan).toMatchObject({ primitive: 'steer', boundary: 'next-step', wakeRequested: true })
      expect(plan.diagnostics).toContain('next-step-does-not-preempt')
      expect(plan.diagnostics).toContain('next-step-does-not-isolate')
    }
  })

  it('queues idle background without requesting wake', () => {
    const plan = expectPlanned(planLeadToChild({ targetState: 'idle', intent: 'background' }))
    expect(plan).toMatchObject({ primitive: 'inject', boundary: 'next-step', wakeRequested: false })
    expect(plan.diagnostics).toContain('background-does-not-request-wake')
  })
})

const INTERRUPT_MATRIX = (['instruction', 'answer', 'correction'] as const).flatMap(intent => (
  LIVE_STATES.map(targetState => ({ intent, targetState }))
))

describe('interrupt override matrix', () => {
  it.each(INTERRUPT_MATRIX)('$intent + interrupt × $targetState', ({ intent, targetState }) => {
    const input: LeadToChildPolicyInput = intent === 'answer'
      ? answerInput(targetState, { interrupt: true })
      : { targetState, intent, interrupt: true }
    const plan = expectPlanned(planLeadToChild(input))
    expect(plan).toMatchObject({
      lane: intent === 'instruction' ? 'turn-notice' : 'action-required',
      primitive: 'followup', boundary: 'next-turn', wakeRequested: true,
      resumeRequired: targetState === 'cold',
      cancelRequested: targetState === 'running',
      turnEndRequested: false,
    })
    if (intent === 'instruction') expect(plan.diagnostics).not.toContain('interrupt-overrides-intent')
    else expect(plan.diagnostics).toContain('interrupt-overrides-intent')
  })

  it.each(['instruction', 'answer', 'correction'] as const)('%s + interrupt × archived is rejected', intent => {
    const input: LeadToChildPolicyInput = intent === 'answer'
      ? answerInput('archived', { interrupt: true })
      : { targetState: 'archived', intent, interrupt: true }
    expect(planLeadToChild(input)).toMatchObject({ status: 'rejected', reason: 'target-archived' })
  })
})

describe('illegal lead-to-child combinations', () => {
  const cases: Array<{
    readonly name: string
    readonly input: LeadToChildPolicyInput
    readonly reason: string
  }> = [
    {
      name: 'answer without question_id',
      input: { targetState: 'running', intent: 'answer', question: openQuestion() },
      reason: 'answer-question-id-required',
    },
    {
      name: 'answer with an empty question_id',
      input: answerInput('running', { questionId: '' }),
      reason: 'answer-question-id-required',
    },
    {
      name: 'instruction with question_id',
      input: { targetState: 'running', questionId: 'q1' },
      reason: 'question-id-not-allowed',
    },
    {
      name: 'correction with question_id',
      input: { targetState: 'running', intent: 'correction', questionId: 'q1' },
      reason: 'question-id-not-allowed',
    },
    {
      name: 'background with question_id',
      input: { targetState: 'running', intent: 'background', questionId: 'q1' },
      reason: 'background-question-id',
    },
    {
      name: 'background with interrupt',
      input: { targetState: 'running', intent: 'background', interrupt: true },
      reason: 'background-interrupt',
    },
    {
      name: 'answer whose question report is absent',
      input: {
        targetState: 'running', intent: 'answer', questionId: 'child-1:4:report:question:abc',
      },
      reason: 'question-not-found',
    },
  ]

  it.each(cases)('$name', ({ input, reason }) => {
    expect(planLeadToChild(input)).toEqual({
      status: 'rejected', lane: null, primitive: null, boundary: null,
      wakeRequested: false, resumeRequired: false, cancelRequested: false,
      turnEndRequested: false, header: null, reason, diagnostics: [],
    })
  })

  it('makes answer + correction unrepresentable as one intent', () => {
    expectTypeOf<LeadToChildIntent>().toEqualTypeOf<'instruction' | 'answer' | 'correction' | 'background'>()
    expectTypeOf<DeliveryLane>().toEqualTypeOf<'turn-notice' | 'action-required' | 'background'>()
  })
})

describe('question and answer admission constraints', () => {
  it.each([undefined, 'discarded', 'failed'] as const)('accepts a new answer while open (answerStatus=%s)', answerStatus => {
    expect(expectPlanned(planLeadToChild(answerInput('running', {
      question: openQuestion(answerStatus),
    })))).toMatchObject({ primitive: 'steer', boundary: 'next-step' })
  })

  it.each(['admitted', 'claimed', 'presented'] as const)('rejects different text for an answered question (%s)', answerStatus => {
    expect(planLeadToChild(answerInput('running', {
      question: answeredQuestion(answerStatus),
      answerRetry: { sameIdempotencyKey: false, sameText: false },
    }))).toMatchObject({ status: 'rejected', reason: 'question-already-answered' })
  })

  it.each(['admitted', 'claimed', 'presented'] as const)('replays the same idempotency key without redelivery (%s)', answerStatus => {
    const plan = planLeadToChild(answerInput('running', {
      question: answeredQuestion(answerStatus),
      answerRetry: { sameIdempotencyKey: true, sameText: false },
    }))
    expect(plan).toEqual({
      status: 'idempotent-replay', lane: 'action-required', primitive: null, boundary: null,
      wakeRequested: false, resumeRequired: false, cancelRequested: false,
      turnEndRequested: false, header: null, reason: 'same-idempotency-key', diagnostics: [],
    })
  })

  it('replays identical answer text without claiming that the answer was presented', () => {
    const plan = planLeadToChild(answerInput('running', {
      question: answeredQuestion('admitted'),
      answerRetry: { sameIdempotencyKey: false, sameText: true },
    }))
    expect(plan).toMatchObject({
      status: 'idempotent-replay', primitive: null, reason: 'same-text',
    })
  })

  it.each(['expired', 'cancelled'] as const)('rejects an answer to a %s question', questionStatus => {
    expect(planLeadToChild(answerInput('running', {
      question: { questionStatus },
      answerRetry: { sameIdempotencyKey: true, sameText: true },
    }))).toMatchObject({ status: 'rejected', reason: 'question-not-open' })
  })

  it('validates an answered question before applying interrupt delivery', () => {
    expect(planLeadToChild(answerInput('running', {
      interrupt: true,
      question: answeredQuestion('presented'),
    }))).toMatchObject({ status: 'rejected', reason: 'question-already-answered' })
  })

  it('encodes independent questionStatus/answerStatus invariants at the type level', () => {
    expectTypeOf<AnswerStatus>().toEqualTypeOf<'admitted' | 'claimed' | 'presented' | 'discarded' | 'failed'>()
    // @ts-expect-error An answered question requires an active answer lifecycle.
    const missingAnswer: QuestionPolicyState = { questionStatus: 'answered' }
    // @ts-expect-error An open question cannot have an active answer lifecycle.
    const activeOpen: QuestionPolicyState = { questionStatus: 'open', answerStatus: 'presented' }
    void [missingAnswer, activeOpen]
  })
})

describe('purity', () => {
  it('does not mutate policy inputs', () => {
    const childInput = { category: 'Q1', targetState: 'cold', durable: false } as const
    const leadInput = answerInput('running', {
      interrupt: true,
      answerRetry: { sameText: false },
    })
    const childSnapshot = { ...childInput }
    const leadSnapshot = { ...leadInput, question: { ...leadInput.question }, answerRetry: { ...leadInput.answerRetry } }
    planChildToLead(childInput)
    planLeadToChild(leadInput)
    expect(childInput).toEqual(childSnapshot)
    expect(leadInput).toEqual(leadSnapshot)
  })
})
