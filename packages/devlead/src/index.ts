/**
 * DevLead core service: the durable per-Session mode, Workspace and Session
 * orchestration, the watched-session notification hub, and the `devLead`
 * Session projection.
 *
 * The service is the only Host-side owner of DevLead state. Tool and command
 * plugins call it through `ctx.devLead`; the browser reads the projection.
 *
 * @module @yankeguo/dsh-devlead
 */

import { mkdir } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionActivity, Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  DEVLEAD_DEFAULT_MAX_WATCHED,
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_IDEMPOTENCY_KEY_MAX,
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_PROMPT_INTENTS,
  DEVLEAD_QUESTIONS_MAX,
  DEVLEAD_QUESTION_FIELD_MAX,
  DEVLEAD_QUESTION_OPTIONS_MAX,
  DEVLEAD_REPORT_MAX_PER_TURN,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_SUMMARY_MAX,
  excerptLine,
  isDevLeadReportKind,
} from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadAgentPresetCatalog,
  DevLeadArchivedSession,
  DevLeadArchiveSessionOptions,
  DevLeadCreatedSession,
  DevLeadCreateSessionRequest,
  DevLeadInterruptInboxPolicy,
  DevLeadIsolation,
  DevLeadIsolationMode,
  DevLeadModelCatalog,
  DevLeadModelSelection,
  DevLeadNotification,
  DevLeadProjection,
  DevLeadProjectionState,
  DevLeadPromptDelivery,
  DevLeadPromptedSession,
  DevLeadPromptIntent,
  DevLeadPromptSessionOptions,
  DevLeadQueuedInput,
  DevLeadQuestion,
  DevLeadQuestionAnswerView,
  DevLeadQuestionOption,
  DevLeadReport,
  DevLeadReportAnswer,
  DevLeadRetractedInput,
  DevLeadReportKind,
  DevLeadRemovedWorkspace,
  DevLeadSessionView,
  DevLeadUnarchivedSession,
  DevLeadUseWorkspaceRequest,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_REPORT_ANSWER_RECORD_TYPE,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  answerTextHash,
  createDevLeadBackgroundMessage,
  createDevLeadPromptMessage,
  devLeadReport,
  modeRecord,
  reportAnswerRecord,
  resetRecord,
  watchRecord,
} from './domain.ts'
import { DevLeadAnswerTracker, DevLeadChildAnswerObserver, admittedAtOf, discardedAnswerOf, recordOfEntry } from './answers.ts'
import type { AnswerMemoryEntry, DerivedAnswerDiscard } from './answers.ts'
import {
  planLeadToChild,
} from './message-policy.ts'
import type {
  AnswerRetryPolicy,
  DeliveryRejectionReason,
  PlannedDelivery,
  QuestionPolicyState,
  TargetState,
} from './message-policy.ts'
import {
  agentTeamsCapabilityOf,
  devLeadModelCatalogOf,
  modelCatalogCapabilityOf,
  modelSelectionLabel,
  modelValidatorOf,
  normalizeModelSelection,
} from './dispatch.ts'
import type { AgentTeamsCapability, NormalizedModelSelection } from './dispatch.ts'
import { DevLeadError, isDevLeadError, thrownMessage } from './error.ts'
import {
  isAnswerMessage,
  isOwnRetractable,
  keptInputsOf,
  locatedInputs,
  pendingAnswersOf,
  queuedInputsOf,
  restoreInputs,
} from './inbox.ts'
import { DevLeadReportOutbox } from './outbox.ts'
import type { DevLeadAnswerDiscardRow } from './outbox.ts'
import {
  applyDevLeadProjection,
  devLeadModeProjectionDefinition,
  devLeadProjectionDefinition,
  devLeadWatchProjectionDefinition,
  devLeadProjectionView,
  emptyDevLeadProjectionState,
  latestAnswerOf,
} from './fold.ts'
import {
  alreadyActiveMessage,
  lastEnabledAt,
  rankActiveSessions,
  type DevLeadActiveSession,
} from './active.ts'
import { worktreeCapabilityOf, worktreeCheckoutOf } from './isolation.ts'
import { DevLeadNotificationHub } from './notification.ts'
import type { DevLeadPersistedLead } from './notification.ts'
import { persistedSessionsOf } from './persistence.ts'
import type { PersistedSessionsProbe } from './persistence.ts'
import { agentPresetRosterCapabilityOf, devLeadAgentPresetsOf } from './presets.ts'
import {
  devLeadActivePrefilterOf,
  projectionCacheOf,
} from './projection-cache.ts'
import {
  collectSessionIds,
  devLeadSessionView,
  devLeadSessionViews,
  devLeadWorkspaceView,
  rankSessionIds,
  readSessionFacts,
  sessionRankFacts,
  resolveSessionReference,
  resolveWorkspaceReference,
  type DevLeadViewDeps,
} from './views.ts'

export type * from '@yankeguo/dsh-devlead-protocol'
export * from './domain.ts'
export { DevLeadError, isDevLeadError } from './error.ts'
export type { DevLeadErrorCode } from './error.ts'
export {
  applyDevLeadModeProjection,
  applyDevLeadProjection,
  applyDevLeadWatchProjection,
  devLeadModeProjectionDefinition,
  devLeadModeProjectionSchema,
  devLeadModeProjectionStateSchema,
  devLeadModeProjectionView,
  devLeadWatchProjectionDefinition,
  devLeadWatchProjectionSchema,
  devLeadWatchProjectionStateSchema,
  devLeadWatchProjectionView,
  devLeadProjectionDefinition,
  devLeadProjectionSchema,
  devLeadProjectionStateSchema,
  devLeadProjectionView,
  emptyDevLeadModeProjectionState,
  emptyDevLeadProjectionState,
  emptyDevLeadWatchProjectionState,
} from './fold.ts'
export type { DevLeadModeProjectionState, DevLeadWatchProjectionState } from './fold.ts'
export { renderDevLeadNotice } from './notification.ts'
export type { DevLeadNotificationConfig, DevLeadPersistedLead } from './notification.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    devLead: DevLeadService
  }
}

/** Deployment configuration of the DevLead core service. */
export interface Config {
  /** Coalescing window before one notification digest wakes the lead, in milliseconds. */
  notificationBatchMs?: number
  /** Maximum watched Sessions one lead may keep. */
  maxWatchedSessions?: number
  /** Maximum Session rows one listing may yield. */
  maxListedSessions?: number
  /**
   * Whether a cold lead Session that the hub still indexes is resumed to receive
   * its queued notifications. Defaults to `true`: DevLead's job is to wake the
   * lead when a watched Session settles a turn, including after a Host restart.
   * Set `false` to keep durable records in memory only and wait for a human to
   * open the lead Session.
   */
  wakeColdSession?: boolean
  /** Agent preset used by Sessions this lead creates when the request names none. */
  defaultAgentPreset?: string
}

/**
 * Largest delay Node's `setTimeout` accepts without clamping. A larger
 * notification window would silently fire after 1 ms with an
 * `TimeoutOverflowWarning`, so the loader schema rejects it.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Largest number of unclassified persisted Session logs cold rehydration reads
 * in full during one scan. Rows the projection cache positively identifies as
 * leads are not counted: those must be restored. The cap only bounds how much
 * of an arbitrarily large history a Host re-reads after a restart; the rest is
 * reported with one warning.
 */
const MAX_COLD_LEAD_LOG_READS = 64

/**
 * Largest number of unclassified persisted Session logs one global single-active
 * scan reads in full. Positively cached active rows are always read; this cap
 * only bounds an arbitrarily large history whose cache has no verdict yet. A
 * capped scan warns and leaves admission conservative for every occupant it
 * did find.
 */
const MAX_ACTIVE_SCAN_UNKNOWN_READS = 64

/**
 * Minimum interval between opportunistic outbox retention sweeps triggered by
 * report writes. The explicit replay sweeps still prune on every pass; this
 * throttle only keeps a report-heavy Host from scanning the table per report.
 */
const REPORT_OUTBOX_PRUNE_INTERVAL_MS = 60 * 60 * 1_000

/**
 * Bound on the boot-time corpus-readiness barrier. The real Session query
 * engine binds the optional `sessionPersistence` service through a scheduled
 * callback, so its persisted listing can lag the service's availability by a
 * few milliseconds; DevLead waits (in short polls) until every stored Session is
 * visible in the query corpus, and gives up best-effort after this bound so a
 * broken backend cannot hang plugin load.
 */
const REHYDRATION_READINESS_TIMEOUT_MS = 2_000

/** Poll interval of the boot-time corpus-readiness barrier. */
const REHYDRATION_READINESS_POLL_MS = 100

/** One persisted Session row as the optional Session query engine reports it. */
type PersistedSessionRecord = Awaited<ReturnType<SessionQueryEngine['listSessions']>>[number]

/** Outcome of one prompt admission: whether the Host resumed the target and whether a running turn was interrupted. */
interface PromptAdmission {
  /** Whether a cold Session had to be resumed to admit the prompt. */
  readonly resumed: boolean
  /** Whether the Host's stop providers were asked to interrupt a running turn. */
  readonly interrupted: boolean
  /** Inputs restored after the stop under a keep/clear-own policy; absent otherwise. */
  readonly retainedInputs?: number
  /** Admission receipt: the actual primitive/boundary/wake and message identity. */
  readonly delivery: DevLeadPromptDelivery
}

/** One remembered non-answer idempotency-key admission (Phase 1 memory window). */
interface IdempotencyWindowEntry {
  /** SHA-256 hex of the trimmed prompt text the key was first admitted with. */
  readonly textHash: string
  /** The original admission receipt a same-key same-text retry returns. */
  readonly delivery: DevLeadPromptDelivery
}

/** Maximum remembered idempotency keys per Host process; FIFO eviction bounds it. */
const MAX_IDEMPOTENCY_WINDOW = 512

/** Maximum queued answer discards per cold lead; the newest are kept. */
const MAX_PENDING_ANSWER_DISCARDS = 128

/** Delay between automatic retries of a queued answer discard that could not drain. */
const ANSWER_DISCARD_RETRY_MS = 5_000

/**
 * Upper bound on how long answer admission waits for the repair barrier before
 * giving up with a retryable error. A repair whose survival proof or flush never
 * resolves must not hang the prompt forever; the caller retries later.
 */
const REPAIR_BARRIER_TIMEOUT_MS = 30_000

/** Maximum per-child answer-log observers retained; FIFO eviction bounds them. */
const MAX_CHILD_ANSWER_OBSERVERS = 512

/**
 * Proven survival of one answer whose queued or durable discard is stale: the
 * message is still pending in the child inbox, claimed by an unsettled
 * pre-step, or really presented. `at` is the proving fact's instant.
 */
interface AnswerSurvivalProof {
  /** The proven live state of the answer. */
  readonly status: 'admitted' | 'claimed' | 'presented'
  /** Instant of the proving fact (claim/presentation instant, or now for pending). */
  readonly at: number
}

/**
 * Outcome of a survival probe: a proven live state, `unknown` when the child's
 * reality cannot be read (cold child, no attached log, no/failing query engine),
 * or `undefined` when the child IS observable and shows no survival (a genuine
 * discard / settled answer). `unknown` must never be treated as a final open.
 */
type SurvivalOutcome = AnswerSurvivalProof | { readonly status: 'unknown' } | undefined

/**
 * One discard derivation waiting for its lead's log to become live: the child
 * proved the discard while the lead was cold and no Session query engine could
 * read the cold log, so the durable answer record is read at lead activation.
 */
interface DeferredAnswerDiscard {
  /** Child Session whose inbox dropped the answer. */
  readonly targetId: string
  /** Discarded answer message identity. */
  readonly messageId: string
  /** Question report identity read from the message source. */
  readonly questionId: string
  /** Instant the discard was observed. */
  readonly at: number
}

/**
 * Admission failure after the interrupt stop was already requested. The stop
 * cannot be rolled back, so the watch this prompt added must survive: it is the
 * lead's only path to observe the cancelled turn and retry the replacement
 * prompt. Rolling it back would strand a stopped Session unwatched.
 */
class DevLeadInterruptedAdmissionError extends DevLeadError {
  /**
   * @param message - failure text naming both the admission failure and the
   *   already-committed stop.
   */
  constructor(message: string) {
    super(message, 'DEVLEAD_SESSION_UNAVAILABLE')
    this.name = 'DevLeadInterruptedAdmissionError'
  }
}

/** Loader schema for the DevLead core service. */
export const Config: z<Config> = z.object({
  notificationBatchMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(400),
  maxWatchedSessions: z.number().step(1).min(1).default(DEVLEAD_DEFAULT_MAX_WATCHED),
  maxListedSessions: z.number().step(1).min(1).default(200),
  wakeColdSession: z.boolean().default(true),
  defaultAgentPreset: z.string().default(''),
})

/** Fully materialized deployment configuration, with Loader defaults applied. */
export interface DevLeadSettings {
  /** Coalescing window before one notification digest wakes the lead, in milliseconds. */
  readonly notificationBatchMs: number
  /** Maximum watched Sessions one lead may keep. */
  readonly maxWatchedSessions: number
  /** Maximum Session rows one listing may yield; a caller `limit` is capped by it. */
  readonly maxListedSessions: number
  /**
   * Whether an indexed-but-cold lead is resumed to receive its queued
   * notifications (`true` by default).
   */
  readonly wakeColdSession: boolean
  /** Agent preset used by created Sessions when the request names none. */
  readonly defaultAgentPreset: string | undefined
}

/**
 * Validate one materialized configuration, so a direct construction outside
 * Loader normalization fails the same way.
 * @param config - raw configuration.
 * @returns resolved configuration.
 */
function resolveConfig(config: Config): DevLeadSettings {
  const notificationBatchMs = config.notificationBatchMs ?? 400
  if (!Number.isSafeInteger(notificationBatchMs)
    || notificationBatchMs < 0
    || notificationBatchMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`notificationBatchMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`)
  }
  const maxWatchedSessions = config.maxWatchedSessions ?? DEVLEAD_DEFAULT_MAX_WATCHED
  if (!Number.isSafeInteger(maxWatchedSessions) || maxWatchedSessions < 1) {
    throw new TypeError('maxWatchedSessions must be a positive safe integer')
  }
  const maxListedSessions = config.maxListedSessions ?? 200
  if (!Number.isSafeInteger(maxListedSessions) || maxListedSessions < 1) {
    throw new TypeError('maxListedSessions must be a positive safe integer')
  }
  const wakeColdSession = config.wakeColdSession ?? true
  if (typeof wakeColdSession !== 'boolean') throw new TypeError('wakeColdSession must be a boolean')
  const defaultAgentPreset = config.defaultAgentPreset ?? ''
  if (typeof defaultAgentPreset !== 'string') throw new TypeError('defaultAgentPreset must be a string')
  return {
    notificationBatchMs,
    maxWatchedSessions,
    maxListedSessions,
    wakeColdSession,
    defaultAgentPreset: defaultAgentPreset.trim().length === 0 ? undefined : defaultAgentPreset.trim(),
  }
}

/**
 * Extract the stable `code` of a DSH Remote error without depending on the
 * typert protocol package, so a deployment that moves it still maps failures.
 * @param error - thrown value.
 * @returns the code, or undefined when the value carries none.
 */
function remoteCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Validate one listing limit and cap it at the deployment maximum.
 * @param limit - caller-supplied row limit, when given.
 * @param maximum - configured maximum Session rows one listing may yield.
 * @returns the effective positive row limit.
 */
function listLimit(limit: number | undefined, maximum: number): number {
  if (limit === undefined) return maximum
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new DevLeadError('limit must be a positive safe integer', 'DEVLEAD_INVALID_INPUT')
  }
  return Math.min(limit, maximum)
}

/**
 * Classify one Workspace registration failure into the stable error vocabulary.
 * The Workspace registry canonicalizes the path through `fs.realpath`, rejects
 * relative paths, and requires an existing directory, so its own rejections are
 * the authoritative signal:
 * - a missing directory becomes `DEVLEAD_DIRECTORY_MISSING`, so a caller knows
 *   creation was possible but not attempted;
 * - every other unusable path (relative spelling, file instead of directory,
 *   unusable parents, registry write failure) becomes `DEVLEAD_INVALID_INPUT`.
 * @param error - failure thrown by `workspaceRegistry.create` or `fs.mkdir`.
 * @param path - caller-supplied directory path.
 * @returns the mapped domain failure.
 */
function workspacePathFailure(error: unknown, path: string): DevLeadError {
  const errno = (error as NodeJS.ErrnoException | null)?.code
  if (errno === 'ENOENT') {
    return new DevLeadError(
      `directory "${path}" does not exist; create it first or let this call create it`,
      'DEVLEAD_DIRECTORY_MISSING',
    )
  }
  if (error instanceof TypeError && /fully qualified/u.test(thrownMessage(error))) {
    return new DevLeadError(
      `"${path}" is not a fully qualified path; pass an absolute directory path`,
      'DEVLEAD_INVALID_INPUT',
    )
  }
  return new DevLeadError(
    `could not register "${path}" as a Workspace: ${thrownMessage(error)}`,
    'DEVLEAD_INVALID_INPUT',
  )
}

/**
 * Largest number of active items one activity family reports in an archive
 * refusal. The message is model-facing and the families can carry unbounded
 * lists (jobs, schedules), so the text is bounded instead of echoing them.
 */
const MAX_REPORTED_ACTIVITY_ITEMS = 3

/**
 * Whether a thrown value is the Workspace registry's active-Session refusal.
 *
 * Checked by name and payload rather than `instanceof`: `@deepseek-ai/dsh-workspace`
 * is an optional peer, so this package must not import its runtime classes (a
 * Host without the registry would otherwise fail to load DevLead), and a
 * deployment that loads the package twice still maps the refusal.
 * @param error - thrown value.
 * @returns whether the value is a `WorkspaceActiveSessionError`.
 */
function isActiveSessionFailure(error: unknown): error is { activity: readonly SessionActivity[] } {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; activity?: unknown }
  return candidate.name === 'WorkspaceActiveSessionError' && Array.isArray(candidate.activity)
}

/**
 * Whether a thrown value is the Workspace registry's unknown-Session refusal,
 * detected structurally for the same optional-peer and duplicate-instance
 * reasons as {@link isActiveSessionFailure}.
 * @param error - thrown value.
 * @returns whether the value is a `WorkspaceUnknownSessionError`.
 */
function isUnknownSessionFailure(error: unknown): error is { sessionId: unknown } {
  if (typeof error !== 'object' || error === null) return false
  return (error as { name?: unknown }).name === 'WorkspaceUnknownSessionError'
}

/**
 * Render the activity families an archive refusal reported, with a bounded item
 * list, so the model can tell what must stop without receiving an unbounded
 * payload.
 * @param activity - activity families reported by the Host.
 * @returns compact text such as `turn; job (build, +2 more)`.
 */
function describeSessionActivity(activity: readonly SessionActivity[]): string {
  if (activity.length === 0) return 'unspecified activity'
  return activity.map((entry) => {
    const kind = String(entry.kind)
    const items = entry.items ?? []
    if (items.length === 0) return kind
    const labels = items.slice(0, MAX_REPORTED_ACTIVITY_ITEMS).map(item => item.label ?? item.id)
    const omitted = items.length - labels.length
    return `${kind} (${labels.join(', ')}${omitted > 0 ? `, +${String(omitted)} more` : ''})`
  }).join('; ')
}

/** Reject one malformed structured report-question field. */
function invalidQuestions(message: string): never {
  throw new DevLeadError(`report questions ${message}`, 'DEVLEAD_INVALID_INPUT')
}

/** Validate one bounded, non-empty structured question string. */
function questionText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalidQuestions(`${label} must be a non-empty string`)
  }
  if (value.length > DEVLEAD_QUESTION_FIELD_MAX * 2
    || Array.from(value).length > DEVLEAD_QUESTION_FIELD_MAX) {
    return invalidQuestions(`${label} must be at most ${DEVLEAD_QUESTION_FIELD_MAX} code points`)
  }
  return value
}

/** Narrow one structured question/option to a plain record. */
function questionRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidQuestions(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

/** Validate and detach the optional structured payload supplied by the native gate. */
function validatedQuestions(value: unknown, kind: DevLeadReportKind): DevLeadQuestion[] | undefined {
  if (value === undefined) return undefined
  if (kind !== 'question') invalidQuestions('are only valid when kind is "question"')
  if (!Array.isArray(value)) invalidQuestions('must be an array when present')
  if (value.length > DEVLEAD_QUESTIONS_MAX) {
    invalidQuestions(`must contain at most ${DEVLEAD_QUESTIONS_MAX} questions`)
  }
  return value.map((entry, index) => {
    const label = `[${String(index)}]`
    const question = questionRecord(entry, label)
    const allowed = new Set(['id', 'header', 'question', 'options', 'multi_select'])
    for (const key of Object.keys(question)) {
      if (!allowed.has(key)) invalidQuestions(`${label} carries unexpected field ${JSON.stringify(key)}`)
    }
    if (!('question' in question)) invalidQuestions(`${label} is missing field "question"`)
    const id = question.id === undefined ? undefined : questionText(question.id, `${label} id`)
    const header = question.header === undefined ? undefined : questionText(question.header, `${label} header`)
    if (question.multi_select !== undefined && typeof question.multi_select !== 'boolean') {
      invalidQuestions(`${label} multi_select must be a boolean when present`)
    }
    let options: DevLeadQuestionOption[] | undefined
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) invalidQuestions(`${label} options must be an array when present`)
      if (question.options.length > DEVLEAD_QUESTION_OPTIONS_MAX) {
        invalidQuestions(`${label} options must contain at most ${DEVLEAD_QUESTION_OPTIONS_MAX} options`)
      }
      options = question.options.map((entry, optionIndex) => {
        const optionLabel = `${label} options[${String(optionIndex)}]`
        const option = questionRecord(entry, optionLabel)
        const optionAllowed = new Set(['label', 'description'])
        for (const key of Object.keys(option)) {
          if (!optionAllowed.has(key)) {
            invalidQuestions(`${optionLabel} carries unexpected field ${JSON.stringify(key)}`)
          }
        }
        if (!('label' in option)) invalidQuestions(`${optionLabel} is missing field "label"`)
        const description = option.description === undefined
          ? undefined
          : questionText(option.description, `${optionLabel} description`)
        return {
          label: questionText(option.label, `${optionLabel} label`),
          ...(description === undefined ? {} : { description }),
        }
      })
    }
    return {
      ...(id === undefined ? {} : { id }),
      ...(header === undefined ? {} : { header }),
      question: questionText(question.question, `${label} question`),
      ...(options === undefined ? {} : { options }),
      ...(question.multi_select === undefined ? {} : { multi_select: question.multi_select }),
    }
  })
}

/** One mid-turn report request from a watched Session. */
export interface DevLeadReportRequest {
  /** Full plain-text update; trimmed, non-empty, at most 4000 code points. */
  readonly message: string
  /** Semantic kind, defaulting to `progress`. */
  readonly kind?: DevLeadReportKind
  /** Optional short title for digest rows; at most 200 code points. */
  readonly summary?: string
  /** Structured native questions; accepted only for kind `question`. */
  readonly questions?: readonly DevLeadQuestion[]
}

/** Receipt returned by one report call. */
export interface DevLeadReportReceipt {
  /** Durable/deliverable report payload. */
  readonly report: DevLeadReport
  /** Whether the report is safely recoverable across a Host restart. */
  readonly durable: boolean
  /** Whether the lead has not yet had the receipt written into its Session log. */
  readonly queued: boolean
  /** Human warning when `durable` is false or delivery used a degraded path. */
  readonly warning?: string
}

/**
 * DevLead service (`ctx.devLead`): durable mode selection, Workspace and
 * Session orchestration, and watched-session notifications for one Session
 * acting as the development lead.
 */
export class DevLeadService extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections']

  /** Loader schema, applied by the Loader before construction. */
  static Config = Config

  /** Validated deployment configuration. */
  private readonly resolved: DevLeadSettings

  /** Awaited registration of the `devLead` projection unit. */
  private projectionHandle!: ProjectionHandle<DevLeadProjectionState>

  /** Watched-session notification hub, started with the service. */
  private hub!: DevLeadNotificationHub

  /**
   * Watch slots reserved by in-flight `createSession` calls, per lead Session
   * id. The pre-create capacity check alone is not atomic: two concurrent calls
   * can both pass it, then the second watch write fails after its Session was
   * already created. The reservation is counted by every capacity check and
   * released in a `finally`.
   */
  private readonly watchReservations = new Map<string, number>()

  /**
   * Whether the authoritative readiness scan of the durable lead records has
   * completed. A Host that never composes the optional Session persistence
   * service can never list a persisted corpus, so it never becomes `rehydrated`
   * and simply keeps serving live Sessions.
   */
  private rehydrated = false

  /** In-flight rehydration attempt, so concurrent readiness triggers share it. */
  private rehydrating: Promise<void> | undefined

  /** Whether the plugin fiber was disposed; late rehydration steps must stop. */
  private disposed = false

  /** Resolver of the active readiness sleep, so disposal can wake it. */
  private readinessWake: (() => void) | undefined

  /** Timer of the active readiness sleep, so disposal can clear it. */
  private readinessTimer: ReturnType<typeof setTimeout> | undefined

  /** Serializes global-mode admission so two concurrent enables cannot both pass. */
  private admissionTail: Promise<void> = Promise.resolve()

  /**
   * Last known global DevLead occupant, used only as a recovery preference.
   * Every admission still re-derives occupancy from durable/live projections;
   * this hint merely keeps an incumbent from being displaced by a Session
   * resumed later.
   */
  private activeSessionId: string | undefined

  /** Cold enabled Sessions discovered by the boot rehydration scan. */
  private recoveredActive: DevLeadActiveSession[] = []

  /** Whether the service finished its first activation-phase reconciliation. */
  private initialized = false

  /**
   * Per-reporter report budget and idempotency window for the current turn.
   * Process-local by design; a restart resets the window, while the lead's
   * durable report digest remains the audit authority.
   */
  private readonly reportState = new Map<string, {
    readonly turn: number
    readonly leadSessionId: string
    readonly messages: Map<string, DevLeadReportReceipt>
  }>()

  /**
   * In-memory answer inbox lifecycle observation (Phase 1d). The durable
   * authority is the lead's `plugin:devlead/report-answer` audit; this tracker
   * advances admitted answers through claimed/presented/discarded as the child's
   * inbox and log events arrive, and reconciles rejected pre-steps at turn/end.
   */
  private readonly answers = new DevLeadAnswerTracker()

  /**
   * Per-target admission serialization. Two concurrent `promptSession` calls
   * for one target must not interleave their resolve/watch/interrupt/admission
   * stages and land in the child inbox out of call order, so each target owns a
   * promise chain keyed by its exact Session id.
   */
  private readonly promptTails = new Map<string, Promise<unknown>>()

  /**
   * Phase 1 memory window of non-answer idempotency keys (lead + target + key).
   * A same-key same-text retry returns the original receipt; a different text
   * under the same key is an explicit conflict. Answer idempotency is durable
   * (the answer record), not this window.
   */
  private readonly idempotencyWindow = new Map<string, IdempotencyWindowEntry>()

  /**
   * Targets whose inbox is being cleared by this service's own interrupt stop.
   * The Host stop emits `agent/inbox/discarded` for every cleared message, but a
   * `keep`/`clear-own` interrupt restores the kept answers afterwards, so the
   * discard listener must not reopen their questions during this window. A
   * `clear-all` interrupt records its answer discards explicitly from the
   * pre-stop snapshot instead.
   */
  private readonly interrupting = new Set<string>()

  /**
   * Answer discard records that could not be appended yet because the lead's
   * Session log was cold/detached (or a write/flush failed). They are drained
   * when the lead becomes live again, before the next prompt, and on a retry
   * timer, so a discard observed while the lead was cold still reaches the
   * durable audit and the question stays open across a restart. Every queued
   * row is mirrored into the outbox's durable `answer_discards` table (when the
   * Host composes storage), so the queue itself survives a Host restart while
   * the lead stays cold; without storage the child-log reconstruction re-derives
   * the discards on the next boot. Bounded per lead; the newest discards are
   * kept and an overflow is an explicit warning.
   */
  private readonly pendingAnswerDiscards = new Map<string, DevLeadReportAnswer[]>()

  /** In-flight discard drains per lead, so overlapping triggers share one pass. */
  private readonly answerDiscardDrains = new Map<string, Promise<void>>()

  /** Armed retry timer for queued discards that could not drain yet. */
  private answerDiscardRetryTimer: ReturnType<typeof setTimeout> | undefined

  /** Leads already warned that their discard queue is memory-only (no storage). */
  private readonly warnedMemoryOnlyDiscards = new Set<string>()

  /**
   * Last answer-discard persistence failure (append/flush/durable-queue write),
   * surfaced through {@link answerDiscardHealth} so a discard that may not
   * survive a crash is visible beyond the logger. Cleared by a successful drain.
   */
  private lastAnswerDiscardFailure: string | undefined

  /**
   * Durable-discard REPAIR failures (append/flush) keyed by lead+message, each
   * with its failure instant, tracked separately from the discard-queue failure
   * so a drop-only drain success — or a DIFFERENT message's repair success —
   * never clears a still-pending failure. A message's entry is cleared by that
   * message's own resolution (successful repair, genuine settle, or supersede).
   * Bounded; the newest failures are kept.
   */
  private readonly repairFailures = new Map<string, { readonly message: string; readonly at: number }>()

  /**
   * Per-lead barrier chaining every in-flight repair pass and repair fact, so
   * answer admission can await the repaired state before computing question
   * guards (a stale terminal discard must not let a duplicate answer through).
   */
  private readonly answerRepairBarriers = new Map<string, Promise<void>>()

  /**
   * Per-lead set of question report ids whose stale-discard repair is UNRESOLVED:
   * in flight, deferred, failed-retrying, or unknown (child state unreadable).
   * Marked when a repair pass scans a latest terminal (or a repair starts) and
   * cleared only when the repair resolves — succeeded, superseded by a newer
   * genuine terminal, or disproven by a settled child. The view reports
   * `repairPending` for these questions and admission refuses a stale open.
   */
  private readonly repairingQuestions = new Map<string, Set<string>>()

  /**
   * Discard derivations waiting for a cold lead to become live (no Session
   * query engine could read its cold log). Processed at lead activation.
   * Bounded per lead; the newest derivations are kept.
   */
  private readonly deferredAnswerDiscards = new Map<string, DeferredAnswerDiscard[]>()

  /**
   * Durable-discard repairs waiting for a cold lead (or unreadable child) to
   * become readable, or retried after an append/flush failure. The survival is
   * RE-PROVEN when processed, so only the stale fact is stored. Processed at
   * lead/child activation and on the retry timer. Bounded per lead.
   */
  private readonly deferredDiscardRepairs = new Map<string, Array<{ readonly stale: DevLeadReportAnswer }>>()

  /**
   * Per-child durable inbox observers reconstructing answer discards from the
   * child log (canceled splices and claimed-but-never-presented answers at
   * turn/end), independent of the live tracker. Initialized by replay when a
   * Session becomes live, then fed incrementally by `session/event`.
   */
  private readonly childAnswerObservers = new Map<string, DevLeadChildAnswerObserver>()

  /** Durable report outbox; undefined when the Host composes no storage-domain. */
  private outbox: DevLeadReportOutbox | undefined
  /** In-flight outbox opening. */
  private outboxOpening: Promise<void> | undefined
  /** Optional-service fiber that retries opening the outbox once storage mounts. */
  private outboxInjection: { dispose(): void } | undefined
  /** Guard against overlapping outbox replay passes. */
  private outboxReplaying = false
  /** Last outbox retention sweep (open or opportunistic report-write prune). */
  private outboxPrunedAt = 0
  /**
   * Archived holders whose mode-off could not be written. The durable
   * tombstones live in the outbox domain; this set is the in-process mirror
   * and also covers a Host without storage.
   */
  private ignoredArchived = new Set<string>()

  /**
   * Disposers of the armed readiness retry: the optional-service injection fiber
   * and, while the query engine itself is missing, the lifecycle listeners.
   */
  private rehydrationRetry: Array<() => unknown> | undefined

  /**
   * @param ctx - owning cordis context.
   * @param config - deployment configuration for notification and listing limits.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'devLead')
    this.resolved = resolveConfig(config)
  }

  protected async [Service.init](): Promise<void> {
    this.projectionHandle = await this.ctx.sessionProjections.register(devLeadProjectionDefinition)
    // Summary-sized companion of the digest unit: Session-list rows carry the
    // mode selection without the retained notifications. No handle is needed:
    // only the digest unit folds directly (`stateOf`) for the notification hub.
    await this.ctx.sessionProjections.register(devLeadModeProjectionDefinition)
    // Summary-sized watch set for the sidebar: row marks can resolve watched
    // Sessions from the lead's summary without the excluded digest.
    await this.ctx.sessionProjections.register(devLeadWatchProjectionDefinition)
    this.hub = new DevLeadNotificationHub(
      this.ctx,
      session => this.projectionHandle.stateOf(session),
      { batchMs: this.resolved.notificationBatchMs, wakeColdSession: this.resolved.wakeColdSession },
    )
    this.hub.start()
    // The readiness retry machinery outlives init; make sure a plugin unload
    // clears its timers/fibers even while a rehydration is still pending.
    this.ctx.effect(function* (this: DevLeadService) {
      yield () => {
        this.disposed = true
        this.wakeReadiness()
        this.disposeRehydrationRetry()
        if (this.answerDiscardRetryTimer !== undefined) {
          clearTimeout(this.answerDiscardRetryTimer)
          this.answerDiscardRetryTimer = undefined
        }
        this.outboxInjection?.dispose()
        this.outboxInjection = undefined
        // Awaited by cordis: the storage facility releases the domain name only
        // after a full close, so a reload must not race the next instance's open
        // into an `already-open` refusal that silently degrades durable reports.
        // A late storage mount can still have an open in flight: wait for it to
        // settle so the just-opened handle is closed here, not leaked.
        const opening = this.outboxOpening
        return (async () => {
          await opening?.catch(() => undefined)
          await this.outbox?.close()
        })()
      }
    }.bind(this), 'devlead: cold rehydration')
    // A resumed Session can carry an old enabled mode. Reconcile before the
    // service becomes ready, and again whenever a later boot-phase resume adds
    // a live index, so a historical duplicate never stays the visible winner.
    this.ctx.effect(function* (this: DevLeadService) {
      const dispose = this.ctx.on('agent/created', ({ agent }) => {
        if (this.disposed) return undefined
        const state = this.projectionHandle.stateOf(agent.session)
        if (state.failure !== null || !state.enabled) return undefined
        if (this.activeSessionId === undefined) {
          void this.reconcileActiveSessions(String(agent.id))
          void this.replayOutbox()
          return undefined
        }
        if (this.activeSessionId === String(agent.id)) {
          void this.replayOutbox()
          return undefined
        }
        void this.reconcileActiveSessions(this.activeSessionId)
        void this.replayOutbox()
        return undefined
      })
      yield dispose
    }.bind(this), 'devlead: single active')
    // Answer inbox lifecycle observation (Phase 1d). Admission writes the
    // durable `admitted` fact; these listeners advance the in-memory status
    // through claimed/presented and record discards (which reopen the question).
    // claimed/presented durable backfill is Phase 2; nothing here fabricates a
    // presentation that the child log does not carry.
    this.ctx.effect(function* (this: DevLeadService) {
      const disposables = [
        this.ctx.on('agent/inbox/claimed', ({ agent, message }): undefined => {
          if (this.disposed) return undefined
          this.answers.claimed(String(agent.id), String(message.id), Date.now())
          return undefined
        }),
        this.ctx.on('agent/inbox/discarded', ({ agent, message }): undefined => {
          if (this.disposed) return undefined
          // During this service's own interrupt stop the Host discards every
          // pending message, but keep/clear-own restores the kept answers; the
          // explicit clear-all snapshot handles those discards instead.
          if (this.interrupting.has(String(agent.id))) return undefined
          const entry = this.answers.discarded(String(agent.id), String(message.id), Date.now())
          if (entry !== undefined) {
            this.writeAnswerDiscard(entry, entry.at)
            return undefined
          }
          // No live tracker entry (restart, cold lead, or evicted observation):
          // the runtime-stamped source still identifies the question and lead,
          // so the durable answer record can supply the discard facts.
          const source = message.source as { kind?: unknown; questionId?: unknown; senderSessionId?: unknown } | undefined
          if (source?.kind === DEVLEAD_MESSAGE_KIND
            && typeof source.questionId === 'string' && source.questionId.length > 0
            && typeof source.senderSessionId === 'string' && source.senderSessionId.length > 0) {
            this.discardPendingAnswer(String(agent.id), String(message.id), source.questionId, source.senderSessionId)
          }
          return undefined
        }),
        this.ctx.on('session/event', (session, event): undefined => {
          if (this.disposed) return undefined
          this.observeAnswerEvent(session, event)
          return undefined
        }),
        this.ctx.on('agent/created', ({ agent }): undefined => {
          if (this.disposed) return undefined
          this.seedAnswersForAgent(agent)
          return undefined
        }),
        this.ctx.on('agent/disposed', ({ agent }): undefined => {
          // A disposed child's observer is stale; the next activation rebuilds
          // it by a full replay of the (possibly grown) log.
          this.childAnswerObservers.delete(String(agent.id))
          return undefined
        }),
      ]
      yield () => {
        for (const dispose of disposables) dispose()
      }
    }.bind(this), 'devlead: answer lifecycle')
    // Seed the answer tracker for Agents already live at load (the
    // `agent/created` listener only fires for later creations).
    for (const agent of this.ctx.agents.list()) this.seedAnswersForAgent(agent)
    await this.openOutbox()
    await this.restoreAnswerDiscards()
    if (this.outbox === undefined) {
      // The storage facility often mounts after the DevLead service in the
      // default composition. Retry once it becomes available, then replay any
      // rows that were already written by an earlier Host incarnation.
      this.outboxInjection = this.ctx.inject(['storageDomain' as never], () => {
        void this.openOutbox().then(async () => {
          await this.restoreAnswerDiscards()
          return this.replayOutbox()
        })
        return undefined
      })
    }
    await this.rehydrateFromPersistence()
    await this.reconcileActiveSessions(undefined, {
      includePersisted: false,
      knownActive: this.recoveredActive,
    })
    this.recoveredActive = []
    await this.replayOutbox()
    this.initialized = true
  }

  /**
   * Rebuild the notification hub's watch index from durable state.
   *
   * The authoritative persisted-corpus scan never runs inline with the service
   * that requested it: the real Session query engine binds the optional
   * `sessionPersistence` service through its own scheduled `ctx.inject`
   * callback, so `ctx.get('sessionPersistence')` can already be defined while
   * `query.listSessions()` still silently returns live-only rows. Every
   * readiness scan therefore waits one task boundary and a bounded
   * corpus-readiness barrier (see {@link awaitCorpusReady}) before `rehydrated`
   * becomes final, so `[Service.init]` cannot resolve before the hub's watch
   * index was rebuilt.
   */
  private async rehydrateFromPersistence(): Promise<void> {
    if (this.rehydrated) return
    const pending = this.rehydrating
    if (pending !== undefined) {
      await pending
      return
    }
    const run = this.runRehydration()
    this.rehydrating = run
    try {
      await run
    } finally {
      this.rehydrating = undefined
    }
  }

  /**
   * Run one rehydration attempt: the live-attach fallback immediately, a
   * boot-time corpus-readiness barrier, then one authoritative persisted scan.
   *
   * The barrier is the fix for the ready-vs-rehydration race: until the query
   * engine's own optional `sessionPersistence` binding is installed its listing
   * is live-only, so the scan must wait until every stored Session the
   * persistence service reports is visible in the query corpus. The wait is
   * bounded and only happens when the corpus is observably inconsistent; a
   * steady Host pays one macrotask plus one comparison.
   */
  private async runRehydration(): Promise<void> {
    if (this.rehydrated || this.disposed) return
    const queryReady = this.ctx.get('sessionQuery') !== undefined
    // The live-attach fallback needs no corpus service, so it always runs now.
    try {
      this.hub.rehydrate(this.liveAttachLeads())
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: cold lead rehydration failed: ${thrownMessage(error)}`)
    }
    if (!queryReady) {
      this.armRehydrationRetry(false)
      return
    }
    // Keep the optional-service retry armed until the authoritative scan
    // completes: a persistence binding that is installed or replaced while we
    // wait gets another attempt, and the shared in-flight guard keeps it
    // idempotent.
    this.armRehydrationRetry(true)
    // One task boundary so the query engine's own optional-service callback has
    // had the chance to bind `sessionPersistence`.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    if (this.rehydrated) return
    if (this.ctx.get('sessionQuery') === undefined) {
      this.armRehydrationRetry(false)
      return
    }
    if (this.ctx.get('sessionPersistence') === undefined) {
      // A Host that never composes persistence has no cold corpus to recover; a
      // Host that composes it later is picked up by the armed inject retry.
      this.armRehydrationRetry(true)
      return
    }
    await this.awaitCorpusReady()
    if (this.rehydrated || this.disposed) return
    try {
      const scan = await this.persistedLeadRecords(true)
      this.recoveredActive = [...scan.active]
      // A lead resumed while the scan was in flight already has an
      // authoritative live index (`agent/created` → `syncLead`); replaying the
      // older scan snapshot over it would revert a watch change and drop its
      // queued notifications. Only cold leads are rehydrated.
      this.hub.rehydrate(scan.leads.filter(record => this.ctx.agents.get(toSessionId(record.sessionId)) === undefined))
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: cold lead rehydration failed: ${thrownMessage(error)}`)
    }
    if (this.disposed) return
    this.finalizeRehydration()
  }

  /**
   * Boot-time readiness barrier: wait (bounded) until the Session query corpus
   * lists every Session the optional persistence service reports as stored.
   *
   * The persistence listing is the ground truth: a fresh Host reports no stored
   * Sessions and proceeds immediately, a steady Host reports the same Sessions
   * the corpus lists, and only a corpus whose optional binding is still warming
   * up is observably inconsistent. The barrier is best-effort — after the bound
   * it warns once and lets the scan proceed.
   */
  private async awaitCorpusReady(): Promise<void> {
    const deadline = Date.now() + REHYDRATION_READINESS_TIMEOUT_MS
    let probe = await this.probeCorpus(deadline)
    while (!this.disposed && probe?.verifiable === true && probe.ids === undefined && Date.now() < deadline) {
      await this.readinessSleep(REHYDRATION_READINESS_POLL_MS)
      probe = await this.probeCorpus(deadline)
    }
    if (this.disposed) return
    const ids = probe?.ids
    if (ids === undefined) {
      if (probe?.verifiable === true) {
        this.ctx.logger.warn(
          'devlead: the Session persistence listing did not settle within '
          + `${REHYDRATION_READINESS_TIMEOUT_MS}ms; cold lead rehydration proceeds best-effort`,
        )
      }
      return
    }
    if (ids.size === 0) return
    let consistent = false
    while (!this.disposed && Date.now() < deadline) {
      const listed = await this.listedPersistedSessionIds(deadline)
      if (this.containsAllSessionIds(listed, ids)) {
        consistent = true
        break
      }
      await this.readinessSleep(REHYDRATION_READINESS_POLL_MS)
    }
    if (this.disposed) return
    if (!consistent) {
      // One last check: the corpus may have become consistent during the final
      // poll's wait.
      consistent = this.containsAllSessionIds(await this.listedPersistedSessionIds(deadline), ids)
    }
    if (!consistent) {
      this.ctx.logger.warn(
        'devlead: the persisted Session corpus is still warming up; cold lead rehydration proceeds best-effort',
      )
    }
  }

  /**
   * Read the persistence ground truth under the readiness deadline. The real
   * backend honors the signal; the race is a belt-and-braces bound for a
   * backend that ignores it, so plugin load can never hang on the probe.
   * @param deadline - absolute readiness deadline.
   * @returns the probe result, or undefined when the deadline is already spent
   *   or the listing did not settle in time.
   */
  private async probeCorpus(deadline: number): Promise<PersistedSessionsProbe | undefined> {
    if (this.disposed) return undefined
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    try {
      const aborted = new Promise<undefined>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(undefined), { once: true })
      })
      return await Promise.race([persistedSessionsOf(this.ctx, controller.signal), aborted])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Resolve a short readiness sleep early when the plugin is disposed. */
  private async readinessSleep(milliseconds: number): Promise<void> {
    if (this.disposed) return
    await new Promise<void>((resolve) => {
      this.readinessWake = resolve
      this.readinessTimer = setTimeout(() => {
        this.readinessTimer = undefined
        this.readinessWake = undefined
        resolve()
      }, milliseconds)
    })
  }

  /** Wake the active readiness sleep (if any) after disposal. */
  private wakeReadiness(): void {
    if (this.readinessTimer !== undefined) {
      clearTimeout(this.readinessTimer)
      this.readinessTimer = undefined
    }
    const wake = this.readinessWake
    this.readinessWake = undefined
    wake?.()
  }

  /**
   * Whether one corpus listing contains every expected Session id.
   * @param listed - ids visible in the query corpus.
   * @param expected - ids the persistence service reports as stored.
   * @returns whether every expected id is listed.
   */
  private containsAllSessionIds(listed: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
    for (const id of expected) {
      if (!listed.has(id)) return false
    }
    return true
  }

  /**
   * Read the ids of the persisted Sessions visible in the Session query corpus.
   *
   * Before its optional persistence binding is installed the query engine merges
   * only live Sessions, so this is the number the readiness barrier compares
   * against the persistence service's complete stored listing.
   * @param deadline - absolute readiness deadline for the listing read.
   * @returns the visible persisted Session ids.
   */
  private async listedPersistedSessionIds(deadline: number): Promise<ReadonlySet<string>> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return new Set()
    const remaining = deadline - Date.now()
    if (remaining <= 0) return new Set()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    try {
      const aborted = new Promise<undefined>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(undefined), { once: true })
      })
      const records = await Promise.race([query.listSessions(controller.signal), aborted])
      if (records === undefined) return new Set()
      return new Set(
        records
          .filter(record => record.persisted)
          .map(record => String(record.header.id)),
      )
    } catch (error: unknown) {
      this.ctx.logger.debug(`devlead: corpus readiness listing failed: ${thrownMessage(error)}`)
      return new Set()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Mark rehydration final and disarm the optional-service retry. The
   * authoritative scan runs after the readiness barrier, so it needs no
   * confirmation re-scan.
   */
  private finalizeRehydration(): void {
    this.rehydrated = true
    this.disposeRehydrationRetry()
    // The corpus may have become ready after the first live-only scan; a
    // best-effort follow-up recovers cold duplicates without blocking load.
    if (this.initialized && !this.disposed) {
      void this.reconcileActiveSessions(this.activeSessionId, {
        includePersisted: false,
        knownActive: this.recoveredActive,
      })
    }
  }

  /** Dispose every armed readiness-retry hook. */
  private disposeRehydrationRetry(): void {
    const disposers = this.rehydrationRetry
    if (disposers === undefined) return
    this.rehydrationRetry = undefined
    for (const dispose of disposers.splice(0)) dispose()
  }

  /**
   * Arm the readiness retry for a Host that composed the DevLead service before
   * its Session query engine or persistence binding.
   *
   * The persistence service is awaited through a one-shot optional-service fiber
   * (`ctx.inject`): it fires as soon as the real profile installs the service,
   * which happens during Host boot, well before the Web server accepts the first
   * prompt. Lifecycle listeners are only armed while the query engine itself is
   * missing — a Host without persistence can never list a persisted corpus, so
   * scanning on every event would be pointless work.
   * @param queryReady - whether `sessionQuery` was composed when the scan ran.
   */
  private armRehydrationRetry(queryReady: boolean): void {
    if (this.rehydrated || this.rehydrationRetry !== undefined) return
    const disposers: Array<() => unknown> = []
    const retry = (): undefined => {
      if (this.rehydrated) {
        this.disposeRehydrationRetry()
        return undefined
      }
      if (this.ctx.get('sessionQuery') === undefined) return undefined
      if (this.ctx.get('sessionPersistence') === undefined) return undefined
      // Idempotent: a scan already in flight is shared, and a 250ms confirmation
      // timer bounds a scan that still races the binding.
      void this.rehydrateFromPersistence()
      return undefined
    }
    const injection = this.ctx.inject(['sessionPersistence'], retry)
    disposers.push(() => injection.dispose())
    if (!queryReady) {
      // The query engine may load after this service in an unusual composition
      // order; a lifecycle event is the deterministic signal to re-check.
      disposers.push(this.ctx.on('agent/created', retry))
      disposers.push(this.ctx.on('session/event', retry))
    }
    this.rehydrationRetry = disposers
    this.ctx.logger.debug(
      queryReady
        ? 'devlead: the Session persistence binding is not ready yet; cold lead rehydration is retried when it is composed'
        : 'devlead: the Session query engine is not composed yet; cold lead rehydration is retried on Session lifecycle events',
    )
  }

  /** Whether the durable report outbox is open and usable. */
  get reportOutboxAvailable(): boolean {
    return this.outbox?.available === true
  }

  /** Last durable-outbox failure, exposed for the E2E probe and diagnostics. */
  get reportOutboxLastError(): string | undefined {
    return this.outbox?.lastError
  }

  /** Deployment configuration after validation; read-only. */
  get settings(): Readonly<DevLeadSettings> {
    return this.resolved
  }

  /**
   * Whether this Host currently composes a usable experimental Git worktree
   * service, so a `worktree` isolation request can be attempted.
   *
   * The check is structural and evaluated at call time, so a Host that loads or
   * unloads the capability while DevLead is running reports its current state.
   * DevLead itself never depends on the experimental package: without it, the
   * getter is simply `false` and `createSession` reports an `unavailable`
   * isolation outcome.
   * @returns whether Git worktree isolation is available.
   */
  get worktreeIsolationAvailable(): boolean {
    return worktreeCapabilityOf(this.ctx) !== undefined
  }

  // ---------------------------------------------------------------------------
  // Mode
  // ---------------------------------------------------------------------------

  /**
   * Whether DevLead mode is selected for one exact live Agent. A subagent
   * Session never qualifies, even when a durable mode record was inherited or
   * hand-edited into its log.
   * @param agent - candidate lead Agent.
   * @returns whether the durable mode is enabled for that Agent's Session.
   */
  isEnabled(agent: Agent): boolean {
    // Subagent Sessions are runtime-owned children; an inherited or hand-edited
    // durable mode must never make one the Host's DevLead.
    if (agent.session.header.origin === 'subagent') return false
    if (this.ctx.agents.get(agent.id) !== agent) return false
    const state = this.projectionHandle.stateOf(agent.session)
    return state.failure === null && state.enabled
  }

  /**
   * Read the current DevLead view of one live Session.
   * @param agent - exact live lead Agent.
   * @returns the current projection value.
   * @throws {@link DevLeadError} when the Agent is not live or the replay failed.
   */
  view(agent: Agent): DevLeadProjection {
    this.assertLive(agent)
    return devLeadProjectionView(this.strictStateOf(agent.session))
  }

  /**
   * Save one Session's DevLead selection. Human-entry points own this call: the
   * `/devlead` command and the composer-toolbar toggle, never a model tool.
   * @param agent - exact live Session Agent receiving the selection.
   * @param enabled - selected mode.
   * @param signal - cancellation checked before the write.
   * @returns fulfillment after the committed selection's durability checkpoint
   *   was attempted (a host without a persistence participant keeps it in memory).
   * @throws {@link DevLeadError} when the Agent is not live or the replay failed.
   */
  async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void> {
    // Global admission is serialized: the occupancy scan and the mode append
    // must be one critical section, otherwise two Sessions enabling at the same
    // instant could both observe an empty Host. The durable scan inside makes
    // the check authoritative across restarts; the queue only closes the
    // in-process race.
    await this.withAdmission(async () => {
      this.assertLive(agent)
      // Subagent Sessions are runtime-owned children, not human-addressable
      // leads: even an inherited/hand-edited durable mode must never activate
      // one as the Host's DevLead.
      if (agent.session.header.origin === 'subagent') {
        throw new DevLeadError(
          'a subagent Session cannot hold DevLead mode; use a top-level Session',
          'DEVLEAD_INVALID_INPUT',
        )
      }
      signal?.throwIfAborted()
      const current = this.projectionHandle.stateOf(agent.session)
      if (current.failure !== null) {
        // The frozen fold cannot accept a normal mode record: reading it back would
        // keep serving the damaged state. Turning the mode off is the recovery
        // path (it discards the damaged watch set and digest via a reset record);
        // turning it on must point the human at the explicit reset first.
        if (enabled) {
          throw new DevLeadError(
            `DevLead state for Session "${agent.id}" is damaged (${current.failure}); `
            + 'run /devlead reset first to discard the damaged watch set and notification digest',
            'DEVLEAD_PROJECTION_INVALID',
          )
        }
        this.appendResetRecord(agent.session)
        await this.flushDurably(agent.session, `DevLead reset for Session "${agent.id}"`)
        await this.checkpointProjectionCache(agent.session, `DevLead reset for Session "${agent.id}"`)
        await this.discardLeadReportState(String(agent.id))
        if (this.activeSessionId === String(agent.id)) this.activeSessionId = undefined
        return
      }
      if (current.enabled === enabled) {
        if (enabled) this.activeSessionId = String(agent.id)
        return
      }
      if (enabled) {
        const blocker = await this.blockingOccupant(agent, signal)
        if (blocker !== undefined) {
          throw new DevLeadError(
            alreadyActiveMessage(blocker),
            'DEVLEAD_ALREADY_ACTIVE',
          )
        }
      }
      appendPluginRecord(agent.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(enabled, Date.now()))
      await this.flushDurably(agent.session, `DevLead mode for Session "${agent.id}"`)
      await this.checkpointProjectionCache(agent.session, `DevLead mode for Session "${agent.id}"`)
      if (enabled) this.activeSessionId = String(agent.id)
      else if (this.activeSessionId === String(agent.id)) this.activeSessionId = undefined
      if (enabled) void this.replayOutbox()
    })
  }

  /**
   * Discard one Session's durable DevLead state so a damaged fold can recover.
   *
   * Appending the reset marker restarts both projections from their empty state
   * (mode off, empty watch set, no retained digest). The human-entry points own
   * this call: `/devlead reset` and `/devlead off` on a frozen Session. It does
   * not require the mode to be on, and it is safe to call repeatedly.
   * @param agent - exact live Session Agent owning the state.
   * @param signal - cancellation checked before the write.
   * @returns fulfillment after the reset record's durability checkpoint was
   *   attempted.
   * @throws {@link DevLeadError} when the Agent is not live.
   */
  async reset(agent: Agent, signal?: AbortSignal): Promise<void> {
    await this.withAdmission(async () => {
      this.assertLive(agent)
      signal?.throwIfAborted()
      this.appendResetRecord(agent.session)
      await this.flushDurably(agent.session, `DevLead reset for Session "${agent.id}"`)
      await this.checkpointProjectionCache(agent.session, `DevLead reset for Session "${agent.id}"`)
      // Reset is the explicit "discard this lead's DevLead state" action, so
      // undelivered reports addressed to it must not survive to be replayed
      // into the fresh projection.
      await this.discardLeadReportState(String(agent.id))
      if (this.activeSessionId === String(agent.id)) this.activeSessionId = undefined
    })
  }

  /**
   * Append one reset marker to a Session log.
   * @param session - Session whose DevLead state is discarded.
   */
  private appendResetRecord(session: Session): void {
    appendPluginRecord(session, DEVLEAD_RESET_RECORD_TYPE, resetRecord(Date.now()))
  }

  /**
   * Discard the queue-side state of one lead's DevLead epoch after a reset
   * marker: undelivered outbox reports, queued answer discards (memory and
   * durable rows), deferred discard derivations, and the in-process
   * archived-holder tombstone mirror. Both `reset()` and the frozen-fold
   * `setEnabled(false)` recovery are resets semantically, so they must drop
   * the same rows.
   * @param sessionId - lead Session identity whose queued reports are discarded.
   */
  private async discardLeadReportState(sessionId: string): Promise<void> {
    await this.outbox?.dropForLead(sessionId)
    await this.outbox?.dropAnswerDiscardsForLead(sessionId)
    this.pendingAnswerDiscards.delete(sessionId)
    this.deferredAnswerDiscards.delete(sessionId)
    this.deferredDiscardRepairs.delete(sessionId)
    this.ignoredArchived.delete(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------

  /**
   * List every registered Workspace with its accounted Sessions.
   * @param signal - cancellation checked between rows.
   * @returns detached Workspace views in registry order.
   */
  async listWorkspaces(signal?: AbortSignal): Promise<DevLeadWorkspaceView[]> {
    signal?.throwIfAborted()
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return []
    const views: DevLeadWorkspaceView[] = []
    for (const workspace of registry.list()) {
      signal?.throwIfAborted()
      views.push(await devLeadWorkspaceView(workspace))
    }
    return views
  }

  /**
   * Register an existing directory as a Workspace for one live lead.
   *
   * The Workspace registry itself canonicalizes the path (`fs.realpath`, so
   * trailing slashes and symlinks normalize), rejects relative spellings, and
   * requires an existing directory; this method only adds the optional
   * missing-directory creation and the stable DevLead error vocabulary.
   * An already-registered canonical path reuses its Workspace and keeps the
   * registered title: `request.title` applies only when a new record is created.
   *
   * Directory creation is opt-in: `request.create` defaults to `false`, so a
   * missing directory reports `DEVLEAD_DIRECTORY_MISSING` and the caller must
   * explicitly retry with `create: true`. Creating a Host directory is a
   * high-impact side effect, so the model must have asked for it.
   * @param agent - exact live lead Agent making the registration.
   * @param request - directory path, optional title (new registrations only),
   *   and the missing-directory policy (default: never create).
   * @param signal - cancellation checked before and between the registry writes.
   * @returns the registered or existing Workspace view.
   * @throws {@link DevLeadError} `DEVLEAD_NOT_ENABLED`/`DEVLEAD_AGENT_NOT_LIVE`
   *   for a disallowed caller, `DEVLEAD_DIRECTORY_MISSING` when the directory is
   *   missing and creation is disabled, `DEVLEAD_INVALID_INPUT` for every other
   *   unusable path or registration failure.
   */
  async useWorkspace(
    agent: Agent,
    request: DevLeadUseWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<DevLeadWorkspaceView> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    const trimmed = request.path.trim()
    if (trimmed.length === 0) throw new DevLeadError('a directory path is required', 'DEVLEAD_INVALID_INPUT')
    const create = request.create ?? false
    const title = request.title?.trim()
    const resolvedTitle = title === undefined || title.length === 0 ? undefined : title
    const registry = this.requireWorkspaceRegistry()
    let workspace: Workspace
    try {
      workspace = await registry.create(trimmed, resolvedTitle)
    } catch (error: unknown) {
      const failure = workspacePathFailure(error, trimmed)
      if (failure.code !== 'DEVLEAD_DIRECTORY_MISSING') throw failure
      if (!create) {
        throw new DevLeadError(
          `directory "${trimmed}" does not exist; retry with create: true to create it, or create the directory first`,
          'DEVLEAD_DIRECTORY_MISSING',
        )
      }
      signal?.throwIfAborted()
      try {
        await mkdir(trimmed, { recursive: true })
      } catch (mkdirError: unknown) {
        throw workspacePathFailure(mkdirError, trimmed)
      }
      signal?.throwIfAborted()
      try {
        workspace = await registry.create(trimmed, resolvedTitle)
      } catch (retryError: unknown) {
        throw workspacePathFailure(retryError, trimmed)
      }
    }
    return await devLeadWorkspaceView(workspace)
  }

  /**
   * Close one Workspace by removing its DSH registration.
   *
   * This is the registry's own `remove` action, not a deletion: the directory,
   * its files, and every Session log stay untouched. The Workspace's Sessions
   * become ungrouped — still openable and continuable — and re-registering the
   * same directory creates a new registration that does not adopt them.
   *
   * The returned view is the pre-removal snapshot, so the caller can report
   * what it closed and which Sessions it accounted to.
   * @param agent - exact live lead Agent making the removal.
   * @param workspace - Workspace id, registered path, or exact display title.
   * @param signal - cancellation checked before the registry write.
   * @returns the pre-removal Workspace view and whether a registration was
   *   removed (`false` when another actor removed it first).
   * @throws {@link DevLeadError} `DEVLEAD_NOT_ENABLED`/`DEVLEAD_AGENT_NOT_LIVE`
   *   for a disallowed caller, `DEVLEAD_WORKSPACE_NOT_FOUND` when the Host
   *   composes no registry or nothing matches the reference.
   */
  async removeWorkspace(
    agent: Agent,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<DevLeadRemovedWorkspace> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    const registry = this.requireWorkspaceRegistry()
    const resolved = await resolveWorkspaceReference(this.ctx, workspace, signal)
    signal?.throwIfAborted()
    // The snapshot must be taken before the write: after `delete` the entity is
    // gone from the registry and its accounted Sessions are already ungrouped.
    const view = await devLeadWorkspaceView(resolved)
    signal?.throwIfAborted()
    const removed = await registry.delete(resolved.id)
    return { workspace: view, removed }
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * List Sessions this lead can address.
   *
   * Rows are ranked by cheap live facts (watched, running, then most recently
   * created) before the limit is applied, so a watched or running Session
   * always survives truncation; only retained rows pay for full view assembly.
   * @param agent - exact live lead Agent.
   * @param options - optional Workspace filter, watch-only filter, row limit
   *   (capped by `maxListedSessions`, except that a watched-only listing is
   *   never truncated below the watch set), and cancellation checked between
   *   reads and rows. The watched set is already bounded by
   *   `maxWatchedSessions`; the `/devlead` status view would otherwise report
   *   truncated watch rows as missing.
   * @returns detached Session views, watched and running rows first.
   * @throws {@link DevLeadError} when the Agent is not live, the Workspace does
   *   not resolve, the projection replay failed, or `limit` is not a positive
   *   safe integer.
   */
  async listSessions(
    agent: Agent,
    options: { workspace?: string; watchedOnly?: boolean; limit?: number; signal?: AbortSignal } = {},
  ): Promise<DevLeadSessionView[]> {
    this.assertLive(agent)
    const signal = options.signal
    const deps = this.viewDeps(agent, signal)
    signal?.throwIfAborted()
    let ids: string[]
    if (options.workspace !== undefined && options.workspace.trim().length > 0) {
      const workspace = await resolveWorkspaceReference(this.ctx, options.workspace, signal)
      ids = await collectSessionIds(deps, workspace)
    } else {
      ids = await collectSessionIds(deps, undefined)
    }
    signal?.throwIfAborted()
    if (options.watchedOnly === true) ids = ids.filter(id => deps.isWatched(id))
    const listingCap = options.watchedOnly === true
      ? Math.max(this.resolved.maxListedSessions, deps.watchedSessions.length)
      : this.resolved.maxListedSessions
    const requestedLimit = listLimit(options.limit, listingCap)
    // The status view relies on the watched-only listing describing the whole
    // watch set; an explicit smaller limit must not hide a watched row (the set
    // itself is bounded by maxWatchedSessions).
    const limit = options.watchedOnly === true
      ? Math.max(requestedLimit, deps.watchedSessions.length)
      : requestedLimit
    // Rank on cheap facts first (headers and live titles), then read the
    // retained rows' facts — including cold titles, which fold a complete log.
    const ranking = await sessionRankFacts(deps, ids)
    signal?.throwIfAborted()
    const retained = rankSessionIds(deps, ids, ranking, limit)
    const facts = await readSessionFacts(deps, retained)
    return await devLeadSessionViews(deps, retained, false, facts)
  }

  /**
   * Read the Host's model catalog for dispatch-time selection.
   *
   * The view reports the Host default selection, routable providers, each
   * provider's advertised models and reasoning efforts, and catalog lookup
   * failures. It is read-only: no Session, profile default, or Team state is
   * changed. The controller's catalog method takes no cancellation token, so
   * the signal is checked before and after the read.
   * @param agent - exact live lead Agent.
   * @param signal - cancellation checked before and after the catalog read.
   * @returns the normalized model catalog view.
   * @throws {@link DevLeadError} `DEVLEAD_SESSION_UNAVAILABLE` when the Host
   *   composes no Session controller with a model catalog or the read fails.
   */
  async listModels(agent: Agent, signal?: AbortSignal): Promise<DevLeadModelCatalog> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    const controller = modelCatalogCapabilityOf(this.ctx)
    if (controller === undefined) {
      throw new DevLeadError(
        'this Host cannot list models: no API Session controller with a model catalog is composed',
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    let catalog: unknown
    try {
      catalog = await controller.modelCatalog()
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new DevLeadError(
        `could not read the model catalog: ${thrownMessage(error)}`,
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    signal?.throwIfAborted()
    return devLeadModelCatalogOf(catalog)
  }

  /**
   * Read the Host's Agent preset roster for creation-time preset selection.
   *
   * The roster is optional: a Host that composes no Agent preset service
   * returns `available: false` with a reason instead of an empty list that
   * could be mistaken for "no presets defined". When the service is present,
   * rows are normalized onto the stable protocol view; a row without a usable
   * id is dropped, and the Host's effective default gets the `default` marker.
   * This is a read-only capability: no Session, profile default, or preset is
   * changed.
   * @param agent - exact live lead Agent.
   * @param signal - cancellation checked before and after the roster read.
   * @returns the roster view, or an explicit unavailable result.
   * @throws {@link DevLeadError} `DEVLEAD_SESSION_UNAVAILABLE` when a composed
   *   roster fails a read.
   */
  async listAgentPresets(agent: Agent, signal?: AbortSignal): Promise<DevLeadAgentPresetCatalog> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    const roster = agentPresetRosterCapabilityOf(this.ctx)
    if (roster === undefined) {
      return {
        available: false,
        presets: [],
        reason: 'this Host composes no Agent preset roster; omit preset to use the Host default',
      }
    }
    let rows: readonly unknown[]
    try {
      rows = await roster.list()
      if (!Array.isArray(rows)) {
        throw new Error('the roster service returned no array')
      }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new DevLeadError(
        `could not read the Agent preset roster: ${thrownMessage(error)}`,
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    signal?.throwIfAborted()
    return {
      available: true,
      presets: devLeadAgentPresetsOf(rows, roster.defaultId),
    }
  }

  /**
   * Read one Session in detail, including folded turn and assistant facts.
   * @param agent - exact live lead Agent.
   * @param sessionId - Session id or unique prefix; exact ids stay addressable
   *   beyond the bounded listing window.
   * @param signal - cancellation checked before and between the query reads.
   * @returns the detached Session view.
   * @throws {@link DevLeadError} when the reference is missing or ambiguous.
   */
  async getSession(agent: Agent, sessionId: string, signal?: AbortSignal): Promise<DevLeadSessionView> {
    this.assertLive(agent)
    const deps = this.viewDeps(agent, signal)
    const resolved = await resolveSessionReference(deps, sessionId)
    signal?.throwIfAborted()
    return await devLeadSessionView(deps, String(resolved.sessionId), true)
  }

  /**
   * Read the pending inbox inputs of one Session for the detail tool.
   *
   * The inbox is driver-owned: only a live Agent has one, so a cold Session
   * reports undefined (the caller omits the field) rather than an empty list
   * that would claim "nothing queued" about a log the Host has not folded.
   * @param agent - exact live lead Agent.
   * @param sessionId - exact Session identity (already resolved by the caller).
   * @param signal - cancellation checked before the read.
   * @returns queued inputs in queue order, or undefined when the target is not live.
   * @throws {@link DevLeadError} when the caller is not live.
   */
  sessionQueuedInputs(agent: Agent, sessionId: string, signal?: AbortSignal): DevLeadQueuedInput[] | undefined {
    this.assertLive(agent)
    signal?.throwIfAborted()
    const target = this.ctx.agents.get(toSessionId(sessionId))
    if (target === undefined) return undefined
    return queuedInputsOf(target, (messageId) => {
      const entry = this.answers.entryOfMessage(sessionId, messageId)
      if (entry === undefined) return undefined
      return entry.status === 'claimed' ? 'claimed' : entry.status === 'admitted' ? 'admitted' : undefined
    })
  }

  /**
   * Withdraw one queued inbox input this lead Session authored.
   *
   * The lead's own instruction/correction relay prompts and background notices
   * are retractable; an answer is refused (removing it would desynchronize the
   * question state from the child inbox). A human's queued instruction is the
   * human's intent, a scheduled wake belongs to the schedule plugin, and
   * another lead's relay belongs to that lead. The call is idempotent — an
   * input already consumed or withdrawn reports `retracted: false`. The target
   * must be live (the inbox is driver-owned) and cannot be the lead itself.
   * @param agent - exact live lead Agent.
   * @param sessionId - target Session reference (id or unique prefix).
   * @param inputId - Host message identity reported by queuedInputs.
   * @param signal - cancellation checked before each stage.
   * @returns the retraction outcome.
   * @throws {@link DevLeadError} `DEVLEAD_INVALID_INPUT` for a self-addressed
   *   call or an input this lead did not author, `DEVLEAD_SESSION_UNAVAILABLE`
   *   for a cold target, and the usual resolution failures.
   */
  async retractQueuedInput(
    agent: Agent,
    sessionId: string,
    inputId: string,
    signal?: AbortSignal,
  ): Promise<DevLeadRetractedInput> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    const deps = this.viewDeps(agent, signal)
    const resolved = await resolveSessionReference(deps, sessionId)
    signal?.throwIfAborted()
    const targetId = String(resolved.sessionId)
    if (targetId === String(agent.id)) {
      throw new DevLeadError(
        'a DevLead Session cannot retract inputs from its own inbox; ask the human to manage this Session',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const target = this.ctx.agents.get(resolved.sessionId)
    if (target === undefined) {
      throw new DevLeadError(
        `Session "${targetId}" is not live, so its inbox cannot be inspected or retracted; open it first`,
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    const pending = [...target.inbox.nextTurn, ...target.inbox.nextStep]
      .find(message => String(message.id) === inputId)
    if (pending === undefined) return { sessionId: targetId, inputId, retracted: false }
    if (isAnswerMessage(pending)) {
      throw new DevLeadError(
        `queued input "${inputId}" is an answer to a question; retracting it would desynchronize the question `
        + 'state from the child inbox, so answers cannot be retracted — to discard one and reopen its question, '
        + 'use devlead_prompt_session with interrupt:true and interrupt_inbox:"clear-all"',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    if (!isOwnRetractable(pending, String(agent.id))) {
      throw new DevLeadError(
        `queued input "${inputId}" was not authored by this DevLead Session; only your own relay prompts and `
        + 'background notices can be retracted — human, scheduled, and other producers\' inputs are not yours to remove',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const retracted = target.inbox.remove(MessageId(inputId))
    if (retracted) await this.flushDurably(target.session, `retraction of input "${inputId}"`)
    return { sessionId: targetId, inputId, retracted }
  }

  /**
   * Create one ordinary Session in a Workspace and optionally prompt it.
   *
   * A requested `worktree` checkout isolation is applied best effort between
   * the watch update and the initial prompt: when the Host composes no
   * compatible Git worktree service, the new Session is not live, or creation
   * fails, the result reports an `unavailable`/`failed` isolation outcome and
   * the call still succeeds, with the Session working in the Workspace
   * checkout.
   *
   * Cancellation is cooperative: the signal is checked before each stage. A
   * cancellation that arrives after the Session was created cannot undo the
   * creation (or a title/watch mutation already applied); it only stops the
   * next side effect, so a cancelled create may leave a watched Session behind
   * without running isolation or admitting the prompt. Session creation itself
   * is not abortable once started.
   *
   * A requested model selection and Agent Teams mode are creation-time
   * settings, applied to the new Session's own Agent immediately after the
   * Session exists and before its title/watch/isolation/prompt. The model is
   * validated against the Host's LLM registry first, and it is recorded with
   * `agent.model.select`, never through the Session controller's `selectModel`
   * (which would also rewrite the profile default model). An application
   * failure after creation reports the created Session id and leaves that
   * Session in place, matching the service's non-rollback creation contract.
   * @param agent - exact live lead Agent.
   * @param request - Workspace, optional title, initial prompt, watch policy,
   *   preset, checkout isolation mode, creation-time model selection, and
   *   creation-time Agent Teams mode.
   * @param signal - cancellation checked between stages and threaded into the
   *   worktree creation.
   * @returns the created Session, the Workspace it joined, the
   *   checkout-isolation outcome, and any applied model/Team settings.
   * @throws {@link DevLeadError} when the mode is off, the Host cannot create
   *   Sessions, the destination is not usable, or a requested model/Team
   *   capability is unavailable.
   */
  async createSession(
    agent: Agent,
    request: DevLeadCreateSessionRequest,
    signal?: AbortSignal,
  ): Promise<DevLeadCreatedSession> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    // Request shape is validated before any Host capability or side effect.
    const requestedModel = normalizeModelSelection(request.model)
    const requestedTeams = request.agentTeams
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new DevLeadError(
        'this Host cannot create Sessions: no API Session controller is composed',
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    // A requested Team mode is an explicit opt-in: fail before creating a
    // Session on a Host that composes no Team service. An explicit `false` is
    // satisfied by that absence too (there is no Team mode to turn off).
    const teams = requestedTeams === undefined ? undefined : agentTeamsCapabilityOf(this.ctx)
    if (requestedTeams === true && teams === undefined) {
      throw new DevLeadError(
        'this Host composes no Agent Teams service, so agent_teams cannot be enabled. '
        + 'Agent Teams is available from DSH 0.2.2-rc.2 (and is included in the default '
        + 'composition there); omit agent_teams or continue without Team mode',
        'DEVLEAD_TEAM_UNAVAILABLE',
      )
    }
    if (requestedModel !== undefined) await this.assertModelSelectable(requestedModel, signal)
    const watch = request.watch ?? true
    // Reserve the watch slot synchronously before the first await: a rejected
    // watch after creation would leave an orphan Session the caller was told
    // did not exist, and a second concurrent create must see the reservation.
    const releaseWatch = watch ? this.reserveWatchSlot(agent) : undefined
    try {
      const workspace = await this.createTargetWorkspace(agent, request.workspace)
      signal?.throwIfAborted()
      // The controller creates a missing Workspace directory implicitly; a
      // registered Workspace whose directory moved must fail here instead of
      // resurrecting an empty directory and dispatching a child into it.
      if (await workspace.status() !== 'ok') {
        throw new DevLeadError(
          `Workspace "${workspace.title}" (${workspace.path}) is no longer an available directory; `
          + 'restore it or register a different Workspace',
          'DEVLEAD_DIRECTORY_MISSING',
        )
      }
      signal?.throwIfAborted()
      const preset = request.preset?.trim() ?? this.resolved.defaultAgentPreset
      let created: SessionCreateValue
      try {
        created = await controller.create({
          workspaceId: workspace.id,
          ...(preset === undefined || preset.length === 0 ? {} : { agentPreset: preset }),
        })
      } catch (error: unknown) {
        throw this.sessionUnavailable(`could not create a Session in "${workspace.title}": ${thrownMessage(error)}`, error)
      }
      signal?.throwIfAborted()
      const sessionId = String(created.sessionId)
      const applied = await this.applyDispatchSettings(created, requestedModel, requestedTeams, teams, signal)
      if (request.title !== undefined && request.title.trim().length > 0) {
        this.tryRename(created.sessionId, request.title.trim())
      }
      if (watch) {
        await this.setWatching(agent, created.sessionId, true, signal, true)
        // The watch record is committed: release the reserved capacity now.
        // Holding it through isolation/prompt would double-count this Session
        // and block unrelated watch writes for the rest of the call.
        releaseWatch?.()
      }
      // Isolation must run before the prompt is admitted: the new Session's Agent
      // is still blank, so entering the isolated checkout cannot lose context.
      // The capability is resolved and called best effort; only cancellation
      // throws out of this stage.
      signal?.throwIfAborted()
      const isolation = await this.isolateSession(created.sessionId, request.isolation ?? 'none', signal)
      signal?.throwIfAborted()
      const prompt = request.prompt?.trim() ?? ''
      const prompted = prompt.length > 0
      if (prompted) {
        await this.admitPrompt(agent, created.sessionId, prompt, {
          allowResume: false,
          interrupt: false,
          interruptInbox: 'clear-all',
          signal,
          plan: planLeadToChild({ targetState: 'idle', intent: 'instruction' }) as PlannedDelivery,
          intent: 'instruction',
        })
      }
      const deps = this.viewDeps(agent, signal)
      return {
        session: await devLeadSessionView(deps, sessionId, true),
        workspace: await devLeadWorkspaceView(workspace),
        prompted,
        isolation,
        ...(applied.model === undefined ? {} : { model: applied.model }),
        ...(applied.agentTeams === undefined ? {} : { agentTeams: applied.agentTeams }),
      }
    } finally {
      releaseWatch?.()
    }
  }

  /**
   * Admit one prompt into an existing Session, resuming a cold Session and
   * watching it by default.
   *
   * The semantic `intent` (default `instruction`) selects the delivery through
   * the pure policy table, never a model-chosen transport: `answer` (with a
   * `question_id`) and `correction` steer the next step, `background` injects
   * context without requesting a wake, and `instruction` queues a follow-up
   * turn. `interrupt: true` overrides the intent to cancel-and-replace: when
   * the Agent is running, the Host's `workspace/session-stop` providers stop
   * the turn (and the subagent/job/schedule work they report) before the
   * replacement prompt is admitted as a next turn. The stop is fire-and-forget;
   * an idle or cold Session skips it.
   *
   * An answer is validated against the lead's durable question report and the
   * observed question/answer state: an open question accepts a new answer; an
   * answered question accepts only a same-key/same-text idempotent retry (which
   * returns the original receipt without a second delivery); a different answer
   * conflicts. Admission writes a durable answer record and the result carries
   * the actual primitive/boundary/wake and the stable message identity.
   *
   * Concurrent calls for one target are serialized so their watch/interrupt/
   * admission stages cannot interleave out of call order in the child inbox.
   * @param agent - exact live lead Agent.
   * @param sessionId - Session id or unique prefix.
   * @param prompt - non-empty prompt text.
   * @param options - intent/question/idempotency, watch policy, interrupt
   *   policy, and cancellation checked between stages. Cancellation after an
   *   interrupt was requested does not roll the stop back.
   * @returns the admitted prompt receipt with its delivery facts.
   * @throws {@link DevLeadError} when the Session is missing, archived, or
   *   cannot be resumed, the intent combination is illegal, or the question is
   *   not found / already answered.
   */
  async promptSession(
    agent: Agent,
    sessionId: string,
    prompt: string,
    options: DevLeadPromptSessionOptions = {},
  ): Promise<DevLeadPromptedSession> {
    this.assertReady(agent)
    const signal = options.signal
    signal?.throwIfAborted()
    const text = prompt.trim()
    if (text.length === 0) throw new DevLeadError('a non-empty prompt is required', 'DEVLEAD_INVALID_INPUT')
    const intent: DevLeadPromptIntent = options.intent ?? 'instruction'
    if (!DEVLEAD_PROMPT_INTENTS.includes(intent)) {
      throw new DevLeadError(
        `prompt intent ${JSON.stringify(intent)} is not recognized; use instruction, answer, correction, or background`,
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const questionId = options.questionId === undefined ? undefined : options.questionId.trim()
    if (questionId !== undefined && questionId.length === 0) {
      throw new DevLeadError('question_id must not be empty when provided', 'DEVLEAD_INVALID_INPUT')
    }
    const idempotencyKey = options.idempotencyKey === undefined ? undefined : options.idempotencyKey.trim()
    if (idempotencyKey !== undefined
      && (idempotencyKey.length === 0 || Array.from(idempotencyKey).length > DEVLEAD_IDEMPOTENCY_KEY_MAX)) {
      throw new DevLeadError(
        `idempotency_key must be 1-${DEVLEAD_IDEMPOTENCY_KEY_MAX} code points when provided`,
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const deps = this.viewDeps(agent, signal)
    const resolved = await resolveSessionReference(deps, sessionId)
    signal?.throwIfAborted()
    const targetId = String(resolved.sessionId)
    if (targetId === String(agent.id)) {
      throw new DevLeadError(
        'a DevLead Session cannot prompt itself; end this turn and continue from a new human turn',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    return await this.withTargetAdmission(targetId, async () => {
      signal?.throwIfAborted()
      const leadId = String(agent.id)
      // Drain any queued discards before this admission: the question guards
      // below must see the reopened state, and an older discard must reach the
      // durable audit before a newer answer record is appended.
      if (this.pendingAnswerDiscards.has(leadId)) await this.reconcileAnswerDiscards(leadId)
      // Settle repairs before the question guards. Kick any deferred repairs,
      // then await the barrier chain until no repair is in flight (the chain
      // accumulates EVERY registered repair, so any number of them settles —
      // no fixed round cap). Repairs spawned by drain/restore/drop also chain
      // here through repairStaleDurableDiscard's self-registration.
      if (this.deferredDiscardRepairs.has(leadId)) {
        this.registerRepairBarrier(leadId, this.processDeferredDiscardRepairs(leadId))
      }
      // Await until no repair is in flight, bounded by a finite deadline and the
      // caller's abort signal so a never-resolving repair cannot hang admission.
      const repairDeadline = Date.now() + REPAIR_BARRIER_TIMEOUT_MS
      let barrier = this.answerRepairBarriers.get(leadId)
      while (barrier !== undefined) {
        const remaining = repairDeadline - Date.now()
        if (remaining <= 0) {
          throw new DevLeadError(
            `question "${questionId ?? ''}" answer-discard repair did not settle in time; retry the answer shortly`,
            'DEVLEAD_SESSION_UNAVAILABLE',
          )
        }
        await this.awaitRepairBarrier(barrier, remaining, signal)
        barrier = this.answerRepairBarriers.get(leadId)
      }
      // After the barrier settles, re-check: a repair still pending (failed and
      // re-deferred, or the child's reality is unreadable) means the question's
      // `open` is provisional. Refuse this answer admission with a retryable
      // error rather than silently accepting a possible duplicate.
      if (intent === 'answer' && questionId !== undefined && this.questionRepairPending(leadId, questionId)) {
        throw new DevLeadError(
          `question "${questionId}" has a pending answer-discard repair (the child's delivery state is not yet confirmed); `
          + 'retry the answer shortly — do not treat the current open state as final',
          'DEVLEAD_SESSION_UNAVAILABLE',
        )
      }
      const archived = this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(resolved.sessionId) ?? false
      const liveTarget = this.ctx.agents.get(resolved.sessionId)
      const targetState: TargetState = archived
        ? 'archived'
        : liveTarget === undefined ? 'cold' : liveTarget.status === 'running' ? 'running' : 'idle'
      // Gather the question facts an answer needs. The policy table owns the
      // combination guards and the question admission decision; a missing or
      // foreign report simply leaves `question` undefined so the policy rejects.
      let question: QuestionPolicyState | undefined
      let answerRetry: AnswerRetryPolicy | undefined
      if (intent === 'answer' && questionId !== undefined) {
        const state = this.strictStateOf(agent.session)
        const report = state.reports.find(existing => existing.id === questionId)
        if (report !== undefined && report.kind === 'question'
          && report.senderSessionId === targetId && report.leadSessionId === leadId) {
          const view = this.questionAnswerView(agent, questionId)
          const latest = this.latestAnswerFact(agent, questionId)
          if (view !== undefined && view.questionStatus === 'answered') {
            const answerStatus = view.answerStatus ?? 'admitted'
            question = {
              questionStatus: 'answered',
              answerStatus: answerStatus === 'claimed' || answerStatus === 'presented' ? answerStatus : 'admitted',
            }
          } else {
            const answerStatus = view?.answerStatus
            question = {
              questionStatus: 'open',
              ...(answerStatus === 'discarded' || answerStatus === 'failed' ? { answerStatus } : {}),
            }
          }
          answerRetry = {
            sameIdempotencyKey: idempotencyKey !== undefined && latest?.idempotencyKey === idempotencyKey,
            sameText: latest !== undefined && latest.textHash === answerTextHash(text),
          }
        }
      }
      const plan = planLeadToChild({
        targetState,
        intent,
        interrupt: options.interrupt ?? false,
        ...(questionId === undefined ? {} : { questionId }),
        ...(question === undefined ? {} : { question }),
        ...(answerRetry === undefined ? {} : { answerRetry }),
      })
      if (plan.status === 'rejected') {
        throw this.deliveryRejectionError(plan.reason, targetId, questionId, agent)
      }
      const watchedNow = (): boolean => this.strictStateOf(agent.session).sessions.includes(targetId)
      if (plan.status === 'idempotent-replay') {
        // A recognized answer retry returns the original receipt without a
        // second delivery or any watch mutation.
        return {
          sessionId: targetId,
          watched: watchedNow(),
          resumed: false,
          interrupted: false,
          delivery: this.answerReceiptOf(agent, questionId as string),
        }
      }
      if (plan.status !== 'planned') {
        // planLeadToChild only returns planned/rejected/idempotent-replay for a
        // lead-to-child prompt; a digest-only plan is a child-to-lead outcome.
        throw new DevLeadError(
          `Session "${targetId}" cannot receive this prompt right now; read devlead_notifications and retry`,
          'DEVLEAD_SESSION_UNAVAILABLE',
        )
      }
      // Non-answer idempotency window: a same-key same-text retry returns the
      // original receipt; a different text under the same key is a conflict.
      const windowKey = intent !== 'answer' && idempotencyKey !== undefined
        ? `${leadId}\u0000${targetId}\u0000${idempotencyKey}`
        : undefined
      if (windowKey !== undefined) {
        const previous = this.idempotencyWindow.get(windowKey)
        if (previous !== undefined) {
          if (previous.textHash !== answerTextHash(text)) {
            throw new DevLeadError(
              `idempotency_key "${idempotencyKey}" was already used for a different prompt into Session "${targetId}"; `
              + 'use a new key or resend the original prompt text',
              'DEVLEAD_INVALID_INPUT',
            )
          }
          return { sessionId: targetId, watched: watchedNow(), resumed: false, interrupted: false, delivery: previous.delivery }
        }
      }
      // Validate the cold-resume capability before the watch mutation, so a Host
      // that cannot resume the Session does not leave a half-applied watch.
      if (!resolved.live && this.ctx.get('sessionController') === undefined) {
        throw new DevLeadError(
          `Session "${targetId}" is not live and this Host composes no Session activator, so it cannot be prompted`,
          'DEVLEAD_SESSION_UNAVAILABLE',
        )
      }
      const watch = options.watch ?? true
      // Watch before admission: a very fast child turn/end must not settle before
      // the watch commits, or the first wake is lost. The trade-off is that a
      // failed/cancelled admission can leave the watch behind, so this call
      // compensates exactly the watch it added — a pre-existing explicit watch is
      // the caller's state and is never undone.
      const added = watch && !watchedNow()
      if (added) await this.setWatching(agent, resolved.sessionId, true, signal)
      let admission: PromptAdmission
      try {
        admission = await this.admitPrompt(agent, resolved.sessionId, text, {
          allowResume: true,
          interrupt: options.interrupt ?? false,
          interruptInbox: options.interruptInbox ?? 'clear-all',
          signal,
          plan,
          intent,
          ...(questionId === undefined ? {} : { questionId }),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        })
      } catch (error: unknown) {
        // An interrupt whose stop was already committed keeps the watch: the
        // lead must still observe the cancelled turn and retry the prompt.
        if (added && !(error instanceof DevLeadInterruptedAdmissionError)) {
          // No signal: the caller's cancellation already happened, and the
          // compensating write must still run. A rollback failure is a warning:
          // the original failure is what the caller must see.
          try {
            await this.setWatching(agent, resolved.sessionId, false)
          } catch (compensateError: unknown) {
            this.ctx.logger.warn(
              `devlead: could not roll back the automatic watch for Session "${targetId}": `
              + thrownMessage(compensateError),
            )
          }
        }
        throw error
      }
      const delivery: DevLeadPromptDelivery = {
        ...admission.delivery,
        ...(questionId === undefined ? {} : { questionId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }
      let answerWarning: string | undefined
      if (intent === 'answer' && questionId !== undefined) {
        const recorded = await this.recordAnswerAdmission(agent, targetId, questionId, text, idempotencyKey, admission.delivery)
        answerWarning = recorded.warning
      }
      if (windowKey !== undefined) {
        this.idempotencyWindow.delete(windowKey)
        this.idempotencyWindow.set(windowKey, { textHash: answerTextHash(text), delivery })
        while (this.idempotencyWindow.size > MAX_IDEMPOTENCY_WINDOW) {
          const oldest = this.idempotencyWindow.keys().next().value
          if (oldest === undefined) break
          this.idempotencyWindow.delete(oldest)
        }
      }
      return {
        sessionId: targetId,
        watched: watchedNow(),
        resumed: admission.resumed,
        interrupted: admission.interrupted,
        ...(admission.retainedInputs === undefined ? {} : { retainedInputs: admission.retainedInputs }),
        delivery,
        ...(answerWarning === undefined ? {} : { warning: answerWarning }),
      }
    })
  }

  /**
   * Close one Session by archiving it in the Workspace registry.
   *
   * Archiving is the DSH `archive` action: the Session disappears from grouping
   * surfaces but its log is kept, and {@link unarchiveSession} restores it to
   * its recorded Workspace position. It is idempotent: an already archived
   * Session resolves without writing, asking, or stopping anything, and
   * `stopped` is then `false` even when `stopRunning` is true.
   *
   * With `stopRunning` unset the Host refuses a Session whose running work was
   * reported by a `workspace/session-activity` provider; that refusal is mapped
   * to `DEVLEAD_SESSION_ACTIVE` with the activity families in the message.
   * With `stopRunning: true` the archive is written first and the Host is then
   * asked to stop that work through the same providers the human's own stop
   * action uses; running work is never awaited to settlement, so the result
   * reports `stopped: true` as soon as the requests were issued.
   *
   * A lead Session can never archive itself: that would pause its own
   * notification delivery, and `stopRunning` would cancel the very turn making
   * the call. The rejection is a domain error that points the human at the
   * Workspace sidebar.
   * @param agent - exact live lead Agent making the archival.
   * @param sessionId - Session id, unique prefix, or bare uuid prefix.
   * @param options - stop-running policy (default `false`) and cancellation
   *   checked before the registry write.
   * @returns the archived Session identity and whether the Host was asked to
   *   stop the Session's running work (`false` when it was already archived).
   * @throws {@link DevLeadError} `DEVLEAD_NOT_ENABLED`/`DEVLEAD_AGENT_NOT_LIVE`
   *   for a disallowed caller, `DEVLEAD_INVALID_INPUT` for the lead's own
   *   Session, `DEVLEAD_SESSION_NOT_FOUND` for an unknown Session,
   *   `DEVLEAD_SESSION_ACTIVE` for running work without `stopRunning`, and
   *   `DEVLEAD_WORKSPACE_NOT_FOUND` when the Host composes no registry.
   */
  async archiveSession(
    agent: Agent,
    sessionId: string,
    options: DevLeadArchiveSessionOptions = {},
  ): Promise<DevLeadArchivedSession> {
    this.assertReady(agent)
    const signal = options.signal
    signal?.throwIfAborted()
    const deps = this.viewDeps(agent, signal)
    const resolved = await resolveSessionReference(deps, sessionId)
    const id = String(resolved.sessionId)
    signal?.throwIfAborted()
    // DSH gives an Agent its Session's id (Agent.id is a SessionId), so a
    // resolved Session equal to the caller is this lead's own Session.
    if (id === String(agent.id)) {
      throw new DevLeadError(
        'a DevLead Session cannot archive itself; ask the human to close this Session from the Workspace sidebar',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const registry = this.requireWorkspaceRegistry()
    if (registry.archivedSessionIds.includes(resolved.sessionId)) {
      // Already archived: the Host's archive is a no-op too, but reporting a
      // stop it never requested would be a lie.
      return { sessionId: id, archived: true, stopped: false }
    }
    const stopRunning = options.stopRunning ?? false
    try {
      await registry.archiveSession(resolved.sessionId, { stopActivity: stopRunning })
    } catch (error: unknown) {
      throw this.archiveFailure(id, error) ?? error
    }
    return { sessionId: id, archived: true, stopped: stopRunning }
  }

  /**
   * Restore one archived Session to its recorded Workspace position.
   *
   * Unarchiving is idempotent: an id that is not archived resolves without
   * writing. The Session log was never touched by the archive.
   * @param agent - exact live lead Agent making the restore.
   * @param sessionId - Session id, unique prefix, or bare uuid prefix.
   * @param signal - cancellation checked before the registry write.
   * @returns the restored Session identity.
   * @throws {@link DevLeadError} `DEVLEAD_SESSION_NOT_FOUND` when nothing
   *   matches the reference, `DEVLEAD_WORKSPACE_NOT_FOUND` when the Host
   *   composes no registry, and the caller errors of {@link assertReady}.
   */
  async unarchiveSession(
    agent: Agent,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DevLeadUnarchivedSession> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    const deps = this.viewDeps(agent, signal)
    const resolved = await resolveSessionReference(deps, sessionId)
    signal?.throwIfAborted()
    const registry = this.requireWorkspaceRegistry()
    await registry.unarchiveSession(resolved.sessionId)
    return { sessionId: String(resolved.sessionId), archived: false }
  }

  /**
   * Add or remove one Session from this lead's watch set.
   * @param agent - exact live lead Agent.
   * @param sessionId - Session id or unique prefix.
   * @param watching - whether the Session should be watched.
   * @param signal - cancellation checked before resolving and before the write.
   * @returns the resulting watch mutation.
   * @throws {@link DevLeadError} when the Session is missing, self-addressed, or over the limit.
   */
  async watchSession(
    agent: Agent,
    sessionId: string,
    watching: boolean,
    signal?: AbortSignal,
  ): Promise<DevLeadWatchMutation> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    const deps = this.viewDeps(agent, signal)
    const resolved = await resolveSessionReference(deps, sessionId)
    signal?.throwIfAborted()
    if (String(resolved.sessionId) === String(agent.id)) {
      throw new DevLeadError('a DevLead Session cannot watch itself', 'DEVLEAD_SELF_WATCH')
    }
    return await this.setWatching(agent, resolved.sessionId, watching, signal)
  }

  /**
   * Read the retained notification digest of one live lead Session.
   * @param agent - exact live lead Agent.
   * @param options - newest-row limit; omitted or not a positive safe integer
   *   keeps the default of 20 rows.
   * @returns the newest retained notifications, oldest first.
   * @throws {@link DevLeadError} when the Agent is not live or the replay failed.
   */
  notifications(agent: Agent, options: { limit?: number } = {}): DevLeadNotification[] {
    this.assertLive(agent)
    const state = this.strictStateOf(agent.session)
    const limit = options.limit ?? 20
    const effective = Number.isSafeInteger(limit) && limit > 0 ? limit : 20
    return state.notifications.slice(-effective)
  }

  /** Open the optional durable outbox once and load its archived-holder tombstones. */
  private async openOutbox(): Promise<void> {
    if (this.disposed) return
    if (this.outbox !== undefined || this.outboxOpening !== undefined) return
    const run = (async () => {
      if (this.disposed) return
      const outbox = await DevLeadReportOutbox.open(this.ctx)
      if (outbox === undefined) {
        this.ctx.logger.debug(
          'devlead: no storage-domain service is composed; reports use the explicit non-durable fallback',
        )
        return
      }
      if (this.disposed) {
        // The plugin was unloaded while the storage facility was still opening:
        // nobody else can close this handle, and leaving it open would make a
        // reload's open fail as `already-open`.
        await outbox.close()
        return
      }
      this.outbox = outbox
      for (const sessionId of outbox.ignoredIds()) this.ignoredArchived.add(sessionId)
      await outbox.prune()
      this.outboxPrunedAt = Date.now()
    })()
    this.outboxOpening = run
    try {
      await run
    } finally {
      this.outboxOpening = undefined
    }
  }

  /**
   * Run one throttled outbox retention sweep before a report write. Replay
   * already prunes on every pass; this keeps the seven-day horizon enforced on
   * a Host whose only outbox traffic is report writes (for example a cold lead
   * with `wakeColdSession: false`).
   */
  private async pruneOutboxOpportunistically(): Promise<void> {
    const outbox = this.outbox
    if (outbox === undefined) return
    const now = Date.now()
    if (this.outboxPrunedAt !== 0 && now - this.outboxPrunedAt < REPORT_OUTBOX_PRUNE_INTERVAL_MS) return
    // Stamp before the await so concurrent report writes do not all sweep.
    this.outboxPrunedAt = now
    await outbox.prune(now)
  }

  /**
   * Replay durable outbox rows whose lead is now attachable, then clear each
   * row only after its Session-log receipt was flushed.
   */
  private async replayOutbox(): Promise<void> {
    if (this.disposed || this.outbox === undefined || this.outboxReplaying) return
    this.outboxReplaying = true
    try {
      await this.outbox.prune()
      // Replay just swept the table: suppress a redundant report-write sweep.
      this.outboxPrunedAt = Date.now()
      const archived = new Set(
        (this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? []).map(id => String(id)),
      )
      let waiting = 0
      for (const entry of this.outbox.entries()) {
        if (this.disposed) return
        const report = entry.report
        if (archived.has(report.leadSessionId)) {
          waiting += 1
          continue
        }
        let delivered = false
        try {
          delivered = (await this.hub?.persistReport(report)) ?? false
        } catch (error: unknown) {
          this.ctx.logger.warn(
            `devlead: could not replay report "${report.id}": ${thrownMessage(error)}`,
          )
        }
        if (delivered) await this.outbox.delete(report)
        else waiting += 1
      }
      if (waiting > 0) {
        this.ctx.logger.warn(
          `devlead: ${String(waiting)} durable report(s) wait for their lead Session or watch relationship to return`,
        )
      }
    } finally {
      this.outboxReplaying = false
    }
  }

  /**
   * Persist a report in the durable outbox (when available) and try to write
   * its lead receipt. The outbox row is only removed after the lead flush
   * succeeded; otherwise the report remains replayable. A capacity rejection
   * that lands after the outbox write (two concurrent questions racing the
   * pair cap) removes the just-written row and rethrows, so the child sees the
   * explicit error and no orphan row is left behind.
   * @param report - validated report.
   * @returns the child-facing receipt with durability status.
   * @throws `DEVLEAD_DELIVERY_RATE_LIMITED` when the pair's Q1 pending queue
   *   filled between the preflight and the receipt write.
   */
  private async deliverReport(report: DevLeadReport): Promise<DevLeadReportReceipt> {
    // Capacity errors must reach the child before an outbox row can make a
    // rejected question look accepted; replay applies the same check in the hub.
    this.hub?.assertReportCapacity(report)
    await this.pruneOutboxOpportunistically()
    const outboxed = this.outbox === undefined ? false : await this.outbox.put(report)
    if (outboxed && this.outbox !== undefined) {
      let delivered = false
      try {
        delivered = (await this.hub?.persistReport(report)) ?? false
      } catch (error: unknown) {
        // The preflight above is not atomic: two concurrent questions can both
        // pass it at the pair-cap boundary, and the loser's receipt write then
        // fails inside the hub. That rejection must reach the child as the
        // explicit capacity error, and the row this call just wrote must not
        // survive as an orphan that only a later replay would notice.
        if (isDevLeadError(error) && error.code === 'DEVLEAD_DELIVERY_RATE_LIMITED') {
          const removed = await this.outbox.delete(report)
          if (!removed) {
            this.ctx.logger.warn(
              `devlead: could not remove the capacity-rejected report "${report.id}" from the outbox; `
              + 'a later replay will reconcile it',
            )
          }
          throw error
        }
        this.ctx.logger.warn(
          `devlead: report "${report.id}" is durable but its first delivery attempt failed: ${thrownMessage(error)}`,
        )
      }
      if (delivered) await this.outbox.delete(report)
      return {
        report,
        durable: true,
        queued: !delivered,
      }
    }
    const accepted = this.hub?.report(report) ?? false
    if (!accepted) {
      throw new DevLeadError(
        'the active DevLead Session stopped watching this Session before the report could be queued',
        'DEVLEAD_NOT_SUPERVISED',
      )
    }
    return {
      report,
      durable: false,
      queued: true,
      warning: 'durable report storage is unavailable on this Host; the receipt is queued in memory '
        + 'and may be lost if the Host exits before the lead consumes it'
        + (this.outbox?.lastError === undefined ? '' : ` (${this.outbox.lastError})`),
    }
  }

  /**
   * Resolve the unique active DevLead Session that watches one reporter.
   *
   * The hub's reverse index already reflects durable watch/mode state (live and
   * cold rehydrated leads). Archived leads are excluded, and when historical
   * state leaves more than one watcher the current global incumbent wins; with
   * no unique answer the reporter is treated as unwatched instead of
   * broadcasting to an arbitrary lead.
   * @param agent - candidate watched Session Agent.
   * @returns the watching lead Session id, or undefined.
   */
  supervisorOf(agent: Agent): string | undefined {
    if (this.hub === undefined) return undefined
    if (this.ctx.agents.get(agent.id) !== agent) return undefined
    if (this.isEnabled(agent)) return undefined
    const archived = new Set(
      (this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? []).map(id => String(id)),
    )
    const candidates = this.hub.supervisorsOf(String(agent.id)).filter(id => !archived.has(id))
    if (candidates.length === 0) return undefined
    if (candidates.length === 1) return candidates[0]
    return this.activeSessionId !== undefined && candidates.includes(this.activeSessionId)
      ? this.activeSessionId
      : undefined
  }

  /**
   * List archived Sessions that still carry a durable enabled mode.
   *
   * They are ignored by admission (an archived Session is not an active lead),
   * but the human needs a visible, actionable recovery path: unarchive and open
   * the Session to run `/devlead off`, or delete it. The list is also the
   * diagnostic surface for a tombstone that could not be cleared.
   * @param signal - cancellation threaded through the scan.
   * @returns archived holders with human labels.
   */
  async archivedOccupants(signal?: AbortSignal): Promise<Array<{
    readonly sessionId: string
    readonly title?: string
  }>> {
    const active = await this.scanActiveSessions(signal)
    signal?.throwIfAborted()
    return active
      .filter(occupant => occupant.archived)
      .map(occupant => ({
        sessionId: occupant.sessionId,
        ...(occupant.title === undefined ? {} : { title: occupant.title }),
      }))
  }

  /**
   * Whether one Session may send mid-turn reports to an active DevLead.
   * @param agent - candidate reporter Agent.
   * @returns whether the reporter has exactly one active lead watching it.
   */
  isSupervised(agent: Agent): boolean {
    return this.supervisorOf(agent) !== undefined
  }

  /**
   * Send one mid-turn report from a watched Session to its active DevLead.
   *
   * The durable receipt is appended to the lead's own Session log (or queued
   * for a cold lead by the hub). Ordinary reports keep the coalesced followup
   * path; question reports use their independent action-required steer path.
   * This method returns after the receipt/queue decision, not after the wake,
   * and never waits for the lead's next turn, so the
   * reporter is not blocked. Same-kind same-message reports in one turn are
   * idempotent (the same text under a different kind is a new report);
   * more than {@link DEVLEAD_REPORT_MAX_PER_TURN} distinct non-question reports
   * in one turn are refused. `question` reports are the answer-seeking channel
   * used by the watched-Session question router, so they are exempt from that
   * progress budget.
   * @param agent - exact live reporter Agent.
   * @param request - report text, kind, optional summary, and native structured questions.
   * @param signal - cancellation checked before durable work.
   * @returns the report receipt, including whether it is durable and still queued.
   * @throws {@link DevLeadError} `DEVLEAD_NOT_SUPERVISED` when no unique active
   *   lead watches the reporter, `DEVLEAD_INVALID_INPUT` for unusable fields,
   *   `DEVLEAD_REPORT_RATE_LIMITED` when the per-turn budget is exhausted, and
   *   `DEVLEAD_DELIVERY_RATE_LIMITED` when the pair's Q1 pending queue is full.
   */
  async reportProgress(
    agent: Agent,
    request: DevLeadReportRequest,
    signal?: AbortSignal,
  ): Promise<DevLeadReportReceipt> {
    this.assertLive(agent)
    signal?.throwIfAborted()
    if (this.isEnabled(agent)) {
      throw new DevLeadError(
        'this Session is the active DevLead; a DevLead Session cannot report to itself',
        'DEVLEAD_NOT_SUPERVISED',
      )
    }
    const leadSessionId = this.supervisorOf(agent)
    if (leadSessionId === undefined) {
      throw new DevLeadError(
        'this Session is not watched by the unique active DevLead Session, so it cannot send a report',
        'DEVLEAD_NOT_SUPERVISED',
      )
    }
    const message = request.message.trim()
    if (message.length === 0) {
      throw new DevLeadError('report message must not be empty', 'DEVLEAD_INVALID_INPUT')
    }
    if (message.length > DEVLEAD_REPORT_MESSAGE_MAX * 2
      || Array.from(message).length > DEVLEAD_REPORT_MESSAGE_MAX) {
      throw new DevLeadError(
        `report message must be at most ${DEVLEAD_REPORT_MESSAGE_MAX} code points`,
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const kind = request.kind ?? 'progress'
    if (!isDevLeadReportKind(kind)) {
      throw new DevLeadError(
        `report kind ${JSON.stringify(kind)} is not recognized; use progress, blocked, decision, question, or fyi`,
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const summary = request.summary?.trim()
    if (summary !== undefined && (summary.length === 0
      || summary.length > DEVLEAD_REPORT_SUMMARY_MAX * 2
      || Array.from(summary).length > DEVLEAD_REPORT_SUMMARY_MAX)) {
      throw new DevLeadError(
        `report summary must be 1-${DEVLEAD_REPORT_SUMMARY_MAX} code points when present`,
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const questions = validatedQuestions(request.questions, kind)
    const reporterId = String(agent.id)
    const turn = this.ctx.agents.turnBoundaryOf(agent.session).lastTurn
    const previous = this.reportState.get(reporterId)
    const state = previous !== undefined && previous.turn === turn && previous.leadSessionId === leadSessionId
      ? previous
      : { turn, leadSessionId, messages: new Map<string, DevLeadReportReceipt>() }
    if (previous === undefined || previous.turn !== turn || previous.leadSessionId !== leadSessionId) {
      this.reportState.set(reporterId, state)
    }
    // The idempotency key mirrors the durable report identity (kind included):
    // re-sending the same text as a question after a progress report is an
    // upgrade to the answer-seeking channel, not a duplicate to swallow.
    const dedupKey = `${kind}\u0000${message}`
    const duplicate = state.messages.get(dedupKey)
    if (duplicate !== undefined) {
      const previousQuestions = JSON.stringify(duplicate.report.questions ?? null)
      const nextQuestions = JSON.stringify(questions ?? null)
      if (previousQuestions !== nextQuestions) {
        throw new DevLeadError(
          'the same report kind and message were already used in this turn with different structured questions; '
          + 'keep the questions unchanged for an idempotent retry, or change the report message',
          'DEVLEAD_INVALID_INPUT',
        )
      }
      return duplicate
    }
    // Questions are a control-flow channel, not progress chatter: they must
    // reach the lead even after four ordinary reports in the same turn.
    const progressCount = [...state.messages.values()]
      .filter(entry => entry.report.kind !== 'question').length
    if (kind !== 'question' && progressCount >= DEVLEAD_REPORT_MAX_PER_TURN) {
      throw new DevLeadError(
        `this Session already sent ${DEVLEAD_REPORT_MAX_PER_TURN} non-question reports in turn ${turn}; `
        + 'wait for the next turn or let the DevLead continue',
        'DEVLEAD_REPORT_RATE_LIMITED',
      )
    }
    const title = this.ctx.get('sessionTitle')?.get(agent.session)?.title
    let senderWorkspaceId: string | undefined
    let senderWorkspaceTitle: string | undefined
    for (const workspace of this.ctx.get('workspaceRegistry')?.list() ?? []) {
      if (!workspace.sessionIds.some(id => String(id) === reporterId)) continue
      senderWorkspaceId = workspace.id
      senderWorkspaceTitle = workspace.title
      break
    }
    const report = devLeadReport({
      senderSessionId: reporterId,
      ...(title === undefined ? {} : { senderSessionTitle: title }),
      ...(senderWorkspaceId === undefined ? {} : { senderWorkspaceId }),
      ...(senderWorkspaceTitle === undefined ? {} : { senderWorkspaceTitle }),
      leadSessionId,
      turn,
      kind,
      message,
      ...(summary === undefined ? {} : { summary }),
      ...(questions === undefined ? {} : { questions }),
      at: Date.now(),
    })
    signal?.throwIfAborted()
    const receipt = await this.deliverReport(report)
    state.messages.set(dedupKey, receipt)
    if (this.reportState.size > 512) {
      const oldest = this.reportState.keys().next().value
      if (oldest !== undefined) this.reportState.delete(oldest)
    }
    return receipt
  }

  /**
   * Read the retained mid-turn report digest of one live lead. Like
   * {@link notifications}, this is an audit read: a disabled lead may still
   * inspect what it retained while the mode was on.
   * @param agent - exact live lead Agent.
   * @param options - optional newest-row limit, defaulting to 20.
   * @returns detached reports, oldest first.
   */
  reports(agent: Agent, options: { limit?: number } = {}): DevLeadReport[] {
    this.assertLive(agent)
    const state = this.strictStateOf(agent.session)
    const limit = options.limit ?? 20
    const effective = Number.isSafeInteger(limit) && limit > 0 ? limit : 20
    return state.reports.slice(-effective)
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Reject an Agent that is not this registry's exact live instance. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new DevLeadError(
        `agent "${agent.id}" is not live in this registry; reopen its Session and retry`,
        'DEVLEAD_AGENT_NOT_LIVE',
      )
    }
  }

  /**
   * Check that one more watched Session fits under the configured cap, including
   * watch slots reserved by in-flight creates, before a write path creates side
   * effects it cannot roll back.
   * @param agent - exact live lead Agent.
   */
  private assertWatchCapacity(agent: Agent): void {
    const state = this.strictStateOf(agent.session)
    const reserved = this.watchReservations.get(String(agent.id)) ?? 0
    if (state.sessions.length + reserved < this.resolved.maxWatchedSessions) return
    throw new DevLeadError(
      `watch limit reached (${this.resolved.maxWatchedSessions}); unwatch a Session before adding another`,
      'DEVLEAD_WATCH_LIMIT',
    )
  }

  /**
   * Claim one watch slot synchronously for an in-flight create call.
   * @param agent - exact live lead Agent.
   * @returns an idempotent release function for the caller's `finally`.
   * @throws {@link DevLeadError} `DEVLEAD_WATCH_LIMIT` when the current watch
   *   set plus every other reservation is already at the cap.
   */
  private reserveWatchSlot(agent: Agent): () => void {
    const leadId = String(agent.id)
    const state = this.strictStateOf(agent.session)
    const reserved = this.watchReservations.get(leadId) ?? 0
    if (state.sessions.length + reserved >= this.resolved.maxWatchedSessions) {
      throw new DevLeadError(
        `watch limit reached (${this.resolved.maxWatchedSessions}); unwatch a Session before adding another`,
        'DEVLEAD_WATCH_LIMIT',
      )
    }
    this.watchReservations.set(leadId, reserved + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.watchReservations.get(leadId) ?? 0
      if (current <= 1) this.watchReservations.delete(leadId)
      else this.watchReservations.set(leadId, current - 1)
    }
  }

  /**
   * Flush one Session's durability checkpoint. `SessionStore.flush` returns
   * false when no durability participant is composed (a headless/SDK host that
   * keeps logs in memory) — that is not a failure, so it stays silent; only a
   * composed participant's own rejection is reported, and it is downgraded to a
   * warning because the append already committed to the live log and a later
   * checkpoint can still reach storage.
   * @param session - Session whose buffered events should be persisted.
   * @param what - operation name used in the warning text.
   */
  private async flushDurably(session: Session, what: string): Promise<void> {
    try {
      await this.ctx.sessions.flush(session)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: ${what} could not be flushed to persistence: ${thrownMessage(error)}`)
    }
  }

  /**
   * Eagerly checkpoint the optional Session projection cache after a durable
   * DevLead mode/watch/reset write.
   *
   * Cold rehydration trusts a cached "disabled/empty watch" row as a negative
   * pre-filter, and the cache's normal write-behind can lag the log by its
   * throttled interval. Without this eager write a crash in that window leaves
   * a stale negative row that hides a real cold lead until a human opens it.
   * The write is best-effort: a cache that is absent or fails only leaves the
   * throttled checkpoint in place, and the scan's exact fold still recovers the
   * lead whenever the row is positive or unclassified.
   * @param session - Session whose durable DevLead state just changed.
   * @param what - operation label for the failure warning.
   */
  private async checkpointProjectionCache(session: Session, what: string): Promise<void> {
    const cache = projectionCacheOf(this.ctx)
    if (cache?.write === undefined) return
    try {
      await cache.write(session)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: ${what} could not be checkpointed into the Session projection cache: ${thrownMessage(error)}`)
    }
  }

  /**
   * Serialize one global-mode critical section. Every admission waits for the
   * previous one, so two concurrent enables cannot both scan an empty Host and
   * then both append. The tail promise is released in `finally`, including on
   * a rejected admission.
   * @param body - critical section to run exclusively.
   * @returns the body result.
   */
  private async withAdmission<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.admissionTail
    let release!: () => void
    this.admissionTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await body()
    } finally {
      release()
    }
  }

  /**
   * Find an enabled Session other than `agent`, releasing archived holders
   * first. This is the admission check under the global mutex: it runs the
   * strict occupancy scan, so an unverifiable persisted corpus refuses the
   * enable instead of admitting a possible second lead.
   * @param agent - Session requesting the mode.
   * @param signal - caller cancellation checked around the scan and releases.
   * @returns the blocking occupant, or undefined when the mode is free.
   * @throws {@link DevLeadError} `DEVLEAD_SESSION_UNAVAILABLE` when occupancy
   *   cannot be verified.
   */
  private async blockingOccupant(
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<DevLeadActiveSession | undefined> {
    const active = await this.scanActiveSessions(signal, true, true)
    const blockers: DevLeadActiveSession[] = []
    for (const occupant of active) {
      if (occupant.sessionId === String(agent.id)) continue
      if (occupant.archived) {
        signal?.throwIfAborted()
        // Archiving means the Session is no longer an active lead. Try to
        // write the durable mode-off, but never let an unresumable archived
        // Session block a new lead; remember the tombstone so a later
        // unarchive/opening is reconciled instead of becoming a silent second
        // active lead.
        if (await this.releaseActiveOccupant(occupant, 'archived')) {
          await this.rememberReleased(occupant.sessionId)
        } else {
          await this.rememberIgnored(occupant.sessionId)
          this.ctx.logger.warn(
            `devlead: archived Session "${occupant.sessionId}" is ignored for admission; `
            + 'unarchive and open it to run /devlead off, or delete it',
          )
        }
        continue
      }
      if (this.ignoredArchived.has(occupant.sessionId)) {
        // The occupant was archived/ignored earlier; if it can still be
        // disabled, do so, otherwise keep it out of admission and let the
        // opening/reconciliation path handle it. It must not turn into a
        // permanent refusal for every future lead. Its hub index is dropped
        // when the tombstone is written, so it cannot supervise reports or
        // receive wakes while ignored.
        if (await this.releaseActiveOccupant(occupant, 'duplicate')) {
          await this.rememberReleased(occupant.sessionId)
        } else {
          await this.rememberIgnored(occupant.sessionId)
        }
        continue
      }
      blockers.push(occupant)
    }
    signal?.throwIfAborted()
    return blockers.length === 0 ? undefined : rankActiveSessions(blockers, this.activeSessionId)[0]
  }

  /**
   * Scan every live and persisted Session for an enabled DevLead mode.
   *
   * Live Sessions are authoritative directly from the projection handle. Cold
   * Sessions use the projection cache as a zero-I/O pre-filter: `active` rows
   * are folded exactly, `inactive` rows are skipped, and rows the cache cannot
   * classify (including a Host with no cache) are folded up to a bounded read
   * budget. The budget only limits an arbitrarily large unknown history and is
   * reported.
   *
   * `strict` makes the scan safe for admission: a corpus listing failure, or a
   * log read failure for a row the cache positively classified as active, is a
   * hard `DEVLEAD_SESSION_UNAVAILABLE` instead of a best-effort skip, because
   * admitting on an unverifiable corpus could create a second active lead.
   * Reconciliation and status remain best-effort.
   * @param signal - caller cancellation threaded through query reads.
   * @param includePersisted - whether the persisted corpus is scanned.
   * @param strict - whether unknown occupancy is a hard error (admission only).
   * @returns every enabled Session, deduplicated by id.
   * @throws {@link DevLeadError} `DEVLEAD_SESSION_UNAVAILABLE` when `strict` is
   *   set and a cache-positive candidate or the corpus listing cannot be read.
   */
  private async scanActiveSessions(
    signal?: AbortSignal,
    includePersisted = true,
    strict = false,
  ): Promise<DevLeadActiveSession[]> {
    const active = new Map<string, DevLeadActiveSession>()
    const seen = new Set<string>()
    const archived = new Set(
      (this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? []).map(id => String(id)),
    )
    /** Fold one live Session directly from its projection handle. */
    const addLive = (session: Session): void => {
      const sessionId = String(session.id)
      if (seen.has(sessionId)) return
      seen.add(sessionId)
      // Subagent Sessions are not lead candidates, matching the listing path.
      if (session.header.origin === 'subagent') return
      const state = this.projectionHandle.stateOf(session)
      if (state.failure !== null || !state.enabled) return
      const title = this.ctx.get('sessionTitle')?.get(session)?.title
      const agent = this.ctx.agents.get(session.id)
      active.set(sessionId, {
        sessionId,
        ...(title === undefined || title.trim().length === 0 ? {} : { title }),
        live: true,
        archived: archived.has(sessionId),
        running: agent?.status === 'running',
        createdAt: session.header.createdAt,
        enabledAt: 0,
      })
    }
    for (const agent of this.ctx.agents.list()) addLive(agent.session)
    for (const session of this.ctx.sessions.list()) addLive(session)
    signal?.throwIfAborted()
    if (!includePersisted) return [...active.values()]

    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return [...active.values()]
    let records: readonly PersistedSessionRecord[]
    try {
      records = await query.listSessions(signal)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      const detail = `could not verify global DevLead occupancy: listing persisted Sessions failed: ${thrownMessage(error)}`
      if (strict) throw new DevLeadError(detail, 'DEVLEAD_SESSION_UNAVAILABLE')
      this.ctx.logger.warn(`devlead: ${detail}`)
      return [...active.values()]
    }
    const cache = projectionCacheOf(this.ctx)
    let unknownReads = 0
    let capped = false
    let warnedRead = false
    for (const record of records) {
      signal?.throwIfAborted()
      const sessionId = String(record.header.id)
      if (seen.has(sessionId)) continue
      // A subagent Session is never a lead candidate. Skip it before the cache
      // pre-filter and the log read: a legacy fork may carry the parent's
      // plugin:devlead/mode/watch records in its inherited prefix, and those
      // records must not make it an occupant.
      if (record.header.origin === 'subagent') {
        seen.add(sessionId)
        continue
      }
      const prefilter = cache === undefined
        ? 'unknown'
        : devLeadActivePrefilterOf(cache, record.header)
      if (prefilter === 'inactive') {
        seen.add(sessionId)
        continue
      }
      if (prefilter === 'unknown') {
        if (unknownReads >= MAX_ACTIVE_SCAN_UNKNOWN_READS) {
          capped = true
          continue
        }
        unknownReads += 1
      }
      seen.add(sessionId)
      let events: readonly SessionEvent[]
      let inheritedEventCount = 0
      try {
        const snapshot = await query.readSession(record.header.id)
        events = snapshot.events
        inheritedEventCount = snapshot.inheritedEventCount
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        if (strict && prefilter === 'active') {
          throw new DevLeadError(
            `could not verify global DevLead occupancy: persisted Session "${sessionId}" `
            + `is cached as an active DevLead but its log could not be read: ${thrownMessage(error)}`,
            'DEVLEAD_SESSION_UNAVAILABLE',
          )
        }
        if (!warnedRead) {
          warnedRead = true
          this.ctx.logger.warn(`devlead: could not read a persisted Session log for global DevLead admission: ${thrownMessage(error)}`)
        }
        continue
      }
      // The query snapshot carries the exact fork-inherited prefix length. A
      // cold fold must start with it, exactly like the registered projection
      // unit initialized by the Session registry.
      let state = emptyDevLeadProjectionState(inheritedEventCount)
      for (const event of events) {
        state = applyDevLeadProjection(state, event)
        if (state.failure !== null) break
      }
      if (state.failure !== null || !state.enabled) continue
      active.set(sessionId, {
        sessionId,
        live: false,
        archived: archived.has(sessionId),
        running: false,
        createdAt: record.header.createdAt,
        enabledAt: lastEnabledAt(events) ?? 0,
      })
    }
    if (capped) {
      this.ctx.logger.warn(
        `devlead: global DevLead admission scanned only ${MAX_ACTIVE_SCAN_UNKNOWN_READS} unclassified persisted Session logs; `
        + 'compose projection cache rows to make the single-active check exhaustive',
      )
    }
    return [...active.values()]
  }

  /**
   * Durably disable one active occupant so the global slot becomes free.
   *
   * A live Session (or Agent-owned Session) is appended directly. A cold
   * Session is resumed through the optional Session controller first; without
   * that capability the release fails softly and the caller reports the
   * occupant, rather than clearing a durable mode the Host cannot rewrite.
   * @param occupant - active Session to disable.
   * @param reason - `archived` or `duplicate`, recorded in the warning.
   * @returns whether the durable mode is now off (or already was).
   */
  private async releaseActiveOccupant(
    occupant: DevLeadActiveSession,
    reason: 'archived' | 'duplicate',
  ): Promise<boolean> {
    let session = this.ctx.sessions.get(toSessionId(occupant.sessionId))
    if (session === undefined) {
      const controller = this.ctx.get('sessionController')
      if (controller === undefined) {
        this.ctx.logger.warn(
          `devlead: Session "${occupant.sessionId}" still holds DevLead mode but is cold and no Session controller can resume it to release the slot`,
        )
        return false
      }
      try {
        const resolved = await controller.resolveAgent(toSessionId(occupant.sessionId))
        if ('error' in resolved) {
          this.ctx.logger.warn(
            `devlead: could not resume DevLead occupant "${occupant.sessionId}" to release the slot: ${resolved.error.message}`,
          )
          return false
        }
        session = resolved.agent.session
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `devlead: could not resume DevLead occupant "${occupant.sessionId}" to release the slot: ${thrownMessage(error)}`,
        )
        return false
      }
    }
    try {
      const state = this.projectionHandle.stateOf(session)
      if (state.failure !== null) {
        this.ctx.logger.warn(
          `devlead: cannot release DevLead occupant "${occupant.sessionId}": its projection is damaged (${state.failure})`,
        )
        return false
      }
      if (state.enabled) {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(false, Date.now()))
        await this.flushDurably(session, `DevLead release for Session "${occupant.sessionId}"`)
        await this.checkpointProjectionCache(session, `DevLead release for Session "${occupant.sessionId}"`)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `devlead: could not release DevLead occupant "${occupant.sessionId}": ${thrownMessage(error)}`,
      )
      return false
    }
    if (this.activeSessionId === occupant.sessionId) this.activeSessionId = undefined
    this.ctx.logger.warn(
      `devlead: disabled DevLead mode for Session "${occupant.sessionId}" (${reason}); `
      + 'only one Session may hold DevLead mode at a time',
    )
    await this.rememberReleased(occupant.sessionId)
    return true
  }

  /** Remember one ignored archived holder in memory and, when available, durably. */
  private async rememberIgnored(sessionId: string): Promise<void> {
    this.ignoredArchived.add(sessionId)
    // An ignored holder is not a lead for routing purposes either: drop its
    // hub runtime so it cannot supervise reports or receive wakes while the
    // tombstone is in force. Opening it later re-indexes the live Agent.
    this.hub?.forgetLead(sessionId)
    await this.outbox?.rememberIgnored(sessionId)
  }

  /** Forget one ignored-holder tombstone after a successful release. */
  private async rememberReleased(sessionId: string): Promise<void> {
    if (!this.ignoredArchived.delete(sessionId)) return
    await this.outbox?.forgetIgnored(sessionId)
  }

  /**
   * Reconcile a Host that already has (or has recovered) multiple enabled
   * Sessions.
   *
   * Archived holders are released first. The remaining occupants are ranked
   * deterministically; the preferred/live/newest one stays enabled and every
   * other is durably disabled with a warning. If a cold holder cannot be
   * resumed, it is left enabled and keeps blocking new admissions, which is
   * safer than silently creating a second active Session.
   * @param preferredSessionId - incumbent to keep when it is still active.
   */
  private async reconcileActiveSessions(
    preferredSessionId?: string,
    options: {
      readonly includePersisted?: boolean
      readonly knownActive?: readonly DevLeadActiveSession[]
    } = {},
  ): Promise<void> {
    if (this.disposed) return
    try {
      await this.withAdmission(async () => {
        if (this.disposed) return
        const scanned = await this.scanActiveSessions(undefined, options.includePersisted !== false)
        // Merge the cold Sessions the rehydration scan already read (no second
        // query/cache pass) with the live projection pass. A live Session is
        // authoritative even when it is now disabled, so its known-cold entry
        // is dropped rather than resurrected from the earlier snapshot.
        const merged = new Map<string, DevLeadActiveSession>()
        for (const occupant of options.knownActive ?? []) merged.set(occupant.sessionId, occupant)
        for (const occupant of scanned) merged.set(occupant.sessionId, occupant)
        const liveIds = new Set<string>()
        for (const agent of this.ctx.agents.list()) liveIds.add(String(agent.id))
        for (const session of this.ctx.sessions.list()) liveIds.add(String(session.id))
        for (const sessionId of liveIds) {
          if (!scanned.some(occupant => occupant.sessionId === sessionId)) merged.delete(sessionId)
        }
        const active = [...merged.values()]
        if (active.length === 0) {
          this.activeSessionId = undefined
          return
        }
        const remaining: DevLeadActiveSession[] = []
        for (const occupant of active) {
          if (occupant.archived) {
            if (!(await this.releaseActiveOccupant(occupant, 'archived'))) {
              await this.rememberIgnored(occupant.sessionId)
              this.ctx.logger.warn(
                `devlead: archived Session "${occupant.sessionId}" still has DevLead mode enabled but is ignored for admission; `
                + 'unarchive and open it to run /devlead off, or delete it',
              )
            }
            continue
          }
          if (this.ignoredArchived.has(occupant.sessionId)) {
            if (await this.releaseActiveOccupant(occupant, 'duplicate')) {
              await this.rememberReleased(occupant.sessionId)
            } else {
              await this.rememberIgnored(occupant.sessionId)
            }
            continue
          }
          remaining.push(occupant)
        }
        if (remaining.length === 0) {
          this.activeSessionId = undefined
          return
        }
        const ranked = rankActiveSessions(remaining, preferredSessionId ?? this.activeSessionId)
        const keeper = ranked[0]
        if (keeper === undefined) return
        this.activeSessionId = keeper.sessionId
        let failed = 0
        for (const extra of ranked.slice(1)) {
          if (!(await this.releaseActiveOccupant(extra, 'duplicate'))) failed += 1
        }
        if (ranked.length > 1) {
          this.ctx.logger.warn(
            `devlead: found ${ranked.length} enabled Sessions after recovery; keeping "${keeper.sessionId}"`
            + (failed > 0 ? ` and could not disable ${failed}` : ''),
          )
        }
      })
    } catch (error: unknown) {
      if (!this.disposed) {
        this.ctx.logger.warn(`devlead: global DevLead admission reconciliation failed: ${thrownMessage(error)}`)
      }
    }
  }

  /** Reject any use of a tool surface while DevLead mode is off. */
  private assertReady(agent: Agent): void {
    this.assertLive(agent)
    if (!this.isEnabled(agent)) {
      throw new DevLeadError(
        'DevLead mode is not enabled for this Session; turn it on with /devlead on',
        'DEVLEAD_NOT_ENABLED',
      )
    }
  }

  /** Read the current projection state, rejecting a corrupt replay. */
  private strictStateOf(session: Session): DevLeadProjectionState {
    const state = this.projectionHandle.stateOf(session)
    if (state.failure !== null) throw new DevLeadError(state.failure, 'DEVLEAD_PROJECTION_INVALID')
    return state
  }

  /**
   * Collect the attach-only leads of the current Session store: a live Session
   * whose log is attached but which has no Agent. Its projection can be folded
   * without any corpus I/O, so this fallback is available immediately even
   * before the persistence binding is ready.
   * @returns one persisted lead record per attach-only lead Session.
   */
  private liveAttachLeads(): DevLeadPersistedLead[] {
    const leads: DevLeadPersistedLead[] = []
    for (const session of this.ctx.sessions.list()) {
      if (this.ctx.agents.get(session.id) !== undefined) continue
      if (session.header.origin === 'subagent') continue
      const state = this.projectionHandle.stateOf(session)
      if (state.failure !== null) continue
      const sessionId = String(session.id)
      if (state.enabled && state.sessions.length > 0) leads.push({ sessionId, watched: [...state.sessions] })
    }
    return leads
  }

  /**
   * Scan durable state for lead Sessions the hub must index after a restart.
   *
   * Only called with `scanPersisted: true` once both the Session query engine
   * and the optional Session persistence service are composed; otherwise only
   * the live-attach fallback runs.
   *
   * Cheap sources first: a live Session without an Agent has its projection
   * folded directly (attach-only leads), then the persisted corpus is filtered
   * through the projection cache — a row that positively reports an enabled mode
   * with a non-empty watch set is a candidate, a disabled/empty row is skipped
   * without reading its log, and only unclassified rows pay for a complete
   * full-log exact fold (bounded, because a Host history is unbounded).
   * A corrupt replay skips that candidate with one warning; it must never stop
   * the scan, and it must never make the plugin fail to load.
   * @returns one persisted lead record per recovered lead Session.
   */
  private async persistedLeadRecords(
    scanPersisted: boolean,
  ): Promise<{ readonly leads: DevLeadPersistedLead[]; readonly active: DevLeadActiveSession[] }> {
    const leads = new Map<string, readonly string[]>()
    const active: DevLeadActiveSession[] = []
    const archived = new Set(
      (this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? []).map(id => String(id)),
    )
    const remember = (sessionId: string, sessions: readonly string[]): void => {
      if (sessionId.length === 0 || sessions.length === 0) return
      leads.set(sessionId, [...sessions])
    }
    const result = (): { readonly leads: DevLeadPersistedLead[]; readonly active: DevLeadActiveSession[] } => ({
      leads: [...leads].map(([sessionId, watched]) => ({ sessionId, watched })),
      active,
    })
    for (const lead of this.liveAttachLeads()) remember(lead.sessionId, lead.watched)
    if (!scanPersisted) {
      // Live-attach fallback only: without the optional persistence binding the
      // query engine cannot list a persisted corpus, so a cold scan would read
      // nothing and must not burn the unknown-read budget.
      if (this.ctx.get('sessionQuery') === undefined) {
        this.ctx.logger.debug('devlead: no Session query engine is composed; cold lead rehydration scans live Sessions only')
      }
      else {
        this.ctx.logger.debug(
          'devlead: the Session persistence binding is not composed yet; cold lead rehydration scans live Sessions only',
        )
      }
      return result()
    }
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return result()
    const cache = projectionCacheOf(this.ctx)
    if (cache === undefined) {
      this.ctx.logger.warn(
        'devlead: this Host composes no Session projection cache, so cold lead rehydration reads no persisted logs; '
        + 'only live lead Sessions are rehydrated',
      )
      return result()
    }
    let records: PersistedSessionRecord[]
    try {
      records = await query.listSessions()
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not list persisted Sessions for cold lead rehydration: ${thrownMessage(error)}`)
      return result()
    }
    let unknownReads = 0
    let capped = false
    let warnedCorrupt = false
    let warnedRead = false
    for (const record of records) {
      const sessionId = String(record.header.id)
      if (leads.has(sessionId) || record.live) continue
      if (record.header.origin === 'subagent') continue
      // Occupancy needs enabled-with-empty-watch too, so use the active
      // verdict rather than the lead-indexing one that deliberately skips it.
      const prefilter = devLeadActivePrefilterOf(cache, record.header)
      if (prefilter === 'inactive') continue
      if (prefilter === 'unknown') {
        if (unknownReads >= MAX_COLD_LEAD_LOG_READS) {
          capped = true
          continue
        }
        unknownReads += 1
      }
      let events: readonly SessionEvent[]
      let inheritedEventCount = 0
      try {
        const snapshot = await query.readSession(record.header.id)
        events = snapshot.events
        inheritedEventCount = snapshot.inheritedEventCount
      } catch (error: unknown) {
        if (!warnedRead) {
          warnedRead = true
          this.ctx.logger.warn(`devlead: could not read a cold lead candidate Session log: ${thrownMessage(error)}`)
        }
        continue
      }
      let state = emptyDevLeadProjectionState(inheritedEventCount)
      for (const event of events) {
        state = applyDevLeadProjection(state, event)
        if (state.failure !== null) break
      }
      if (state.failure !== null) {
        if (!warnedCorrupt) {
          warnedCorrupt = true
          this.ctx.logger.warn(`devlead: skipping a cold lead candidate with a corrupt DevLead replay: ${state.failure}`)
        }
        continue
      }
      if (!state.enabled) continue
      active.push({
        sessionId,
        live: false,
        archived: archived.has(sessionId),
        running: false,
        createdAt: record.header.createdAt,
        enabledAt: lastEnabledAt(events) ?? 0,
      })
      remember(sessionId, state.sessions)
    }
    if (capped) {
      this.ctx.logger.warn(
        `devlead: cold lead rehydration stopped reading unclassified Session logs after ${MAX_COLD_LEAD_LOG_READS}; `
        + 'compose projection cache rows to restore leads beyond that bound',
      )
    }
    return result()
  }

  /**
   * Validate one requested model selection against the Host's LLM registry.
   * @param selection - normalized provider/model/effort selection.
   * @param signal - cancellation checked around the adapter lookup.
   * @throws {@link DevLeadError} `DEVLEAD_MODEL_UNAVAILABLE` when the Host
   *   composes no validator or the adapter rejects the route/effort.
   */
  private async assertModelSelectable(
    selection: NormalizedModelSelection,
    signal?: AbortSignal,
  ): Promise<void> {
    const validator = modelValidatorOf(this.ctx)
    if (validator === undefined) {
      throw new DevLeadError(
        `cannot validate model "${modelSelectionLabel(selection)}": this Host composes no LLM registry. `
        + 'Call devlead_list_models to see available providers, models, and reasoning efforts',
        'DEVLEAD_MODEL_UNAVAILABLE',
      )
    }
    try {
      // Mirror the Session controller's selectModel validation without its
      // profile-default side effect: the provider must be registered, the
      // model must be in that provider's current catalog, and the effort must
      // be supported by the resolved capability. A provider whose model list
      // is unavailable (for example no credentials) rejects here instead of
      // producing a Session that is pinned to an unverified route.
      if (!validator.listProviders().some(provider => provider.id === selection.provider)) {
        throw new Error(`provider "${selection.provider}" is not registered`)
      }
      const models = await validator.listModels(selection.provider)
      if (!models.some(model => model.id === selection.model)) {
        throw new Error(`model "${selection.model}" is not in provider "${selection.provider}"'s available model list`)
      }
      await validator.resolveCallConfig(selection, signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new DevLeadError(
        `model "${modelSelectionLabel(selection)}" is not available: ${thrownMessage(error)}. `
        + 'Call devlead_list_models to see available providers, models, and reasoning efforts',
        'DEVLEAD_MODEL_UNAVAILABLE',
      )
    }
    signal?.throwIfAborted()
  }

  /**
   * Apply creation-time dispatch settings to a freshly created Session.
   *
   * The settings are recorded on the child Agent itself: the model through
   * `agent.model.select` (durable Session-level event, never the profile
   * default), and Team mode through the optional Team service. A failure here
   * happens after the Session exists, so the error names its id and the Session
   * is deliberately left in place (the service's creation contract does not
   * roll back side effects).
   * @param created - the controller's create result.
   * @param model - normalized model selection, when requested.
   * @param teamsRequested - requested Team mode, when explicitly set.
   * @param teams - detected Team capability, when one is composed.
   * @param signal - cancellation checked between applications.
   * @returns the settings that were actually applied.
   * @throws {@link DevLeadError} with the created Session id in the message when
   *   the Agent is not live or an application step fails.
   */
  private async applyDispatchSettings(
    created: SessionCreateValue,
    model: NormalizedModelSelection | undefined,
    teamsRequested: boolean | undefined,
    teams: AgentTeamsCapability | undefined,
    signal?: AbortSignal,
  ): Promise<{ model?: DevLeadModelSelection; agentTeams?: boolean }> {
    if (model === undefined && teamsRequested === undefined) return {}
    const sessionId = String(created.sessionId)
    const child = this.ctx.agents.get(created.sessionId)
    if (child === undefined) {
      throw new DevLeadError(
        `Session "${sessionId}" was created but its Agent is not live, so the requested dispatch settings `
        + 'could not be applied; the Session remains and can be continued',
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    const applied: { model?: DevLeadModelSelection; agentTeams?: boolean } = {}
    if (model !== undefined) {
      try {
        child.model.select({
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }),
        })
      } catch (error: unknown) {
        signal?.throwIfAborted()
        throw new DevLeadError(
          `Session "${sessionId}" was created but model "${modelSelectionLabel(model)}" could not be applied; `
          + `the Session remains: ${thrownMessage(error)}. `
          + 'Call devlead_list_models to see available providers, models, and reasoning efforts',
          'DEVLEAD_MODEL_UNAVAILABLE',
        )
      }
      await this.flushDurably(child.session, `model selection for Session "${sessionId}"`)
      applied.model = { ...model }
    }
    if (teamsRequested !== undefined) {
      if (teamsRequested === true && teams === undefined) {
        throw new DevLeadError(
          `Session "${sessionId}" was created but this Host composes no Agent Teams service, `
          + 'so agent_teams could not be enabled; the Session remains. Agent Teams is available '
          + 'from DSH 0.2.2-rc.2 (included in the default composition there)',
          'DEVLEAD_TEAM_UNAVAILABLE',
        )
      }
      if (teams !== undefined) {
        try {
          await teams.setEnabled(child, teamsRequested, signal)
        } catch (error: unknown) {
          signal?.throwIfAborted()
          throw new DevLeadError(
            `Session "${sessionId}" was created but Agent Teams could not be `
            + `${teamsRequested ? 'enabled' : 'disabled'}; the Session remains: ${thrownMessage(error)}`,
            'DEVLEAD_TEAM_UNAVAILABLE',
          )
        }
      }
      applied.agentTeams = teamsRequested
    }
    signal?.throwIfAborted()
    return applied
  }

  /** Require the Workspace registry capability (Workspaces and Session archive state). */
  private requireWorkspaceRegistry(): WorkspaceRegistry {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      throw new DevLeadError(
        'this Host composes no Workspace registry, so Workspaces and archived Sessions cannot be managed',
        'DEVLEAD_WORKSPACE_NOT_FOUND',
      )
    }
    return registry
  }

  /**
   * Build the read-side dependency bundle for one live lead Agent.
   * @param agent - exact live lead Agent.
   * @param signal - optional cancellation threaded into every read.
   * @returns the view dependencies.
   */
  private viewDeps(agent: Agent, signal?: AbortSignal): DevLeadViewDeps {
    const state = this.strictStateOf(agent.session)
    const watched = new Set(state.sessions)
    return {
      ctx: this.ctx,
      maxListedSessions: this.resolved.maxListedSessions,
      watchedSessions: state.sessions,
      isWatched: sessionId => watched.has(sessionId),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  /**
   * Resolve the Workspace one created Session should join: the requested
   * reference, or the lead's own directory registered on demand.
   * @param agent - exact live lead Agent.
   * @param reference - requested Workspace id, registered path, or exact title.
   * @returns the target Workspace.
   */
  private async createTargetWorkspace(agent: Agent, reference: string | undefined): Promise<Workspace> {
    if (reference !== undefined && reference.trim().length > 0) {
      return await resolveWorkspaceReference(this.ctx, reference)
    }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      throw new DevLeadError(
        'this lead Session records no working directory; name a Workspace or path explicitly',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    const registry = this.requireWorkspaceRegistry()
    // resolveByPath rejects a missing directory even when a record exists, so a
    // moved/deleted directory is matched through the registry order instead.
    const byPath = await registry.resolveByPath(cwd).catch(() => undefined)
    if (byPath !== undefined) return byPath
    const recorded = registry.list().find(workspace => workspace.path === cwd)
    if (recorded !== undefined) return recorded
    try {
      return await registry.create(cwd)
    } catch (error: unknown) {
      // The lead's own directory cannot be created implicitly: a moved or
      // unreadable directory must surface as a stable domain failure, not as a
      // raw `fs` rejection from the registry.
      const failure = workspacePathFailure(error, cwd)
      throw new DevLeadError(
        `the lead Session's working directory "${cwd}" is not usable: ${thrownMessage(error)}; `
        + 'name a Workspace or path explicitly',
        failure.code,
      )
    }
  }

  /**
   * Attempt the checkout isolation requested for a freshly created Session.
   *
   * Isolation is best effort and never fails the creation call: a missing or
   * malformed capability, a Session that is not live, and a rejected creation
   * are all reported in the result, leaving the Session usable in its Workspace
   * checkout. Cancellation is the only throwing path, and it wins over a
   * reported failure so an aborted call is not misreported as a worktree
   * failure.
   * @param sessionId - freshly created Session identity.
   * @param mode - requested isolation mode; `none` never touches the capability.
   * @param signal - cancellation checked before the attempt and threaded into
   *   the worktree creation.
   * @returns the isolation outcome.
   */
  private async isolateSession(
    sessionId: ReturnType<typeof toSessionId>,
    mode: DevLeadIsolationMode,
    signal?: AbortSignal,
  ): Promise<DevLeadIsolation> {
    if (mode !== 'worktree') return { requested: 'none', status: 'none' }
    signal?.throwIfAborted()
    const capability = worktreeCapabilityOf(this.ctx)
    if (capability === undefined) {
      return {
        requested: 'worktree',
        status: 'unavailable',
        reason: 'this Host composes no Git worktree service, so the Session stays in its Workspace checkout',
      }
    }
    // The worktree service changes the CALLING Agent's working directory, so the
    // new child Agent must own the call: the lead (or any other Agent) would
    // move the wrong Session. A Session that is already cold has no such Agent
    // and stays in its Workspace checkout.
    const child = this.ctx.agents.get(sessionId)
    if (child === undefined) {
      return {
        requested: 'worktree',
        status: 'unavailable',
        reason: `Session "${String(sessionId)}" is not live, so no worktree can be created for it`,
      }
    }
    try {
      const created = await capability.create(child, {}, signal)
      // Cancellation observed while Git worked wins over a malformed result,
      // exactly as it does over a rejected creation.
      signal?.throwIfAborted()
      const checkout = worktreeCheckoutOf(created)
      if (checkout === undefined) {
        this.ctx.logger.warn(
          `devlead: the Git worktree service returned an unusable checkout for Session "${String(sessionId)}"`,
        )
        return {
          requested: 'worktree',
          status: 'failed',
          reason: 'the Git worktree service returned an unusable checkout',
        }
      }
      return {
        requested: 'worktree',
        status: 'worktree',
        path: checkout.path,
        branch: checkout.branch,
        baseCommit: checkout.baseCommit,
      }
    } catch (error: unknown) {
      // A cancellation observed while Git worked must reject the call, not be
      // reported as a failure the Session survived.
      signal?.throwIfAborted()
      this.ctx.logger.warn(
        `devlead: could not create a Git worktree for Session "${String(sessionId)}": ${thrownMessage(error)}`,
      )
      return { requested: 'worktree', status: 'failed', reason: thrownMessage(error) }
    }
  }

  /** Rename a freshly created Session, logging a failure instead of aborting creation. */
  private tryRename(sessionId: ReturnType<typeof toSessionId>, title: string): void {
    const titles = this.ctx.get('sessionTitle')
    const session = this.ctx.sessions.get(sessionId)
    if (titles === undefined || session === undefined) return
    try {
      titles.rename(session, title)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: Session "${sessionId}" was not renamed: ${thrownMessage(error)}`)
    }
  }

  /** Map one Session-controller failure to the stable DevLead vocabulary. */
  private sessionUnavailable(message: string, error: unknown): DevLeadError {
    const code = remoteCodeOf(error)
    if (code === 'session/not-found') return new DevLeadError(message, 'DEVLEAD_SESSION_NOT_FOUND')
    return new DevLeadError(message, 'DEVLEAD_SESSION_UNAVAILABLE')
  }

  /**
   * Map one Workspace-registry archive failure to the stable DevLead
   * vocabulary.
   * @param sessionId - Session identity the archive addressed.
   * @param error - failure thrown by `workspaceRegistry.archiveSession`.
   * @returns the mapped domain failure, or undefined for an infrastructure
   *   failure the caller rethrows unchanged.
   */
  private archiveFailure(sessionId: string, error: unknown): DevLeadError | undefined {
    if (isActiveSessionFailure(error)) {
      return new DevLeadError(
        `Session "${sessionId}" is still active (${describeSessionActivity(error.activity)}); `
        + 'stop that work first, or retry with stop_running: true to archive it and ask the Host to stop it now',
        'DEVLEAD_SESSION_ACTIVE',
      )
    }
    if (isUnknownSessionFailure(error)) {
      return new DevLeadError(
        `no Session matches "${sessionId}"; it may have disappeared since it was resolved`,
        'DEVLEAD_SESSION_NOT_FOUND',
      )
    }
    return undefined
  }

  /**
   * Admit one lead-authored prompt into a Session, resuming a cold Session and
   * dispatching the primitive the policy plan selected.
   *
   * `interrupt` is evaluated only against a live running Agent. The Host's
   * `workspace/session-stop` providers are the same fan-out archive
   * `stopActivity` uses; they cancel the turn and stop the Session's reported
   * subagent/job/schedule work. The stop is fire-and-forget: the replacement
   * prompt is admitted immediately afterwards, and the Agent reclassifies a
   * wake after an aborted phase to the next turn and latches it until the
   * aborted activity converges, so the prompt cannot enter the cancelling turn.
   * The inbox retention restore is best-effort. A `clear-all` stop discards the
   * pending answers it actually removed (recording them discarded so their
   * questions reopen); an answer the stop left pending is not discarded.
   * `keep`/`clear-own` retain pending answers. A new answer to an OPEN question
   * discards a stale pending answer message of that question; it cannot replace
   * an active answer (the policy rejects a different answer to an answered
   * question before admission — use `clear-all` to discard and reopen).
   *
   * The result's `boundary` reflects where the message actually landed: DSH may
   * reclassify a waking steer to next-turn on an aborted phase, so the inbox is
   * inspected after admission rather than trusting the plan alone.
   * @param leadAgent - exact live lead Agent.
   * @param sessionId - target Session identity.
   * @param text - non-empty prompt text.
   * @param options - resume/interrupt policy, the policy plan, the intent and
   *   answer/idempotency metadata, and cancellation checked before each stage.
   * @returns the admission outcome including the delivery receipt.
   */
  private async admitPrompt(
    leadAgent: Agent,
    sessionId: ReturnType<typeof toSessionId>,
    text: string,
    options: {
      allowResume: boolean
      interrupt: boolean
      interruptInbox: DevLeadInterruptInboxPolicy
      signal: AbortSignal | undefined
      plan: PlannedDelivery
      intent: DevLeadPromptIntent
      questionId?: string
      idempotencyKey?: string
    },
  ): Promise<PromptAdmission> {
    const signal = options.signal
    signal?.throwIfAborted()
    let target = this.ctx.agents.get(sessionId)
    let resumed = false
    if (target === undefined) {
      if (!options.allowResume) {
        throw new DevLeadError(`Session "${sessionId}" is not live`, 'DEVLEAD_SESSION_UNAVAILABLE')
      }
      const controller = this.ctx.get('sessionController')
      if (controller === undefined) {
        throw new DevLeadError(
          `Session "${sessionId}" is not live and this Host composes no Session activator`,
          'DEVLEAD_SESSION_UNAVAILABLE',
        )
      }
      try {
        const resolved = await controller.resolveAgent(sessionId)
        if ('error' in resolved) {
          throw this.sessionUnavailable(
            `could not resume Session "${sessionId}": ${resolved.error.message}`,
            resolved.error,
          )
        }
        target = resolved.agent
        resumed = true
      } catch (error: unknown) {
        if (error instanceof DevLeadError) throw error
        throw new DevLeadError(
          `could not resume Session "${sessionId}": ${thrownMessage(error)}`,
          'DEVLEAD_SESSION_UNAVAILABLE',
        )
      }
      // A cancellation observed while the Host resumed the Session must not
      // admit the prompt (or be misreported as an unavailable Session).
      signal?.throwIfAborted()
    }
    signal?.throwIfAborted()
    const leadId = String(leadAgent.id)
    const targetId = String(sessionId)
    let interrupted = false
    let retainedInputs: number | undefined
    const clearsAll = options.interrupt && options.interruptInbox === 'clear-all'
    // Snapshot the pending answers a clear-all stop is about to discard, so
    // their questions can be reopened with a durable discard record.
    const answersBeforeClear = clearsAll && target.status === 'running' ? pendingAnswersOf(target) : []
    if (options.interrupt && target.status === 'running') {
      // This is the last cancellation point: once the stop providers are asked
      // to cancel the child, the replacement prompt is committed with the stop
      // rather than leaving a stopped Session without its new instruction.
      interrupted = true
      // The stop providers always clear the inbox, so a retention policy is a
      // snapshot before the stop and a restore of the same identified messages
      // after it — never a veto of the stop itself. Suppress the discard
      // listener for this target across the stop+restore window so a restored
      // answer is not reopened by the Host's clear-time discard events.
      const kept = keptInputsOf(target, leadId, options.interruptInbox)
      this.interrupting.add(targetId)
      try {
        await this.stopSessionActivity(sessionId)
        if (options.interruptInbox !== 'clear-all') {
          try {
            retainedInputs = restoreInputs(target, kept)
          } catch (error: unknown) {
            // The stop is already committed, so a failed restore must not strand
            // the replacement prompt (or trigger the caller's watch rollback).
            // The cancelled work is lost, but the new instruction still runs.
            this.ctx.logger.warn(
              `devlead: could not restore queued input for Session "${sessionId}" after the interrupt: `
              + thrownMessage(error),
            )
          }
        }
      } finally {
        this.interrupting.delete(targetId)
      }
    }
    if (interrupted && clearsAll) {
      // Only discard answers the stop actually removed. A stop provider that
      // failed or did not clear the inbox leaves the answer pending, so it must
      // not be marked discarded (its question stays answered).
      const stillPending = new Set(locatedInputs(target).map(entry => String(entry.message.id)))
      for (const pending of answersBeforeClear) {
        if (pending.senderSessionId !== leadId) continue
        if (stillPending.has(String(pending.message.id))) continue
        this.discardPendingAnswer(targetId, pending.message.id, pending.questionId, leadId)
      }
    }
    // Replacement edge: an OPEN question may still carry a stale pending answer
    // message (for example one a keep/clear-own restore brought back after a
    // reopen). A new answer to that open question discards the stale message so
    // two answers never coexist. This does NOT bypass the answered-question
    // guard: an active pending answer makes the question answered, and the
    // policy rejects a different new answer (or replays an idempotent retry)
    // before admission ever reaches here — interrupt+answer cannot replace an
    // active answer; use interrupt_inbox:"clear-all" to discard it and reopen.
    if (options.intent === 'answer' && options.questionId !== undefined) {
      for (const pending of pendingAnswersOf(target)) {
        if (pending.questionId !== options.questionId || pending.senderSessionId !== leadId) continue
        // Remove first: the discard derivation refuses messages still pending
        // in the child inbox (a survival guard against stale cancellations).
        target.inbox.remove(pending.message.id)
        this.discardPendingAnswer(targetId, pending.message.id, pending.questionId, leadId)
      }
    }
    const message = options.intent === 'background'
      ? createDevLeadBackgroundMessage(text, leadAgent)
      : createDevLeadPromptMessage(
        options.intent === 'answer' && options.questionId !== undefined
          ? `[DEV LEAD ANSWER to question ${options.questionId}]\n${text}`
          : text,
        leadAgent,
        {
          intent: options.intent === 'answer' ? 'answer' : options.intent === 'correction' ? 'correction' : 'instruction',
          ...(options.questionId === undefined ? {} : { questionId: options.questionId }),
          ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
        },
      )
    try {
      switch (options.plan.primitive) {
        case 'steer':
          target.steer(message)
          break
        case 'inject':
          target.inject(message)
          break
        default:
          target.followup(message)
          break
      }
    } catch (error: unknown) {
      const detail = `could not admit a prompt into Session "${sessionId}": ${thrownMessage(error)}`
      if (interrupted) {
        throw new DevLeadInterruptedAdmissionError(
          `${detail}; the running work was already asked to stop, so the Session keeps its watch — retry the prompt`,
        )
      }
      throw new DevLeadError(detail, 'DEVLEAD_SESSION_UNAVAILABLE')
    }
    await this.flushDurably(target.session, `prompt into Session "${sessionId}"`)
    const messageId = String(message.id)
    // Report the boundary the message actually occupies: a waking steer admitted
    // on an aborted phase is reclassified to next-turn by DSH.
    const boundary = target.inbox.nextStep.some(entry => String(entry.id) === messageId)
      ? 'next-step'
      : target.inbox.nextTurn.some(entry => String(entry.id) === messageId)
        ? 'next-turn'
        : options.plan.boundary
    return {
      resumed,
      interrupted,
      ...(retainedInputs === undefined ? {} : { retainedInputs }),
      delivery: {
        primitive: options.plan.primitive,
        boundary,
        wakeRequested: options.plan.wakeRequested,
        messageId,
      },
    }
  }

  /**
   * Serialize one target's prompt admission stages behind any in-flight call
   * for the same target, so concurrent calls land in the child inbox in call
   * order. The chain never rejects (a failed call must not strand the next).
   * @param targetId - exact target Session identity.
   * @param body - the admission stages to run exclusively for this target.
   * @returns the body's result.
   */
  private async withTargetAdmission<T>(targetId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.promptTails.get(targetId) ?? Promise.resolve()
    const run = previous.then(() => body())
    const tail = run.then(() => undefined, () => undefined)
    this.promptTails.set(targetId, tail)
    try {
      return await run
    } finally {
      if (this.promptTails.get(targetId) === tail) this.promptTails.delete(targetId)
    }
  }

  /**
   * Map one policy rejection to the stable DevLead error vocabulary.
   * @param reason - the policy's rejection reason.
   * @param targetId - target Session identity used in the message.
   * @param questionId - question identity for the answer-specific rejections.
   * @param agent - calling lead Agent, used to read the existing answer excerpt.
   * @returns the domain failure to throw.
   */
  private deliveryRejectionError(
    reason: DeliveryRejectionReason,
    targetId: string,
    questionId: string | undefined,
    agent: Agent,
  ): DevLeadError {
    switch (reason) {
      case 'answer-question-id-required':
        return new DevLeadError(
          'intent "answer" requires question_id; name the question report this prompt answers',
          'DEVLEAD_INVALID_INPUT',
        )
      case 'question-id-not-allowed':
        return new DevLeadError(
          'question_id is only valid with intent "answer"; use intent "answer" to reply to a question',
          'DEVLEAD_INVALID_INPUT',
        )
      case 'background-question-id':
        return new DevLeadError(
          'background context cannot answer a question; use intent "answer" with question_id',
          'DEVLEAD_INVALID_INPUT',
        )
      case 'background-interrupt':
        return new DevLeadError(
          'background context cannot interrupt the Session\'s work; use instruction or correction to replace it',
          'DEVLEAD_INVALID_INPUT',
        )
      case 'question-not-found':
        return new DevLeadError(
          `no question report "${questionId ?? ''}" addressed to this lead from Session "${targetId}" was found; `
          + 'it may have been answered and aged out, expired, or cancelled — read devlead_notifications, '
          + 'or continue the Session with a normal instruction',
          'DEVLEAD_QUESTION_NOT_FOUND',
        )
      case 'question-not-open':
        return new DevLeadError(
          `question "${questionId ?? ''}" is expired or cancelled and no longer accepts an answer; `
          + 'continue the Session with a normal instruction instead',
          'DEVLEAD_QUESTION_NOT_FOUND',
        )
      case 'question-already-answered': {
        const excerpt = this.latestAnswerFact(agent, questionId ?? '')?.textExcerpt
        return new DevLeadError(
          `question "${questionId ?? ''}" was already answered${excerpt === undefined ? '' : ` ("${excerpt}")`}; `
          + 'a different answer is a conflict — resend the same answer text/idempotency_key for an idempotent retry, '
          + 'or send a correction/instruction without question_id to change direction',
          'DEVLEAD_QUESTION_ALREADY_ANSWERED',
        )
      }
      case 'target-archived':
        return new DevLeadError(
          `Session "${targetId}" is archived; restore it from the Workspace sidebar before continuing it`,
          'DEVLEAD_SESSION_ARCHIVED',
        )
      case 'background-cold-target':
        return new DevLeadError(
          `Session "${targetId}" is cold and background context does not resume a Session; `
          + 'use intent "instruction" to resume and prompt it',
          'DEVLEAD_INVALID_INPUT',
        )
    }
  }

  /**
   * Resolve the newest answer fact of one question by merging the durable audit
   * (authoritative for which answer is latest and whether it was discarded) with
   * the in-memory inbox observation (which only advances an admitted answer to
   * claimed/presented). This is never unconditional memory-first: a durable
   * discard reopens the question even if a stale memory entry still says
   * admitted, and a newer durable re-answer replaces an older memory entry, so a
   * restart restores the exact durable state.
   * @param agent - exact live lead Agent.
   * @param reportId - question report identity.
   * @returns the newest merged answer record, or undefined when unanswered.
   */
  private resolvedAnswer(agent: Agent, reportId: string): DevLeadReportAnswer | undefined {
    const leadId = String(agent.id)
    const record = latestAnswerOf(this.strictStateOf(agent.session).answers, reportId)
    const entry = this.answers.entryOfQuestion(leadId, reportId)
    if (record === undefined) return entry === undefined ? undefined : recordOfEntry(entry)
    if (entry === undefined) return record
    if (entry.messageId !== record.messageId) {
      // Different answer messages: the higher admission sequence wins — never
      // the lifecycle `at`, which a late claim/presentation/discard of an older
      // answer advances past a newer re-answer. A legacy tie (both records
      // predate the sequence) falls back to admission instants, and a remaining
      // tie keeps the durable record (the append-only audit is authoritative).
      const recordSeq = record.answerSeq ?? 0
      if (entry.answerSeq !== recordSeq) return entry.answerSeq > recordSeq ? recordOfEntry(entry) : record
      return entry.firstAdmittedAt > admittedAtOf(record) ? recordOfEntry(entry) : record
    }
    // Same answer message: an observed presentation is delivery completion and
    // outranks even a durable terminal discard (a stale discard an earlier
    // incarnation drained must not reopen a presented answer). A memory discard
    // the audit may not yet carry wins (the answer really left the inbox). A
    // durable terminal discard wins over a stale memory admission, and over a
    // claim only when observed at/after the claim (a genuine pre-step reject);
    // a claim observed AFTER the durable terminal fact disproves it. Otherwise
    // memory may advance admitted → claimed/presented.
    if (entry.status === 'presented') return recordOfEntry(entry)
    if (entry.status === 'discarded' || entry.status === 'failed') return recordOfEntry(entry)
    if (record.status === 'discarded' || record.status === 'failed') {
      // A claim or a repaired admission observed AFTER the durable terminal
      // disproves it (a stale discard); a strictly later live fact wins.
      if ((entry.status === 'claimed' || entry.status === 'admitted') && entry.at > record.at) {
        return recordOfEntry(entry)
      }
      return record
    }
    if (record.status === 'admitted' && entry.status === 'claimed') {
      return {
        ...record,
        status: entry.status,
        at: entry.at,
        ...(entry.presentedAt === undefined ? {} : { presentedAt: entry.presentedAt }),
      }
    }
    return record
  }

  /**
   * Read the derived question/answer state of one question report from the
   * merged durable + in-memory answer fact.
   * @param agent - exact live lead Agent.
   * @param reportId - question report identity.
   * @returns the question/answer view, or undefined when the report is not a retained question.
   * @throws {@link DevLeadError} when the caller is not live or the projection is corrupt.
   */
  questionAnswerView(agent: Agent, reportId: string): DevLeadQuestionAnswerView | undefined {
    this.assertLive(agent)
    const state = this.strictStateOf(agent.session)
    const report = state.reports.find(existing => existing.id === reportId)
    if (report === undefined || report.kind !== 'question') return undefined
    const leadId = String(agent.id)
    const repairPending = this.questionRepairPending(leadId, reportId)
    const fact = this.resolvedAnswer(agent, reportId)
    if (fact === undefined) return { questionStatus: 'open', ...(repairPending ? { repairPending: true } : {}) }
    // A legacy durable record may lack `answeredAt`; an active answer's own
    // admission instant is the fallback (a discarded/failed answer without one
    // exposes no answeredAt, exactly like the fold's durable view).
    const answeredAt = fact.answeredAt
      ?? (fact.status === 'admitted' || fact.status === 'claimed' || fact.status === 'presented' ? fact.at : undefined)
    return {
      questionStatus: fact.status === 'discarded' || fact.status === 'failed' ? 'open' : 'answered',
      answerStatus: fact.status,
      answerMessageId: fact.messageId,
      ...(answeredAt === undefined ? {} : { answeredAt }),
      ...(fact.presentedAt === undefined ? {} : { presentedAt: fact.presentedAt }),
      // A repair in flight/deferred means the derived status may still reflect a
      // stale terminal discard; consumers treat it as provisional.
      ...(repairPending ? { repairPending: true } : {}),
    }
  }

  /**
   * Diagnostic health of the answer discard queue and its repairs: per-lead
   * queued discard counts (`pending`) and unresolved repair counts
   * (`pendingRepairs`: in-flight, deferred, queued, or unknown), plus the last
   * discard-queue failure (`lastFailure`, cleared by a successful drain) and the
   * newest repair failure (`lastRepairFailure`, cleared by that message's own
   * repair/settle/supersede) tracked separately so a drop-only drain success
   * never masks a still-pending repair failure.
   * @returns the per-lead pending counts and the last failures, when any.
   */
  answerDiscardHealth(): {
    readonly pending: Readonly<Record<string, number>>
    readonly pendingRepairs: Readonly<Record<string, number>>
    readonly lastFailure?: string
    readonly lastRepairFailure?: string
  } {
    const pending: Record<string, number> = {}
    for (const [leadId, queue] of this.pendingAnswerDiscards) {
      if (queue.length > 0) pending[leadId] = queue.length
    }
    // pendingRepairs merges in-flight, deferred, still-queued, and unknown
    // repairs: every question whose stale-discard repair is still unresolved.
    const pendingRepairs: Record<string, number> = {}
    const leads = new Set<string>([
      ...this.repairingQuestions.keys(),
      ...this.deferredDiscardRepairs.keys(),
      ...this.pendingAnswerDiscards.keys(),
    ])
    for (const leadId of leads) {
      const count = this.pendingRepairIds(leadId).size
      if (count > 0) pendingRepairs[leadId] = count
    }
    const lastRepairFailure = this.latestRepairFailure()
    return {
      pending,
      pendingRepairs,
      ...(this.lastAnswerDiscardFailure === undefined ? {} : { lastFailure: this.lastAnswerDiscardFailure }),
      ...(lastRepairFailure === undefined ? {} : { lastRepairFailure }),
    }
  }

  /**
   * Read the newest answer fact of one question for retry recognition and
   * conflict messages.
   * @param agent - exact live lead Agent.
   * @param reportId - question report identity.
   * @returns the newest answer's retry/excerpt facts, or undefined when unanswered.
   */
  private latestAnswerFact(
    agent: Agent,
    reportId: string,
  ): { readonly textHash: string; readonly idempotencyKey?: string; readonly textExcerpt?: string } | undefined {
    return this.resolvedAnswer(agent, reportId)
  }

  /**
   * Rebuild the original admission receipt of an answered question for an
   * idempotent replay.
   * @param agent - exact live lead Agent.
   * @param questionId - question report identity.
   * @returns the original delivery receipt.
   * @throws {@link DevLeadError} `DEVLEAD_QUESTION_NOT_FOUND` when no answer fact exists.
   */
  private answerReceiptOf(agent: Agent, questionId: string): DevLeadPromptDelivery {
    const fact = this.resolvedAnswer(agent, questionId)
    if (fact === undefined) {
      throw new DevLeadError(
        `question "${questionId}" has no answer receipt to replay; read devlead_notifications`,
        'DEVLEAD_QUESTION_NOT_FOUND',
      )
    }
    return {
      primitive: fact.primitive ?? 'steer',
      boundary: fact.boundary ?? 'next-step',
      wakeRequested: fact.wakeRequested ?? true,
      messageId: fact.messageId,
      questionId,
      ...(fact.idempotencyKey === undefined ? {} : { idempotencyKey: fact.idempotencyKey }),
    }
  }

  /**
   * Record one successfully admitted answer: append the durable `admitted`
   * fact to the lead's log, await its durability checkpoint, and register the
   * in-memory lifecycle entry. The answer message is already in the child inbox,
   * so a durable-write failure cannot un-admit it; instead the failure is
   * surfaced as a receipt warning (the question state may not survive a
   * restart) rather than silently claiming a durable answer.
   * @param agent - exact live lead Agent.
   * @param targetId - child Session identity.
   * @param questionId - question report identity.
   * @param text - trimmed answer prompt (hashed without the runtime prefix).
   * @param idempotencyKey - lead-supplied key, when provided.
   * @param delivery - the admission receipt.
   * @returns a warning when the durable answer record could not be persisted.
   */
  private async recordAnswerAdmission(
    agent: Agent,
    targetId: string,
    questionId: string,
    text: string,
    idempotencyKey: string | undefined,
    delivery: DevLeadPromptDelivery,
  ): Promise<{ readonly warning?: string }> {
    const at = Date.now()
    const leadId = String(agent.id)
    const textHash = answerTextHash(text)
    const textExcerpt = excerptLine(text, DEVLEAD_ERROR_EXCERPT_MAX)
    const priorEntry = this.answers.entryOfQuestion(leadId, questionId)
    const priorRecord = latestAnswerOf(this.strictStateOf(agent.session).answers, questionId)
    const firstAdmittedAt = priorEntry?.firstAdmittedAt ?? priorRecord?.answeredAt ?? at
    // Every admission of this question takes the next sequence number, so a
    // delayed discard of an older answer can never outrank this re-answer.
    const answerSeq = Math.max(priorEntry?.answerSeq ?? 0, priorRecord?.answerSeq ?? 0) + 1
    const primitive = delivery.primitive === 'followup' ? 'followup' : 'steer'
    const answer: DevLeadReportAnswer = {
      reportId: questionId,
      leadSessionId: leadId,
      sessionId: targetId,
      messageId: delivery.messageId,
      at,
      status: 'admitted',
      answerSeq,
      textHash,
      answeredAt: firstAdmittedAt,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(textExcerpt === undefined ? {} : { textExcerpt }),
      primitive,
      boundary: delivery.boundary,
      wakeRequested: delivery.wakeRequested,
    }
    this.answers.remember({
      reportId: questionId,
      leadSessionId: leadId,
      sessionId: targetId,
      messageId: delivery.messageId,
      status: 'admitted',
      at,
      answerSeq,
      firstAdmittedAt,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      textHash,
      ...(textExcerpt === undefined ? {} : { textExcerpt }),
      primitive,
      boundary: delivery.boundary,
      wakeRequested: delivery.wakeRequested,
    })
    let warning: string | undefined
    try {
      appendPluginRecord(agent.session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer))
    } catch (error: unknown) {
      warning = `the answer was delivered to the child inbox but its durable record could not be written `
        + `(${thrownMessage(error)}); the question state may not survive a Host restart`
      this.ctx.logger.warn(`devlead: could not record the answer to question "${questionId}" for lead "${leadId}": ${thrownMessage(error)}`)
    }
    try {
      await this.ctx.sessions.flush(agent.session)
    } catch (error: unknown) {
      warning ??= `the answer record for question "${questionId}" could not be flushed to persistence `
        + `(${thrownMessage(error)}); a later checkpoint may still persist it`
      this.ctx.logger.warn(`devlead: answer record for question "${questionId}" could not be flushed: ${thrownMessage(error)}`)
    }
    return warning === undefined ? {} : { warning }
  }

  /**
   * Append one durable discard fact for a tracked answer and await its flush. A
   * cold/detached lead log (or a failed write) cannot accept the record yet, so
   * the discard is queued and drained when the lead becomes live again
   * ({@link reconcileAnswerDiscards}); the in-memory status already reopened the
   * question, and the queue keeps that reopen durable across a restart.
   * @param entry - the discarded answer entry.
   * @param at - discard instant.
   */
  private async writeAnswerDiscard(entry: AnswerMemoryEntry, at: number): Promise<void> {
    await this.persistAnswerDiscard(discardedAnswerOf(entry, at))
  }

  /**
   * Persist one discard record to its lead's log, queueing it for reconciliation
   * when the lead is cold/detached, the append fails, or the flush fails. A
   * flush failure is not silently logged: the record is in the live log but may
   * not survive a crash, so the discard re-enters the durable retry queue (the
   * next drain sees the exact fact already appended and retries just the flush).
   * @param discard - the discard record value.
   */
  private async persistAnswerDiscard(discard: DevLeadReportAnswer): Promise<void> {
    const leadSession = this.ctx.sessions.get(toSessionId(discard.leadSessionId))
    if (leadSession === undefined) {
      this.queueAnswerDiscard(discard)
      return
    }
    try {
      appendPluginRecord(leadSession, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(discard))
    } catch (error: unknown) {
      this.lastAnswerDiscardFailure = `append of the discard of answer "${discard.messageId}" (question "${discard.reportId}", lead "${discard.leadSessionId}") failed: ${thrownMessage(error)}`
      this.ctx.logger.warn(`devlead: ${this.lastAnswerDiscardFailure}; queued for retry`)
      this.queueAnswerDiscard(discard)
      return
    }
    try {
      await this.ctx.sessions.flush(leadSession)
    } catch (error: unknown) {
      this.lastAnswerDiscardFailure = `flush of the discard of answer "${discard.messageId}" (question "${discard.reportId}", lead "${discard.leadSessionId}") failed: ${thrownMessage(error)}`
      this.ctx.logger.warn(`devlead: ${this.lastAnswerDiscardFailure}; queued for retry`)
      this.queueAnswerDiscard(discard)
    }
  }

  /**
   * Queue one discard for a lead whose log could not accept it yet, bounded per
   * lead (newest kept). The row is mirrored into the durable outbox queue so a
   * Host restart while the lead stays cold does not lose it; an overflow or a
   * failed durable mirror is an explicit warning, never a silent drop.
   * @param discard - the discard record value.
   */
  private queueAnswerDiscard(discard: DevLeadReportAnswer): void {
    const leadId = discard.leadSessionId
    const queue = this.pendingAnswerDiscards.get(leadId) ?? []
    const deduped = queue.filter(existing => !(existing.reportId === discard.reportId
      && existing.messageId === discard.messageId && existing.status === discard.status))
    deduped.push(discard)
    if (deduped.length > MAX_PENDING_ANSWER_DISCARDS) {
      const dropped = deduped.splice(0, deduped.length - MAX_PENDING_ANSWER_DISCARDS)
      this.ctx.logger.warn(
        `devlead: answer discard queue for lead "${leadId}" exceeded ${String(MAX_PENDING_ANSWER_DISCARDS)} entries; `
        + `dropped the ${String(dropped.length)} oldest — their questions may stay answered after a restart`,
      )
      for (const entry of dropped) void this.outbox?.deleteAnswerDiscard(entry)
    }
    this.pendingAnswerDiscards.set(leadId, deduped)
    if (this.outbox === undefined || !this.outbox.available) {
      if (!this.warnedMemoryOnlyDiscards.has(leadId)) {
        this.warnedMemoryOnlyDiscards.add(leadId)
        this.ctx.logger.warn(
          `devlead: no durable storage for the answer discard queue of lead "${leadId}"; the queue is memory-only `
          + 'and relies on child-log reconstruction after a restart',
        )
      }
    } else {
      void this.outbox.putAnswerDiscard(discard).then((durable) => {
        if (!durable) {
          this.lastAnswerDiscardFailure = `durable queue write of answer discard "${discard.messageId}" (lead "${leadId}") failed; the queue row is memory-only until the next drain`
        }
      })
    }
    this.scheduleAnswerDiscardRetry()
  }

  /** Arm the periodic retry of queued discards that could not drain yet. */
  private scheduleAnswerDiscardRetry(): void {
    if (this.disposed || this.answerDiscardRetryTimer !== undefined) return
    this.answerDiscardRetryTimer = setTimeout(() => {
      this.answerDiscardRetryTimer = undefined
      if (this.disposed) return
      for (const leadId of [...this.pendingAnswerDiscards.keys()]) {
        void this.reconcileAnswerDiscards(leadId)
      }
      for (const leadId of [...this.deferredDiscardRepairs.keys()]) {
        this.registerRepairBarrier(leadId, this.processDeferredDiscardRepairs(leadId))
      }
    }, ANSWER_DISCARD_RETRY_MS)
    this.answerDiscardRetryTimer.unref?.()
  }

  /**
   * Rehydrate the durable answer discard queue after the outbox opens (boot or
   * late storage mount): every still-valid row re-enters the memory queue and
   * seeds the tracker as discarded, so a question whose answer was dropped
   * while the lead stayed cold reads open immediately — even before the drain
   * appends the record. A stale row whose answer survived (a keep/clear-own
   * restore re-inserted it, or it was presented) or was superseded by a newer
   * durable answer is dropped, never seeded. Each lead's restored rows are
   * bounded exactly like the live queue (newest kept, overflow warned). Rows
   * queued in memory before the outbox opened are mirrored back into it. Live
   * leads drain right away.
   */
  private async restoreAnswerDiscards(): Promise<void> {
    const outbox = this.outbox
    if (outbox === undefined || !outbox.available) return
    const byLead = new Map<string, DevLeadAnswerDiscardRow[]>()
    for (const row of outbox.answerDiscards()) {
      const rows = byLead.get(row.answer.leadSessionId) ?? []
      rows.push(row)
      byLead.set(row.answer.leadSessionId, rows)
    }
    const logCache = new Map<string, readonly SessionEvent[] | undefined>()
    for (const [leadId, rows] of byLead) {
      rows.sort((left, right) => left.enqueuedAt - right.enqueuedAt)
      if (rows.length > MAX_PENDING_ANSWER_DISCARDS) {
        const dropped = rows.splice(0, rows.length - MAX_PENDING_ANSWER_DISCARDS)
        this.ctx.logger.warn(
          `devlead: restored answer discard queue for lead "${leadId}" exceeded ${String(MAX_PENDING_ANSWER_DISCARDS)} entries; `
          + `dropped the ${String(dropped.length)} oldest — their questions may stay answered after a restart`,
        )
        for (const row of dropped) void outbox.deleteAnswerDiscard(row.answer)
      }
      for (const row of rows) {
        const discard = row.answer
        if (this.leadSideObsolete(discard)) {
          this.dropObsoleteDiscard(discard)
          continue
        }
        const survival = await this.survivalProof(discard, logCache)
        // A proven survival drops the stale row; an unreadable child (unknown)
        // keeps it queued for retry — never drop/seed on unknown.
        if (survival !== undefined && survival.status !== 'unknown') {
          this.dropObsoleteDiscard(discard, survival)
          continue
        }
        const queue = this.pendingAnswerDiscards.get(leadId) ?? []
        if (!queue.some(existing => existing.reportId === discard.reportId
          && existing.messageId === discard.messageId && existing.status === discard.status)) {
          queue.push(discard)
          this.pendingAnswerDiscards.set(leadId, queue)
        }
        // An unreadable child leaves the reopen provisional: mark the question
        // repair-pending so the view/prompt refuse a duplicate until it resolves.
        if (survival?.status === 'unknown') this.markRepairPending(leadId, discard.reportId)
        // The seq-aware, presentation-safe seed never lets a stale queued
        // discard outrank a newer re-answer or rewind a presented answer.
        this.answers.seed(discard)
      }
    }
    for (const [leadId, queue] of this.pendingAnswerDiscards) {
      for (const discard of queue) void outbox.putAnswerDiscard(discard)
      if (this.ctx.sessions.get(toSessionId(leadId)) !== undefined) {
        void this.reconcileAnswerDiscards(leadId)
      }
    }
  }

  /**
   * Drain the queued answer discards of one lead now that its Session log is
   * live, so a discard observed while the lead was cold reaches the durable
   * audit. Called when the lead becomes live ({@link seedAnswersForAgent}),
   * before the next prompt, and on the retry timer; overlapping triggers share
   * one in-flight pass per lead.
   * @param leadId - lead Session identity.
   */
  private async reconcileAnswerDiscards(leadId: string): Promise<void> {
    const inflight = this.answerDiscardDrains.get(leadId)
    if (inflight !== undefined) return inflight
    const run = this.drainAnswerDiscards(leadId)
    this.answerDiscardDrains.set(leadId, run)
    try {
      await run
    } finally {
      this.answerDiscardDrains.delete(leadId)
    }
  }

  /**
   * Lead-side obsolescence of one queued discard: a newer answer of the same
   * question is already durable (same or higher admission sequence), or a
   * different discard fact of the same message is already durable.
   * @param discard - the queued discard fact.
   * @returns whether the durable audit already supersedes the discard.
   */
  private leadSideObsolete(discard: DevLeadReportAnswer): boolean {
    const leadSession = this.ctx.sessions.get(toSessionId(discard.leadSessionId))
    if (leadSession === undefined) return false
    const state = this.projectionHandle.stateOf(leadSession)
    if (state.failure !== null) return false
    const latest = latestAnswerOf(state.answers, discard.reportId)
    if (latest === undefined) return false
    if (latest.messageId !== discard.messageId && (latest.answerSeq ?? 0) >= (discard.answerSeq ?? 0)) return true
    return latest.messageId === discard.messageId
      && (latest.status === 'discarded' || latest.status === 'failed')
      && latest.at !== discard.at
  }

  /**
   * Prove that a queued/durable discard's answer SURVIVED, so the discard must
   * be dropped (and any stale durable discard repaired): the message is still
   * pending in the child inbox (a keep/clear-own restore re-inserted it after a
   * canceled splice), claimed by an unsettled pre-step, or it really presented.
   * A claimed answer only survives a discard queued BEFORE the claim — a later
   * terminal fact is a genuine pre-step reject. A live child is checked through
   * its inbox, observer (falling back to a log replay when the observer is
   * missing), and tracker; a cold child through its durable log (attached
   * Session snapshot, else the Session query engine), replayed exactly like the
   * activation path so canceled+restore histories resolve identically.
   * @param discard - the queued or stale durable discard fact.
   * @param logCache - per-pass cache of cold child logs, avoiding one read per row.
   * @returns the proven survival state, or undefined when nothing disproves the discard.
   */
  private async survivalProof(
    discard: DevLeadReportAnswer,
    logCache: Map<string, readonly SessionEvent[] | undefined>,
  ): Promise<SurvivalOutcome> {
    const childId = discard.sessionId
    const child = this.ctx.agents.get(toSessionId(childId))
    if (child !== undefined) {
      if (locatedInputs(child).some(entry => String(entry.message.id) === discard.messageId)) {
        return { status: 'admitted', at: Date.now() }
      }
      let observer = this.childAnswerObservers.get(childId)
      if (observer === undefined) {
        // Live child without an observer (disposed or evicted): fall back to a
        // replay of its attached log so survival is still checkable.
        observer = this.newChildObserver(childId)
        observer.replay(child.session.snapshotEvents())
      }
      const presentedAt = observer.presentedAtOf(discard.messageId)
      if (presentedAt !== undefined) return { status: 'presented', at: presentedAt }
      const claimedAt = observer.claimedAtOf(discard.messageId)
      if (claimedAt !== undefined && discard.at < claimedAt) return { status: 'claimed', at: claimedAt }
      const entry = this.answers.entryOfMessage(childId, discard.messageId)
      if (entry?.status === 'presented') return { status: 'presented', at: entry.presentedAt ?? entry.at }
      if (entry?.status === 'claimed' && discard.at < entry.at) return { status: 'claimed', at: entry.at }
      return undefined
    }
    let events = logCache.get(childId)
    if (events === undefined && !logCache.has(childId)) {
      events = await this.childLogEvents(childId)
      logCache.set(childId, events)
    }
    // The child's reality is unreadable (cold, no attached log, no/failing query
    // engine): the outcome is UNKNOWN, not a genuine discard. Callers must keep
    // the question provisional and retry, never accept a stale open as final.
    if (events === undefined) return { status: 'unknown' }
    const observer = this.newChildObserver(childId)
    observer.replay(events)
    const presentedAt = observer.presentedAtOf(discard.messageId)
    if (presentedAt !== undefined) return { status: 'presented', at: presentedAt }
    const claimedAt = observer.claimedAtOf(discard.messageId)
    if (claimedAt !== undefined && discard.at < claimedAt) return { status: 'claimed', at: claimedAt }
    if (observer.isPending(discard.messageId)) return { status: 'admitted', at: Date.now() }
    return undefined
  }

  /**
   * Synchronous unreadability check for the view: a cold child with no attached
   * Session log and no query engine cannot be proven either way. (A composed
   * query engine's read failure is resolved asynchronously by the repair pass.)
   * @param childId - child Session identity.
   * @returns whether the child's reality is synchronously unreadable.
   */
  private childUnreadable(childId: string): boolean {
    if (this.ctx.agents.get(toSessionId(childId)) !== undefined) return false
    if (this.ctx.sessions.get(toSessionId(childId)) !== undefined) return false
    return this.ctx.get('sessionQuery') === undefined
  }

  /** Mark one question's stale-discard repair as unresolved (pending). */
  private markRepairPending(leadId: string, reportId: string): void {
    let set = this.repairingQuestions.get(leadId)
    if (set === undefined) {
      set = new Set()
      this.repairingQuestions.set(leadId, set)
    }
    set.add(reportId)
  }

  /** Clear one question's repair-pending mark once the repair resolves. */
  private clearRepairPending(leadId: string, reportId: string): void {
    const set = this.repairingQuestions.get(leadId)
    if (set === undefined) return
    set.delete(reportId)
    if (set.size === 0) this.repairingQuestions.delete(leadId)
  }

  /**
   * Every question of one lead whose stale-discard repair is still unresolved:
   * marked in-flight, deferred, STILL QUEUED with an unreadable child (a reopen
   * that survives a drain), or a durable terminal whose child is unreadable. A
   * queued unknown row counts because the question's reopen is not provable, so
   * its `open` is provisional and must not admit a duplicate answer.
   * @param leadId - lead Session identity.
   * @returns the set of unresolved question report ids.
   */
  private pendingRepairIds(leadId: string): Set<string> {
    const ids = new Set(this.repairingQuestions.get(leadId) ?? [])
    for (const entry of this.deferredDiscardRepairs.get(leadId) ?? []) ids.add(entry.stale.reportId)
    // A queued discard whose child is unreadable is an UNKNOWN reopen: provisional
    // until it resolves. A queued discard with a readable child is provable
    // (genuine or survived) and the drain resolves it, so it is not flagged here.
    for (const discard of this.pendingAnswerDiscards.get(leadId) ?? []) {
      if (this.childUnreadable(discard.sessionId)) ids.add(discard.reportId)
    }
    const leadSession = this.ctx.sessions.get(toSessionId(leadId))
    if (leadSession !== undefined) {
      const state = this.projectionHandle.stateOf(leadSession)
      if (state.failure === null) {
        const latest = new Map<string, DevLeadReportAnswer>()
        for (const answer of state.answers) {
          const current = latest.get(answer.reportId)
          if (current === undefined || (answer.answerSeq ?? 0) >= (current.answerSeq ?? 0)) {
            latest.set(answer.reportId, answer)
          }
        }
        for (const record of latest.values()) {
          if ((record.status === 'discarded' || record.status === 'failed') && this.childUnreadable(record.sessionId)) {
            ids.add(record.reportId)
          }
        }
      }
    }
    return ids
  }

  /** Whether one question's stale-discard repair is still unresolved. */
  private questionRepairPending(leadId: string, reportId: string): boolean {
    return this.pendingRepairIds(leadId).has(reportId)
  }

  /**
   * Read one child's durable log: the attached Session snapshot when present,
   * else the persisted log through the optional Session query engine.
   * @param childId - child Session identity.
   * @returns the committed events, or undefined when unreadable.
   */
  private async childLogEvents(childId: string): Promise<readonly SessionEvent[] | undefined> {
    const session = this.ctx.sessions.get(toSessionId(childId))
    if (session !== undefined) return session.snapshotEvents()
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    try {
      return (await query.readSession(toSessionId(childId))).events
    } catch {
      return undefined
    }
  }

  /**
   * Drop one obsolete queued discard (memory row already removed by the caller;
   * this removes the durable row), repair a tracker entry the stale discard had
   * marked discarded/failed back to the proven reality, and — when the stale
   * discard already reached the lead's durable audit — append a durable repair
   * fact so the reopen does not survive the next restart.
   * @param discard - the obsolete discard fact.
   * @param survival - the proven survival state, when the drop is survival-based.
   */
  private dropObsoleteDiscard(discard: DevLeadReportAnswer, survival?: AnswerSurvivalProof): void {
    void this.outbox?.deleteAnswerDiscard(discard)
    if (survival === undefined) {
      // Superseded/obsolete without a survival proof: the stale repair resolves
      // (a newer genuine fact wins); clear its pending mark and failure.
      this.clearRepairFailure(discard)
      this.clearRepairPending(discard.leadSessionId, discard.reportId)
      return
    }
    // The tracker repair happens inside the repair pass, AFTER the latest
    // durable fact is validated: a newer genuine terminal must not be undone,
    // and a failed/rejected repair must not leave the tracker falsely survived.
    void this.repairStaleDurableDiscard(discard)
  }

  /**
   * Chain one repair pass/fact onto the lead's repair barrier so answer
   * admission can await the repaired state. The chained promise never rejects;
   * callers that need the outcome await the raw run, not the barrier (so a pass
   * that itself spawns repairs cannot deadlock on its own barrier).
   * @param leadId - lead Session identity.
   * @param run - the repair work to chain.
   */
  private registerRepairBarrier(leadId: string, run: Promise<void>): void {
    const previous = this.answerRepairBarriers.get(leadId) ?? Promise.resolve()
    const chained = previous.then(() => run.catch(() => undefined))
    this.answerRepairBarriers.set(leadId, chained)
    void chained.then(() => {
      if (this.answerRepairBarriers.get(leadId) === chained) this.answerRepairBarriers.delete(leadId)
    })
  }

  /**
   * Await one repair barrier with a finite timeout and abort awareness, so a
   * repair that never resolves cannot hang answer admission. On timeout/abort it
   * throws a retryable error; normal settlement is unchanged. Timers/listeners
   * are always cleaned up.
   * @param run - the barrier promise to await.
   * @param ms - remaining milliseconds before giving up.
   * @param signal - the caller's cancellation signal, when provided.
   */
  private async awaitRepairBarrier(run: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const retryable = (reason: string): DevLeadError => new DevLeadError(
      `answer-discard repair did not settle (${reason}); retry the answer shortly`,
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(retryable('timed out')), ms)
    })
    const abort = new Promise<never>((_, reject) => {
      if (signal === undefined) return
      if (signal.aborted) {
        reject(retryable('cancelled'))
        return
      }
      onAbort = () => reject(retryable('cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([run, timeout, abort])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Record one repair failure keyed by lead+message (never cleared by another's success). */
  private setRepairFailure(stale: DevLeadReportAnswer, detail: string): void {
    const message = `repair ${detail} for answer "${stale.messageId}" (lead "${stale.leadSessionId}") failed`
    const key = `${stale.leadSessionId}\u0000${stale.messageId}`
    this.repairFailures.set(key, { message, at: Date.now() })
    // Bounded: evict the oldest failures beyond the cap (newest kept).
    if (this.repairFailures.size > MAX_PENDING_ANSWER_DISCARDS) {
      const oldest = [...this.repairFailures.entries()].sort((left, right) => left[1].at - right[1].at)
      for (const [entryKey] of oldest.slice(0, this.repairFailures.size - MAX_PENDING_ANSWER_DISCARDS)) {
        this.repairFailures.delete(entryKey)
      }
    }
    this.ctx.logger.warn(`devlead: ${message}; deferred`)
  }

  /** Clear one message's repair failure after its own resolution. */
  private clearRepairFailure(stale: DevLeadReportAnswer): void {
    this.repairFailures.delete(`${stale.leadSessionId}\u0000${stale.messageId}`)
  }

  /** The most recent still-pending repair failure (by failure instant), if any. */
  private latestRepairFailure(): string | undefined {
    let newest: { readonly message: string; readonly at: number } | undefined
    for (const entry of this.repairFailures.values()) {
      if (newest === undefined || entry.at >= newest.at) newest = entry
    }
    return newest?.message
  }

  /**
   * Repair one stale durable discard already appended to the lead's audit. The
   * repair is registered on the lead's barrier (so admission awaits it) and its
   * question is marked repair-pending (so the view reports `repairPending`). The
   * mark is cleared only when the repair RESOLVES inside {@link runDiscardRepair}
   * — a failed/deferred/unknown repair keeps the question provisional. The raw
   * run is returned for callers that await the outcome directly.
   * @param stale - the stale discard fact (queued row or durable record).
   */
  private repairStaleDurableDiscard(stale: DevLeadReportAnswer): Promise<void> {
    this.markRepairPending(stale.leadSessionId, stale.reportId)
    const run = this.runDiscardRepair(stale)
    this.registerRepairBarrier(stale.leadSessionId, run)
    return run
  }

  /**
   * Execute one durable-discard repair. The survival is RE-PROVEN now: a settled
   * child resolves the repair as genuine (clears the pending mark); an unreadable
   * child is UNKNOWN and re-defers (keeps the mark). The repair only appends when
   * the newest durable fact is the SAME stale terminal (same messageId/status/
   * answerSeq and `latest.at <= stale.at`); a newer genuine terminal is never
   * overwritten. The tracker advances to the proven status ONLY after the durable
   * append+flush succeeds — on failure the view stays `repairPending`, never a
   * premature answered. A cold lead defers; failures re-defer with a per-message
   * repair-failure health entry.
   * @param stale - the stale discard fact.
   */
  private async runDiscardRepair(stale: DevLeadReportAnswer): Promise<void> {
    const leadId = stale.leadSessionId
    const fresh = await this.survivalProof(stale, new Map())
    if (fresh === undefined) {
      // The child is observable and shows no survival: a genuine discard.
      this.clearRepairFailure(stale)
      this.clearRepairPending(leadId, stale.reportId)
      return
    }
    if (fresh.status === 'unknown') {
      // The child's reality is unreadable: keep provisional and retry later.
      this.deferDiscardRepair(stale)
      return
    }
    const leadSession = this.ctx.sessions.get(toSessionId(leadId))
    if (leadSession === undefined) {
      this.deferDiscardRepair(stale)
      return
    }
    const state = this.projectionHandle.stateOf(leadSession)
    if (state.failure !== null) {
      this.deferDiscardRepair(stale)
      return
    }
    const latest = latestAnswerOf(state.answers, stale.reportId)
    const sameMessage = latest !== undefined && latest.messageId === stale.messageId
    const sameSeq = sameMessage && (latest.answerSeq ?? 0) === (stale.answerSeq ?? 0)
    if (sameMessage && (latest.status === 'discarded' || latest.status === 'failed')) {
      // Only repair the SAME stale terminal. A newer terminal fact (later at,
      // or a different status/sequence) is a genuine discard that supersedes.
      const sameStaleTerminal = latest.status === stale.status && sameSeq && latest.at <= stale.at
      if (!sameStaleTerminal) {
        // A newer genuine terminal supersedes: resolve the stale repair.
        this.clearRepairFailure(stale)
        this.clearRepairPending(leadId, stale.reportId)
        return
      }
      const at = Math.max(Date.now(), latest.at + 1)
      const repair: DevLeadReportAnswer = {
        reportId: latest.reportId,
        leadSessionId: latest.leadSessionId,
        sessionId: latest.sessionId,
        messageId: latest.messageId,
        at,
        status: fresh.status,
        ...(latest.answerSeq === undefined ? {} : { answerSeq: latest.answerSeq }),
        textHash: latest.textHash,
        answeredAt: latest.answeredAt ?? latest.at,
        ...(fresh.status === 'presented' ? { presentedAt: fresh.at } : {}),
        ...(latest.idempotencyKey === undefined ? {} : { idempotencyKey: latest.idempotencyKey }),
        ...(latest.textExcerpt === undefined ? {} : { textExcerpt: latest.textExcerpt }),
        ...(latest.primitive === undefined ? {} : { primitive: latest.primitive }),
        ...(latest.boundary === undefined ? {} : { boundary: latest.boundary }),
        ...(latest.wakeRequested === undefined ? {} : { wakeRequested: latest.wakeRequested }),
      }
      try {
        appendPluginRecord(leadSession, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(repair))
      } catch (error: unknown) {
        this.setRepairFailure(stale, `append: ${thrownMessage(error)}`)
        this.deferDiscardRepair(stale)
        return
      }
      try {
        await this.ctx.sessions.flush(leadSession)
      } catch (error: unknown) {
        this.setRepairFailure(stale, `flush: ${thrownMessage(error)}`)
        this.deferDiscardRepair(stale)
        return
      }
      // Durable success: NOW advance the tracker and resolve the pending mark.
      this.clearRepairFailure(stale)
      this.answers.repairLifecycle(stale.sessionId, stale.messageId, fresh.status, fresh.at)
      this.answers.seed(repair)
      this.clearRepairPending(leadId, stale.reportId)
      return
    }
    if (sameMessage && sameSeq && latest.status === fresh.status && latest.at > stale.at) {
      // The exact repair fact is already the latest row (an earlier append whose
      // flush failed): retry just the flush, then advance the tracker on success.
      try {
        await this.ctx.sessions.flush(leadSession)
        this.clearRepairFailure(stale)
        this.answers.repairLifecycle(stale.sessionId, stale.messageId, fresh.status, fresh.at)
        this.clearRepairPending(leadId, stale.reportId)
      } catch (error: unknown) {
        this.setRepairFailure(stale, `flush: ${thrownMessage(error)}`)
        this.deferDiscardRepair(stale)
      }
      return
    }
    // No stale durable terminal of this message to repair (already answered, or
    // a different answer is latest): apply proven reality and resolve the mark.
    this.clearRepairFailure(stale)
    this.answers.repairLifecycle(stale.sessionId, stale.messageId, fresh.status, fresh.at)
    this.clearRepairPending(leadId, stale.reportId)
  }

  /**
   * Defer one durable-discard repair until its lead/child becomes readable,
   * bounded per lead (newest kept, overflow warned). Keeps the question's
   * repair-pending mark so the view stays provisional until it resolves.
   * @param stale - the stale discard fact.
   */
  private deferDiscardRepair(stale: DevLeadReportAnswer): void {
    this.markRepairPending(stale.leadSessionId, stale.reportId)
    const queue = this.deferredDiscardRepairs.get(stale.leadSessionId) ?? []
    const deduped = queue.filter(existing => !(existing.stale.messageId === stale.messageId
      && existing.stale.reportId === stale.reportId))
    deduped.push({ stale })
    if (deduped.length > MAX_PENDING_ANSWER_DISCARDS) {
      const dropped = deduped.splice(0, deduped.length - MAX_PENDING_ANSWER_DISCARDS)
      this.ctx.logger.warn(
        `devlead: deferred discard repairs for lead "${stale.leadSessionId}" exceeded ${String(MAX_PENDING_ANSWER_DISCARDS)} entries; `
        + `dropped the ${String(dropped.length)} oldest — their questions may stay open after a restart`,
      )
    }
    this.deferredDiscardRepairs.set(stale.leadSessionId, deduped)
    this.scheduleAnswerDiscardRetry()
  }

  /**
   * Process the deferred durable-discard repairs of one lead now that its log
   * is live. Each repair re-proves survival; a failure/unknown re-defers itself.
   * @param leadId - lead Session identity.
   */
  private async processDeferredDiscardRepairs(leadId: string): Promise<void> {
    const queue = this.deferredDiscardRepairs.get(leadId)
    if (queue === undefined || queue.length === 0) return
    this.deferredDiscardRepairs.delete(leadId)
    for (const entry of queue) {
      await this.repairStaleDurableDiscard(entry.stale)
    }
  }

  /**
   * Repair every stale durable discard of one lead whose answer the child's
   * reality disproves: for each newest terminal discard/failed record, mark the
   * question repair-pending and run the survival proof. A proven survival
   * appends a durable repair fact; an unreadable child (unknown) defers; a
   * settled child (genuine) clears the mark. This is the restart path for a
   * false discard an earlier incarnation already drained into the lead log.
   * @param leadId - lead Session identity whose answer audit is checked.
   */
  private async repairDisprovenDurableDiscards(leadId: string): Promise<void> {
    const leadSession = this.ctx.sessions.get(toSessionId(leadId))
    if (leadSession === undefined) return
    const state = this.projectionHandle.stateOf(leadSession)
    if (state.failure !== null) return
    const latest = new Map<string, DevLeadReportAnswer>()
    for (const answer of state.answers) {
      const current = latest.get(answer.reportId)
      if (current === undefined || (answer.answerSeq ?? 0) >= (current.answerSeq ?? 0)) {
        latest.set(answer.reportId, answer)
      }
    }
    const logCache = new Map<string, readonly SessionEvent[] | undefined>()
    for (const record of latest.values()) {
      if (record.status !== 'discarded' && record.status !== 'failed') continue
      // Mark pending as soon as a latest terminal is scanned, so the view flags
      // it provisional even before the survival proof resolves.
      this.markRepairPending(leadId, record.reportId)
      const survival = await this.survivalProof(record, logCache)
      if (survival === undefined) {
        this.clearRepairPending(leadId, record.reportId)
        continue
      }
      if (survival.status === 'unknown') {
        this.deferDiscardRepair(record)
        continue
      }
      await this.repairStaleDurableDiscard(record)
    }
  }

  /**
   * Reconcile every lead's queued discards targeting one newly-live child
   * against the child's observable reality: a row whose answer is still pending
   * (a keep/clear-own restore re-inserted it) or was presented is obsolete —
   * drop it (memory and durable row) and repair a tracker entry the stale row
   * had marked discarded. Runs at child activation, when the inbox and the
   * replayed log first become checkable.
   * @param childId - child Session identity that just became live.
   */
  private async reconcileQueuedDiscardsForChild(childId: string): Promise<void> {
    const logCache = new Map<string, readonly SessionEvent[] | undefined>()
    for (const [leadId, queue] of [...this.pendingAnswerDiscards]) {
      const kept: DevLeadReportAnswer[] = []
      for (const discard of queue) {
        if (discard.sessionId !== childId) {
          kept.push(discard)
          continue
        }
        if (this.leadSideObsolete(discard)) {
          this.dropObsoleteDiscard(discard)
          continue
        }
        const survival = await this.survivalProof(discard, logCache)
        // A proven survival drops the stale row; an unreadable child (unknown)
        // keeps it queued for retry — never drop on unknown.
        if (survival !== undefined && survival.status !== 'unknown') {
          this.dropObsoleteDiscard(discard, survival)
          continue
        }
        kept.push(discard)
      }
      if (kept.length === 0) this.pendingAnswerDiscards.delete(leadId)
      else this.pendingAnswerDiscards.set(leadId, kept)
    }
  }

  /**
   * One drain pass over a lead's queued discards. A discard superseded by a
   * newer answer of the same question (durable or observed) is dropped instead
   * of appended, so a delayed old discard can never become the latest fact; a
   * discard whose exact fact is already durable, or whose answer survived
   * (pending/presented), is dropped too. Append/flush failures re-queue the
   * affected rows for the next drain.
   * @param leadId - lead Session identity.
   */
  private async drainAnswerDiscards(leadId: string): Promise<void> {
    const queue = this.pendingAnswerDiscards.get(leadId)
    if (queue === undefined || queue.length === 0) return
    this.pendingAnswerDiscards.delete(leadId)
    const leadSession = this.ctx.sessions.get(toSessionId(leadId))
    if (leadSession === undefined) {
      // Still cold: keep the queue (and its durable rows) for the next live index.
      this.pendingAnswerDiscards.set(leadId, queue)
      this.scheduleAnswerDiscardRetry()
      return
    }
    if (this.projectionHandle.stateOf(leadSession).failure !== null) {
      // A frozen fold cannot derive question state; keep the queue until the
      // human recovers the Session (reset), rather than appending into it.
      this.pendingAnswerDiscards.set(leadId, queue)
      this.scheduleAnswerDiscardRetry()
      return
    }
    const appended: DevLeadReportAnswer[] = []
    const failed: DevLeadReportAnswer[] = []
    const logCache = new Map<string, readonly SessionEvent[] | undefined>()
    for (const discard of queue) {
      const entry = this.answers.entryOfQuestion(leadId, discard.reportId)
      const supersededByMemory = entry !== undefined && entry.messageId !== discard.messageId
        && entry.answerSeq >= (discard.answerSeq ?? 0)
      if (supersededByMemory || this.leadSideObsolete(discard)) {
        this.dropObsoleteDiscard(discard)
        continue
      }
      // The answer may have survived (restored/pending, claimed, or presented) —
      // check the child's inbox or durable log before appending the discard. An
      // unreadable child (unknown) keeps the row queued; never append on unknown.
      const survival = await this.survivalProof(discard, logCache)
      if (survival !== undefined && survival.status !== 'unknown') {
        this.dropObsoleteDiscard(discard, survival)
        continue
      }
      if (survival?.status === 'unknown') {
        // Unreadable child: the reopen stays provisional and queued for retry.
        this.markRepairPending(leadId, discard.reportId)
        failed.push(discard)
        continue
      }
      // This exact fact may already sit in the live log (a flush failed after a
      // successful append): it then needs only the flush, not a duplicate row.
      const latest = latestAnswerOf(this.projectionHandle.stateOf(leadSession).answers, discard.reportId)
      const alreadyAppended = latest !== undefined && latest.messageId === discard.messageId
        && latest.status === discard.status && latest.at === discard.at
      if (!alreadyAppended) {
        try {
          appendPluginRecord(leadSession, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(discard))
        } catch (error: unknown) {
          this.lastAnswerDiscardFailure = `reconcile append of answer discard "${discard.messageId}" (lead "${leadId}") failed: ${thrownMessage(error)}`
          this.ctx.logger.warn(`devlead: ${this.lastAnswerDiscardFailure}; queued for retry`)
          failed.push(discard)
          continue
        }
      }
      appended.push(discard)
    }
    let flushed = true
    if (appended.length > 0) {
      try {
        await this.ctx.sessions.flush(leadSession)
        this.lastAnswerDiscardFailure = undefined
      } catch (error: unknown) {
        flushed = false
        this.lastAnswerDiscardFailure = `reconcile flush of answer discards for lead "${leadId}" failed: ${thrownMessage(error)}`
        this.ctx.logger.warn(`devlead: ${this.lastAnswerDiscardFailure}; queued for retry`)
      }
    } else if (failed.length === 0) {
      // A drop-only pass (every row obsolete/superseded) persisted nothing new
      // and failed at nothing: the queue is healthy again.
      this.lastAnswerDiscardFailure = undefined
    }
    for (const discard of appended) {
      if (flushed) {
        void this.outbox?.deleteAnswerDiscard(discard)
        // The reopen is now durable: resolve the queued-repair mark. (If the
        // child is still unreadable, the durable-terminal clause keeps it
        // provisional until a repair pass resolves it.)
        this.clearRepairPending(leadId, discard.reportId)
      } else {
        this.queueAnswerDiscard(discard)
      }
    }
    for (const discard of failed) this.queueAnswerDiscard(discard)
  }

  /**
   * Discard one pending answer message (interrupt clear-all, replacement, an
   * observed inbox discard, or a child-log reconstruction), advancing the
   * memory entry and writing a durable discard so the question reopens. When no
   * memory entry exists (restart, cold lead, evicted observation), the durable
   * admitted record supplies the facts needed for the discard — read from the
   * live lead projection, from the cold lead's persisted log through the
   * Session query engine, or deferred until the lead becomes live.
   * @param targetId - child Session identity.
   * @param messageId - pending answer message identity.
   * @param questionId - question report identity read from the message source.
   * @param leadId - authoring lead Session identity.
   * @param at - discard instant (the proving log event's time for a replay).
   */
  private discardPendingAnswer(targetId: string, messageId: string, questionId: string, leadId: string, at = Date.now()): void {
    // The child inbox is authoritative about survival: a message still pending
    // (for example one a keep/clear-own restore re-inserted after a canceled
    // splice) or already presented must never be discarded, whatever a
    // replayed cancellation candidate or stale queue row claims.
    const targetAgent = this.ctx.agents.get(toSessionId(targetId))
    if (targetAgent !== undefined && locatedInputs(targetAgent).some(entry => String(entry.message.id) === messageId)) return
    const observer = this.childAnswerObservers.get(targetId)
    if (observer?.wasPresented(messageId) === true) return
    // A claimed answer is still alive: a discard observed BEFORE the claim is
    // stale (a keep/clear-own restore re-inserted it and a pre-step took it);
    // only a terminal fact at/after the claim is a genuine pre-step reject.
    const claimedAt = observer?.claimedAtOf(messageId)
    if (claimedAt !== undefined && at < claimedAt) return
    const claimedEntry = this.answers.entryOfMessage(targetId, messageId)
    if (claimedEntry?.status === 'claimed' && at < claimedEntry.at) return
    const advanced = this.answers.discarded(targetId, messageId, at)
    if (advanced !== undefined) {
      void this.writeAnswerDiscard(advanced, at)
      return
    }
    const entry = this.answers.entryOfMessage(targetId, messageId)
    if (entry !== undefined) return // already terminal (presented/discarded/failed)
    // A newer answer of this question is already tracked: the old message's
    // discard must not clobber it (the durable-latest check below agrees).
    const current = this.answers.entryOfQuestion(leadId, questionId)
    if (current !== undefined && current.messageId !== messageId) return
    // No live memory entry: derive the discard from the durable admitted record.
    const leadSession = this.ctx.sessions.get(toSessionId(leadId))
    if (leadSession === undefined) {
      void this.discardAnswerFromColdLead(targetId, messageId, questionId, leadId, at)
      return
    }
    const state = this.projectionHandle.stateOf(leadSession)
    if (state.failure !== null) return
    const record = latestAnswerOf(state.answers, questionId)
    if (record === undefined || record.messageId !== messageId) return
    if (record.status === 'discarded' || record.status === 'failed') return // already durable
    this.rememberDerivedDiscard(record, at)
  }

  /**
   * Derive a discard while the lead's log is cold: read the persisted log
   * through the optional Session query engine and fold its answer audit. When
   * no query engine is composed (or the read fails), the derivation is deferred
   * until the lead becomes live — the child-log observer and the durable queue
   * keep the observation alive across that window and across a restart.
   * @param targetId - child Session identity.
   * @param messageId - discarded answer message identity.
   * @param questionId - question report identity.
   * @param leadId - authoring lead Session identity.
   * @param at - discard instant.
   */
  private async discardAnswerFromColdLead(
    targetId: string,
    messageId: string,
    questionId: string,
    leadId: string,
    at: number,
  ): Promise<void> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      this.deferAnswerDiscard(targetId, messageId, questionId, leadId, at)
      return
    }
    let state: DevLeadProjectionState
    try {
      const snapshot = await query.readSession(toSessionId(leadId))
      state = emptyDevLeadProjectionState(snapshot.inheritedEventCount)
      for (const event of snapshot.events) {
        state = applyDevLeadProjection(state, event)
        if (state.failure !== null) break
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `devlead: could not read cold lead "${leadId}" to derive the discard of answer "${messageId}": `
        + `${thrownMessage(error)}; deferred until the lead becomes live`,
      )
      this.deferAnswerDiscard(targetId, messageId, questionId, leadId, at)
      return
    }
    if (state.failure !== null) {
      this.deferAnswerDiscard(targetId, messageId, questionId, leadId, at)
      return
    }
    // The lead may have become live while the cold log was read: re-run the
    // live derivation so the newest durable state decides.
    if (this.ctx.sessions.get(toSessionId(leadId)) !== undefined) {
      this.discardPendingAnswer(targetId, messageId, questionId, leadId, at)
      return
    }
    const record = latestAnswerOf(state.answers, questionId)
    if (record === undefined || record.messageId !== messageId) return
    if (record.status === 'discarded' || record.status === 'failed') return
    this.rememberDerivedDiscard(record, at)
  }

  /**
   * Remember one discard derived from a durable admitted record and persist it
   * (queueing it when the lead log still cannot accept it). A newer tracked
   * answer of the same question is never clobbered.
   * @param record - the durable admitted answer record being discarded.
   * @param at - discard instant.
   */
  private rememberDerivedDiscard(record: DevLeadReportAnswer, at: number): void {
    const current = this.answers.entryOfQuestion(record.leadSessionId, record.reportId)
    if (current !== undefined && current.messageId !== record.messageId
      && current.answerSeq >= (record.answerSeq ?? 0)) return
    const discarded: DevLeadReportAnswer = {
      reportId: record.reportId,
      leadSessionId: record.leadSessionId,
      sessionId: record.sessionId,
      messageId: record.messageId,
      at,
      status: 'discarded',
      ...(record.answerSeq === undefined ? {} : { answerSeq: record.answerSeq }),
      textHash: record.textHash,
      answeredAt: record.answeredAt ?? record.at,
      ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
      ...(record.textExcerpt === undefined ? {} : { textExcerpt: record.textExcerpt }),
      ...(record.primitive === undefined ? {} : { primitive: record.primitive }),
      ...(record.boundary === undefined ? {} : { boundary: record.boundary }),
      ...(record.wakeRequested === undefined ? {} : { wakeRequested: record.wakeRequested }),
    }
    this.answers.remember({
      reportId: record.reportId,
      leadSessionId: record.leadSessionId,
      sessionId: record.sessionId,
      messageId: record.messageId,
      status: 'discarded',
      at,
      answerSeq: record.answerSeq ?? 0,
      firstAdmittedAt: record.answeredAt ?? record.at,
      ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
      textHash: record.textHash,
      ...(record.textExcerpt === undefined ? {} : { textExcerpt: record.textExcerpt }),
      primitive: record.primitive ?? 'steer',
      boundary: record.boundary ?? 'next-step',
      wakeRequested: record.wakeRequested ?? true,
    })
    void this.persistAnswerDiscard(discarded)
  }

  /**
   * Defer one discard derivation until its lead becomes live, bounded per lead
   * (newest kept, overflow warned).
   * @param targetId - child Session identity.
   * @param messageId - discarded answer message identity.
   * @param questionId - question report identity.
   * @param leadId - authoring lead Session identity.
   * @param at - discard instant.
   */
  private deferAnswerDiscard(targetId: string, messageId: string, questionId: string, leadId: string, at: number): void {
    const queue = this.deferredAnswerDiscards.get(leadId) ?? []
    const deduped = queue.filter(existing => !(existing.messageId === messageId && existing.questionId === questionId))
    deduped.push({ targetId, messageId, questionId, at })
    if (deduped.length > MAX_PENDING_ANSWER_DISCARDS) {
      const dropped = deduped.splice(0, deduped.length - MAX_PENDING_ANSWER_DISCARDS)
      this.ctx.logger.warn(
        `devlead: deferred answer discard derivations for lead "${leadId}" exceeded ${String(MAX_PENDING_ANSWER_DISCARDS)} entries; `
        + `dropped the ${String(dropped.length)} oldest — their questions may stay answered after a restart`,
      )
    }
    this.deferredAnswerDiscards.set(leadId, deduped)
  }

  /**
   * Observe one child Session log event for answer presentation and turn-end
   * reconciliation. A `user/message` carrying the answer's identity is the only
   * proof of presentation; a `turn/end` discards any claimed answer that never
   * became a `user/message` (a rejected pre-step). The durable child-log
   * observer runs alongside the live tracker: it reconstructs discards from the
   * inbox splices even when the tracker holds no entry (restart, cold lead).
   * @param session - child Session whose log grew.
   * @param event - the committed event.
   */
  private observeAnswerEvent(session: Session, event: SessionEvent): void {
    const sessionId = String(session.id)
    if (event.type === 'user/message') {
      const message = event.data
      const source = message.source as { kind?: unknown; questionId?: unknown } | undefined
      if (source?.kind === DEVLEAD_MESSAGE_KIND && typeof source.questionId === 'string') {
        this.answers.presented(sessionId, String(message.id), event.time)
      }
    } else if (event.type === 'turn/end') {
      for (const entry of this.answers.reconcileTurnEnd(sessionId, event.time)) {
        void this.writeAnswerDiscard(entry, entry.at)
      }
    }
    const existing = this.childAnswerObservers.get(sessionId)
    let derived: DerivedAnswerDiscard[]
    if (existing === undefined) {
      // First event of an unknown Session: the snapshot already includes this
      // event, so a full replay both initializes the observer and proves any
      // historical discards the live tracker never saw. When the log ends
      // inside this service's interrupt window, the restore has not happened
      // yet: surviving cancellation candidates must stay pending.
      derived = this.replayChildObserver(session)
    } else {
      derived = existing.observe(event, this.interrupting.has(sessionId))
    }
    for (const discard of derived) {
      this.discardPendingAnswer(sessionId, discard.messageId, discard.questionId, discard.leadId, discard.at)
    }
  }

  /** Build one child observer whose eviction warnings reach the Host logger. */
  private newChildObserver(sessionId: string): DevLeadChildAnswerObserver {
    return new DevLeadChildAnswerObserver(message => {
      this.ctx.logger.warn(`devlead: child answer observer for Session "${sessionId}": ${message}`)
    })
  }

  /** Store one child observer, FIFO-evicting beyond the bounded count. */
  private rememberChildObserver(sessionId: string, observer: DevLeadChildAnswerObserver): void {
    this.childAnswerObservers.delete(sessionId)
    this.childAnswerObservers.set(sessionId, observer)
    while (this.childAnswerObservers.size > MAX_CHILD_ANSWER_OBSERVERS) {
      const oldest = this.childAnswerObservers.keys().next().value
      if (oldest === undefined) break
      this.childAnswerObservers.delete(oldest)
      this.ctx.logger.warn(
        `devlead: evicted the answer-log observer of Session "${oldest}" beyond ${String(MAX_CHILD_ANSWER_OBSERVERS)} tracked Sessions; `
        + 'it will be rebuilt by replay when that Session becomes live again',
      )
    }
  }

  /**
   * Rebuild the durable answer-log observer of one Session by a full replay,
   * replacing any prior observation. Every activation replays: a child that
   * went live→cold→live again gained splices while cold that the previous
   * observer never saw. Cancellation candidates finalize unless the log ends
   * inside this service's interrupt window (the restore may still arrive).
   * @param session - Session whose inbox log is replayed.
   * @returns the discards the replay proves.
   */
  private replayChildObserver(session: Session): DerivedAnswerDiscard[] {
    const sessionId = String(session.id)
    const observer = this.newChildObserver(sessionId)
    const derived = observer.replay(session.snapshotEvents(), {
      finalizeCandidates: !this.interrupting.has(sessionId),
    })
    this.rememberChildObserver(sessionId, observer)
    return derived
  }

  /**
   * Seed the answer tracker from durable state when a Session becomes live, so
   * a restart resumes observing pending answers. Answers targeting this Session
   * are seeded from its watching leads; a lead's own authored answers are seeded
   * so their lifecycle can be observed and reconciled. The Session's durable
   * inbox log is also replayed to reconstruct discards the live tracker never
   * saw, deferred cold-lead derivations are resolved, and any queued discards
   * of this lead are drained.
   * @param agent - the newly live Agent.
   */
  private seedAnswersForAgent(agent: Agent): void {
    const sessionId = String(agent.id)
    // Reconstruct answer discards from this Session's durable inbox log: a
    // restart (or a cold lead) leaves the live tracker empty, but the splices
    // still prove which answers were canceled or consumed by a rejected
    // pre-step. Every activation replays the full log — a live→cold→live child
    // gained splices while cold that an earlier observer never saw.
    // Derivations are idempotent against the durable audit, and a canceled
    // answer that a keep/clear-own restore re-inserted is not discarded.
    const derived = this.replayChildObserver(agent.session)
    for (const discard of derived) {
      this.discardPendingAnswer(sessionId, discard.messageId, discard.questionId, discard.leadId, discard.at)
    }
    for (const leadId of this.hub?.supervisorsOf(sessionId) ?? []) {
      const leadSession = this.ctx.sessions.get(toSessionId(leadId))
      if (leadSession === undefined) continue
      const state = this.projectionHandle.stateOf(leadSession)
      if (state.failure !== null) continue
      // Seed only the newest record per question targeting this Session, so a
      // discarded answer seeds as discarded (question open) rather than replaying
      // an earlier admitted row.
      const latest = new Map<string, DevLeadReportAnswer>()
      for (const answer of state.answers) {
        const current = latest.get(answer.reportId)
        if (current === undefined || (answer.answerSeq ?? 0) >= (current.answerSeq ?? 0)) {
          latest.set(answer.reportId, answer)
        }
      }
      for (const answer of latest.values()) this.answers.seed(answer)
    }
    // This Session's inbox is now observable: drop queued discards of its
    // answers that reality disproves (restored/pending, claimed, or presented),
    // repair any tracker entry a stale queue row had marked discarded, and
    // repair stale durable discards its watching leads already appended.
    const supervisors = this.hub?.supervisorsOf(sessionId) ?? []
    const reconcile = this.reconcileQueuedDiscardsForChild(sessionId)
    for (const leadId of supervisors) {
      this.registerRepairBarrier(leadId, reconcile)
      this.registerRepairBarrier(leadId, this.repairDisprovenDurableDiscards(leadId))
    }
    const ownState = this.projectionHandle.stateOf(agent.session)
    if (ownState.failure === null && ownState.enabled) {
      const latest = new Map<string, DevLeadReportAnswer>()
      for (const answer of ownState.answers) {
        const current = latest.get(answer.reportId)
        if (current === undefined || (answer.answerSeq ?? 0) >= (current.answerSeq ?? 0)) {
          latest.set(answer.reportId, answer)
        }
      }
      for (const answer of latest.values()) this.answers.seed(answer)
    }
    // Discard derivations deferred while this lead was cold can now read its
    // live durable audit.
    const deferred = this.deferredAnswerDiscards.get(sessionId)
    if (deferred !== undefined) {
      this.deferredAnswerDiscards.delete(sessionId)
      for (const entry of deferred) {
        this.discardPendingAnswer(entry.targetId, entry.messageId, entry.questionId, sessionId, entry.at)
      }
    }
    // Durable-discard repairs deferred while this lead was cold (or after a
    // failed append/flush) can now reach its log; and any stale durable discard
    // whose answer the child's reality disproves is repaired even without a
    // queued row (the false-discard-already-drained restart path).
    this.registerRepairBarrier(sessionId, this.processDeferredDiscardRepairs(sessionId))
    this.registerRepairBarrier(sessionId, this.repairDisprovenDurableDiscards(sessionId))
    // The lead log is live now: drain any discards queued while it was cold (or
    // after a failed append/flush). This runs even when the mode is currently
    // disabled, so a disabled→enabled transition never strands the queue.
    void this.reconcileAnswerDiscards(sessionId)
  }

  /**
   * Ask every composed `workspace/session-stop` provider to stop one Session's
   * running work. This is the same fan-out archive `stopActivity` uses, without
   * the archive write: the Agent registry cancels the running turn, the job
   * registry kills owned jobs, the subagent runtime cancels running
   * descendants, and the schedule plugin removes active schedule rows.
   * Provider failures are logged and never block the replacement prompt; the
   * cancellation itself is fire-and-forget, so this method does not wait for
   * the stopped work to settle.
   * @param sessionId - Session whose running work should stop.
   */
  private async stopSessionActivity(sessionId: ReturnType<typeof toSessionId>): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error: unknown) {
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger.warn(
          `devlead: stopping Session "${String(sessionId)}" for prompt interrupt failed: ${thrownMessage(failure)}`,
        )
      }
    }
  }

  /**
   * Replace one lead's watch set with one Session added or removed.
   * @param agent - exact live lead Agent.
   * @param sessionId - target Session identity.
   * @param watching - whether to include the Session.
   * @param signal - cancellation checked before the write.
   * @param reservedSlot - the caller already holds a watch reservation for this
   *   lead (the create path), so the capacity check must not count it again.
   * @returns the resulting watch mutation.
   */
  private async setWatching(
    agent: Agent,
    sessionId: ReturnType<typeof toSessionId>,
    watching: boolean,
    signal?: AbortSignal,
    reservedSlot = false,
  ): Promise<DevLeadWatchMutation> {
    signal?.throwIfAborted()
    const id = String(sessionId)
    // Every automatic watch path (create, prompt) funnels through here, so the
    // self-watch rejection cannot be bypassed by a convenience default.
    if (id === String(agent.id)) {
      throw new DevLeadError('a DevLead Session cannot watch itself', 'DEVLEAD_SELF_WATCH')
    }
    const state = this.strictStateOf(agent.session)
    const present = state.sessions.includes(id)
    if (present === watching) {
      return { sessionId: id, watched: present, sessions: state.sessions }
    }
    if (watching && !reservedSlot) this.assertWatchCapacity(agent)
    const next = watching
      ? [...state.sessions, id]
      : state.sessions.filter(existing => existing !== id)
    appendPluginRecord(agent.session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(next, Date.now()))
    await this.flushDurably(agent.session, `watch set for lead "${agent.id}"`)
    await this.checkpointProjectionCache(agent.session, `watch set for lead "${agent.id}"`)
    if (watching) void this.replayOutbox()
    return { sessionId: id, watched: watching, sessions: next }
  }
}

export default DevLeadService
