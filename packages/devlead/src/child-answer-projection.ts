/**
 * Bounded, plain-JSON fold of the child inbox facts needed for answer
 * survival/discard reconstruction. The live service reads it through a
 * ProjectionHandle; a cold Session is prepared through `observeSession()` and
 * serves the same wire value. No raw Session-event reader is required.
 *
 * @module @yankeguo/dsh-devlead/child-answer-projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ProjectionDefinition,
  SessionProjectionSummaryExcluded,
} from '@deepseek-ai/dsh-session-projection'
import { DEVLEAD_MESSAGE_KIND } from '@yankeguo/dsh-devlead-protocol'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    /** Internal answer reconstruction; excluded from every Session summary. */
    devLeadChildAnswers: SessionProjectionSummaryExcluded<DevLeadChildAnswersState>
  }
}

/** Maximum retained observations per family before the fold becomes incomplete. */
export const DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX = 256

/** Answer correlation carried by one pending/claimed/cancelled inbox item. */
export interface ChildAnswerRef {
  readonly questionId: string
  readonly leadId: string
}

/** One pending inbox id and optional answer correlation. */
export interface ChildAnswerPendingItem {
  readonly id: string
  readonly answer?: ChildAnswerRef
}

/** One claimed or cancellation-candidate answer observation. */
export interface ChildAnswerTimedItem extends ChildAnswerRef {
  readonly id: string
  readonly at: number
}

/** One presented message observation. */
export interface ChildAnswerPresentedItem {
  readonly id: string
  readonly at: number
}

/** One discard fact derived by the replay fold. */
export interface ChildAnswerDiscardFact extends ChildAnswerRef {
  readonly messageId: string
  readonly at: number
  readonly seq: number
}

/** Families that evicted observations; only unresolvable messages are unknown. */
export interface DevLeadChildAnswerOverflow {
  readonly claimed: boolean
  readonly cancelCandidates: boolean
  readonly presented: boolean
  readonly discards: boolean
}

/** Complete Host/wire state of the bounded child-answer fold. */
export interface DevLeadChildAnswersState {
  readonly nextTurn: readonly ChildAnswerPendingItem[]
  readonly nextStep: readonly ChildAnswerPendingItem[]
  readonly claimed: readonly ChildAnswerTimedItem[]
  readonly cancelCandidates: readonly ChildAnswerTimedItem[]
  readonly presented: readonly ChildAnswerPresentedItem[]
  readonly discards: readonly ChildAnswerDiscardFact[]
  /** Per-family eviction markers; never a global liveness failure. */
  readonly overflow: DevLeadChildAnswerOverflow
}

/** Empty child-answer state. */
export function emptyDevLeadChildAnswersState(): DevLeadChildAnswersState {
  return {
    nextTurn: [],
    nextStep: [],
    claimed: [],
    cancelCandidates: [],
    presented: [],
    discards: [],
    overflow: { claimed: false, cancelCandidates: false, presented: false, discards: false },
  }
}

const answerRefSchema = zod.object({
  questionId: zod.string().min(1),
  leadId: zod.string().min(1),
}).strict()

const pendingSchema = zod.object({
  id: zod.string().min(1),
  answer: answerRefSchema.optional(),
}).strict()

const timedSchema = zod.object({
  id: zod.string().min(1),
  questionId: zod.string().min(1),
  leadId: zod.string().min(1),
  at: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

const presentedSchema = zod.object({
  id: zod.string().min(1),
  at: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

const discardSchema = zod.object({
  messageId: zod.string().min(1),
  questionId: zod.string().min(1),
  leadId: zod.string().min(1),
  at: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  seq: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

/** Exact state/wire schema, also used to validate a cold detached value. */
export const devLeadChildAnswersStateSchema: ZodType<DevLeadChildAnswersState> = zod.object({
  nextTurn: zod.array(pendingSchema),
  nextStep: zod.array(pendingSchema),
  claimed: zod.array(timedSchema),
  cancelCandidates: zod.array(timedSchema),
  presented: zod.array(presentedSchema),
  discards: zod.array(discardSchema),
  overflow: zod.object({
    claimed: zod.boolean(),
    cancelCandidates: zod.boolean(),
    presented: zod.boolean(),
    discards: zod.boolean(),
  }).strict(),
}).strict() as ZodType<DevLeadChildAnswersState>

/** Extract runtime-stamped answer metadata from one inserted message. */
function answerMetaOf(message: unknown): ChildAnswerRef | undefined {
  const source = (message as { source?: unknown } | null)?.source
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as { kind?: unknown; questionId?: unknown; senderSessionId?: unknown }
  if (record.kind !== DEVLEAD_MESSAGE_KIND) return undefined
  if (typeof record.questionId !== 'string' || record.questionId.length === 0) return undefined
  if (typeof record.senderSessionId !== 'string' || record.senderSessionId.length === 0) return undefined
  return { questionId: record.questionId, leadId: record.senderSessionId }
}

/** Return a new array without one id. */
function withoutId<T extends { readonly id: string }>(items: readonly T[], id: string): T[] {
  return items.filter(item => item.id !== id)
}

/** Upsert one bounded id-keyed observation and report only its family's overflow. */
function upsert<T extends { readonly id: string }>(
  items: readonly T[],
  value: T,
  overflow: boolean,
): { readonly items: T[]; readonly overflow: boolean } {
  const next = [...withoutId(items, value.id), value]
  if (next.length <= DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX) return { items: next, overflow }
  return { items: next.slice(next.length - DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX), overflow: true }
}

/**
 * Replay-mode fold. Cancellation remains a candidate until the end-of-log
 * finalizer, so a later restore revokes it. The live side effect adapter keeps
 * its existing immediate-discard semantics; this projection is the bootstrap
 * and cold-read authority.
 */
export function applyDevLeadChildAnswers(
  state: DevLeadChildAnswersState,
  event: SessionEvent,
): DevLeadChildAnswersState {
  if (event.type === 'agent/inbox/spliced') {
    const data = event.data as {
      target?: unknown
      start?: unknown
      removedCount?: unknown
      inserted?: unknown
      outcome?: unknown
    }
    const target = data.target === 'next-turn' ? 'nextTurn' : 'nextStep'
    const lane = state[target]
    const rawStart = typeof data.start === 'number' ? Math.trunc(data.start) : 0
    const start = Number.isNaN(rawStart) ? 0 : rawStart < 0 ? Math.max(lane.length + rawStart, 0) : Math.min(rawStart, lane.length)
    const rawCount = typeof data.removedCount === 'number' ? Math.trunc(data.removedCount) : 0
    const count = Math.min(Math.max(Number.isNaN(rawCount) ? 0 : rawCount, 0), lane.length - start)
    const inserted: ChildAnswerPendingItem[] = (Array.isArray(data.inserted) ? data.inserted : []).map((message) => {
      const id = String((message as { id?: unknown } | null)?.id ?? '')
      const answer = answerMetaOf(message)
      return { id, ...(answer === undefined ? {} : { answer }) }
    }).filter(item => item.id.length > 0)
    const removed = lane.slice(start, start + count)
    const nextLane = [...lane.slice(0, start), ...inserted, ...lane.slice(start + count)]
    let claimed = state.claimed
    let cancelCandidates = state.cancelCandidates
    let overflow = state.overflow
    for (const item of removed) {
      claimed = withoutId(claimed, item.id)
      if (item.answer === undefined) continue
      if (data.outcome === 'canceled') {
        const updated = upsert(cancelCandidates, { id: item.id, ...item.answer, at: event.time }, overflow.cancelCandidates)
        cancelCandidates = updated.items
        overflow = { ...overflow, cancelCandidates: updated.overflow }
      } else {
        const updated = upsert(claimed, { id: item.id, ...item.answer, at: event.time }, overflow.claimed)
        claimed = updated.items
        overflow = { ...overflow, claimed: updated.overflow }
      }
    }
    for (const item of inserted) {
      claimed = withoutId(claimed, item.id)
      cancelCandidates = withoutId(cancelCandidates, item.id)
    }
    return {
      ...state,
      [target]: nextLane,
      claimed,
      cancelCandidates,
      overflow,
    }
  }
  if (event.type === 'user/message') {
    const id = String((event.data as { id?: unknown } | null)?.id ?? '')
    if (id.length === 0) return state
    const answer = answerMetaOf(event.data)
    const related = answer !== undefined
      || state.claimed.some(item => item.id === id)
      || state.cancelCandidates.some(item => item.id === id)
    // Ordinary user messages do not consume the bounded answer-presentation
    // budget; otherwise a chatty child would permanently poison repair state.
    if (!related) return state
    const updated = upsert(state.presented, { id, at: event.time }, state.overflow.presented)
    return {
      ...state,
      claimed: withoutId(state.claimed, id),
      cancelCandidates: withoutId(state.cancelCandidates, id),
      presented: updated.items,
      overflow: { ...state.overflow, presented: updated.overflow },
    }
  }
  if (event.type === 'turn/end') {
    if (state.claimed.length === 0) return state
    const appended = state.claimed.map(item => ({
      messageId: item.id,
      questionId: item.questionId,
      leadId: item.leadId,
      at: event.time,
      seq: event.seq,
    }))
    const discards = [...state.discards, ...appended]
    return {
      ...state,
      claimed: [],
      discards: discards.length <= DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX
        ? discards
        : discards.slice(discards.length - DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX),
      overflow: {
        ...state.overflow,
        discards: state.overflow.discards || discards.length > DEVLEAD_CHILD_ANSWER_OBSERVATION_MAX,
      },
    }
  }
  return state
}

/** Registered bootstrap/cold projection. It is never included in summaries. */
export const devLeadChildAnswersProjectionDefinition = {
  key: 'devLeadChildAnswers',
  stateSchema: devLeadChildAnswersStateSchema,
  init: () => emptyDevLeadChildAnswersState(),
  apply: applyDevLeadChildAnswers,
  wire: {
    viewSchema: devLeadChildAnswersStateSchema,
    view: (state: DevLeadChildAnswersState) => state,
    summary: false,
  },
  stateVersion: 2,
} satisfies ProjectionDefinition<'devLeadChildAnswers', DevLeadChildAnswersState>

/** Pending-id lookup used by survival proofs. */
export function childAnswerPending(state: DevLeadChildAnswersState, messageId: string): boolean {
  return state.nextTurn.some(item => item.id === messageId) || state.nextStep.some(item => item.id === messageId)
}

/** Claim instant of one unsettled answer. */
export function childAnswerClaimedAt(state: DevLeadChildAnswersState, messageId: string): number | undefined {
  return state.claimed.find(item => item.id === messageId)?.at
}

/** Presentation instant of one answer. */
export function childAnswerPresentedAt(state: DevLeadChildAnswersState, messageId: string): number | undefined {
  return state.presented.find(item => item.id === messageId)?.at
}

/**
 * Whether an evicted family prevents this specific message's proof. Other
 * messages and later admissions continue normally; there is no global latch.
 */
export function childAnswerUnknown(state: DevLeadChildAnswersState, messageId: string): boolean {
  if (childAnswerPending(state, messageId)) return false
  if (childAnswerPresentedAt(state, messageId) !== undefined) return false
  if (childAnswerClaimedAt(state, messageId) !== undefined) return false
  return state.overflow.claimed
    || state.overflow.cancelCandidates
    || state.overflow.presented
    || state.overflow.discards
}

/** Finalize all replay-tail cancellation candidates without mutating the fold. */
export function finalizeDevLeadChildAnswerCandidates(state: DevLeadChildAnswersState): ChildAnswerDiscardFact[] {
  const lastSeq = state.discards.at(-1)?.seq ?? -1
  return state.cancelCandidates.map((item, index) => ({
    messageId: item.id,
    questionId: item.questionId,
    leadId: item.leadId,
    at: item.at,
    seq: lastSeq + index + 1,
  }))
}
