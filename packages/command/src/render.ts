/**
 * Pure human-facing rendering for the `/devlead` command.
 *
 * The status view always states the mode, the watched Sessions with their live
 * state, and the retained notification digest, because those are exactly the
 * facts a human needs to understand why a lead is or is not being woken. Every
 * view ends with one help line naming the available subcommands.
 *
 * @module @yankeguo/dsh-command-devlead/render
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import {
  formatInstant,
  notificationLine,
  transitionLabel,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadSessionView } from '@yankeguo/dsh-devlead-protocol'
import { sessionRefLabel } from './resolve.ts'

/** How many retained notifications the status view shows. */
export const RECENT_NOTIFICATION_LIMIT = 5

/** One-line command reminder shown at the bottom of every status view. */
export const HELP_LINE =
  'Help: /devlead (status) | /devlead on | /devlead off | /devlead watch <session> | /devlead unwatch <session>'

/** Everything the status view renders. */
export interface DevLeadStatusSnapshot {
  /** Whether DevLead mode is selected for the receiving Session. */
  readonly enabled: boolean
  /**
   * Whether the Host composes the optional experimental Git worktree service,
   * so a dispatched Session can be isolated into its own checkout.
   */
  readonly worktreeIsolation: boolean
  /** Watched Sessions the host could describe, in watch order. */
  readonly watched: readonly DevLeadSessionView[]
  /** Watched Session ids the host could not describe, in watch order. */
  readonly missingWatched: readonly string[]
  /** Retained notifications, oldest first. */
  readonly notifications: readonly DevLeadNotification[]
}

/** Human label of the mode switch. */
export function modeLabel(enabled: boolean): string {
  return enabled ? 'on' : 'off'
}

/**
 * Render one Session as `title (session-id)`, or the bare id without a title.
 * @param view - one Session view.
 * @returns the human-readable reference shared with the command's other views.
 */
export function sessionLabel(view: DevLeadSessionView): string {
  return sessionRefLabel(view.sessionId, view.title)
}

/**
 * Render the live state of one watched Session: lifecycle state, queued input,
 * and the latest settled turn when the host folded one.
 * @param view - one watched Session view.
 * @returns a compact single-line state such as `running · last turn 3 completed`.
 */
export function sessionStateLabel(view: DevLeadSessionView): string {
  const state = view.archived
    ? 'archived'
    : view.running
      ? 'running'
      : view.live
        ? 'idle'
        : 'cold'
  const parts = [state]
  if (view.running && (view.pendingInputs ?? 0) > 0) parts.push(`${view.pendingInputs} queued`)
  if (view.lastTurn !== undefined) {
    const outcome = view.lastTransition === undefined ? '' : ` ${transitionLabel(view.lastTransition)}`
    parts.push(`last turn ${view.lastTurn}${outcome}`)
  }
  const base = parts.join(' · ')
  return view.lastError === undefined ? base : `${base}: ${view.lastError}`
}

/** Render the watched-Session block lines. */
function watchedLines(snapshot: DevLeadStatusSnapshot): string[] {
  const total = snapshot.watched.length + snapshot.missingWatched.length
  if (total === 0) return ['Watched sessions: none']
  const running = snapshot.watched.filter(view => view.running).length
  const summary = running === 0
    ? `Watched sessions: ${total}`
    : `Watched sessions: ${total} (${running} running)`
  const lines = [summary]
  for (const view of snapshot.watched) lines.push(`  - ${sessionLabel(view)} — ${sessionStateLabel(view)}`)
  for (const sessionId of snapshot.missingWatched) lines.push(`  - ${sessionId} — not found`)
  return lines
}

/** Render the retained-notification block lines, newest last. */
function notificationLines(snapshot: DevLeadStatusSnapshot): string[] {
  if (snapshot.notifications.length === 0) return ['Recent notifications: none']
  const lines = ['Recent notifications:']
  for (const notification of snapshot.notifications) {
    lines.push(`  - ${formatInstant(notification.at)} ${notificationLine(notification)}`)
  }
  return lines
}

/**
 * Render the shared body of every `/devlead` success view.
 * @param snapshot - current mode, watch set, and notification digest.
 * @returns plain output lines; the caller supplies any leading title.
 */
export function statusLines(snapshot: DevLeadStatusSnapshot): string[] {
  const lines = [
    `DevLead mode: ${modeLabel(snapshot.enabled)}`,
    `Worktree isolation: ${snapshot.worktreeIsolation ? 'available' : 'unavailable'}`,
    ...watchedLines(snapshot),
    ...notificationLines(snapshot),
  ]
  if (!snapshot.enabled) {
    lines.push(
      'DevLead mode is off: no notification wakes this Session until it is turned on again.',
      'Turn DevLead mode on with: /devlead on',
    )
  }
  lines.push(HELP_LINE)
  return lines
}

/**
 * Render a successful status or mutation view.
 * @param snapshot - current mode, watch set, and notification digest.
 * @param title - optional one-line outcome placed above the status body.
 * @returns a successful command result rather than a thrown failure.
 */
export function renderStatus(snapshot: DevLeadStatusSnapshot, title?: string): CommandResult {
  const lines = title === undefined ? [] : [title, '']
  return { kind: 'success', text: [...lines, ...statusLines(snapshot)].join('\n') }
}

/**
 * Render a friendly command error.
 * @param text - explanation shown to the human.
 * @returns an error result rather than a thrown failure.
 */
export function errorResult(text: string): CommandResult {
  return { kind: 'error', text }
}
