/**
 * Small Host-only Session projections replacing deprecated synchronous log
 * readers. DSH drives these pure folds over committed events (including a
 * restored log), so callers get synchronous, bounded state without
 * `Session.snapshotEvents()` / `eventAt()` / `ownEvents()`.
 *
 * @module @yankeguo/dsh-devlead/runtime-projections
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { DEVLEAD_MESSAGE_KIND } from '@yankeguo/dsh-devlead-protocol'

/** Source kinds that record a direct human action in the current turn. */
const HUMAN_SOURCE_KINDS = new Set(['user', 'user-question-reply', 'user-approval'])

/** Source kinds that are injected context rather than an actionable prompt. */
const NON_ACTIONABLE_SOURCE_KINDS = new Set([
  'runtime-context',
  'tool-registry',
  'time-context',
  'tmux-context',
  'agent-instructions',
  'working-directory',
  'ptc-mode',
  'plan-mode',
  'session-reference',
  'action-cards',
  'webhook',
])

/** Prefixes of plugin-injected context sources. */
const NON_ACTIONABLE_SOURCE_PREFIXES = ['hooks-']

/** Context forms that identify injected rather than actionable content. */
const NON_ACTIONABLE_SOURCE_FORMS = new Set([
  'instructions',
  'catalog',
  'snapshot',
  'notice',
  'recall',
  'relay',
])

/** Minimal turn-source state folded from the current turn's user messages. */
export interface DevLeadTurnSourceState {
  /** Sequence of the latest turn/start, or null before the first turn. */
  readonly openTurnStartSeq: number | null
  /** Whether the latest actionable user message came directly from a human. */
  readonly humanDirected: boolean
}

/** Empty turn-source state. */
export function emptyDevLeadTurnSourceState(): DevLeadTurnSourceState {
  return { openTurnStartSeq: null, humanDirected: false }
}

const turnSourceStateSchema: ZodType<DevLeadTurnSourceState> = zod.object({
  openTurnStartSeq: zod.number().int().nonnegative().nullable(),
  humanDirected: zod.boolean(),
}).strict() as ZodType<DevLeadTurnSourceState>

/**
 * Fold one event into the latest actionable-source decision. DevLead
 * background notices are non-actionable and deliberately do not mask an
 * earlier human prompt; every other DevLead relay/notice is lead-directed.
 */
export function applyDevLeadTurnSource(
  state: DevLeadTurnSourceState,
  event: SessionEvent,
): DevLeadTurnSourceState {
  if (event.type === 'turn/start') {
    return { openTurnStartSeq: event.seq, humanDirected: false }
  }
  if (event.type !== 'user/message' || state.openTurnStartSeq === null) return state
  const source = (event.data as {
    source?: { kind?: unknown; form?: unknown; lane?: unknown; wakeRequested?: unknown }
  } | undefined)?.source
  const kind = source?.kind
  if (typeof kind !== 'string') return { ...state, humanDirected: false }
  if (kind === DEVLEAD_MESSAGE_KIND) {
    const background = source?.form === 'notice'
      && source?.wakeRequested === false
      && source?.lane === 'background'
    return background ? state : { ...state, humanDirected: false }
  }
  if (NON_ACTIONABLE_SOURCE_KINDS.has(kind)
    || NON_ACTIONABLE_SOURCE_PREFIXES.some(prefix => kind.startsWith(prefix))) return state
  const form = source?.form
  if (typeof form === 'string' && NON_ACTIONABLE_SOURCE_FORMS.has(form)) return state
  return { ...state, humanDirected: HUMAN_SOURCE_KINDS.has(kind) }
}

/**
 * Evaluate an explicit event sequence, useful for offline tests and callers
 * that already received a public Session-query snapshot. Production live
 * callers use the registered projection instead of materializing a log.
 */
export function isHumanDirectedTurn(events: readonly SessionEvent[]): boolean {
  let state = emptyDevLeadTurnSourceState()
  for (const event of events) state = applyDevLeadTurnSource(state, event)
  return state.humanDirected
}

/** Host-only latest-turn source projection. */
export const devLeadTurnSourceProjectionDefinition = {
  key: 'devLeadTurnSource',
  stateSchema: turnSourceStateSchema,
  init: () => emptyDevLeadTurnSourceState(),
  apply: applyDevLeadTurnSource,
  stateVersion: 1,
} satisfies ProjectionDefinition<string, DevLeadTurnSourceState>

/** One pending inbox identity and its durable enqueue instant. */
interface InboxTimeItem {
  readonly id: string
  readonly at: number
}

/** Current pending inbox identities and enqueue instants, bounded by the inbox. */
export interface DevLeadInboxTimesState {
  readonly nextTurn: readonly InboxTimeItem[]
  readonly nextStep: readonly InboxTimeItem[]
}

/** Empty inbox-time state. */
export function emptyDevLeadInboxTimesState(): DevLeadInboxTimesState {
  return { nextTurn: [], nextStep: [] }
}

const inboxTimeItemSchema = zod.object({
  id: zod.string().min(1),
  at: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

const inboxTimesStateSchema: ZodType<DevLeadInboxTimesState> = zod.object({
  nextTurn: zod.array(inboxTimeItemSchema),
  nextStep: zod.array(inboxTimeItemSchema),
}).strict() as ZodType<DevLeadInboxTimesState>

/** Apply the Host's array-splice contract to one inbox-time lane. */
function spliceLane(
  lane: readonly InboxTimeItem[],
  event: SessionEvent & { type: 'agent/inbox/spliced' },
): readonly InboxTimeItem[] {
  const data = event.data as {
    start?: unknown
    removedCount?: unknown
    inserted?: unknown
  }
  const rawStart = typeof data.start === 'number' ? Math.trunc(data.start) : 0
  const start = Number.isNaN(rawStart) ? 0 : rawStart < 0 ? Math.max(lane.length + rawStart, 0) : Math.min(rawStart, lane.length)
  const rawCount = typeof data.removedCount === 'number' ? Math.trunc(data.removedCount) : 0
  const count = Math.min(Math.max(Number.isNaN(rawCount) ? 0 : rawCount, 0), lane.length - start)
  const inserted: InboxTimeItem[] = (Array.isArray(data.inserted) ? data.inserted : []).flatMap((message) => {
    const id = (message as { id?: unknown } | null)?.id
    return id === undefined || id === null || String(id).length === 0
      ? []
      : [{ id: String(id), at: event.time }]
  })
  if (count === 0 && inserted.length === 0) return lane
  return [...lane.slice(0, start), ...inserted, ...lane.slice(start + count)]
}

/** Fold one durable inbox splice while retaining only currently pending ids. */
export function applyDevLeadInboxTimes(
  state: DevLeadInboxTimesState,
  event: SessionEvent,
): DevLeadInboxTimesState {
  if (event.type !== 'agent/inbox/spliced') return state
  const target = (event.data as { target?: unknown }).target
  if (target === 'next-turn') {
    const nextTurn = spliceLane(state.nextTurn, event)
    return nextTurn === state.nextTurn ? state : { ...state, nextTurn }
  }
  if (target === 'next-step') {
    const nextStep = spliceLane(state.nextStep, event)
    return nextStep === state.nextStep ? state : { ...state, nextStep }
  }
  return state
}

/** Host-only pending-inbox enqueue-time projection. */
export const devLeadInboxTimesProjectionDefinition = {
  key: 'devLeadInboxTimes',
  stateSchema: inboxTimesStateSchema,
  init: () => emptyDevLeadInboxTimesState(),
  apply: applyDevLeadInboxTimes,
  stateVersion: 1,
} satisfies ProjectionDefinition<string, DevLeadInboxTimesState>

/** Read one pending message's enqueue instant from the bounded fold. */
export function inboxEnqueuedAtOf(state: DevLeadInboxTimesState, messageId: string): number | undefined {
  return state.nextStep.find(item => item.id === messageId)?.at
    ?? state.nextTurn.find(item => item.id === messageId)?.at
}
