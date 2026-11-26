/**
 * Pure fold of the `devLead` Session projection: durable mode selection,
 * whole-value watched-session set, and the bounded notification digest.
 *
 * The fold never throws to the projection registry: recognized legacy records
 * are skipped with one process-wide warning, the first invalid current owned
 * record is retained in `failure`, the last valid state stays served, and the
 * Host service rejects reads while the failure is present.
 *
 * @module @yankeguo/dsh-devlead
 */

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { readRecord } from './record-api.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import {
  DEVLEAD_ANSWER_RETENTION,
  DEVLEAD_ASSISTANT_EXCERPT_MAX,
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_IDEMPOTENCY_KEY_MAX,
  DEVLEAD_MAX_INSTANT,
  DEVLEAD_MODE_PROJECTION_KEY,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_OPEN_QUESTION_PIN_MAX,
  DEVLEAD_PROJECTION_KEY,
  DEVLEAD_QUESTIONS_MAX,
  DEVLEAD_QUESTION_FIELD_MAX,
  DEVLEAD_QUESTION_OPTIONS_MAX,
  DEVLEAD_REPAIR_RECORD_TYPE,
  DEVLEAD_REPORT_ANSWER_RECORD_TYPE,
  DEVLEAD_REPORT_KINDS,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_REPORT_RETENTION,
  DEVLEAD_REPORT_SUMMARY_MAX,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_TRANSITIONS,
  DEVLEAD_WATCH_PROJECTION_KEY,
  DEVLEAD_WATCH_RECORD_TYPE,
  devLeadReportId,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadModeProjection,
  DevLeadNotification,
  DevLeadProjection,
  DevLeadProjectionReport,
  DevLeadProjectionState,
  DevLeadQuestion,
  DevLeadQuestionAnswerView,
  DevLeadQuestionOption,
  DevLeadQuestionStatus,
  DevLeadReport,
  DevLeadReportAnswer,
  DevLeadReportKind,
  DevLeadTransition,
  DevLeadWatchProjection,
} from '@yankeguo/dsh-devlead-protocol'
import {
  decodeModeRecord,
  decodeNotificationRecord,
  decodeRepairRecord,
  decodeReportAnswerRecord,
  decodeReportRecord,
  decodeResetRecord,
  decodeWatchRecord,
  legacyDevLeadRecordReason,
} from './domain.ts'

/** Structural subset of the Host logger used for legacy-record warnings. */
export interface DevLeadFoldLogger {
  warn(message: string): void
}

let legacyRecordLogger: DevLeadFoldLogger | undefined
let legacyRecordWarningEmitted = false

/** Connect the process-wide one-time legacy-record warning to the Host logger. */
export function initializeDevLeadFoldWarnings(hostLogger: DevLeadFoldLogger): void {
  legacyRecordLogger = hostLogger
}

/** Reset warning state between isolated unit tests. */
export function resetDevLeadFoldWarningsForTests(): void {
  legacyRecordLogger = undefined
  legacyRecordWarningEmitted = false
}

/** Skip one recognized legacy record without turning it into replay failure. */
function ignoreLegacyRecord(event: SessionEvent, type: string, reason: string): void {
  if (legacyRecordWarningEmitted) return
  legacyRecordWarningEmitted = true
  const message = `devlead: ignored a legacy record at session event ${String(event.seq)} (${type}): ${reason}; `
    + 'the old Session\'s DevLead state is no longer valid and has been discarded; '
    + 'further legacy records will be ignored without additional warnings'
  if (legacyRecordLogger === undefined) console.warn(message)
  else legacyRecordLogger.warn(message)
}

/**
 * Empty projection state: disabled, watching nothing, no notifications or
 * reports.
 * @param inheritedEventCount - exact fork-inherited prefix length to ignore.
 * @returns the empty state for one Session.
 */
export function emptyDevLeadProjectionState(inheritedEventCount = 0): DevLeadProjectionState {
  return {
    enabled: false,
    sessions: [],
    notifications: [],
    reports: [],
    answers: [],
    repairPending: [],
    failure: null,
    inheritedEventCount,
  }
}

/** One bounded, non-empty excerpt as persisted by the notification writer. */
const excerptSchema = zod.string().min(1).refine(
  value => value.length <= DEVLEAD_ERROR_EXCERPT_MAX * 2
    && Array.from(value).length <= DEVLEAD_ERROR_EXCERPT_MAX,
  { message: `excerpt must be at most ${DEVLEAD_ERROR_EXCERPT_MAX} code points` },
)

/** Latest-assistant summaries have a larger budget than errors and titles. */
const assistantSummarySchema = zod.string().min(1).refine(
  value => value.length <= DEVLEAD_ASSISTANT_EXCERPT_MAX * 2
    && Array.from(value).length <= DEVLEAD_ASSISTANT_EXCERPT_MAX,
  { message: `assistant summary must be at most ${DEVLEAD_ASSISTANT_EXCERPT_MAX} code points` },
)

/** Wire schema validating one retained notification before it leaves the Host. */
const notificationSchema: ZodType<DevLeadNotification> = zod.object({
  id: zod.string().min(1),
  sessionId: zod.string().min(1),
  sessionTitle: excerptSchema.optional(),
  // Derived from the shared vocabulary: a protocol transition added and written
  // by the core can never become a record that this fold rejects.
  transition: zod.enum([...DEVLEAD_TRANSITIONS] as [DevLeadTransition, ...DevLeadTransition[]]),
  turn: zod.number().int().positive(),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
  error: excerptSchema.optional(),
  summary: assistantSummarySchema.optional(),
  summaryTruncated: zod.boolean().optional(),
  cancelledByLeadInterrupt: zod.boolean().optional(),
  wakeSuppressedByReportId: zod.string().min(1).optional(),
  wakeSuppressionReason: zod.enum(['merged-into-pending-wake', 'included-in-sent-wake']).optional(),
}).strict().refine(
  notification => notification.summaryTruncated === undefined || notification.summary !== undefined,
  { message: 'summaryTruncated requires summary' },
).refine(
  notification => notification.cancelledByLeadInterrupt !== true
    || notification.transition === 'interrupted' || notification.transition === 'aborted',
  { message: 'cancelledByLeadInterrupt is only valid for interrupted or aborted turns' },
).refine(
  notification => (notification.wakeSuppressedByReportId === undefined)
    === (notification.wakeSuppressionReason === undefined),
  { message: 'wakeSuppressedByReportId and wakeSuppressionReason must appear together' },
).refine(
  notification => notification.id === notificationId(
    notification.sessionId,
    notification.turn,
    notification.transition,
  ),
  { message: 'notification id must match sessionId, turn, and transition' },
) as ZodType<DevLeadNotification>

/** Bounded non-empty report text, checked in Unicode code points. */
const reportMessageSchema = zod.string().min(1).refine(
  value => Array.from(value).length <= DEVLEAD_REPORT_MESSAGE_MAX,
  { message: `report message must be at most ${DEVLEAD_REPORT_MESSAGE_MAX} code points` },
)

/** Bounded non-empty structured question/option text. */
const questionFieldSchema = zod.string().min(1).refine(
  value => value.length <= DEVLEAD_QUESTION_FIELD_MAX * 2
    && Array.from(value).length <= DEVLEAD_QUESTION_FIELD_MAX,
  { message: `question field must be at most ${DEVLEAD_QUESTION_FIELD_MAX} code points` },
)

/** Wire schema of one structured question option. */
const questionOptionSchema: ZodType<DevLeadQuestionOption> = zod.object({
  label: questionFieldSchema,
  description: questionFieldSchema.optional(),
}).strict() as ZodType<DevLeadQuestionOption>

/** Wire schema of one structured native question. */
const questionSchema: ZodType<DevLeadQuestion> = zod.object({
  id: questionFieldSchema.optional(),
  header: questionFieldSchema.optional(),
  question: questionFieldSchema,
  options: zod.array(questionOptionSchema).max(DEVLEAD_QUESTION_OPTIONS_MAX).optional(),
  multi_select: zod.boolean().optional(),
}).strict() as ZodType<DevLeadQuestion>

/** Shared field shape of one retained report (persisted state and client wire). */
const reportShape = {
  id: zod.string().min(1),
  kind: zod.enum([...DEVLEAD_REPORT_KINDS] as [DevLeadReportKind, ...DevLeadReportKind[]]),
  message: reportMessageSchema,
  summary: zod.string().min(1).refine(
    value => Array.from(value).length <= DEVLEAD_REPORT_SUMMARY_MAX,
    { message: `report summary must be at most ${DEVLEAD_REPORT_SUMMARY_MAX} code points` },
  ).optional(),
  questions: zod.array(questionSchema).max(DEVLEAD_QUESTIONS_MAX).optional(),
  senderSessionId: zod.string().min(1),
  senderSessionTitle: excerptSchema.optional(),
  senderWorkspaceId: zod.string().min(1).optional(),
  senderWorkspaceTitle: excerptSchema.optional(),
  leadSessionId: zod.string().min(1),
  turn: zod.number().int().nonnegative(),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
}

/** Wire schema validating one retained report before it leaves the Host. */
const reportSchema: ZodType<DevLeadReport> = zod.object(reportShape).strict().refine(
  report => report.questions === undefined || report.kind === 'question',
  { message: 'report questions are only valid when kind is "question"' },
).refine(
  report => report.id === devLeadReportId(report.senderSessionId, report.turn, report.kind, report.message),
  { message: 'report id must match senderSessionId, turn, kind, and message' },
) as ZodType<DevLeadReport>

/**
 * Client wire schema of one report row: the retained report plus the additive
 * fold-derived question/answer pair (Phase 1e). The pair appears only on
 * question reports; older bundles ignore it.
 */
const projectionReportSchema: ZodType<DevLeadProjectionReport> = zod.object({
  ...reportShape,
  questionStatus: zod.enum(['open', 'answered', 'expired', 'cancelled']).optional(),
  answerStatus: zod.enum(['admitted', 'claimed', 'presented', 'discarded', 'failed']).optional(),
  repairPending: zod.boolean().optional(),
}).strict().refine(
  report => report.questions === undefined || report.kind === 'question',
  { message: 'report questions are only valid when kind is "question"' },
).refine(
  report => report.id === devLeadReportId(report.senderSessionId, report.turn, report.kind, report.message),
  { message: 'report id must match senderSessionId, turn, kind, and message' },
).refine(
  report => (report.questionStatus === undefined && report.answerStatus === undefined && report.repairPending === undefined)
    || report.kind === 'question',
  { message: 'derived question/answer/repair status is only valid on question reports' },
).refine(
  report => report.answerStatus === undefined || report.questionStatus !== undefined,
  { message: 'answerStatus requires questionStatus' },
) as ZodType<DevLeadProjectionReport>

/**
 * Wire schema validating one retained answer lifecycle record. Exported so the
 * durable discard queue (outbox) validates restored rows with the exact schema
 * the fold applies.
 */
export const answerSchema: ZodType<DevLeadReportAnswer> = zod.object({
  reportId: zod.string().min(1),
  leadSessionId: zod.string().min(1),
  sessionId: zod.string().min(1),
  messageId: zod.string().min(1),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
  status: zod.enum(['admitted', 'claimed', 'presented', 'discarded', 'failed']),
  answerSeq: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  textHash: zod.string().regex(/^[0-9a-f]{64}$/u),
  answeredAt: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT).optional(),
  presentedAt: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT).optional(),
  idempotencyKey: zod.string().min(1).refine(
    value => Array.from(value).length <= DEVLEAD_IDEMPOTENCY_KEY_MAX,
    { message: `idempotency key must be at most ${DEVLEAD_IDEMPOTENCY_KEY_MAX} code points` },
  ).optional(),
  textExcerpt: excerptSchema.optional(),
  primitive: zod.enum(['followup', 'steer']).optional(),
  boundary: zod.enum(['next-turn', 'next-step']).optional(),
  wakeRequested: zod.boolean().optional(),
}).strict().refine(
  answer => answer.presentedAt === undefined || answer.status === 'presented',
  { message: 'answer presentedAt is only valid when status is "presented"' },
) as ZodType<DevLeadReportAnswer>

/**
 * Newest answer lifecycle record of one question report. The highest
 * per-question admission sequence wins (a delayed discard of an older answer
 * appended after a newer re-answer must not reopen the question), with later
 * log position breaking a same-sequence lifecycle tie. Legacy records without
 * a sequence are ignored rather than coerced to zero. The newest record is
 * authoritative for `questionStatus`; older records are audit.
 * @param answers - retained answer records, oldest first.
 * @param reportId - question report identity.
 * @returns the newest record, or undefined when the question has no answer.
 */
export function latestAnswerOf(
  answers: readonly DevLeadReportAnswer[],
  reportId: string,
): DevLeadReportAnswer | undefined {
  let newest: DevLeadReportAnswer | undefined
  let newestSeq = -1
  for (const answer of answers) {
    if (answer.reportId !== reportId || answer.answerSeq === undefined) continue
    if (answer.answerSeq >= newestSeq) {
      newest = answer
      newestSeq = answer.answerSeq
    }
  }
  return newest
}

/**
 * Derive the question lifecycle from the newest answer record. An answer in
 * `admitted`/`claimed`/`presented` marks the question answered; a
 * `discarded`/`failed` answer (or no answer) leaves it open. `expired` and
 * `cancelled` have no durable writer in 0.4.0 either: TTL expiry is a
 * runtime overlay (`questionTtlMs` in `index.ts`) and cancellation has no
 * durable writer, so the fold itself never derives them.
 * @param answers - retained answer records, oldest first.
 * @param reportId - question report identity.
 * @returns the derived question status.
 */
export function questionStatusOf(
  answers: readonly DevLeadReportAnswer[],
  reportId: string,
): DevLeadQuestionStatus {
  const latest = latestAnswerOf(answers, reportId)
  if (latest === undefined) return 'open'
  return latest.status === 'discarded' || latest.status === 'failed' ? 'open' : 'answered'
}

/**
 * Project the durable question/answer state of one question report. The
 * runtime overlays its in-memory inbox observation on top of this view.
 * @param state - current fold state.
 * @param reportId - question report identity.
 * @returns the derived view, or undefined when the report is not a retained question.
 */
export function questionAnswerViewOf(
  state: DevLeadProjectionState,
  reportId: string,
): DevLeadQuestionAnswerView | undefined {
  const report = state.reports.find(existing => existing.id === reportId)
  if (report === undefined || report.kind !== 'question') return undefined
  const latest = latestAnswerOf(state.answers, reportId)
  const questionStatus = questionStatusOf(state.answers, reportId)
  if (latest === undefined) return { questionStatus }
  // answeredAt survives a discard: the writer carries the first admission
  // instant forward on every record, so a reopen does not erase it.
  const answeredAt = latest.answeredAt ?? (latest.status === 'admitted' || latest.status === 'claimed'
    || latest.status === 'presented' ? latest.at : undefined)
  return {
    questionStatus,
    answerStatus: latest.status,
    answerMessageId: latest.messageId,
    ...(answeredAt === undefined ? {} : { answeredAt }),
    ...(latest.presentedAt === undefined ? {} : { presentedAt: latest.presentedAt }),
  }
}

/** Whether one retained report is an open question the retention must pin. */
function isOpenQuestion(report: DevLeadReport, answers: readonly DevLeadReportAnswer[]): boolean {
  return report.kind === 'question' && questionStatusOf(answers, report.id) === 'open'
}

/**
 * Trim the report digest to its retention while pinning open questions. An
 * unanswered question must stay addressable by `question_id`, so it is not
 * evicted with the ordinary digest; the pin itself is bounded, and beyond it
 * the oldest pinned question is evicted honestly (a later `question_id` then
 * reports not-found instead of addressing a silently dropped question).
 * @param reports - retained reports, oldest first.
 * @param answers - retained answer records driving the pin decision.
 * @returns the trimmed digest, or the same reference when nothing changed.
 */
function trimReports(
  reports: readonly DevLeadReport[],
  answers: readonly DevLeadReportAnswer[],
): readonly DevLeadReport[] {
  if (reports.length <= DEVLEAD_REPORT_RETENTION) return reports
  const next = [...reports]
  while (next.length > DEVLEAD_REPORT_RETENTION) {
    const evictable = next.findIndex(report => !isOpenQuestion(report, answers))
    if (evictable >= 0) {
      next.splice(evictable, 1)
      continue
    }
    // Every retained report is a pinned open question: allow the bounded pin
    // growth, then evict the oldest pin so the projection stays bounded.
    if (next.length <= DEVLEAD_REPORT_RETENTION + DEVLEAD_OPEN_QUESTION_PIN_MAX) break
    next.shift()
  }
  return next
}

/**
 * Append one answer lifecycle record to a bounded audit, deduplicating an
 * exact replayed fact so a replayed log converges. The newest record of a
 * retained question is pinned against eviction; beyond the retention the
 * oldest non-pinned record goes first.
 * @param answers - retained answer records, oldest first.
 * @param answer - observed lifecycle fact.
 * @param reports - retained reports whose newest answers must stay derivable.
 * @returns the next retained audit.
 */
function retainAnswer(
  answers: readonly DevLeadReportAnswer[],
  answer: DevLeadReportAnswer,
  reports: readonly DevLeadReport[],
): readonly DevLeadReportAnswer[] {
  const duplicate = answers.some(existing => existing.reportId === answer.reportId
    && existing.messageId === answer.messageId
    && existing.status === answer.status
    && existing.at === answer.at)
  if (duplicate) return answers
  let next = [...answers, answer]
  if (next.length <= DEVLEAD_ANSWER_RETENTION) return next
  const retainedQuestions = new Set(reports.map(report => report.id))
  const newestOf = new Map<string, DevLeadReportAnswer>()
  for (const entry of next) {
    // Pin the same record `latestAnswerOf` derives: the highest admission
    // sequence, with the later log position breaking a same-sequence tie.
    if (entry.answerSeq === undefined) continue
    const current = newestOf.get(entry.reportId)
    if (current === undefined || current.answerSeq === undefined || entry.answerSeq >= current.answerSeq) {
      newestOf.set(entry.reportId, entry)
    }
  }
  while (next.length > DEVLEAD_ANSWER_RETENTION) {
    const evictable = next.findIndex(entry => newestOf.get(entry.reportId) !== entry
      || !retainedQuestions.has(entry.reportId))
    if (evictable >= 0) next.splice(evictable, 1)
    else next.shift()
  }
  return next
}

/** Compare every notification fact except the additive wake-suppression pair. */
function sameNotificationPayload(left: DevLeadNotification, right: DevLeadNotification): boolean {
  return left.id === right.id
    && left.sessionId === right.sessionId
    && left.sessionTitle === right.sessionTitle
    && left.transition === right.transition
    && left.turn === right.turn
    && left.at === right.at
    && left.error === right.error
    && left.summary === right.summary
    && left.summaryTruncated === right.summaryTruncated
    && left.cancelledByLeadInterrupt === right.cancelledByLeadInterrupt
}

/**
 * Append one notification to a bounded digest, dropping an already-retained
 * identity so a replayed log converges on the same state.
 * @param notifications - retained notifications, oldest first.
 * @param notification - observed notification.
 * @returns the next retained digest.
 */
function retainNotification(
  notifications: readonly DevLeadNotification[],
  notification: DevLeadNotification,
): readonly DevLeadNotification[] {
  const index = notifications.findIndex(existing => existing.id === notification.id)
  if (index < 0) {
    const next = [...notifications, notification]
    return next.length <= DEVLEAD_DEFAULT_NOTIFICATION_RETENTION
      ? next
      : next.slice(next.length - DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
  }
  const existing = notifications[index]
  if (existing === undefined
    || existing.wakeSuppressedByReportId !== undefined
    || notification.wakeSuppressedByReportId === undefined
    || notification.wakeSuppressionReason === undefined
    || !sameNotificationPayload(existing, notification)) return notifications
  // A plain durable T1 row may later be folded through the Q1 path, which can
  // prove that its already-sent wake included this exact transition. Only that
  // additive pair may upgrade a duplicate identity; every other drift is still
  // ignored, and an existing suppression fact is never rewritten.
  const next = [...notifications]
  next[index] = {
    ...existing,
    wakeSuppressedByReportId: notification.wakeSuppressedByReportId,
    wakeSuppressionReason: notification.wakeSuppressionReason,
  }
  return next
}

/**
 * Append one report to a bounded digest, dropping an already-retained identity
 * and pinning open questions against eviction.
 * @param reports - retained reports, oldest first.
 * @param report - report to retain.
 * @param answers - retained answer records driving the open-question pin.
 * @returns the retained list, or the same reference when unchanged.
 */
function retainReport(
  reports: readonly DevLeadReport[],
  report: DevLeadReport,
  answers: readonly DevLeadReportAnswer[],
): readonly DevLeadReport[] {
  if (reports.some(existing => existing.id === report.id)) return reports
  return trimReports([...reports, report], answers)
}

/**
 * Whether two session-id lists carry the same ids in the same order.
 * @param left - first list.
 * @param right - second list.
 * @returns whether the lists are equal as values.
 */
function sameSessionIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Persisted projection state schema; seeds a fold and validates cached rows. */
export const devLeadProjectionStateSchema: ZodType<DevLeadProjectionState> = zod.object({
  enabled: zod.boolean(),
  sessions: zod.array(zod.string().min(1)).refine(
    sessions => new Set(sessions).size === sessions.length,
    { message: 'sessions must be unique' },
  ),
  notifications: zod.array(notificationSchema)
    .max(DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    .refine(
      notifications => new Set(notifications.map(notification => notification.id)).size === notifications.length,
      { message: 'notification ids must be unique' },
    ),
  reports: zod.array(reportSchema)
    .max(DEVLEAD_REPORT_RETENTION + DEVLEAD_OPEN_QUESTION_PIN_MAX)
    .refine(
      reports => new Set(reports.map(report => report.id)).size === reports.length,
      { message: 'report ids must be unique' },
    ),
  answers: zod.array(answerSchema)
    .max(DEVLEAD_ANSWER_RETENTION)
    .refine(
      answers => new Set(answers.map(answer => `${answer.reportId}\u0000${answer.messageId}\u0000${answer.status}\u0000${answer.at}`)).size === answers.length,
      { message: 'answer lifecycle facts must be unique' },
    ),
  repairPending: zod.array(zod.string().min(1)).refine(
    ids => new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1]! < id),
    { message: 'repairPending question ids must be sorted and unique' },
  ),
  failure: zod.string().min(1).nullable(),
  inheritedEventCount: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict() as ZodType<DevLeadProjectionState>

/** Client wire schema of the `devLead` projection value. */
export const devLeadProjectionSchema: ZodType<DevLeadProjection> = zod.object({
  enabled: zod.boolean(),
  sessions: zod.array(zod.string().min(1)),
  notifications: zod.array(notificationSchema)
    .max(DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    .refine(
      notifications => new Set(notifications.map(notification => notification.id)).size === notifications.length,
      { message: 'notification ids must be unique' },
    ),
  reports: zod.array(projectionReportSchema)
    .max(DEVLEAD_REPORT_RETENTION + DEVLEAD_OPEN_QUESTION_PIN_MAX)
    .refine(
      reports => new Set(reports.map(report => report.id)).size === reports.length,
      { message: 'report ids must be unique' },
    ),
}).strict() as ZodType<DevLeadProjection>

/**
 * Memoized wire views keyed by their exact immutable fold state. The registry
 * compares the previous and the current `wire.view` result with `Object.is`, so
 * a view must be reused across a state change that alters only host-only data
 * (the `failure` field); otherwise every such change would publish a new,
 * deep-equal client value and redraw the browser.
 */
const wireViews = new WeakMap<DevLeadProjectionState, { readonly view: DevLeadProjection; readonly repairKey: string }>()

/** Repair flags are folded state, so a repair record drives normal publication. */
function projectionRepairKey(state: DevLeadProjectionState): string {
  return state.repairPending.join('\u0000')
}

/**
 * Project one wire view from fold state. The result is memoized per state
 * object and reuses the retained state arrays, so the projection registry's
 * identity comparison suppresses unchanged pushes.
 *
 * Question report rows carry the additive fold-derived `questionStatus` /
 * `answerStatus` pair (Phase 1e) so the browser chip can show the question
 * lifecycle without a second fact source. The derivation reads the durable
 * audit only; when no question report is retained the state array is reused
 * unchanged.
 * @param state - current fold state.
 * @returns the client view value.
 */
export function devLeadProjectionView(state: DevLeadProjectionState): DevLeadProjection {
  const repairKey = projectionRepairKey(state)
  const cached = wireViews.get(state)
  if (cached?.repairKey === repairKey) return cached.view
  let reports: readonly DevLeadProjectionReport[] = state.reports
  if (state.reports.some(report => report.kind === 'question')) {
    reports = state.reports.map((report): DevLeadProjectionReport => {
      if (report.kind !== 'question') return report
      const latest = latestAnswerOf(state.answers, report.id)
      const repairPending = state.repairPending.includes(report.id)
      return {
        ...report,
        questionStatus: questionStatusOf(state.answers, report.id),
        ...(latest === undefined ? {} : { answerStatus: latest.status }),
        ...(repairPending ? { repairPending: true } : {}),
      }
    })
  }
  const view: DevLeadProjection = {
    enabled: state.enabled,
    sessions: state.sessions,
    notifications: state.notifications,
    reports,
  }
  wireViews.set(state, { view, repairKey })
  return view
}

/**
 * Fold one committed Session event.
 *
 * Unrelated events return the same state reference. An invalid owned record
 * freezes the fold at the last valid state and records the failure once; the
 * frozen state reuses the previous wire view because `failure` is host-only.
 *
 * A valid `plugin:devlead/reset` record is the one owned record applied BEFORE
 * the freeze check: it discards every earlier DevLead record of the Session and
 * restarts the fold from `init`. That is the human recovery path for a
 * hand-edited or migrated log, so it must be foldable even when an earlier
 * record already froze the state. A malformed reset cannot unfreeze anything
 * (it would otherwise let a corrupt marker discard a damaged but recoverable
 * state) and leaves a frozen state frozen.
 * @param state - the projection covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next projection state.
 */
export function applyDevLeadProjection(
  state: DevLeadProjectionState,
  event: SessionEvent,
): DevLeadProjectionState {
  // Fork-inherited events are the parent's history, not this Session's state.
  // A forked subagent must never inherit DevLead mode or its watch set.
  if (event.seq < state.inheritedEventCount) return state
  const record = readRecord(event)
  if (record === undefined) return state
  const legacyReason = legacyDevLeadRecordReason(record.type, record.data)
  if (legacyReason !== undefined) {
    ignoreLegacyRecord(event, record.type, legacyReason)
    return state
  }
  if (record.type === DEVLEAD_RESET_RECORD_TYPE) {
    try {
      decodeResetRecord(record.data)
      return emptyDevLeadProjectionState(state.inheritedEventCount)
    } catch (error: unknown) {
      if (state.failure !== null) return state
      return freezeProjection(state, event, record.type, error)
    }
  }
  if (state.failure !== null) return state
  try {
    switch (record.type) {
      case DEVLEAD_MODE_RECORD_TYPE: {
        const mode = decodeModeRecord(record.data)
        return mode.enabled === state.enabled ? state : { ...state, enabled: mode.enabled }
      }
      case DEVLEAD_WATCH_RECORD_TYPE: {
        const watch = decodeWatchRecord(record.data)
        // A whole-value record may repeat the current set (a retried write or a
        // replayed log); keeping the state reference avoids a needless publish.
        return sameSessionIds(state.sessions, watch.sessions) ? state : { ...state, sessions: watch.sessions }
      }
      case DEVLEAD_NOTIFICATION_RECORD_TYPE: {
        const notification = decodeNotificationRecord(record.data)
        const notifications = retainNotification(state.notifications, notification)
        return notifications === state.notifications ? state : { ...state, notifications }
      }
      case DEVLEAD_REPORT_RECORD_TYPE: {
        const report = decodeReportRecord(record.data)
        const reports = retainReport(state.reports, report, state.answers)
        return reports === state.reports ? state : { ...state, reports }
      }
      case DEVLEAD_REPORT_ANSWER_RECORD_TYPE: {
        const answer = decodeReportAnswerRecord(record.data)
        const answers = retainAnswer(state.answers, answer, state.reports)
        if (answers === state.answers) return state
        // An answer can unpin a previously pinned open question (it became
        // answered) or re-pin it (a discard reopened it), so the report digest
        // is re-trimmed against the new answer state.
        const reports = trimReports(state.reports, answers)
        return { ...state, answers, ...(reports === state.reports ? {} : { reports }) }
      }
      case DEVLEAD_REPAIR_RECORD_TYPE: {
        const repair = decodeRepairRecord(record.data)
        return sameSessionIds(state.repairPending, repair.questionIds)
          ? state
          : { ...state, repairPending: repair.questionIds }
      }
      default:
        return state
    }
  } catch (error: unknown) {
    return freezeProjection(state, event, record.type, error)
  }
}

/**
 * Freeze a projection state on its first invalid owned record, retaining the
 * replay position and message that make the failure actionable.
 * @param state - last valid projection state.
 * @param event - event that failed to decode.
 * @param type - owned record type that failed.
 * @param error - thrown decoder failure.
 * @returns the frozen state.
 */
function freezeProjection(
  state: DevLeadProjectionState,
  event: SessionEvent,
  type: string,
  error: unknown,
): DevLeadProjectionState {
  const message = error instanceof Error ? error.message : String(error)
  const failure = {
    ...state,
    failure: `devlead replay failed at session event ${event.seq} (${type}): ${message}`,
  }
  // Host-only failure change: reuse the previous wire view so the registry's
  // Object.is comparison does not publish an unchanged client value.
  wireViews.set(failure, {
    view: devLeadProjectionView(state),
    repairKey: projectionRepairKey(failure),
  })
  return failure
}

/** Registered projection unit serving `devLead` from the Session log. */
export const devLeadProjectionDefinition = {
  key: DEVLEAD_PROJECTION_KEY,
  stateSchema: devLeadProjectionStateSchema,
  // The unit owns no Session-metadata-derived state (the header is unused), but
  // it must remember the fork-inherited prefix length so inherited mode/watch
  // records never describe the forked Session.
  init: (_header?: SessionHeader, inheritedEventCount = 0) => emptyDevLeadProjectionState(inheritedEventCount),
  apply: applyDevLeadProjection,
  wire: {
    viewSchema: devLeadProjectionSchema,
    view: devLeadProjectionView,
    // The retained digest makes this value large, and only the open
    // conversation reads it: keep it out of every Session summary/list row.
    summary: false,
  },
  // 7: adds the runtime repair-pending set; pre-repair cache rows (stateVersion
  // <7) lack the required field and must be discarded and refolded.
  stateVersion: 7,
} satisfies ProjectionDefinition<'devLead', DevLeadProjectionState>

/**
 * Host-only fold state of the summary-sized `devLeadWatch` projection: the
 * lead's current watch set. It mirrors the digest unit's freeze semantics for
 * owned records, so a corrupt watch/mode log never paints watched rows from a
 * stale set.
 */
export interface DevLeadWatchProjectionState {
  /** Sessions this lead watches, in add order. */
  readonly sessions: readonly string[]
  /** First rejected persisted record, or null while the state is valid. */
  readonly failure: string | null
  /** Fork-inherited prefix length; inherited events never change the watch set. */
  readonly inheritedEventCount: number
}

/**
 * Empty watch-projection state: no watched Sessions, no failure.
 * @param inheritedEventCount - exact fork-inherited prefix length to ignore.
 * @returns the empty watch state for one Session.
 */
export function emptyDevLeadWatchProjectionState(inheritedEventCount = 0): DevLeadWatchProjectionState {
  return { sessions: [], failure: null, inheritedEventCount }
}

/** Persisted watch-projection state schema; seeds a fold and validates cached rows. */
export const devLeadWatchProjectionStateSchema: ZodType<DevLeadWatchProjectionState> = zod.object({
  sessions: zod.array(zod.string().min(1)).refine(
    sessions => new Set(sessions).size === sessions.length,
    { message: 'watch sessions must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
  inheritedEventCount: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict() as ZodType<DevLeadWatchProjectionState>

/** Client wire schema of the `devLeadWatch` projection value. */
export const devLeadWatchProjectionSchema: ZodType<DevLeadWatchProjection> = zod.object({
  sessions: zod.array(zod.string().min(1)).refine(
    sessions => new Set(sessions).size === sessions.length,
    { message: 'watch sessions must be unique' },
  ),
}).strict() as ZodType<DevLeadWatchProjection>

/**
 * Project one client view from watch fold state. Returning the state's own
 * immutable array keeps the registry's Object.is suppression effective for
 * records that do not change the watch set.
 * @param state - current watch fold state.
 * @returns the watch-set wire view.
 */
export function devLeadWatchProjectionView(state: DevLeadWatchProjectionState): DevLeadWatchProjection {
  return { sessions: state.sessions }
}

/**
 * Fold one committed Session event into the summary-sized watch projection.
 *
 * The fold follows the digest/mode units' freeze policy: a legal reset restarts
 * it, and every owned record is decoded strictly so a corrupt log freezes the
 * last valid watch set. Mode/notification/report records do not change this
 * unit's value, but decoding them keeps the units' failure boundaries aligned.
 * @param state - the projection covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next watch projection state.
 */
export function applyDevLeadWatchProjection(
  state: DevLeadWatchProjectionState,
  event: SessionEvent,
): DevLeadWatchProjectionState {
  if (event.seq < state.inheritedEventCount) return state
  const record = readRecord(event)
  if (record === undefined) return state
  const legacyReason = legacyDevLeadRecordReason(record.type, record.data)
  if (legacyReason !== undefined) {
    ignoreLegacyRecord(event, record.type, legacyReason)
    return state
  }
  if (record.type === DEVLEAD_RESET_RECORD_TYPE) {
    try {
      decodeResetRecord(record.data)
      return emptyDevLeadWatchProjectionState(state.inheritedEventCount)
    } catch (error: unknown) {
      if (state.failure !== null) return state
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...state,
        failure: `devlead watch replay failed at session event ${event.seq} (${record.type}): ${message}`,
      }
    }
  }
  if (state.failure !== null) return state
  try {
    switch (record.type) {
      case DEVLEAD_WATCH_RECORD_TYPE: {
        const watch = decodeWatchRecord(record.data)
        return sameSessionIds(state.sessions, watch.sessions)
          ? state
          : { sessions: watch.sessions, failure: null, inheritedEventCount: state.inheritedEventCount }
      }
      case DEVLEAD_MODE_RECORD_TYPE:
        decodeModeRecord(record.data)
        return state
      case DEVLEAD_NOTIFICATION_RECORD_TYPE:
        decodeNotificationRecord(record.data)
        return state
      case DEVLEAD_REPORT_RECORD_TYPE:
        decodeReportRecord(record.data)
        return state
      case DEVLEAD_REPORT_ANSWER_RECORD_TYPE:
        decodeReportAnswerRecord(record.data)
        return state
      case DEVLEAD_REPAIR_RECORD_TYPE:
        decodeRepairRecord(record.data)
        return state
      default:
        return state
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...state,
      failure: `devlead watch replay failed at session event ${event.seq} (${record.type}): ${message}`,
    }
  }
}

/** Registered projection unit serving the summary-sized `devLeadWatch` value. */
export const devLeadWatchProjectionDefinition = {
  key: DEVLEAD_WATCH_PROJECTION_KEY,
  stateSchema: devLeadWatchProjectionStateSchema,
  init: (_header?: SessionHeader, inheritedEventCount = 0) => emptyDevLeadWatchProjectionState(inheritedEventCount),
  apply: applyDevLeadWatchProjection,
  wire: {
    viewSchema: devLeadWatchProjectionSchema,
    view: devLeadWatchProjectionView,
  },
  // 3: legacy record versions and pre-sequence answers no longer freeze replay;
  // version 2 added the fork-inherited prefix length.
  stateVersion: 3,
} satisfies ProjectionDefinition<'devLeadWatch', DevLeadWatchProjectionState>

/**
 * Host-only fold state of the summary-sized `devLeadMode` projection. The
 * selection is the only client fact; `failure` mirrors the digest unit's
 * freezing rule, so both units freeze on the same corrupt log (the service
 * rejects reads while the failure is present; the frozen view keeps the last
 * valid selection, exactly like the digest unit).
 */
export interface DevLeadModeProjectionState {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
  /** First rejected persisted record, or null while the state is valid. */
  readonly failure: string | null
  /** Fork-inherited prefix length; inherited mode records never select this Session. */
  readonly inheritedEventCount: number
}

/**
 * Empty mode-projection state: disabled, no failure.
 * @param inheritedEventCount - exact fork-inherited prefix length to ignore.
 * @returns the empty mode state for one Session.
 */
export function emptyDevLeadModeProjectionState(inheritedEventCount = 0): DevLeadModeProjectionState {
  return { enabled: false, failure: null, inheritedEventCount }
}

/** Persisted mode-projection state schema; seeds a fold and validates cached rows. */
export const devLeadModeProjectionStateSchema: ZodType<DevLeadModeProjectionState> = zod.object({
  enabled: zod.boolean(),
  failure: zod.string().min(1).nullable(),
  inheritedEventCount: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict() as ZodType<DevLeadModeProjectionState>

/** Client wire schema of the `devLeadMode` projection value. */
export const devLeadModeProjectionSchema: ZodType<DevLeadModeProjection> = zod.object({
  enabled: zod.boolean(),
}).strict() as ZodType<DevLeadModeProjection>

/**
 * The two client views are shared constants: the registry suppresses a push
 * when the previous and current `wire.view` results are `Object.is`-equal, so a
 * mode-only unit must never mint a fresh object for an unchanged selection.
 */
const MODE_ENABLED_VIEW: DevLeadModeProjection = { enabled: true }
const MODE_DISABLED_VIEW: DevLeadModeProjection = { enabled: false }

/**
 * Project one client view from mode fold state.
 * @param state - current mode fold state.
 * @returns the shared enabled/disabled view.
 */
export function devLeadModeProjectionView(state: DevLeadModeProjectionState): DevLeadModeProjection {
  return state.enabled ? MODE_ENABLED_VIEW : MODE_DISABLED_VIEW
}

/**
 * Fold one committed Session event into the summary-sized mode projection.
 *
 * The fold follows the digest unit's failure policy: every owned record type is
 * decoded strictly (so the two units freeze on the same corrupt log), and the
 * first invalid one freezes the last valid selection. A valid reset record is
 * applied before that check and restarts the unit from its empty state, exactly
 * like the digest unit, so a recovered Session loses its damaged mark too.
 * @param state - the projection covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next mode projection state.
 */
export function applyDevLeadModeProjection(
  state: DevLeadModeProjectionState,
  event: SessionEvent,
): DevLeadModeProjectionState {
  if (event.seq < state.inheritedEventCount) return state
  const record = readRecord(event)
  if (record === undefined) return state
  const legacyReason = legacyDevLeadRecordReason(record.type, record.data)
  if (legacyReason !== undefined) {
    ignoreLegacyRecord(event, record.type, legacyReason)
    return state
  }
  if (record.type === DEVLEAD_RESET_RECORD_TYPE) {
    try {
      decodeResetRecord(record.data)
      return emptyDevLeadModeProjectionState(state.inheritedEventCount)
    } catch (error: unknown) {
      if (state.failure !== null) return state
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...state,
        failure: `devlead mode replay failed at session event ${event.seq} (${record.type}): ${message}`,
      }
    }
  }
  if (state.failure !== null) return state
  try {
    switch (record.type) {
      case DEVLEAD_MODE_RECORD_TYPE: {
        const mode = decodeModeRecord(record.data)
        return mode.enabled === state.enabled ? state : { enabled: mode.enabled, failure: null, inheritedEventCount: state.inheritedEventCount }
      }
      case DEVLEAD_WATCH_RECORD_TYPE:
        // Watch and notification records do not contribute to this projection;
        // they are decoded only to mirror the digest unit's freeze semantics.
        decodeWatchRecord(record.data)
        return state
      case DEVLEAD_NOTIFICATION_RECORD_TYPE:
        decodeNotificationRecord(record.data)
        return state
      case DEVLEAD_REPORT_RECORD_TYPE:
        decodeReportRecord(record.data)
        return state
      case DEVLEAD_REPORT_ANSWER_RECORD_TYPE:
        decodeReportAnswerRecord(record.data)
        return state
      case DEVLEAD_REPAIR_RECORD_TYPE:
        decodeRepairRecord(record.data)
        return state
      default:
        return state
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...state,
      failure: `devlead mode replay failed at session event ${event.seq} (${record.type}): ${message}`,
    }
  }
}

/**
 * Registered projection unit serving the summary-sized `devLeadMode` value.
 *
 * This unit exists because the digest unit is excluded from Session summaries
 * (the sidebar cannot carry up to 64 notifications per row), while the mode
 * selection itself is exactly the fact a Session-list row renders. The unit
 * declares no `wire.summary: false`, so every Session summary carries it.
 */
export const devLeadModeProjectionDefinition = {
  key: DEVLEAD_MODE_PROJECTION_KEY,
  stateSchema: devLeadModeProjectionStateSchema,
  init: (_header?: SessionHeader, inheritedEventCount = 0) => emptyDevLeadModeProjectionState(inheritedEventCount),
  apply: applyDevLeadModeProjection,
  wire: {
    viewSchema: devLeadModeProjectionSchema,
    view: devLeadModeProjectionView,
  },
  // 3: legacy record versions and pre-sequence answers no longer freeze replay;
  // version 2 added the fork-inherited prefix length.
  stateVersion: 3,
} satisfies ProjectionDefinition<'devLeadMode', DevLeadModeProjectionState>
