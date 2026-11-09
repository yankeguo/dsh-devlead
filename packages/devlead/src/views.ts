/**
 * Read-side composition of the DevLead views: Workspace rows, Session rows
 * with live Agent state and folded log facts, and reference resolution
 * (id / path / unique id prefix).
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
import {
  DEVLEAD_ERROR_EXCERPT_MAX,
  excerptLine,
  isDevLeadTransition,
} from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadSessionView,
  DevLeadTransition,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import { DevLeadError } from './error.ts'

/** Read-side services and limits shared by every view builder. */
export interface DevLeadViewDeps {
  /** Host context carrying the optional capabilities. */
  readonly ctx: Context
  /** Maximum Session rows one listing may yield. */
  readonly maxListedSessions: number
  /** Whether this lead watches one Session id. */
  readonly isWatched: (sessionId: string) => boolean
  /** Complete watch set of this lead, in add order. */
  readonly watchedSessions: readonly string[]
}

/** One resolved Session reference and whether an Agent is currently live. */
export interface ResolvedSession {
  readonly sessionId: SessionId
  readonly live: boolean
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

/** Known header facts of one listed Session, gathered without activating it. */
interface KnownSession {
  readonly header: SessionHeader | undefined
  readonly live: boolean
}

/**
 * Collect the Session ids one listing should consider: live Agents, live
 * Sessions without an Agent, Workspace accounting, the lead's watch set, and —
 * when the query engine is composed — persisted Sessions beyond the live set.
 * @param deps - view dependencies.
 * @param workspace - restrict to one Workspace's accounting when provided.
 * @returns candidate ids, most recently active first where known.
 */
export async function collectSessionIds(
  deps: DevLeadViewDeps,
  workspace: Workspace | undefined,
): Promise<string[]> {
  const { ctx } = deps
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
        const records = await query.listSessions()
        for (const record of records) {
          if (ids.size >= deps.maxListedSessions) break
          if (record.header.origin === 'subagent') continue
          ids.add(record.header.id)
        }
      } catch {
        // A listing that fails only loses the cold rows; live facts stay valid.
      }
    }
  }
  return [...ids].filter(admissible)
}

/**
 * Fold the latest title for one Session without activating it.
 * @param deps - view dependencies.
 * @param sessionId - Session identity.
 * @returns the title, or undefined when none was folded.
 */
async function foldedTitle(deps: DevLeadViewDeps, sessionId: string): Promise<string | undefined> {
  const live = deps.ctx.sessions.get(toSessionId(sessionId))
  if (live !== undefined) {
    const snapshot = deps.ctx.get('sessionTitle')?.get(live)
    if (snapshot !== undefined) return snapshot.title
  }
  const query = deps.ctx.get('sessionQuery')
  if (query === undefined) return undefined
  try {
    const snapshot = await query.readTitle(toSessionId(sessionId))
    return snapshot?.title
  } catch {
    return undefined
  }
}

/**
 * Read title, header, and existence facts for one batch of Sessions.
 * @param deps - view dependencies.
 * @param ids - Session identities.
 * @returns per-id title, header, live flag, and recorded cwd.
 */
async function knownSessions(
  deps: DevLeadViewDeps,
  ids: readonly string[],
): Promise<Map<string, { title: string | undefined; header: SessionHeader | undefined; live: boolean }>> {
  const { ctx } = deps
  const result = new Map<string, { title: string | undefined; header: SessionHeader | undefined; live: boolean }>()
  const pendingTitles: string[] = []
  for (const id of ids) {
    const session = ctx.sessions.get(toSessionId(id))
    const agent = ctx.agents.get(toSessionId(id))
    const live = session !== undefined || agent !== undefined
    const sessionObject: Session | undefined = session ?? agent?.session
    let title: string | undefined = sessionObject === undefined
      ? undefined
      : ctx.get('sessionTitle')?.get(sessionObject)?.title
    if (title === undefined) pendingTitles.push(id)
    result.set(id, { title, header: sessionObject?.header, live })
  }
  if (pendingTitles.length > 0) {
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      try {
        const observations = await query.readTitleSnapshots(pendingTitles.map(id => toSessionId(id)))
        for (const observation of observations) {
          if (observation.status !== 'fulfilled') continue
          const { session, title: snapshot } = observation.value
          const id = String(session.id)
          const entry = result.get(id)
          if (entry === undefined) continue
          result.set(id, { ...entry, title: snapshot?.title ?? entry.title, header: session })
        }
      } catch {
        // Titles and cold headers degrade to unknown facts; the row still lists.
      }
    }
  }
  return result
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
    const blocks: readonly unknown[] = event.data.message.content
    const text = blocks
      .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      .map(block => block.text)
      .join(' ')
    const excerpt = excerptLine(text, DEVLEAD_ERROR_EXCERPT_MAX)
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
 * @returns folded facts, empty when the engine is absent or the read fails.
 */
async function sessionLogFacts(deps: DevLeadViewDeps, sessionId: string): Promise<LogFacts> {
  const query = deps.ctx.get('sessionQuery')
  if (query === undefined) return {}
  let events: readonly SessionEvent[]
  try {
    const snapshot = await query.readSession(toSessionId(sessionId))
    events = snapshot.events
  } catch {
    return {}
  }
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
      if (isDevLeadTransition(kind)) {
        lastTransition = kind
        lastError = kind === 'error' ? event.data.reason.error.message : undefined
      }
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
 * @param known - pre-read title/header/live facts; omitted to read them here.
 * @returns the detached view.
 */
async function buildSessionView(
  deps: DevLeadViewDeps,
  sessionId: string,
  withLog: boolean,
  known?: { title: string | undefined; header: SessionHeader | undefined; live: boolean },
): Promise<DevLeadSessionView> {
  const { ctx } = deps
  const facts = known ?? (await knownSessions(deps, [sessionId])).get(sessionId)
  const session = ctx.sessions.get(toSessionId(sessionId))
  const agent = ctx.agents.get(toSessionId(sessionId))
  const archived = ctx.get('workspaceRegistry')?.archivedSessionIds.includes(toSessionId(sessionId)) ?? false
  const workspace = workspaceOf(deps, sessionId)
  const live = facts?.live ?? false
  const boundary = agent === undefined ? undefined : ctx.agents.turnBoundaryOf(agent.session)
  const log = withLog ? await sessionLogFacts(deps, sessionId) : {}
  return {
    sessionId,
    ...(facts?.title === undefined ? {} : { title: facts.title }),
    ...(workspace === undefined ? {} : { workspaceId: workspace.id, workspaceTitle: workspace.title }),
    ...(facts?.header?.cwd === undefined ? {} : { cwd: facts.header.cwd }),
    live,
    running: agent?.status === 'running',
    watched: deps.isWatched(sessionId),
    archived,
    ...(boundary === undefined ? {} : { lastTurn: boundary.lastTurn }),
    ...(agent === undefined ? {} : { pendingInputs: agent.inbox.nextTurn.length + agent.inbox.nextStep.length }),
    ...log,
    ...(log.lastTurn === undefined && boundary !== undefined ? { lastTurn: boundary.lastTurn } : {}),
    ...(facts?.header?.createdAt === undefined ? {} : { createdAt: facts.header.createdAt }),
  }
}

/**
 * Find the Workspace whose accounting contains one Session.
 * @param deps - view dependencies.
 * @param sessionId - Session identity.
 * @returns the accounting Workspace, or undefined.
 */
export function workspaceOf(deps: DevLeadViewDeps, sessionId: string): Workspace | undefined {
  const registry = deps.ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(toSessionId(sessionId))) return workspace
  }
  return undefined
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
  return await buildSessionView(deps, sessionId, withLog)
}

/**
 * Build a listing of Session views.
 * @param deps - view dependencies.
 * @param ids - candidate Session identities, most relevant first.
 * @param withLog - include folded log facts per row.
 * @returns detached views in candidate order.
 */
export async function devLeadSessionViews(
  deps: DevLeadViewDeps,
  ids: readonly string[],
  withLog: boolean,
): Promise<DevLeadSessionView[]> {
  const facts = await knownSessions(deps, ids)
  const views: DevLeadSessionView[] = []
  for (const id of ids) {
    views.push(await buildSessionView(deps, id, withLog, facts.get(id)))
  }
  return views
}

/**
 * Resolve one Workspace reference: a record id, a registered path, or a
 * directory path the registry already knows.
 * @param ctx - host context.
 * @param reference - Workspace id or path.
 * @returns the resolved Workspace.
 * @throws {@link DevLeadError} `DEVLEAD_WORKSPACE_NOT_FOUND` when nothing matches.
 */
export async function resolveWorkspaceReference(ctx: Context, reference: string): Promise<Workspace> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    throw new DevLeadError('this Host composes no Workspace registry', 'DEVLEAD_WORKSPACE_NOT_FOUND')
  }
  const trimmed = reference.trim()
  const byId = registry.list().find(workspace => workspace.id === trimmed)
  if (byId !== undefined) return byId
  try {
    const byPath = await registry.resolveByPath(trimmed)
    if (byPath !== undefined) return byPath
  } catch {
    // A path outside the registry falls through to the not-found failure.
  }
  throw new DevLeadError(
    `no Workspace matches "${reference}"; register the repository directory first with devlead_use_workspace`,
    'DEVLEAD_WORKSPACE_NOT_FOUND',
  )
}

/**
 * Resolve one Session reference: exact id, or a unique id prefix. Candidates
 * are gathered from live and persisted Sessions plus this lead's watch set.
 * @param deps - view dependencies.
 * @param reference - Session id or unique prefix.
 * @returns the resolved Session and its live-Agent status.
 * @throws {@link DevLeadError} on ambiguity or a missing Session.
 */
export async function resolveSessionReference(
  deps: DevLeadViewDeps,
  reference: string,
): Promise<ResolvedSession> {
  const trimmed = reference.trim()
  if (trimmed.length === 0) throw new DevLeadError('a Session id is required', 'DEVLEAD_INVALID_INPUT')
  const candidates = await collectSessionIds(deps, undefined)
  const exact = candidates.find(id => id === trimmed)
  let resolvedId = exact
  if (resolvedId === undefined) {
    const matched = candidates.filter(id => id.startsWith(trimmed))
    if (matched.length === 0) {
      throw new DevLeadError(`no Session matches "${reference}"`, 'DEVLEAD_SESSION_NOT_FOUND')
    }
    if (matched.length > 1) {
      throw new DevLeadError(
        `Session prefix "${reference}" is ambiguous: ${matched.slice(0, 8).join(', ')}`,
        'DEVLEAD_INVALID_INPUT',
      )
    }
    resolvedId = matched[0]
  }
  const sessionId = toSessionId(resolvedId as string)
  return { sessionId, live: deps.ctx.agents.get(sessionId) !== undefined }
}
