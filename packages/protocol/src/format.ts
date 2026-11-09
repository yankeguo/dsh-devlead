/**
 * Pure formatting and construction helpers shared by the Host notification
 * builder and the browser status strip. No clock, no I/O, no DSH runtime.
 *
 * @module @yankeguo/dsh-devlead-protocol
 */

import type { DevLeadNotification, DevLeadTransition } from './types.ts'

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
 * Whether a raw value is a known transition literal.
 * @param value - candidate value.
 * @returns whether {@link value} is a {@link DevLeadTransition}.
 */
export function isDevLeadTransition(value: unknown): value is DevLeadTransition {
  return typeof value === 'string' && (DEVLEAD_TRANSITIONS as readonly string[]).includes(value)
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
 * @param text - source text.
 * @param max - maximum retained characters including the ellipsis.
 * @returns the collapsed excerpt, or undefined when nothing remains.
 */
export function excerptLine(text: string, max: number): string | undefined {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return undefined
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`
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
 * Render one notification as one prompt/UI digest line.
 * @param notification - observed watched-session transition.
 * @returns a bounded single line naming the Session, turn, and outcome.
 */
export function notificationLine(notification: DevLeadNotification): string {
  const who = notification.sessionTitle === undefined
    ? notification.sessionId
    : `${notification.sessionTitle} (${notification.sessionId})`
  const error = notification.error === undefined ? '' : `: ${notification.error}`
  const summary = notification.error === undefined && notification.summary !== undefined
    ? `: ${notification.summary}`
    : ''
  return `${who} — turn ${notification.turn} ${transitionLabel(notification.transition)}${error}${summary}`
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
 */
export function formatInstant(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/u, 'Z')
}
