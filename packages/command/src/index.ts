/**
 * Human-facing `/devlead` command over the DevLead core service: flip the
 * human-only mode switch for the receiving Session, watch or unwatch another
 * Session (exact id or unique id prefix), and inspect the current mode, watch
 * set, and recent notification digest.
 *
 * The command is the only human entry point the DevLead UI uses (`/devlead on`
 * and `/devlead off` via the remote command executor), so it owns every
 * friendly error for the domain failures a human can hit here.
 *
 * @module @yankeguo/dsh-command-devlead
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { isDevLeadError } from '@yankeguo/dsh-devlead'
import type { DevLeadError } from '@yankeguo/dsh-devlead'
// Type-only: pulls the core service's `ctx.devLead` Context merge.
import type {} from '@yankeguo/dsh-devlead'
import { DEVLEAD_COMMAND_NAME } from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadSessionView } from '@yankeguo/dsh-devlead-protocol'
import { COMMAND_GRAMMAR, USAGE, parseDevLeadCommand } from './parse.ts'
import type { DevLeadCommand } from './parse.ts'
import { RECENT_NOTIFICATION_LIMIT, errorResult, renderStatus } from './render.ts'
import type { DevLeadStatusSnapshot } from './render.ts'
import { formatCandidates, mergeCandidates, resolveSessionReference, sessionRefLabel } from './resolve.ts'
import type { SessionCandidate } from './resolve.ts'

/** Plugin name reported to the Cordis loader. */
export const name = 'command-devlead'

/** Services this plugin needs. */
export const inject = ['commands', 'devLead']

const DESCRIPTION =
  'Turn DevLead mode on or off for this Session, watch or unwatch another Session, '
  + 'and inspect the DevLead mode, watch set, and recent notification digest.'

/** Shown whenever a write needs DevLead mode and the receiving Session is not a lead. */
const NOT_ENABLED_MESSAGE =
  'DevLead mode is off for this Session, so its watch set cannot change. '
  + 'Turn it on with /devlead on first.'

/**
 * Collect the current status: one Session projection read for the mode, watch
 * set, and retained digest, plus the host's rows for the watched Sessions.
 * @param ctx - host context carrying `ctx.devLead`.
 * @param invocation - command invocation supplying the agent and signal.
 * @returns one renderable status snapshot taken from a single projection read.
 */
async function collectStatus(ctx: Context, invocation: CommandInvocation): Promise<DevLeadStatusSnapshot> {
  // One projection read supplies every durable fact, so the mode, the watch
  // set, and the digest cannot disagree with a concurrent append.
  const view = ctx.devLead.view(invocation.agent)
  const watched: DevLeadSessionView[] = []
  const missingWatched: string[] = []
  if (view.sessions.length > 0) {
    const sessions = await ctx.devLead.listSessions(invocation.agent, {
      watchedOnly: true,
      signal: invocation.signal,
    })
    const byId = new Map(sessions.map(session => [session.sessionId, session]))
    for (const sessionId of view.sessions) {
      const session = byId.get(sessionId)
      if (session === undefined) missingWatched.push(sessionId)
      else watched.push(session)
    }
  }
  return {
    enabled: view.enabled,
    worktreeIsolation: ctx.devLead.worktreeIsolationAvailable,
    watched,
    missingWatched,
    notifications: view.notifications.slice(-RECENT_NOTIFICATION_LIMIT),
  }
}

/**
 * Collect every Session reference the command can resolve against: the host's
 * Session listing plus this lead's watch set, so a stale watched id can still
 * be unwatched.
 * @param ctx - host context carrying `ctx.devLead`.
 * @param invocation - command invocation supplying the signal.
 * @param watchedSessionIds - this lead's complete watch set.
 * @returns addressable Session candidates without duplicates.
 */
async function collectCandidates(
  ctx: Context,
  invocation: CommandInvocation,
  watchedSessionIds: readonly string[],
): Promise<SessionCandidate[]> {
  const sessions = await ctx.devLead.listSessions(invocation.agent, { signal: invocation.signal })
  return mergeCandidates(sessions, watchedSessionIds)
}

/** Render one ambiguous Session reference with its bounded candidate list. */
function ambiguousResult(query: string, candidates: readonly SessionCandidate[]): CommandResult {
  return errorResult([
    `Session reference "${query}" is ambiguous; it matches ${candidates.length} Sessions:`,
    ...formatCandidates(candidates),
    'Use a longer prefix or the full Session id.',
  ].join('\n'))
}

/** Render one Session reference that matches no addressable Session. */
function missingSessionResult(query: string): CommandResult {
  return errorResult(
    `No Session matches "${query}". Check the Session id, `
    + 'or run /devlead to inspect the watched Sessions.',
  )
}

/** Outcome of asking the core service to resolve a reference beyond the command's listing. */
type CoreSessionResolution =
  | { readonly kind: 'resolved'; readonly sessionId: string; readonly title?: string }
  | { readonly kind: 'ambiguous'; readonly message: string }
  | { readonly kind: 'missing' }

/**
 * Resolve a reference the command's own listing could not match by asking the
 * core service. The listing is bounded and need not include every cold Session
 * the Host knows, so `ctx.devLead.getSession` remains the authoritative resolver
 * for references outside it (a full id or a unique prefix alike).
 * @param ctx - host context carrying `ctx.devLead`.
 * @param invocation - command invocation supplying the agent and signal.
 * @param reference - human-supplied Session reference.
 * @returns the resolution, treating the core's ambiguity code as a candidate message.
 */
async function resolveBeyondListing(
  ctx: Context,
  invocation: CommandInvocation,
  reference: string,
): Promise<CoreSessionResolution> {
  try {
    const view = await ctx.devLead.getSession(invocation.agent, reference, invocation.signal)
    return view.title === undefined
      ? { kind: 'resolved', sessionId: view.sessionId }
      : { kind: 'resolved', sessionId: view.sessionId, title: view.title }
  } catch (error: unknown) {
    if (!isDevLeadError(error)) throw error
    if (error.code === 'DEVLEAD_INVALID_INPUT') return { kind: 'ambiguous', message: error.message }
    if (error.code === 'DEVLEAD_SESSION_NOT_FOUND') return { kind: 'missing' }
    throw error
  }
}

/** One resolved watch target, or the result that reports why it could not be resolved. */
type WatchTargetResolution =
  | { readonly kind: 'resolved'; readonly sessionId: string; readonly title?: string }
  | { readonly kind: 'failure'; readonly result: CommandResult }

/**
 * Resolve one Session reference for a watch mutation: the command listing first
 * (friendly ambiguity candidates with titles), then the core resolver for
 * Sessions the bounded listing does not include.
 * @param ctx - host context carrying `ctx.devLead`.
 * @param invocation - command invocation supplying the agent and signal.
 * @param reference - human-supplied Session reference.
 * @param watchedSessionIds - this lead's complete watch set.
 * @returns the resolved target or a friendly error result.
 */
async function resolveWatchTarget(
  ctx: Context,
  invocation: CommandInvocation,
  reference: string,
  watchedSessionIds: readonly string[],
): Promise<WatchTargetResolution> {
  const candidates = await collectCandidates(ctx, invocation, watchedSessionIds)
  const resolution = resolveSessionReference(reference, candidates)
  if (resolution.kind === 'resolved') return resolution
  if (resolution.kind === 'ambiguous') {
    return { kind: 'failure', result: ambiguousResult(reference, resolution.candidates) }
  }
  const fallback = await resolveBeyondListing(ctx, invocation, reference)
  if (fallback.kind === 'resolved') return fallback
  if (fallback.kind === 'ambiguous') {
    return {
      kind: 'failure',
      result: errorResult(`${fallback.message}\nUse a longer prefix or the full Session id.`),
    }
  }
  return { kind: 'failure', result: missingSessionResult(reference) }
}

/** Execute `/devlead on` or `/devlead off`. */
async function executeMode(
  ctx: Context,
  invocation: CommandInvocation,
  enabled: boolean,
): Promise<CommandResult> {
  if (ctx.devLead.view(invocation.agent).enabled === enabled) {
    const title = enabled ? 'DevLead mode is already on.' : 'DevLead mode is already off.'
    return renderStatus(await collectStatus(ctx, invocation), title)
  }
  await ctx.devLead.setEnabled(invocation.agent, enabled, invocation.signal)
  const title = enabled ? 'DevLead mode enabled.' : 'DevLead mode disabled.'
  return renderStatus(await collectStatus(ctx, invocation), title)
}

/** Execute `/devlead watch <session>` or `/devlead unwatch <session>`. */
async function executeWatch(
  ctx: Context,
  invocation: CommandInvocation,
  command: Extract<DevLeadCommand, { kind: 'watch' | 'unwatch' }>,
): Promise<CommandResult> {
  const view = ctx.devLead.view(invocation.agent)
  if (!view.enabled) return errorResult(NOT_ENABLED_MESSAGE)
  const target = await resolveWatchTarget(ctx, invocation, command.session, view.sessions)
  if (target.kind === 'failure') return target.result
  const { sessionId } = target
  const label = sessionRefLabel(sessionId, target.title)
  const watching = view.sessions.includes(sessionId)
  if (command.kind === 'watch') {
    const title = watching ? `Already watching ${label}.` : `Now watching ${label}.`
    if (!watching) await ctx.devLead.watchSession(invocation.agent, sessionId, true, invocation.signal)
    return renderStatus(await collectStatus(ctx, invocation), title)
  }
  const title = watching ? `Stopped watching ${label}.` : `Not watching ${label}.`
  if (watching) await ctx.devLead.watchSession(invocation.agent, sessionId, false, invocation.signal)
  return renderStatus(await collectStatus(ctx, invocation), title)
}

/** Render one core domain failure as a friendly command error instead of a throw. */
function friendlyDevLeadError(error: DevLeadError): string {
  switch (error.code) {
    case 'DEVLEAD_NOT_ENABLED':
      return NOT_ENABLED_MESSAGE
    case 'DEVLEAD_AGENT_NOT_LIVE':
      return 'This Session is no longer live in this Host, so the command cannot run. '
        + 'Open it again from the sidebar and retry.'
    case 'DEVLEAD_INVALID_INPUT':
      return `The /devlead request is not usable: ${error.message}`
    case 'DEVLEAD_SESSION_NOT_FOUND':
      return `The host could not find that Session: ${error.message}`
    case 'DEVLEAD_SESSION_ARCHIVED':
      return 'That Session is archived; restore it from the Workspace sidebar before watching it.'
    case 'DEVLEAD_SESSION_UNAVAILABLE':
      return `That Session cannot be resumed right now: ${error.message}`
    case 'DEVLEAD_WATCH_LIMIT':
      return 'The maximum number of watched Sessions has been reached. '
        + 'Stop watching one with /devlead unwatch <session> first.'
    case 'DEVLEAD_SELF_WATCH':
      return 'A DevLead Session cannot watch itself.'
    case 'DEVLEAD_PROJECTION_INVALID':
      return `This Session's DevLead records are damaged: ${error.message}. `
        + 'Inspect the Session log for the offending plugin:devlead record.'
    case 'DEVLEAD_WORKSPACE_NOT_FOUND':
      return `The Workspace could not be resolved: ${error.message}`
    case 'DEVLEAD_DIRECTORY_MISSING':
      return `The target directory is missing: ${error.message}`
    default:
      return `The DevLead request failed: ${error.message}`
  }
}

/** Execute one already-parsed command against the core service. */
async function executeDevLeadCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const command = parseDevLeadCommand(invocation.rawInput)
  if (command.kind === 'invalid') return errorResult(`${command.message}\n${USAGE}`)
  try {
    switch (command.kind) {
      case 'status':
        return renderStatus(await collectStatus(ctx, invocation))
      case 'on':
      case 'off':
        return await executeMode(ctx, invocation, command.kind === 'on')
      case 'watch':
      case 'unwatch':
        return await executeWatch(ctx, invocation, command)
    }
  } catch (error: unknown) {
    if (isDevLeadError(error)) return errorResult(friendlyDevLeadError(error))
    throw error
  }
}

/** Register the `/devlead` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@yankeguo/dsh-command-devlead'),
    name: DEVLEAD_COMMAND_NAME,
    description: DESCRIPTION,
    // The grammar is text-only, so the definition deliberately declares no
    // `input.attachments`: the CommandRuntime then rejects composer attachments
    // before this handler runs, and no handler-side guard is needed.
    input: { hint: COMMAND_GRAMMAR },
    handler: invocation => executeDevLeadCommand(ctx, invocation),
  })
}
