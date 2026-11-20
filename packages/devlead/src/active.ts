/**
 * Global single-active DevLead admission vocabulary.
 *
 * DevLead mode is a Host-wide resource: at most one Session may have it
 * enabled at a time, across every Workspace. This module owns the pure parts
 * of that rule — extracting the last durable enable instant, ranking recovered
 * occupants deterministically, and building the user-facing refusal — while
 * the service owns the Cordis scan and the durable writes.
 *
 * @module @yankeguo/dsh-devlead
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { readRecord } from './record-api.ts'
// Type-only: pulls the plugin-record map entries for the devlead event types.
import type {} from './domain.ts'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_RESET_RECORD_TYPE,
  sessionRefLabel,
} from '@yankeguo/dsh-devlead-protocol'

/** One Session discovered as DevLead-enabled during a global occupancy scan. */
export interface DevLeadActiveSession {
  /** Session identity of the occupant. */
  readonly sessionId: string
  /** Human title, when the live title service supplies one. */
  readonly title?: string
  /** Whether the Session is live in the Session store/Agent registry. */
  readonly live: boolean
  /** Whether the Workspace registry currently lists the Session as archived. */
  readonly archived: boolean
  /** Whether the live Agent is running a turn. */
  readonly running: boolean
  /** Session creation timestamp, used only for deterministic recovery ranking. */
  readonly createdAt: number
  /**
   * Epoch milliseconds of the last durable enable record, when the caller read
   * the log (cold scan). Live projections do not expose record timestamps, so
   * this is 0 for live occupants.
   */
  readonly enabledAt: number
}

/**
 * Find the instant of the last durable DevLead enable in one raw Session log.
 *
 * A reset discards earlier modes, so it clears the candidate; a later enable
 * replaces it. Malformed records are ignored here (the fold will reject them
 * during its own strict decode) so this helper can never throw on a hostile
 * log.
 * @param events - complete raw Session events, in log order.
 * @returns the last enabled instant, or undefined when the Session is off.
 */
export function lastEnabledAt(events: readonly SessionEvent[]): number | undefined {
  let at: number | undefined
  for (const event of events) {
    const record = readRecord(event)
    if (record === undefined) continue
    if (record.type === DEVLEAD_MODE_RECORD_TYPE) {
      const data = record.data as { readonly enabled?: unknown; readonly at?: unknown }
      if (data.enabled === true && typeof data.at === 'number' && Number.isFinite(data.at)) at = data.at
      continue
    }
    if (record.type === DEVLEAD_RESET_RECORD_TYPE) at = undefined
  }
  return at
}

/**
 * Rank active occupants for the recovery keeper and for choosing which
 * occupant to name in a refusal.
 *
 * A caller-supplied incumbent wins first (a live index that already existed
 * must not be displaced by a Session resumed later). Then non-archived over
 * archived, live over cold, running over idle, the latest durable enable,
 * the newest header, and finally the Session id. The order is total and
 * deterministic, so a restart never flips the keeper arbitrarily.
 * @param occupants - active Sessions discovered by the scan.
 * @param preferredSessionId - incumbent identity to keep when still present.
 * @returns a new array with the keeper first.
 */
export function rankActiveSessions(
  occupants: readonly DevLeadActiveSession[],
  preferredSessionId?: string,
): DevLeadActiveSession[] {
  return [...occupants].sort((left, right) => {
    if (left.sessionId === preferredSessionId) return -1
    if (right.sessionId === preferredSessionId) return 1
    if (left.archived !== right.archived) return left.archived ? 1 : -1
    if (left.live !== right.live) return left.live ? -1 : 1
    if (left.running !== right.running) return left.running ? -1 : 1
    return right.enabledAt - left.enabledAt
      || right.createdAt - left.createdAt
      || left.sessionId.localeCompare(right.sessionId)
  })
}

/**
 * Render one occupant for a human-facing error: `title (session-id)`, or the
 * bare id when no title is available.
 * @param occupant - active Session.
 * @returns the compact label.
 */
export function activeSessionLabel(occupant: DevLeadActiveSession): string {
  // The title is durable record/log data that reaches a human error and the
  // browser's localized refusal parser: use the shared single-line excerpt so a
  // newline, an oversized title, or an embedded instruction suffix cannot break
  // either surface.
  return sessionRefLabel(occupant.sessionId, occupant.title)
}

/**
 * Build the stable refusal for a second Session trying to enable DevLead.
 *
 * The message always names the occupant and tells the human how to switch.
 * Archived holders no longer produce a refusal of their own: they are ignored
 * for admission and surfaced through `/devlead status` instead.
 * @param occupant - Session holding the mode.
 * @returns the refusal text.
 */
export function alreadyActiveMessage(occupant: DevLeadActiveSession): string {
  const label = activeSessionLabel(occupant)
  return `Another Session is already in DevLead mode: ${label}. `
    + 'Run /devlead off there first, then enable this Session.'
}
