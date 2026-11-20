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
   * claim/presentation, a durable terminal discard wins over a stale admission
   * or claim but NEVER over an observed presentation (delivery completed; a
   * stale queued discard of a presented answer must not reopen the question),
   * and a newer different-messageId fact replaces an older one.
   * @param answer - newest durable answer lifecycle record of the question.
   */
  seed(answer: DevLeadReportAnswer): void {
    const key = questionKey(answer.leadSessionId, answer.reportId)
    const existing = this.byQuestion.get(key)
    if (existing !== undefined) {
      if (existing.messageId === answer.messageId) {
        // Same answer: a durable terminal discard/failed is authoritative only
        // when observed AFTER the live entry's newest fact. An observed
        // presentation is delivery completion and is never rewound; a claimed
        // answer is only overwritten by a terminal fact after the claim (a
        // genuine pre-step reject); a repaired admission (at = the survival
        // proof instant) is only overwritten by a strictly later terminal. A
        // stale discard queued before any of these must not reopen the question.
        if (answer.status === 'discarded' || answer.status === 'failed') {
          if (existing.status === 'presented') return
          if (answer.at <= existing.at) return
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
        // decide, never the lifecycle `at`.
        const incomingAdmittedAt = admittedAtOf(answer)
        if (existing.firstAdmittedAt > incomingAdmittedAt) return
        if (existing.firstAdmittedAt === incomingAdmittedAt) {
          // Same-instant tie: a newer ADMISSION wins by durable log position
          // (the caller seeds the newest record); a discard/failed lifecycle
          // fact of an older answer carries the question's first admission in
          // answeredAt and must never replace the live entry on a tie.
          if (answer.status !== 'admitted') return
        }
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
   * Apply the child-log-proven reality to one entry: the message is still
   * pending in the inbox (a keep/clear-own restore re-inserted it after a
   * canceled splice), claimed by an unsettled pre-step, or it really entered an
   * entered step (`user/message`). A terminal discard/failed entry is repaired
   * to the proven status; a live entry only ever advances FORWARD
   * (admitted → claimed → presented) with a newer proving instant — an observed
   * presentation is never rewound. This is the stale-queue-row /
   * stale-durable-discard correction path, not a normal lifecycle transition.
   * @param sessionId - child Session identity.
   * @param messageId - answer message identity.
   * @param status - the proven reality: pending (`admitted`), claimed, or presented.
   * @param at - instant of the proving fact.
   * @returns whether the entry changed.
   */
  repairLifecycle(sessionId: string, messageId: string, status: 'admitted' | 'claimed' | 'presented', at: number): boolean {
    const entry = this.byMessage.get(messageKey(sessionId, messageId))
    if (entry === undefined) return false
    if (entry.status === 'presented') return false
    if (entry.status === 'discarded' || entry.status === 'failed') {
      entry.status = status
      entry.at = at
      if (status === 'presented') entry.presentedAt = at
      return true
    }
    // A live entry advances forward only, and only with a newer proving fact.
    const rank = { admitted: 0, claimed: 1, presented: 2 } as const
    if (rank[status] < rank[entry.status]) return false
    if (at <= entry.at && status === entry.status) return false
    entry.status = status
    entry.at = at
    if (status === 'presented') entry.presentedAt = at
    return true
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

/** Maximum cancellation candidates retained per child before FIFO eviction. */
const MAX_CANCEL_CANDIDATES = 256

/** Maximum presented-message identities retained per child before FIFO eviction. */
const MAX_PRESENTED_OBSERVATIONS = 256

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
 *
 * A canceled removal is a cancellation CANDIDATE, not an immediate discard,
 * whenever a restore may still follow: during the service's interrupt window
 * (`keep`/`clear-own` stop clears the inbox, then `restoreInputs` re-inserts
 * the same ids) and throughout a replay (the log may carry the restore later).
 * A same-id re-insertion or a `user/message` revokes the candidate; surviving
 * candidates finalize at the end of a replay, or at the first live `turn/end`
 * outside the interrupt window. Only a live canceled removal outside any
 * interrupt window derives immediately — no restore can follow it.
 */
export class DevLeadChildAnswerObserver {
  private nextTurn: PendingItem[] = []
  private nextStep: PendingItem[] = []
  private readonly claimed = new Map<string, { readonly questionId: string; readonly leadId: string; readonly at: number }>()
  private readonly cancelCandidates = new Map<string, { readonly questionId: string; readonly leadId: string; readonly at: number }>()
  private readonly presented = new Map<string, number>()

  /**
   * @param onWarning - optional sink for bounded-observation eviction warnings.
   */
  constructor(private readonly onWarning?: (message: string) => void) {}

  /**
   * Whether the message is currently claimed by a proposed pre-step that has
   * not presented or settled yet. A claimed answer is still alive: a stale
   * discard queued BEFORE the claim must not reopen its question.
   * @param messageId - answer message identity.
   * @returns whether the message is claimed and unsettled.
   */
  isClaimed(messageId: string): boolean {
    return this.claimed.has(messageId)
  }

  /**
   * The instant the claim splice removed the message, when currently claimed.
   * @param messageId - answer message identity.
   * @returns the claim instant, or undefined when not claimed.
   */
  claimedAtOf(messageId: string): number | undefined {
    return this.claimed.get(messageId)?.at
  }

  /**
   * Whether this child's log proved the message presented (entered an entered
   * step's `user/message`), so a derived discard of it must be skipped.
   * @param messageId - answer message identity.
   * @returns whether a presentation was observed.
   */
  wasPresented(messageId: string): boolean {
    return this.presented.has(messageId)
  }

  /**
   * The instant this child's log proved the message presented, when observed.
   * @param messageId - answer message identity.
   * @returns the `user/message` event instant, or undefined.
   */
  presentedAtOf(messageId: string): number | undefined {
    return this.presented.get(messageId)
  }

  /**
   * Whether the folded inbox still holds the message pending (including a
   * keep/clear-own restore that re-inserted it after a canceled splice).
   * @param messageId - answer message identity.
   * @returns whether the message is pending at either boundary.
   */
  isPending(messageId: string): boolean {
    return this.nextTurn.some(item => item.id === messageId) || this.nextStep.some(item => item.id === messageId)
  }

  /**
   * Observe one committed child log event live.
   * @param event - the committed event.
   * @param suppressDiscards - whether the service's own interrupt stop is
   *   clearing this child's inbox (a restore may re-insert the same answers).
   * @returns the discards this event proved, in observation order.
   */
  observe(event: SessionEvent, suppressDiscards = false): DerivedAnswerDiscard[] {
    return this.apply(event, 'live', suppressDiscards)
  }

  /**
   * Rebuild the observation from a complete child log (boot/resume
   * reconstruction), replacing any prior state. Cancellation candidates
   * finalize at the end of the log unless the caller knows the log ends inside
   * an interrupt window whose restore has not happened yet.
   * @param events - the child's committed events, in log order.
   * @param options - `finalizeCandidates: false` keeps surviving candidates
   *   pending (the restore may still arrive as a later live event).
   * @returns every discard the log proves, in log order.
   */
  replay(events: readonly SessionEvent[], options: { readonly finalizeCandidates?: boolean } = {}): DerivedAnswerDiscard[] {
    this.nextTurn = []
    this.nextStep = []
    this.claimed.clear()
    this.cancelCandidates.clear()
    this.presented.clear()
    const derived: DerivedAnswerDiscard[] = []
    for (const event of events) derived.push(...this.apply(event, 'replay', false))
    if (options.finalizeCandidates !== false) derived.push(...this.finalizeCandidates())
    return derived
  }

  /** Apply one event in live or replay mode. */
  private apply(event: SessionEvent, mode: 'live' | 'replay', suppress: boolean): DerivedAnswerDiscard[] {
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
        this.claimed.delete(item.id)
        if (item.answer === undefined) continue
        if (data.outcome === 'canceled') {
          if (mode === 'live' && !suppress) {
            // Outside any interrupt window no restore can follow: the discard
            // is proven now.
            derived.push({ messageId: item.id, questionId: item.answer.questionId, leadId: item.answer.leadId, at: event.time })
          } else {
            this.cancelCandidates.set(item.id, { ...item.answer, at: event.time })
            this.evictBounded(this.cancelCandidates, MAX_CANCEL_CANDIDATES, 'cancellation candidates')
          }
        } else {
          this.claimed.set(item.id, { ...item.answer, at: event.time })
          this.evictBounded(this.claimed, MAX_CLAIMED_OBSERVATIONS, 'claimed observations')
        }
      }
      for (const item of inserted) {
        this.claimed.delete(item.id)
        // A restored message (same id re-inserted) revokes its cancellation.
        this.cancelCandidates.delete(item.id)
      }
      return derived
    }
    if (event.type === 'user/message') {
      const id = String((event.data as { id?: unknown } | null)?.id ?? '')
      this.claimed.delete(id)
      // Presentation is delivery completion: it revokes any cancellation
      // candidate and blocks every later derived discard of this message.
      this.cancelCandidates.delete(id)
      this.presented.set(id, event.time)
      while (this.presented.size > MAX_PRESENTED_OBSERVATIONS) {
        const oldest = this.presented.keys().next().value
        if (oldest === undefined) break
        this.presented.delete(oldest)
        this.onWarning?.(`evicted the oldest presented observation beyond ${String(MAX_PRESENTED_OBSERVATIONS)}; a much later derived discard of it may not be blocked`)
      }
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
      // Outside the interrupt window a settled turn also proves that any
      // surviving cancellation candidate was never restored. During a replay
      // the restore may still appear later in the log, so candidates wait for
      // the end of the log instead.
      if (mode === 'live' && !suppress) derived.push(...this.finalizeCandidates())
      return derived
    }
    return []
  }

  /** Emit and clear every surviving cancellation candidate. */
  private finalizeCandidates(): DerivedAnswerDiscard[] {
    const derived: DerivedAnswerDiscard[] = []
    for (const [messageId, candidate] of this.cancelCandidates) {
      derived.push({ messageId, questionId: candidate.questionId, leadId: candidate.leadId, at: candidate.at })
    }
    this.cancelCandidates.clear()
    return derived
  }

  /** FIFO-evict a bounded observation map, warning on each eviction. */
  private evictBounded(map: Map<string, unknown>, max: number, label: string): void {
    while (map.size > max) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
      this.onWarning?.(`evicted the oldest ${label} entry beyond ${String(max)}; a much later restore/reject of it may be misobserved`)
    }
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
