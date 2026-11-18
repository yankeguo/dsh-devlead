/**
 * Private end-to-end probe plugin for `scripts/e2e-smoke.mjs`.
 *
 * The E2E harness needs Host-side commands that drive DevLead through the
 * **real** composition; the probe never invents facts, it reads every reported
 * value from services:
 *
 *   `devlead-e2e-worktree` (phase 2)
 *     1. register the lead Session's own directory as a Workspace
 *        (`ctx.devLead.useWorkspace(agent, request, signal?)`);
 *     2. create a new Session requested with `isolation: 'worktree'` and no
 *        initial prompt (`ctx.devLead.createSession(agent, request, signal?)`);
 *     3. read the created Session back from the Host store.
 *
 *   `devlead-e2e-inspect` (phase 3)
 *     Resolve the tools a real model step would see for the calling Agent
 *     (`ctx.tools.resolve` + the admitted `ResolvedToolSet`) and assemble the
 *     prompt section text (`ctx.systemPrompt.assemble`), so the harness can
 *     assert the conditional DevLead tool surface and the resident policy for
 *     enabled and disabled modes.
 *
 *   `devlead-e2e-close` (phase 3)
 *     Drive the close lifecycle through `ctx.devLead`: archive / repeat archive
 *     / unarchive a prompted child, refuse an "active" Session through a
 *     temporary `workspace/session-activity` listener, stop it with
 *     `stopRunning`, exercise the self-archive guard, then remove the scratch
 *     Workspace registration and re-register the same directory. Every fact
 *     (registry archive set, Session views, durable log reads, filesystem
 *     survival) is read back and returned as one JSON document.
 *
 *   `devlead-e2e-dispatch` (phase 3)
 *     Exercise creation-time dispatch settings: pick a model from the Host's
 *     own `modelCatalog()` (falling back to the deployment default route when
 *     the catalog is unavailable), create a model-selected child, an Agent
 *     Teams child, an explicit-off child, and an omitted-settings child
 *     through `ctx.devLead`, then read the child Agent and durable log back.
 *     Also exercises an unavailable model id and reports whether a positive
 *     selection was verifiable at all (a credential-less Host exposes no
 *     catalog, so the harness reports SKIP instead of faking it).
 *
 * The probe is a linked-root package of the throwaway profile (a symlink
 * under `<profile>/node_modules/@yankeguo/` pointing at this directory), so
 * its `@deepseek-ai/*` peer dependencies resolve to the installation's own
 * runtime copies instead of a second physical module graph.
 *
 * JSON contracts the harness parses from the success text:
 *
 *   worktree:
 *   {
 *     created: DevLeadCreatedSession,        // session, workspace, prompted, isolation
 *     child: {
 *       sessionId: string,
 *       headerCwd: string | null,            // live child Session header cwd
 *       effectiveCwd: string | null           // ctx.workingDirectory.get(child Session)
 *     }
 *   }
 *
 *   inspect:
 *   {
 *     enabled: boolean,                      // ctx.devLead.isEnabled(caller)
 *     tools: string[],                       // names admitted for a real step
 *     devleadTools: string[],                // subset starting with devlead_
 *     policy: string | null,                 // devlead:policy section text
 *     toolError: string | null,              // activation failure, when any
 *     policyError: string | null             // assembly failure, when any
 *   }
 *
 *   dispatch:
 *   {
 *     defaultModelBefore: ModelSelection | null,   // profile default before any create
 *     defaultModelAfter: ModelSelection | null,    // must equal the before value
 *     model: {
 *       available: boolean,                        // a positive selection was applied
 *       reason: string | null,                     // why not, when unavailable
 *       source: 'catalog' | 'deployment-default' | null,
 *       provider, model,                           // attempted route, when any
 *       catalog: object | null,                    // catalog diagnostics for the report
 *       child: { result, current, modelEvents, error } | null
 *     },
 *     teams: {
 *       available: boolean,
 *       child: { result, enabled, teamEvents } | null,
 *       off: { result, enabled },
 *       unavailable: { code, message, sessionsBefore, sessionsAfter } | null
 *     },
 *     omitted: { modelPresent, agentTeamsPresent },
 *     modelUnavailable: { code, message, sessionsBefore, sessionsAfter },
 *     teamsUnavailableChecked: false,
 *     teamsUnavailableReason: string,
 *     listModels: { view: DevLeadModelCatalog | null, error: { code, message } | null },
 *     presets: { view: DevLeadAgentPresetCatalog | null, error: { code, message } | null }
 *   }
 *
 *   close:
 *   {
 *     workspace: DevLeadWorkspaceView,       // registration snapshot
 *     archive: {
 *       childId: string,
 *       first: { sessionId, archived, stopped },
 *       second: { sessionId, archived, stopped },
 *       unarchive: { sessionId, archived },
 *       archivedSetAfterFirst: string[],
 *       archivedSetAfterSecond: string[],
 *       archivedSetAfterUnarchive: string[],
 *       viewArchivedAfterFirst: boolean,
 *       viewArchivedAfterUnarchive: boolean,
 *       rowArchivedAfterFirst: boolean,
 *       logBefore: { readable, events, source },
 *       logAfterUnarchive: { readable, events, source }
 *     },
 *     active: {
 *       childId: string,
 *       refusedCode: string | null,
 *       refusedMessage: string,
 *       archivedSetAfterRefusal: string[],
 *       stopResult: { sessionId, archived, stopped } | null,
 *       stopError: string | null,
 *       stopRequests: number,
 *       archivedSetAfterStop: string[],
 *       unarchiveAfterStop: { sessionId, archived } | null
 *     },
 *     selfArchive: { code: string | null, message: string },
 *     remove: {
 *       removed: boolean,
 *       snapshotSessionIds: string[],
 *       workspaceIdsAfter: string[],
 *       workspacePath: string,
 *       directoryExists: boolean,
 *       markerContent: string | null,
 *       childViewWorkspaceIdAfter: string | null,
 *       logBefore: { readable, events, source },
 *       logAfter: { readable, events, source },
 *       reRegisteredWorkspaceId: string | null,
 *       reRegisteredSessionIds: string[],
 *       childViewWorkspaceIdAfterReRegister: string | null
 *     }
 *   }
 *
 * A missing service, a failed core call, or a malformed Host answer settles as
 * a command error result instead of throwing, so the E2E harness can print the
 * real failure instead of a generic command-execution error.
 *
 * Test-only package: private, never published, and not part of the workspace.
 * @module @yankeguo/dsh-devlead-e2e-probe
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'

/** Plugin name reported to the Cordis loader. */
export const name = 'devlead-e2e-probe'

/**
 * Services this plugin needs.
 *
 * `commands` provides the registry; `devLead` is the service under test.
 * `sessions` is injected because the probe reads the live Session store;
 * `tools` and `systemPrompt` drive the real step-time tool admission and prompt
 * assembly the inspect command reports. `workspaceRegistry` is read through
 * `ctx.get` (optional capability) like the core service does.
 */
export const inject = ['commands', 'devLead', 'sessions', 'agents', 'tools', 'systemPrompt']

/** Stable, plugin-owned command-definition identity (mirrors the package name). */
const DEFINITION_ID = '@yankeguo/dsh-devlead-e2e-probe'
/** Command name; the harness dispatches `/${COMMAND_NAME}`. */
const COMMAND_NAME = 'devlead-e2e-worktree'
/** Inspection command: report the step-visible DevLead tool surface + policy. */
export const INSPECT_COMMAND_NAME = 'devlead-e2e-inspect'
/** Close-lifecycle command: archive/unarchive/remove through the real Host. */
export const CLOSE_COMMAND_NAME = 'devlead-e2e-close'
/** Dispatch-settings command: creation-time model selection + Agent Teams. */
export const DISPATCH_COMMAND_NAME = 'devlead-e2e-dispatch'
/** Upper bound for one prompted child turn to settle inside the close command. */
const CHILD_TURN_TIMEOUT_MS = 45_000
/** Poll interval of the close command's child-turn wait. */
const CHILD_TURN_POLL_MS = 250
/** Deterministic marker written into the scratch Workspace before removal. */
const REMOVE_MARKER = 'devlead-e2e-close-marker.txt'

/** Render an unknown thrown value as one line. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Sleep for one poll interval. */
function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * Read the model selection a real step would capture for this Agent, with a
 * deterministic fallback when the lead has no configured route (conditions and
 * sections under test only read the Agent).
 * @param agent - calling lead Agent.
 * @returns the Agent's current selection or a probe-owned placeholder.
 */
function modelSelectionOf(agent) {
  try {
    return agent.model?.current() ?? { provider: 'e2e-probe', model: 'e2e-probe' }
  } catch {
    return { provider: 'e2e-probe', model: 'e2e-probe' }
  }
}

/** Read the registry-global archive set, or null without a registry. */
function archivedSetOf(ctx) {
  const registry = ctx.get('workspaceRegistry')
  return registry === undefined ? null : registry.archivedSessionIds.map(String)
}

/**
 * Read one Session log without activating the Session. The query engine reads
 * the persisted log; the live Session store is only a fallback for a Host that
 * composes no durable query engine.
 * @param ctx - owning plugin context.
 * @param sessionId - Session identity.
 * @returns `{ readable, events, source }`.
 */
async function readLog(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    try {
      const snapshot = await query.readSession(sessionId)
      return { readable: true, events: snapshot.events.length, source: 'sessionQuery' }
    } catch (error) {
      return { readable: false, events: -1, source: `sessionQuery: ${messageOf(error)}` }
    }
  }
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) return { readable: false, events: -1, source: 'no sessionQuery and no live Session' }
  return { readable: true, events: session.snapshotEvents().length, source: 'sessionStore' }
}

/**
 * Capture one falling operation as a uniform `{ value }` / `{ code, message }`.
 * @param operation - operation to run.
 * @returns the settled outcome.
 */
async function settle(operation) {
  try {
    return { value: await operation() }
  } catch (error) {
    return { code: error?.code ?? null, message: messageOf(error) }
  }
}

/**
 * Register the lead directory as a Workspace, create one worktree-isolated
 * Session, and report the created result plus the live child Session's
 * header/effective working directories.
 *
 * The lead Session's header cwd is the source checkout: the harness creates
 * that Session with `cwd = <scratch workspace>` and initializes the directory
 * as a real Git repository, which the experimental worktree service requires.
 * @param ctx - owning plugin context carrying `commands`, `devLead`, `sessions`.
 * @param invocation - the command invocation; its Agent is the calling lead.
 * @returns a success result whose text is the probe JSON, or an error result.
 */
async function executeProbe(ctx, invocation) {
  const path = invocation.agent.session.header.cwd
  if (typeof path !== 'string' || path.length === 0) {
    return {
      kind: 'error',
      text: 'devlead-e2e-probe: the lead Session records no header cwd, so no Workspace can be addressed',
    }
  }
  // No cancellation token: this is one deterministic test step (a Workspace
  // registration, one unprompted Session creation, one worktree checkout) and
  // the E2E RPC call bounds the overall wait.
  await ctx.devLead.useWorkspace(invocation.agent, { path }, undefined)
  const created = await ctx.devLead.createSession(invocation.agent, {
    isolation: 'worktree',
    watch: false,
  })
  const childSession = ctx.sessions.get(created.session.sessionId)
  const workingDirectory = ctx.get('workingDirectory')
  const child = {
    sessionId: String(created.session.sessionId),
    // The immutable header keeps the Workspace path; isolation only changes the
    // effective (durable working-directory projection) directory.
    headerCwd: childSession?.header?.cwd ?? null,
    effectiveCwd: childSession === undefined || workingDirectory === undefined
      ? null
      : workingDirectory.get(childSession),
  }
  return { kind: 'success', text: JSON.stringify({ created, child }) }
}

/**
 * Report the tools a real model step would admit and the assembled DevLead
 * policy section for the calling Agent, in whatever mode it is currently in.
 * @param ctx - owning plugin context.
 * @param invocation - the command invocation; its Agent is the lead under test.
 * @returns a success result whose text is the inspect JSON, or an error result.
 */
async function executeInspect(ctx, invocation) {
  const agent = invocation.agent
  const modelSelection = modelSelectionOf(agent)
  const signal = new AbortController().signal
  let toolSet
  let toolNames = []
  let toolError = null
  try {
    toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
    toolNames = [...toolSet.view(agent).keys()].sort()
  } catch (error) {
    toolError = messageOf(error)
  }
  let policy = null
  let policyError = null
  try {
    // Mirror the real step assembly (`agent-loop` passes agent + scope + the
    // admitted tool set), so the section text is exactly what a model step sees.
    const assembly = await ctx.systemPrompt.assemble({
      agent,
      scope: agent,
      modelSelection,
      signal,
      ...(toolSet === undefined ? {} : { toolSet }),
    })
    policy = (assembly.sections ?? []).find(section => section.name === 'devlead:policy')?.text ?? null
  } catch (error) {
    policyError = messageOf(error)
  } finally {
    toolSet?.dispose()
  }
  return {
    kind: 'success',
    text: JSON.stringify({
      enabled: ctx.devLead.isEnabled(agent),
      tools: toolNames,
      devleadTools: toolNames.filter(name => name.startsWith('devlead_')),
      policy,
      toolError,
      policyError,
    }),
  }
}

/**
 * Wait for a prompted child turn to settle inside the real Host.
 * @param ctx - owning plugin context.
 * @param agent - calling lead Agent.
 * @param sessionId - child Session identity.
 * @returns the settled Session view.
 * @throws when the turn does not settle before the probe's bound.
 */
async function awaitChildTurn(ctx, agent, sessionId) {
  const deadline = Date.now() + CHILD_TURN_TIMEOUT_MS
  for (;;) {
    const view = await ctx.devLead.getSession(agent, sessionId)
    if (view.running !== true && (view.lastTurn ?? 0) >= 1) return view
    if (Date.now() >= deadline) {
      throw new Error(`child Session "${sessionId}" did not settle a turn within ${String(CHILD_TURN_TIMEOUT_MS)}ms`)
    }
    await sleep(CHILD_TURN_POLL_MS)
  }
}

/**
 * Drive the close lifecycle through the real Host.
 *
 * The prompt carries no credentials: the child turn settles deterministically as
 * a provider error, which gives the archived Session a real non-empty log to
 * survive. The active-session refusal is made deterministic by a temporary
 * `workspace/session-activity` provider; the stop path observes the real
 * `workspace/session-stop` dispatch the Host issues for `stopRunning`.
 * @param ctx - owning plugin context.
 * @param invocation - the command invocation; its Agent is the lead under test.
 * @returns a success result whose text is the close JSON, or an error result.
 */
async function executeClose(ctx, invocation) {
  const agent = invocation.agent
  const path = agent.session.header.cwd
  if (typeof path !== 'string' || path.length === 0) {
    return {
      kind: 'error',
      text: 'devlead-e2e-close: the lead Session records no header cwd, so no Workspace can be addressed',
    }
  }
  const workspace = await ctx.devLead.useWorkspace(agent, { path })

  // A prompted child gives the archive assertions a real, non-empty durable log.
  const created = await ctx.devLead.createSession(agent, {
    watch: false,
    prompt: 'devlead e2e close: this turn is expected to settle as a provider error',
  })
  const childId = String(created.session.sessionId)
  await awaitChildTurn(ctx, agent, childId)
  const logBefore = await readLog(ctx, childId)

  const first = await ctx.devLead.archiveSession(agent, childId)
  const archivedSetAfterFirst = archivedSetOf(ctx)
  const viewAfterFirst = await ctx.devLead.getSession(agent, childId)
  const rowsAfterFirst = await ctx.devLead.listSessions(agent, { limit: 500 })
  const rowAfterFirst = rowsAfterFirst.find(row => row.sessionId === childId)
  const second = await ctx.devLead.archiveSession(agent, childId)
  const archivedSetAfterSecond = archivedSetOf(ctx)
  const unarchive = await ctx.devLead.unarchiveSession(agent, childId)
  const archivedSetAfterUnarchive = archivedSetOf(ctx)
  const viewAfterUnarchive = await ctx.devLead.getSession(agent, childId)
  const logAfterUnarchive = await readLog(ctx, childId)

  // Active refusal: a temporary activity provider makes the child "running"
  // for the registry's archive admission, without starting a real turn.
  const activeChild = await ctx.devLead.createSession(agent, { watch: false })
  const activeChildId = String(activeChild.session.sessionId)
  let stopRequests = 0
  const disposeActivity = ctx.on('workspace/session-activity', async (request, next) => {
    const rest = await next()
    return String(request.sessionId) === activeChildId ? [{ kind: 'turn' }, ...rest] : rest
  })
  const disposeStop = ctx.on('workspace/session-stop', (request) => {
    if (String(request.sessionId) === activeChildId) stopRequests += 1
  })
  let refused
  let archivedSetAfterRefusal
  let stopOutcome
  let archivedSetAfterStop
  let unarchiveAfterStop
  try {
    refused = await settle(() => ctx.devLead.archiveSession(agent, activeChildId))
    archivedSetAfterRefusal = archivedSetOf(ctx)
    stopOutcome = await settle(() => ctx.devLead.archiveSession(agent, activeChildId, { stopRunning: true }))
    archivedSetAfterStop = archivedSetOf(ctx)
    unarchiveAfterStop = (await settle(() => ctx.devLead.unarchiveSession(agent, activeChildId))).value ?? null
  } finally {
    disposeActivity()
    disposeStop()
  }

  const selfArchive = await settle(() => ctx.devLead.archiveSession(agent, String(agent.id)))

  // Removal: a marker file proves the directory survives; the prompted child
  // (now unarchived) proves its log and ungrouped state survive too.
  const markerPath = join(path, REMOVE_MARKER)
  writeFileSync(markerPath, 'devlead e2e close marker\n')
  const logBeforeRemove = await readLog(ctx, childId)
  const removed = await ctx.devLead.removeWorkspace(agent, workspace.workspaceId)
  const workspaceIdsAfter = (await ctx.devLead.listWorkspaces()).map(entry => entry.workspaceId)
  const viewAfterRemove = await ctx.devLead.getSession(agent, childId)
  const logAfterRemove = await readLog(ctx, childId)
  const reRegistered = await ctx.devLead.useWorkspace(agent, { path })
  const viewAfterReRegister = await ctx.devLead.getSession(agent, childId)
  const markerContent = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null

  return {
    kind: 'success',
    text: JSON.stringify({
      workspace,
      archive: {
        childId,
        first,
        second,
        unarchive,
        archivedSetAfterFirst,
        archivedSetAfterSecond,
        archivedSetAfterUnarchive,
        viewArchivedAfterFirst: viewAfterFirst.archived === true,
        viewArchivedAfterUnarchive: viewAfterUnarchive.archived === true,
        rowArchivedAfterFirst: rowAfterFirst?.archived === true,
        logBefore,
        logAfterUnarchive,
      },
      active: {
        childId: activeChildId,
        refusedCode: refused.code ?? null,
        refusedMessage: refused.message ?? '',
        archivedSetAfterRefusal,
        stopResult: stopOutcome.value ?? null,
        stopError: stopOutcome.message ?? null,
        stopRequests,
        archivedSetAfterStop,
        unarchiveAfterStop,
      },
      selfArchive: { code: selfArchive.code ?? null, message: selfArchive.message ?? '' },
      remove: {
        removed: removed.removed,
        snapshotSessionIds: removed.workspace.sessionIds.map(String),
        workspaceIdsAfter,
        workspacePath: removed.workspace.path,
        directoryExists: existsSync(path),
        markerContent,
        childViewWorkspaceIdAfter: viewAfterRemove.workspaceId ?? null,
        logBefore: logBeforeRemove,
        logAfter: logAfterRemove,
        reRegisteredWorkspaceId: reRegistered.workspaceId ?? null,
        reRegisteredSessionIds: reRegistered.sessionIds.map(String),
        childViewWorkspaceIdAfterReRegister: viewAfterReRegister.workspaceId ?? null,
      },
    }),
  }
}

/**
 * Drive creation-time model selection and Agent Teams through the real Host.
 *
 * The model route comes from the Host's own `modelCatalog()`; when the catalog
 * is unavailable (for example a Host with no configured provider) the probe
 * reports that fact instead of faking a selection, and the harness skips the
 * corresponding positive checks. The profile default is read before and after
 * every create to prove the dispatch never rewrites it.
 * @param ctx - owning plugin context.
 * @param invocation - the command invocation; its Agent is the lead under test.
 * @returns a success result whose text is the dispatch JSON, or an error result.
 */
async function executeDispatch(ctx, invocation) {
  const agent = invocation.agent
  const teams = ctx.get('agentTeams')
  const defaultModel = ctx.get('agentDefaultModel')
  const readDefault = () => {
    try {
      return defaultModel?.currentSelection?.() ?? null
    } catch {
      return null
    }
  }
  const defaultBefore = readDefault()

  let listModelsView = null
  let listModelsError = null
  try {
    listModelsView = await ctx.devLead.listModels(agent)
  } catch (error) {
    listModelsError = { code: error?.code ?? null, message: messageOf(error) }
  }

  let presetsView = null
  let presetsError = null
  try {
    presetsView = await ctx.devLead.listAgentPresets(agent)
  } catch (error) {
    presetsError = { code: error?.code ?? null, message: messageOf(error) }
  }

  let selection = null
  let modelReason = null
  let modelSource = null
  const controller = ctx.get('sessionController')
  const llm = ctx.get('llm')
  let catalogDiagnostics = null
  try {
    const catalog = await controller.modelCatalog()
    catalogDiagnostics = {
      routableProviders: catalog?.routableProviders ?? null,
      failures: catalog?.failures ?? null,
      default: catalog?.default ?? null,
      providers: llm?.listProviders?.().map(provider => provider.id) ?? null,
    }
    const group = (catalog?.groups ?? [])[0]
    const model = group?.models?.[0]
    if (group !== undefined && model !== undefined) {
      selection = { provider: group.id, model: model.id }
      modelSource = 'catalog'
    }
    else modelReason = 'the Host model catalog reports no available provider/model'
  } catch (error) {
    modelReason = `modelCatalog failed: ${messageOf(error)}`
  }
  // A Host with no configured provider catalog still has a deployment default
  // route; using it lets the E2E verify the positive path without credentials.
  if (selection === null && typeof defaultBefore?.provider === 'string' && typeof defaultBefore?.model === 'string') {
    selection = { provider: defaultBefore.provider, model: defaultBefore.model }
    modelReason = null
    modelSource = 'deployment-default'
  }

  // Model-only child, so a missing Team service cannot mask model verification.
  let modelChild = null
  if (selection !== null) {
    const created = await settle(() => ctx.devLead.createSession(agent, { watch: false, model: selection }))
    let facts = null
    if (created.value !== undefined) {
      const child = ctx.agents.get(created.value.session.sessionId)
      const events = child?.session?.snapshotEvents?.() ?? []
      facts = {
        result: created.value.model ?? null,
        current: child?.model?.current?.() ?? null,
        modelEvents: events.filter(event => event.type === 'model/selection').length,
      }
    }
    modelChild = {
      created: created.value === undefined ? null : { sessionId: String(created.value.session.sessionId) },
      result: facts?.result ?? null,
      current: facts?.current ?? null,
      modelEvents: facts?.modelEvents ?? 0,
      error: created.code === undefined ? null : { code: created.code, message: created.message },
    }
  }
  const modelApplied = selection !== null && modelChild?.error === null
  if (!modelApplied && modelReason === null) {
    modelReason = modelChild?.error?.message ?? 'the model selection could not be applied'
  }

  // Team-only child (when the Host composes the service), plus explicit off.
  let teamChild = null
  if (teams !== undefined) {
    const created = await ctx.devLead.createSession(agent, { watch: false, agentTeams: true })
    const child = ctx.agents.get(created.session.sessionId)
    const events = child?.session?.snapshotEvents?.() ?? []
    teamChild = {
      result: created.agentTeams ?? null,
      enabled: child === undefined ? null : teams.isEnabled(child),
      teamEvents: events
        .filter(event => event.type === 'team/mode')
        .map(event => event.data),
    }
  }
  const off = await ctx.devLead.createSession(agent, { watch: false, agentTeams: false })
  const offChild = ctx.agents.get(off.session.sessionId)
  const offTeams = {
    result: off.agentTeams ?? null,
    enabled: teams === undefined || offChild === undefined ? null : teams.isEnabled(offChild),
  }
  // A Team-less Host (for example DSH 0.2.2-rc.1) must reject the explicit
  // request before creating anything; record the real outcome for the harness.
  let teamUnavailable = null
  if (teams === undefined) {
    const sessionsBefore = ctx.sessions.list().length
    const attempt = await settle(() => ctx.devLead.createSession(agent, { watch: false, agentTeams: true }))
    const sessionsAfter = ctx.sessions.list().length
    teamUnavailable = {
      code: attempt.code ?? null,
      message: attempt.message ?? '',
      sessionsBefore,
      sessionsAfter,
    }
  }

  const omitted = await ctx.devLead.createSession(agent, { watch: false })

  // Unavailable model id: the pre-create validation must reject without a Session.
  const sessionsBefore = ctx.sessions.list().length
  const provider = selection?.provider ?? 'e2e-probe'
  const unavailable = await settle(() => ctx.devLead.createSession(agent, {
    watch: false,
    model: { provider, model: 'definitely-not-a-model' },
  }))
  const sessionsAfter = ctx.sessions.list().length

  const defaultAfter = readDefault()
  return {
    kind: 'success',
    text: JSON.stringify({
      defaultModelBefore: defaultBefore,
      defaultModelAfter: defaultAfter,
      listModels: {
        view: listModelsView,
        error: listModelsError,
      },
      presets: {
        view: presetsView,
        error: presetsError,
      },
      model: {
        available: modelApplied,
        reason: modelReason,
        source: modelSource,
        catalog: catalogDiagnostics,
        provider: selection?.provider ?? null,
        model: selection?.model ?? null,
        child: modelChild,
      },
      teams: {
        available: teams !== undefined,
        child: teamChild,
        off: offTeams,
        unavailable: teamUnavailable,
      },
      omitted: {
        modelPresent: omitted.model !== undefined,
        agentTeamsPresent: omitted.agentTeams !== undefined,
      },
      modelUnavailable: {
        code: unavailable.code ?? null,
        message: unavailable.message ?? '',
        sessionsBefore,
        sessionsAfter,
      },
      teamsUnavailableChecked: false,
      teamsUnavailableReason: teams !== undefined
        ? 'the default composition composes agentTeams, so the missing-service path is covered by unit tests'
        : 'the Host composes no agentTeams service; the positive Team path was skipped',
    }),
  }
}

/** Wrap one command handler so a Host failure settles as an error result. */
function guarded(command, operation) {
  return async invocation => {
    try {
      return await operation(invocation)
    } catch (error) {
      return { kind: 'error', text: `${command} failed: ${messageOf(error)}` }
    }
  }
}

/** Register the probe commands for every composed command adapter. */
export function apply(ctx) {
  ctx.commands.register({
    definitionId: CommandDefinitionId(DEFINITION_ID),
    name: COMMAND_NAME,
    description: 'E2E probe: create a worktree-isolated Session from this lead and report the isolation result.',
    // Text-only command: no `input.attachments` declaration, so the command
    // runtime rejects composer attachments before this handler runs.
    handler: guarded(COMMAND_NAME, invocation => executeProbe(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#inspect`),
    name: INSPECT_COMMAND_NAME,
    description: 'E2E probe: report the step-visible DevLead tools and policy text for this lead.',
    handler: guarded(INSPECT_COMMAND_NAME, invocation => executeInspect(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#close`),
    name: CLOSE_COMMAND_NAME,
    description: 'E2E probe: drive archive/unarchive/remove through the real Host and report every fact.',
    handler: guarded(CLOSE_COMMAND_NAME, invocation => executeClose(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#dispatch`),
    name: DISPATCH_COMMAND_NAME,
    description: 'E2E probe: create Sessions with a model selection and Agent Teams, and report the real state.',
    handler: guarded(DISPATCH_COMMAND_NAME, invocation => executeDispatch(ctx, invocation)),
  })
}
