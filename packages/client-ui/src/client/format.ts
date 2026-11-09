/**
 * Pure presentation helpers for the DevLeadBar dock: watched-session counts,
 * latest-notification copy, and the transition vocabulary. Kept free of React
 * and platform-module imports so the strip logic is unit-testable in Node.
 *
 * The durable vocabulary itself comes from the shared protocol package: the
 * browser and the Host must agree on the notification identity and digest line,
 * so that part is never re-implemented here. Only the localization seam (which
 * dictionary keys a transition maps to) is owned by this module.
 */

import { isDevLeadTransition, notificationLine } from '@yankeguo/dsh-devlead-protocol/client'
import type { DevLeadNotification, DevLeadTransition } from '@yankeguo/dsh-devlead-protocol/client'

/**
 * Dictionary keys of the transition chip, one per known transition plus the
 * wire-drift fallback: a newer Host may report a transition this bundle does
 * not know, and the strip must still render something neutral.
 */
export type DevLeadTransitionKey =
  | 'transition.completed'
  | 'transition.error'
  | 'transition.blocked'
  | 'transition.aborted'
  | 'transition.max-tokens'
  | 'transition.interrupted'
  | 'transition.forked'
  | 'transition.unknown'

/**
 * Localized label key per known transition. An exhaustive record — rather than
 * a switch with a default — makes a transition added to the shared protocol a
 * compile error here instead of a silent degradation to the neutral label.
 */
const TRANSITION_LABEL_KEYS: Record<DevLeadTransition, DevLeadTransitionKey> = {
  completed: 'transition.completed',
  error: 'transition.error',
  blocked: 'transition.blocked',
  aborted: 'transition.aborted',
  'max-tokens': 'transition.max-tokens',
  interrupted: 'transition.interrupted',
  forked: 'transition.forked',
}

/**
 * Map one wire transition to its localized label key.
 * @param transition - transition value read from the projection.
 * @returns the label key; unknown values fall back to the neutral label.
 */
export function transitionLabelKey(transition: string): DevLeadTransitionKey {
  return isDevLeadTransition(transition) ? TRANSITION_LABEL_KEYS[transition] : 'transition.unknown'
}

/** Rendered fields of the latest-notification chip. */
export interface DevLeadNotificationSummary {
  /** Canonical Host digest line, used as the chip's technical tooltip. */
  readonly tooltip: string
  /** Session title the Host folded at notification time, otherwise the raw Session id. */
  readonly who: string
  /** 1-based settled turn, or 0 when the wire value is unusable. */
  readonly turn: number
  /** Raw transition value, forwarded to the DOM for the per-outcome dot. */
  readonly transition: string
  /** Dictionary key of the localized transition label. */
  readonly labelKey: DevLeadTransitionKey
  /** Host-authored failure excerpt, when the transition recorded one. */
  readonly error: string | undefined
}

/**
 * Render one retained notification as the strip's chip fields. Every field is
 * read defensively: the value crossed the Remote boundary, so an empty title,
 * an out-of-range turn, or a future transition literal must degrade instead of
 * producing an empty or broken chip.
 * @param notification - retained notification to summarize.
 * @returns the localized chip fields plus the Host canonical tooltip.
 */
export function notificationSummary(notification: DevLeadNotification): DevLeadNotificationSummary {
  const rawTitle = typeof notification.sessionTitle === 'string' ? notification.sessionTitle.trim() : ''
  const who = rawTitle.length > 0 ? rawTitle : notification.sessionId
  const turn = Number.isInteger(notification.turn) && notification.turn > 0 ? notification.turn : 0
  const tooltip = isDevLeadTransition(notification.transition)
    ? notificationLine(notification)
    : `${who} — ${String(notification.transition)}`
  const rawError = typeof notification.error === 'string' ? notification.error.trim() : ''
  return {
    tooltip,
    who,
    turn,
    transition: String(notification.transition),
    labelKey: transitionLabelKey(notification.transition),
    error: rawError.length > 0 ? rawError : undefined,
  }
}

/**
 * Latest retained notification of one projection, or null while none is retained.
 * @param notifications - retained notifications, oldest first.
 * @returns the newest notification.
 */
export function latestNotification(notifications: readonly DevLeadNotification[]): DevLeadNotification | null {
  return notifications.at(-1) ?? null
}

/** Structural row the watched-session summary reads from the Session catalog. */
export interface DevLeadWatchedRow {
  /** Host running state of this Session. */
  readonly running: boolean
}

/** Structural per-Session UI status the summary reads from the Session status map. */
export interface DevLeadWatchedStatus {
  /** Latest known running state; undefined until the Client observed a baseline. */
  readonly running: boolean | undefined
}

/** Counts rendered by the enabled strip. */
export interface DevLeadWatchedSummary {
  /** Deduplicated watched Session count, exactly the projection's watch set. */
  readonly watched: number
  /** Watched Sessions whose UI status or catalog row says they are running. */
  readonly running: number
  /** Watched Session ids the catalog no longer lists (stale watch rows). */
  readonly missing: number
}

/**
 * Summarize the projection's watch set against the live Session catalog.
 *
 * The projection is the truth for the watch set; the catalog and the status map
 * are read-only enrichment that may lag or lack a row entirely (a Session
 * removed from the catalog, a Client that has not observed a status baseline
 * yet), so a missing row counts as "not running" instead of throwing.
 * @param watchedSessions - watch-set ids from the projection, in add order.
 * @param rows - Session catalog rows by id.
 * @param statuses - per-Session UI status by id, when the source is available.
 * @returns the watched/running/missing counts.
 */
export function summarizeWatched(
  watchedSessions: readonly unknown[],
  rows: Readonly<Record<string, DevLeadWatchedRow | undefined>>,
  statuses: ReadonlyMap<string, DevLeadWatchedStatus> | undefined,
): DevLeadWatchedSummary {
  const seen = new Set<string>()
  let running = 0
  let missing = 0
  for (const candidate of watchedSessions) {
    // The watch set crossed the Remote boundary: an empty or non-string entry
    // must not produce a phantom count.
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const row = rows[candidate]
    if (row === undefined) missing += 1
    // The Client's live UI status outranks the list's host snapshot: a Session
    // that started or finished a turn since the catalog refresh must count
    // correctly. An unobserved status falls back to the catalog row.
    const status = statuses?.get(candidate)
    if (status?.running ?? row?.running ?? false) running += 1
  }
  return { watched: seen.size, running, missing }
}
