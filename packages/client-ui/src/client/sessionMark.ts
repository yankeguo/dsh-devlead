/**
 * Pure predicates behind the sidebar's DevLead Session-row marks.
 *
 * Marks must render for every listed Session, including cold rows the client
 * never attached. The digest-bearing `devLead` projection is deliberately
 * excluded from Session summaries, so rows read the summary-sized
 * `devLeadMode` / `devLeadWatch` values instead: `SessionSummary.projectionValues`
 * carries them on every list pull. This module keeps those reads testable
 * without React.
 *
 * The input is a structural shape rather than the full `SessionSummary` type:
 * the component passes the list row straight through, and the predicate only
 * needs the one projection value.
 */

import {
  DEVLEAD_MODE_PROJECTION_KEY,
  DEVLEAD_WATCH_PROJECTION_KEY,
} from '@yankeguo/dsh-devlead-protocol/client'

/** Structural view of the row's summary projection values this mark reads. */
export interface DevLeadRowSummary {
  /** Summary projection values carried by one Session list row. */
  readonly projectionValues?: {
    /** Summary-sized DevLead mode selection, when the Host published it. */
    readonly [DEVLEAD_MODE_PROJECTION_KEY]?: { readonly enabled?: boolean }
    /** Summary-sized watch set of this Session when it is a lead. */
    readonly [DEVLEAD_WATCH_PROJECTION_KEY]?: { readonly sessions?: readonly unknown[] }
  }
}

/**
 * Whether one listed Session row should render the DevLead mark.
 * @param summary - the row's Session summary, or undefined before the list lands.
 * @returns true only when the summary explicitly reports DevLead mode enabled.
 */
export function devLeadRowEnabled(summary: DevLeadRowSummary | undefined): boolean {
  return summary?.projectionValues?.[DEVLEAD_MODE_PROJECTION_KEY]?.enabled === true
}

/**
 * Own-property row lookup of one Session summary. The catalog crossed the
 * store boundary as a plain object, so a prototype key (`toString`,
 * `constructor`, …) must read as "no row" instead of an inherited member.
 * @param byId - Session list rows keyed by identity.
 * @param sessionId - row identity.
 * @returns the row's summary, or undefined when the catalog has no own row.
 */
export function devLeadRowSummaryOf(
  byId: Readonly<Record<string, DevLeadRowSummary | undefined>>,
  sessionId: string,
): DevLeadRowSummary | undefined {
  return Object.hasOwn(byId, sessionId) ? byId[sessionId] : undefined
}

/**
 * Watched-id sets derived once per catalog snapshot, keyed by the snapshot's
 * `byId` reference. The shell list store is an immutable snapshot store (every
 * update publishes a fresh `byId` object), so the reference is a sound cache
 * key: a stale entry can never outlive the snapshot it describes, and the
 * WeakMap lets collected snapshots take their derived set with them. Without
 * this, every row's selector would rescan the whole catalog on every list or
 * status update (O(N²) per push).
 */
const watchedIdsCache = new WeakMap<
  Readonly<Record<string, DevLeadRowSummary | undefined>>,
  ReadonlySet<string>
>()

/**
 * Derive (or reuse) the set of Session ids watched by an enabled lead.
 * @param byId - Session list rows keyed by identity.
 * @returns ids listed by at least one enabled lead, excluding the lead's own
 *   id and unusable drift entries.
 */
function watchedIdsOf(
  byId: Readonly<Record<string, DevLeadRowSummary | undefined>>,
): ReadonlySet<string> {
  const cached = watchedIdsCache.get(byId)
  if (cached !== undefined) return cached
  const watched = new Set<string>()
  for (const [leadId, lead] of Object.entries(byId)) {
    if (!devLeadRowEnabled(lead)) continue
    const sessions = lead?.projectionValues?.[DEVLEAD_WATCH_PROJECTION_KEY]?.sessions
    if (!Array.isArray(sessions)) continue
    for (const candidate of sessions) {
      // A lead never marks itself, and an empty/non-string entry is wire
      // drift, not a watchable identity.
      if (typeof candidate !== 'string' || candidate.length === 0 || candidate === leadId) continue
      watched.add(candidate)
    }
  }
  watchedIdsCache.set(byId, watched)
  return watched
}

/**
 * Whether one listed Session is watched by the current active lead.
 *
 * Watch state lives in the lead's own `devLeadWatch` summary projection, not in
 * the watched Session's log. The predicate reads the watched-id set derived
 * once per catalog snapshot (see {@link watchedIdsOf}). It fails closed on
 * absent/drifting values and never marks the lead itself.
 * @param sessionId - row identity.
 * @param byId - Session list rows keyed by identity.
 * @returns true only when an enabled lead summary explicitly lists this row.
 */
export function devLeadRowWatched(
  sessionId: string,
  byId: Readonly<Record<string, DevLeadRowSummary | undefined>>,
): boolean {
  if (devLeadRowEnabled(devLeadRowSummaryOf(byId, sessionId))) return false
  return watchedIdsOf(byId).has(sessionId)
}
