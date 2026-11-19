/**
 * In-memory observation of the answer inbox lifecycle (Phase 1d).
 *
 * The durable authority is the lead's `plugin:devlead/report-answer` audit:
 * admission writes an `admitted` fact, and a service-initiated discard
 * (interrupt `clear-all`, replacement) writes a `discarded` fact. The finer
 * inbox transitions — `claimed` (a proposed pre-step took the message),
 * `presented` (the message entered an entered step's `user/message`), and the
 * pre-step-reject reconciliation at `turn/end` — are observed in memory only;
 * their durable replay/backfill is Phase 2. Nothing here fabricates
 * `presented`: it is recorded only when the child log actually carries the
 * answer's `user/message`.
 *
 * @module @yankeguo/dsh-devlead/answers
 */

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
   * Seed one durable answer fact when no live memory entry exists for its
   * question. Memory only ever advances a seeded admission, so a re-seed of
   * the same durable fact never rewinds an observed claim/presentation.
   * @param answer - durable answer lifecycle record.
   */
  seed(answer: DevLeadReportAnswer): void {
    const key = questionKey(answer.leadSessionId, answer.reportId)
    if (this.byQuestion.has(key)) return
    if (answer.status !== 'admitted' && answer.status !== 'claimed') return
    const entry: AnswerMemoryEntry = {
      reportId: answer.reportId,
      leadSessionId: answer.leadSessionId,
      sessionId: answer.sessionId,
      messageId: answer.messageId,
      status: answer.status,
      at: answer.at,
      firstAdmittedAt: answer.answeredAt ?? answer.at,
      ...(answer.presentedAt === undefined ? {} : { presentedAt: answer.presentedAt }),
      ...(answer.idempotencyKey === undefined ? {} : { idempotencyKey: answer.idempotencyKey }),
      textHash: answer.textHash,
      ...(answer.textExcerpt === undefined ? {} : { textExcerpt: answer.textExcerpt }),
      primitive: answer.primitive ?? 'steer',
      boundary: answer.boundary ?? 'next-step',
      wakeRequested: answer.wakeRequested ?? true,
    }
    this.byQuestion.set(key, entry)
    this.byMessage.set(messageKey(entry.sessionId, entry.messageId), entry)
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
    textHash: entry.textHash,
    answeredAt: entry.firstAdmittedAt,
    ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
    ...(entry.textExcerpt === undefined ? {} : { textExcerpt: entry.textExcerpt }),
    primitive: entry.primitive,
    boundary: entry.boundary,
    wakeRequested: entry.wakeRequested,
  }
}