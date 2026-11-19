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

import {
  DEVLEAD_ERROR_EXCERPT_MAX,
  excerptLine,
  isDevLeadReportKind,
  isDevLeadTransition,
  notificationLine,
  reportLine,
} from '@yankeguo/dsh-devlead-protocol/client'
import type {
  DevLeadNotification,
  DevLeadReport,
  DevLeadReportKind,
  DevLeadTransition,
} from '@yankeguo/dsh-devlead-protocol/client'

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
  /**
   * Host-authored assistant excerpt of the settled turn, when one was recorded.
   * The chip renders this only when {@link error} is absent (a real failure
   * excerpt wins), but the field stays independent so callers can inspect both.
   */
  readonly summary: string | undefined
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
  const title = typeof notification.sessionTitle === 'string'
    ? excerptLine(notification.sessionTitle, DEVLEAD_ERROR_EXCERPT_MAX)
    : undefined
  const who = title ?? notification.sessionId
  const turn = Number.isInteger(notification.turn) && notification.turn > 0 ? notification.turn : 0
  const tooltip = isDevLeadTransition(notification.transition)
    ? notificationLine(notification)
    : `${who} — ${String(notification.transition)}`
  const error = typeof notification.error === 'string'
    ? excerptLine(notification.error, DEVLEAD_ERROR_EXCERPT_MAX)
    : undefined
  // The settled turn's assistant excerpt is the chip's only detail on a
  // successful/blocked turn; a blank stored value must render as absent.
  const summary = typeof notification.summary === 'string'
    ? excerptLine(notification.summary, DEVLEAD_ERROR_EXCERPT_MAX)
    : undefined
  return {
    tooltip,
    who,
    turn,
    transition: String(notification.transition),
    labelKey: transitionLabelKey(notification.transition),
    error,
    summary,
  }
}

/**
 * Latest retained notification of one projection, or null while none is retained.
 * The value crossed the Remote boundary, so a missing or non-array collection
 * (an older/newer Host shape) degrades to "nothing retained" instead of
 * throwing inside the strip.
 * @param notifications - retained notifications, oldest first.
 * @returns the newest notification, or null when the collection is unusable.
 */
export function latestNotification(
  notifications: readonly DevLeadNotification[] | undefined,
): DevLeadNotification | null {
  if (!Array.isArray(notifications)) return null
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
  watchedSessions: readonly unknown[] | undefined,
  rows: Readonly<Record<string, DevLeadWatchedRow | undefined>>,
  statuses: ReadonlyMap<string, DevLeadWatchedStatus> | undefined,
): DevLeadWatchedSummary {
  // The watch set crosses the Remote boundary: a missing or non-array value is
  // an unusable collection, not an empty watch set, but the strip can only
  // render "nothing to describe" without crashing.
  if (!Array.isArray(watchedSessions)) return { watched: 0, running: 0, missing: 0 }
  const seen = new Set<string>()
  let running = 0
  let missing = 0
  for (const candidate of watchedSessions) {
    // The watch set crossed the Remote boundary: an empty or non-string entry
    // must not produce a phantom count.
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    // Own-property lookup: a prototype key (`toString`, `constructor`, …)
    // must count as a lost row, not read an inherited member as a live one.
    const row = Object.hasOwn(rows, candidate) ? rows[candidate] : undefined
    if (row === undefined) missing += 1
    // The Client's live UI status outranks the list's host snapshot: a Session
    // that started or finished a turn since the catalog refresh must count
    // correctly. An unobserved status falls back to the catalog row.
    const status = statuses?.get(candidate)
    if (status?.running ?? row?.running ?? false) running += 1
  }
  return { watched: seen.size, running, missing }
}


/**
 * Dictionary keys of the report chip, one per known kind plus the wire-drift
 * fallback. Kept separate from transition keys: a report is not a turn end.
 */
export type DevLeadReportKey =
  | 'report.kind.progress'
  | 'report.kind.blocked'
  | 'report.kind.decision'
  | 'report.kind.question'
  | 'report.kind.fyi'
  | 'report.kind.unknown'

/** Localized label key per known report kind. */
const REPORT_LABEL_KEYS: Record<DevLeadReportKind, DevLeadReportKey> = {
  progress: 'report.kind.progress',
  blocked: 'report.kind.blocked',
  decision: 'report.kind.decision',
  question: 'report.kind.question',
  fyi: 'report.kind.fyi',
}

/**
 * Map one wire report kind to its localized label key.
 * @param kind - kind value read from the projection.
 * @returns the label key; unknown values fall back to the neutral report label.
 */
export function reportLabelKey(kind: string): DevLeadReportKey {
  return isDevLeadReportKind(kind) ? REPORT_LABEL_KEYS[kind] : 'report.kind.unknown'
}

/**
 * Wire-drift-safe epoch milliseconds of one digest row. The value crossed the
 * Remote boundary, so a missing, non-numeric, or non-finite instant must
 * degrade to a comparable number instead of poisoning a newest-row comparison
 * (`NaN >= x` is always false, which would silently pin the strip to the older
 * digest family).
 * @param value - raw `at` value read from the projection.
 * @returns the finite instant, or 0 when the wire value is unusable.
 */
export function epochMillis(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Rendered fields of the latest-report chip. */
export interface DevLeadReportSummary {
  /** Canonical Host digest line, used as the chip's technical tooltip. */
  readonly tooltip: string
  /** Reporting Session title, otherwise its raw id. */
  readonly who: string
  /** Raw kind value, forwarded to the DOM for the per-kind dot. */
  readonly kind: string
  /** Dictionary key of the localized kind label. */
  readonly labelKey: DevLeadReportKey
  /** Compact summary or message excerpt, when the report carries one. */
  readonly detail: string | undefined
  /** Epoch milliseconds used to compare with the latest notification; 0 when the wire value is unusable. */
  readonly at: number
}

/**
 * Render one retained report as the strip's chip fields.
 * @param report - retained report to summarize.
 * @returns the localized chip fields plus the Host canonical tooltip.
 */
export function reportSummary(report: DevLeadReport): DevLeadReportSummary {
  const title = typeof report.senderSessionTitle === 'string'
    ? excerptLine(report.senderSessionTitle, DEVLEAD_ERROR_EXCERPT_MAX)
    : undefined
  const who = title ?? report.senderSessionId
  const detail = typeof report.summary === 'string'
    ? excerptLine(report.summary, DEVLEAD_ERROR_EXCERPT_MAX)
    : typeof report.message === 'string'
      ? excerptLine(report.message, DEVLEAD_ERROR_EXCERPT_MAX)
      : undefined
  return {
    tooltip: isDevLeadReportKind(report.kind) ? reportLine(report) : `${who} — report ${String(report.kind)}`,
    who,
    kind: String(report.kind),
    labelKey: reportLabelKey(report.kind),
    detail,
    at: epochMillis(report.at),
  }
}

/**
 * Latest retained report of one projection, or null while none is retained.
 * Like {@link latestNotification}, an unusable collection from the wire
 * boundary renders as "nothing retained" instead of throwing.
 * @param reports - retained reports, oldest first.
 * @returns the newest report, or null when the collection is unusable.
 */
export function latestReport(reports: readonly DevLeadReport[] | undefined): DevLeadReport | null {
  if (!Array.isArray(reports)) return null
  return reports.at(-1) ?? null
}
