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
  DEVLEAD_MAX_INSTANT,
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_QUESTIONS_MAX,
  DEVLEAD_QUESTION_FIELD_MAX,
  DEVLEAD_QUESTION_OPTIONS_MAX,
  DEVLEAD_RECORD_VERSION,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_REPORT_SUMMARY_MAX,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  DEVLEAD_DEFAULT_MAX_WATCHED,
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  devLeadReportId,
  excerptLine,
  isDevLeadReportKind,
  isDevLeadTransition,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadModeRecord,
  DevLeadNotification,
  DevLeadNotificationRecord,
  DevLeadQuestion,
  DevLeadQuestionOption,
  DevLeadReport,
  DevLeadReportKind,
  DevLeadReportRecord,
  DevLeadResetRecord,
  DevLeadTransition,
  DevLeadWatchRecord,
} from '@yankeguo/dsh-devlead-protocol'
import { thrownMessage } from './error.ts'

export {
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_MAX_INSTANT,
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_QUESTIONS_MAX,
  DEVLEAD_QUESTION_FIELD_MAX,
  DEVLEAD_QUESTION_OPTIONS_MAX,
  DEVLEAD_RECORD_VERSION,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_REPORT_SUMMARY_MAX,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  DEVLEAD_DEFAULT_MAX_WATCHED,
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  notificationId,
}
export type {
  DevLeadNotification,
  DevLeadModeRecord,
  DevLeadWatchRecord,
  DevLeadNotificationRecord,
  DevLeadQuestion,
  DevLeadQuestionOption,
  DevLeadReport,
  DevLeadReportKind,
  DevLeadReportRecord,
  DevLeadResetRecord,
}

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
  /** Whether this notice requests a driver wake. */
  readonly wakeRequested?: boolean
  /** Internal delivery lane used to classify queued notices. */
  readonly lane?: 'turn-notice' | 'action-required' | 'background'
  /** Bounded notice summary for Host context surfaces. */
  readonly summary?: string
  /** Report associated with an action-required notice, when one exists. */
  readonly reportId?: string
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
    /** One mid-turn report from a watched Session to its lead. */
    'plugin:devlead/report': DevLeadReportRecord
    /** Reset marker discarding every earlier DevLead record of the Session. */
    'plugin:devlead/reset': DevLeadResetRecord
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
 * @param metadata - optional wake classification and associated report facts.
 * @returns the identified user message.
 */
export function createDevLeadNoticeMessage(
  text: string,
  metadata: Omit<DevLeadNoticeMessageSource, 'kind' | 'form'> = {},
): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: DEVLEAD_MESSAGE_KIND, form: 'notice', ...metadata },
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
 * Build one durable reset record payload.
 *
 * The record carries no state: replay discards every earlier DevLead record of
 * the Session, so both projections restart from their empty initial state.
 * @param at - epoch milliseconds of the reset.
 * @returns the record payload.
 */
export function resetRecord(at: number): DevLeadResetRecord {
  return { kind: 'devlead/reset', version: DEVLEAD_RECORD_VERSION, at }
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
  // The title is record data too, and it is rendered into a model-facing digest
  // line: store the same bounded single-line form the renderer accepts, so a
  // long or multi-line title cannot make the durable payload drift from what
  // every reader will draw.
  const title = sessionTitle === undefined
    ? undefined
    : excerptLine(sessionTitle, DEVLEAD_ERROR_EXCERPT_MAX)
  return {
    id: notificationId(sessionId, turn, transition),
    sessionId,
    ...(title === undefined ? {} : { sessionTitle: title }),
    transition,
    turn,
    at,
    ...(error === undefined ? {} : { error }),
    ...(summary === undefined ? {} : { summary }),
  }
}

/** Deep-copy a structured question payload across the service/durable boundary. */
function cloneQuestions(questions: readonly DevLeadQuestion[]): DevLeadQuestion[] {
  return questions.map(question => ({
    ...(question.id === undefined ? {} : { id: question.id }),
    ...(question.header === undefined ? {} : { header: question.header }),
    question: question.question,
    ...(question.options === undefined ? {} : {
      options: question.options.map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    }),
    ...(question.multi_select === undefined ? {} : { multi_select: question.multi_select }),
  }))
}

/**
 * Build one durable mid-turn report.
 *
 * The caller (the core service) validates emptiness, code-point budgets, the
 * kind, and the rate limit before calling this factory; the factory normalizes
 * display fields into the same bounded single-line form the decoders accept.
 * @param input - report fields already validated by the service.
 * @returns the report payload with its deterministic identity.
 */
export function devLeadReport(input: {
  readonly senderSessionId: string
  readonly senderSessionTitle?: string
  readonly senderWorkspaceId?: string
  readonly senderWorkspaceTitle?: string
  readonly leadSessionId: string
  readonly turn: number
  readonly kind: DevLeadReportKind
  readonly message: string
  readonly summary?: string
  readonly questions?: readonly DevLeadQuestion[]
  readonly at: number
}): DevLeadReport {
  const message = input.message.trim()
  const title = input.senderSessionTitle === undefined
    ? undefined
    : excerptLine(input.senderSessionTitle, DEVLEAD_ERROR_EXCERPT_MAX)
  const summary = input.summary === undefined
    ? undefined
    : excerptLine(input.summary, DEVLEAD_REPORT_SUMMARY_MAX)
  const workspaceTitle = input.senderWorkspaceTitle === undefined
    ? undefined
    : excerptLine(input.senderWorkspaceTitle, DEVLEAD_ERROR_EXCERPT_MAX)
  // The id and the stored turn must agree: the strict fold recomputes the id
  // from the stored turn, so clamping only one side would write a record the
  // writer's own fold rejects.
  const turn = Number.isSafeInteger(input.turn) && input.turn >= 0 ? input.turn : 0
  return {
    id: devLeadReportId(input.senderSessionId, turn, input.kind, message),
    kind: input.kind,
    message,
    ...(summary === undefined ? {} : { summary }),
    ...(input.questions === undefined ? {} : { questions: cloneQuestions(input.questions) }),
    senderSessionId: input.senderSessionId,
    ...(title === undefined ? {} : { senderSessionTitle: title }),
    ...(input.senderWorkspaceId === undefined ? {} : { senderWorkspaceId: input.senderWorkspaceId }),
    ...(workspaceTitle === undefined ? {} : { senderWorkspaceTitle: workspaceTitle }),
    leadSessionId: input.leadSessionId,
    turn,
    at: representableInstant(input.at, Date.now()),
  }
}

/**
 * Build one durable report receipt record.
 * @param report - report appended to the lead's retained digest.
 * @returns the record payload.
 */
export function reportRecord(report: DevLeadReport): DevLeadReportRecord {
  return { kind: 'devlead/report', version: DEVLEAD_RECORD_VERSION, report }
}

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
  return Number.isSafeInteger(at) && at >= 0 && at <= DEVLEAD_MAX_INSTANT ? at : fallback
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
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > DEVLEAD_MAX_INSTANT) {
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
 * Decode one persisted free-text excerpt. The writer stores the shared bounded
 * form (see `excerptLine`), so a value over the budget is drift or tampering:
 * reject it rather than letting a hand-edited log dominate a model prompt or
 * the browser strip. Whitespace is collapsed again by every renderer, so an
 * older/migrated record containing a newline cannot forge an extra line.
 * @param value - persisted field.
 * @param label - field name used in the failure text.
 * @returns the validated non-empty excerpt.
 */
function decodeExcerpt(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string when present`)
  }
  // Each code point is at most two UTF-16 units; check the cheap upper bound
  // before allocating an array for a hand-edited multi-megabyte string.
  if (value.length > DEVLEAD_ERROR_EXCERPT_MAX * 2
    || Array.from(value).length > DEVLEAD_ERROR_EXCERPT_MAX) {
    throw new Error(`${label} must be at most ${DEVLEAD_ERROR_EXCERPT_MAX} code points`)
  }
  return value
}

/**
 * Decode one bounded excerpt with an explicit code-point budget.
 * @param value - persisted field.
 * @param label - field name used in the failure text.
 * @param max - maximum code points.
 * @returns the validated excerpt.
 */
function decodeExcerptWithMax(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string when present`)
  }
  if (value.length > max * 2 || Array.from(value).length > max) {
    throw new Error(`${label} must be at most ${max} code points`)
  }
  return value
}

/** Decode one non-blank structured question string with the shared field budget. */
function decodeQuestionText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string when present`)
  }
  return decodeExcerptWithMax(value, label, DEVLEAD_QUESTION_FIELD_MAX)
}

/** Decode and detach one structured question option. */
function decodeQuestionOption(value: unknown, label: string): DevLeadQuestionOption {
  const option = expectRecord(value, label)
  expectFields(option, label, ['label'], ['description'])
  const description = option.description === undefined
    ? undefined
    : decodeQuestionText(option.description, `${label} description`)
  return {
    label: decodeQuestionText(option.label, `${label} label`),
    ...(description === undefined ? {} : { description }),
  }
}

/** Decode and detach the optional structured payload of a question report. */
function decodeQuestions(value: unknown): DevLeadQuestion[] {
  const label = 'report questions'
  if (!Array.isArray(value)) throw new Error(`${label} must be an array when present`)
  if (value.length > DEVLEAD_QUESTIONS_MAX) {
    throw new Error(`${label} must contain at most ${DEVLEAD_QUESTIONS_MAX} questions`)
  }
  return value.map((entry, index) => {
    const questionLabel = `${label}[${String(index)}]`
    const question = expectRecord(entry, questionLabel)
    expectFields(question, questionLabel, ['question'], ['id', 'header', 'options', 'multi_select'])
    const id = question.id === undefined
      ? undefined
      : decodeQuestionText(question.id, `${questionLabel} id`)
    const header = question.header === undefined
      ? undefined
      : decodeQuestionText(question.header, `${questionLabel} header`)
    if (question.options !== undefined && !Array.isArray(question.options)) {
      throw new Error(`${questionLabel} options must be an array when present`)
    }
    if (Array.isArray(question.options) && question.options.length > DEVLEAD_QUESTION_OPTIONS_MAX) {
      throw new Error(
        `${questionLabel} options must contain at most ${DEVLEAD_QUESTION_OPTIONS_MAX} options`,
      )
    }
    if (question.multi_select !== undefined && typeof question.multi_select !== 'boolean') {
      throw new Error(`${questionLabel} multi_select must be a boolean when present`)
    }
    const options = question.options === undefined
      ? undefined
      : (question.options as unknown[]).map((option, optionIndex) => decodeQuestionOption(
        option,
        `${questionLabel} options[${String(optionIndex)}]`,
      ))
    return {
      ...(id === undefined ? {} : { id }),
      ...(header === undefined ? {} : { header }),
      question: decodeQuestionText(question.question, `${questionLabel} question`),
      ...(options === undefined ? {} : { options }),
      ...(question.multi_select === undefined ? {} : { multi_select: question.multi_select }),
    }
  })
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
 * Decode one persisted report value.
 * @param value - persisted report.
 * @returns the decoded report.
 * @throws when the value is not a valid report.
 */
export function decodeReport(value: unknown): DevLeadReport {
  const record = expectRecord(value, DEVLEAD_REPORT_RECORD_TYPE)
  const label = 'report'
  expectFields(record, label, [
    'id',
    'kind',
    'message',
    'senderSessionId',
    'leadSessionId',
    'turn',
    'at',
  ], [
    'summary',
    'questions',
    'senderSessionTitle',
    'senderWorkspaceId',
    'senderWorkspaceTitle',
  ])
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`${label} id must be a non-empty string`)
  }
  if (!isDevLeadReportKind(record.kind)) {
    throw new Error(`${label} kind ${JSON.stringify(record.kind)} is not recognized`)
  }
  if (typeof record.message !== 'string' || record.message.trim().length === 0) {
    throw new Error(`${label} message must be a non-empty string`)
  }
  if (Array.from(record.message).length > DEVLEAD_REPORT_MESSAGE_MAX) {
    throw new Error(`${label} message must be at most ${DEVLEAD_REPORT_MESSAGE_MAX} code points`)
  }
  if (typeof record.senderSessionId !== 'string' || record.senderSessionId.length === 0) {
    throw new Error(`${label} senderSessionId must be a non-empty string`)
  }
  if (typeof record.leadSessionId !== 'string' || record.leadSessionId.length === 0) {
    throw new Error(`${label} leadSessionId must be a non-empty string`)
  }
  const turn = typeof record.turn === 'number' && Number.isSafeInteger(record.turn) && record.turn >= 0
    ? record.turn
    : (() => { throw new Error(`${label} turn must be a non-negative safe integer`) })()
  const summary = record.summary === undefined
    ? undefined
    : decodeExcerptWithMax(record.summary, `${label} summary`, DEVLEAD_REPORT_SUMMARY_MAX)
  const questions = record.questions === undefined ? undefined : decodeQuestions(record.questions)
  if (questions !== undefined && record.kind !== 'question') {
    throw new Error(`${label} questions are only valid when kind is "question"`)
  }
  const senderSessionTitle = record.senderSessionTitle === undefined
    ? undefined
    : decodeExcerpt(record.senderSessionTitle, `${label} senderSessionTitle`)
  const senderWorkspaceId = record.senderWorkspaceId === undefined
    ? undefined
    : decodeExcerpt(record.senderWorkspaceId, `${label} senderWorkspaceId`)
  const senderWorkspaceTitle = record.senderWorkspaceTitle === undefined
    ? undefined
    : decodeExcerpt(record.senderWorkspaceTitle, `${label} senderWorkspaceTitle`)
  const id = devLeadReportId(record.senderSessionId, turn, record.kind, record.message)
  if (record.id !== id) throw new Error(`${label} id must be ${id}`)
  return {
    id,
    kind: record.kind,
    message: record.message,
    ...(summary === undefined ? {} : { summary }),
    ...(questions === undefined ? {} : { questions }),
    senderSessionId: record.senderSessionId,
    ...(senderSessionTitle === undefined ? {} : { senderSessionTitle }),
    ...(senderWorkspaceId === undefined ? {} : { senderWorkspaceId }),
    ...(senderWorkspaceTitle === undefined ? {} : { senderWorkspaceTitle }),
    leadSessionId: record.leadSessionId,
    turn,
    at: decodeInstant(record.at, `${label} at`),
  }
}

/**
 * Decode one persisted report record.
 * @param value - persisted payload.
 * @returns the decoded report value.
 * @throws when the payload is not a valid report record.
 */
export function decodeReportRecord(value: unknown): DevLeadReport {
  const record = expectRecord(value, DEVLEAD_REPORT_RECORD_TYPE)
  const label = 'report record'
  expectFields(record, label, ['kind', 'version', 'report'])
  expectEnvelope(record, DEVLEAD_REPORT_RECORD_TYPE, 'devlead/report')
  return decodeReport(record.report)
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
    'wakeSuppressedByReportId',
    'wakeSuppressionReason',
  ])
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`${label} id must be a non-empty string`)
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
    throw new Error(`${label} sessionId must be a non-empty string`)
  }
  const sessionTitle = record.sessionTitle === undefined
    ? undefined
    : decodeExcerpt(record.sessionTitle, `${label} sessionTitle`)
  if (!isDevLeadTransition(record.transition)) {
    throw new Error(`${label} transition ${JSON.stringify(record.transition)} is not recognized`)
  }
  const turn = decodeTurn(record.turn, `${label} turn`)
  const error = record.error === undefined ? undefined : decodeExcerpt(record.error, `${label} error`)
  const summary = record.summary === undefined ? undefined : decodeExcerpt(record.summary, `${label} summary`)
  const wakeSuppressedByReportId = record.wakeSuppressedByReportId
  const wakeSuppressionReason = record.wakeSuppressionReason
  if ((wakeSuppressedByReportId === undefined) !== (wakeSuppressionReason === undefined)) {
    throw new Error(`${label} wakeSuppressedByReportId and wakeSuppressionReason must appear together`)
  }
  if (wakeSuppressedByReportId !== undefined
    && (typeof wakeSuppressedByReportId !== 'string' || wakeSuppressedByReportId.length === 0)) {
    throw new Error(`${label} wakeSuppressedByReportId must be a non-empty string when present`)
  }
  if (wakeSuppressionReason !== undefined
    && wakeSuppressionReason !== 'merged-into-pending-wake'
    && wakeSuppressionReason !== 'included-in-sent-wake') {
    throw new Error(`${label} wakeSuppressionReason is not recognized`)
  }
  const id = notificationId(record.sessionId, turn, record.transition)
  if (record.id !== id) throw new Error(`${label} id must be ${id}`)
  return {
    id,
    sessionId: record.sessionId,
    ...(sessionTitle === undefined ? {} : { sessionTitle }),
    transition: record.transition,
    turn,
    at: decodeInstant(record.at, `${label} at`),
    ...(error === undefined ? {} : { error }),
    ...(summary === undefined ? {} : { summary }),
    ...(wakeSuppressedByReportId === undefined ? {} : { wakeSuppressedByReportId }),
    ...(wakeSuppressionReason === undefined ? {} : { wakeSuppressionReason }),
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
 * Decode one persisted reset record.
 *
 * A reset marker is the only owned record replay applies while a previous
 * record has frozen the fold, so its own payload is validated just as strictly:
 * a malformed reset must not silently discard a damaged Session's state (the
 * human can retry `/devlead reset`).
 * @param value - persisted payload.
 * @returns the decoded reset record.
 * @throws when the payload is not a valid reset record.
 */
export function decodeResetRecord(value: unknown): DevLeadResetRecord {
  const record = expectRecord(value, DEVLEAD_RESET_RECORD_TYPE)
  const label = 'reset record'
  expectFields(record, label, ['kind', 'version', 'at'])
  expectEnvelope(record, DEVLEAD_RESET_RECORD_TYPE, 'devlead/reset')
  return {
    kind: 'devlead/reset',
    version: DEVLEAD_RECORD_VERSION,
    at: decodeInstant(record.at, `${label} at`),
  }
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
