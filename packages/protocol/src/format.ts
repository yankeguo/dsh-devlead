/**
 * Pure formatting and construction helpers shared by the Host notification
 * builder and the browser status strip. No clock, no I/O, no DSH runtime.
 *
 * @module @yankeguo/dsh-devlead-protocol
 */

import {
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_REPORT_KINDS,
  type DevLeadNotification,
  type DevLeadReport,
  type DevLeadReportKind,
  type DevLeadTransition,
} from './types.ts'

/** Every accepted transition literal, in reporting order. */
export const DEVLEAD_TRANSITIONS: readonly DevLeadTransition[] = [
  'completed',
  'error',
  'blocked',
  'aborted',
  'max-tokens',
  'interrupted',
  'forked',
]

/**
 * Membership set of {@link DEVLEAD_TRANSITIONS}, so a wire-drift check does not
 * pay a linear scan and needs no cast on the public array type.
 */
const TRANSITION_SET: ReadonlySet<string> = new Set(DEVLEAD_TRANSITIONS)

/**
 * Whether a raw value is a known transition literal.
 * @param value - candidate value.
 * @returns whether {@link value} is a {@link DevLeadTransition}.
 */
export function isDevLeadTransition(value: unknown): value is DevLeadTransition {
  return typeof value === 'string' && TRANSITION_SET.has(value)
}

/**
 * Build the deterministic identity of one notification.
 * @param sessionId - watched Session identity.
 * @param turn - settled turn number.
 * @param transition - how the turn ended.
 * @returns the notification id.
 */
export function notificationId(sessionId: string, turn: number, transition: DevLeadTransition): string {
  return `${sessionId}:${turn}:${transition}`
}

/**
 * Collapse free text into one bounded single line.
 *
 * Whitespace runs become one space and the result is trimmed. The budget
 * counts Unicode code points, not UTF-16 units, so truncation never splits a
 * surrogate pair; the ellipsis is part of the budget. A non-finite budget
 * disables truncation, and a budget below one cannot hold even the ellipsis,
 * which yields undefined.
 * @param text - source text.
 * @param max - maximum retained code points including the ellipsis.
 * @returns the collapsed excerpt, or undefined when nothing remains or the budget is unusable.
 */
export function excerptLine(text: string, max: number): string | undefined {
  // Whitespace runs first become one space; remaining C0/C1 controls (ESC, BEL,
  // CSI, …) are stripped so a child-controlled title/summary cannot inject
  // terminal escapes or hyperlinks into a prompt, command line, or UI chip.
  const collapsed = text
    .replace(/\s+/gu, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .trim()
  if (collapsed.length === 0) return undefined
  const budget = Number.isFinite(max) ? Math.floor(max) : Number.POSITIVE_INFINITY
  if (budget < 1) return undefined
  const points = Array.from(collapsed)
  if (points.length <= budget) return collapsed
  return `${points.slice(0, budget - 1).join('')}…`
}

/** English technical label of one transition, used in Host-rendered prompt text. */
const TRANSITION_LABELS: Record<DevLeadTransition, string> = {
  completed: 'completed',
  error: 'failed',
  blocked: 'blocked',
  aborted: 'cancelled',
  'max-tokens': 'hit the output-token limit',
  interrupted: 'interrupted',
  forked: 'forked',
}

/**
 * Label one transition for Host-rendered prompt text.
 * @param transition - settled-turn outcome.
 * @returns a stable English label.
 */
export function transitionLabel(transition: DevLeadTransition): string {
  return TRANSITION_LABELS[transition]
}

/**
 * One optional stored text field, or undefined when it is absent or collapses
 * to nothing. Titles and excerpts cross the record/wire boundary, so a blank
 * value must not become an empty title pair, a newline must not forge another
 * digest line, and an oversized value must not dominate the prompt. The shared
 * excerpt rule does all three (whitespace collapse, trim, code-point budget).
 * @param value - optional stored text.
 * @returns the bounded single-line text, or undefined when there is none.
 */
function presentLine(value: string | undefined): string | undefined {
  // Wire drift can hand a renderer a non-string where the type says string;
  // degrade to "absent" instead of throwing inside a digest line.
  if (typeof value !== 'string') return undefined
  return excerptLine(value, DEVLEAD_ERROR_EXCERPT_MAX)
}

/**
 * Render one Session reference as `title (session-id)` when a non-blank title
 * is known, or the bare id otherwise. Shared by command candidate lists, status
 * rows, mutation titles, and notification/report digest lines so every surface
 * names a Session the same way. The title is folded through the shared
 * single-line excerpt rule: a hand-edited log or a future title writer must not
 * be able to inject newlines into command output or a digest.
 * @param sessionId - exact Session identity.
 * @param title - folded title, possibly absent or blank.
 * @returns the human-readable reference.
 */
export function sessionRefLabel(sessionId: string, title: string | undefined): string {
  const line = presentLine(title)
  return line === undefined ? sessionId : `${line} (${sessionId})`
}

/**
 * Render one notification as one prompt/UI digest line.
 * @param notification - observed watched-session transition.
 * @returns a single line naming the Session, turn, and outcome, followed by the
 * recorded failure excerpt (which wins) or assistant summary when one exists.
 */
export function notificationLine(notification: DevLeadNotification): string {
  const who = sessionRefLabel(notification.sessionId, notification.sessionTitle)
  // Only a real excerpt wins over the assistant summary: a blank failure text
  // must fall through instead of suppressing the recorded summary.
  const error = presentLine(notification.error)
  const detail = error ?? presentLine(notification.summary)
  const suffix = detail === undefined ? '' : `: ${detail}`
  return `${who} — turn ${notification.turn} ${transitionLabel(notification.transition)}${suffix}`
}

/**
 * Render the retained notification digest as prompt/UI lines, newest last.
 * @param notifications - retained notifications.
 * @returns one line per notification, oldest first.
 */
export function notificationDigest(notifications: readonly DevLeadNotification[]): string[] {
  return notifications.map(notificationLine)
}

/**
 * Render a portable instant for prompt text and tool output.
 * @param at - epoch milliseconds.
 * @returns the compact UTC `YYYY-MM-DDTHH:mm:ssZ` spelling.
 * @throws {RangeError} when {@link at} is not a finite instant inside the
 *   `Date` range (±8.64e15 ms); callers pass Host-recorded event times, which
 *   are validated before they reach a record or notification.
 */
export function formatInstant(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

/** English technical label of one report kind, used in Host-rendered prompt text. */
const REPORT_KIND_LABELS: Record<DevLeadReportKind, string> = {
  progress: 'progress',
  blocked: 'blocked',
  decision: 'decision needed',
  question: 'question',
  fyi: 'fyi',
}

/**
 * Membership-checked report kind guard.
 * @param value - candidate value from the wire or a tool argument.
 * @returns whether the value is a known report kind.
 */
export function isDevLeadReportKind(value: unknown): value is DevLeadReportKind {
  return typeof value === 'string' && (DEVLEAD_REPORT_KINDS as readonly string[]).includes(value)
}

/**
 * Build the deterministic identity of one report.
 *
 * Same sender, turn, kind, and message map to the same id, so a retried tool
 * call or a replayed durable record cannot duplicate the lead's digest. The
 * message is hashed rather than embedded to keep ids compact.
 *
 * The hash is a 32-bit FNV-1a variant: two different messages of the same
 * sender/turn/kind can theoretically collide (~2^-32 per pair, at most a handful
 * of reports per turn), and the fold would treat the second as a duplicate.
 * That residual risk is accepted deliberately: the id is a durable-record
 * contract, so widening the hash later would orphan existing records and must
 * ride a record-version change rather than a silent algorithm swap.
 * @param senderSessionId - reporting Session identity.
 * @param turn - reporter's current turn (0 before the first turn).
 * @param kind - report kind.
 * @param message - full report message.
 * @returns the stable report id.
 */
export function devLeadReportId(
  senderSessionId: string,
  turn: number,
  kind: DevLeadReportKind,
  message: string,
): string {
  let hash = 0x811c9dc5
  for (const character of `${kind}\u0000${message}`) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return `${senderSessionId}:${turn}:report:${kind}:${(hash >>> 0).toString(36)}`
}

/**
 * Render one report as one compact Host digest line.
 * @param report - report to render.
 * @returns a single line naming the sender, kind, and summary/message excerpt.
 */
export function reportLine(report: DevLeadReport): string {
  const who = sessionRefLabel(report.senderSessionId, report.senderSessionTitle)
  const detail = presentLine(report.summary) ?? presentLine(report.message)
  const suffix = detail === undefined ? '' : `: ${detail}`
  // A drifted kind still renders as a neutral line instead of "report undefined".
  const kind = REPORT_KIND_LABELS[report.kind] ?? String(report.kind)
  return `${who} — report ${kind}${suffix}`
}

/**
 * Render the retained report digest as prompt/UI lines, newest last.
 * @param reports - retained reports.
 * @returns one line per report, oldest first.
 */
export function reportDigest(reports: readonly DevLeadReport[]): string[] {
  return reports.map(reportLine)
}
