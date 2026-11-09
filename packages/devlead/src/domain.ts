/**
 * Host-side vocabulary of the DevLead domain: the durable record payloads
 * (declared against the Session plugin-record map), the message attribution of
 * DevLead-authored user messages, and the strict decoders the fold uses.
 *
 * Kept apart from `@yankeguo/dsh-devlead-protocol` (pure, browser-safe) because
 * these declarations pull dsh-session and dsh-llm into the Host program.
 *
 * The decoders are the fold's only trust boundary: a persisted plugin record is
 * attacker-adjacent JSON (a hand-edited or migrated log), so each decoder
 * accepts exactly the fields its writer produces and rejects drift instead of
 * silently dropping or coercing it.
 *
 * @module @yankeguo/dsh-devlead
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the Session type tables and the plugin-record map into this program.
import type {} from '@deepseek-ai/dsh-session/types'
import {
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_RECORD_VERSION,
  DEVLEAD_WATCH_RECORD_TYPE,
  DEVLEAD_DEFAULT_MAX_WATCHED,
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  excerptLine,
  isDevLeadTransition,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadModeRecord,
  DevLeadNotification,
  DevLeadNotificationRecord,
  DevLeadTransition,
  DevLeadWatchRecord,
} from '@yankeguo/dsh-devlead-protocol'
import { thrownMessage } from './error.ts'

export {
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_RECORD_VERSION,
  DEVLEAD_WATCH_RECORD_TYPE,
  DEVLEAD_DEFAULT_MAX_WATCHED,
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  notificationId,
}
export type { DevLeadNotification, DevLeadModeRecord, DevLeadWatchRecord, DevLeadNotificationRecord }

/** Durable attribution of one message DevLead authored for another Session. */
export interface DevLeadRelayMessageSource {
  readonly kind: 'devlead'
  /** A prompt the lead admitted into another Session. */
  readonly form: 'relay'
  /** Session id of the lead Agent that authored the prompt. */
  readonly senderSessionId: SessionId
}

/** Durable attribution of the runtime wake-up digest addressed to the lead itself. */
export interface DevLeadNoticeMessageSource {
  readonly kind: 'devlead'
  /** A runtime digest of watched-session transitions, not human or lead-authored content. */
  readonly form: 'notice'
}

/** Union of the two DevLead message sources. */
export type DevLeadMessageSource = DevLeadRelayMessageSource | DevLeadNoticeMessageSource

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Prompts and wake-up digests authored by the DevLead runtime. */
    devlead: DevLeadMessageSource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Complete DevLead mode selection of one Session. */
    'plugin:devlead/mode': DevLeadModeRecord
    /** Complete watched-session set of one DevLead Session. */
    'plugin:devlead/watch': DevLeadWatchRecord
    /** One watched-session transition notification. */
    'plugin:devlead/notification': DevLeadNotificationRecord
  }
}

/**
 * Build the durable user message that admits a lead-authored prompt into a
 * watched Session.
 * @param text - prompt text.
 * @param lead - exact live lead Agent that authored it.
 * @returns the identified user message.
 */
export function createDevLeadPromptMessage(text: string, lead: Agent): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: DEVLEAD_MESSAGE_KIND, form: 'relay', senderSessionId: lead.id },
  })
}

/**
 * Build the durable user message that wakes a lead with a notification digest.
 * @param text - rendered digest text.
 * @returns the identified user message.
 */
export function createDevLeadNoticeMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: DEVLEAD_MESSAGE_KIND, form: 'notice' },
  })
}

/**
 * Build one durable mode record payload.
 * @param enabled - selected mode.
 * @param at - epoch milliseconds of the change.
 * @returns the record payload.
 */
export function modeRecord(enabled: boolean, at: number): DevLeadModeRecord {
  return { kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled, at }
}

/**
 * Build one durable whole-value watch record payload.
 * @param sessions - complete watch set after the mutation.
 * @param at - epoch milliseconds of the change.
 * @returns the record payload.
 */
export function watchRecord(sessions: readonly string[], at: number): DevLeadWatchRecord {
  return { kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION, sessions, at }
}

/**
 * Build one durable notification record payload.
 * @param notification - observed transition.
 * @returns the record payload.
 */
export function notificationRecord(notification: DevLeadNotification): DevLeadNotificationRecord {
  return { kind: 'devlead/notification', version: DEVLEAD_RECORD_VERSION, notification }
}

/**
 * Build one notification for a settled watched-session turn.
 * @param sessionId - watched Session identity.
 * @param sessionTitle - folded title at observation time, when one exists.
 * @param transition - how the turn ended.
 * @param turn - settled turn number.
 * @param at - epoch milliseconds when the Host observed it.
 * @param error - failure text for `error` transitions.
 * @param summary - latest assistant excerpt observed before the turn settled.
 * @returns the notification.
 */
export function devLeadNotification(
  sessionId: string,
  sessionTitle: string | undefined,
  transition: DevLeadTransition,
  turn: number,
  at: number,
  error?: string,
  summary?: string,
): DevLeadNotification {
  return {
    id: notificationId(sessionId, turn, transition),
    sessionId,
    ...(sessionTitle === undefined ? {} : { sessionTitle }),
    transition,
    turn,
    at,
    ...(error === undefined ? {} : { error }),
    ...(summary === undefined ? {} : { summary }),
  }
}

/**
 * Largest epoch-millisecond instant a JavaScript `Date` can represent. A larger
 * persisted instant would survive schema validation but make every renderer
 * fail on `new Date(value).toISOString()`, so the decoders reject it here.
 */
const MAX_INSTANT = 8_640_000_000_000_000

/**
 * Clamp one observed instant into the representable Date range. The hub writes
 * the settled event's own `time` into durable records; a restored or foreign
 * log carrying an unrepresentable instant must not make the writer persist a
 * record that the strict fold then rejects.
 * @param at - observed epoch milliseconds.
 * @param fallback - replacement instant (normally the current clock).
 * @returns a non-negative representable epoch-millisecond instant.
 */
export function representableInstant(at: number, fallback: number): number {
  return Number.isSafeInteger(at) && at >= 0 && at <= MAX_INSTANT ? at : fallback
}

/**
 * Reject a persisted payload that is not a plain record.
 * @param value - persisted payload.
 * @param type - record name used in the failure text.
 * @returns the payload as a mutable record.
 */
function expectRecord(value: unknown, type: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`record "${type}" payload is not a plain object`)
  }
  return value as Record<string, unknown>
}

/**
 * Reject unexpected or missing fields of one decoded payload. Writers always
 * stamp a complete, closed shape, so an unknown field is version drift and a
 * missing required field is corruption.
 * @param value - payload record.
 * @param label - payload name used in the failure text.
 * @param required - fields every payload must carry.
 * @param optional - further fields a payload may carry.
 */
function expectFields(
  value: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} carries unexpected field ${JSON.stringify(key)}`)
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${label} is missing field ${JSON.stringify(key)}`)
  }
}

/** Reject a persisted record with an unexpected kind or version. */
function expectEnvelope(value: Record<string, unknown>, type: string, kind: string): void {
  if (value.kind !== kind) {
    throw new Error(`record "${type}" carries unexpected kind ${JSON.stringify(value.kind)}`)
  }
  if (value.version !== DEVLEAD_RECORD_VERSION) {
    throw new Error(`record "${type}" carries unsupported version ${JSON.stringify(value.version)}`)
  }
}

/**
 * Validate one persisted epoch-millisecond instant.
 * @param value - persisted field.
 * @param label - field name used in the failure text.
 * @returns the validated instant.
 */
function decodeInstant(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_INSTANT) {
    throw new Error(`${label} must be a non-negative integer instant in epoch milliseconds`)
  }
  return value as number
}

/**
 * Validate one persisted 1-based turn number.
 * @param value - persisted field.
 * @param label - field name used in the failure text.
 * @returns the validated turn.
 */
function decodeTurn(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value as number
}

/**
 * Decode one persisted mode record.
 * @param value - persisted payload.
 * @returns the decoded mode record.
 * @throws when the payload is not a valid mode record.
 */
export function decodeModeRecord(value: unknown): DevLeadModeRecord {
  const record = expectRecord(value, DEVLEAD_MODE_RECORD_TYPE)
  const label = 'mode record'
  expectFields(record, label, ['kind', 'version', 'enabled', 'at'])
  expectEnvelope(record, DEVLEAD_MODE_RECORD_TYPE, 'devlead/mode')
  if (typeof record.enabled !== 'boolean') throw new Error(`${label} enabled must be a boolean`)
  return {
    kind: 'devlead/mode',
    version: DEVLEAD_RECORD_VERSION,
    enabled: record.enabled,
    at: decodeInstant(record.at, `${label} at`),
  }
}

/**
 * Decode one persisted watch record.
 * @param value - persisted payload.
 * @returns the decoded watch record.
 * @throws when the payload is not a valid watch record.
 */
export function decodeWatchRecord(value: unknown): DevLeadWatchRecord {
  const record = expectRecord(value, DEVLEAD_WATCH_RECORD_TYPE)
  const label = 'watch record'
  expectFields(record, label, ['kind', 'version', 'sessions', 'at'])
  expectEnvelope(record, DEVLEAD_WATCH_RECORD_TYPE, 'devlead/watch')
  if (!Array.isArray(record.sessions)
    || !record.sessions.every(session => typeof session === 'string' && session.length > 0)) {
    throw new Error(`${label} sessions must be a non-empty string array`)
  }
  if (new Set(record.sessions).size !== record.sessions.length) {
    throw new Error(`${label} sessions must be unique`)
  }
  return {
    kind: 'devlead/watch',
    version: DEVLEAD_RECORD_VERSION,
    sessions: [...record.sessions] as string[],
    at: decodeInstant(record.at, `${label} at`),
  }
}

/**
 * Decode one persisted notification value.
 * @param value - persisted notification.
 * @returns the decoded notification.
 * @throws when the value is not a valid notification.
 */
export function decodeNotification(value: unknown): DevLeadNotification {
  const record = expectRecord(value, DEVLEAD_NOTIFICATION_RECORD_TYPE)
  const label = 'notification'
  expectFields(record, label, ['id', 'sessionId', 'transition', 'turn', 'at'], [
    'sessionTitle',
    'error',
    'summary',
  ])
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`${label} id must be a non-empty string`)
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
    throw new Error(`${label} sessionId must be a non-empty string`)
  }
  if (record.sessionTitle !== undefined
    && (typeof record.sessionTitle !== 'string' || record.sessionTitle.length === 0)) {
    throw new Error(`${label} sessionTitle must be a non-empty string when present`)
  }
  if (!isDevLeadTransition(record.transition)) {
    throw new Error(`${label} transition ${JSON.stringify(record.transition)} is not recognized`)
  }
  const turn = decodeTurn(record.turn, `${label} turn`)
  if (record.error !== undefined && (typeof record.error !== 'string' || record.error.length === 0)) {
    throw new Error(`${label} error must be a non-empty string when present`)
  }
  if (record.summary !== undefined && (typeof record.summary !== 'string' || record.summary.length === 0)) {
    throw new Error(`${label} summary must be a non-empty string when present`)
  }
  const id = notificationId(record.sessionId, turn, record.transition)
  if (record.id !== id) throw new Error(`${label} id must be ${id}`)
  return {
    id,
    sessionId: record.sessionId,
    ...(record.sessionTitle === undefined ? {} : { sessionTitle: record.sessionTitle }),
    transition: record.transition,
    turn,
    at: decodeInstant(record.at, `${label} at`),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.summary === undefined ? {} : { summary: record.summary }),
  }
}

/**
 * Decode one persisted notification record.
 * @param value - persisted payload.
 * @returns the decoded notification value.
 * @throws when the payload is not a valid notification record.
 */
export function decodeNotificationRecord(value: unknown): DevLeadNotification {
  const record = expectRecord(value, DEVLEAD_NOTIFICATION_RECORD_TYPE)
  const label = 'notification record'
  expectFields(record, label, ['kind', 'version', 'notification'])
  expectEnvelope(record, DEVLEAD_NOTIFICATION_RECORD_TYPE, 'devlead/notification')
  return decodeNotification(record.notification)
}

/**
 * Collapse one failure into the bounded excerpt a notification stores.
 * @param error - thrown value or structured failure record.
 * @returns the excerpt, or undefined when no message remains.
 */
export function failureExcerpt(error: unknown): string | undefined {
  return excerptLine(thrownMessage(error), DEVLEAD_ERROR_EXCERPT_MAX)
}

/**
 * Collapse the text blocks of one assistant message into the bounded
 * single-line excerpt stored on notifications and Session detail views. The
 * excerpt rule exists here once, so the notification hub and the read-side
 * views can never disagree about it.
 * @param blocks - assistant message content blocks.
 * @returns the excerpt, or undefined when the message carries no text.
 */
export function assistantExcerpt(blocks: readonly unknown[]): string | undefined {
  const text = blocks
    .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join(' ')
  return excerptLine(text, DEVLEAD_ERROR_EXCERPT_MAX)
}
