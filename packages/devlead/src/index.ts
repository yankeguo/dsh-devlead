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
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { DEVLEAD_DEFAULT_MAX_WATCHED } from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadCreatedSession,
  DevLeadCreateSessionRequest,
  DevLeadIsolation,
  DevLeadIsolationMode,
  DevLeadNotification,
  DevLeadProjection,
  DevLeadProjectionState,
  DevLeadPromptedSession,
  DevLeadSessionView,
  DevLeadUseWorkspaceRequest,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  createDevLeadPromptMessage,
  modeRecord,
  resetRecord,
  watchRecord,
} from './domain.ts'
import { DevLeadError, thrownMessage } from './error.ts'
import {
  applyDevLeadProjection,
  devLeadModeProjectionDefinition,
  devLeadProjectionDefinition,
  devLeadProjectionView,
  emptyDevLeadProjectionState,
} from './fold.ts'
import { worktreeCapabilityOf, worktreeCheckoutOf } from './isolation.ts'
import { DevLeadNotificationHub } from './notification.ts'
import type { DevLeadPersistedLead } from './notification.ts'
import { persistedSessionsOf } from './persistence.ts'
import { devLeadPrefilterOf, projectionCacheOf } from './projection-cache.ts'
import {
  collectSessionIds,
  devLeadSessionView,
  devLeadSessionViews,
  devLeadWorkspaceView,
  rankSessionIds,
  readSessionFacts,
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
  devLeadModeProjectionDefinition,
  devLeadModeProjectionSchema,
  devLeadModeProjectionStateSchema,
  devLeadModeProjectionView,
  devLeadProjectionDefinition,
  devLeadProjectionSchema,
  devLeadProjectionStateSchema,
  devLeadProjectionView,
  emptyDevLeadModeProjectionState,
  emptyDevLeadProjectionState,
} from './fold.ts'
export type { DevLeadModeProjectionState } from './fold.ts'
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
    this.hub = new DevLeadNotificationHub(
      this.ctx,
      session => this.projectionHandle.stateOf(session),
      { batchMs: this.resolved.notificationBatchMs, wakeColdSession: this.resolved.wakeColdSession },
    )
    this.hub.start()
    // The readiness retry machinery outlives init; make sure a plugin unload
    // clears its timers/fibers even while a rehydration is still pending.
    this.ctx.effect(function* (this: DevLeadService) {
      yield () => this.disposeRehydrationRetry()
    }.bind(this), 'devlead: cold rehydration')
    await this.rehydrateFromPersistence()
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
    if (this.rehydrated) return
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
    if (this.rehydrated) return
    try {
      this.hub.rehydrate(await this.persistedLeadRecords(true))
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: cold lead rehydration failed: ${thrownMessage(error)}`)
    }
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
    let probe = await persistedSessionsOf(this.ctx)
    while (probe.verifiable && probe.ids === undefined && Date.now() < deadline) {
      await new Promise<void>((resolve) => { setTimeout(resolve, REHYDRATION_READINESS_POLL_MS) })
      probe = await persistedSessionsOf(this.ctx)
    }
    const ids = probe.ids
    if (ids === undefined) return
    if (ids.size === 0) return
    let consistent = false
    while (Date.now() < deadline) {
      const listed = await this.listedPersistedSessionIds()
      if (this.containsAllSessionIds(listed, ids)) {
        consistent = true
        break
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, REHYDRATION_READINESS_POLL_MS) })
    }
    if (!consistent) {
      // One last check: the corpus may have become consistent during the final
      // poll's wait.
      consistent = this.containsAllSessionIds(await this.listedPersistedSessionIds(), ids)
    }
    if (!consistent) {
      this.ctx.logger.warn(
        'devlead: the persisted Session corpus is still warming up; cold lead rehydration proceeds best-effort',
      )
    }
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
   * @returns the visible persisted Session ids.
   */
  private async listedPersistedSessionIds(): Promise<ReadonlySet<string>> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return new Set()
    try {
      const records = await query.listSessions()
      return new Set(
        records
          .filter(record => record.persisted)
          .map(record => String(record.header.id)),
      )
    } catch (error: unknown) {
      this.ctx.logger.debug(`devlead: corpus readiness listing failed: ${thrownMessage(error)}`)
      return new Set()
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
   * Whether DevLead mode is selected for one exact live Agent.
   * @param agent - candidate lead Agent.
   * @returns whether the durable mode is enabled for that Agent's Session.
   */
  isEnabled(agent: Agent): boolean {
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
   * `/devlead` command and the browser switch, never a model tool.
   * @param agent - exact live Session Agent receiving the selection.
   * @param enabled - selected mode.
   * @param signal - cancellation checked before the write.
   * @returns fulfillment after the committed selection's durability checkpoint
   *   was attempted (a host without a persistence participant keeps it in memory).
   * @throws {@link DevLeadError} when the Agent is not live or the replay failed.
   */
  async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void> {
    this.assertLive(agent)
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
      return
    }
    if (current.enabled === enabled) return
    appendPluginRecord(agent.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(enabled, Date.now()))
    await this.flushDurably(agent.session, `DevLead mode for Session "${agent.id}"`)
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
    this.assertLive(agent)
    signal?.throwIfAborted()
    this.appendResetRecord(agent.session)
    await this.flushDurably(agent.session, `DevLead reset for Session "${agent.id}"`)
  }

  /**
   * Append one reset marker to a Session log.
   * @param session - Session whose DevLead state is discarded.
   */
  private appendResetRecord(session: Session): void {
    appendPluginRecord(session, DEVLEAD_RESET_RECORD_TYPE, resetRecord(Date.now()))
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
    const facts = await readSessionFacts(deps, ids)
    signal?.throwIfAborted()
    const retained = rankSessionIds(deps, ids, facts, limit)
    return await devLeadSessionViews(deps, retained, false, facts)
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
   * @param agent - exact live lead Agent.
   * @param request - Workspace, optional title, initial prompt, watch policy,
   *   preset, and checkout isolation mode.
   * @param signal - cancellation checked between stages and threaded into the
   *   worktree creation.
   * @returns the created Session, the Workspace it joined, and the
   *   checkout-isolation outcome.
   * @throws {@link DevLeadError} when the mode is off, the Host cannot create
   *   Sessions, or the destination is not usable.
   */
  async createSession(
    agent: Agent,
    request: DevLeadCreateSessionRequest,
    signal?: AbortSignal,
  ): Promise<DevLeadCreatedSession> {
    this.assertReady(agent)
    signal?.throwIfAborted()
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new DevLeadError(
        'this Host cannot create Sessions: no API Session controller is composed',
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
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
        await this.admitPrompt(agent, created.sessionId, prompt, false, signal)
      }
      const deps = this.viewDeps(agent, signal)
      return {
        session: await devLeadSessionView(deps, sessionId, true),
        workspace: await devLeadWorkspaceView(workspace),
        prompted,
        isolation,
      }
    } finally {
      releaseWatch?.()
    }
  }

  /**
   * Admit one prompt into an existing Session, resuming a cold Session and
   * watching it by default.
   * @param agent - exact live lead Agent.
   * @param sessionId - Session id or unique prefix.
   * @param prompt - non-empty prompt text.
   * @param options - optional watch policy (default watches) and cancellation
   *   checked between stages.
   * @returns the admitted prompt receipt.
   * @throws {@link DevLeadError} when the Session is missing, archived, or cannot be resumed.
   */
  async promptSession(
    agent: Agent,
    sessionId: string,
    prompt: string,
    options: { watch?: boolean; signal?: AbortSignal } = {},
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
    let resumed: boolean
    try {
      resumed = await this.admitPrompt(agent, resolved.sessionId, text, true, signal)
    } catch (error: unknown) {
      if (added) {
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
      resumed,
    }
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
  private async persistedLeadRecords(scanPersisted: boolean): Promise<DevLeadPersistedLead[]> {
    const leads = new Map<string, readonly string[]>()
    const remember = (sessionId: string, sessions: readonly string[]): void => {
      if (sessionId.length === 0 || sessions.length === 0) return
      leads.set(sessionId, [...sessions])
    }
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
      return [...leads].map(([sessionId, watched]) => ({ sessionId, watched }))
    }
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return [...leads].map(([sessionId, watched]) => ({ sessionId, watched }))
    const cache = projectionCacheOf(this.ctx)
    if (cache === undefined) {
      this.ctx.logger.warn(
        'devlead: this Host composes no Session projection cache, so cold lead rehydration reads no persisted logs; '
        + 'only live lead Sessions are rehydrated',
      )
      return [...leads].map(([sessionId, watched]) => ({ sessionId, watched }))
    }
    let records: PersistedSessionRecord[]
    try {
      records = await query.listSessions()
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not list persisted Sessions for cold lead rehydration: ${thrownMessage(error)}`)
      return [...leads].map(([sessionId, watched]) => ({ sessionId, watched }))
    }
    let unknownReads = 0
    let capped = false
    let warnedCorrupt = false
    let warnedRead = false
    for (const record of records) {
      const sessionId = String(record.header.id)
      if (leads.has(sessionId) || record.live) continue
      if (record.header.origin === 'subagent') continue
      const prefilter = devLeadPrefilterOf(cache, record.header)
      if (prefilter === 'not-lead') continue
      if (prefilter === 'unknown') {
        if (unknownReads >= MAX_COLD_LEAD_LOG_READS) {
          capped = true
          continue
        }
        unknownReads += 1
      }
      let events: readonly SessionEvent[]
      try {
        events = (await query.readSession(record.header.id)).events
      } catch (error: unknown) {
        if (!warnedRead) {
          warnedRead = true
          this.ctx.logger.warn(`devlead: could not read a cold lead candidate Session log: ${thrownMessage(error)}`)
        }
        continue
      }
      let state = emptyDevLeadProjectionState()
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
      if (state.enabled) remember(sessionId, state.sessions)
    }
    if (capped) {
      this.ctx.logger.warn(
        `devlead: cold lead rehydration stopped reading unclassified Session logs after ${MAX_COLD_LEAD_LOG_READS}; `
        + 'compose projection cache rows to restore leads beyond that bound',
      )
    }
    return [...leads].map(([sessionId, watched]) => ({ sessionId, watched }))
  }

  /** Require the Workspace registry capability. */
  private requireWorkspaceRegistry(): WorkspaceRegistry {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      throw new DevLeadError(
        'this Host composes no Workspace registry, so Workspaces cannot be managed',
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
   * @param reference - requested Workspace id or path.
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
   * Admit one lead-authored prompt into a Session, resuming a cold Session.
   * @param leadAgent - exact live lead Agent.
   * @param sessionId - target Session identity.
   * @param text - non-empty prompt text.
   * @param allowResume - whether a cold Session may be resumed.
   * @param signal - cancellation checked before the resume and the admission.
   * @returns whether the Host resumed a cold Session.
   */
  private async admitPrompt(
    leadAgent: Agent,
    sessionId: ReturnType<typeof toSessionId>,
    text: string,
    allowResume: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted()
    let target = this.ctx.agents.get(sessionId)
    let resumed = false
    if (target === undefined) {
      if (!allowResume) {
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
    try {
      target.followup(createDevLeadPromptMessage(text, leadAgent))
    } catch (error: unknown) {
      throw new DevLeadError(
        `could not admit a prompt into Session "${sessionId}": ${thrownMessage(error)}`,
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    await this.flushDurably(target.session, `prompt into Session "${sessionId}"`)
    return resumed
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
    return { sessionId: id, watched: watching, sessions: next }
  }
}

export default DevLeadService
