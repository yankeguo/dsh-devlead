/**
 * Read-side composition of the DevLead views: Workspace rows, Session rows
 * with live Agent state and folded log facts, and reference resolution
 * (id / path / unique id prefix, including a truncated uuid head whose
 * `session-` prefix the caller omitted).
 *
 * Every optional capability is read through `ctx.get(...)` so a composition
 * without the API Session controller, Session query engine, title service, or
 * Workspace registry degrades to fewer fields instead of failing the tool.
 *
 * @module @yankeguo/dsh-devlead
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { isDevLeadTransition } from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadSessionView,
  DevLeadTransition,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import { assistantExcerpt, failureExcerpt } from './domain.ts'
import { DevLeadError } from './error.ts'

/** Read-side services, limits, and cancellation shared by every view builder. */
export interface DevLeadViewDeps {
  /** Host context carrying the optional capabilities. */
  readonly ctx: Context
  /** Maximum Session rows one listing may yield. */
  readonly maxListedSessions: number
  /** Whether this lead watches one Session id. */
  readonly isWatched: (sessionId: string) => boolean
  /** Complete watch set of this lead, in add order. */
  readonly watchedSessions: readonly string[]
  /** Cancellation checked between reads and rows, and threaded into query reads. */
  readonly signal?: AbortSignal
}

/** One resolved Session reference and whether an Agent is currently live. */
export interface ResolvedSession {
  readonly sessionId: SessionId
  readonly live: boolean
}

/** Known non-log facts of one Session, gathered without activating it. */
interface KnownFacts {
  /** Latest folded title, when a title service or the query engine knows one. */
  readonly title: string | undefined
  /** Recorded header, from the live Session or the query engine's clone. */
  readonly header: SessionHeader | undefined
  /** Whether a Session or Agent for the id is live in the host registries. */
  readonly live: boolean
}

/**
 * Batch facts one listing or detail view needs beyond the live registries:
 * per-Session titles and headers, Workspace accounting, and archive state.
 */
export interface SessionFacts {
  /** Per-Session title/header/liveness, keyed by Session id. */
  readonly known: ReadonlyMap<string, KnownFacts>
  /** First Workspace accounting each Session, keyed by Session id. */
  readonly workspaces: ReadonlyMap<string, Workspace>
  /** Whether the Workspace registry lists one Session as archived. */
  readonly archived: ReadonlySet<string>
}

/**
 * Fold one Workspace entity into its model-facing view.
 * @param workspace - registry entity.
 * @returns the detached view.
 */
export async function devLeadWorkspaceView(workspace: Workspace): Promise<DevLeadWorkspaceView> {
  const status = await workspace.status()
  return {
    workspaceId: workspace.id,
    title: workspace.title,
    path: workspace.path,
    status,
    sessionIds: workspace.sessionIds,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/**
 * Re-throw a read failure the caller cancelled instead of degrading it to an
 * unknown fact: best-effort reads only swallow genuine capability failures.
 * @param error - caught failure.
 * @param signal - caller cancellation.
 */
function rethrowIfAborted(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw error
}

/**
 * Collect the Session ids one listing should consider: live Agents, live
 * Sessions without an Agent, Workspace accounting, the lead's watch set, and —
 * when the query engine is composed — persisted Sessions beyond the live set.
 *
 * The persisted-Session window is bounded by `maxListedSessions` for listings,
 * where only the retained rows are ever read. Identity resolution passes
 * `exhaustive: true` instead: the cap belongs to row lists, never to whether an
 * exact id or unique prefix is addressable.
 * @param deps - view dependencies.
 * @param workspace - restrict to one Workspace's accounting when provided.
 * @param exhaustive - scan every persisted Session instead of the listing window.
 * @returns candidate ids, deduplicated, without subagent-origin Sessions.
 */
export async function collectSessionIds(
  deps: DevLeadViewDeps,
  workspace: Workspace | undefined,
  exhaustive = false,
): Promise<string[]> {
  const { ctx, signal } = deps
  const ids = new Set<string>()
  /** Subagent-origin Sessions are routed by the subagent runtime and are not addressable here. */
  const admissible = (id: string): boolean => {
    const session = ctx.sessions.get(toSessionId(id)) ?? ctx.agents.get(toSessionId(id))?.session
    return session === undefined || session.header.origin !== 'subagent'
  }
  if (workspace !== undefined) {
    for (const id of workspace.sessionIds) ids.add(id)
  } else {
    for (const agent of ctx.agents.list()) {
      if (agent.session.header.origin !== 'subagent') ids.add(agent.id)
    }
    for (const session of ctx.sessions.list()) {
      if (session.header.origin !== 'subagent') ids.add(session.id)
    }
    for (const id of deps.watchedSessions) ids.add(id)
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      for (const entry of registry.list()) {
        for (const id of entry.sessionIds) ids.add(id)
      }
    }
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      try {
        const records = await query.listSessions(signal)
        for (const record of records) {
          if (!exhaustive && ids.size >= deps.maxListedSessions) break
          if (record.header.origin === 'subagent') continue
          ids.add(record.header.id)
        }
      } catch (error: unknown) {
        rethrowIfAborted(error, signal)
        // A listing that fails only loses the cold rows; live facts stay valid.
      }
    }
  }
  signal?.throwIfAborted()
  return [...ids].filter(admissible)
}

/**
 * Read title, header, and existence facts for one batch of Sessions.
 * @param deps - view dependencies.
 * @param ids - Session identities.
 * @returns per-id title, header, and live flag.
 */
async function knownSessions(
  deps: DevLeadViewDeps,
  ids: readonly string[],
): Promise<Map<string, KnownFacts>> {
  const { ctx, signal } = deps
  const result = new Map<string, KnownFacts>()
  const pendingTitles: string[] = []
  for (const id of ids) {
    const session = ctx.sessions.get(toSessionId(id))
    const agent = ctx.agents.get(toSessionId(id))
    const live = session !== undefined || agent !== undefined
    const sessionObject: Session | undefined = session ?? agent?.session
    const title: string | undefined = sessionObject === undefined
      ? undefined
      : ctx.get('sessionTitle')?.get(sessionObject)?.title
    if (title === undefined) pendingTitles.push(id)
    result.set(id, { title, header: sessionObject?.header, live })
  }
  if (pendingTitles.length > 0) {
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      try {
        const observations = await query.readTitleSnapshots(pendingTitles.map(id => toSessionId(id)), signal)
        for (const observation of observations) {
          if (observation.status !== 'fulfilled') continue
          const { session, title: snapshot } = observation.value
          const id = String(session.id)
          const entry = result.get(id)
          if (entry === undefined) continue
          result.set(id, { ...entry, title: snapshot?.title ?? entry.title, header: session })
        }
      } catch (error: unknown) {
        rethrowIfAborted(error, signal)
        // Titles and cold headers degrade to unknown facts; the row still lists.
      }
    }
  }
  return result
}

/**
 * Gather every non-log fact one listing or detail view needs: known Session
 * facts, Workspace accounting, and archive state. The Workspace registry is
 * scanned once instead of once per row.
 * @param deps - view dependencies.
 * @param ids - Session identities the views will report.
 * @returns the batch facts.
 */
export async function readSessionFacts(
  deps: DevLeadViewDeps,
  ids: readonly string[],
): Promise<SessionFacts> {
  const known = await knownSessions(deps, ids)
  const workspaces = new Map<string, Workspace>()
  const archived = new Set<string>()
  const registry = deps.ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    const requested = new Set(ids)
    for (const sessionId of registry.archivedSessionIds) {
      const id = String(sessionId)
      if (requested.has(id)) archived.add(id)
    }
    for (const workspace of registry.list()) {
      for (const sessionId of workspace.sessionIds) {
        const id = String(sessionId)
        if (!requested.has(id) || workspaces.has(id)) continue
        workspaces.set(id, workspace)
      }
    }
  }
  return { known, workspaces, archived }
}

/**
 * Rank candidate ids by the cheap live facts and cap the listing, so full
 * Session views are only built for rows the caller receives.
 *
 * Priority: watched first, then running, then most recently created; Session
 * id breaks ties so ordering is deterministic.
 * @param deps - view dependencies.
 * @param ids - candidate ids.
 * @param facts - pre-read batch facts.
 * @param limit - maximum retained rows, already validated as positive.
 * @returns the retained ids in display order.
 */
export function rankSessionIds(
  deps: DevLeadViewDeps,
  ids: readonly string[],
  facts: SessionFacts,
  limit: number,
): string[] {
  const ranked = ids.map((id) => ({
    id,
    watched: deps.isWatched(id),
    running: deps.ctx.agents.get(toSessionId(id))?.status === 'running',
    createdAt: facts.known.get(id)?.header?.createdAt ?? 0,
  }))
  ranked.sort((left, right) => {
    if (left.watched !== right.watched) return left.watched ? -1 : 1
    if (left.running !== right.running) return left.running ? -1 : 1
    return right.createdAt - left.createdAt || left.id.localeCompare(right.id)
  })
  return ranked.slice(0, Math.max(1, limit)).map(entry => entry.id)
}

/**
 * Render one bounded excerpt of the latest assistant text in a log.
 * @param events - complete raw Session events.
 * @returns the excerpt, or undefined when no assistant text was recorded.
 */
function lastAssistantExcerpt(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const excerpt = assistantExcerpt(event.data.message.content)
    if (excerpt !== undefined) return excerpt
  }
  return undefined
}

/** Folded log facts of one Session, read only for single-Session detail views. */
interface LogFacts {
  readonly lastTurn?: number
  readonly lastTransition?: DevLeadTransition
  readonly lastError?: string
  readonly lastAssistant?: string
  readonly updatedAt?: number
}

/**
 * Fold turn and assistant facts from one Session log through the query engine.
 * @param deps - view dependencies.
 * @param sessionId - Session identity.
 * @returns folded facts, empty when the engine is absent, the read fails, or
 *   the caller cancels between reads.
 */
async function sessionLogFacts(deps: DevLeadViewDeps, sessionId: string): Promise<LogFacts> {
  const query = deps.ctx.get('sessionQuery')
  if (query === undefined) return {}
  deps.signal?.throwIfAborted()
  let events: readonly SessionEvent[]
  try {
    const snapshot = await query.readSession(toSessionId(sessionId))
    events = snapshot.events
  } catch (error: unknown) {
    rethrowIfAborted(error, deps.signal)
    return {}
  }
  deps.signal?.throwIfAborted()
  const last = events.at(-1)
  let lastTurn: number | undefined
  let lastTransition: DevLeadTransition | undefined
  let lastError: string | undefined
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      lastTurn = Math.max(lastTurn ?? 0, event.data.turn)
    }
    if (event.type === 'turn/end') {
      const kind = event.data.reason.kind
      // TurnEndReasonMap is merge-extensible: report an unknown future kind the
      // same way notifications do instead of keeping a stale earlier outcome.
      lastTransition = isDevLeadTransition(kind) ? kind : 'interrupted'
      // The view type promises a compact excerpt; unbounded provider text would
      // otherwise blow up the tool payload and the command status line.
      lastError = kind === 'error' ? failureExcerpt(event.data.reason.error) : undefined
    }
  }
  const lastAssistant = lastAssistantExcerpt(events)
  return {
    ...(lastTurn === undefined ? {} : { lastTurn }),
    ...(lastTransition === undefined ? {} : { lastTransition }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(last === undefined ? {} : { updatedAt: last.time }),
    ...(lastAssistant === undefined ? {} : { lastAssistant }),
  }
}

/**
 * Build one Session view from live facts plus, when requested, folded log facts.
 * @param deps - view dependencies.
 * @param sessionId - Session identity.
 * @param withLog - read the complete log for turn and assistant facts.
 * @param facts - pre-read batch facts for this Session.
 * @returns the detached view.
 */
async function buildSessionView(
  deps: DevLeadViewDeps,
  sessionId: string,
  withLog: boolean,
  facts: SessionFacts,
): Promise<DevLeadSessionView> {
  const { ctx } = deps
  const known = facts.known.get(sessionId)
  const agent = ctx.agents.get(toSessionId(sessionId))
  const workspace = facts.workspaces.get(sessionId)
  const boundary = agent === undefined ? undefined : ctx.agents.turnBoundaryOf(agent.session)
  const log = withLog ? await sessionLogFacts(deps, sessionId) : {}
  const lastTurn = log.lastTurn ?? boundary?.lastTurn
  return {
    sessionId,
    ...(known?.title === undefined ? {} : { title: known.title }),
    ...(workspace === undefined ? {} : { workspaceId: workspace.id, workspaceTitle: workspace.title }),
    ...(known?.header?.cwd === undefined ? {} : { cwd: known.header.cwd }),
    live: known?.live ?? false,
    running: agent?.status === 'running',
    watched: deps.isWatched(sessionId),
    archived: facts.archived.has(sessionId),
    ...(lastTurn === undefined ? {} : { lastTurn }),
    ...(agent === undefined ? {} : { pendingInputs: agent.inbox.nextTurn.length + agent.inbox.nextStep.length }),
    ...log,
    ...(known?.header?.createdAt === undefined ? {} : { createdAt: known.header.createdAt }),
  }
}

/**
 * Build one Session view by identity.
 * @param deps - view dependencies.
 * @param sessionId - Session identity.
 * @param withLog - include folded log facts.
 * @returns the detached view.
 */
export async function devLeadSessionView(
  deps: DevLeadViewDeps,
  sessionId: string,
  withLog: boolean,
): Promise<DevLeadSessionView> {
  const facts = await readSessionFacts(deps, [sessionId])
  return await buildSessionView(deps, sessionId, withLog, facts)
}

/**
 * Build a listing of Session views.
 * @param deps - view dependencies.
 * @param ids - retained Session identities, in display order.
 * @param withLog - include folded log facts per row.
 * @param facts - pre-read batch facts; omitted to read them here.
 * @returns detached views in candidate order.
 */
export async function devLeadSessionViews(
  deps: DevLeadViewDeps,
  ids: readonly string[],
  withLog: boolean,
  facts?: SessionFacts,
): Promise<DevLeadSessionView[]> {
  const batch = facts ?? await readSessionFacts(deps, ids)
  const views: DevLeadSessionView[] = []
  for (const id of ids) {
    deps.signal?.throwIfAborted()
    views.push(await buildSessionView(deps, id, withLog, batch))
  }
  return views
}

/**
 * Resolve one Workspace reference: a record id, a registered path, or a
 * directory path the registry already knows.
 * @param ctx - host context.
 * @param reference - Workspace id or path.
 * @param signal - cancellation checked before and after the path lookup.
 * @returns the resolved Workspace.
 * @throws {@link DevLeadError} `DEVLEAD_WORKSPACE_NOT_FOUND` when nothing matches.
 */
export async function resolveWorkspaceReference(
  ctx: Context,
  reference: string,
  signal?: AbortSignal,
): Promise<Workspace> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    throw new DevLeadError('this Host composes no Workspace registry', 'DEVLEAD_WORKSPACE_NOT_FOUND')
  }
  const trimmed = reference.trim()
  const byId = registry.list().find(workspace => workspace.id === trimmed)
  if (byId !== undefined) return byId
  try {
    signal?.throwIfAborted()
    const byPath = await registry.resolveByPath(trimmed)
    if (byPath !== undefined) return byPath
  } catch (error: unknown) {
    rethrowIfAborted(error, signal)
    // A path outside the registry falls through to the not-found failure.
  }
  signal?.throwIfAborted()
  throw new DevLeadError(
    `no Workspace matches "${reference}"; register the repository directory first with devlead_use_workspace`,
    'DEVLEAD_WORKSPACE_NOT_FOUND',
  )
}

/**
 * Resolve one exact Session identity without listing the corpus: a live
 * Session or Agent, a watched id, or a persisted Session the query engine can
 * observe. Exact ids must stay addressable beyond the listing window the
 * caller-visible listing is capped to.
 * @param deps - view dependencies.
 * @param reference - trimmed reference that failed no prefix checks yet.
 * @returns the resolved Session, or undefined when no exact Session exists.
 */
async function resolveExactSession(
  deps: DevLeadViewDeps,
  reference: string,
): Promise<ResolvedSession | undefined> {
  const { ctx } = deps
  const sessionId = toSessionId(reference)
  const live = ctx.agents.get(sessionId) !== undefined
  if (deps.watchedSessions.includes(reference)) return { sessionId, live }
  const session = ctx.sessions.get(sessionId) ?? ctx.agents.get(sessionId)?.session
  if (session !== undefined) {
    if (session.header.origin === 'subagent') return undefined
    return { sessionId, live }
  }
  const query = ctx.get('sessionQuery')
  if (query === undefined) return undefined
  try {
    const observation = await query.readTitleSnapshot(sessionId, deps.signal)
    if (observation.session.origin === 'subagent') return undefined
    return { sessionId, live: false }
  } catch (error: unknown) {
    rethrowIfAborted(error, deps.signal)
    // An unobservable exact id falls through to bounded prefix resolution.
    return undefined
  }
}

/** Prefix every ordinary DSH Session id carries in front of its uuid. */
const SESSION_ID_PREFIX = 'session-'

/**
 * Match one trimmed Session reference against candidate ids.
 *
 * A full id (`session-<uuid>`) and a `session-`-prefixed partial id match as
 * plain prefixes. A model reading a truncated log entry often passes only the
 * uuid head (`e59ab350` or `e59ab350-65be`), which is not a prefix of the full
 * id; a reference that omits the `session-` prefix therefore also matches the
 * candidate with that prefix re-added. A unique match resolves and several
 * matches stay ambiguous — this narrows truncation, it never guesses.
 * @param candidates - addressable Session ids in collection order.
 * @param reference - trimmed Session reference.
 * @returns matching ids in candidate order, without duplicates.
 */
function matchSessionIds(candidates: readonly string[], reference: string): string[] {
  const mayOmitPrefix = !reference.startsWith(SESSION_ID_PREFIX)
  const matched = new Set<string>()
  for (const id of candidates) {
    if (id.startsWith(reference)) {
      matched.add(id)
      continue
    }
    if (mayOmitPrefix && id.startsWith(SESSION_ID_PREFIX) && id.slice(SESSION_ID_PREFIX.length).startsWith(reference)) {
      matched.add(id)
    }
  }
  return [...matched]
}

/**
 * Resolve one Session reference: an exact id, a unique id prefix, or the uuid
 * head of an id whose `session-` prefix the caller omitted. Candidates are
 * gathered from live and persisted Sessions plus this lead's watch set.
 * @param deps - view dependencies.
 * @param reference - Session id, unique prefix, or bare uuid prefix.
 * @returns the resolved Session and its live-Agent status.
 * @throws {@link DevLeadError} on ambiguity or a missing Session.
 */
export async function resolveSessionReference(
  deps: DevLeadViewDeps,
  reference: string,
): Promise<ResolvedSession> {
  const trimmed = reference.trim()
  if (trimmed.length === 0) throw new DevLeadError('a Session id is required', 'DEVLEAD_INVALID_INPUT')
  const exact = await resolveExactSession(deps, trimmed)
  if (exact !== undefined) return exact
  const candidates = await collectSessionIds(deps, undefined, true)
  const matched = matchSessionIds(candidates, trimmed)
  const resolvedId = matched.find(id => id === trimmed) ?? (matched.length === 1 ? matched[0] : undefined)
  if (resolvedId === undefined && matched.length === 0) {
    throw new DevLeadError(
      `no Session matches "${reference}"; the id may be incomplete or truncated, so look up the full id with devlead_list_sessions and retry`,
      'DEVLEAD_SESSION_NOT_FOUND',
    )
  }
  if (resolvedId === undefined) {
    throw new DevLeadError(
      `Session prefix "${reference}" is ambiguous: ${matched.slice(0, 8).join(', ')}`,
      'DEVLEAD_INVALID_INPUT',
    )
  }
  const sessionId = toSessionId(resolvedId)
  return { sessionId, live: deps.ctx.agents.get(sessionId) !== undefined }
}
