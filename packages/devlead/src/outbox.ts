/**
 * Durable report outbox and archived-holder tombstones.
 *
 * A watched-child report must not disappear just because its lead is cold or
 * archived while it is delivered. The report is first written to a small
 * storage-domain KV table (whose writes resolve only after durability), then a
 * receipt is appended to the lead's Session log. The outbox row is removed only
 * after that receipt was flushed; a Host crash at any point leaves the row for
 * replay on the next boot or lead activation.
 *
 * The same domain carries tombstones for archived DevLead occupants whose
 * durable mode-off could not be written. An archived occupant is not an active
 * lead, so the tombstone lets admission ignore it across restarts; an
 * unarchived/opened occupant is still reconciled and its tombstone cleared when
 * the mode-off succeeds.
 *
 * A third table queues answer discards whose lead log could not accept them
 * yet (cold/detached lead, failed append, failed flush). The queue survives a
 * Host restart while the lead stays cold; a row is removed only after the
 * discard record was appended to the lead log and flushed, so a crash never
 * leaves the durable audit claiming an answer the child inbox already dropped.
 *
 * The storage-domain service is optional: a Host that composes no storage keeps
 * the existing in-memory fallback and reports `durable: false` to the child.
 *
 * @module @yankeguo/dsh-devlead
 */

import { z as zod } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEVLEAD_MAX_INSTANT,
  DEVLEAD_QUESTION_FIELD_MAX,
  DEVLEAD_QUESTION_OPTIONS_MAX,
  DEVLEAD_QUESTIONS_MAX,
  DEVLEAD_REPORT_KINDS,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_SUMMARY_MAX,
  devLeadReportId,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadReport, DevLeadReportAnswer, DevLeadReportKind } from '@yankeguo/dsh-devlead-protocol'
import { answerSchema } from './fold.ts'

/** One open-failure warning per service context (retry-safe without duplicate logs). */
const warnedOpenContexts = new WeakSet<Context>()

/** Domain/table names (must match the storage backend's safe-name rule). */
const OUTBOX_DOMAIN = 'devlead_report_outbox'
const OUTBOX_TABLE = 'pending'
const IGNORED_TABLE = 'ignored'
const ANSWER_DISCARD_TABLE = 'answer_discards'

/** Durable outbox row retention; uncollected rows older than this are discarded. */
export const DEVLEAD_REPORT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * Queued answer-discard retention, deliberately longer than the report outbox
 * horizon: a dropped discard row means a question may stay answered after a
 * restart even though the child inbox already lost the answer. Pruning past
 * this horizon is an explicit warning, never the silent report sweep.
 */
export const DEVLEAD_ANSWER_DISCARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

/**
 * Whether a report was observed while the lead Agent was live (`live`) or cold
 * (`cold`). The origin must survive a restart because a cold-observed
 * background report is digest-only by policy and must never be injected by a
 * later outbox replay. Version-3 rows always carry the field; legacy rows
 * without it are rejected at the storage boundary and are never replayed.
 */
export type DevLeadReportOrigin = 'live' | 'cold'

/** One persisted outbox row. */
export interface DevLeadOutboxRecord {
  /** Full report receipt, including sender and lead identities. */
  readonly report: DevLeadReport
  /** Epoch milliseconds when the row was first enqueued. */
  readonly enqueuedAt: number
  /** Lead liveness when the report was admitted, required for every v3 row. */
  readonly origin: DevLeadReportOrigin
}

/** One tombstone for an archived holder that could not be disabled. */
export interface DevLeadIgnoredHolder {
  /** Session that still has a durable enabled mode but is ignored as archived. */
  readonly sessionId: string
  /** Epoch milliseconds when the tombstone was written. */
  readonly at: number
}

/**
 * One queued answer discard whose lead log could not accept it yet (cold or
 * detached lead, failed append, or failed flush). The row survives a Host
 * restart while the lead stays cold; the drain removes it only after the
 * discard record was appended to the lead log AND flushed.
 */
export interface DevLeadAnswerDiscardRow {
  /** The discard lifecycle fact to append to the lead's answer audit. */
  readonly answer: DevLeadReportAnswer
  /** Epoch milliseconds when the row was first enqueued. */
  readonly enqueuedAt: number
}

/** Structural storage-domain table surface used by the outbox. */
interface OutboxTable {
  get(key: string): unknown
  entries(): IterableIterator<[string, unknown]>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  deleteMany(keys: readonly string[]): Promise<number>
}

/** Structural storage-domain handle surface used by the outbox. */
interface OutboxDomain {
  table(name: string): OutboxTable
  close(): Promise<void>
}

/** Structural storage-domain facility resolved through the optional service. */
interface StorageDomainFacility {
  open(spec: unknown): Promise<OutboxDomain>
}

/** Bounded structured question field accepted at the durable outbox boundary. */
const questionFieldSchema = zod.string().min(1).refine(
  value => value.length <= DEVLEAD_QUESTION_FIELD_MAX * 2
    && Array.from(value).length <= DEVLEAD_QUESTION_FIELD_MAX,
  { message: `question field must be at most ${DEVLEAD_QUESTION_FIELD_MAX} code points` },
)

const questionOptionSchema = zod.object({
  label: questionFieldSchema,
  description: questionFieldSchema.optional(),
}).strict()

const questionSchema = zod.object({
  id: questionFieldSchema.optional(),
  header: questionFieldSchema.optional(),
  question: questionFieldSchema,
  options: zod.array(questionOptionSchema).max(DEVLEAD_QUESTION_OPTIONS_MAX).optional(),
  multi_select: zod.boolean().optional(),
}).strict()

/** Report schema accepted from the durable outbox boundary. */
const reportSchema = zod.object({
  id: zod.string().min(1),
  kind: zod.enum([...DEVLEAD_REPORT_KINDS] as [DevLeadReportKind, ...DevLeadReportKind[]]),
  message: zod.string().min(1).refine(
    value => Array.from(value).length <= DEVLEAD_REPORT_MESSAGE_MAX,
    { message: `report message must be at most ${DEVLEAD_REPORT_MESSAGE_MAX} code points` },
  ),
  summary: zod.string().min(1).refine(
    value => Array.from(value).length <= DEVLEAD_REPORT_SUMMARY_MAX,
    { message: `report summary must be at most ${DEVLEAD_REPORT_SUMMARY_MAX} code points` },
  ).optional(),
  questions: zod.array(questionSchema).max(DEVLEAD_QUESTIONS_MAX).optional(),
  senderSessionId: zod.string().min(1),
  senderSessionTitle: zod.string().min(1).optional(),
  senderWorkspaceId: zod.string().min(1).optional(),
  senderWorkspaceTitle: zod.string().min(1).optional(),
  leadSessionId: zod.string().min(1),
  turn: zod.number().int().nonnegative(),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
}).strict().refine(
  report => report.questions === undefined || report.kind === 'question',
  { message: 'report questions are only valid when kind is "question"' },
).refine(
  report => report.id === devLeadReportId(report.senderSessionId, report.turn, report.kind, report.message),
  { message: 'report id must match senderSessionId, turn, kind, and message' },
)

/** Outbox row schema. */
const outboxSchema = zod.object({
  report: reportSchema,
  enqueuedAt: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
  origin: zod.enum(['live', 'cold']),
}).strict()

/** Tombstone row schema. */
const ignoredSchema = zod.object({
  sessionId: zod.string().min(1),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
}).strict()

/** Queued answer-discard row schema (the fold's exact answer record schema). */
const answerDiscardSchema = zod.object({
  answer: answerSchema,
  enqueuedAt: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
}).strict()

/**
 * Domain declaration opened lazily through `ctx.storageDomain`. Exported so
 * regression tests can parse stored rows with the exact `valueSchema` the real
 * Host applies at open time (`invalidRecords: 'backup-and-skip'`): a schema
 * that rejects an already-written row would silently back it up and skip it on
 * the next restart.
 */
export const OUTBOX_SPEC = {
  name: OUTBOX_DOMAIN,
  // 3 intentionally abandons v1/v2: pending rows must carry an explicit
  // origin, so legacy origin-less reports cannot be replayed with new meaning.
  version: 3,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    pending: { valueSchema: outboxSchema },
    ignored: { valueSchema: ignoredSchema },
    answer_discards: { valueSchema: answerDiscardSchema },
  },
} as const

/** Stable path-safe table key for one report (lead-scoped so id reuse across leads cannot collide). */
export function devLeadOutboxKey(report: DevLeadReport): string {
  return Buffer.from(`${report.leadSessionId}\u0000${report.id}`, 'utf8').toString('base64url')
}

/** Stable path-safe queue key for one answer discard (one row per answer message). */
export function devLeadAnswerDiscardKey(answer: DevLeadReportAnswer): string {
  return Buffer.from(`${answer.leadSessionId}\u0000${answer.reportId}\u0000${answer.messageId}`, 'utf8').toString('base64url')
}

/** Stable path-safe table key for one session id. */
function sessionKey(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

/**
 * Durable outbox facade. `open` returns undefined when the Host composes no
 * storage-domain service; callers then use the explicitly non-durable path.
 */
export class DevLeadReportOutbox {
  /** Whether the domain was opened and remains available. */
  get available(): boolean {
    return !this.closed
  }

  private closed = false

  /** Last outbox write/open failure, for diagnostics and receipts. */
  lastError: string | undefined

  private constructor(
    private readonly ctx: Context,
    private readonly domain: OutboxDomain,
  ) {}

  /**
   * Open the outbox domain when the Host composes storage-domain.
   * @param ctx - Host context carrying the optional service.
   * @returns the outbox, or undefined when storage is unavailable.
   */
  static async open(ctx: Context): Promise<DevLeadReportOutbox | undefined> {
    const getter = ctx as unknown as { get(name: string): unknown }
    const facility = getter.get('storageDomain') as StorageDomainFacility | undefined
    if (facility === undefined) return undefined
    try {
      const domain = await facility.open(OUTBOX_SPEC)
      return new DevLeadReportOutbox(ctx, domain)
    } catch (error: unknown) {
      if (!warnedOpenContexts.has(ctx)) {
        warnedOpenContexts.add(ctx)
        ctx.logger.warn(`devlead: durable report outbox unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    }
  }

  /**
   * Persist one report before the child receives a success receipt.
   * @param report - report to enqueue.
   * @param origin - lead liveness at admission, preserved across restarts.
   * @returns whether the row is durable.
   */
  async put(report: DevLeadReport, origin: DevLeadReportOrigin): Promise<boolean> {
    if (this.closed) return false
    const key = devLeadOutboxKey(report)
    try {
      const table = this.domain.table(OUTBOX_TABLE)
      const existing = table.get(key) as DevLeadOutboxRecord | undefined
      await table.put(key, {
        report,
        enqueuedAt: existing?.enqueuedAt ?? Date.now(),
        origin,
      } satisfies DevLeadOutboxRecord)
      this.lastError = undefined
      return true
    } catch (error: unknown) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`devlead: could not durably enqueue report "${report.id}": ${this.lastError}`)
      return false
    }
  }

  /**
   * Remove one delivered outbox row.
   * @param reportId - report identity.
   * @returns whether the row is gone (or was already absent).
   */
  async delete(report: DevLeadReport): Promise<boolean> {
    if (this.closed) return false
    try {
      await this.domain.table(OUTBOX_TABLE).delete(devLeadOutboxKey(report))
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not remove delivered report "${report.id}" from the outbox: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Snapshot all undelivered rows.
   * @returns rows in storage iteration order.
   */
  entries(): DevLeadOutboxRecord[] {
    // The open-time schema normally backups and skips legacy rows. Keep the
    // replay boundary defensive too: an origin-less row exposed after open is
    // visible to retention/reset for deletion, but is never delivered.
    return this.storedEntries().filter(entry => entry.origin !== undefined)
  }

  /** Raw pending rows for maintenance paths that may delete legacy records. */
  private storedEntries(): DevLeadOutboxRecord[] {
    if (this.closed) return []
    try {
      return [...this.domain.table(OUTBOX_TABLE).entries()]
        .map(([, value]) => value as DevLeadOutboxRecord)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not read the durable report outbox: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * Delete undelivered rows older than the retention horizon.
   * @param now - current epoch milliseconds.
   * @param retentionMs - maximum age, defaulting to the outbox retention.
   * @returns number of removed rows.
   */
  async prune(
    now: number = Date.now(),
    retentionMs: number = DEVLEAD_REPORT_OUTBOX_RETENTION_MS,
    answerDiscardRetentionMs: number = DEVLEAD_ANSWER_DISCARD_RETENTION_MS,
  ): Promise<number> {
    const cutoff = now - retentionMs
    const discardCutoff = now - answerDiscardRetentionMs
    const stale = this.storedEntries().filter(entry => entry.enqueuedAt < cutoff)
    // Queued discards keep their own (longer) horizon: they are question-state
    // repairs, not deliverable reports, and losing one silently would leave a
    // question answered after a restart although the child dropped the answer.
    const staleDiscards = this.answerDiscards().filter(row => row.enqueuedAt < discardCutoff)
    if (stale.length === 0 && staleDiscards.length === 0) return 0
    let removed = 0
    try {
      if (stale.length > 0) {
        removed += await this.domain.table(OUTBOX_TABLE).deleteMany(stale.map(entry => devLeadOutboxKey(entry.report)))
        this.ctx.logger.warn(
          `devlead: discarded ${String(stale.length)} undelivered report(s) older than the ${String(retentionMs)} ms outbox retention`,
        )
      }
      if (staleDiscards.length > 0) {
        removed += await this.domain.table(ANSWER_DISCARD_TABLE).deleteMany(staleDiscards.map(row => devLeadAnswerDiscardKey(row.answer)))
        this.ctx.logger.warn(
          `devlead: pruned ${String(staleDiscards.length)} queued answer discard(s) older than the ${String(answerDiscardRetentionMs)} ms answer-discard retention; `
          + 'their questions may stay answered after a restart although the child inbox dropped the answers',
        )
      }
      return removed
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not prune the durable report outbox: ${error instanceof Error ? error.message : String(error)}`)
      return removed
    }
  }

  /**
   * Drop every report queued for one lead, used by `/devlead reset`.
   * @param leadSessionId - lead identity.
   * @returns number of removed rows.
   */
  async dropForLead(leadSessionId: string): Promise<number> {
    const keys = this.storedEntries()
      .filter(entry => entry.report.leadSessionId === leadSessionId)
      .map(entry => devLeadOutboxKey(entry.report))
    if (keys.length === 0) return 0
    try {
      return await this.domain.table(OUTBOX_TABLE).deleteMany(keys)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not drop outbox reports for lead "${leadSessionId}": ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  /**
   * Persist one queued answer discard before the lead log can accept it.
   * @param answer - the discard lifecycle fact to queue.
   * @returns whether the row is durable.
   */
  async putAnswerDiscard(answer: DevLeadReportAnswer): Promise<boolean> {
    if (this.closed) return false
    const key = devLeadAnswerDiscardKey(answer)
    try {
      const table = this.domain.table(ANSWER_DISCARD_TABLE)
      const existing = table.get(key) as DevLeadAnswerDiscardRow | undefined
      await table.put(key, {
        answer,
        enqueuedAt: existing?.enqueuedAt ?? Date.now(),
      } satisfies DevLeadAnswerDiscardRow)
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not durably queue the discard of answer "${answer.messageId}": ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Remove one queued answer discard after its record was appended and flushed.
   * @param answer - the drained discard fact.
   * @returns whether the row is gone (or was already absent).
   */
  async deleteAnswerDiscard(answer: DevLeadReportAnswer): Promise<boolean> {
    if (this.closed) return false
    try {
      return await this.domain.table(ANSWER_DISCARD_TABLE).delete(devLeadAnswerDiscardKey(answer))
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not remove the drained answer discard "${answer.messageId}" from the queue: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Snapshot every queued answer discard.
   * @returns rows in storage iteration order.
   */
  answerDiscards(): DevLeadAnswerDiscardRow[] {
    if (this.closed) return []
    try {
      return [...this.domain.table(ANSWER_DISCARD_TABLE).entries()]
        .map(([, value]) => value as DevLeadAnswerDiscardRow)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not read the durable answer discard queue: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * Drop every queued answer discard of one lead, used by `/devlead reset`.
   * @param leadSessionId - lead identity.
   * @returns number of removed rows.
   */
  async dropAnswerDiscardsForLead(leadSessionId: string): Promise<number> {
    const keys = this.answerDiscards()
      .filter(row => row.answer.leadSessionId === leadSessionId)
      .map(row => devLeadAnswerDiscardKey(row.answer))
    if (keys.length === 0) return 0
    try {
      return await this.domain.table(ANSWER_DISCARD_TABLE).deleteMany(keys)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not drop queued answer discards for lead "${leadSessionId}": ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  /**
   * Persist one archived-holder tombstone.
   * @param sessionId - ignored Session identity.
   * @returns whether the tombstone is durable.
   */
  async rememberIgnored(sessionId: string): Promise<boolean> {
    if (this.closed) return false
    try {
      await this.domain.table(IGNORED_TABLE).put(sessionKey(sessionId), {
        sessionId,
        at: Date.now(),
      } satisfies DevLeadIgnoredHolder)
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not persist archived-holder tombstone "${sessionId}": ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Remove one archived-holder tombstone after a successful release.
   * @param sessionId - Session identity.
   */
  async forgetIgnored(sessionId: string): Promise<void> {
    if (this.closed) return
    try {
      await this.domain.table(IGNORED_TABLE).delete(sessionKey(sessionId))
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not clear archived-holder tombstone "${sessionId}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Read every archived-holder tombstone.
   * @returns Session identities.
   */
  ignoredIds(): string[] {
    if (this.closed) return []
    try {
      return [...this.domain.table(IGNORED_TABLE).entries()]
        .map(([, value]) => (value as DevLeadIgnoredHolder).sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not read archived-holder tombstones: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /** Close the domain handle. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.domain.close()
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not close the durable report outbox: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
