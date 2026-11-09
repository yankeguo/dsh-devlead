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
import type { Agent, AgentRegistry, AgentStatus, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type { SessionController, SessionCreateRequest, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TextBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionTitleService, SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
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

/** Deterministic instant used for every seeded record and fake title. */
export const T0 = 1_700_000_000_000

/** Flush pending microtasks without touching the clock. */
export async function flushMicrotasks(rounds = 64): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
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

/** One scriptable fake Agent owning a real Session log. */
export class FakeAgent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
  /** Real Session whose log the Agent drives. */
  readonly session: Session
  /** Current lifecycle state. */
  status: AgentStatus = 'idle'
  /** Pending inbox boundaries read by the notification hub. */
  readonly inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] } = { nextTurn: [], nextStep: [] }
  /** Every message admitted through {@link followup}, in order. */
  readonly followups: UserMessage[] = []
  /** When true, the next {@link followup} throws instead of admitting. */
  failFollowups = 0

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

  /** Workspace-registry-shaped value for `ctx.provide`. */
  asRegistry(): WorkspaceRegistry {
    return this as unknown as WorkspaceRegistry
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

/** Fake `ctx.sessionQuery`: scripted cold logs and folded titles. */
export class FakeSessionQuery {
  private readonly logs = new Map<string, readonly SessionEvent[]>()
  private readonly titles = new Map<string, string>()
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

  /**
   * Seed one persisted Session's log and folded title.
   * @param sessionId - persisted Session identity.
   * @param events - complete raw event log.
   * @param title - folded title, when one exists.
   * @returns this fake, for chaining.
   */
  seed(sessionId: string, events: readonly SessionEvent[], title?: string): this {
    this.logs.set(sessionId, [...events])
    if (title !== undefined) this.titles.set(sessionId, title)
    return this
  }

  /** Every persisted Session record, newest-listed first. */
  async listSessions(): Promise<Array<{ header: SessionHeader }>> {
    this.listSessionsCalls += 1
    if (this.listError !== undefined) throw this.listError
    return [...this.logs.keys()].map(id => ({ header: { id: SessionId(id) } as unknown as SessionHeader }))
  }

  /**
   * Read one persisted Session log.
   * @param sessionId - persisted Session identity.
   * @returns the complete raw event log.
   */
  async readSession(sessionId: SessionId): Promise<{ events: readonly SessionEvent[] }> {
    this.readSessionCalls += 1
    if (this.readError !== undefined) throw this.readError
    const events = this.logs.get(String(sessionId))
    if (events === undefined) throw new Error(`persisted Session ${String(sessionId)} does not exist`)
    return { events }
  }

  /**
   * Read one persisted Session title and header together.
   * @param sessionId - persisted Session identity.
   * @returns the header and optional title, as the query engine observes them.
   */
  async readTitleSnapshot(sessionId: SessionId): Promise<{ session: SessionHeader; title?: SessionTitleSnapshot }> {
    this.readTitleCalls += 1
    if (this.readError !== undefined) throw this.readError
    const events = this.logs.get(String(sessionId))
    if (events === undefined) throw new Error(`persisted Session ${String(sessionId)} does not exist`)
    const title = this.snapshotOf(String(sessionId))
    return {
      session: { id: sessionId } as unknown as SessionHeader,
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
      return {
        status: 'fulfilled' as const,
        value: {
          session: { id: sessionId } as unknown as SessionHeader,
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
    const title = this.titles.get(sessionId)
    if (title === undefined) return undefined
    return { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 0 as never, updatedAt: T0 }
  }

  /** Session-query-shaped value for `ctx.provide`. */
  asService(): SessionQueryEngine {
    return this as unknown as SessionQueryEngine
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
  /** Whether the lead Agent is registered live before the service loads. */
  readonly registerLeadAgent?: boolean
  /** Fake Workspace registry to provide. */
  readonly workspaceRegistry?: FakeWorkspaceRegistry
  /** Fake Session controller to provide. */
  readonly sessionController?: FakeSessionController
  /** Fake Session query engine to provide (cold logs and titles). */
  readonly sessionQuery?: FakeSessionQuery
  /** Fake optional Git worktree capability to provide; omitted models a Host without it. */
  readonly worktrees?: FakeWorktreesCapability
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
  readonly worktrees: FakeWorktreesCapability | undefined
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
  if (options.persistence !== false) {
    ctx.on('session/flush', () => {
      if (options.flushFailure !== undefined) throw options.flushFailure
    })
  }
  const leadId = options.leadId ?? `service-lead-${String(bootCounter)}`
  const leadSession = options.leadCwd === undefined
    ? ctx.sessions.create(SessionId(leadId))
    : ctx.sessions.create(SessionId(leadId), { meta: { cwd: options.leadCwd } })
  const sessions: Record<string, Session> = { [leadId]: leadSession }
  for (const id of options.sessionIds ?? []) sessions[id] = ctx.sessions.create(SessionId(id))
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
  // Provided only when asked for: every other spec deliberately models a Host
  // that composes no experimental Git worktree service.
  if (options.worktrees !== undefined) ctx.provide('worktrees', options.worktrees)
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
    worktrees: options.worktrees,
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
  if (options.persistence !== false) {
    ctx.on('session/flush', () => {
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
        wakeColdSession: options.wakeColdSession ?? false,
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
    dispose: () => disposeContext(ctx),
  }
}

/** Build one human-authored user message fixture. */
export function humanMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
