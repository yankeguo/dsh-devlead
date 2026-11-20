/**
 * Durable idempotency receipts for non-answer prompt admission.
 *
 * A receipt is keyed by lead, target, and the lead-supplied idempotency key.
 * The facade deliberately does not decide whether a retry is a replay or a
 * conflict: promptSession reads the original receipt, compares its textHash,
 * and either returns the original delivery or rejects the conflicting text.
 *
 * The storage-domain service is optional. Every storage failure is warned and
 * degraded to an absent receipt / unsuccessful mutation so prompt admission can
 * retain its in-memory fallback instead of crashing the Host.
 *
 * @module @yankeguo/dsh-devlead
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { DEVLEAD_IDEMPOTENCY_KEY_MAX, DEVLEAD_MAX_INSTANT } from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadPromptDelivery } from '@yankeguo/dsh-devlead-protocol'

/** Independent domain and table used only by prompt idempotency receipts. */
const IDEMPOTENCY_DOMAIN = 'devlead_idempotency'
const RECEIPTS_TABLE = 'receipts'

/** Receipts are replayable for seven days after their original admission. */
export const DEVLEAD_PROMPT_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

/** One original non-answer prompt admission retained for same-key retries. */
export interface DevLeadPromptIdempotencyReceipt {
  /** Lead Session that supplied the idempotency key. */
  readonly leadSessionId: string
  /** Target Session that admitted the original prompt. */
  readonly targetSessionId: string
  /** Lead-supplied idempotency key, scoped by lead and target. */
  readonly key: string
  /** SHA-256 hex of the normalized prompt text, compared by promptSession. */
  readonly textHash: string
  /** Epoch milliseconds of the original admission, also the TTL timestamp. */
  readonly at: number
  /** Original admission receipt returned by a same-key, same-text retry. */
  readonly delivery: DevLeadPromptDelivery
}

/** Three-way receipt read: only a definite absence permits a new admission. */
export type DevLeadPromptIdempotencyRead =
  | { readonly status: 'found'; readonly receipt: DevLeadPromptIdempotencyReceipt }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly reason: string }

/** Structural storage-domain table surface used by the receipt facade. */
interface IdempotencyTable {
  get(key: string): unknown
  entries(): IterableIterator<[string, unknown]>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  deleteMany(keys: readonly string[]): Promise<number>
}

/** Structural storage-domain handle surface used by the receipt facade. */
interface IdempotencyDomain {
  table(name: string): IdempotencyTable
  close(): Promise<void>
}

/** Structural storage-domain facility resolved through the optional service. */
interface StorageDomainFacility {
  open(spec: unknown): Promise<IdempotencyDomain>
}

/** Idempotency keys use the same bounded wire representation as answer records. */
const idempotencyKeySchema = zod.string().min(1).refine(
  value => Array.from(value).length <= DEVLEAD_IDEMPOTENCY_KEY_MAX,
  { message: `idempotency key must be at most ${String(DEVLEAD_IDEMPOTENCY_KEY_MAX)} code points` },
)

/** Exact durable shape of the public prompt admission receipt. */
const promptDeliverySchema: ZodType<DevLeadPromptDelivery> = zod.object({
  primitive: zod.enum(['followup', 'steer', 'inject']),
  boundary: zod.enum(['next-turn', 'next-step']),
  wakeRequested: zod.boolean(),
  messageId: zod.string().min(1),
  questionId: zod.string().min(1).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict() as ZodType<DevLeadPromptDelivery>

/** Schema applied by the Host when existing receipt records are opened. */
const receiptSchema = zod.object({
  leadSessionId: zod.string().min(1),
  targetSessionId: zod.string().min(1),
  key: idempotencyKeySchema,
  textHash: zod.string().regex(/^[0-9a-f]{64}$/u),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
  delivery: promptDeliverySchema,
}).strict()

/**
 * Version-1 domain declaration. Corrupt rows are backed up and skipped at open
 * rather than making the whole optional idempotency facility unavailable.
 */
export const PROMPT_IDEMPOTENCY_SPEC = {
  name: IDEMPOTENCY_DOMAIN,
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    receipts: { valueSchema: receiptSchema },
  },
} as const

/** Stable path-safe storage key for one (lead, target, idempotency key) tuple. */
export function devLeadPromptIdempotencyKey(leadSessionId: string, targetSessionId: string, key: string): string {
  return Buffer.from(`${leadSessionId}\u0000${targetSessionId}\u0000${key}`, 'utf8').toString('base64url')
}

/** Convert an unknown storage failure into a useful warning suffix. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Durable non-answer prompt idempotency facade. `open` returns undefined when
 * storage-domain is absent or cannot open; operation failures never throw into
 * prompt admission.
 */
export class DevLeadPromptIdempotencyStore {
  /** Whether this handle can still access its storage domain. */
  get available(): boolean {
    return !this.closed
  }

  private closed = false

  private constructor(
    private readonly ctx: Context,
    private readonly domain: IdempotencyDomain,
  ) {}

  /**
   * Open the independent receipt domain and prune expired rows before use.
   * @param ctx - Host context carrying the optional storage-domain service.
   * @returns an open facade, or undefined when durable storage is unavailable.
   */
  static async open(ctx: Context): Promise<DevLeadPromptIdempotencyStore | undefined> {
    try {
      const getter = ctx as unknown as { get(name: string): unknown }
      const facility = getter.get('storageDomain') as StorageDomainFacility | undefined
      if (facility === undefined) return undefined
      const domain = await facility.open(PROMPT_IDEMPOTENCY_SPEC)
      const store = new DevLeadPromptIdempotencyStore(ctx, domain)
      await store.prune()
      return store
    } catch (error: unknown) {
      ctx.logger.warn(`devlead: durable prompt idempotency unavailable: ${errorMessage(error)}`)
      return undefined
    }
  }

  /**
   * Read the original receipt for one key. Conflict handling belongs to the
   * caller: compare textHash, then replay delivery only when the hash matches.
   * @returns the original receipt, or undefined when absent/closed/unreadable.
   */
  get(leadSessionId: string, targetSessionId: string, key: string): DevLeadPromptIdempotencyReceipt | undefined {
    const result = this.read(leadSessionId, targetSessionId, key)
    return result.status === 'found' ? result.receipt : undefined
  }

  /** Distinguish a definite absence from corruption/read failure (fail closed). */
  read(leadSessionId: string, targetSessionId: string, key: string): DevLeadPromptIdempotencyRead {
    if (this.closed) return { status: 'unreadable', reason: 'the idempotency store is closed' }
    try {
      const value = this.domain.table(RECEIPTS_TABLE).get(devLeadPromptIdempotencyKey(leadSessionId, targetSessionId, key))
      if (value === undefined) return { status: 'absent' }
      const parsed = receiptSchema.safeParse(value)
      if (!parsed.success) {
        const reason = `corrupt durable prompt idempotency receipt: ${parsed.error.message}`
        this.ctx.logger.warn(`devlead: ${reason} for key "${key}"`)
        return { status: 'unreadable', reason }
      }
      return { status: 'found', receipt: parsed.data }
    } catch (error: unknown) {
      const reason = errorMessage(error)
      this.ctx.logger.warn(`devlead: could not read durable prompt idempotency key "${key}": ${reason}`)
      return { status: 'unreadable', reason }
    }
  }

  /**
   * Persist one original admission receipt after the prompt was admitted.
   * @param receipt - complete identity, text hash, timestamp, and delivery.
   * @returns whether the receipt was durably written.
   */
  async put(receipt: DevLeadPromptIdempotencyReceipt): Promise<boolean> {
    if (this.closed) return false
    try {
      const key = devLeadPromptIdempotencyKey(receipt.leadSessionId, receipt.targetSessionId, receipt.key)
      await this.domain.table(RECEIPTS_TABLE).put(key, receipt)
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not persist durable prompt idempotency key "${receipt.key}": ${errorMessage(error)}`)
      return false
    }
  }

  /**
   * Delete one receipt, for explicit lifecycle cleanup.
   * @returns whether an existing receipt was removed.
   */
  async delete(leadSessionId: string, targetSessionId: string, key: string): Promise<boolean> {
    if (this.closed) return false
    try {
      const storageKey = devLeadPromptIdempotencyKey(leadSessionId, targetSessionId, key)
      return await this.domain.table(RECEIPTS_TABLE).delete(storageKey)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not delete durable prompt idempotency key "${key}": ${errorMessage(error)}`)
      return false
    }
  }

  /**
   * Remove receipts older than the retention horizon. Called automatically by
   * open, and public so a long-lived Host can schedule the same best-effort sweep.
   * @param now - current epoch milliseconds.
   * @param retentionMs - receipt TTL, defaulting to seven days.
   * @returns number of receipts removed; zero on a closed/failed sweep.
   */
  async prune(
    now: number = Date.now(),
    retentionMs: number = DEVLEAD_PROMPT_IDEMPOTENCY_RETENTION_MS,
  ): Promise<number> {
    if (this.closed) return 0
    try {
      const table = this.domain.table(RECEIPTS_TABLE)
      const cutoff = now - retentionMs
      const stale: string[] = []
      for (const [key, value] of table.entries()) {
        const parsed = receiptSchema.safeParse(value)
        if (!parsed.success) {
          this.ctx.logger.warn(`devlead: ignored a corrupt durable prompt idempotency receipt during prune: ${parsed.error.message}`)
          continue
        }
        if (parsed.data.at < cutoff) stale.push(key)
      }
      if (stale.length === 0) return 0
      return await table.deleteMany(stale)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not prune durable prompt idempotency receipts: ${errorMessage(error)}`)
      return 0
    }
  }

  /** Close the domain handle; repeated close calls are harmless. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.domain.close()
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not close durable prompt idempotency storage: ${errorMessage(error)}`)
    }
  }
}
