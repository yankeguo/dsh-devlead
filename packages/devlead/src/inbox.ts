/**
 * Pending-inbox visibility and interrupt inbox policies.
 *
 * The Host inbox is a durable projection folded from `agent/inbox/spliced`
 * events, and its public contract exposes per-message operations
 * (`remove`/`prepend`/`append`) on every supported DSH version (rc.1–rc.5).
 * This module reads pending inputs for the detail tool and implements the
 * snapshot → stop → restore sequence behind the `keep`/`clear-own` interrupt
 * policies: the Host's stop providers always clear the inbox, so retention is
 * a restore of the same identified messages after the stop, not a veto of it.
 *
 * @module @yankeguo/dsh-devlead/inbox
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { DEVLEAD_ERROR_EXCERPT_MAX, DEVLEAD_MESSAGE_KIND, excerptLine } from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadInterruptInboxPolicy, DevLeadQueuedInput } from '@yankeguo/dsh-devlead-protocol'

/** One pending message paired with the boundary that holds it. */
interface LocatedInput {
  readonly boundary: 'next-turn' | 'next-step'
  readonly message: UserMessage
}

/** Read one optional string field of an untrusted source record. */
function sourceString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Defensive source record of one pending message (the wire may drift). */
function sourceOf(message: UserMessage): Record<string, unknown> {
  const source: unknown = message.source
  return typeof source === 'object' && source !== null && !Array.isArray(source)
    ? source as Record<string, unknown>
    : {}
}

/**
 * Whether one pending message is a relay prompt authored by the given lead.
 * Notices and other producers are not "own" inputs: a notice carries no
 * sender, and another lead's relay belongs to that lead.
 * @param message - pending message.
 * @param leadSessionId - exact lead Session identity.
 * @returns whether the message is this lead's relay prompt.
 */
export function isOwnRelay(message: UserMessage, leadSessionId: string): boolean {
  const source = sourceOf(message)
  return source.kind === DEVLEAD_MESSAGE_KIND
    && source.form === 'relay'
    && source.senderSessionId === leadSessionId
}

/** Snapshot both inbox boundaries in queue order. */
function locatedInputs(agent: Agent): LocatedInput[] {
  return [
    ...agent.inbox.nextTurn.map(message => ({ boundary: 'next-turn' as const, message })),
    ...agent.inbox.nextStep.map(message => ({ boundary: 'next-step' as const, message })),
  ]
}

/**
 * Find the durable enqueue instant of each pending message: the newest
 * `agent/inbox/spliced` event whose insertion carries the message id. The scan
 * walks backwards and stops once every id is resolved, so a long history costs
 * only the tail since the last enqueue.
 * @param session - live Session whose log carries the inbox splices.
 * @param ids - pending message identities.
 * @returns enqueue instants by message id; ids without a recorded splice are absent.
 */
function enqueuedTimes(session: Session, ids: ReadonlySet<string>): Map<string, number> {
  const times = new Map<string, number>()
  if (ids.size === 0) return times
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0 && times.size < ids.size; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent/inbox/spliced') continue
    const inserted = (event.data as { inserted?: unknown }).inserted
    if (!Array.isArray(inserted)) continue
    for (const candidate of inserted) {
      const id = (candidate as { id?: unknown } | null)?.id
      if (typeof id === 'string' && ids.has(id) && !times.has(id)) times.set(id, event.time)
    }
  }
  return times
}

/** Bounded single-line excerpt of one message's text blocks. */
function textExcerpt(message: UserMessage): string | undefined {
  const blocks: unknown = message.content
  if (!Array.isArray(blocks)) return undefined
  const text = blocks
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join(' ')
  return excerptLine(text, DEVLEAD_ERROR_EXCERPT_MAX)
}

/**
 * Project one live Agent's pending inbox onto the model-facing detail rows.
 * @param agent - live Agent whose inbox is read.
 * @returns queued inputs in queue order (next-turn, then next-step).
 */
export function queuedInputsOf(agent: Agent): DevLeadQueuedInput[] {
  const located = locatedInputs(agent)
  const times = enqueuedTimes(agent.session, new Set(located.map(entry => String(entry.message.id))))
  return located.map(({ boundary, message }) => {
    const source = sourceOf(message)
    const id = String(message.id)
    const excerpt = textExcerpt(message)
    const enqueuedAt = times.get(id)
    const sourceForm = sourceString(source, 'form')
    const senderSessionId = sourceString(source, 'senderSessionId')
    return {
      id,
      boundary,
      sourceKind: sourceString(source, 'kind') ?? 'unknown',
      ...(sourceForm === undefined ? {} : { sourceForm }),
      ...(senderSessionId === undefined ? {} : { senderSessionId }),
      ...(excerpt === undefined ? {} : { excerpt }),
      ...(enqueuedAt === undefined ? {} : { enqueuedAt }),
    }
  })
}

/**
 * Restore the pending inputs an interrupt policy keeps, after the Host stop
 * cleared the inbox.
 *
 * The stop providers discard every pending message, so retention is a restore
 * of the same identified messages: each kept message is prepended back to its
 * original boundary in its original relative order, ahead of anything enqueued
 * after the stop. The aborted driver cannot claim restored input — the loop
 * checks its abort signal before every synchronous claim — so the restored
 * work runs in the turns after the replacement prompt's wake, in queue order.
 * @param agent - target Agent whose inbox the stop just cleared.
 * @param kept - snapshot entries the policy keeps, in original queue order.
 * @returns number of messages actually restored (skipping ids already pending again).
 */
export function restoreInputs(agent: Agent, kept: readonly LocatedInput[]): number {
  const pending = new Set(locatedInputs(agent).map(entry => String(entry.message.id)))
  let restored = 0
  // Prepend in reverse so the original relative order survives at the head.
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const entry = kept[index]
    if (entry === undefined) continue
    const id = String(entry.message.id)
    if (pending.has(id)) continue
    agent.inbox.prepend(entry.boundary, entry.message)
    pending.add(id)
    restored += 1
  }
  return restored
}

/**
 * Snapshot the inputs an interrupt policy keeps before the stop clears them.
 * @param agent - running target Agent.
 * @param leadSessionId - exact lead Session identity (the `clear-own` author).
 * @param policy - retention policy; `clear-all` keeps nothing.
 * @returns kept entries in original queue order.
 */
export function keptInputsOf(
  agent: Agent,
  leadSessionId: string,
  policy: DevLeadInterruptInboxPolicy,
): LocatedInput[] {
  if (policy === 'clear-all') return []
  const located = locatedInputs(agent)
  return policy === 'keep' ? located : located.filter(entry => !isOwnRelay(entry.message, leadSessionId))
}