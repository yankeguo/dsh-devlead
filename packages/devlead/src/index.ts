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

import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { DEVLEAD_DEFAULT_MAX_WATCHED } from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadCreatedSession,
  DevLeadCreateSessionRequest,
  DevLeadNotification,
  DevLeadProjection,
  DevLeadProjectionState,
  DevLeadPromptedSession,
  DevLeadSessionView,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  createDevLeadPromptMessage,
  modeRecord,
  watchRecord,
} from './domain.ts'
import { DevLeadError } from './error.ts'
import { devLeadProjectionDefinition, devLeadProjectionView } from './fold.ts'
import { DevLeadNotificationHub } from './notification.ts'
import {
  collectSessionIds,
  devLeadSessionView,
  devLeadSessionViews,
  devLeadWorkspaceView,
  resolveSessionReference,
  resolveWorkspaceReference,
  type DevLeadViewDeps,
} from './views.ts'

export type * from '@yankeguo/dsh-devlead-protocol'
export * from './domain.ts'
export { DevLeadError, isDevLeadError } from './error.ts'
export type { DevLeadErrorCode } from './error.ts'
export {
  applyDevLeadProjection,
  devLeadProjectionDefinition,
  devLeadProjectionSchema,
  devLeadProjectionStateSchema,
  devLeadProjectionView,
  emptyDevLeadProjectionState,
} from './fold.ts'
export { renderDevLeadNotice } from './notification.ts'
export type { DevLeadNotificationConfig } from './notification.ts'

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
  /** Whether a cold lead Session is resumed to receive its notification digest. */
  wakeColdSession?: boolean
  /** Agent preset used by Sessions this lead creates when the request names none. */
  defaultAgentPreset?: string
}

/** Loader schema for the DevLead core service. */
export const Config: z<Config> = z.object({
  notificationBatchMs: z.number().step(1).min(0).default(400),
  maxWatchedSessions: z.number().step(1).min(1).default(DEVLEAD_DEFAULT_MAX_WATCHED),
  maxListedSessions: z.number().step(1).min(1).default(200),
  wakeColdSession: z.boolean().default(false),
  defaultAgentPreset: z.string().default(''),
})

/** Fully materialized deployment configuration. */
interface ResolvedConfig {
  readonly notificationBatchMs: number
  readonly maxWatchedSessions: number
  readonly maxListedSessions: number
  readonly wakeColdSession: boolean
  readonly defaultAgentPreset: string | undefined
}

/**
 * Validate one materialized configuration, so a direct construction outside
 * Loader normalization fails the same way.
 * @param config - raw configuration.
 * @returns resolved configuration.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const notificationBatchMs = config.notificationBatchMs ?? 400
  if (!Number.isSafeInteger(notificationBatchMs) || notificationBatchMs < 0) {
    throw new TypeError('notificationBatchMs must be a non-negative safe integer')
  }
  const maxWatchedSessions = config.maxWatchedSessions ?? DEVLEAD_DEFAULT_MAX_WATCHED
  if (!Number.isSafeInteger(maxWatchedSessions) || maxWatchedSessions < 1) {
    throw new TypeError('maxWatchedSessions must be a positive safe integer')
  }
  const maxListedSessions = config.maxListedSessions ?? 200
  if (!Number.isSafeInteger(maxListedSessions) || maxListedSessions < 1) {
    throw new TypeError('maxListedSessions must be a positive safe integer')
  }
  const wakeColdSession = config.wakeColdSession ?? false
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

/** Render any thrown value for a domain failure message. */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  private readonly resolved: ResolvedConfig

  /** Awaited registration of the `devLead` projection unit. */
  private projectionHandle!: ProjectionHandle<DevLeadProjectionState>

  /** Watched-session notification hub, started with the service. */
  private hub!: DevLeadNotificationHub

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
    this.hub = new DevLeadNotificationHub(
      this.ctx,
      session => this.projectionHandle.stateOf(session),
      { batchMs: this.resolved.notificationBatchMs, wakeColdSession: this.resolved.wakeColdSession },
    )
    this.hub.start()
  }

  /** Deployment configuration after validation; read-only. */
  get settings(): Readonly<ResolvedConfig> {
    return this.resolved
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
   * @returns fulfillment after the selection is durable.
   * @throws {@link DevLeadError} when the Agent is not live or the replay failed.
   */
  async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void> {
    this.assertLive(agent)
    signal?.throwIfAborted()
    const current = this.strictStateOf(agent.session)
    if (current.enabled === enabled) return
    appendPluginRecord(agent.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(enabled, Date.now()))
    const flushed = await this.ctx.sessions.flush(agent.session)
    if (!flushed) {
      this.ctx.logger.warn(`devlead: DevLead mode for Session "${agent.id}" was not flushed to persistence`)
    }
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
   * Register an existing directory as a Workspace, creating a missing
   * directory first when allowed.
   * @param path - fully qualified directory path.
   * @param options - optional title and missing-directory policy (default creates).
   * @returns the registered or existing Workspace view.
   * @throws {@link DevLeadError} when the path is not usable.
   */
  async useWorkspace(
    path: string,
    options: { title?: string; create?: boolean; signal?: AbortSignal } = {},
  ): Promise<DevLeadWorkspaceView> {
    const trimmed = path.trim()
    if (trimmed.length === 0) throw new DevLeadError('a directory path is required', 'DEVLEAD_INVALID_INPUT')
    if (!isAbsolute(trimmed)) {
      throw new DevLeadError(`"${trimmed}" is not a fully qualified path`, 'DEVLEAD_INVALID_INPUT')
    }
    options.signal?.throwIfAborted()
    const create = options.create ?? true
    const exists = await stat(trimmed).then(() => true, () => false)
    if (!exists) {
      if (!create) {
        throw new DevLeadError(`directory "${trimmed}" does not exist`, 'DEVLEAD_DIRECTORY_MISSING')
      }
      try {
        await mkdir(trimmed, { recursive: true })
      } catch (error: unknown) {
        throw new DevLeadError(
          `could not create directory "${trimmed}": ${renderThrown(error)}`,
          'DEVLEAD_DIRECTORY_MISSING',
        )
      }
    }
    const registry = this.requireWorkspaceRegistry()
    let workspace: Workspace
    try {
      workspace = await registry.create(trimmed, options.title)
    } catch (error: unknown) {
      throw new DevLeadError(
        `could not register "${trimmed}" as a Workspace: ${renderThrown(error)}`,
        'DEVLEAD_DIRECTORY_MISSING',
      )
    }
    return await devLeadWorkspaceView(workspace)
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * List Sessions this lead can address.
   * @param options - optional Workspace filter, watch-only filter, and row limit.
   * @param signal - cancellation checked between rows.
   * @returns detached Session views, watched and running rows first.
   */
  async listSessions(
    agent: Agent,
    options: { workspace?: string; watchedOnly?: boolean; limit?: number; signal?: AbortSignal } = {},
    signal?: AbortSignal,
  ): Promise<DevLeadSessionView[]> {
    this.assertLive(agent)
    const deps = this.viewDeps(agent)
    signal?.throwIfAborted()
    let ids: string[]
    if (options.workspace !== undefined && options.workspace.trim().length > 0) {
      const workspace = await resolveWorkspaceReference(this.ctx, options.workspace)
      ids = await collectSessionIds(deps, workspace)
    } else {
      ids = await collectSessionIds(deps, undefined)
    }
    if (options.watchedOnly === true) ids = ids.filter(id => deps.isWatched(id))
    const limit = options.limit ?? this.resolved.maxListedSessions
    const views = await devLeadSessionViews(deps, ids, false)
    // Priority ordering must precede the row cap: slicing first could drop a
    // watched or running Session that the caller most needs to see.
    views.sort((left, right) => {
      if (left.watched !== right.watched) return left.watched ? -1 : 1
      if (left.running !== right.running) return left.running ? -1 : 1
      return (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0)
        || left.sessionId.localeCompare(right.sessionId)
    })
    return views.slice(0, Math.max(1, limit))
  }

  /**
   * Read one Session in detail, including folded turn and assistant facts.
   * @param sessionId - Session id or unique prefix.
   * @param signal - cancellation checked before the log read.
   * @returns the detached Session view.
   * @throws {@link DevLeadError} when the reference is missing or ambiguous.
   */
  async getSession(agent: Agent, sessionId: string, signal?: AbortSignal): Promise<DevLeadSessionView> {
    this.assertLive(agent)
    const deps = this.viewDeps(agent)
    const resolved = await resolveSessionReference(deps, sessionId)
    signal?.throwIfAborted()
    return await devLeadSessionView(deps, String(resolved.sessionId), true)
  }

  /**
   * Create one ordinary Session in a Workspace and optionally prompt it.
   * @param agent - exact live lead Agent.
   * @param request - Workspace, optional title, initial prompt, watch policy, and preset.
   * @returns the created Session and the Workspace it joined.
   * @throws {@link DevLeadError} when the mode is off, the Host cannot create
   *   Sessions, or the destination is not usable.
   */
  async createSession(agent: Agent, request: DevLeadCreateSessionRequest): Promise<DevLeadCreatedSession> {
    this.assertReady(agent)
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new DevLeadError(
        'this Host cannot create Sessions: no API Session controller is composed',
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    const workspace = await this.createTargetWorkspace(agent, request.workspace)
    const preset = request.preset?.trim() ?? this.resolved.defaultAgentPreset
    let created: SessionCreateValue
    try {
      created = await controller.create({
        workspaceId: workspace.id,
        ...(preset === undefined || preset.length === 0 ? {} : { agentPreset: preset }),
      })
    } catch (error: unknown) {
      throw this.sessionUnavailable(`could not create a Session in "${workspace.title}": ${renderThrown(error)}`, error)
    }
    const sessionId = String(created.sessionId)
    if (request.title !== undefined && request.title.trim().length > 0) {
      this.tryRename(created.sessionId, request.title.trim())
    }
    const watch = request.watch ?? true
    if (watch) await this.setWatching(agent, created.sessionId, true)
    const prompt = request.prompt?.trim() ?? ''
    const prompted = prompt.length > 0
    if (prompted) {
      await this.admitPrompt(agent, created.sessionId, prompt, false)
    }
    const deps = this.viewDeps(agent)
    return {
      session: await devLeadSessionView(deps, sessionId, true),
      workspace: await devLeadWorkspaceView(workspace),
      prompted,
    }
  }

  /**
   * Admit one prompt into an existing Session, resuming a cold Session and
   * watching it by default.
   * @param agent - exact live lead Agent.
   * @param sessionId - Session id or unique prefix.
   * @param prompt - non-empty prompt text.
   * @param options - optional watch policy (default watches).
   * @returns the admitted prompt receipt.
   * @throws {@link DevLeadError} when the Session is missing, archived, or cannot be resumed.
   */
  async promptSession(
    agent: Agent,
    sessionId: string,
    prompt: string,
    options: { watch?: boolean } = {},
  ): Promise<DevLeadPromptedSession> {
    this.assertReady(agent)
    const text = prompt.trim()
    if (text.length === 0) throw new DevLeadError('a non-empty prompt is required', 'DEVLEAD_INVALID_INPUT')
    const deps = this.viewDeps(agent)
    const resolved = await resolveSessionReference(deps, sessionId)
    if (String(resolved.sessionId) === String(agent.id)) {
      throw new DevLeadError(
        'a DevLead Session cannot prompt itself; end this turn and continue from a new human turn',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    this.assertNotArchived(resolved.sessionId)
    const watch = options.watch ?? true
    if (watch) await this.setWatching(agent, resolved.sessionId, true)
    const resumed = await this.admitPrompt(agent, resolved.sessionId, text, true)
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
   * @returns the resulting watch mutation.
   * @throws {@link DevLeadError} when the Session is missing, self-addressed, or over the limit.
   */
  async watchSession(agent: Agent, sessionId: string, watching: boolean): Promise<DevLeadWatchMutation> {
    this.assertReady(agent)
    const deps = this.viewDeps(agent)
    const resolved = await resolveSessionReference(deps, sessionId)
    if (String(resolved.sessionId) === String(agent.id)) {
      throw new DevLeadError('a DevLead Session cannot watch itself', 'DEVLEAD_SELF_WATCH')
    }
    return await this.setWatching(agent, resolved.sessionId, watching)
  }

  /**
   * Read the retained notification digest of one live lead Session.
   * @param agent - exact live lead Agent.
   * @param options - maximum rows (newest last).
   * @returns retained notifications, oldest first.
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
      throw new DevLeadError(`agent "${agent.id}" is not live in this registry`, 'DEVLEAD_AGENT_NOT_LIVE')
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

  /** Build the read-side dependency bundle for one live lead Agent. */
  private viewDeps(agent: Agent): DevLeadViewDeps {
    const state = this.strictStateOf(agent.session)
    return {
      ctx: this.ctx,
      maxListedSessions: this.resolved.maxListedSessions,
      watchedSessions: state.sessions,
      isWatched: sessionId => state.sessions.includes(sessionId),
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
    return await registry.create(cwd)
  }

  /** Rename a freshly created Session, logging a failure instead of aborting creation. */
  private tryRename(sessionId: ReturnType<typeof toSessionId>, title: string): void {
    const titles = this.ctx.get('sessionTitle')
    const session = this.ctx.sessions.get(sessionId)
    if (titles === undefined || session === undefined) return
    try {
      titles.rename(session, title)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: Session "${sessionId}" was not renamed: ${renderThrown(error)}`)
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
   * @returns whether the Host resumed a cold Session.
   */
  private async admitPrompt(
    leadAgent: Agent,
    sessionId: ReturnType<typeof toSessionId>,
    text: string,
    allowResume: boolean,
  ): Promise<boolean> {
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
          `could not resume Session "${sessionId}": ${renderThrown(error)}`,
          'DEVLEAD_SESSION_UNAVAILABLE',
        )
      }
    }
    try {
      target.followup(createDevLeadPromptMessage(text, leadAgent))
    } catch (error: unknown) {
      throw new DevLeadError(
        `could not admit a prompt into Session "${sessionId}": ${renderThrown(error)}`,
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    }
    const flushed = await this.ctx.sessions.flush(target.session)
    if (!flushed) {
      this.ctx.logger.warn(`devlead: prompt into Session "${sessionId}" was not flushed to persistence`)
    }
    return resumed
  }

  /**
   * Replace one lead's watch set with one Session added or removed.
   * @param agent - exact live lead Agent.
   * @param sessionId - target Session identity.
   * @param watching - whether to include the Session.
   * @returns the resulting watch mutation.
   */
  private async setWatching(
    agent: Agent,
    sessionId: ReturnType<typeof toSessionId>,
    watching: boolean,
  ): Promise<DevLeadWatchMutation> {
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
    if (watching && state.sessions.length >= this.resolved.maxWatchedSessions) {
      throw new DevLeadError(
        `watch limit reached (${this.resolved.maxWatchedSessions}); unwatch a Session before adding another`,
        'DEVLEAD_WATCH_LIMIT',
      )
    }
    const next = watching
      ? [...state.sessions, id]
      : state.sessions.filter(existing => existing !== id)
    appendPluginRecord(agent.session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(next, Date.now()))
    const flushed = await this.ctx.sessions.flush(agent.session)
    if (!flushed) {
      this.ctx.logger.warn(`devlead: watch set for lead "${agent.id}" was not flushed to persistence`)
    }
    return { sessionId: id, watched: watching, sessions: next }
  }
}

export default DevLeadService
