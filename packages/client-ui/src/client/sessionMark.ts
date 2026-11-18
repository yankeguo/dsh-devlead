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
 * Whether one listed Session is watched by the current active lead.
 *
 * Watch state lives in the lead's own `devLeadWatch` summary projection, not in
 * the watched Session's log. Every row has the list state, so the predicate
 * scans for an enabled lead whose summary-sized watch set contains this row.
 * It fails closed on absent/drifting values and never marks the lead itself.
 * @param sessionId - row identity.
 * @param byId - Session list rows keyed by identity.
 * @returns true only when an enabled lead summary explicitly lists this row.
 */
export function devLeadRowWatched(
  sessionId: string,
  byId: Readonly<Record<string, DevLeadRowSummary | undefined>>,
): boolean {
  const own = byId[sessionId]
  if (devLeadRowEnabled(own)) return false
  for (const [leadId, lead] of Object.entries(byId)) {
    if (leadId === sessionId || !devLeadRowEnabled(lead)) continue
    const sessions = lead?.projectionValues?.[DEVLEAD_WATCH_PROJECTION_KEY]?.sessions
    if (Array.isArray(sessions) && sessions.includes(sessionId)) return true
  }
  return false
}
