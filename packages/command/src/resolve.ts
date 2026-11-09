/**
 * Pure Session-reference resolution for the human-facing `/devlead` command.
 *
 * The command accepts an exact Session id or a unique id prefix; the handler
 * feeds it the ids it can currently see (the Session listing plus this lead's
 * watch set) and renders the outcome. Keeping the matching pure makes the
 * ambiguity and miss paths unit-testable without a live host.
 *
 * @module @yankeguo/dsh-command-devlead/resolve
 */

import {
  DEVLEAD_ERROR_EXCERPT_MAX,
  excerptLine,
  type DevLeadSessionView,
} from '@yankeguo/dsh-devlead-protocol'

/** One addressable Session: identity plus the folded title when the host knows one. */
export interface SessionCandidate {
  /** Exact Session identity. */
  readonly sessionId: string
  /** Latest folded title, when one exists. */
  readonly title?: string
}

/** Outcome of resolving one Session reference against the visible candidates. */
export type SessionResolution =
  | { readonly kind: 'resolved'; readonly sessionId: string; readonly title?: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly SessionCandidate[] }
  | { readonly kind: 'missing' }

/** Build one candidate from a Session view, omitting an absent title. */
export function candidateOf(view: DevLeadSessionView): SessionCandidate {
  return view.title === undefined
    ? { sessionId: view.sessionId }
    : { sessionId: view.sessionId, title: view.title }
}

/**
 * Merge a Session listing with this lead's watch set without duplicating ids.
 * The watch set can name Sessions the listing no longer returns (for example a
 * Session created since the listing snapshot), and a stale watched id must
 * still be addressable so `/devlead unwatch` can clean it up.
 * @param listed - views from the Session listing.
 * @param watchedSessionIds - complete watch set of this lead, in watch order.
 * @returns candidates in listing order, then any watch-only ids.
 */
export function mergeCandidates(
  listed: readonly DevLeadSessionView[],
  watchedSessionIds: readonly string[],
): SessionCandidate[] {
  const candidates = new Map<string, SessionCandidate>()
  for (const view of listed) candidates.set(view.sessionId, candidateOf(view))
  for (const sessionId of watchedSessionIds) {
    if (!candidates.has(sessionId)) candidates.set(sessionId, { sessionId })
  }
  return [...candidates.values()]
}

/**
 * Resolve one reference: an exact id wins over any prefix match, a unique id
 * prefix resolves, and anything else is ambiguous or missing.
 * @param query - trimmed human-supplied reference.
 * @param candidates - currently addressable Sessions.
 * @returns the resolution outcome; never throws.
 */
export function resolveSessionReference(
  query: string,
  candidates: readonly SessionCandidate[],
): SessionResolution {
  const reference = query.trim()
  if (reference.length === 0) return { kind: 'missing' }
  for (const candidate of candidates) {
    if (candidate.sessionId !== reference) continue
    return candidate.title === undefined
      ? { kind: 'resolved', sessionId: candidate.sessionId }
      : { kind: 'resolved', sessionId: candidate.sessionId, title: candidate.title }
  }
  const matches = candidates.filter(candidate => candidate.sessionId.startsWith(reference))
  const first = matches[0]
  if (first === undefined) return { kind: 'missing' }
  if (matches.length === 1) {
    return first.title === undefined
      ? { kind: 'resolved', sessionId: first.sessionId }
      : { kind: 'resolved', sessionId: first.sessionId, title: first.title }
  }
  return { kind: 'ambiguous', candidates: matches }
}

/** Shortest candidate list rendered for one ambiguous reference. */
const MAX_RENDERED_CANDIDATES = 10

/**
 * Render one Session reference as `title (session-id)` when a non-blank title
 * is known, or the bare id otherwise. Shared by candidate lists, status rows,
 * and mutation titles so every surface names a Session the same way. The title
 * is folded through the shared single-line excerpt rule: a hand-edited log or a
 * future title writer must not be able to inject Newlines into command output.
 * @param sessionId - exact Session identity.
 * @param title - folded title, possibly absent or blank.
 * @returns the human-readable reference.
 */
export function sessionRefLabel(sessionId: string, title: string | undefined): string {
  const line = title === undefined ? undefined : excerptLine(title, DEVLEAD_ERROR_EXCERPT_MAX)
  return line === undefined ? sessionId : `${line} (${sessionId})`
}

/**
 * Render one candidate as a bullet line: `title (session-id)` when the title is
 * known, the bare id otherwise.
 * @param candidate - addressable Session.
 * @returns one human-readable line without indentation.
 */
export function candidateLabel(candidate: SessionCandidate): string {
  return sessionRefLabel(candidate.sessionId, candidate.title)
}

/**
 * Render the candidate list of one ambiguous reference, bounded so a one-letter
 * prefix cannot flood the transcript.
 * @param candidates - every candidate the prefix matched.
 * @returns indented lines; the last line reports any truncated remainder.
 */
export function formatCandidates(candidates: readonly SessionCandidate[]): string[] {
  const shown = candidates.slice(0, MAX_RENDERED_CANDIDATES)
  const lines = shown.map(candidate => `  - ${candidateLabel(candidate)}`)
  const hidden = candidates.length - shown.length
  if (hidden > 0) lines.push(`  … and ${hidden} more`)
  return lines
}
