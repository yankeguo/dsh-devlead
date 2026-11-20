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
import {
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_PROMPT_INTENTS,
  excerptLine,
} from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadInterruptInboxPolicy,
  DevLeadPromptIntent,
  DevLeadQueuedInput,
} from '@yankeguo/dsh-devlead-protocol'

/** One pending message paired with the boundary that holds it. */
export interface LocatedInput {
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

/**
 * Whether one pending message is an answer to a question report. An answer is
 * recognized by its runtime-stamped `questionId` (or `intent:'answer'`), never
 * by its text; removing one would desynchronize the question state from the
 * child inbox, so retraction refuses it and `clear-own` keeps it.
 * @param message - pending message.
 * @returns whether the message is a DevLead answer.
 */
export function isAnswerMessage(message: UserMessage): boolean {
  const source = sourceOf(message)
  if (source.kind !== DEVLEAD_MESSAGE_KIND) return false
  return sourceString(source, 'questionId') !== undefined || source.intent === 'answer'
}

/**
 * Whether one pending message is a background context notice authored by the
 * given lead. Background notices are `notice`-form (not relay) and carry the
 * lead's sender identity plus `intent:'background'`.
 * @param message - pending message.
 * @param leadSessionId - exact lead Session identity.
 * @returns whether the message is this lead's background notice.
 */
export function isOwnBackground(message: UserMessage, leadSessionId: string): boolean {
  const source = sourceOf(message)
  return source.kind === DEVLEAD_MESSAGE_KIND
    && source.form === 'notice'
    && source.intent === 'background'
    && source.senderSessionId === leadSessionId
}

/**
 * Whether one pending message is retractable by the given lead: its own
 * instruction/correction relay prompts and its own background notices, but
 * never an answer (whose removal would desynchronize the question state).
 * @param message - pending message.
 * @param leadSessionId - exact lead Session identity.
 * @returns whether the lead may withdraw the message.
 */
export function isOwnRetractable(message: UserMessage, leadSessionId: string): boolean {
  if (isAnswerMessage(message)) return false
  return isOwnRelay(message, leadSessionId) || isOwnBackground(message, leadSessionId)
}

/**
 * Whether one pending message is an own input the `clear-own` interrupt policy
 * removes: an instruction/correction relay or a background notice this lead
 * authored. Answers are deliberately excluded — `clear-own` keeps them.
 * @param message - pending message.
 * @param leadSessionId - exact lead Session identity.
 * @returns whether `clear-own` drops the message.
 */
export function isOwnClearable(message: UserMessage, leadSessionId: string): boolean {
  if (isAnswerMessage(message)) return false
  return isOwnRelay(message, leadSessionId) || isOwnBackground(message, leadSessionId)
}

/** Snapshot both inbox boundaries in queue order. */
export function locatedInputs(agent: Agent): LocatedInput[] {
  return [
    ...agent.inbox.nextTurn.map(message => ({ boundary: 'next-turn' as const, message })),
    ...agent.inbox.nextStep.map(message => ({ boundary: 'next-step' as const, message })),
  ]
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
 * @param deliveryStateOf - optional observed lifecycle of a tracked answer
 *   message; absent for messages the runtime does not track.
 * @param enqueuedAtOf - enqueue instant looked up in the Host-driven inbox
 *   projection; omitted when no projection is composed.
 * @returns queued inputs in queue order (next-turn, then next-step).
 */
export function queuedInputsOf(
  agent: Agent,
  deliveryStateOf?: (messageId: string) => 'admitted' | 'claimed' | undefined,
  enqueuedAtOf?: (messageId: string) => number | undefined,
): DevLeadQueuedInput[] {
  const located = locatedInputs(agent)
  return located.map(({ boundary, message }) => {
    const source = sourceOf(message)
    const id = String(message.id)
    const excerpt = textExcerpt(message)
    const enqueuedAt = enqueuedAtOf?.(id)
    const sourceForm = sourceString(source, 'form')
    const senderSessionId = sourceString(source, 'senderSessionId')
    const rawIntent = sourceString(source, 'intent')
    const intent = DEVLEAD_PROMPT_INTENTS.includes(rawIntent as DevLeadPromptIntent)
      ? rawIntent as DevLeadPromptIntent
      : undefined
    const questionId = sourceString(source, 'questionId')
    const wakeRequested = typeof source.wakeRequested === 'boolean' ? source.wakeRequested : undefined
    const deliveryState = deliveryStateOf?.(id)
    return {
      id,
      boundary,
      sourceKind: sourceString(source, 'kind') ?? 'unknown',
      ...(sourceForm === undefined ? {} : { sourceForm }),
      ...(senderSessionId === undefined ? {} : { senderSessionId }),
      ...(excerpt === undefined ? {} : { excerpt }),
      ...(enqueuedAt === undefined ? {} : { enqueuedAt }),
      ...(intent === undefined ? {} : { intent }),
      ...(questionId === undefined ? {} : { questionId }),
      ...(wakeRequested === undefined ? {} : { wakeRequested }),
      ...(deliveryState === undefined ? {} : { deliveryState }),
    }
  })
}

/**
 * List every pending answer message in one live Agent's inbox, with the
 * question identity and authoring lead read from the runtime-stamped source.
 * @param agent - live Agent whose inbox is read.
 * @returns pending answer entries in queue order.
 */
export function pendingAnswersOf(agent: Agent): Array<LocatedInput & {
  readonly questionId: string
  readonly senderSessionId: string | undefined
}> {
  return locatedInputs(agent).flatMap((entry) => {
    if (!isAnswerMessage(entry.message)) return []
    const source = sourceOf(entry.message)
    const questionId = sourceString(source, 'questionId')
    // An answer stamped only with intent:'answer' (no questionId) cannot be
    // correlated to a question; the admission path always stamps questionId.
    if (questionId === undefined) return []
    return [{ ...entry, questionId, senderSessionId: sourceString(source, 'senderSessionId') }]
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
 * `clear-own` removes this lead's instruction/correction relays and background
 * notices but keeps pending answers (removing one would desynchronize the
 * question state from the child inbox); `keep` keeps everything.
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
  return policy === 'keep' ? located : located.filter(entry => !isOwnClearable(entry.message, leadSessionId))
}