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
 *   `devlead-e2e-board-state` (phase 3)
 *     Read the current lead's board activation facts (`ctx.devLead.board.path`,
 *     `boardLeadSessionId`, `statePathOverride`) and one real `readBoard` call,
 *     returning the structured failure when the board is disabled. Used for the
 *     no-workspace BOARD_DISABLED and mode-off lifecycle assertions.
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
 *   `devlead-e2e-watch-child` (phase 3)
    Create one idle watched child so the harness can inspect that child's real
    step-time tool surface and drive a report through the same command seat.

  `devlead-e2e-report` (phase 3)
    Called inside that watched child: send a real `reportProgress` call and
    return the durable lead receipt plus the lead's current report digest.

  `devlead-e2e-question` (phase 3)
    Create a watched child, execute a real structured multi-question
    `ask_user_question` call plus a sibling read-only call through the Host
    tools pipeline as that child, and return the denial result, the batch
    continuation facts (case 33), the forwarded `kind: question` report with
    its structured `questions` from the lead digest, and the lead's durable
    `lane:'action-required'` wake admission.

  `devlead-e2e-question-report` (phase 3)
    Called inside a watched child: execute a real `devlead_report`
    `kind: question` batch (plus a sibling call and a pre-queued next-step
    marker) and return the `turnEndRequested`/`concludesTurn` facts, the lead
    digest row and wake admission, then a memory-only attempt made by
    write-protecting the real outbox table directory (durable:false, no turn
    end, restatement warning), and a report proving writability (and thus
    durable delivery) returned — no automatic-replay claim.

  `devlead-e2e-question-turn` (phase 3)
    Create a watched child and run one REAL prompted turn against a scripted
    `llm/stream` script (the rc.5 MockAdapter chunk recipe; no provider
    credential needed): the model requests a `[devlead_report(question),
    glob]` batch, and a next-step marker is steered while the glob dispatch is
    in flight. Returns the durable-log facts proving the concluding batch
    still ran the committed marker in a later real step before the single
    turn/end, plus the intercepted model requests and the lead digest/wake.

  `devlead-e2e-question-continue` (phase 3)
    Create a watched child and run one REAL prompted turn whose scripted
    model calls `ask_user_question` (gate-denied), then continues with another
    tool-call step and a final text step. Returns the durable-log facts
    proving the deny did not force the turn to end (case 33 with a real
    model continuation), plus the forwarded question and wake admission.

  `devlead-e2e-answer-turn` (phase 3, Phase 1d)
    Create a watched child and run one REAL prompted turn whose scripted model
    requests a `[devlead_report(question), glob]` batch; during the glob dispatch
    the lead answers the forwarded question through `promptSession(intent:'answer')`,
    then probes the same-key/same-text idempotent retry and the different-answer
    conflict. Returns the durable-log facts proving the answer steered next-step
    and was presented in a later real step before the single turn/end, the
    intercepted model requests, the lead's durable answer record, and the derived
    question/answer view.

  `devlead-e2e-answer-inbox` (phase 3, Phase 1d)
    Idle child: answer delivery metadata, queuedInputs intent/questionId/
    wakeRequested/deliveryState, retraction refusing the answer but accepting
    background/instruction. Running scripted children: interrupt `clear-own`
    keeps the pending answer (drops the own instruction, keeps human input) and
    `clear-all` discards the answer and reopens the question, through the real
    `workspace/session-stop` fan-out.

  `devlead-e2e-dispatch` (phase 3)
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
 *   question:
 *   {
 *     childId: string,                      // watched child created for the probe
 *     supervised: boolean,                  // child is watched by the lead
 *     expectedQuestions: object[],          // structured payload sent to the gate
 *     batch: { concluded, results: [{ callId, isError, concludesTurn, value, content }] },
 *     childStatus: string,                  // case 33: no forced turn end
 *     childTurnEnds: number,                // case 33: turn/end events after the batch
 *     questionReports: DevLeadReport[],     // forwarded kind=question rows (with questions)
 *     wake: { found, boundary, lane, wakeRequested, reportId, excerpt }
 *   }
 *
 *   questionReport:
 *   {
 *     supervised: boolean,
 *     leadId: string,
 *     markerPending: boolean,               // committed next-step input survived the batch
 *     durable: { batch, reports: DevLeadReport[], wake },
 *     memoryOnly: { available, reason? , batch? },
 *     recovery: { concluded, results }      // writability restored; durable again (no replay claim)
 *   }
 *
 *   questionTurn / questionContinue (real scripted child turns):
 *   {
 *     childId: string,
 *     requests: [{ userTexts, toolNames }], // intercepted model requests, in order
 *     toolResults: [{ name, callId, isError, concludesTurn, value, content }],
 *     turns, steps, turnEnds: number,       // durable-log event counts (must be > 0)
 *     stepStarts: number[],                 // event indexes of every step/start
 *     turnEndReason: string | null, turnEndIndex: number,
 *     markerMessageIndex: number,           // questionTurn: user/message carrying the marker
 *     markerPendingAfter: boolean | null,
 *     questionResultIndex, askResultIndex, globCallIndex, globResultIndex: number,
 *     eventCount: number,
 *     markerText?: string,                  // questionTurn only
 *     questionReports: DevLeadReport[], wake
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
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
/** Real board writes and CAS through the enabled lead's Host service. */
export const BOARD_COMMAND_NAME = 'devlead-e2e-board'
/** Board activation facts plus a real read, including the disabled failure. */
export const BOARD_STATE_COMMAND_NAME = 'devlead-e2e-board-state'
/** Dispatch-settings command: creation-time model selection + Agent Teams. */
export const DISPATCH_COMMAND_NAME = 'devlead-e2e-dispatch'
/** Create one idle watched child for the report-surface checks. */
export const WATCH_CHILD_COMMAND_NAME = 'devlead-e2e-watch-child'
/** Send one real report from inside the watched child. */
export const REPORT_COMMAND_NAME = 'devlead-e2e-report'
/** Drive the watched-Session ask_user_question gate from the lead. */
export const QUESTION_COMMAND_NAME = 'devlead-e2e-question'
/** Drive the watched-Session devlead_report question path from inside the child. */
export const QUESTION_REPORT_COMMAND_NAME = 'devlead-e2e-question-report'
/** Real prompted child turn: a concluding question batch must still run committed next-step work. */
export const QUESTION_TURN_COMMAND_NAME = 'devlead-e2e-question-turn'
/** Real prompted child turn: a native-gate deny must not stop the model from continuing. */
export const QUESTION_CONTINUE_COMMAND_NAME = 'devlead-e2e-question-continue'
/** Queued-inbox visibility / ownership / idempotent retraction through the real Host. */
export const INBOX_COMMAND_NAME = 'devlead-e2e-inbox'
/** Real scripted child turn: the lead answers a running child via steer (Phase 1d). */
export const ANSWER_TURN_COMMAND_NAME = 'devlead-e2e-answer-turn'
/** Idle-child answer inbox lifecycle: clear-own/clear-all/retract/background (Phase 1d). */
export const ANSWER_INBOX_COMMAND_NAME = 'devlead-e2e-answer-inbox'
/** Phase 1e: P1/P2 background inject (no wake) + read-tool lane/deliveryState output. */
export const LANES_BACKGROUND_COMMAND_NAME = 'devlead-e2e-lanes-background'
/** Phase 1e: P3/P4 blocked/decision action-required steer wakes with the full message. */
export const LANES_ACTION_COMMAND_NAME = 'devlead-e2e-lanes-action'
/** Phase 1e: T1 completed followup vs T2 failed/interrupted review steer wakes. */
export const LANES_TURN_COMMAND_NAME = 'devlead-e2e-lanes-turn'
/** Phase 1e: question + turn-end double-wake merge suppression fields. */
export const LANES_MERGE_COMMAND_NAME = 'devlead-e2e-lanes-merge'
/** Phase 1e: 16-pair action cap overflow returns DEVLEAD_DELIVERY_RATE_LIMITED. */
export const LANES_RATE_COMMAND_NAME = 'devlead-e2e-lanes-rate'
/** Phase 1e: low-cardinality delivery/suppression/guard metrics snapshot. */
export const LANES_METRICS_COMMAND_NAME = 'devlead-e2e-lanes-metrics'
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
  let reportPolicy = null
  let boardContext = null
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
    reportPolicy = (assembly.sections ?? []).find(section => section.name === 'devlead:report-policy')?.text ?? null
    boardContext = (assembly.contexts ?? []).find(context => context.name === 'devlead:board-summary')?.text ?? null
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
      reportPolicy,
      boardContext,
      supervised: ctx.devLead.isSupervised(agent),
      storageDomain: ctx.get('storageDomain') !== undefined,
      storage: ctx.get('storage') !== undefined,
      reportOutboxAvailable: ctx.devLead.reportOutboxAvailable === true,
      reportOutboxLastError: ctx.devLead.reportOutboxLastError ?? null,
      boardFilePath: ctx.devLead.board.path ?? null,
      boardLeadSessionId: ctx.devLead.boardLeadSessionId ?? null,
      boardOverride: ctx.devLead.statePathOverride,
      boardStartError: ctx.devLead.boardStartError ?? null,
      workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
      toolError,
      policyError,
    }),
  }
}

/** Write five real board revisions (per-project CAS + long path/title refs) and read them back. */
async function executeBoard(ctx, invocation) {
  const agent = invocation.agent
  const workspacePath = agent.session.header.cwd
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    return { kind: 'error', text: 'devlead-e2e-board: the lead Session records no absolute workspace path' }
  }
  const created = await ctx.devLead.updateBoard(agent, {
    project: 'e2e-board',
    create: true,
    set: {
      workspace: { path: workspacePath, title: 'E2E Board' },
      focus: 'created through the real Host',
    },
    tasks: { upsert: [{ id: 'task-1', title: 'persist the board', status: 'doing' }] },
  })
  const other = await ctx.devLead.updateBoard(agent, {
    project: 'e2e-other',
    create: true,
    set: { workspace: { path: `${workspacePath}/other`, title: 'E2E Other' } },
  })
  const updated = await ctx.devLead.updateBoard(agent, {
    project: 'e2e-board',
    set: { focus: 'CAS committed through the real Host' },
  }, created.project.revision)
  // Path/title references are resolved against the locked board; the values are
  // longer than the id limit in real deployments, so this also proves the
  // preflight no longer confuses a reference with a synthetic project id.
  const byPath = await ctx.devLead.updateBoard(agent, {
    project: workspacePath,
    set: { next: 'updated through the workspace path' },
  })
  const byTitle = await ctx.devLead.updateBoard(agent, {
    project: 'E2E Board',
    set: { next: 'updated through the workspace title' },
  })
  const detail = await ctx.devLead.readBoard(agent, { project: 'e2e-board' })
  // Notes deliberately live outside board.json. Exercise the same active-lead
  // service boundary as the AI tools, then leave one substantial markdown note
  // on disk for the harness to read through the real workspaceFiles Remote.
  const noteCreated = await ctx.devLead.writeBoardNote(agent, {
    project: 'e2e-board',
    operation: 'create',
    note: 'e2e-plan',
    title: 'E2E implementation plan',
    summary: 'A persisted plan shared by the lead and the read-only board UI',
    expectedRevision: 0,
  })
  // Native file edits deliberately bypass the notes tool. Append through the
  // returned absolute Markdown path, then prove read/list reconciliation fixes
  // the index without rewriting that external body.
  const nativeMarkdown = '# E2E implementation plan\n\n## Context\n\nThe lead and the human read the same project note.\n\n- persist markdown outside `board.json`\n- render **safe** project context\n\n> Read-only in the browser.\n\n## Next\n\n- [ ] verify automatic refresh\n'
  writeFileSync(noteCreated.note.absolutePath, nativeMarkdown, 'utf8')
  const noteListing = await ctx.devLead.readBoardNote(agent, { project: 'E2E Board' })
  // Exercise the actual registered tool -> argument translation -> active-lead
  // service path, not only a direct service call from this private probe.
  const noteToolRead = await executeLeadReadTool(ctx, agent, 'devlead_board_note_read', {
    project: 'e2e-board', note: 'e2e-plan',
  })
  if (noteToolRead.isError) throw new Error(`devlead_board_note_read failed: ${JSON.stringify(noteToolRead.content)}`)
  const noteRead = noteToolRead.value
  return {
    kind: 'success',
    text: JSON.stringify({
      boardFilePath: ctx.devLead.board.path ?? null,
      boardLeadSessionId: ctx.devLead.boardLeadSessionId ?? null,
      boardOverride: ctx.devLead.statePathOverride,
      created,
      other,
      updated,
      byPath,
      byTitle,
      detail,
      noteCreated,
      noteListing,
      noteRead,
      nativeNotePath: noteCreated.note.absolutePath,
      nativeNoteBytes: Buffer.byteLength(nativeMarkdown, 'utf8'),
      noteToolRead,
      boardSummary: ctx.devLead.boardSummaryFor(agent),
    }),
  }
}

/** Report the lead's board activation facts plus one real read (for disabled cases). */
async function executeBoardState(ctx, invocation) {
  const agent = invocation.agent
  let read
  let error
  try {
    read = await ctx.devLead.readBoard(agent)
  } catch (thrown) {
    error = { code: thrown?.code ?? 'UNKNOWN', message: String(thrown?.message ?? thrown) }
  }
  return {
    kind: 'success',
    text: JSON.stringify({
      enabled: ctx.devLead.isEnabled(agent),
      boardFilePath: ctx.devLead.board.path ?? null,
      boardLeadSessionId: ctx.devLead.boardLeadSessionId ?? null,
      boardOverride: ctx.devLead.statePathOverride,
      read: read === undefined ? null : { revision: read.revision, projects: read.projects.length },
      error: error ?? null,
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
 * Create one idle watched child and return its identity.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the child id, or an error result.
 */
async function executeWatchChild(ctx, invocation) {
  const agent = invocation.agent
  try {
    const created = await ctx.devLead.createSession(agent, {
      watch: true,
      title: 'e2e report child',
    })
    const childId = String(created.session.sessionId)
    return {
      kind: 'success',
      text: JSON.stringify({
        childId,
        watched: ctx.devLead.view(agent).sessions.includes(childId),
        live: ctx.agents.get(childId) !== undefined,
      }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-watch-child: ${messageOf(error)}` }
  }
}

/**
 * Send one real mid-turn report from the calling watched child.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the child Agent.
 * @returns success JSON with the report and the lead's digest, or an error result.
 */
async function executeReport(ctx, invocation) {
  const agent = invocation.agent
  try {
    const supervised = ctx.devLead.isSupervised(agent)
    const leadId = ctx.devLead.supervisorOf(agent)
    if (leadId === undefined) {
      return {
        kind: 'success',
        text: JSON.stringify({ supervised, leadId: null, report: null, leadReports: [] }),
      }
    }
    const outboxAvailable = ctx.devLead.reportOutboxAvailable === true
    const outboxLastError = ctx.devLead.reportOutboxLastError ?? null
    const leadAgent = ctx.agents.get(leadId)
    // Phase 1e: a progress report rides the BACKGROUND lane (inject, no wake).
    // Capture the lead's turn boundary and status before/after so the harness
    // can assert the idle lead was NOT woken, plus the durable inject splice.
    const leadTurnBefore = leadAgent === undefined ? null : ctx.agents.turnBoundaryOf(leadAgent.session).lastTurn
    const leadStatusBefore = leadAgent?.status ?? null
    const report = await ctx.devLead.reportProgress(agent, {
      message: 'e2e report: the parser is halfway through',
      kind: 'progress',
      summary: 'e2e parser progress',
    })
    const leadReports = leadAgent === undefined ? [] : ctx.devLead.reports(leadAgent)
    const background = leadAgent === undefined
      ? { found: false }
      : await awaitLeadNotice(ctx, leadAgent, {
        lane: 'background',
        header: '[DEV LEAD REPORT]',
        reportIds: [report.report.id],
      })
    // Give any (incorrect) wake a chance to open a turn before re-reading. The
    // wait exceeds the 400ms T1 coalescing window so a regressed followup wake
    // cannot slip past the no-wake assertion.
    await sleep(700)
    const leadTurnAfter = leadAgent === undefined ? null : ctx.agents.turnBoundaryOf(leadAgent.session).lastTurn
    const leadStatusAfter = leadAgent?.status ?? null
    const deliveryState = leadAgent === undefined ? null : ctx.devLead.reportDeliveryState(leadAgent, report.report.id) ?? null
    return {
      kind: 'success',
      text: JSON.stringify({
        supervised, leadId, outboxAvailable, outboxLastError, report, leadReports,
        background, leadTurnBefore, leadTurnAfter, leadStatusBefore, leadStatusAfter, deliveryState,
      }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-report: ${messageOf(error)}` }
  }
}

/**
 * Poll one lead Session log for the durable admission of a DevLead notice on a
 * specific lane: an `agent/inbox/spliced` event inserting a notice whose source
 * matches `lane` (and optional header / report id / substring). Every inbox
 * primitive (`followup`, `steer`, `inject`) records such a splice, so this one
 * scanner covers the turn-notice, action-required, and background lanes alike.
 * The splice is the durable admission fact; a later claim by the lead loop does
 * not erase it.
 * @param ctx - probe context.
 * @param lead - lead Agent whose Session log carries the splice.
 * @param criteria - `{ lane?, header?, reportIds?, contains?, timeoutMs? }`.
 * @returns the notice facts, or `{ found: false }` after the bounded wait.
 */
async function awaitLeadNotice(ctx, lead, { lane, header, reportIds, contains, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const events = lead.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'agent/inbox/spliced') continue
      const data = event.data ?? {}
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      for (const message of inserted) {
        const source = message?.source
        if (source?.kind !== 'devlead' || source?.form !== 'notice') continue
        if (lane !== undefined && source?.lane !== lane) continue
        const text = (message.content ?? [])
          .filter(block => block?.type === 'text')
          .map(block => block.text)
          .join('\n')
        if (header !== undefined && !text.includes(header)) continue
        if (contains !== undefined && !text.includes(contains)) continue
        let reportId = typeof source.reportId === 'string' ? source.reportId : null
        if (reportIds !== undefined) {
          const matched = reportIds.find(id => source.reportId === id || text.includes(id))
          if (matched === undefined) continue
          reportId = matched
        }
        return {
          found: true,
          boundary: data.target ?? null,
          lane: source.lane ?? null,
          wakeRequested: source.wakeRequested === true,
          reportId,
          senderSessionId: typeof source.senderSessionId === 'string' ? source.senderSessionId : null,
          messageId: String(message.id),
          excerpt: text.slice(0, 400),
          // Full notice text (the renderer bounds wakes at 8000 code points) so
          // the harness can deep-compare the rendered payload.
          text,
        }
      }
    }
    if (Date.now() >= deadline) return { found: false }
    await sleep(100)
  }
}

/**
 * Poll the lead Session log for the durable admission of one question wake
 * (the action-required lane, `[DEV LEAD QUESTION]` header, naming a given report
 * id). Thin wrapper over {@link awaitLeadNotice} kept for the Phase 1c/1d probes.
 * @param ctx - probe context.
 * @param lead - lead Agent whose Session log carries the splice.
 * @param reportIds - forwarded question report identities to match.
 * @returns the wake facts, or `{ found: false }` after the bounded wait.
 */
async function awaitQuestionWake(ctx, lead, reportIds) {
  return await awaitLeadNotice(ctx, lead, {
    lane: 'action-required',
    header: '[DEV LEAD QUESTION]',
    reportIds,
  })
}

/**
 * Wait until one lead is idle with no undelivered WAKING DevLead notice parked
 * in its inbox. Background notices (`wakeRequested:false`) never open a turn and
 * are intentionally ignored: they stay parked without affecting the action or
 * turn-notice lanes. A parked action/turn-notice wake in an idle lead opens a
 * drain turn that consumes it, so this settles quickly on a credential-less Host.
 * @param ctx - probe context.
 * @param lead - lead Agent to drain.
 * @param timeoutMs - bounded wait.
 * @returns whether the lead reached a quiet idle state.
 */
async function drainLead(ctx, lead, timeoutMs = 15_000) {
  void ctx
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const parked = [...lead.inbox.nextStep, ...lead.inbox.nextTurn].some((message) => {
      const source = message?.source
      return source?.kind === 'devlead' && source?.form === 'notice' && source?.wakeRequested === true
    })
    if (lead.status === 'idle' && !parked) return true
    if (Date.now() >= deadline) return false
    await sleep(100)
  }
}

/**
 * Resolve the lead's real step-time tool set and execute one read tool through
 * the Host tools pipeline, so the probe reports the ACTUAL `devlead_notifications`
 * / `devlead_get_session` output (lane / deliveryState / suppression fields) a
 * model step would see, not a hand-assembled projection.
 * @param ctx - probe context.
 * @param lead - lead Agent the tool runs for.
 * @param name - tool name (e.g. `devlead_notifications`).
 * @param args - tool arguments object.
 * @returns `{ isError, value, content }` of the single call.
 */
async function executeLeadReadTool(ctx, lead, name, args) {
  const signal = AbortSignal.timeout(15_000)
  const toolSet = await ctx.tools.resolve({ agent: lead, modelSelection: modelSelectionOf(lead), signal })
  try {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `e2e-read-${name}`, name, arguments: JSON.stringify(args) }],
      agent: lead,
      toolSet,
      signal,
    })
    const entry = batch.results[0]
    return {
      isError: entry.result.isError,
      value: entry.result.isError ? null : entry.result.value,
      content: entry.result.content,
    }
  } finally {
    toolSet.dispose()
  }
}

/**
 * Hold one lead RUNNING through a real scripted turn so a probe can observe
 * lane delivery while the lead cannot claim its parked wakes. The lead's own
 * `llm/stream` conversation requests are scripted (a `glob` tool step then a
 * text step); while the glob dispatch is in flight the `duringGlob` hook runs
 * (the lead is mid-turn, so action wakes park and the pending queue accumulates).
 * The lead is opened with a real `followup` (the T1 primitive), so every event
 * is a genuine agent-loop event. Returns the captured hook facts and turn counts.
 * @param ctx - probe context.
 * @param lead - lead Agent to run.
 * @param options - `{ duringGlob, script? }`; script defaults to glob then text.
 * @returns `{ requests, globFacts, turnEnds, eventCount }`.
 */
async function holdLeadRunning(ctx, lead, { duringGlob, script }) {
  const leadId = String(lead.id)
  const effectiveScript = script ?? [
    toolCallChunks([{ id: 'e2e-lead-glob', name: 'glob', arguments: { pattern: '*' } }]),
    textChunks('e2e lead lane turn complete'),
  ]
  const requests = []
  let callIndex = 0
  let globPending = true
  let globFacts = null
  const disposables = []
  disposables.push(ctx.on('llm/stream', async function* (options, next) {
    if (String(options.sessionId ?? '') !== leadId || options.purpose !== undefined) {
      yield* next()
      return
    }
    const entry = effectiveScript[Math.min(callIndex, effectiveScript.length - 1)]
    callIndex += 1
    requests.push(requestSummary(options))
    for (const chunk of entry) yield chunk
  }))
  disposables.push(ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (globPending && exec.agent === lead && exec.name === 'glob') {
      globPending = false
      globFacts = await duringGlob({ lead, leadId })
    }
    return result
  }))
  try {
    lead.followup({
      id: `e2e-lead-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: 'e2e lead turn: run a tool so the probe can inspect lane delivery' }],
      source: { kind: 'user' },
    })
    await awaitChildTurn(ctx, lead, leadId)
    const events = lead.session.snapshotEvents()
    return {
      requests,
      globFacts,
      turnEnds: events.filter(event => event?.type === 'turn/end').length,
      eventCount: events.length,
    }
  } finally {
    for (const dispose of disposables) dispose()
  }
}

/**
 * Scripted `llm/stream` chunks for one text response (the rc.5 MockAdapter
 * recipe): the real agent loop consumes them exactly like an adapter stream,
 * producing real step/request/assistant events without a provider credential.
 * @param text - assistant text to stream.
 * @returns the chunk sequence ending in a `stop` finish.
 */
function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Scripted `llm/stream` chunks for one tool-call batch response.
 * @param calls - ordered `{ id, name, arguments }` calls the model requests.
 * @returns the chunk sequence ending in a `tool-calls` finish.
 */
function toolCallChunks(calls) {
  const chunks = []
  calls.forEach((call, index) => {
    const argumentsJson = JSON.stringify(call.arguments)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: argumentsJson },
      { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: argumentsJson } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/** Compact model-visible summary of one intercepted loop request. */
function requestSummary(options) {
  const userTexts = []
  const toolNames = []
  for (const message of options.messages ?? []) {
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && message.role === 'user') userTexts.push(block.text.slice(0, 200))
      if (block?.type === 'tool-call') toolNames.push(block.name)
    }
  }
  return { role: 'conversation', userTexts, toolNames }
}

/**
 * Run one real prompted child turn against a scripted `llm/stream` script.
 *
 * The interceptor short-circuits only this child's conversation requests
 * (auxiliary purposes and every other Session pass through to the real
 * adapter), so the child's turn is a genuine agent-loop turn: real
 * turn/start, step/start, request/header, tool/call, tool/result,
 * assistant/message, and turn/end events in its durable log.
 * @param ctx - probe context.
 * @param lead - lead Agent creating and prompting the child.
 * @param options - `{ title, prompt, script, steerOnGlob, answerOnGlob }`;
 *   `script` is an array of chunk arrays consumed one per model request (the
 *   last entry repeats if the loop asks again); `steerOnGlob` is a UserMessage
 *   steered into next-step while the child's `glob` dispatch is still in flight;
 *   `answerOnGlob` (`{ text, idempotencyKey }`) makes the lead answer the child's
 *   forwarded question through `promptSession(intent:'answer')` during that same
 *   glob dispatch, then probes the idempotent retry and the different-answer
 *   conflict, capturing every receipt; `duringGlob` is a general async hook run
 *   once during the glob dispatch whose returned facts are merged into the result.
 * @returns the child identity, captured requests/tool results, and log facts.
 */
async function runScriptedChildTurn(ctx, lead, { title, prompt, script, steerOnGlob, answerOnGlob, duringGlob, failRequest }) {
  const created = await ctx.devLead.createSession(lead, { watch: true, title })
  const childId = String(created.session.sessionId)
  const child = ctx.agents.get(childId)
  if (child === undefined) throw new Error('scripted child is not live')
  const requests = []
  const toolResults = []
  let callIndex = 0
  let steerPending = steerOnGlob !== undefined
  let answerPending = answerOnGlob !== undefined
  let answerFacts = null
  let duringGlobPending = duringGlob !== undefined
  let duringGlobFacts = null
  const disposables = []
  disposables.push(ctx.on('llm/stream', async function* (options, next) {
    if (String(options.sessionId ?? '') !== childId || options.purpose !== undefined) {
      yield* next()
      return
    }
    // A thrown adapter error settles the turn as a real `turn/end` error (the
    // T2 review category), exactly like a credential-less provider failure.
    if (failRequest === true) throw new Error('e2e scripted provider failure')
    const entry = script[Math.min(callIndex, script.length - 1)]
    callIndex += 1
    requests.push(requestSummary(options))
    for (const chunk of entry) yield chunk
  }))
  disposables.push(ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    // Land the steering while the concluding batch is still in flight, the
    // same shape as the rc.5 loop test "continues for steering that arrived
    // during a concluding tool step".
    if (steerPending && exec.agent === child && exec.name === 'glob') {
      steerPending = false
      child.steer(steerOnGlob)
    }
    // Answer the forwarded question through the real lead prompt path while the
    // child is still running its glob dispatch: the answer must steer next-step
    // and be presented in a later real step, not wait for the turn to end.
    if (answerPending && exec.agent === child && exec.name === 'glob') {
      answerPending = false
      const question = ctx.devLead.reports(lead).find(row => row.kind === 'question' && row.senderSessionId === childId)
      if (question === undefined) throw new Error('answer probe: no forwarded question report found at glob time')
      const answerReceipt = await ctx.devLead.promptSession(lead, childId, answerOnGlob.text, {
        intent: 'answer',
        questionId: question.id,
        idempotencyKey: answerOnGlob.idempotencyKey,
      })
      // Same key + same text: an idempotent replay returning the original receipt.
      const retryReceipt = await ctx.devLead.promptSession(lead, childId, answerOnGlob.text, {
        intent: 'answer',
        questionId: question.id,
        idempotencyKey: answerOnGlob.idempotencyKey,
      })
      // A different answer is an explicit conflict.
      let conflictCode = null
      try {
        await ctx.devLead.promptSession(lead, childId, `${answerOnGlob.text} (changed)`, {
          intent: 'answer',
          questionId: question.id,
        })
      } catch (error) {
        conflictCode = error?.code ?? null
      }
      answerFacts = {
        questionId: question.id,
        answerText: answerOnGlob.text,
        answerReceipt,
        retryReceipt,
        conflictCode,
        childStatusAtAnswer: child.status,
      }
    }
    // A general probe hook run once during the child's glob dispatch (used by
    // the answer-inbox probe to drive interrupt inbox policies on a real
    // running child). Its facts are merged into the result.
    if (duringGlobPending && exec.agent === child && exec.name === 'glob') {
      duringGlobPending = false
      duringGlobFacts = await duringGlob({ child, childId, lead })
    }
    return result
  }))
  disposables.push(ctx.on('tools/result', (exec, result) => {
    if (exec.agent !== child) return
    toolResults.push({
      name: exec.name,
      callId: String(exec.callId),
      isError: result.isError,
      concludesTurn: result.concludesTurn === true,
      value: result.isError ? null : result.value,
      content: result.content,
    })
  }))
  try {
    await ctx.devLead.promptSession(lead, childId, prompt)
    await awaitChildTurn(ctx, lead, childId)
    const events = child.session.snapshotEvents()
    const indexOf = (predicate) => {
      for (let index = 0; index < events.length; index += 1) {
        if (predicate(events[index])) return index
      }
      return -1
    }
    const textOf = (message) => (message?.content ?? [])
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('\n')
    const markerText = steerOnGlob === undefined ? null : textOf(steerOnGlob)
    const answerText = answerOnGlob === undefined ? null : answerOnGlob.text
    const turnEndIndex = indexOf(event => event?.type === 'turn/end')
    const stepStarts = events
      .map((event, index) => ({ event, index }))
      .filter(entry => entry.event?.type === 'step/start')
      .map(entry => entry.index)
    return {
      childId,
      requests,
      toolResults,
      turns: events.filter(event => event?.type === 'turn/start').length,
      steps: stepStarts.length,
      stepStarts,
      turnEnds: events.filter(event => event?.type === 'turn/end').length,
      turnEndReason: turnEndIndex < 0 ? null : events[turnEndIndex].data?.reason?.kind ?? null,
      turnEndIndex,
      markerMessageIndex: markerText === null ? -1 : indexOf(event =>
        event?.type === 'user/message' && textOf(event.data).includes(markerText)),
      markerPendingAfter: markerText === null ? null : child.inbox.nextStep.some(message => textOf(message).includes(markerText)),
      answerMessageIndex: answerText === null ? -1 : indexOf(event =>
        event?.type === 'user/message' && textOf(event.data).includes(answerText)),
      answerPendingAfter: answerText === null ? null : child.inbox.nextStep.some(message => textOf(message).includes(answerText)),
      answerFacts,
      questionAnswerView: answerFacts === null ? null : ctx.devLead.questionAnswerView(lead, answerFacts.questionId),
      duringGlobFacts,
      questionResultIndex: indexOf(event => event?.type === 'tool/result'
        && String(event.data?.message?.toolCallId) === 'e2e-scripted-question'),
      askResultIndex: indexOf(event => event?.type === 'tool/result'
        && String(event.data?.message?.toolCallId) === 'e2e-scripted-ask'),
      globCallIndex: indexOf(event => event?.type === 'tool/call' && event.data?.name === 'glob'),
      globResultIndex: indexOf(event => event?.type === 'tool/result'
        && String(event.data?.message?.toolCallId) === 'e2e-scripted-glob'),
      eventCount: events.length,
    }
  } finally {
    for (const dispose of disposables) dispose()
  }
}

/** Map one settled tool batch onto the compact facts the harness asserts. */
function batchFacts(batch) {
  return {
    concluded: batch.concluded === true,
    results: batch.results.map(entry => ({
      callId: String(entry.callId),
      isError: entry.result.isError,
      concludesTurn: entry.result.concludesTurn === true,
      value: entry.result.isError ? null : entry.result.value,
      content: entry.result.content,
    })),
  }
}

/**
 * Drive one real `ask_user_question` call through a freshly created watched
 * child and report whether the DevLead question gate denied it before the
 * child's own question UI could run, plus the forwarded lead report.
 *
 * Phase 1c additions: the payload is a structured multi-question batch
 * (options + description + multi_select), a sibling read-only tool call proves
 * the deny does not end the child's work (case 33: the batch completes, no
 * forced turn end), and the lead's durable action-required wake admission is
 * read back from the Session log.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the call result and question reports, or an error result.
 */
async function executeQuestion(ctx, invocation) {
  const lead = invocation.agent
  try {
    const created = await ctx.devLead.createSession(lead, { watch: true, title: 'e2e question child' })
    const childId = String(created.session.sessionId)
    const child = ctx.agents.get(childId)
    if (child === undefined) {
      return { kind: 'error', text: 'devlead-e2e-question: watched child is not live' }
    }
    const before = ctx.devLead.reports(lead).length
    const expectedQuestions = [
      {
        id: 'target',
        question: 'Which e2e target?',
        header: 'Deploy',
        options: [{ label: 'Staging', description: 'safe rollback path' }, { label: 'Prod' }],
        multi_select: false,
      },
      {
        id: 'extras',
        question: 'Which extras should ship?',
        header: 'Extras',
        options: [{ label: 'Metrics', description: 'dashboards' }, { label: 'Alerts' }],
        multi_select: true,
      },
    ]
    const batch = await ctx.tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: 'e2e-ask-question',
          name: 'ask_user_question',
          arguments: JSON.stringify({ questions: expectedQuestions }),
        },
        {
          type: 'tool-call',
          id: 'e2e-after-deny',
          name: 'glob',
          arguments: JSON.stringify({ pattern: '*' }),
        },
      ],
      agent: child,
      signal: AbortSignal.timeout(10_000),
    })
    const questionReports = ctx.devLead.reports(lead).slice(before).filter(report => report.kind === 'question')
    const wake = await awaitQuestionWake(ctx, lead, questionReports.map(report => report.id))
    const childEvents = child.session.snapshotEvents()
    return {
      kind: 'success',
      text: JSON.stringify({
        childId,
        supervised: ctx.devLead.isSupervised(child),
        expectedQuestions,
        batch: batchFacts(batch),
        // Case 33 facts: the deny is a soft request, so the child's batch kept
        // running and no turn was forced to end.
        childStatus: child.status,
        childTurnEnds: childEvents.filter(event => event.type === 'turn/end').length,
        questionReports,
        wake,
      }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-question: ${messageOf(error)}` }
  }
}

/**
 * Drive the `devlead_report({kind:'question'})` path from inside a watched
 * child through the real Host tools pipeline (Phase 1c gate):
 *
 * - durable success: the result carries `turnEndRequested:true` and the
 *   executor marker `concludesTurn`, a sibling tool call still completes
 *   (the batch is not cancelled), and a pre-queued next-step input survives
 *   (committed next-step work is not short-circuited);
 * - the lead digest carries the text question and the lead log records the
 *   `lane:'action-required'` next-step wake admission;
 * - memory-only receipt: with the outbox table directory temporarily
 *   write-protected, the same tool reports `durable:false`, requests no turn
 *   end, and its warning asks for a restatement in the final assistant
 *   message; the directory mode is restored afterwards and a recovery report
 *   proves the outbox is durable again.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the watched child Agent.
 * @returns success JSON with every read-back fact, or an error result.
 */
async function executeQuestionReport(ctx, invocation) {
  const child = invocation.agent
  try {
    const supervised = ctx.devLead.isSupervised(child)
    const leadId = ctx.devLead.supervisorOf(child)
    if (!supervised || leadId === undefined) {
      return { kind: 'success', text: JSON.stringify({ supervised, leadId: null }) }
    }
    const lead = ctx.agents.get(leadId)
    if (lead === undefined) return { kind: 'error', text: 'devlead-e2e-question-report: lead is not live' }

    // One committed next-step input the concluded batch must not discard.
    const marker = {
      id: `e2e-nextstep-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: 'e2e pending next-step marker' }],
      source: { kind: 'user' },
    }
    child.inbox.append('next-step', marker)

    // devlead_report carries a `when` condition, so it is only executable
    // through a step-time resolved tool set (the raw execute path admits
    // unconditional registrations alone). Resolve exactly like a model step.
    const signal = AbortSignal.timeout(30_000)
    const toolSet = await ctx.tools.resolve({ agent: child, modelSelection: modelSelectionOf(child), signal })
    try {
      const before = ctx.devLead.reports(lead).length
      const durableBatch = await ctx.tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: 'e2e-question-report',
            name: 'devlead_report',
            arguments: JSON.stringify({
              message: 'e2e question: which release train should I target?',
              kind: 'question',
              summary: 'e2e release train',
            }),
          },
          {
            type: 'tool-call',
            id: 'e2e-question-sibling',
            name: 'glob',
            arguments: JSON.stringify({ pattern: '*' }),
          },
        ],
        agent: child,
        toolSet,
        signal,
      })
      const markerPending = child.inbox.nextStep.some(message => String(message.id) === marker.id)
      const durableReports = ctx.devLead.reports(lead).slice(before).filter(report => report.kind === 'question')
      const durableWake = await awaitQuestionWake(ctx, lead, durableReports.map(report => report.id))

      // Memory-only injection: write-protect the real outbox table directory so
      // the per-record put fails with EACCES and the service falls back to the
      // explicit non-durable path. The original mode is restored in finally.
      const home = process.env.DSH_HOME
      const outboxDir = typeof home === 'string' && home.length > 0
        ? join(home, 'storages', 'devlead_report_outbox', 'pending')
        : null
      let memoryOnly
      if (outboxDir === null || !existsSync(outboxDir)) {
        memoryOnly = { available: false, reason: `outbox directory not found: ${outboxDir ?? '(no DSH_HOME)'}` }
      } else {
        const originalMode = statSync(outboxDir).mode & 0o777
        chmodSync(outboxDir, 0o555)
        try {
          const batch = await ctx.tools.execute({
            calls: [{
              type: 'tool-call',
              id: 'e2e-question-memory-only',
              name: 'devlead_report',
              arguments: JSON.stringify({
                message: 'e2e question: memory-only path check?',
                kind: 'question',
                summary: 'e2e memory-only question',
              }),
            }],
            agent: child,
            toolSet,
            signal,
          })
          memoryOnly = { available: true, batch: batchFacts(batch) }
        } finally {
          chmodSync(outboxDir, originalMode)
        }
      }

      // Recovery: the outbox must be durable again after the mode restore.
      const recoveryBatch = await ctx.tools.execute({
        calls: [{
          type: 'tool-call',
          id: 'e2e-question-recovery',
          name: 'devlead_report',
          arguments: JSON.stringify({
            message: 'e2e question: recovery after the write-protected window?',
            kind: 'question',
            summary: 'e2e recovery question',
          }),
        }],
        agent: child,
        toolSet,
        signal,
      })

      return {
        kind: 'success',
        text: JSON.stringify({
          supervised,
          leadId,
          markerPending,
          durable: { batch: batchFacts(durableBatch), reports: durableReports, wake: durableWake },
          memoryOnly,
          recovery: batchFacts(recoveryBatch),
        }),
      }
    } finally {
      toolSet.dispose()
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-question-report: ${messageOf(error)}` }
  }
}

/**
 * Real prompted child turn for the Phase 1c turn-end request: the scripted
 * model requests a `[devlead_report(question), glob]` batch; while the glob
 * dispatch is still in flight the probe steers one committed next-step marker.
 * The durable question concludes the batch, but the loop must still run the
 * marker in a following step (real `step/start` + `user/message`) before the
 * single `turn/end`. Every fact is read from the child's durable log and the
 * intercepted model requests, not from queue state alone.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the turn facts, or an error result.
 */
async function executeQuestionTurn(ctx, invocation) {
  const lead = invocation.agent
  try {
    const markerText = 'e2e committed next-step marker: continue after the question batch'
    const marker = {
      id: `e2e-marker-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: markerText }],
      source: { kind: 'devlead', form: 'relay', senderSessionId: String(lead.id) },
    }
    const before = ctx.devLead.reports(lead).length
    const facts = await runScriptedChildTurn(ctx, lead, {
      title: 'e2e scripted question turn',
      prompt: 'e2e scripted turn: ask the lead which channel to use, then finish',
      script: [
        toolCallChunks([
          {
            id: 'e2e-scripted-question',
            name: 'devlead_report',
            arguments: {
              message: 'e2e scripted question: which channel should I use?',
              kind: 'question',
              summary: 'e2e scripted channel',
            },
          },
          { id: 'e2e-scripted-glob', name: 'glob', arguments: { pattern: '*' } },
        ]),
        textChunks('e2e scripted marker turn complete'),
      ],
      steerOnGlob: marker,
    })
    const questionReports = ctx.devLead.reports(lead).slice(before).filter(report => report.kind === 'question')
    const wake = await awaitQuestionWake(ctx, lead, questionReports.map(report => report.id))
    return { kind: 'success', text: JSON.stringify({ ...facts, markerText, questionReports, wake }) }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-question-turn: ${messageOf(error)}` }
  }
}

/**
 * Real prompted child turn for case 33: the scripted model calls
 * `ask_user_question` (denied by the gate), then keeps working — a second
 * model step runs another tool call and a third step finishes with text. The
 * deny must not force the turn to end: the child log shows the later steps
 * and one natural `turn/end` after them.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the continuation facts, or an error result.
 */
async function executeQuestionContinue(ctx, invocation) {
  const lead = invocation.agent
  try {
    const before = ctx.devLead.reports(lead).length
    const facts = await runScriptedChildTurn(ctx, lead, {
      title: 'e2e scripted gate continue',
      prompt: 'e2e scripted turn: ask which target, keep working after the denial, then finish',
      script: [
        toolCallChunks([{
          id: 'e2e-scripted-ask',
          name: 'ask_user_question',
          arguments: {
            questions: [{
              id: 'target',
              question: 'Which e2e continue target?',
              header: 'Deploy',
              options: [{ label: 'Staging' }, { label: 'Prod' }],
            }],
          },
        }]),
        toolCallChunks([{ id: 'e2e-scripted-glob', name: 'glob', arguments: { pattern: '*' } }]),
        textChunks('e2e scripted gate continue complete'),
      ],
    })
    const questionReports = ctx.devLead.reports(lead).slice(before).filter(report => report.kind === 'question')
    const wake = await awaitQuestionWake(ctx, lead, questionReports.map(report => report.id))
    return { kind: 'success', text: JSON.stringify({ ...facts, questionReports, wake }) }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-question-continue: ${messageOf(error)}` }
  }
}

/** Read the durable answer lifecycle records from one lead's Session log. */
function answerRecordsOf(lead) {
  return lead.session.snapshotEvents()
    .filter(event => event?.type === 'plugin:devlead/report-answer')
    .map(event => event.data?.answer)
}

/**
 * Real prompted child turn for the Phase 1d answer path: the scripted model
 * requests a `[devlead_report(question), glob]` batch; while the glob dispatch
 * is in flight the lead answers the forwarded question through
 * `promptSession(intent:'answer')`, then probes the idempotent retry and the
 * different-answer conflict. The answer must steer next-step and be presented
 * in a later real step (real `step/start` + `user/message`) before the single
 * turn/end — not wait for the running turn to settle. Every fact is read from
 * the child's durable log, the intercepted model requests, the lead's durable
 * answer record, and the derived question/answer view.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the answer-turn facts, or an error result.
 */
async function executeAnswerTurn(ctx, invocation) {
  const lead = invocation.agent
  try {
    const answerText = 'e2e answer: use the staging channel'
    const before = ctx.devLead.reports(lead).length
    const facts = await runScriptedChildTurn(ctx, lead, {
      title: 'e2e scripted answer turn',
      prompt: 'e2e scripted turn: ask the lead which channel to use, then finish',
      script: [
        toolCallChunks([
          {
            id: 'e2e-scripted-question',
            name: 'devlead_report',
            arguments: {
              message: 'e2e scripted question: which channel should I use?',
              kind: 'question',
              summary: 'e2e scripted channel',
            },
          },
          { id: 'e2e-scripted-glob', name: 'glob', arguments: { pattern: '*' } },
        ]),
        textChunks('e2e scripted answer turn complete'),
      ],
      answerOnGlob: { text: answerText, idempotencyKey: 'e2e-answer-key' },
    })
    const questionReports = ctx.devLead.reports(lead).slice(before).filter(report => report.kind === 'question')
    const wake = await awaitQuestionWake(ctx, lead, questionReports.map(report => report.id))
    return {
      kind: 'success',
      text: JSON.stringify({ ...facts, answerText, questionReports, wake, answerRecords: answerRecordsOf(lead) }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-answer-turn: ${messageOf(error)}` }
  }
}

/**
 * Phase 1d answer inbox lifecycle against the real durable inbox.
 *
 * Running child (scripted turn): during the glob dispatch the answer steers
 * next-step (delivery facts + derived view), the queued-input row carries
 * intent/questionId/wakeRequested/deliveryState, retraction refuses the answer
 * but accepts a background notice and an instruction, and background injects
 * without a wake. (A steer to an idle child would open a turn and consume the
 * answer, so the pending-inbox facts are captured while the child is running.)
 *
 * Running child (scripted turn): during the glob dispatch the lead admits an
 * answer plus an own instruction and a human input, then interrupts with
 * `clear-own` (answer + human restored, own instruction dropped) and, on a
 * second child, `clear-all` (answer discarded, question reopened). The real
 * `workspace/session-stop` fan-out clears the inbox; the service restores the
 * kept messages, so the facts prove the answer exception end to end.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with every read-back fact, or an error result.
 */
async function executeAnswerInbox(ctx, invocation) {
  const lead = invocation.agent
  try {
    // --- Running child: answer delivery metadata, retraction, background. ---
    // A steer to an IDLE child opens a turn and consumes the answer immediately,
    // so the pending-inbox facts are captured during a RUNNING child's glob
    // dispatch, where next-step input waits for the next pre-step.
    const metadata = await runScriptedChildTurn(ctx, lead, {
      title: 'e2e answer metadata',
      prompt: 'e2e turn: run a tool so the lead can inspect the answer inbox',
      script: [
        toolCallChunks([{ id: 'e2e-glob', name: 'glob', arguments: { pattern: '*' } }]),
        textChunks('e2e answer metadata turn complete'),
      ],
      duringGlob: async ({ child: running, childId: runningId }) => {
        const questionReceipt = await ctx.devLead.reportProgress(running, {
          kind: 'question',
          message: 'e2e inbox question: which target?',
          summary: 'e2e inbox target',
        })
        const questionId = questionReceipt.report.id
        const answer = await ctx.devLead.promptSession(lead, runningId, 'use staging', { intent: 'answer', questionId })
        const viewAfterAnswer = ctx.devLead.questionAnswerView(lead, questionId)
        const queued = ctx.devLead.sessionQueuedInputs(lead, runningId)
        let answerRetract
        try {
          await ctx.devLead.retractQueuedInput(lead, runningId, answer.delivery.messageId)
          answerRetract = { refused: false }
        } catch (error) {
          answerRetract = { refused: true, code: error?.code }
        }
        const background = await ctx.devLead.promptSession(lead, runningId, 'fyi context', { intent: 'background' })
        const backgroundRetract = await ctx.devLead.retractQueuedInput(lead, runningId, background.delivery.messageId)
        const instruction = await ctx.devLead.promptSession(lead, runningId, 'do X')
        const instructionRetract = await ctx.devLead.retractQueuedInput(lead, runningId, instruction.delivery.messageId)
        return {
          childId: runningId,
          questionId,
          answerDelivery: answer.delivery,
          viewAfterAnswer,
          queued,
          answerRetract,
          backgroundDelivery: background.delivery,
          backgroundRetract,
          instructionRetract,
          answerStillPending: running.inbox.nextStep.some(message => String(message.id) === answer.delivery.messageId),
        }
      },
    })
    const metadataFacts = metadata.duringGlobFacts

    // --- Running child: clear-own keeps the answer, drops the own instruction. ---
    const clearOwn = await runScriptedChildTurn(ctx, lead, {
      title: 'e2e answer clear-own',
      prompt: 'e2e turn: run a tool so the lead can interrupt the inbox',
      script: [
        toolCallChunks([{ id: 'e2e-glob', name: 'glob', arguments: { pattern: '*' } }]),
        textChunks('e2e clear-own turn complete'),
      ],
      duringGlob: async ({ child: running, childId: runningId }) => {
        const receipt = await ctx.devLead.reportProgress(running, {
          kind: 'question',
          message: 'e2e clear-own question: which target?',
        })
        const qid = receipt.report.id
        const ans = await ctx.devLead.promptSession(lead, runningId, 'use staging', { intent: 'answer', questionId: qid })
        const ownInstruction = {
          id: `e2e-own-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: 'stale own instruction' }],
          source: { kind: 'devlead', form: 'relay', senderSessionId: String(lead.id), intent: 'instruction' },
        }
        const human = {
          id: `e2e-human-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: 'human instruction' }],
          source: { kind: 'user' },
        }
        running.inbox.append('next-turn', ownInstruction)
        running.inbox.append('next-turn', human)
        const replacement = await ctx.devLead.promptSession(lead, runningId, 'replacement work', {
          interrupt: true,
          interruptInbox: 'clear-own',
        })
        return {
          questionId: qid,
          answerMessageId: ans.delivery.messageId,
          ownInstructionId: ownInstruction.id,
          humanId: human.id,
          replacement,
          viewAfter: ctx.devLead.questionAnswerView(lead, qid),
          pendingIds: [...running.inbox.nextTurn, ...running.inbox.nextStep].map(message => String(message.id)),
          answerPending: running.inbox.nextStep.some(message => String(message.id) === ans.delivery.messageId),
          ownInstructionPending: [...running.inbox.nextTurn, ...running.inbox.nextStep].some(message => String(message.id) === ownInstruction.id),
          humanPending: [...running.inbox.nextTurn, ...running.inbox.nextStep].some(message => String(message.id) === human.id),
        }
      },
    })

    // --- Running child: clear-all discards the answer and reopens the question. ---
    const clearAll = await runScriptedChildTurn(ctx, lead, {
      title: 'e2e answer clear-all',
      prompt: 'e2e turn: run a tool so the lead can clear the inbox',
      script: [
        toolCallChunks([{ id: 'e2e-glob', name: 'glob', arguments: { pattern: '*' } }]),
        textChunks('e2e clear-all turn complete'),
      ],
      duringGlob: async ({ child: running, childId: runningId }) => {
        const receipt = await ctx.devLead.reportProgress(running, {
          kind: 'question',
          message: 'e2e clear-all question: which target?',
        })
        const qid = receipt.report.id
        const ans = await ctx.devLead.promptSession(lead, runningId, 'use staging', { intent: 'answer', questionId: qid })
        await ctx.devLead.promptSession(lead, runningId, 'replacement work', {
          interrupt: true,
          interruptInbox: 'clear-all',
        })
        return {
          questionId: qid,
          answerMessageId: ans.delivery.messageId,
          viewAfter: ctx.devLead.questionAnswerView(lead, qid),
          answerPending: [...running.inbox.nextTurn, ...running.inbox.nextStep].some(message => String(message.id) === ans.delivery.messageId),
          answerRecords: answerRecordsOf(lead).filter(record => record.reportId === qid),
        }
      },
    })

    return { kind: 'success', text: JSON.stringify({ metadata: metadataFacts, clearOwn: clearOwn.duringGlobFacts, clearAll: clearAll.duringGlobFacts }) }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-answer-inbox: ${messageOf(error)}` }
  }
}

/**
 * Exercise queued-inbox visibility and retraction against the real durable
 * inbox: create one idle watched child, append a human-authored and a
 * lead-authored queued input through the Host `inbox.append` (no wake, so the
 * state is deterministic on a credential-less Host), read them back through
 * `sessionQueuedInputs`, refuse the human input, and retract the own relay
 * twice to prove idempotency.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with every read-back fact, or an error result.
 */
async function executeInbox(ctx, invocation) {
  const agent = invocation.agent
  try {
    const created = await ctx.devLead.createSession(agent, { watch: true, title: 'e2e inbox child' })
    const childId = String(created.session.sessionId)
    const child = ctx.agents.get(childId)
    if (child === undefined) throw new Error('created child is not live')
    const empty = ctx.devLead.sessionQueuedInputs(agent, childId)
    const human = {
      id: `e2e-human-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: 'human queued instruction' }],
      source: { kind: 'user' },
    }
    child.inbox.append('next-turn', human)
    const withHuman = ctx.devLead.sessionQueuedInputs(agent, childId)
    let humanRefusal
    try {
      await ctx.devLead.retractQueuedInput(agent, childId, human.id)
      humanRefusal = { refused: false }
    } catch (error) {
      humanRefusal = { refused: true, code: error?.code }
    }
    const own = {
      id: `e2e-own-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: 'stale lead instruction' }],
      source: { kind: 'devlead', form: 'relay', senderSessionId: String(agent.id) },
    }
    child.inbox.append('next-turn', own)
    const first = await ctx.devLead.retractQueuedInput(agent, childId, own.id)
    const second = await ctx.devLead.retractQueuedInput(agent, childId, own.id)
    const after = ctx.devLead.sessionQueuedInputs(agent, childId)
    return {
      kind: 'success',
      text: JSON.stringify({ childId, empty, withHuman, humanRefusal, first, second, after }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-inbox: ${messageOf(error)}` }
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

/**
 * Phase 1e P1/P2 background lane: an idle lead receives progress and fyi reports
 * as next-step injects with `lane:'background'` / `wakeRequested:false`, and NO
 * new lead turn starts. Also reads the real `devlead_notifications` and
 * `devlead_get_session` (self) tool output so the harness can assert the
 * diagnostic `lane` / `deliveryState` fields and the durable receipts.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the background facts, or an error result.
 */
async function executeLanesBackground(ctx, invocation) {
  const lead = invocation.agent
  try {
    await drainLead(ctx, lead)
    const created = await ctx.devLead.createSession(lead, { watch: true, title: 'e2e lanes background child' })
    const childId = String(created.session.sessionId)
    const child = ctx.agents.get(childId)
    if (child === undefined) throw new Error('background child is not live')
    const leadTurnBefore = ctx.agents.turnBoundaryOf(lead.session).lastTurn
    const leadStatusBefore = lead.status
    const progress = await ctx.devLead.reportProgress(child, {
      kind: 'progress', message: 'e2e background progress: parser halfway', summary: 'e2e bg progress',
    })
    const fyi = await ctx.devLead.reportProgress(child, {
      kind: 'fyi', message: 'e2e background fyi: cache warmed', summary: 'e2e bg fyi',
    })
    const progressNotice = await awaitLeadNotice(ctx, lead, {
      lane: 'background', header: '[DEV LEAD REPORT]', reportIds: [progress.report.id],
    })
    const fyiNotice = await awaitLeadNotice(ctx, lead, {
      lane: 'background', header: '[DEV LEAD REPORT]', reportIds: [fyi.report.id],
    })
    // Exceed the 400ms T1 coalescing window so a regressed followup wake cannot
    // slip past the idle-lead/no-new-turn assertion.
    await sleep(700)
    const leadTurnAfter = ctx.agents.turnBoundaryOf(lead.session).lastTurn
    const leadStatusAfter = lead.status
    const notifications = await executeLeadReadTool(ctx, lead, 'devlead_notifications', { limit: 64 })
    const selfView = await executeLeadReadTool(ctx, lead, 'devlead_get_session', { session: String(lead.id) })
    return {
      kind: 'success',
      text: JSON.stringify({
        childId,
        leadTurnBefore, leadTurnAfter, leadStatusBefore, leadStatusAfter,
        progress: { receipt: progress, notice: progressNotice, deliveryState: ctx.devLead.reportDeliveryState(lead, progress.report.id) ?? null },
        fyi: { receipt: fyi, notice: fyiNotice, deliveryState: ctx.devLead.reportDeliveryState(lead, fyi.report.id) ?? null },
        notificationsTool: notifications,
        selfViewTool: selfView,
      }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-lanes-background: ${messageOf(error)}` }
  }
}

/**
 * Phase 1e P3/P4 action-required lane: blocked and decision reports steer the
 * lead with `[DEV LEAD ACTION REQUIRED]` wakes carrying the FULL message and the
 * report id; the notification digest rows carry `lane:'action-required'`.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the action wake facts, or an error result.
 */
async function executeLanesAction(ctx, invocation) {
  const lead = invocation.agent
  try {
    await drainLead(ctx, lead)
    const created = await ctx.devLead.createSession(lead, { watch: true, title: 'e2e lanes action child' })
    const childId = String(created.session.sessionId)
    const child = ctx.agents.get(childId)
    if (child === undefined) throw new Error('action child is not live')
    const blockedMessage = 'e2e blocked: the staging database refuses connections\nretry budget exhausted'
    const decisionMessage = 'e2e decision: ship the blue-green cutover or roll back?'
    const blocked = await ctx.devLead.reportProgress(child, { kind: 'blocked', message: blockedMessage, summary: 'e2e blocked' })
    const decision = await ctx.devLead.reportProgress(child, { kind: 'decision', message: decisionMessage, summary: 'e2e decision' })
    const blockedWake = await awaitLeadNotice(ctx, lead, {
      lane: 'action-required', header: '[DEV LEAD ACTION REQUIRED]', reportIds: [blocked.report.id],
    })
    const decisionWake = await awaitLeadNotice(ctx, lead, {
      lane: 'action-required', header: '[DEV LEAD ACTION REQUIRED]', reportIds: [decision.report.id],
    })
    const notifications = await executeLeadReadTool(ctx, lead, 'devlead_notifications', { limit: 64 })
    return {
      kind: 'success',
      text: JSON.stringify({
        childId, blockedMessage, decisionMessage,
        blocked: { receipt: blocked, wake: blockedWake, deliveryState: ctx.devLead.reportDeliveryState(lead, blocked.report.id) ?? null },
        decision: { receipt: decision, wake: decisionWake, deliveryState: ctx.devLead.reportDeliveryState(lead, decision.report.id) ?? null },
        notificationsTool: notifications,
      }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-lanes-action: ${messageOf(error)}` }
  }
}

/**
 * Phase 1e T1/T2 turn lanes: a REAL scripted child turn that completes rides the
 * turn-notice lane (`[DEV LEAD NOTIFICATION]` followup); a REAL scripted child
 * turn whose adapter throws settles as `turn/end` error and rides the
 * action-required review lane (`[DEV LEAD REVIEW REQUIRED]` steer).
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with both turn facts, or an error result.
 */
async function executeLanesTurn(ctx, invocation) {
  const lead = invocation.agent
  try {
    await drainLead(ctx, lead)
    const completed = await runScriptedChildTurn(ctx, lead, {
      title: 'e2e lanes completed turn',
      prompt: 'e2e turn: finish cleanly',
      script: [textChunks('e2e lanes completed turn output')],
    })
    const completedWake = await awaitLeadNotice(ctx, lead, {
      lane: 'turn-notice', header: '[DEV LEAD NOTIFICATION]', contains: completed.childId,
    })
    const failed = await runScriptedChildTurn(ctx, lead, {
      title: 'e2e lanes failed turn',
      prompt: 'e2e turn: the adapter fails',
      script: [textChunks('unused')],
      failRequest: true,
    })
    const failedWake = await awaitLeadNotice(ctx, lead, {
      lane: 'action-required', header: '[DEV LEAD REVIEW REQUIRED]', contains: failed.childId,
    })
    return {
      kind: 'success',
      text: JSON.stringify({
        completed: { facts: completed, wake: completedWake },
        failed: { facts: failed, wake: failedWake },
      }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-lanes-turn: ${messageOf(error)}` }
  }
}

/**
 * Phase 1e double-wake merge: while the lead is held RUNNING (a parked question
 * wake occupies its inbox), a watched child's mid-turn question report stays
 * PENDING and the child's same-turn `turn/end` merges into that pending wake.
 * The durable notification row then carries `wakeSuppressedByReportId` /
 * `wakeSuppressionReason:'merged-into-pending-wake'`, and the delivered question
 * wake explicitly includes the turn-end line.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the merge facts, or an error result.
 */
async function executeLanesMerge(ctx, invocation) {
  const lead = invocation.agent
  try {
    await drainLead(ctx, lead)
    const parking = await ctx.devLead.createSession(lead, { watch: true, title: 'e2e lanes merge parking child' })
    const parkingId = String(parking.session.sessionId)
    const parkingChild = ctx.agents.get(parkingId)
    if (parkingChild === undefined) throw new Error('merge parking child is not live')
    let mergeFacts = null
    const held = await holdLeadRunning(ctx, lead, {
      duringGlob: async () => {
        // Park the first question wake (lead is running, so the steer is admitted
        // but not claimed); every later action report of this lead stays pending.
        const q0 = await ctx.devLead.reportProgress(parkingChild, {
          kind: 'question', message: 'e2e merge parking question: which lane?',
        })
        // A REAL scripted child turn: mid-turn question Q1 (turn 1) then a
        // completed turn/end (turn 1). Q1 is pending behind the parked wake, so
        // the turn/end merges into Q1's wake.
        const scripted = await runScriptedChildTurn(ctx, lead, {
          title: 'e2e lanes merge scripted child',
          prompt: 'e2e turn: ask the lead then finish',
          script: [
            toolCallChunks([{
              id: 'e2e-merge-question',
              name: 'devlead_report',
              arguments: { kind: 'question', message: 'e2e merge question: which release train?', summary: 'e2e merge train' },
            }]),
            textChunks('e2e merge scripted turn complete'),
          ],
        })
        const q1 = ctx.devLead.reports(lead, { limit: 64 })
          .find(row => row.kind === 'question' && row.senderSessionId === scripted.childId)
        const mergedRow = ctx.devLead.notifications(lead, { limit: 64 })
          .find(row => row.id === `${scripted.childId}:1:completed`)
        mergeFacts = {
          q0Id: q0.report.id,
          q1Id: q1?.id ?? null,
          scriptedChildId: scripted.childId,
          scriptedTurnEndReason: scripted.turnEndReason,
          scriptedTurnEnds: scripted.turnEnds,
          mergedRow: mergedRow ?? null,
        }
        return mergeFacts
      },
    })
    // After the lead drains, the pending Q1 wake is delivered with the merged
    // turn-end line explicitly included.
    const q1Wake = mergeFacts?.q1Id == null
      ? { found: false }
      : await awaitLeadNotice(ctx, lead, {
        lane: 'action-required', header: '[DEV LEAD QUESTION]', reportIds: [mergeFacts.q1Id], contains: '- included turn-end:',
      })
    const notificationsTool = await executeLeadReadTool(ctx, lead, 'devlead_notifications', { limit: 64 })
    return {
      kind: 'success',
      text: JSON.stringify({ held: { turnEnds: held.turnEnds, eventCount: held.eventCount }, merge: mergeFacts, q1Wake, notificationsTool }),
    }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-lanes-merge: ${messageOf(error)}` }
  }
}

/**
 * Phase 1e action-cap explicitness: while the lead is held RUNNING with a parked
 * action wake, a watched child fills the shared 16-pending-per-pair cap (a mix of
 * blocked reports and questions). The 17th distinct report is accepted (1 parked
 * + 16 pending); the 18th distinct report throws `DEVLEAD_DELIVERY_RATE_LIMITED`
 * back to the child — no silent drop. Every accepted receipt stays durable.
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the per-report outcomes, or an error result.
 */
async function executeLanesRate(ctx, invocation) {
  const lead = invocation.agent
  try {
    await drainLead(ctx, lead)
    const created = await ctx.devLead.createSession(lead, { watch: true, title: 'e2e lanes rate child' })
    const childId = String(created.session.sessionId)
    const child = ctx.agents.get(childId)
    if (child === undefined) throw new Error('rate child is not live')
    let rateFacts = null
    const held = await holdLeadRunning(ctx, lead, {
      duringGlob: async () => {
        const outcomes = []
        // 4 blocked (the per-turn non-question budget) + 14 questions = 18 distinct
        // action reports. The first parks (delivered), the next 16 fill the pending
        // cap, and the 18th must be refused explicitly.
        const plan = [
          ...Array.from({ length: 4 }, (_, index) => ({ kind: 'blocked', message: `e2e rate blocked #${index}` })),
          ...Array.from({ length: 14 }, (_, index) => ({ kind: 'question', message: `e2e rate question #${index}?` })),
        ]
        for (const item of plan) {
          try {
            const receipt = await ctx.devLead.reportProgress(child, { kind: item.kind, message: item.message })
            outcomes.push({ kind: item.kind, accepted: true, durable: receipt.durable, id: receipt.report.id })
          } catch (error) {
            outcomes.push({ kind: item.kind, accepted: false, code: error?.code ?? null, message: messageOf(error) })
          }
        }
        const accepted = outcomes.filter(entry => entry.accepted)
        const refused = outcomes.filter(entry => !entry.accepted)
        rateFacts = {
          outcomes,
          acceptedCount: accepted.length,
          refusedCount: refused.length,
          acceptedAllDurable: accepted.every(entry => entry.durable === true),
          refusedCodes: refused.map(entry => entry.code),
        }
        return rateFacts
      },
    })
    return { kind: 'success', text: JSON.stringify({ childId, held: { turnEnds: held.turnEnds }, rate: rateFacts }) }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-lanes-rate: ${messageOf(error)}` }
  }
}

/**
 * Phase 1e metrics: return the process-local delivery/suppression/guard counter
 * snapshot. The harness asserts the expected series exist and that every label
 * is a low-cardinality enum (never a Session id, report id, or message text).
 * @param ctx - probe context.
 * @param invocation - command invocation carrying the lead Agent.
 * @returns success JSON with the snapshot, or an error result.
 */
async function executeLanesMetrics(ctx, invocation) {
  void invocation
  try {
    const snapshot = ctx.devLead.metricsSnapshot()
    return { kind: 'success', text: JSON.stringify({ snapshot }) }
  } catch (error) {
    return { kind: 'error', text: `devlead-e2e-lanes-metrics: ${messageOf(error)}` }
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
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#board`),
    name: BOARD_COMMAND_NAME,
    description: 'E2E probe: write five board revisions through the real Host (per-project CAS + path/title refs).',
    handler: guarded(BOARD_COMMAND_NAME, invocation => executeBoard(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#board-state`),
    name: BOARD_STATE_COMMAND_NAME,
    description: 'E2E probe: report the current board activation facts and the result of one real board read.',
    handler: guarded(BOARD_STATE_COMMAND_NAME, invocation => executeBoardState(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#dispatch`),
    name: DISPATCH_COMMAND_NAME,
    description: 'E2E probe: create Sessions with a model selection and Agent Teams, and report the real state.',
    handler: guarded(DISPATCH_COMMAND_NAME, invocation => executeDispatch(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#watch-child`),
    name: WATCH_CHILD_COMMAND_NAME,
    description: 'E2E probe: create one idle watched child for report-surface checks.',
    handler: guarded(WATCH_CHILD_COMMAND_NAME, invocation => executeWatchChild(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#report`),
    name: REPORT_COMMAND_NAME,
    description: 'E2E probe: send a real mid-turn report from this watched child.',
    handler: guarded(REPORT_COMMAND_NAME, invocation => executeReport(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#question`),
    name: QUESTION_COMMAND_NAME,
    description: 'E2E probe: ask a real ask_user_question call through a watched child and report the gate.',
    handler: guarded(QUESTION_COMMAND_NAME, invocation => executeQuestion(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#question-report`),
    name: QUESTION_REPORT_COMMAND_NAME,
    description: 'E2E probe: drive devlead_report question conclude/durable paths from inside a watched child.',
    handler: guarded(QUESTION_REPORT_COMMAND_NAME, invocation => executeQuestionReport(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#question-turn`),
    name: QUESTION_TURN_COMMAND_NAME,
    description: 'E2E probe: real scripted child turn where a concluding question batch still runs committed next-step work.',
    handler: guarded(QUESTION_TURN_COMMAND_NAME, invocation => executeQuestionTurn(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#question-continue`),
    name: QUESTION_CONTINUE_COMMAND_NAME,
    description: 'E2E probe: real scripted child turn where a native-gate deny does not stop the model continuing.',
    handler: guarded(QUESTION_CONTINUE_COMMAND_NAME, invocation => executeQuestionContinue(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#inbox`),
    name: INBOX_COMMAND_NAME,
    description: 'E2E probe: queued-inbox visibility, ownership refusal, and idempotent retraction.',
    handler: guarded(INBOX_COMMAND_NAME, invocation => executeInbox(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#answer-turn`),
    name: ANSWER_TURN_COMMAND_NAME,
    description: 'E2E probe: real scripted child turn where the lead answers a running child via steer (Phase 1d).',
    handler: guarded(ANSWER_TURN_COMMAND_NAME, invocation => executeAnswerTurn(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#answer-inbox`),
    name: ANSWER_INBOX_COMMAND_NAME,
    description: 'E2E probe: answer inbox lifecycle — delivery metadata, retract refusal, clear-own/clear-all (Phase 1d).',
    handler: guarded(ANSWER_INBOX_COMMAND_NAME, invocation => executeAnswerInbox(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#lanes-background`),
    name: LANES_BACKGROUND_COMMAND_NAME,
    description: 'E2E probe: P1/P2 background inject without a wake + read-tool lane/deliveryState output (Phase 1e).',
    handler: guarded(LANES_BACKGROUND_COMMAND_NAME, invocation => executeLanesBackground(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#lanes-action`),
    name: LANES_ACTION_COMMAND_NAME,
    description: 'E2E probe: P3/P4 blocked/decision action-required steer wakes with the full message (Phase 1e).',
    handler: guarded(LANES_ACTION_COMMAND_NAME, invocation => executeLanesAction(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#lanes-turn`),
    name: LANES_TURN_COMMAND_NAME,
    description: 'E2E probe: T1 completed followup vs T2 failed review steer wakes (Phase 1e).',
    handler: guarded(LANES_TURN_COMMAND_NAME, invocation => executeLanesTurn(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#lanes-merge`),
    name: LANES_MERGE_COMMAND_NAME,
    description: 'E2E probe: question + turn-end double-wake merge suppression fields (Phase 1e).',
    handler: guarded(LANES_MERGE_COMMAND_NAME, invocation => executeLanesMerge(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#lanes-rate`),
    name: LANES_RATE_COMMAND_NAME,
    description: 'E2E probe: 16-pair action cap overflow returns DEVLEAD_DELIVERY_RATE_LIMITED (Phase 1e).',
    handler: guarded(LANES_RATE_COMMAND_NAME, invocation => executeLanesRate(ctx, invocation)),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId(`${DEFINITION_ID}#lanes-metrics`),
    name: LANES_METRICS_COMMAND_NAME,
    description: 'E2E probe: low-cardinality delivery/suppression/guard metrics snapshot (Phase 1e).',
    handler: guarded(LANES_METRICS_COMMAND_NAME, invocation => executeLanesMetrics(ctx, invocation)),
  })
}
