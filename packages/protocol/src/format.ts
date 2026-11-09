/**
 * Pure formatting and construction helpers shared by the Host notification
 * builder and the browser status strip. No clock, no I/O, no DSH runtime.
 *
 * @module @yankeguo/dsh-devlead-protocol
 */

import {
  DEVLEAD_ERROR_EXCERPT_MAX,
  type DevLeadNotification,
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
  const collapsed = text.replace(/\s+/gu, ' ').trim()
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
  if (value === undefined) return undefined
  return excerptLine(value, DEVLEAD_ERROR_EXCERPT_MAX)
}

/**
 * Render one notification as one prompt/UI digest line.
 * @param notification - observed watched-session transition.
 * @returns a single line naming the Session, turn, and outcome, followed by the
 * recorded failure excerpt (which wins) or assistant summary when one exists.
 */
export function notificationLine(notification: DevLeadNotification): string {
  const title = presentLine(notification.sessionTitle)
  const who = title === undefined ? notification.sessionId : `${title} (${notification.sessionId})`
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
