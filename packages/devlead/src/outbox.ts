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
import type { DevLeadReport, DevLeadReportKind } from '@yankeguo/dsh-devlead-protocol'

/** Domain/table names (must match the storage backend's safe-name rule). */
const OUTBOX_DOMAIN = 'devlead_report_outbox'
const OUTBOX_TABLE = 'pending'
const IGNORED_TABLE = 'ignored'

/** Durable outbox row retention; uncollected rows older than this are discarded. */
export const DEVLEAD_REPORT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

/** One persisted outbox row. */
export interface DevLeadOutboxRecord {
  /** Full report receipt, including sender and lead identities. */
  readonly report: DevLeadReport
  /** Epoch milliseconds when the row was first enqueued. */
  readonly enqueuedAt: number
}

/** One tombstone for an archived holder that could not be disabled. */
export interface DevLeadIgnoredHolder {
  /** Session that still has a durable enabled mode but is ignored as archived. */
  readonly sessionId: string
  /** Epoch milliseconds when the tombstone was written. */
  readonly at: number
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
}).strict()

/** Tombstone row schema. */
const ignoredSchema = zod.object({
  sessionId: zod.string().min(1),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
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
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    pending: { valueSchema: outboxSchema },
    ignored: { valueSchema: ignoredSchema },
  },
} as const

/** Stable path-safe table key for one report (lead-scoped so id reuse across leads cannot collide). */
export function devLeadOutboxKey(report: DevLeadReport): string {
  return Buffer.from(`${report.leadSessionId}\u0000${report.id}`, 'utf8').toString('base64url')
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
      ctx.logger.warn(`devlead: durable report outbox unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Persist one report before the child receives a success receipt.
   * @param report - report to enqueue.
   * @returns whether the row is durable.
   */
  async put(report: DevLeadReport): Promise<boolean> {
    if (this.closed) return false
    const key = devLeadOutboxKey(report)
    try {
      const table = this.domain.table(OUTBOX_TABLE)
      const existing = table.get(key) as DevLeadOutboxRecord | undefined
      await table.put(key, {
        report,
        enqueuedAt: existing?.enqueuedAt ?? Date.now(),
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
  async prune(now: number = Date.now(), retentionMs: number = DEVLEAD_REPORT_OUTBOX_RETENTION_MS): Promise<number> {
    const cutoff = now - retentionMs
    const stale = this.entries().filter(entry => entry.enqueuedAt < cutoff)
    if (stale.length === 0) return 0
    try {
      const removed = await this.domain.table(OUTBOX_TABLE).deleteMany(stale.map(entry => devLeadOutboxKey(entry.report)))
      if (removed > 0) {
        this.ctx.logger.warn(
          `devlead: discarded ${String(removed)} undelivered report(s) older than the ${String(retentionMs)} ms outbox retention`,
        )
      }
      return removed
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not prune the durable report outbox: ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  /**
   * Drop every report queued for one lead, used by `/devlead reset`.
   * @param leadSessionId - lead identity.
   * @returns number of removed rows.
   */
  async dropForLead(leadSessionId: string): Promise<number> {
    const keys = this.entries()
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
