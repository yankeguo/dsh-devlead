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
  DEVLEAD_QUESTIONS_MAX,
  DEVLEAD_QUESTION_FIELD_MAX,
  DEVLEAD_QUESTION_OPTIONS_MAX,
  DEVLEAD_REPORT_MAX_PER_TURN,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_SUMMARY_MAX,
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
  DevLeadPromptedSession,
  DevLeadPromptSessionOptions,
  DevLeadQueuedInput,
  DevLeadQuestion,
  DevLeadQuestionOption,
  DevLeadReport,
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
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  createDevLeadPromptMessage,
  devLeadReport,
  modeRecord,
  resetRecord,
  watchRecord,
} from './domain.ts'
import {
  agentTeamsCapabilityOf,
  devLeadModelCatalogOf,
  modelCatalogCapabilityOf,
  modelSelectionLabel,
  modelValidatorOf,
  normalizeModelSelection,
} from './dispatch.ts'
import type { AgentTeamsCapability, NormalizedModelSelection } from './dispatch.ts'
import { DevLeadError, thrownMessage } from './error.ts'
import { isOwnRelay, keptInputsOf, queuedInputsOf, restoreInputs } from './inbox.ts'
import { DevLeadReportOutbox } from './outbox.ts'
import {
  applyDevLeadProjection,
  devLeadModeProjectionDefinition,
  devLeadProjectionDefinition,
  devLeadWatchProjectionDefinition,
  devLeadProjectionView,
  emptyDevLeadProjectionState,
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
    await this.openOutbox()
    if (this.outbox === undefined) {
      // The storage facility often mounts after the DevLead service in the
      // default composition. Retry once it becomes available, then replay any
      // rows that were already written by an earlier Host incarnation.
      this.outboxInjection = this.ctx.inject(['storageDomain' as never], () => {
        void this.openOutbox().then(() => this.replayOutbox())
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
   * marker: undelivered outbox reports and the in-process archived-holder
   * tombstone mirror. Both `reset()` and the frozen-fold `setEnabled(false)`
   * recovery are resets semantically, so they must drop the same rows.
   * @param sessionId - lead Session identity whose queued reports are discarded.
   */
  private async discardLeadReportState(sessionId: string): Promise<void> {
    await this.outbox?.dropForLead(sessionId)
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
    return target === undefined ? undefined : queuedInputsOf(target)
  }

  /**
   * Withdraw one queued inbox input this lead Session authored.
   *
   * Only the lead's own relay prompts are retractable: a human's queued
   * instruction is the human's intent, a scheduled wake belongs to the
   * schedule plugin, and another lead's relay belongs to that lead. The call
   * is idempotent — an input already consumed or withdrawn reports
   * `retracted: false`. The target must be live (the inbox is driver-owned)
   * and cannot be the lead itself.
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
    if (!isOwnRelay(pending, String(agent.id))) {
      throw new DevLeadError(
        `queued input "${inputId}" was not authored by this DevLead Session; only your own relay prompts can be `
        + 'retracted — human, scheduled, and other producers\' inputs are not yours to remove',
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
   * `interrupt: true` explicitly replaces the Session's current work: when its
   * Agent is running, the Host's `workspace/session-stop` providers are asked
   * to stop the turn (and the subagent/job/schedule work they report) before
   * the prompt is admitted. The stop is fire-and-forget; the replacement
   * prompt is queued for the next turn and starts once the aborted turn
   * converges, so it can never join the cancelling turn. An idle or cold
   * Session skips the stop entirely.
   * @param agent - exact live lead Agent.
   * @param sessionId - Session id or unique prefix.
   * @param prompt - non-empty prompt text.
   * @param options - watch policy, interrupt policy, and cancellation checked
   *   between stages. Cancellation after an interrupt was requested does not
   *   roll the stop back; the replacement prompt is admitted with it.
   * @returns the admitted prompt receipt.
   * @throws {@link DevLeadError} when the Session is missing, archived, or cannot be resumed.
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
    const deps = this.viewDeps(agent, signal)
    const resolved = await resolveSessionReference(deps, sessionId)
    signal?.throwIfAborted()
    if (String(resolved.sessionId) === String(agent.id)) {
      throw new DevLeadError(
        'a DevLead Session cannot prompt itself; end this turn and continue from a new human turn',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    this.assertNotArchived(resolved.sessionId)
    // Validate the cold-resume capability before the watch mutation, so a Host
    // that cannot resume the Session does not leave a half-applied watch.
    if (!resolved.live && this.ctx.get('sessionController') === undefined) {
      throw new DevLeadError(
        `Session "${resolved.sessionId}" is not live and this Host composes no Session activator, so it cannot be prompted`,
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    const watch = options.watch ?? true
    // Watch before admission: a very fast child turn/end must not settle before
    // the watch commits, or the first wake is lost. The trade-off is that a
    // failed/cancelled admission can leave the watch behind, so this call
    // compensates exactly the watch it added — a pre-existing explicit watch is
    // the caller's state and is never undone.
    const alreadyWatched = this.strictStateOf(agent.session).sessions.includes(String(resolved.sessionId))
    const added = watch && !alreadyWatched
    if (added) await this.setWatching(agent, resolved.sessionId, true, signal)
    let admission: PromptAdmission
    try {
      admission = await this.admitPrompt(agent, resolved.sessionId, text, {
        allowResume: true,
        interrupt: options.interrupt ?? false,
        interruptInbox: options.interruptInbox ?? 'clear-all',
        signal,
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
            `devlead: could not roll back the automatic watch for Session "${String(resolved.sessionId)}": `
            + thrownMessage(compensateError),
          )
        }
      }
      throw error
    }
    return {
      sessionId: String(resolved.sessionId),
      watched: this.strictStateOf(agent.session).sessions.includes(String(resolved.sessionId)),
      resumed: admission.resumed,
      interrupted: admission.interrupted,
      ...(admission.retainedInputs === undefined ? {} : { retainedInputs: admission.retainedInputs }),
    }
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
   * succeeded; otherwise the report remains replayable.
   * @param report - validated report.
   * @returns the child-facing receipt with durability status.
   */
  private async deliverReport(report: DevLeadReport): Promise<DevLeadReportReceipt> {
    await this.pruneOutboxOpportunistically()
    const outboxed = this.outbox === undefined ? false : await this.outbox.put(report)
    if (outboxed && this.outbox !== undefined) {
      let delivered = false
      try {
        delivered = (await this.hub?.persistReport(report)) ?? false
      } catch (error: unknown) {
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
   *   and `DEVLEAD_REPORT_RATE_LIMITED` when the per-turn budget is exhausted.
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
    if (duplicate !== undefined) return duplicate
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

  /** Reject a Session the Workspace registry lists as archived. */
  private assertNotArchived(sessionId: ReturnType<typeof toSessionId>): void {
    const archived = this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(sessionId) ?? false
    if (archived) {
      throw new DevLeadError(
        `Session "${sessionId}" is archived; restore it from the Workspace sidebar before continuing it`,
        'DEVLEAD_SESSION_ARCHIVED',
      )
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
   * Admit one lead-authored prompt into a Session, resuming a cold Session.
   *
   * `interrupt` is evaluated only against a live running Agent. The Host's
   * `workspace/session-stop` providers are the same fan-out archive
   * `stopActivity` uses; they cancel the turn and stop the Session's reported
   * subagent/job/schedule work. The stop is fire-and-forget: `followup` is
   * admitted immediately afterwards, and the Agent reclassifies a wake after
   * an aborted phase to the next turn and latches it until the aborted
   * activity converges, so the prompt cannot enter the cancelling turn. No
   * settlement wait is needed. The inbox retention restore is best-effort: a
   * failed restore is a warning, and the replacement prompt is admitted anyway
   * because the stop cannot be rolled back.
   * @param leadAgent - exact live lead Agent.
   * @param sessionId - target Session identity.
   * @param text - non-empty prompt text.
   * @param options - resume policy, interrupt policy, and cancellation checked
   *   before each stage. Once an interrupt is requested, cancellation does not
   *   roll it back; the replacement prompt is admitted with the stop.
   * @returns whether the Host resumed a cold Session and whether it was asked
   *   to interrupt a running turn.
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
    let interrupted = false
    let retainedInputs: number | undefined
    if (options.interrupt && target.status === 'running') {
      // This is the last cancellation point: once the stop providers are asked
      // to cancel the child, the replacement prompt is committed with the stop
      // rather than leaving a stopped Session without its new instruction.
      interrupted = true
      // The stop providers always clear the inbox, so a retention policy is a
      // snapshot before the stop and a restore of the same identified messages
      // after it — never a veto of the stop itself.
      const kept = keptInputsOf(target, String(leadAgent.id), options.interruptInbox)
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
    }
    try {
      target.followup(createDevLeadPromptMessage(text, leadAgent))
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
    return { resumed, interrupted, ...(retainedInputs === undefined ? {} : { retainedInputs }) }
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
