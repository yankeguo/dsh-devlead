/**
 * Pure message-passing policy for the DevLead message model.
 *
 * The model-facing vocabulary is a report kind, a turn category, or a prompt
 * intent. This module owns the mapping from that vocabulary and the observed
 * target state to an internal delivery plan. It deliberately has no runtime
 * imports, I/O, timers, or mutable module state; admission and lifecycle state
 * transitions remain outside the policy table.
 *
 * @module @yankeguo/dsh-devlead/message-policy
 */

/** Internal delivery paths. These are never model-selectable transport options. */
export type DeliveryLane = 'turn-notice' | 'action-required' | 'background'

/** DSH primitive selected by the policy, rather than by the model. */
export type DeliveryPrimitive = 'followup' | 'steer' | 'inject'

/** Inbox boundary at which the selected primitive admits a message. */
export type DeliveryBoundary = 'next-turn' | 'next-step'

/** Runtime state observed when the policy is evaluated. */
export type TargetState = 'running' | 'idle' | 'cold' | 'archived'

/** Child-to-lead message categories from the message model. */
export type ChildToLeadCategory = 'T1' | 'T2' | 'P1' | 'P2' | 'P3' | 'P4' | 'Q1' | 'Q2'

/** Turn transitions that classify as an ordinary settled turn. */
export type SettledTurnTransition = 'completed' | 'forked'

/** Turn transitions that require lead review. `error` is the runtime spelling of `failed`. */
export type FailedTurnTransition = 'failed' | 'error' | 'aborted' | 'blocked' | 'max-tokens' | 'interrupted'

/** Turn-end input accepted by the category classifier. */
export type ChildTurnTransition = SettledTurnTransition | FailedTurnTransition

/** Model-facing report kinds. An omitted kind has the safe `progress` default. */
export type ChildReportKind = 'progress' | 'fyi' | 'blocked' | 'decision' | 'question'

/** Model-facing lead-to-child intents. An omitted intent means `instruction`. */
export type LeadToChildIntent = 'instruction' | 'answer' | 'correction' | 'background'

/** Model-facing headers associated with child-to-lead delivery paths. */
export type DeliveryHeader =
  | '[DEV LEAD NOTIFICATION]'
  | '[DEV LEAD REVIEW REQUIRED]'
  | '[DEV LEAD ACTION REQUIRED]'
  | '[DEV LEAD QUESTION]'
  | '[DEV LEAD REPORT]'

/** Independent lifecycle of the question itself, not of one answer message. */
export type QuestionStatus = 'open' | 'answered' | 'expired' | 'cancelled'

/** Inbox lifecycle of one answer message. Only `presented` is delivery completion. */
export type AnswerStatus = 'admitted' | 'claimed' | 'presented' | 'discarded' | 'failed'

/**
 * Question facts needed for answer admission, expressed as a type-level invariant.
 * An open question has no active answer; an answered question has an answer whose
 * inbox lifecycle is active. Expiry/cancellation is independent of that lifecycle.
 */
export type QuestionPolicyState =
  | { readonly questionStatus: 'open'; readonly answerStatus?: 'discarded' | 'failed' }
  | { readonly questionStatus: 'answered'; readonly answerStatus: 'admitted' | 'claimed' | 'presented' }
  | { readonly questionStatus: 'expired' | 'cancelled'; readonly answerStatus?: AnswerStatus }

/**
 * Facts used only to recognize a retry of an already admitted answer. A retry
 * replays only when `sameText` is true (the answer text matches); a matching
 * `sameIdempotencyKey` with the same text is recognized as a key replay. A
 * different text is a conflict even when the key matches.
 */
export interface AnswerRetryPolicy {
  readonly sameIdempotencyKey?: boolean
  readonly sameText?: boolean
}

/** Non-delivery explanation for a rejected lead-to-child request. */
export type DeliveryRejectionReason =
  | 'answer-question-id-required'
  | 'question-id-not-allowed'
  | 'background-question-id'
  | 'background-interrupt'
  | 'question-not-found'
  | 'question-not-open'
  | 'question-already-answered'
  | 'target-archived'
  | 'background-cold-target'

/** Reason a child-to-lead message remains only in the durable digest. */
export type DigestOnlyReason = 'cold-background' | 'cold-lead-wake-disabled' | 'archived-lead'

/** Operational semantics that callers must preserve without putting them in tool schemas. */
export type DeliveryDiagnostic =
  | 'cold-resume-required'
  | 'next-turn-wake-not-guaranteed'
  | 'next-step-does-not-preempt'
  | 'next-step-does-not-isolate'
  | 'background-does-not-request-wake'
  | 'interrupt-overrides-intent'
  | 'digest-only-fallback'
  | 'question-nondurable-fallback'

/** Common fields of an executable plan. This is a plan, not an admission receipt. */
export interface PlannedDelivery {
  readonly status: 'planned'
  readonly lane: DeliveryLane
  readonly primitive: DeliveryPrimitive
  readonly boundary: DeliveryBoundary
  readonly wakeRequested: boolean
  readonly resumeRequired: boolean
  readonly cancelRequested: boolean
  readonly turnEndRequested: boolean
  readonly header: DeliveryHeader | null
  readonly diagnostics: readonly DeliveryDiagnostic[]
}

/** No inbox primitive is invoked; the caller retains the digest fallback. */
export interface DigestOnlyDelivery {
  readonly status: 'digest-only'
  readonly lane: DeliveryLane
  readonly primitive: null
  readonly boundary: null
  readonly wakeRequested: false
  readonly resumeRequired: false
  readonly cancelRequested: false
  readonly turnEndRequested: boolean
  readonly header: null
  readonly reason: DigestOnlyReason
  readonly diagnostics: readonly DeliveryDiagnostic[]
}

/** A recognized answer retry returns its original receipt without another delivery. */
export interface IdempotentReplayDelivery {
  readonly status: 'idempotent-replay'
  readonly lane: 'action-required'
  readonly primitive: null
  readonly boundary: null
  readonly wakeRequested: false
  readonly resumeRequired: false
  readonly cancelRequested: false
  readonly turnEndRequested: false
  readonly header: null
  readonly reason: 'same-idempotency-key' | 'same-text'
  readonly diagnostics: readonly []
}

/** A request that must not invoke resume, cancel, or an inbox primitive. */
export interface RejectedDelivery {
  readonly status: 'rejected'
  readonly lane: null
  readonly primitive: null
  readonly boundary: null
  readonly wakeRequested: false
  readonly resumeRequired: false
  readonly cancelRequested: false
  readonly turnEndRequested: false
  readonly header: null
  readonly reason: DeliveryRejectionReason
  readonly diagnostics: readonly []
}

/** Result of evaluating either direction of the pure policy table. */
export type DeliveryPlan =
  | PlannedDelivery
  | DigestOnlyDelivery
  | IdempotentReplayDelivery
  | RejectedDelivery

/** Input for the child-to-lead category/state matrix. */
export interface ChildToLeadPolicyInput {
  readonly category: ChildToLeadCategory
  readonly targetState: TargetState
  /** Defaults to true, matching the existing cold-lead configuration default. */
  readonly wakeColdSession?: boolean
  /** Q1 requests turn end only after durable report persistence. Defaults to true. */
  readonly durable?: boolean
}

/** Report-specific input; omitting `kind` exercises the safe progress default. */
export interface ChildReportPolicyInput extends Omit<ChildToLeadPolicyInput, 'category'> {
  readonly kind?: ChildReportKind
}

/** Input for the lead-to-child intent/state matrix and combination guards. */
export interface LeadToChildPolicyInput {
  readonly targetState: TargetState
  readonly intent?: LeadToChildIntent
  readonly interrupt?: boolean
  readonly questionId?: string
  readonly question?: QuestionPolicyState
  readonly answerRetry?: AnswerRetryPolicy
}

interface PolicyRow {
  readonly lane: DeliveryLane
  readonly primitive: DeliveryPrimitive
  readonly boundary: DeliveryBoundary
  readonly wakeRequested: boolean
  readonly header: DeliveryHeader | null
}

/** The transport-invariant portion of every child-to-lead category. */
const CHILD_POLICIES: Readonly<Record<ChildToLeadCategory, PolicyRow>> = {
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

/** Classify a settled or failed turn without inferring prose questions. */
export function childTurnCategory(transition: ChildTurnTransition): 'T1' | 'T2' {
  return transition === 'completed' || transition === 'forked' ? 'T1' : 'T2'
}

/**
 * Internal delivery lane of one report kind, derived purely from the policy
 * table. This is a diagnostic projection (read-tool output), never a
 * model-selectable transport option.
 */
export function childReportLane(kind: ChildReportKind = 'progress'): DeliveryLane {
  return CHILD_POLICIES[childReportCategory(kind)].lane
}

/** Classify a report kind, including the no-kind safe default. */
export function childReportCategory(kind: ChildReportKind = 'progress'): ChildToLeadCategory {
  switch (kind) {
    case 'progress': return 'P1'
    case 'fyi': return 'P2'
    case 'blocked': return 'P3'
    case 'decision': return 'P4'
    case 'question': return 'Q1'
  }
}

function planned(
  row: PolicyRow,
  targetState: Exclude<TargetState, 'archived'>,
  turnEndRequested: boolean,
  cancel = false,
  interruptOverridesIntent = false,
): PlannedDelivery {
  const diagnostics: DeliveryDiagnostic[] = []
  if (targetState === 'cold') diagnostics.push('cold-resume-required')
  if (row.primitive === 'followup') diagnostics.push('next-turn-wake-not-guaranteed')
  if (row.primitive === 'steer') diagnostics.push('next-step-does-not-preempt', 'next-step-does-not-isolate')
  if (row.primitive === 'inject') diagnostics.push('background-does-not-request-wake')
  if (interruptOverridesIntent) diagnostics.push('interrupt-overrides-intent')
  return {
    status: 'planned',
    ...row,
    resumeRequired: targetState === 'cold',
    cancelRequested: cancel && targetState === 'running',
    turnEndRequested,
    diagnostics,
  }
}

function digestOnly(
  row: PolicyRow,
  reason: DigestOnlyReason,
  turnEndRequested: boolean,
  durable: boolean,
  category: ChildToLeadCategory,
): DigestOnlyDelivery {
  const diagnostics: DeliveryDiagnostic[] = ['digest-only-fallback']
  if (category === 'Q1' && !durable) diagnostics.push('question-nondurable-fallback')
  return {
    status: 'digest-only',
    lane: row.lane,
    primitive: null,
    boundary: null,
    wakeRequested: false,
    resumeRequired: false,
    cancelRequested: false,
    turnEndRequested,
    header: null,
    reason,
    diagnostics,
  }
}

function rejected(reason: DeliveryRejectionReason): RejectedDelivery {
  return {
    status: 'rejected',
    lane: null,
    primitive: null,
    boundary: null,
    wakeRequested: false,
    resumeRequired: false,
    cancelRequested: false,
    turnEndRequested: false,
    header: null,
    reason,
    diagnostics: [],
  }
}

function idempotentReplay(reason: 'same-idempotency-key' | 'same-text'): IdempotentReplayDelivery {
  return {
    status: 'idempotent-replay',
    lane: 'action-required',
    primitive: null,
    boundary: null,
    wakeRequested: false,
    resumeRequired: false,
    cancelRequested: false,
    turnEndRequested: false,
    header: null,
    reason,
    diagnostics: [],
  }
}

/** Evaluate the complete child-to-lead category × target-state policy matrix. */
export function planChildToLead(input: ChildToLeadPolicyInput): DeliveryPlan {
  const row = CHILD_POLICIES[input.category]
  const durable = input.durable ?? true
  const turnEndRequested = input.category === 'Q1' && durable
  if (input.targetState === 'archived') {
    return digestOnly(row, 'archived-lead', turnEndRequested, durable, input.category)
  }
  if (input.targetState === 'cold') {
    if (input.category === 'P1' || input.category === 'P2') {
      return digestOnly(row, 'cold-background', false, durable, input.category)
    }
    if (input.wakeColdSession === false) {
      return digestOnly(row, 'cold-lead-wake-disabled', turnEndRequested, durable, input.category)
    }
  }
  const result = planned(row, input.targetState, turnEndRequested)
  if (input.category === 'Q1' && !durable) {
    return { ...result, diagnostics: [...result.diagnostics, 'question-nondurable-fallback'] }
  }
  return result
}

/** Evaluate a report after applying the model-facing kind default. */
export function planChildReport(input: ChildReportPolicyInput): DeliveryPlan {
  return planChildToLead({ ...input, category: childReportCategory(input.kind) })
}

function leadRow(intent: LeadToChildIntent, interrupt: boolean): PolicyRow {
  if (interrupt) {
    return {
      lane: intent === 'instruction' ? 'turn-notice' : 'action-required',
      primitive: 'followup',
      boundary: 'next-turn',
      wakeRequested: true,
      header: null,
    }
  }
  switch (intent) {
    case 'instruction':
      return {
        lane: 'turn-notice', primitive: 'followup', boundary: 'next-turn', wakeRequested: true, header: null,
      }
    case 'answer':
    case 'correction':
      return {
        lane: 'action-required', primitive: 'steer', boundary: 'next-step', wakeRequested: true, header: null,
      }
    case 'background':
      return {
        lane: 'background', primitive: 'inject', boundary: 'next-step', wakeRequested: false, header: null,
      }
  }
}

/** Evaluate intent guards, question admission, and the lead-to-child policy matrix. */
export function planLeadToChild(input: LeadToChildPolicyInput): DeliveryPlan {
  const intent = input.intent ?? 'instruction'
  const interrupt = input.interrupt ?? false
  const hasQuestionId = input.questionId !== undefined && input.questionId.length > 0

  if (intent === 'answer' && !hasQuestionId) return rejected('answer-question-id-required')
  if (intent === 'background' && hasQuestionId) return rejected('background-question-id')
  if (intent !== 'answer' && intent !== 'background' && hasQuestionId) {
    return rejected('question-id-not-allowed')
  }
  if (intent === 'background' && interrupt) return rejected('background-interrupt')

  if (intent === 'answer') {
    if (input.question === undefined) return rejected('question-not-found')
    if (input.question.questionStatus === 'expired' || input.question.questionStatus === 'cancelled') {
      return rejected('question-not-open')
    }
    if (input.question.questionStatus === 'answered') {
      // An idempotent retry must carry the SAME answer text. A matching key with
      // the same text is a key replay; the same text alone is a text replay. A
      // different text is always a conflict, even under the same idempotency key
      // (the key never authorizes a different answer).
      if (input.answerRetry?.sameText === true) {
        return idempotentReplay(input.answerRetry.sameIdempotencyKey === true ? 'same-idempotency-key' : 'same-text')
      }
      return rejected('question-already-answered')
    }
  }

  if (input.targetState === 'archived') return rejected('target-archived')
  if (intent === 'background' && input.targetState === 'cold') return rejected('background-cold-target')

  const row = leadRow(intent, interrupt)
  return planned(row, input.targetState, false, interrupt, interrupt && intent !== 'instruction')
}
