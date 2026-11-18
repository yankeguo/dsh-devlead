/**
 * Optional Session projection-cache capability.
 *
 * Cold lead rehydration and global single-active admission must not read the
 * complete log of every Session a Host ever persisted: on a long-lived
 * deployment that corpus is unbounded. The projection cache keeps the last
 * published projection row per Session, so its cached `devLead` value is a
 * cheap pre-filter: a disabled row is skipped without touching the log, an
 * enabled row is a real candidate, and only rows the cache cannot classify pay
 * for an exact fold.
 *
 * The negative verdict is safe only because the service eagerly checkpoints
 * this cache after every durable mode/watch/reset write, and DSH's cache
 * contract says a stored row is never wrong, only behind the log. A crash
 * between the log flush and that eager checkpoint can still leave a stale
 * negative row; the lead is then recovered when its Session is opened
 * (live indexing), not by the cold scan.
 *
 * The cache package is optional (a headless Host may compose neither it nor the
 * Session query engine), and DevLead must keep zero build/runtime dependency on
 * it, so this module declares only the small structural slice DevLead reads and
 * detects it through the Cordis context, exactly like the worktree capability.
 *
 * @module @yankeguo/dsh-devlead
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

/** Structural view of the optional `sessionProjectionCache` service. */
export interface SessionProjectionCacheLike {
  /**
   * Read the cached projection row of one Session.
   * @param header - persisted Session header from the query listing.
   * @returns the cached row, or undefined when no row/key is cached.
   */
  cachedSnapshot(header: unknown): unknown
  /**
   * Durably checkpoint one live Session now, when the composed cache supports
   * an eager write. DevLead uses this after its own durable mode/watch/reset
   * records so the cache's pre-filter cannot stay behind them for the whole
   * throttled write interval.
   * @param session - live Session to checkpoint.
   * @returns fulfillment after the durable checkpoint attempt.
   */
  write?(session: Session): Promise<void>
}

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
  const service = candidate as {
    cachedSnapshot: (header: unknown) => unknown
    write?: (session: Session) => Promise<void>
  }
  // Bind the real service: its methods may read `this`, and the structural view
  // must not detach them. An eager writer is exposed only when callable.
  return {
    cachedSnapshot: header => service.cachedSnapshot(header),
    ...(typeof service.write === 'function' ? { write: (session: Session) => service.write!(session) } : {}),
  }
}

/** Occupancy pre-filter verdict of one cached projection row. */
export type DevLeadActivePrefilter = 'active' | 'inactive' | 'unknown'

/**
 * Classify one cached projection row for global single-active admission.
 *
 * An enabled row is always `active`, even with an empty watch set: the mode
 * itself is the global resource. A disabled row is `inactive`; a
 * missing/malformed row is `unknown` and the caller must
 * read the exact log. The same eager-checkpoint invariant documented on the
 * module keeps a negative row from hiding a just-enabled Session beyond the
 * one durable write.
 * @param cache - composed projection cache.
 * @param header - persisted Session header from the query listing.
 * @returns the occupancy verdict.
 */
export function devLeadActivePrefilterOf(
  cache: SessionProjectionCacheLike,
  header: unknown,
): DevLeadActivePrefilter {
  let snapshot: unknown
  try {
    snapshot = cache.cachedSnapshot(header)
  } catch {
    return 'unknown'
  }
  if (typeof snapshot !== 'object' || snapshot === null) return 'unknown'
  const values = (snapshot as { values?: unknown }).values
  if (typeof values !== 'object' || values === null) return 'unknown'
  const devLead = (values as Record<string, unknown>).devLead
  if (typeof devLead !== 'object' || devLead === null) return 'unknown'
  const enabled = (devLead as { enabled?: unknown }).enabled
  if (enabled === true) return 'active'
  return enabled === false ? 'inactive' : 'unknown'
}
