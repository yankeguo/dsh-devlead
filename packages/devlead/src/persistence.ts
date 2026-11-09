/**
 * Optional Session persistence capability: the structural slice of the
 * `sessionPersistence` service that serves as a corpus-readiness predicate.
 *
 * The real Session query engine binds this optional service through its own
 * `ctx.inject` callback. Until that binding is installed, `sessionQuery`
 * listings are silently live-only, so a cold-lead scan during plugin load can
 * miss every persisted Session. The persistence service exposes its complete
 * stored Session listing regardless of the query engine's binding state, so
 * comparing the two is a precise "the corpus is ready" signal — the devlead
 * service uses it as a bounded boot-time readiness barrier instead of a fixed
 * sleep.
 *
 * The persistence package is optional (a headless Host may compose no
 * persistence at all), and DevLead keeps zero build/runtime dependency on it,
 * so this module declares only the structural slice DevLead reads and detects
 * it through the Cordis context, exactly like the projection-cache/worktree
 * capabilities.
 *
 * @module @yankeguo/dsh-devlead
 */

import type { Context } from '@deepseek-ai/cordis'

/** Structural view of the optional `sessionPersistence` service. */
export interface SessionPersistenceLike {
  /**
   * List every stored Session snapshot.
   * @param options - backend options, unused by this readiness probe.
   * @returns the stored Session snapshots.
   */
  list(options?: unknown): unknown
}

/** One persistence readiness probe result. */
export interface PersistedSessionsProbe {
  /** Whether the composed service exposes a callable `list`, so readiness is observable. */
  readonly verifiable: boolean
  /**
   * Stored Session ids when the listing succeeded. `undefined` means the service
   * is composed but its listing is not usable yet (or the shape was unreadable).
   */
  readonly ids?: ReadonlySet<string>
}

/**
 * Probe one context's optional Session persistence service for its complete
 * stored-Session listing.
 *
 * The probe never throws: a Host without the service, a foreign object without a
 * callable `list`, or a backend whose listing is still initializing all degrade
 * to an unverifiable/unknown result instead of failing plugin load.
 * @param ctx - context whose optional service is consulted.
 * @returns the readiness probe result.
 */
export async function persistedSessionsOf(ctx: Context): Promise<PersistedSessionsProbe> {
  const candidate: unknown = ctx.get('sessionPersistence')
  if (typeof candidate !== 'object' || candidate === null) return { verifiable: false }
  const list = (candidate as { list?: unknown }).list
  if (typeof list !== 'function') return { verifiable: false }
  let listed: unknown
  try {
    listed = await Promise.resolve((list as (options?: unknown) => unknown).call(candidate))
  } catch {
    // Composed but not ready (or the probe failed): report verifiable-unknown.
    return { verifiable: true }
  }
  if (!Array.isArray(listed)) return { verifiable: true }
  const ids = new Set<string>()
  for (const snapshot of listed) {
    if (typeof snapshot !== 'object' || snapshot === null) continue
    const header = (snapshot as { header?: unknown }).header
    if (typeof header !== 'object' || header === null) continue
    const id = (header as { id?: unknown }).id
    if (id === undefined || id === null) continue
    const text = typeof id === 'string' ? id : String(id)
    if (text.length > 0) ids.add(text)
  }
  return { verifiable: true, ids }
}
