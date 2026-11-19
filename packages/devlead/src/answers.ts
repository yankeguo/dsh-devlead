/**
 * In-memory observation of the answer inbox lifecycle (Phase 1d).
 *
 * The durable authority is the lead's `plugin:devlead/report-answer` audit:
 * admission writes an `admitted` fact, and a service-initiated discard
 * (interrupt `clear-all`, replacement) writes a `discarded` fact. The finer
 * inbox transitions — `claimed` (a proposed pre-step took the message) and
 * `presented` (the message entered an entered step's `user/message`) — are
 * observed in memory only; their durable backfill is Phase 2. Discards, in
 * contrast, must survive a restart: the child-log observer below reconstructs
 * them from the durable inbox splices (`outcome:'canceled'` removals and
 * claimed-but-never-presented answers at `turn/end`) even when the live tracker
 * is empty and the lead is cold. Nothing here fabricates `presented`: it is
 * recorded only when the child log actually carries the answer's
 * `user/message`.
 *
 * @module @yankeguo/dsh-devlead/answers
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DEVLEAD_MESSAGE_KIND } from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadAnswerStatus,
  DevLeadDeliveryBoundary,
  DevLeadReportAnswer,
} from '@yankeguo/dsh-devlead-protocol'

/** One tracked answer message and its observed inbox lifecycle. */
export interface AnswerMemoryEntry {
  /** Question report identity the answer addresses. */
  readonly reportId: string
  /** Lead Session that authored the answer. */
  readonly leadSessionId: string
  /** Child Session whose inbox received the answer. */
  readonly sessionId: string
  /** Stable Host message identity of the answer. */
  readonly messageId: string
  /** Observed lifecycle status (memory advances the durable admission). */
  status: DevLeadAnswerStatus
  /** Instant of the newest lifecycle fact. */
  at: number
  /**
   * Per-question admission sequence of this answer (0 for a legacy record
   * without one). Different-answer comparisons use it — never the lifecycle
   * `at`, which a late claim/presentation/discard advances past a newer answer.
   */
  readonly answerSeq: number
  /** First admission instant of the question; survives a reopen. */
  readonly firstAdmittedAt: number
  /** Instant the answer entered an entered step, when observed. */
  presentedAt?: number
  /** Lead-supplied idempotency key, when provided. */
  readonly idempotencyKey?: string
  /** SHA-256 hex of the trimmed answer prompt. */
  readonly textHash: string
  /** Bounded excerpt of the answer prompt, for conflict messages. */
  readonly textExcerpt?: string
  /** Primitive that admitted the answer. */
  readonly primitive: 'followup' | 'steer'
  /** Boundary that admitted the answer. */
  readonly boundary: DevLeadDeliveryBoundary
  /** Whether the admission requested a driver wake. */
  readonly wakeRequested: boolean
}

/** Maximum tracked answers per Host process; FIFO eviction keeps it bounded. */
const MAX_TRACKED_ANSWERS = 512

/** Question key of one tracked answer. */
function questionKey(leadSessionId: string, reportId: string): string {
  return `${leadSessionId}\u0000${reportId}`
}

/** Message key of one tracked answer. */
function messageKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`
}

/** Whether a lifecycle status is terminal (no further transition applies). */
function isTerminal(status: DevLeadAnswerStatus): boolean {
  return status === 'presented' || status === 'discarded' || status === 'failed'
}

/**
 * Admission instant of one durable record for the legacy (no-sequence) tie
 * break: an `admitted` row's `at` is its admission; every other lifecycle row
 * carries the question's first admission in `answeredAt`. The lifecycle `at`
 * of a claim/presentation/discard never orders two different answers.
 * @param answer - durable answer lifecycle record.
 * @returns the admission instant the record represents.
 */
export function admittedAtOf(answer: DevLeadReportAnswer): number {
  return answer.status === 'admitted' ? answer.at : (answer.answeredAt ?? answer.at)
}

/**
 * Process-local answer lifecycle observer. One instance is owned by the core
 * service; entries are created at admission, seeded from the durable audit
 * when a Session becomes live, and advanced by the child's inbox/log events.
 */
export class DevLeadAnswerTracker {
  private readonly byQuestion = new Map<string, AnswerMemoryEntry>()
  private readonly byMessage = new Map<string, AnswerMemoryEntry>()

  /**
   * Register one freshly admitted answer, replacing any earlier answer of the
   * same question (the newest admission is authoritative).
   * @param entry - admitted answer facts.
   */
  remember(entry: AnswerMemoryEntry): void {
    this.insert(entry)
  }

  /**
   * Seed the latest durable answer fact of one question. The caller passes the
   * newest record per question (not every audit row), so a discarded answer
   * seeds as discarded and the question stays open after a restart. A live
   * memory entry is never rewound: a same-messageId admission keeps any observed
   * claim/presentation, a durable terminal discard wins over a stale admission,
   * and a newer different-messageId fact replaces an older one.
   * @param answer - newest durable answer lifecycle record of the question.
   */
  seed(answer: DevLeadReportAnswer): void {
    const key = questionKey(answer.leadSessionId, answer.reportId)
    const existing = this.byQuestion.get(key)
    if (existing !== undefined) {
      if (existing.messageId === answer.messageId) {
        // Same answer: a durable terminal discard/failed is authoritative; an
        // admitted/claimed record never rewinds an observed claim/presentation.
        if (answer.status === 'discarded' || answer.status === 'failed') {
          existing.status = answer.status
          existing.at = answer.at
        }
        return
      }
      // A different answer message: the higher admission sequence wins. A late
      // lifecycle fact (claim/presentation/discard) of an older answer carries
      // that answer's lower sequence and can never replace a newer re-answer.
      const incomingSeq = answer.answerSeq ?? 0
      if (incomingSeq < existing.answerSeq) return
      if (incomingSeq === existing.answerSeq) {
        // Legacy tie (both records predate the sequence): admission instants
        // decide, never the lifecycle `at`; a tie keeps the live entry.
        if (existing.firstAdmittedAt >= admittedAtOf(answer)) return
      }
      this.byMessage.delete(messageKey(existing.sessionId, existing.messageId))
      this.byQuestion.delete(key)
    }
    this.insert(entryOfRecord(answer))
  }

  /** Insert one entry under both indexes and trim to the bounded size. */
  private insert(entry: AnswerMemoryEntry): void {
    const key = questionKey(entry.leadSessionId, entry.reportId)
    const previous = this.byQuestion.get(key)
    if (previous !== undefined) this.byMessage.delete(messageKey(previous.sessionId, previous.messageId))
    this.byQuestion.delete(key)
    this.byQuestion.set(key, entry)
    this.byMessage.set(messageKey(entry.sessionId, entry.messageId), entry)
    while (this.byQuestion.size > MAX_TRACKED_ANSWERS) {
      const oldest = this.byQuestion.keys().next().value
      if (oldest === undefined) break
      const evicted = this.byQuestion.get(oldest)
      this.byQuestion.delete(oldest)
      if (evicted !== undefined) this.byMessage.delete(messageKey(evicted.sessionId, evicted.messageId))
    }
  }

  /**
   * Read the tracked answer of one question.
   * @param leadSessionId - lead Session identity.
   * @param reportId - question report identity.
   * @returns the memory entry, or undefined when untracked.
   */
  entryOfQuestion(leadSessionId: string, reportId: string): AnswerMemoryEntry | undefined {
    return this.byQuestion.get(questionKey(leadSessionId, reportId))
  }

  /**
   * Read the tracked answer by its child inbox message identity.
   * @param sessionId - child Session identity.
   * @param messageId - Host message identity.
   * @returns the memory entry, or undefined when untracked.
   */
  entryOfMessage(sessionId: string, messageId: string): AnswerMemoryEntry | undefined {
    return this.byMessage.get(messageKey(sessionId, messageId))
  }

  /**
   * Observe one `agent/inbox/claimed`: the answer was taken for a proposed
   * pre-step. This is not delivery completion.
   * @param sessionId - child Session identity.
   * @param messageId - claimed message identity.
   * @param at - observation instant.
   * @returns whether the entry advanced.
   */
  claimed(sessionId: string, messageId: string, at: number): boolean {
    const entry = this.byMessage.get(messageKey(sessionId, messageId))
    if (entry === undefined || entry.status !== 'admitted') return false
    entry.status = 'claimed'
    entry.at = at
    return true
  }

  /**
   * Observe one entered-step `user/message`: the answer really entered the
   * model-visible surface. Only this transition is delivery completion.
   * @param sessionId - child Session identity.
   * @param messageId - presented message identity.
   * @param at - the `user/message` event instant.
   * @returns whether the entry advanced.
   */
  presented(sessionId: string, messageId: string, at: number): boolean {
    const entry = this.byMessage.get(messageKey(sessionId, messageId))
    if (entry === undefined || isTerminal(entry.status)) return false
    entry.status = 'presented'
    entry.at = at
    entry.presentedAt = at
    return true
  }

  /**
   * Observe one discard of a still-pending or claimed answer (inbox discard
   * event, interrupt clear, or replacement). The question reopens because the
   * newest answer is now `discarded`.
   * @param sessionId - child Session identity.
   * @param messageId - discarded message identity.
   * @param at - observation instant.
   * @returns the advanced entry, or undefined when nothing changed.
   */
  discarded(sessionId: string, messageId: string, at: number): AnswerMemoryEntry | undefined {
    const entry = this.byMessage.get(messageKey(sessionId, messageId))
    if (entry === undefined || isTerminal(entry.status)) return undefined
    entry.status = 'discarded'
    entry.at = at
    return entry
  }

  /**
   * Reconcile claimed answers at a child `turn/end`: a claimed answer that
   * never became a `user/message` was consumed by a rejected pre-step, so it
   * is discarded and its question reopens. A presented answer is terminal and
   * untouched.
   * @param sessionId - child Session whose turn settled.
   * @param at - the `turn/end` event instant.
   * @returns the entries that advanced to discarded.
   */
  reconcileTurnEnd(sessionId: string, at: number): AnswerMemoryEntry[] {
    const discarded: AnswerMemoryEntry[] = []
    for (const entry of this.byQuestion.values()) {
      if (entry.sessionId !== sessionId || entry.status !== 'claimed') continue
      entry.status = 'discarded'
      entry.at = at
      discarded.push(entry)
    }
    return discarded
  }
}

/**
 * Build the durable discard fact of one tracked answer. The writer carries the
 * first admission instant forward so a reopen does not erase `answeredAt`.
 * @param entry - tracked answer being discarded.
 * @param at - discard instant.
 * @returns the answer lifecycle record payload value.
 */
export function discardedAnswerOf(entry: AnswerMemoryEntry, at: number): DevLeadReportAnswer {
  return {
    reportId: entry.reportId,
    leadSessionId: entry.leadSessionId,
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    at,
    status: 'discarded',
    // A legacy answer (sequence 0) keeps the pre-sequence record shape.
    ...(entry.answerSeq === 0 ? {} : { answerSeq: entry.answerSeq }),
    textHash: entry.textHash,
    answeredAt: entry.firstAdmittedAt,
    ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
    ...(entry.textExcerpt === undefined ? {} : { textExcerpt: entry.textExcerpt }),
    primitive: entry.primitive,
    boundary: entry.boundary,
    wakeRequested: entry.wakeRequested,
  }
}

/**
 * Project one durable answer record into a memory entry, preserving its status
 * (including terminal discarded/failed/presented) so a restart seeds the exact
 * durable state.
 * @param answer - durable answer lifecycle record.
 * @returns the equivalent memory entry.
 */
export function entryOfRecord(answer: DevLeadReportAnswer): AnswerMemoryEntry {
  return {
    reportId: answer.reportId,
    leadSessionId: answer.leadSessionId,
    sessionId: answer.sessionId,
    messageId: answer.messageId,
    status: answer.status,
    at: answer.at,
    answerSeq: answer.answerSeq ?? 0,
    firstAdmittedAt: answer.answeredAt ?? answer.at,
    ...(answer.presentedAt === undefined ? {} : { presentedAt: answer.presentedAt }),
    ...(answer.idempotencyKey === undefined ? {} : { idempotencyKey: answer.idempotencyKey }),
    textHash: answer.textHash,
    ...(answer.textExcerpt === undefined ? {} : { textExcerpt: answer.textExcerpt }),
    primitive: answer.primitive ?? 'steer',
    boundary: answer.boundary ?? 'next-step',
    wakeRequested: answer.wakeRequested ?? true,
  }
}

/** One answer discard derived from a child Session log, with the identities
 * needed to locate the lead's durable answer record. */
export interface DerivedAnswerDiscard {
  /** Discarded answer message identity. */
  readonly messageId: string
  /** Question report identity read from the runtime-stamped message source. */
  readonly questionId: string
  /** Authoring lead Session identity read from the message source. */
  readonly leadId: string
  /** Instant of the log event that proved the discard. */
  readonly at: number
}

/** One pending inbox slot: its identity plus answer metadata when it is one. */
interface PendingItem {
  readonly id: string
  readonly answer?: { readonly questionId: string; readonly leadId: string }
}

/** Maximum claimed-answer observations retained per child before FIFO eviction. */
const MAX_CLAIMED_OBSERVATIONS = 256

/** Answer metadata of one inserted message, when it is a correlatable answer. */
function answerMetaOf(message: unknown): { questionId: string; leadId: string } | undefined {
  const source = (message as { source?: unknown } | null)?.source
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as { kind?: unknown; questionId?: unknown; senderSessionId?: unknown }
  if (record.kind !== DEVLEAD_MESSAGE_KIND) return undefined
  if (typeof record.questionId !== 'string' || record.questionId.length === 0) return undefined
  if (typeof record.senderSessionId !== 'string' || record.senderSessionId.length === 0) return undefined
  return { questionId: record.questionId, leadId: record.senderSessionId }
}

/**
 * Per-child fold of the durable inbox splices restricted to answer lifecycle
 * reconstruction. The Host emits `agent/inbox/claimed`/`agent/inbox/discarded`
 * only live; the durable log carries `agent/inbox/spliced` (a claim removes
 * without `outcome:'canceled'`, a discard removes with it) plus `user/message`
 * and `turn/end`. Replaying those events proves, without any live tracker
 * entry, which answers were discarded or consumed by a rejected pre-step —
 * the restart/cold-lead reconstruction path. The observer never fabricates a
 * presentation: only a real `user/message` clears a claimed answer.
 */
export class DevLeadChildAnswerObserver {
  private nextTurn: PendingItem[] = []
  private nextStep: PendingItem[] = []
  private readonly claimed = new Map<string, { readonly questionId: string; readonly leadId: string }>()

  /**
   * Observe one committed child log event.
   * @param event - the committed event.
   * @param suppressDiscards - while the service's own interrupt stop clears the
   *   inbox, `keep`/`clear-own` restore the kept answers afterwards, so a
   *   canceled removal must not derive a discard in that window (the explicit
   *   `clear-all` snapshot owns those discards).
   * @returns the discards this event proved, in observation order.
   */
  observe(event: SessionEvent, suppressDiscards = false): DerivedAnswerDiscard[] {
    if (event.type === 'agent/inbox/spliced') {
      const data = event.data as {
        target?: unknown
        start?: unknown
        removedCount?: unknown
        inserted?: unknown
        outcome?: unknown
      }
      const list = data.target === 'next-turn' ? this.nextTurn : this.nextStep
      const rawStart = typeof data.start === 'number' ? Math.trunc(data.start) : 0
      const start = Number.isNaN(rawStart) ? 0 : rawStart < 0 ? Math.max(list.length + rawStart, 0) : Math.min(rawStart, list.length)
      const rawCount = typeof data.removedCount === 'number' ? Math.trunc(data.removedCount) : 0
      const count = Math.min(Math.max(Number.isNaN(rawCount) ? 0 : rawCount, 0), list.length - start)
      const inserted: PendingItem[] = (Array.isArray(data.inserted) ? data.inserted : []).map((message) => {
        const id = String((message as { id?: unknown } | null)?.id ?? '')
        const answer = answerMetaOf(message)
        return { id, ...(answer === undefined ? {} : { answer }) }
      })
      const removed = list.splice(start, count, ...inserted)
      const derived: DerivedAnswerDiscard[] = []
      for (const item of removed) {
        // A restored message (same id re-inserted later) is pending again.
        this.claimed.delete(item.id)
        if (item.answer === undefined) continue
        if (data.outcome === 'canceled') {
          if (!suppressDiscards) {
            derived.push({ messageId: item.id, questionId: item.answer.questionId, leadId: item.answer.leadId, at: event.time })
          }
        } else {
          this.claimed.set(item.id, item.answer)
          while (this.claimed.size > MAX_CLAIMED_OBSERVATIONS) {
            const oldest = this.claimed.keys().next().value
            if (oldest === undefined) break
            this.claimed.delete(oldest)
          }
        }
      }
      for (const item of inserted) this.claimed.delete(item.id)
      return derived
    }
    if (event.type === 'user/message') {
      const id = String((event.data as { id?: unknown } | null)?.id ?? '')
      this.claimed.delete(id)
      return []
    }
    if (event.type === 'turn/end') {
      // A claimed answer that never became a `user/message` was consumed by a
      // rejected (or aborted) pre-step: it is discarded and its question reopens.
      const derived: DerivedAnswerDiscard[] = []
      for (const [messageId, answer] of this.claimed) {
        derived.push({ messageId, questionId: answer.questionId, leadId: answer.leadId, at: event.time })
      }
      this.claimed.clear()
      return derived
    }
    return []
  }

  /**
   * Rebuild the observation from a complete child log (boot/resume
   * reconstruction), replacing any prior state.
   * @param events - the child's committed events, in log order.
   * @returns every discard the log proves, in log order.
   */
  replay(events: readonly SessionEvent[]): DerivedAnswerDiscard[] {
    this.nextTurn = []
    this.nextStep = []
    this.claimed.clear()
    const derived: DerivedAnswerDiscard[] = []
    for (const event of events) derived.push(...this.observe(event))
    return derived
  }
}

/**
 * Project one memory entry back into the durable record shape, so the service
 * can merge a live observation with the durable audit on equal footing.
 * @param entry - tracked answer entry.
 * @returns the equivalent record value.
 */
export function recordOfEntry(entry: AnswerMemoryEntry): DevLeadReportAnswer {
  return {
    reportId: entry.reportId,
    leadSessionId: entry.leadSessionId,
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    at: entry.at,
    status: entry.status,
    // A legacy answer (sequence 0) keeps the pre-sequence record shape.
    ...(entry.answerSeq === 0 ? {} : { answerSeq: entry.answerSeq }),
    textHash: entry.textHash,
    answeredAt: entry.firstAdmittedAt,
    ...(entry.presentedAt === undefined ? {} : { presentedAt: entry.presentedAt }),
    ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
    ...(entry.textExcerpt === undefined ? {} : { textExcerpt: entry.textExcerpt }),
    primitive: entry.primitive,
    boundary: entry.boundary,
    wakeRequested: entry.wakeRequested,
  }
}
