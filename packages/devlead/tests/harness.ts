/**
 * Shared harness for the DevLead notification-hub and core-service specs.
 *
 * Both boot paths use a real cordis `Context`, the real `SessionStore`, and the
 * real `SessionProjectionRegistry`; only the surrounding host capabilities
 * (`agents`, `workspaceRegistry`, `sessionController`, `sessionTitle`) are
 * deterministic in-memory fakes. That keeps every durable write, log event,
 * projection drive, and listener dispatch exactly as production runs them
 * without booting the Agent loop, a model, or a persistent store.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry, AgentStatus, ModelSelection, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type { SessionController, SessionCreateRequest, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller'
import { MessageId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TextBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionTitleService, SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import { WorkspaceActiveSessionError, WorkspaceId, WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import type { SessionActivity, Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadProjectionState } from '@yankeguo/dsh-devlead-protocol'
import { decodeNotificationRecord, modeRecord, watchRecord } from '../src/domain.ts'
import { applyDevLeadProjection, emptyDevLeadProjectionState } from '../src/fold.ts'
import DevLeadService from '../src/index.ts'
import type { WorktreeCheckout } from '../src/isolation.ts'
import { DevLeadNotificationHub } from '../src/notification.ts'
import type { SessionProjectionCacheLike } from '../src/projection-cache.ts'

/** Deterministic instant used for every seeded record and fake title. */
export const T0 = 1_700_000_000_000

/** Flush pending microtasks without touching the clock. */
export async function flushMicrotasks(rounds = 64): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

/**
 * Let a few macrotask boundaries pass and settle the microtasks they queue. The
 * service registers its readiness rehydration through an optional-service fiber
 * and then defers the scan by one task, so a single timer tick is not enough for
 * the whole chain.
 */
export async function nextTask(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await flushMicrotasks(256)
  }
  await flushMicrotasks(1_024)
}

/**
 * Advance real time (the service specs use real timers), then settle the
 * microtasks the elapsed callbacks queued.
 * @param ms - milliseconds to wait.
 */
export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  await flushMicrotasks(512)
}

/** Extract the visible text of one admitted message. */
export function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Fold the complete `devLead` projection of one Session from its committed log.
 * @param session - Session whose log is folded.
 * @returns the fold state, exactly as the registered projection unit produces it.
 */
export function projectionStateOf(session: Session): DevLeadProjectionState {
  let state = emptyDevLeadProjectionState()
  for (const event of session.snapshotEvents()) state = applyDevLeadProjection(state, event)
  return state
}

/**
 * Read every durable notification record of one Session, in log order.
 * @param session - Session whose log is read.
 * @returns the decoded notifications.
 */
export function notificationRecords(session: Session): DevLeadNotification[] {
  return session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === DEVLEAD_NOTIFICATION_RECORD_TYPE ? [decodeNotificationRecord(record.data)] : []
  })
}

/** One in-memory Inbox stand-in with the per-message operations the core uses
 * (`prepend`/`remove`) on top of the plain boundary arrays the specs script.
 * Mutations are not durable here; specs that assert enqueue instants append
 * the real `agent/inbox/spliced` event to the Session log themselves.
 */
export class FakeInbox {
  /** Prompts awaiting individual turns. */
  readonly nextTurn: UserMessage[] = []
  /** Input awaiting the next step boundary. */
  readonly nextStep: UserMessage[] = []
  /** When set, the next {@link prepend} throws this failure (one-shot). */
  prependFailure: Error | undefined

  /** Whether either boundary holds work. */
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /** The array of one boundary. */
  private list(target: 'next-turn' | 'next-step'): UserMessage[] {
    return target === 'next-turn' ? this.nextTurn : this.nextStep
  }

  /** Durably-shaped clear of both boundaries. */
  clear(): void {
    this.nextStep.splice(0)
    this.nextTurn.splice(0)
  }

  /** Append one message to a boundary. */
  append(target: 'next-turn' | 'next-step', message: UserMessage): void {
    this.list(target).push(message)
  }

  /** Prepend one message to a boundary. */
  prepend(target: 'next-turn' | 'next-step', message: UserMessage): void {
    if (this.prependFailure !== undefined) {
      const failure = this.prependFailure
      this.prependFailure = undefined
      throw failure
    }
    this.list(target).unshift(message)
  }

  /** Remove one pending message by identity; whether it was still pending. */
  remove(messageId: string): boolean {
    for (const list of [this.nextTurn, this.nextStep]) {
      const index = list.findIndex(message => String(message.id) === String(messageId))
      if (index >= 0) {
        list.splice(index, 1)
        return true
      }
    }
    return false
  }
}

/** One scriptable fake Agent owning a real Session log. */
export class FakeAgent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
  /** Real Session whose log the Agent drives. */
  readonly session: Session
  /** Current lifecycle state. */
  status: AgentStatus = 'idle'
  /** Pending inbox boundaries read by the notification hub and inbox tools. */
  readonly inbox = new FakeInbox()
  /** Every message admitted through {@link followup}, in order. */
  readonly followups: UserMessage[] = []
  /** When true, the next {@link followup} throws instead of admitting. */
  failFollowups = 0
  /** Model selections recorded by the core through `agent.model.select`. */
  readonly modelSelections: ModelSelection[] = []
  /** When positive, the next `agent.model.select` throws instead of recording. */
  failModelSelect = 0
  /** Agent-owned model accessor the core writes creation-time selections through. */
  readonly model = {
    current: (): Readonly<ModelSelection> | undefined => this.modelSelections.at(-1),
    select: (selection: Readonly<ModelSelection>): void => {
      if (this.failModelSelect > 0) {
        this.failModelSelect -= 1
        throw new Error('fake agent refused the model selection')
      }
      this.modelSelections.push({ ...selection })
    },
  }

  /**
   * @param session - real Session the fake Agent drives.
   */
  constructor(session: Session) {
    this.id = session.id
    this.session = session
  }

  /** Agent-shaped value for services that compare identities. */
  get agent(): Agent {
    return this as unknown as Agent
  }

  /**
   * Queue one ordinary follow-up message: mirrors the real Agent contract by
   * appending to `next-turn` before waking.
   * @param message - admitted message.
   */
  followup(message: UserMessage): void {
    if (this.failFollowups > 0) {
      this.failFollowups -= 1
      throw new Error('fake agent refused the followup')
    }
    this.followups.push(message)
    this.inbox.nextTurn.push(message)
  }

  /** Drop every pending inbox message, emulating a drain by the driven loop. */
  drainInbox(): void {
    this.inbox.nextTurn.splice(0)
    this.inbox.nextStep.splice(0)
  }

  /**
   * Drop every pending inbox message without a loop consuming it, emulating a
   * cancelled/withdrawn notice. Unlike {@link drainInbox} this models the
   * delivery-retry boundary: the notice disappears with no turn executed.
   */
  cancelInbox(): void {
    this.inbox.nextTurn.splice(0)
    this.inbox.nextStep.splice(0)
  }

  /** Flip the public lifecycle status. */
  setRunning(running: boolean): void {
    this.status = running ? 'running' : 'idle'
  }
}

/** Fake `ctx.agents` registry: exact-identity lookups over scripted Agents. */
export class FakeAgentRegistry {
  private readonly byId = new Map<string, FakeAgent>()
  /** Number of {@link turnBoundaryOf} folds requested, for listing-cost assertions. */
  turnBoundaryCalls = 0

  /**
   * Register one fake Agent, replacing any previous identity.
   * @param agent - fake Agent to register.
   * @returns this registry, for chaining.
   */
  add(agent: FakeAgent): this {
    this.byId.set(String(agent.id), agent)
    return this
  }

  /**
   * Remove one identity from the registry.
   * @param id - Session identity.
   * @returns whether an Agent was removed.
   */
  remove(id: string): boolean {
    return this.byId.delete(id)
  }

  /**
   * Read one fake Agent by identity.
   * @param id - Session identity.
   * @returns the fake Agent, or undefined.
   */
  resolve(id: string): FakeAgent | undefined {
    return this.byId.get(id)
  }

  /**
   * Read one live Agent by identity.
   * @param id - Session identity.
   * @returns the Agent shape, or undefined.
   */
  get(id: SessionId): Agent | undefined {
    return this.byId.get(String(id))?.agent
  }

  /** Every live Agent in registration order. */
  list(): Agent[] {
    return [...this.byId.values()].map(agent => agent.agent)
  }

  /**
   * Fold the turn positions the views read.
   * @param session - Session whose committed log is scanned.
   * @returns the latest turn number.
   */
  turnBoundaryOf(session: Session): TurnBoundaryProjection {
    this.turnBoundaryCalls += 1
    let lastTurn = 0
    for (const event of session.snapshotEvents()) {
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        lastTurn = Math.max(lastTurn, event.data.turn)
      }
    }
    return { openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn }
  }

  /**
   * Run one operation without an initiator (the service never reads it).
   * @param operation - operation to run.
   * @returns the operation result.
   */
  withoutInitiator<T>(operation: () => T): T {
    return operation()
  }

  /** The service never infers an initiator; report none. */
  currentInitiator(): Agent | undefined {
    return undefined
  }

  /** Agent-registry-shaped value for `ctx.provide`. */
  asRegistry(): AgentRegistry {
    return this as unknown as AgentRegistry
  }
}

/** Explicit shape of one fake Workspace fixture. */
export interface FakeWorkspaceSeed {
  readonly id?: string
  readonly path: string
  readonly title?: string
  readonly sessionIds?: readonly string[]
  readonly status?: 'ok' | 'missing-dir'
  readonly createdAt?: string
  readonly updatedAt?: string
}

/**
 * Build one Workspace entity fixture.
 * @param seed - explicit entity fields.
 * @returns the Workspace shape the views consume.
 */
export function fakeWorkspace(seed: FakeWorkspaceSeed): Workspace {
  const workspace = {
    id: WorkspaceId(seed.id ?? 'ws-1'),
    path: seed.path,
    title: seed.title ?? (seed.path.split('/').filter(Boolean).at(-1) ?? seed.path),
    createdAt: seed.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: seed.updatedAt ?? '2026-01-01T00:00:00.000Z',
    sessionIds: (seed.sessionIds ?? []).map(id => SessionId(id)),
    status: async (): Promise<'ok' | 'missing-dir'> => seed.status ?? 'ok',
    setTitle: async (title: string): Promise<void> => { workspace.title = title },
    attachSession: async (id: SessionId): Promise<void> => { workspace.sessionIds.push(id) },
    insertSessionBefore: async (): Promise<void> => undefined,
    detachSession: async (): Promise<void> => undefined,
  }
  return workspace as unknown as Workspace
}

/** One active work family a {@link FakeWorkspaceRegistry} reports for a Session. */
export interface FakeSessionActivity {
  /** Activity family key, for example `turn` or `job`. */
  readonly kind: string
  /** Active items of the family, when it carries per-item identity. */
  readonly items?: readonly { readonly id: string; readonly label?: string }[]
}

/** Fake `ctx.workspaceRegistry`: scripted workspaces, archive set, and create calls. */
export class FakeWorkspaceRegistry {
  /** Workspaces in registry order. */
  readonly workspaces: Workspace[] = []
  /** Archived Session identities. */
  archived: string[] = []
  /** Every `create` call, in order. */
  readonly createCalls: Array<{ path: string; title?: string }> = []
  /** When set, every `create` call throws this error. */
  createError: Error | undefined
  /** Per-path one-shot `create` failures, keyed by exact requested path. */
  readonly createErrors = new Map<string, Error>()
  /** Number of complete registry listings requested, for listing-cost assertions. */
  listCalls = 0
  /** Session identities the fake counts as existing for archive admission. */
  readonly knownSessions: string[] = []
  /** Scripted activity families per Session, reported while not archived with `stopActivity` unset. */
  readonly activity = new Map<string, readonly FakeSessionActivity[]>()
  /** Every `delete` call, in order. */
  readonly deleteCalls: string[] = []
  /** Every `archiveSession` call, in order. */
  readonly archiveCalls: Array<{ readonly sessionId: string; readonly stopActivity: boolean }> = []
  /** Every `unarchiveSession` call, in order. */
  readonly unarchiveCalls: string[] = []
  /** Sessions whose stop was requested by an archive with `stopActivity`. */
  readonly stopCalls: string[] = []
  /** When set, every `delete` call rejects. */
  deleteError: Error | undefined

  /**
   * Add one Workspace fixture.
   * @param seed - explicit entity fields.
   * @returns the added Workspace.
   */
  add(seed: FakeWorkspaceSeed): Workspace {
    const workspace = fakeWorkspace({ id: `ws-${this.workspaces.length + 1}`, ...seed })
    this.workspaces.push(workspace)
    return workspace
  }

  /** Archived Session identities as the registry exposes them. */
  get archivedSessionIds(): readonly SessionId[] {
    return this.archived.map(id => SessionId(id))
  }

  /** Every registered Workspace, in registry order. */
  list(): Workspace[] {
    this.listCalls += 1
    return [...this.workspaces]
  }

  /**
   * Resolve a registered Workspace by its canonical path.
   * @param path - absolute directory path.
   * @returns the matching Workspace, or undefined.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    return this.workspaces.find(workspace => workspace.path === path)
  }

  /**
   * Create or reuse a Workspace for one absolute path.
   * @param path - absolute directory path.
   * @param title - optional display title.
   * @returns the registered Workspace.
   */
  async create(path: string, title?: string): Promise<Workspace> {
    const call: { path: string; title?: string } = { path }
    if (title !== undefined) call.title = title
    this.createCalls.push(call)
    const oneShot = this.createErrors.get(path)
    if (oneShot !== undefined) {
      this.createErrors.delete(path)
      throw oneShot
    }
    if (this.createError !== undefined) throw this.createError
    const existing = this.workspaces.find(workspace => workspace.path === path)
    if (existing !== undefined) return existing
    return this.add(title === undefined ? { path } : { path, title })
  }

  /**
   * Remove one Workspace registration, retaining its directory and logs.
   * @param id - Workspace identity.
   * @returns whether a registration was removed.
   */
  async delete(id: Workspace['id']): Promise<boolean> {
    this.deleteCalls.push(String(id))
    if (this.deleteError !== undefined) throw this.deleteError
    const index = this.workspaces.findIndex(workspace => workspace.id === id)
    if (index < 0) return false
    this.workspaces.splice(index, 1)
    return true
  }

  /**
   * Archive one Session, replaying the Host's admission rules.
   * @param sessionId - Session identity.
   * @param options - whether running work is stopped instead of refusing.
   * @throws {@link WorkspaceUnknownSessionError} for an unknown Session and
   *   {@link WorkspaceActiveSessionError} for reported activity without the stop.
   */
  async archiveSession(sessionId: SessionId, options: { stopActivity?: boolean } = {}): Promise<void> {
    const id = String(sessionId)
    this.archiveCalls.push({ sessionId: id, stopActivity: options.stopActivity === true })
    if (this.archived.includes(id)) return
    if (!this.knownSessions.includes(id)) throw new WorkspaceUnknownSessionError(sessionId, 'archive')
    if (options.stopActivity !== true) {
      const activity = this.activity.get(id) ?? []
      if (activity.length > 0) {
        throw new WorkspaceActiveSessionError(
          sessionId,
          activity as unknown as readonly SessionActivity[],
        )
      }
    }
    this.archived.push(id)
    if (options.stopActivity === true) this.stopCalls.push(id)
  }

  /**
   * Unarchive one Session.
   * @param sessionId - Session identity.
   */
  async unarchiveSession(sessionId: SessionId): Promise<void> {
    const id = String(sessionId)
    this.unarchiveCalls.push(id)
    this.archived = this.archived.filter(existing => existing !== id)
  }

  /** Workspace-registry-shaped value for `ctx.provide`. */
  asRegistry(): WorkspaceRegistry {
    return this as unknown as WorkspaceRegistry
  }
}

/** Fake `ctx.llm` slice: records and validates model selections. */
export class FakeModelValidator {
  /** Every validated selection, in call order. */
  readonly calls: Array<{ provider: string; model: string; reasoningEffort?: string }> = []
  /** Advertised provider routes and their model ids. */
  readonly providers = new Map<string, string[]>()
  /** When set, every call-config validation rejects with this failure. */
  error: Error | undefined
  /** When set, every `listModels` call rejects. */
  listError: Error | undefined
  /** Optional per-route validation rejection, keyed by `provider/model`. */
  readonly routeErrors = new Map<string, Error>()

  /**
   * Seed one advertised provider route.
   * @param provider - provider id.
   * @param models - model ids the fake advertises.
   * @returns this fake, for chaining.
   */
  withProvider(provider: string, models: readonly string[]): this {
    this.providers.set(provider, [...models])
    return this
  }

  /** Registered providers in insertion order. */
  listProviders(): Array<{ id: string }> {
    return [...this.providers.keys()].map(id => ({ id }))
  }

  /**
   * List one provider's advertised models.
   * @param provider - provider id.
   * @returns model descriptors.
   */
  async listModels(provider: string): Promise<Array<{ id: string }>> {
    if (this.listError !== undefined) throw this.listError
    const models = this.providers.get(provider)
    if (models === undefined) throw new Error(`provider "${provider}" is not registered`)
    return models.map(id => ({ id }))
  }

  /**
   * Validate one requested model selection's capability.
   * @param config - provider/model route and optional reasoning effort.
   * @param signal - cancellation checked before validation.
   * @returns the accepted config.
   */
  async resolveCallConfig(
    config: { provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
    this.calls.push({ ...config })
    signal?.throwIfAborted()
    const oneShot = this.routeErrors.get(`${config.provider}/${config.model}`)
    if (oneShot !== undefined) throw oneShot
    if (this.error !== undefined) throw this.error
    return { ...config }
  }

  /** LLM-service-shaped value for `ctx.provide`. */
  asService(): object {
    return this
  }
}

/** Fake optional `ctx.agentTeams`: records Team-mode changes. */
export class FakeAgentTeams {
  /** Every `setEnabled` call, in order. */
  readonly calls: Array<{ agentId: string; enabled: boolean }> = []
  /** Root Agent ids whose Team mode is enabled. */
  readonly enabled = new Set<string>()
  /** When set, every `setEnabled` call rejects. */
  error: Error | undefined

  /**
   * Read the fake Team mode of one Agent.
   * @param agent - live root Agent.
   * @returns whether Team mode is enabled for it.
   */
  isEnabled(agent: Agent): boolean {
    return this.enabled.has(String(agent.id))
  }

  /**
   * Record one Team-mode change.
   * @param agent - live root Agent.
   * @param enabled - requested mode.
   * @param signal - cancellation checked before the change.
   */
  async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.calls.push({ agentId: String(agent.id), enabled })
    if (this.error !== undefined) throw this.error
    if (enabled) this.enabled.add(String(agent.id))
    else this.enabled.delete(String(agent.id))
  }

  /** Team-service-shaped value for `ctx.provide`. */
  asService(): object {
    return this
  }
}

/** Fake `ctx.agentDefaultModel`: proves the profile default is never rewritten. */
export class FakeAgentDefaultModel {
  /** Current profile default selection. */
  selection: ModelSelection = { provider: 'default-provider', model: 'default-model' }
  /** Number of `saveSelection` calls observed. */
  saveCalls = 0

  /**
   * Read the profile default selection.
   * @returns a detached selection.
   */
  currentSelection(): ModelSelection {
    return { ...this.selection }
  }

  /**
   * Record one saved default selection.
   * @param selection - selection the caller wants persisted.
   */
  async saveSelection(selection: ModelSelection): Promise<void> {
    this.saveCalls += 1
    this.selection = { ...selection }
  }

  /** Default-model-service-shaped value for `ctx.provide`. */
  asService(): object {
    return this
  }
}

/** Fake `ctx.sessionTitle`: scripted titles and recorded renames. */
export class FakeSessionTitle {
  private readonly titles = new Map<string, string>()
  /** Every `rename` call, in order. */
  readonly renames: Array<{ sessionId: string; title: string }> = []

  /**
   * Seed the folded title of one Session.
   * @param sessionId - Session identity.
   * @param title - folded title.
   * @returns this fake, for chaining.
   */
  set(sessionId: string, title: string): this {
    this.titles.set(sessionId, title)
    return this
  }

  /**
   * Read the folded title snapshot of one live Session.
   * @param session - live Session.
   * @returns the snapshot, or undefined when untitled.
   */
  get(session: Session): SessionTitleSnapshot | undefined {
    const title = this.titles.get(String(session.id))
    if (title === undefined) return undefined
    return { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: SessionSeq(0), updatedAt: T0 }
  }

  /**
   * Record one explicit rename and fold it.
   * @param session - live Session.
   * @param title - requested title.
   * @returns the folded snapshot.
   */
  rename(session: Session, title: string): SessionTitleSnapshot {
    this.renames.push({ sessionId: String(session.id), title })
    this.titles.set(String(session.id), title)
    const snapshot = this.get(session)
    if (snapshot === undefined) throw new Error('fake session title failed to fold a rename')
    return snapshot
  }

  /** Title-service-shaped value for `ctx.provide`. */
  asService(): SessionTitleService {
    return this as unknown as SessionTitleService
  }
}

/** Scripted result of one fake cold-Session resolve. */
export type FakeResolveHandler = (
  sessionId: SessionId,
) => { agent: Agent } | { error: { message: string; code: string } }

/** One persisted Session row as {@link FakeSessionQuery} serves it. */
interface FakePersistedSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly title?: string
}

/** Fake `ctx.sessionQuery`: scripted cold logs and folded titles. */
export class FakeSessionQuery {
  private readonly rows = new Map<string, FakePersistedSession>()
  /** When set, every corpus listing call rejects. */
  listError: Error | undefined
  /** When set, every log/title read rejects. */
  readError: Error | undefined
  /** Number of corpus listings requested. */
  listSessionsCalls = 0
  /** Number of complete log reads requested. */
  readSessionCalls = 0
  /** Number of batch title reads requested. */
  readTitleSnapshotsCalls = 0
  /** Number of single title reads requested. */
  readTitleCalls = 0
  /** Remove one persisted Session, as a permanent deletion would. */
  delete(sessionId: string): boolean {
    return this.rows.delete(sessionId)
  }
  /**
   * Number of upcoming corpus listings that report an empty result (one-shot),
   * emulating a persistence backend whose index is still warming up.
   */
  emptyListings = 0

  /**
   * Seed one persisted Session's log and folded title with a synthetic header
   * carrying only its identity. Use {@link seedRecord} when the header facts
   * (origin, cwd, title) matter to the code under test.
   * @param sessionId - persisted Session identity.
   * @param events - complete raw event log.
   * @param title - folded title, when one exists.
   * @returns this fake, for chaining.
   */
  seed(sessionId: string, events: readonly SessionEvent[], title?: string): this {
    return this.seedRecord({ id: SessionId(sessionId) } as unknown as SessionHeader, events, title)
  }

  /**
   * Seed one persisted Session row with a real header.
   * @param header - header captured from a real Session log.
   * @param events - complete raw event log.
   * @param title - folded title, when one exists.
   * @returns this fake, for chaining.
   */
  seedRecord(header: SessionHeader, events: readonly SessionEvent[], title?: string): this {
    this.rows.set(String(header.id), title === undefined ? { header, events: [...events] } : { header, events: [...events], title })
    return this
  }

  /** Every persisted Session record, newest-listed first. */
  async listSessions(): Promise<Array<{ header: SessionHeader; live: boolean; persisted: boolean }>> {
    this.listSessionsCalls += 1
    if (this.listError !== undefined) throw this.listError
    if (this.emptyListings > 0) {
      this.emptyListings -= 1
      return []
    }
    return [...this.rows.values()].map(row => ({ header: row.header, live: false, persisted: true }))
  }

  /**
   * Read one persisted Session log.
   * @param sessionId - persisted Session identity.
   * @returns the complete raw event log.
   */
  async readSession(sessionId: SessionId): Promise<{ session: SessionHeader; inheritedEventCount: number; events: readonly SessionEvent[] }> {
    this.readSessionCalls += 1
    if (this.readError !== undefined) throw this.readError
    const row = this.rows.get(String(sessionId))
    if (row === undefined) throw new Error(`persisted Session ${String(sessionId)} does not exist`)
    return { session: row.header, inheritedEventCount: 0, events: row.events }
  }

  /**
   * Read one persisted Session title and header together.
   * @param sessionId - persisted Session identity.
   * @returns the header and optional title, as the query engine observes them.
   */
  async readTitleSnapshot(sessionId: SessionId): Promise<{ session: SessionHeader; title?: SessionTitleSnapshot }> {
    this.readTitleCalls += 1
    if (this.readError !== undefined) throw this.readError
    const row = this.rows.get(String(sessionId))
    if (row === undefined) throw new Error(`persisted Session ${String(sessionId)} does not exist`)
    const title = this.snapshotOf(String(sessionId))
    return {
      session: row.header,
      ...(title === undefined ? {} : { title }),
    }
  }

  /**
   * Read one persisted Session title.
   * @param sessionId - persisted Session identity.
   * @returns the title snapshot, or undefined.
   */
  async readTitle(sessionId: SessionId): Promise<SessionTitleSnapshot | undefined> {
    this.readTitleCalls += 1
    if (this.readError !== undefined) throw this.readError
    return this.snapshotOf(String(sessionId))
  }

  /**
   * Batch-read persisted Session titles.
   * @param sessionIds - persisted Session identities.
   * @returns one fulfilled observation per identity.
   */
  async readTitleSnapshots(
    sessionIds: readonly SessionId[],
  ): Promise<Array<{ status: 'fulfilled'; value: { session: SessionHeader; title?: SessionTitleSnapshot } }>> {
    this.readTitleSnapshotsCalls += 1
    if (this.readError !== undefined) throw this.readError
    return sessionIds.map((sessionId) => {
      const title = this.snapshotOf(String(sessionId))
      const header = this.rows.get(String(sessionId))?.header ?? ({ id: sessionId } as unknown as SessionHeader)
      return {
        status: 'fulfilled' as const,
        value: {
          session: header,
          ...(title === undefined ? {} : { title }),
        },
      }
    })
  }

  /**
   * Build one title snapshot for one identity.
   * @param sessionId - persisted Session identity.
   * @returns the snapshot, or undefined.
   */
  private snapshotOf(sessionId: string): SessionTitleSnapshot | undefined {
    const title = this.rows.get(sessionId)?.title
    if (title === undefined) return undefined
    return { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 0 as never, updatedAt: T0 }
  }

  /** Session-query-shaped value for `ctx.provide`. */
  asService(): SessionQueryEngine {
    return this as unknown as SessionQueryEngine
  }
}

/** Scripted cached projection row of one Session. */
export interface FakeCachedProjectionRow {
  /** Projection values map; the cache stores one entry per registered unit. */
  readonly values?: Readonly<Record<string, unknown>>
}

/**
 * Fake `ctx.sessionProjectionCache`: scripted `cachedSnapshot(header)` rows keyed
 * by Session identity, exactly the structural slice cold lead rehydration reads.
 */
export class FakeProjectionCache {
  private readonly rows = new Map<string, FakeCachedProjectionRow>()
  /** Number of `cachedSnapshot` lookups. */
  lookupCalls = 0
  /** Number of eager `write` checkpoints. */
  writeCalls = 0
  /** When set, every eager write throws this failure. */
  writeError: Error | undefined
  /** When set, every lookup throws this failure. */
  lookupError: Error | undefined

  /**
   * Seed one cached row.
   * @param sessionId - persisted Session identity.
   * @param row - cached row value.
   * @returns this fake, for chaining.
   */
  set(sessionId: string, row: FakeCachedProjectionRow): this {
    this.rows.set(sessionId, row)
    return this
  }

  /**
   * Seed one cached `devLead` digest value.
   * @param sessionId - persisted Session identity.
   * @param state - enabled flag and watch set the cached digest reports.
   * @returns this fake, for chaining.
   */
  setDevLead(sessionId: string, state: { readonly enabled: boolean; readonly sessions?: readonly string[] }): this {
    const values = {
      devLead: {
        enabled: state.enabled,
        sessions: state.sessions ?? [],
        notifications: [],
      },
    }
    return this.set(sessionId, { values })
  }

  /**
   * Drop one cached row.
   * @param sessionId - persisted Session identity.
   * @returns whether a row was removed.
   */
  delete(sessionId: string): boolean {
    return this.rows.delete(sessionId)
  }

  /**
   * Serve one cached row by Session identity.
   * @param header - persisted Session header.
   * @returns the cached row, or undefined when absent.
   */
  cachedSnapshot(header: unknown): FakeCachedProjectionRow | undefined {
    this.lookupCalls += 1
    if (this.lookupError !== undefined) throw this.lookupError
    const id = (header as { id?: unknown } | undefined)?.id
    return typeof id === 'string' ? this.rows.get(id) : undefined
  }

  /**
   * Record one eager checkpoint. The real cache would refresh the row from the
   * Session's live projections; the fake only counts the call (and can fail).
   * @param _session - Session being checkpointed.
   * @returns fulfillment after the simulated write.
   */
  async write(_session: unknown): Promise<void> {
    this.writeCalls += 1
    if (this.writeError !== undefined) throw this.writeError
  }

  /** Projection-cache-shaped value for `ctx.provide`. */
  asService(): SessionProjectionCacheLike {
    return this as unknown as SessionProjectionCacheLike
  }
}

/**
 * Fake optional `ctx.sessionPersistence`: scripted complete listing of stored
 * Session ids, used as the corpus-readiness predicate.
 */
export class FakeSessionPersistence {
  /** Session ids the fake reports as stored. */
  ids: string[] = []
  /** Number of `list` calls requested. */
  listCalls = 0
  /** When set, every `list` call rejects (composed but not usable yet). */
  listError: Error | undefined

  /**
   * List every stored Session snapshot.
   * @returns one snapshot per stored id.
   */
  async list(): Promise<Array<{ header: { id: string } }>> {
    this.listCalls += 1
    if (this.listError !== undefined) throw this.listError
    return this.ids.map(id => ({ header: { id } }))
  }

  /** Persistence-service-shaped value for `ctx.provide`. */
  asService(): object {
    return this as unknown as object
  }
}

/** Fake `ctx.sessionController`: records calls and replays scripted results. */
export class FakeSessionController {
  /** Every `create` request, in order. */
  readonly createCalls: SessionCreateRequest[] = []
  /** Every `resolveAgent` identity, in order. */
  readonly resolveCalls: SessionId[] = []
  /** Scripted `create` body. */
  createHandler: ((request: SessionCreateRequest) => SessionCreateValue | Promise<SessionCreateValue>) | undefined
  /** Scripted `resolveAgent` body. */
  resolveHandler: FakeResolveHandler | undefined
  /** Catalog value returned by {@link modelCatalog}. */
  modelCatalogResult: unknown = {
    default: { provider: 'provider-a', model: 'model-a' },
    routableProviders: [],
    groups: [],
    failures: [],
  }
  /** When set, every {@link modelCatalog} call rejects. */
  modelCatalogError: Error | undefined
  /** Number of {@link modelCatalog} calls. */
  modelCatalogCalls = 0

  /**
   * @param error - thrown by every `create` call when set.
   */
  constructor(readonly createError: Error | undefined = undefined) {}

  /**
   * Script one created Session result.
   * @param request - creation request.
   * @returns the created identity.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    this.createCalls.push(request)
    if (this.createError !== undefined) throw this.createError
    if (this.createHandler === undefined) throw new Error('fake session controller has no create handler')
    return await this.createHandler(request)
  }

  /**
   * Read the scripted model catalog.
   * @returns the scripted catalog value.
   */
  async modelCatalog(): Promise<unknown> {
    this.modelCatalogCalls += 1
    if (this.modelCatalogError !== undefined) throw this.modelCatalogError
    return this.modelCatalogResult
  }

  /**
   * Resolve or fail one cold Session.
   * @param sessionId - addressed Session identity.
   * @returns the scripted resolve result.
   */
  async resolveAgent(sessionId: SessionId): Promise<{ agent: Agent } | { error: { message: string; code: string } }> {
    this.resolveCalls.push(sessionId)
    if (this.resolveHandler === undefined) {
      return { error: { message: `no agent for ${String(sessionId)}`, code: 'session/not-found' } }
    }
    return this.resolveHandler(sessionId)
  }

  /** Session-controller-shaped value for `ctx.provide`. */
  asService(): SessionController {
    return this as unknown as SessionController
  }
}

/** One recorded call of {@link FakeWorktreesCapability}. */
export interface FakeWorktreeCall {
  /** Agent the service passed as the worktree owner. */
  readonly agent: Agent
  /** Request body the service passed. */
  readonly request: object
  /** Cancellation signal the service passed, when one was threaded in. */
  readonly signal: AbortSignal | undefined
  /** Messages already admitted into the owning Agent when the call arrived. */
  readonly followupsAtCall: number
}

/** Deterministic checkout reported by an unscripted {@link FakeWorktreesCapability}. */
export const FAKE_WORKTREE = {
  path: '/fake/repo/.agents/worktrees/dsh-fake',
  branch: 'dsh-fake',
  baseCommit: '0123456789abcdef0123456789abcdef01234567',
} as const

/**
 * Fake optional `ctx.worktrees` capability: records every call and replays a
 * scripted (or deterministic) checkout. It is provided only when a spec asks
 * for it, so the absent-capability path remains the default in every other
 * booted harness.
 */
export class FakeWorktreesCapability {
  /** Every `create` call, in order. */
  readonly calls: FakeWorktreeCall[] = []
  /** When set, every `create` call throws this error. */
  createError: Error | undefined
  /** Scripted `create` body; unset reports {@link FAKE_WORKTREE}. */
  createHandler: ((call: FakeWorktreeCall) => WorktreeCheckout | Promise<WorktreeCheckout>) | undefined

  /**
   * Record one call, then report the scripted checkout.
   * @param agent - Agent the service passes as the worktree owner.
   * @param request - request body the service passes.
   * @param signal - cancellation signal the service passes.
   * @returns the created checkout.
   */
  async create(agent: Agent, request: object = {}, signal?: AbortSignal): Promise<WorktreeCheckout> {
    const followups = (agent as unknown as { followups?: readonly unknown[] }).followups
    const call: FakeWorktreeCall = {
      agent,
      request,
      signal,
      followupsAtCall: followups?.length ?? 0,
    }
    this.calls.push(call)
    if (this.createError !== undefined) throw this.createError
    if (this.createHandler !== undefined) return await this.createHandler(call)
    return { ...FAKE_WORKTREE }
  }
}

/** Monotonic counter so every booted harness has deterministic unique ids. */
let bootCounter = 0

/** Contexts booted by this harness module, disposed by {@link disposeHarnesses}. */
const liveContexts: Context[] = []

/**
 * Dispose one context booted through this module and stop tracking it.
 * @param ctx - context to dispose.
 */
export async function disposeContext(ctx: Context): Promise<void> {
  const index = liveContexts.indexOf(ctx)
  if (index >= 0) liveContexts.splice(index, 1)
  await ctx.fiber.dispose()
}

/** Dispose every harness booted through this module. */
export async function disposeHarnesses(): Promise<void> {
  const pending = liveContexts.splice(0).reverse()
  for (const ctx of pending) await ctx.fiber.dispose()
}

/** Append one settled-turn event to a real watched Session log. */
export function appendTurnEnd(session: Session, turn: number, reason: TurnEndReason = { kind: 'completed' }): SessionEvent {
  return session.append('turn/end', { turn, reason })
}

/** Append one opened-turn event to a real Session log. */
export function appendTurnStart(session: Session, turn: number): SessionEvent {
  return session.append('turn/start', { turn })
}

/** Append one model-authored assistant message to a real Session log. */
export function appendAssistantMessage(session: Session, turn: number, text: string, step = 1): SessionEvent {
  return session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'fake-provider', model: 'fake-model' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
}

/** One persisted Session log built through a throwaway real Session store. */
export interface PersistedLog {
  /** Real Session header captured from the throwaway store. */
  readonly header: SessionHeader
  /** Complete raw committed events, in log order. */
  readonly events: readonly SessionEvent[]
}

/**
 * Build one real persisted Session log through a throwaway Context + Session
 * store, so a fake query engine serves the exact events and header a real
 * persistence backend would return after a restart.
 * @param sessionId - persisted Session identity.
 * @param build - seeds the throwaway Session log.
 * @param options - optional recorded working directory.
 * @returns the captured header and complete event log.
 */
export async function buildPersistedLog(
  sessionId: string,
  build: (session: Session) => void,
  options: { readonly cwd?: string } = {},
): Promise<PersistedLog> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const session = options.cwd === undefined
      ? ctx.sessions.create(SessionId(sessionId))
      : ctx.sessions.create(SessionId(sessionId), { meta: { cwd: options.cwd } })
    build(session)
    return { header: session.header, events: session.snapshotEvents() }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** One persisted lead Session to seed into a {@link FakeSessionQuery}. */
export interface PersistedLeadSeed {
  /** Lead Session identity. */
  readonly sessionId: string
  /** Seed a durable enabled mode record; defaults to true. */
  readonly enabled?: boolean
  /** Seed this complete durable watch set, when given. */
  readonly watched?: readonly string[]
  /** Recorded working directory. */
  readonly cwd?: string
  /** Extra seeding on the throwaway Session before its log is captured. */
  readonly seed?: (session: Session) => void
}

/**
 * Build one persisted cold lead Session and seed it into a fake query engine.
 * @param query - fake query engine receiving the row.
 * @param seed - persisted lead description.
 * @returns the captured real header.
 */
export async function seedPersistedLead(query: FakeSessionQuery, seed: PersistedLeadSeed): Promise<SessionHeader> {
  const log = await buildPersistedLog(seed.sessionId, (session) => {
    if (seed.enabled !== false) appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
    if (seed.watched !== undefined) {
      appendPluginRecord(session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(seed.watched, T0))
    }
    seed.seed?.(session)
  }, seed.cwd === undefined ? {} : { cwd: seed.cwd })
  query.seedRecord(log.header, log.events)
  return log.header
}

/**
 * Materialize one cold lead Session as a live Session + fake Agent, the way a
 * real resume or a human opening the Session leaves it: the durable records are
 * replayed into the newly attached log and the Agent is announced live.
 * @param ctx - booted harness context providing the real Session store.
 * @param agents - fake Agent registry of the same harness.
 * @param seed - durable lead description replayed into the attached log.
 * @returns the live fake Agent.
 */
export function attachPersistedLead(
  ctx: Context,
  agents: FakeAgentRegistry,
  seed: PersistedLeadSeed & { readonly watched: readonly string[] },
): FakeAgent {
  const session = ctx.sessions.create(SessionId(seed.sessionId))
  if (seed.enabled !== false) appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
  appendPluginRecord(session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(seed.watched, T0))
  seed.seed?.(session)
  const agent = new FakeAgent(session)
  agents.add(agent)
  return agent
}

/** Options accepted by {@link bootService}. */
export interface BootServiceOptions {
  /** Lead Session identity; minted when omitted. */
  readonly leadId?: string
  /** Recorded lead working directory. */
  readonly leadCwd?: string
  /** Extra Session identities created in the store before the service loads. */
  readonly sessionIds?: readonly string[]
  /** Seed a durable mode record with this value before the service loads. */
  readonly enabled?: boolean
  /** Seed a durable whole-value watch record before the service loads. */
  readonly watched?: readonly string[]
  /** Extra lead-log seeding before the service loads. */
  readonly seedLead?: (session: Session) => void
  /** Extra seeding on the created `sessionIds` Sessions before the service loads. */
  readonly seedSessions?: (sessions: Readonly<Record<string, Session>>) => void
  /** Whether the lead Agent is registered live before the service loads. */
  readonly registerLeadAgent?: boolean
  /** Fake Workspace registry to provide. */
  readonly workspaceRegistry?: FakeWorkspaceRegistry
  /** Fake Session controller to provide. */
  readonly sessionController?: FakeSessionController
  /** Fake Session query engine to provide (cold logs and titles). */
  readonly sessionQuery?: FakeSessionQuery
  /** Fake Session projection cache to provide (cold lead pre-filter). */
  readonly projectionCache?: FakeProjectionCache
  /**
   * Optional Session persistence service to provide before the service loads,
   * usually a {@link FakeSessionPersistence} (scripted stored ids) or `{}` to
   * model a composed-but-unverifiable backend. Cold rehydration needs both
   * `sessionQuery` and this service, and compares the query corpus against its
   * stored listing as a boot-time readiness barrier.
   */
  readonly sessionPersistence?: object
  /** Fake optional Git worktree capability to provide; omitted models a Host without it. */
  readonly worktrees?: FakeWorktreesCapability
  /** Fake LLM registry slice used to validate dispatch-time model selections. */
  readonly llm?: FakeModelValidator
  /** Fake optional Agent Teams service; omitted models a Host without it. */
  readonly agentTeams?: FakeAgentTeams
  /** Fake profile default model; lets a spec prove selections never rewrite it. */
  readonly agentDefaultModel?: FakeAgentDefaultModel
  /** Fake durable storage-domain facility, provided through `ctx.storageDomain`. */
  readonly storageDomain?: FakeStorageDomain
  /** Whether a durability participant is registered; false models an unpersisted Host. */
  readonly persistence?: boolean
  /** When set, the durability participant rejects with this failure. */
  readonly flushFailure?: Error
  /** Extra fake Agents to register before the service loads. */
  readonly extraAgents?: (registry: FakeAgentRegistry, sessions: Readonly<Record<string, Session>>) => void
  /** Core-service configuration passed to the plugin. */
  readonly config?: Record<string, unknown>
}

/** One booted core-service harness. */
export interface ServiceHarness {
  readonly ctx: Context
  readonly service: DevLeadService
  readonly lead: FakeAgent
  readonly leadSession: Session
  readonly agents: FakeAgentRegistry
  readonly sessions: Record<string, Session>
  readonly sessionTitle: FakeSessionTitle
  readonly workspaceRegistry: FakeWorkspaceRegistry | undefined
  readonly sessionController: FakeSessionController | undefined
  readonly sessionQuery: FakeSessionQuery | undefined
  readonly projectionCache: FakeProjectionCache | undefined
  readonly worktrees: FakeWorktreesCapability | undefined
  readonly llm: FakeModelValidator | undefined
  readonly agentTeams: FakeAgentTeams | undefined
  readonly agentDefaultModel: FakeAgentDefaultModel | undefined
  readonly storageDomain: FakeStorageDomain | undefined
  /** Session ids whose `session/flush` checkpoint ran, in call order. */
  readonly flushCalls: string[]
  /** Dispose this harness's context and stop tracking it. */
  dispose(): Promise<void>
}

/**
 * Boot cordis with the real Session services, the fake host capabilities, and
 * the real DevLead core service.
 * @param options - harness options.
 * @returns the booted harness.
 */
export async function bootService(options: BootServiceOptions = {}): Promise<ServiceHarness> {
  bootCounter += 1
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  // A no-op durability participant, so `sessions.flush()` reports true the way
  // a profile with a persistence plugin does and production code paths avoid
  // their "not flushed" warning branch.
  const flushCalls: string[] = []
  if (options.persistence !== false) {
    ctx.on('session/flush', (session) => {
      flushCalls.push(String(session.id))
      if (options.flushFailure !== undefined) throw options.flushFailure
    })
  }
  const leadId = options.leadId ?? `service-lead-${String(bootCounter)}`
  const leadSession = options.leadCwd === undefined
    ? ctx.sessions.create(SessionId(leadId))
    : ctx.sessions.create(SessionId(leadId), { meta: { cwd: options.leadCwd } })
  const sessions: Record<string, Session> = { [leadId]: leadSession }
  for (const id of options.sessionIds ?? []) sessions[id] = ctx.sessions.create(SessionId(id))
  options.seedSessions?.(sessions)
  if (options.enabled !== undefined) appendPluginRecord(leadSession, DEVLEAD_MODE_RECORD_TYPE, modeRecord(options.enabled, T0))
  if (options.watched !== undefined) appendPluginRecord(leadSession, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(options.watched, T0))
  options.seedLead?.(leadSession)
  const agents = new FakeAgentRegistry()
  const lead = new FakeAgent(leadSession)
  if (options.registerLeadAgent !== false) agents.add(lead)
  options.extraAgents?.(agents, sessions)
  ctx.provide('agents', agents.asRegistry())
  const sessionTitle = new FakeSessionTitle()
  ctx.provide('sessionTitle', sessionTitle.asService())
  if (options.workspaceRegistry !== undefined) ctx.provide('workspaceRegistry', options.workspaceRegistry.asRegistry())
  if (options.sessionController !== undefined) ctx.provide('sessionController', options.sessionController.asService())
  if (options.sessionQuery !== undefined) ctx.provide('sessionQuery', options.sessionQuery.asService())
  if (options.projectionCache !== undefined) ctx.provide('sessionProjectionCache', options.projectionCache.asService())
  if (options.sessionPersistence !== undefined) ctx.provide('sessionPersistence', options.sessionPersistence)
  // Provided only when asked for: every other spec deliberately models a Host
  // that composes no experimental Git worktree service.
  if (options.worktrees !== undefined) ctx.provide('worktrees', options.worktrees)
  if (options.llm !== undefined) ctx.provide('llm', options.llm.asService())
  if (options.agentTeams !== undefined) ctx.provide('agentTeams', options.agentTeams.asService())
  if (options.agentDefaultModel !== undefined) ctx.provide('agentDefaultModel', options.agentDefaultModel.asService())
  if (options.storageDomain !== undefined) ctx.provide('storageDomain' as never, options.storageDomain.asService() as never)
  await ctx.plugin(DevLeadService, options.config ?? {})
  liveContexts.push(ctx)
  return {
    ctx,
    service: ctx.devLead,
    lead,
    leadSession,
    agents,
    sessions,
    sessionTitle,
    workspaceRegistry: options.workspaceRegistry,
    sessionController: options.sessionController,
    sessionQuery: options.sessionQuery,
    projectionCache: options.projectionCache,
    worktrees: options.worktrees,
    llm: options.llm,
    agentTeams: options.agentTeams,
    agentDefaultModel: options.agentDefaultModel,
    storageDomain: options.storageDomain,
    flushCalls,
    dispose: () => disposeContext(ctx),
  }
}

/** Per-lead seeding accepted by {@link bootHub}. */
export interface HubLeadSeed {
  /** Seed a durable enabled mode record; defaults to true. */
  readonly enabled?: boolean
  /** Seed this complete watch set; defaults to the booted watched Session. */
  readonly watched?: readonly string[]
  /** Whether the lead Agent is registered live; defaults to true. */
  readonly register?: boolean
  /**
   * Append one corrupt owned record after the seeded mode/watch records, so the
   * lead's exact fold is frozen from the start. Defaults to false.
   */
  readonly corrupt?: boolean
}

/** Options accepted by {@link bootHub}. */
export interface BootHubOptions {
  /** Coalescing window in milliseconds. */
  readonly batchMs?: number
  /** Whether a cold lead Session is resumed for its digest. */
  readonly wakeColdSession?: boolean
  /** Scripted leads; defaults to one enabled lead watching the Session. */
  readonly leads?: readonly HubLeadSeed[]
  /** Fake Session controller to provide. */
  readonly sessionController?: FakeSessionController
  /** Fake Workspace registry to provide (archive state drives delivery). */
  readonly workspaceRegistry?: FakeWorkspaceRegistry
  /** Extra seeding on the watched Session before the hub starts. */
  readonly seedWatched?: (session: Session) => void
  /** Whether the hub is started on load; defaults to true. */
  readonly start?: boolean
  /** Whether a durability participant is registered; false models an unpersisted Host. */
  readonly persistence?: boolean
  /** When set, the durability participant rejects with this failure. */
  readonly flushFailure?: Error
}

/** One scripted lead of a booted notification-hub harness. */
export interface HubLead {
  readonly session: Session
  readonly agent: FakeAgent
}

/** One booted notification-hub harness. */
export interface HubHarness {
  readonly ctx: Context
  readonly hub: DevLeadNotificationHub
  readonly agents: FakeAgentRegistry
  readonly watched: Session
  readonly leads: readonly HubLead[]
  readonly sessionTitle: FakeSessionTitle
  readonly sessionController: FakeSessionController | undefined
  /** Session ids whose `session/flush` checkpoint ran, in call order. */
  readonly flushCalls: string[]
  /** Dispose this harness's context and stop tracking it. */
  dispose(): Promise<void>
}

/**
 * Boot the real Session store plus the notification hub inside a disposable
 * cordis plugin, with fake Agents standing in for the Agent loop.
 * @param options - harness options.
 * @returns the booted harness.
 */
export async function bootHub(options: BootHubOptions = {}): Promise<HubHarness> {
  bootCounter += 1
  const bootId = bootCounter
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const flushCalls: string[] = []
  if (options.persistence !== false) {
    ctx.on('session/flush', (session) => {
      flushCalls.push(String(session.id))
      if (options.flushFailure !== undefined) throw options.flushFailure
    })
  }
  const watched = ctx.sessions.create(SessionId(`hub-watched-${String(bootId)}`))
  options.seedWatched?.(watched)
  const agents = new FakeAgentRegistry()
  const leads: HubLead[] = []
  const seeds = options.leads ?? [{ enabled: true, watched: [String(watched.id)] }]
  seeds.forEach((seed, index) => {
    const session = ctx.sessions.create(SessionId(`hub-lead-${String(bootId)}-${String(index + 1)}`))
    if (seed.enabled !== false) appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
    const watchedIds = seed.watched ?? [String(watched.id)]
    appendPluginRecord(session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(watchedIds, T0))
    if (seed.corrupt === true) {
      appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, { kind: 'devlead/mode', version: 1, enabled: 'yes', at: T0 } as never)
    }
    const agent = new FakeAgent(session)
    if (seed.register !== false) agents.add(agent)
    leads.push({ session, agent })
  })
  ctx.provide('agents', agents.asRegistry())
  const sessionTitle = new FakeSessionTitle()
  ctx.provide('sessionTitle', sessionTitle.asService())
  if (options.sessionController !== undefined) ctx.provide('sessionController', options.sessionController.asService())
  if (options.workspaceRegistry !== undefined) ctx.provide('workspaceRegistry', options.workspaceRegistry.asRegistry())
  let hub: DevLeadNotificationHub | undefined
  await ctx.plugin({
    name: 'devlead-hub-test-wrapper',
    inject: ['agents', 'sessions'],
    apply(inner: Context): void {
      hub = new DevLeadNotificationHub(inner, projectionStateOf, {
        batchMs: options.batchMs ?? 400,
        wakeColdSession: options.wakeColdSession ?? true,
      })
      if (options.start !== false) hub.start()
    },
  })
  if (hub === undefined) throw new Error('notification hub wrapper did not construct the hub')
  liveContexts.push(ctx)
  return {
    ctx,
    hub,
    agents,
    watched,
    leads,
    sessionTitle,
    sessionController: options.sessionController,
    flushCalls,
    dispose: () => disposeContext(ctx),
  }
}

/** Build one human-authored user message fixture. */
export function humanMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Build one queued user message with a controlled identity and source, so
 * inbox specs can script ownership and stable ids.
 * @param id - stable message identity.
 * @param source - producer source record (user, devlead relay, schedule, …).
 * @param text - text content of the message.
 * @returns the identified user message.
 */
export function queuedMessage(id: string, source: unknown, text = 'queued instruction'): UserMessage {
  return {
    ...createUserMessage({ content: [{ type: 'text', text }], source: source as UserMessage['source'] }),
    id: MessageId(id),
  }
}

/** One in-memory table of {@link FakeStorageDomain}. */
export class FakeStorageTable {
  /** Persisted records by key. */
  readonly records = new Map<string, unknown>()
  /** When set, every put rejects with this failure. */
  putError: Error | undefined
  /** Number of durable puts attempted. */
  putCalls = 0

  get(key: string): unknown {
    return this.records.get(key)
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.records.entries()
  }

  async put(key: string, value: unknown): Promise<void> {
    this.putCalls += 1
    if (this.putError !== undefined) throw this.putError
    this.records.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }

  async deleteMany(keys: readonly string[]): Promise<number> {
    let removed = 0
    for (const key of keys) if (this.records.delete(key)) removed += 1
    return removed
  }
}

/** One in-memory storage-domain handle. */
class FakeStorageDomainHandle {
  /** Tables by declared name. */
  readonly tables = new Map<string, FakeStorageTable>()
  /** Whether a handle currently holds the domain open (single-open facility). */
  opened = true

  constructor(names: readonly string[]) {
    for (const name of names) this.tables.set(name, new FakeStorageTable())
  }

  table(name: string): FakeStorageTable {
    const table = this.tables.get(name)
    if (table === undefined) throw new Error(`fake storage domain has no table ${name}`)
    return table
  }

  async close(): Promise<void> {
    this.opened = false
  }
}

/**
 * In-memory `ctx.storageDomain` stand-in. Domain data survives a handle close,
 * so booting a second service over the same fake models a Host restart with
 * durable outbox rows still on disk. Like the real facility, a domain name is
 * single-open: opening it while a previous handle has not closed refuses with
 * `already-open`, which is how a dispose/close race becomes visible to tests.
 */
export class FakeStorageDomain {
  /** Persisted domains by name. */
  readonly domains = new Map<string, FakeStorageDomainHandle>()
  /**
   * When set, {@link open} reserves the domain and then awaits this gate before
   * returning the handle, so a spec can hold a storage mount in flight.
   */
  openGate: Promise<void> | undefined

  async open(spec: unknown): Promise<FakeStorageDomainHandle> {
    const name = (spec as { name?: unknown }).name
    const tableNames = Object.keys((spec as { tables?: Record<string, unknown> }).tables ?? {})
    if (typeof name !== 'string' || name.length === 0) throw new Error('fake storage domain requires a name')
    let domain = this.domains.get(name)
    if (domain !== undefined && domain.opened) {
      throw new Error(`storage domain "${name}" is already open`)
    }
    if (domain === undefined) {
      domain = new FakeStorageDomainHandle(tableNames)
      this.domains.set(name, domain)
    } else {
      domain.opened = true
    }
    const gate = this.openGate
    if (gate !== undefined) await gate
    return domain
  }

  /** Whether one named domain currently has an open handle. */
  isOpen(name: string): boolean {
    return this.domains.get(name)?.opened === true
  }

  /** Table of one persisted domain, for direct assertions. */
  table(domainName: string, tableName: string): FakeStorageTable {
    const domain = this.domains.get(domainName)
    if (domain === undefined) throw new Error(`fake storage domain ${domainName} is not created`)
    return domain.table(tableName)
  }

  /** Storage-domain-shaped value for `ctx.provide`. */
  asService(): unknown {
    return this
  }
}
