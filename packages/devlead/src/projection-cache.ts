/**
 * Optional Session projection-cache capability.
 *
 * Cold lead rehydration must not read the complete log of every Session a Host
 * ever persisted: on a long-lived deployment that corpus is unbounded. The
 * projection cache keeps the last published projection row per Session, so its
 * cached `devLead` value is a cheap pre-filter: a row that clearly says
 * "disabled" or "watching nothing" is skipped without touching the log, an
 * "enabled" row is a real lead candidate, and only rows the cache cannot
 * classify pay for an exact fold.
 *
 * The cache package is optional (a headless Host may compose neither it nor the
 * Session query engine), and DevLead must keep zero build/runtime dependency on
 * it, so this module declares only the small structural slice DevLead reads and
 * detects it through the Cordis context, exactly like the worktree capability.
 *
 * @module @yankeguo/dsh-devlead
 */

import type { Context } from '@deepseek-ai/cordis'

/** Structural view of the optional `sessionProjectionCache` service. */
export interface SessionProjectionCacheLike {
  /**
   * Read the cached projection row of one Session.
   * @param header - persisted Session header from the query listing.
   * @returns the cached row, or undefined when no row/key is cached.
   */
  cachedSnapshot(header: unknown): unknown
}

/**
 * Pre-filter verdict of one cached projection row, derived from the cached
 * `devLead` digest value.
 *
 * - `lead`: the row says the mode is enabled and the watch set is non-empty;
 * - `not-lead`: the row says the mode is disabled or the watch set is empty, so
 *   the log does not need to be read;
 * - `unknown`: no row, no `devLead` key, or a value this Host cannot classify;
 *   an exact fold is required and the unknown-read budget applies.
 */
export type DevLeadPrefilter = 'lead' | 'not-lead' | 'unknown'

/**
 * Detect one context's optional Session projection-cache service.
 *
 * The service is read from the Cordis context at call time (it is not an
 * injected dependency), then narrowed structurally: a Host that never composes
 * the cache reports no capability, and a foreign object registered under the
 * same name is only trusted when it exposes a callable `cachedSnapshot`.
 * @param ctx - context whose optional service is consulted.
 * @returns the structurally narrowed cache, or undefined when absent or unusable.
 */
export function projectionCacheOf(ctx: Context): SessionProjectionCacheLike | undefined {
  const candidate: unknown = ctx.get('sessionProjectionCache')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const cachedSnapshot = (candidate as { cachedSnapshot?: unknown }).cachedSnapshot
  if (typeof cachedSnapshot !== 'function') return undefined
  const service = candidate as { cachedSnapshot: (header: unknown) => unknown }
  // Bind the real service: its method may read `this`, and the structural view
  // must not detach it.
  return { cachedSnapshot: header => service.cachedSnapshot(header) }
}

/**
 * Classify one cached projection row without reading the Session log.
 *
 * The cached value is the `devLead` projection state (the digest unit stays in
 * the projection checkpoint even though it is excluded from Session summaries),
 * merged into `{ values }` by the cache row format.
 * @param cache - composed projection cache.
 * @param header - persisted Session header from the query listing.
 * @returns the pre-filter verdict.
 */
export function devLeadPrefilterOf(cache: SessionProjectionCacheLike, header: unknown): DevLeadPrefilter {
  let snapshot: unknown
  try {
    snapshot = cache.cachedSnapshot(header)
  } catch {
    // A cache that cannot answer is not a reason to skip a real lead: fall back
    // to the exact fold (bounded by the unknown-read budget).
    return 'unknown'
  }
  if (typeof snapshot !== 'object' || snapshot === null) return 'unknown'
  const values = (snapshot as { values?: unknown }).values
  if (typeof values !== 'object' || values === null) return 'unknown'
  const devLead = (values as Record<string, unknown>).devLead
  if (typeof devLead !== 'object' || devLead === null) return 'unknown'
  const record = devLead as { enabled?: unknown; sessions?: unknown }
  if (record.enabled !== true) {
    // A row that positively reports a disabled mode never hid a live lead.
    return record.enabled === false ? 'not-lead' : 'unknown'
  }
  if (!Array.isArray(record.sessions)) return 'unknown'
  // Enabled but watching nothing is still not a lead worth waking: matching the
  // hub's own "enabled && watch set non-empty" indexing rule keeps the two
  // rebuild paths consistent.
  return record.sessions.length > 0 ? 'lead' : 'not-lead'
}
