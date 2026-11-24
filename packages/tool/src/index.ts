/**
 * Model-facing `devlead_*` tools and the conditional DevLead system-prompt
 * section.
 *
 * Every tool is visible only inside a Session whose Agent has DevLead mode
 * enabled: registration carries a `when` condition that asks the core service,
 * so a normal Session never sees the tools or the policy text. The plugin owns
 * no state of its own; it validates model input, forwards the call to
 * `ctx.devLead`, and projects the result onto a canonical JSON value.
 *
 * @module @yankeguo/dsh-tool-devlead
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { childReportLane } from '@yankeguo/dsh-devlead'
import type { DevLeadReport } from '@yankeguo/dsh-devlead-protocol'
import {
  TOOL_ARGUMENT_KEYS,
  assertKnownArguments,
  createSessionRequest,
  defaultedLimit,
  optionalInterruptInbox,
  optionalPositiveInteger,
  optionalPromptIntent,
  optionalText,
  optionalWorkspaceRef,
  requireAbsolutePath,
  requireAgent,
  requireInputId,
  requirePrompt,
  requireSessionRef,
  requireWorkspaceRef,
} from './arguments.ts'
import { runTool } from './errors.ts'
import { registerDevLeadBoardTools } from './board-tools.ts'
import { DEFAULT_NOTIFICATIONS_LIMIT, TOOL_PARAMETERS } from './parameters.ts'
import { DEVLEAD_BOARD_POLICY, DEVLEAD_REPORT_POLICY, devLeadPolicy } from './policy.ts'
import { registerQuestionRouting } from './question-routing.ts'
import {
  presentArchiveSessionCall,
  presentCreateSessionCall,
  presentGetSessionCall,
  presentListAgentPresetsCall,
  presentListModelsCall,
  presentListSessionsCall,
  presentListWorkspacesCall,
  presentNotificationsCall,
  presentPromptSessionCall,
  presentReportCall,
  presentRemoveWorkspaceCall,
  presentRetractInputCall,
  presentUnarchiveSessionCall,
  presentUseWorkspaceCall,
  presentWatchSessionCall,
} from './presentation.ts'
import {
  ARCHIVE_SESSION_OUTPUT,
  CREATE_SESSION_OUTPUT,
  GET_SESSION_OUTPUT,
  LIST_AGENT_PRESETS_OUTPUT,
  LIST_MODELS_OUTPUT,
  LIST_SESSIONS_OUTPUT,
  LIST_WORKSPACES_OUTPUT,
  NOTIFICATIONS_OUTPUT,
  PROMPT_SESSION_OUTPUT,
  REPORT_OUTPUT,
  REMOVE_WORKSPACE_OUTPUT,
  RETRACT_INPUT_OUTPUT,
  UNARCHIVE_SESSION_OUTPUT,
  USE_WORKSPACE_OUTPUT,
  WATCH_SESSION_OUTPUT,
  agentPresetCatalogValue,
  archivedSessionValue,
  createdSessionValue,
  modelCatalogValue,
  notificationValue,
  promptedSessionValue,
  reportValue,
  removedWorkspaceValue,
  sessionValue,
  unarchivedSessionValue,
  watchMutationValue,
  watchedIds,
  workspaceValue,
} from './value.ts'

/** Cordis plugin name. */
export const name = 'tool-devlead'

/** Services this plugin needs: the DevLead core, tool registration, and prompt sections. */
export const inject = ['devLead', 'tools', 'systemPrompt']

/** Newest retained mid-turn reports `devlead_get_session` adds when reading the lead itself. */
const SELF_REPORTS_LIMIT = 5

/**
 * Assemble the diagnostic lane/deliveryState facts of one retained report for
 * the read tools. The lane is a pure kind derivation; the deliveryState is the
 * hub's in-memory observation and stays absent for old records or after a
 * restart (the durable digest is the recovery authority).
 */
function reportFacts(
  ctx: Context,
  agent: Agent,
  report: DevLeadReport,
): { lane: 'turn-notice' | 'action-required' | 'background'; deliveryState?: 'pending' | 'delivered' | 'digest-only' } {
  const deliveryState = ctx.devLead.reportDeliveryState(agent, report.id)
  return {
    lane: childReportLane(report.kind),
    ...deliveryState === undefined ? {} : { deliveryState },
  }
}

/**
 * Concurrency classifier of the read-only tools: they only project Host state,
 * so a batch of sibling reads may overlap instead of running exclusively.
 * Mutations keep the default exclusive classification.
 */
const READ_ONLY_CONCURRENCY_SAFE = (): boolean => true

const LIST_MODELS_DESCRIPTION =
  'List the model routes this Host can dispatch to: the Host default selection, routable providers, each provider\'s '
  + 'models with their reasoning efforts and default effort, and any provider whose catalog could not be loaded. Call '
  + 'this before pinning provider/model/reasoning_effort on devlead_create_session; the pinning rules live on those '
  + 'parameters.'

const LIST_AGENT_PRESETS_DESCRIPTION =
  'List the Agent preset roster this Host currently defines for Session creation. Each entry carries the id accepted '
  + 'by devlead_create_session preset, its name/description when available, a default marker, and a broken reason '
  + 'when the preset cannot compose a Session. Call this before setting preset and never assume a fixed list; '
  + 'standard and ptc are examples on some Hosts, not a complete vocabulary. If the Host composes no roster, the '
  + 'result reports available false with a reason; the preset parameter states the fallback and rejection rules.'

const LIST_WORKSPACES_DESCRIPTION =
  'List every registered DSH Workspace: its id, title, canonical directory path, live directory status, and the '
  + 'Sessions the registry accounts to it. Use it first to decide which Workspace owns a request, before registering '
  + 'a new Workspace or dispatching a Session. Its id, path, and exact title are the accepted Workspace references.'

const USE_WORKSPACE_DESCRIPTION =
  'Register a repository directory as a DSH Workspace so Sessions can be created in it. An already-registered path is '
  + 'reused idempotently. A missing directory is an error by default: set create to true only when the human explicitly '
  + 'asked to create that directory.'

const LIST_SESSIONS_DESCRIPTION =
  'List DSH Sessions this DevLead Session can address: whether each is live, running, watched, or archived, plus '
  + 'latest-turn facts when the Host knows them. Watched and running rows come first. Optionally restrict to one '
  + 'Workspace (by id, registered path, or exact title) or to the watched set; use devlead_get_session for a log '
  + 'detail with the latest turn outcome and assistant excerpt. Inspect it after a wake-up or when the human '
  + 'explicitly asks, not as a polling loop while waiting for a dispatched Session.'

const CREATE_SESSION_DESCRIPTION =
  'Create an ordinary DSH Session in a Workspace, optionally started with a prompt. Use it to dispatch the owning '
  + 'Workspace\'s work to that Session instead of doing the work yourself; the brief may carry open questions, '
  + 'because the Session owns the deeper investigation and the implementation. The child inherits the Host default '
  + 'model unless you pin provider/model (plus optional reasoning_effort); preset and agent_teams inherit by default '
  + 'too. These settings are creation-time only; each parameter states its pinning rules. Never change the '
  + 'Host/profile default or reroute a model on your own. It runs independently: after this call end the turn '
  + 'instead of waiting; never sleep or poll the read tools, and never call wait_agent to wait for it. A watched '
  + 'Session is the default, and its settled turn starts a new turn of this lead session with the wake-up message. A '
  + 'watched child can use devlead_report for mid-turn milestones; invite it only in a long-running brief, and omit '
  + 'that advice with watch=false.'

const GET_SESSION_DESCRIPTION =
  'Read one Session in detail: whether it is live and running, whether it is archived, and, when the Host can read '
  + 'the Session log, the latest turn number and outcome plus the latest error and assistant excerpts. While a live '
  + 'Agent owns the target, the output also lists its queued inbox inputs (id, boundary, source, text excerpt, enqueue '
  + 'time, and for DevLead messages the intent/questionId/wakeRequested plus a tracked answer\'s deliveryState), so '
  + 'stale or duplicate queued instructions can be identified before they run and answers distinguished from '
  + 'instructions. Use it to '
  + 'inspect state after a wake-up or when the human explicitly asks, not to poll while waiting for a dispatched Session. '
  + `When the target is this lead Session itself, the output also carries its ${SELF_REPORTS_LIMIT} newest retained mid-turn reports `
  + '(question reports with questionStatus/answerStatus, every report with its diagnostic lane and in-memory deliveryState).'

const PROMPT_SESSION_DESCRIPTION =
  'Admit a prompt into an existing Session, resuming a cold Session first. The prompt is attributed to this '
  + 'DevLead Session. Archived Sessions are rejected. The Session is watched by default, so after this call end the '
  + 'turn instead of waiting: its settled turn starts a new turn of this lead session with the wake-up message. A '
  + 'watched Session gains devlead_report for mid-turn milestones; mention it only in a long-running continuation. '
  + 'With watch=false this call only skips adding a watch: an already-watched Session stays watched and keeps '
  + 'devlead_report, so use devlead_watch_session with watching:false to remove it. The intent selects delivery: '
  + 'instruction (default) queues a new next-turn boundary behind the current turn; answer (requires question_id) '
  + 'replies to a [DEV LEAD QUESTION] report and steers the child\'s next step; correction changes the current '
  + 'approach and also steers; background injects non-urgent context without a wake. steer is next-step priority, '
  + 'not preemption or isolation: the current model request/tool batch finishes first, and an idle answer may share '
  + 'a request with an older next-turn input. Set interrupt true only to replace the current work (cancel + new '
  + 'turn), with inbox retention on interrupt_inbox. The result delivery reports the actual primitive/boundary/wake '
  + 'and the messageId (for retract); it is an admission receipt, not a presented confirmation.'

const RETRACT_INPUT_DESCRIPTION =
  'Withdraw one queued inbox input from a Session before it runs, addressed by the id devlead_get_session reports '
  + 'in queuedInputs. Your own instruction/correction relay prompts and background notices can be withdrawn; an '
  + 'answer is refused (removing it would desynchronize the question state from the child inbox — to discard an '
  + 'answer and reopen its question use interrupt:true with interrupt_inbox:"clear-all"). Human, scheduled, and '
  + 'other producers\' queued inputs are refused with an explanation — they are not yours to remove. Idempotent: an '
  + 'input already consumed or withdrawn reports retracted false. The target must be live (a cold Session has no '
  + 'folded inbox) and cannot be this lead Session itself. Use it to clean up a stale or misdelivered instruction '
  + 'you queued, instead of layering another prompt on top of it.'

const WATCH_SESSION_DESCRIPTION =
  'Add one Session to, or remove it from, this DevLead Session\'s watch set. A watch is a one-way follow '
  + 'relationship, not a permission grant: it only routes turn notifications/reports and allows steering; it does '
  + 'not grant file access or ownership. Only watched Sessions produce wake-up notifications, so unwatch work that '
  + 'no longer needs attention. A Session cannot watch itself.'

const NOTIFICATIONS_DESCRIPTION =
  'Read the retained notification digest of this DevLead Session together with the current watch set. Each notification '
  + 'names a watched Session whose turn settled and how it ended; a wakeSuppressedByReportId/wakeSuppressionReason pair '
  + 'means that turn-end was carried by an action-required wake instead of a separate one (the transition is still '
  + 'retained, not lost). The reports array carries mid-turn reports from watched Sessions, each with its diagnostic '
  + 'lane (background for progress/fyi, action-required for blocked/decision/question) and an in-memory deliveryState '
  + '(pending/delivered/digest-only; absent after a restart — not a presented confirmation). Both digests are newest '
  + 'last. A question report carries questionStatus (open/answered/expired/cancelled) and, when answered, answerStatus '
  + '(admitted/claimed/presented/discarded/failed): filter open questions with questionStatus === "open", and note that '
  + 'answered does not mean presented (only presented is delivery completion). Answer an open question yourself or ask '
  + 'the human, then relay with devlead_prompt_session intent "answer" and the report id as question_id. The '
  + '[DEV LEAD QUESTION] wake already carries the full question, so the normal path needs no digest read; use this for '
  + 'history or a lost wake. Read it after a wake-up or when the human explicitly asks, not as a polling loop while '
  + 'waiting for a dispatched Session.'

const REPORT_DESCRIPTION =
  'Send a one-way mid-turn report to the active DevLead Session that watches this Session; the lead cannot reply '
  + 'through the report itself. The lead is already notified when your turn settles, so do not report routine '
  + 'progress or a final summary here. Use it only mid-turn, on a long-running task, for a milestone the lead must '
  + 'know before the turn ends; a short or linear task should not call it. The kind selects the lane: progress/fyi '
  + 'are non-urgent background context injected without waking the lead (a cold lead or a full background budget '
  + 'keeps them digest-only) — use them only for updates that can wait for the next wake or settled-turn notice; '
  + 'blocked (a real blocker) and decision (a fork needing the lead before your turn ends) steer the lead\'s next '
  + 'step under [DEV LEAD ACTION REQUIRED] and share a bounded pending queue per pair, so an overflow returns '
  + 'DEVLEAD_DELIVERY_RATE_LIMITED — merge instead of resending. Use kind question when you are blocked on missing '
  + 'information or a decision, then end your turn; the lead answers in a new turn (or steers your next step while '
  + 'you are still running). When a question report is durably forwarded the result sets `turnEndRequested:true`: '
  + 'the tool requests the end of your turn, but the current tool batch still completes and already-queued '
  + 'next-step work still runs before the turn closes; do not poll or resend. When the question receipt is not '
  + 'durable, no turn end is requested: restate the question in your final assistant message and end the turn '
  + 'naturally. At most four non-question reports per turn; question reports are exempt. The result carries '
  + '`durable` and `queued`; `durable` false means no durable receipt was written on this attempt (storage absent '
  + 'or the outbox write failed), so treat the warning as a possible-loss receipt and retry when the lead is reachable.'

/** Result guidance of a durably forwarded question report (Phase 1c turn-end request). */
const QUESTION_FORWARDED_GUIDANCE =
  'The question was forwarded to the DevLead and an answer is requested. This is not an immediate close; '
  + 'the turn ends after the current tool batch and any committed next-step work — the request cannot veto '
  + 'them. The answer may arrive as a new turn or steer your next step while you are still running; do not '
  + 'poll or resend the question.'

/** Restatement instruction appended when a question receipt is memory-only. */
const QUESTION_MEMORY_ONLY_RESTATE =
  'Forwarding is memory-only on this attempt; restate the question in your final assistant message and end '
  + 'your turn naturally so the DevLead can also read it from the turn notification.'

const REMOVE_WORKSPACE_DESCRIPTION =
  'Close (remove) a DSH Workspace registration: the DSH remove action, not a deletion. The directory, its files, and '
  + 'every Session log stay untouched, but the Workspace\'s Sessions become ungrouped (still openable, no longer '
  + 'listed under that Workspace); re-registering the same directory creates a new Workspace that does not adopt '
  + 'them. Use your judgment to remove registrations that are clearly stale, duplicate, or empty, or that you '
  + 'created; do not remove a Workspace the human is using, and report what you closed and why. When tidying up, '
  + 'prefer archiving finished Sessions over unregistering their Workspace; '
  + 'removal has the wider blast radius. The returned workspace is the pre-removal snapshot, including the Session '
  + 'ids that just became ungrouped.'

const ARCHIVE_SESSION_DESCRIPTION =
  'Close (archive) one DSH Session: it disappears from sidebar grouping while its log is kept, and '
  + 'devlead_unarchive_session restores it to its recorded Workspace position. Archiving is idempotent and '
  + 'reversible; an already archived Session is a no-op and reports stopped false. Use your judgment to archive '
  + 'Sessions you created or dispatched for a task once they are done, or when the human asks to wrap up or clean '
  + 'up. When tidying up, archive finished Sessions and keep the Workspace registration. Do not archive a Session '
  + 'the human is using or talking to now, and never use closing to hide a failure. By default a Session with '
  + 'running work is refused with DEVLEAD_SESSION_ACTIVE; set stop_running true only when you mean to cancel that '
  + 'work (see stop_running for archive-then-stop). This lead Session cannot archive itself: ask the human to close '
  + 'it from the sidebar. Report what you archived and why.'

const UNARCHIVE_SESSION_DESCRIPTION =
  'Restore (unarchive) one archived DSH Session, returning it to its recorded Workspace position. Unarchiving is '
  + 'idempotent, and the Session log was kept while it was archived. Use it to reverse an archive you made while '
  + 'wrapping up, or when the human asks to restore a Session; report the restored Session.'

/**
 * Register the eighteen lead tools, the watched-Session report tool, and
 * their shared policy sections.
 *
 * The tools and the policy text follow the same condition: DevLead mode is
 * enabled for the assembling Agent. Because both are evaluated per step, toggling
 * the mode off removes the surface and the policy on the next step without
 * touching registration.
 * @param ctx - context carrying the DevLead, tool, and system-prompt services.
 */
export function apply(ctx: Context): void {
  // DevLead steering is delegation-shaped, so the policy sits with the
  // subagent guidance in the tool section ordering.
  ctx.systemPrompt.section({
    name: 'devlead:policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ agent }) => agent !== undefined && ctx.devLead.isEnabled(agent)
      ? devLeadPolicy({ worktreeIsolation: ctx.devLead.worktreeIsolationAvailable })
      : '',
  })
  // Board/notes workflow is lead-only too, but lives outside the base policy
  // so its operational guidance has an independent, explicit size budget.
  ctx.systemPrompt.section({
    name: 'devlead:board-policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ agent }) => agent !== undefined && ctx.devLead.isEnabled(agent)
      ? DEVLEAD_BOARD_POLICY
      : '',
  })
  // A watched, non-DevLead Session gets the one-way reporting guidance instead
  // of the lead policy. The condition is evaluated per step, so gaining or
  // losing the watch relationship adds/removes both the tool and this text.
  ctx.systemPrompt.section({
    name: 'devlead:report-policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ agent }) => agent !== undefined && ctx.devLead.isSupervised(agent)
      ? DEVLEAD_REPORT_POLICY
      : '',
  })
  // Give watched Sessions a hard question path to the lead before the child's
  // own ask_user_question UI can run. The listener checks supervision per call,
  // so unwatched Sessions and human-directed child turns are untouched.
  registerQuestionRouting(ctx, ctx.devLead)

  // Cache-safe user-role snapshot: unchanged board text is not persisted again,
  // while a committed revision appears in the next context reconstruction.
  ctx.systemPrompt.context({
    name: 'devlead:board-summary',
    order: ctx.systemPrompt.getContextOrder('WEB_SURFACE') + 10,
    text: ({ agent }) => agent === undefined ? '' : ctx.devLead.boardSummaryFor(agent),
  })
  registerDevLeadBoardTools(ctx)

  ctx.tools.register(defineTool({
    name: 'devlead_list_workspaces',
    description: LIST_WORKSPACES_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_list_workspaces,
    output: LIST_WORKSPACES_OUTPUT,
    presentCall: presentListWorkspacesCall,
    isConcurrencySafe: READ_ONLY_CONCURRENCY_SAFE,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_list_workspaces)
        return {
          workspaces: (await ctx.devLead.listWorkspaces(exec.signal)).map(workspaceValue),
        }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_list_models',
    description: LIST_MODELS_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_list_models,
    output: LIST_MODELS_OUTPUT,
    presentCall: presentListModelsCall,
    isConcurrencySafe: READ_ONLY_CONCURRENCY_SAFE,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_list_models)
        const agent = requireAgent(exec.agent, 'devlead_list_models')
        return modelCatalogValue(await ctx.devLead.listModels(agent, exec.signal))
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_list_agent_presets',
    description: LIST_AGENT_PRESETS_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_list_agent_presets,
    output: LIST_AGENT_PRESETS_OUTPUT,
    presentCall: presentListAgentPresetsCall,
    isConcurrencySafe: READ_ONLY_CONCURRENCY_SAFE,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_list_agent_presets)
        const agent = requireAgent(exec.agent, 'devlead_list_agent_presets')
        return agentPresetCatalogValue(await ctx.devLead.listAgentPresets(agent, exec.signal))
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_use_workspace',
    description: USE_WORKSPACE_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_use_workspace,
    output: USE_WORKSPACE_OUTPUT,
    presentCall: presentUseWorkspaceCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_use_workspace)
        const agent = requireAgent(exec.agent, 'devlead_use_workspace')
        const path = requireAbsolutePath(args.path)
        const title = optionalText(args.title)
        const workspace = await ctx.devLead.useWorkspace(
          agent,
          {
            path,
            ...title === undefined ? {} : { title },
            create: args.create ?? false,
          },
          exec.signal,
        )
        return { workspace: workspaceValue(workspace) }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_list_sessions',
    description: LIST_SESSIONS_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_list_sessions,
    output: LIST_SESSIONS_OUTPUT,
    presentCall: presentListSessionsCall,
    isConcurrencySafe: READ_ONLY_CONCURRENCY_SAFE,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_list_sessions)
        const agent = requireAgent(exec.agent, 'devlead_list_sessions')
        const workspace = optionalWorkspaceRef(args.workspace)
        const limit = optionalPositiveInteger(args.limit, 'limit')
        const sessions = await ctx.devLead.listSessions(agent, {
          ...workspace === undefined ? {} : { workspace },
          ...args.watched_only === undefined ? {} : { watchedOnly: args.watched_only },
          ...limit === undefined ? {} : { limit },
          signal: exec.signal,
        })
        return {
          sessions: sessions.map(sessionValue),
          watched: watchedIds(ctx.devLead.view(agent)),
        }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_create_session',
    description: CREATE_SESSION_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_create_session,
    output: CREATE_SESSION_OUTPUT,
    presentCall: presentCreateSessionCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_create_session)
        const agent = requireAgent(exec.agent, 'devlead_create_session')
        const created = await ctx.devLead.createSession(agent, createSessionRequest(args), exec.signal)
        return createdSessionValue(created)
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_get_session',
    description: GET_SESSION_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_get_session,
    output: GET_SESSION_OUTPUT,
    presentCall: presentGetSessionCall,
    isConcurrencySafe: READ_ONLY_CONCURRENCY_SAFE,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_get_session)
        const agent = requireAgent(exec.agent, 'devlead_get_session')
        const session = await ctx.devLead.getSession(agent, requireSessionRef(args.session), exec.signal)
        const reports = String(session.sessionId) === String(agent.id)
          ? ctx.devLead.reports(agent, { limit: SELF_REPORTS_LIMIT }).map(report => reportValue(
            report,
            report.kind === 'question' ? ctx.devLead.questionAnswerView(agent, report.id) : undefined,
            reportFacts(ctx, agent, report),
          ))
          : undefined
        const queuedInputs = ctx.devLead.sessionQueuedInputs(agent, session.sessionId, exec.signal)
        return {
          session: sessionValue(session),
          ...(reports === undefined ? {} : { reports }),
          ...(queuedInputs === undefined ? {} : { queuedInputs }),
        }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_prompt_session',
    description: PROMPT_SESSION_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_prompt_session,
    output: PROMPT_SESSION_OUTPUT,
    presentCall: presentPromptSessionCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_prompt_session)
        const agent = requireAgent(exec.agent, 'devlead_prompt_session')
        const interruptInbox = optionalInterruptInbox(args.interrupt_inbox)
        const intent = optionalPromptIntent(args.intent)
        const questionId = optionalText(args.question_id)
        const idempotencyKey = optionalText(args.idempotency_key)
        const prompted = await ctx.devLead.promptSession(
          agent,
          requireSessionRef(args.session),
          requirePrompt(args.prompt),
          {
            watch: args.watch ?? true,
            interrupt: args.interrupt ?? false,
            ...interruptInbox === undefined ? {} : { interruptInbox },
            ...intent === undefined ? {} : { intent },
            ...questionId === undefined ? {} : { questionId },
            ...idempotencyKey === undefined ? {} : { idempotencyKey },
            signal: exec.signal,
          },
        )
        return promptedSessionValue(prompted)
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_retract_input',
    description: RETRACT_INPUT_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_retract_input,
    output: RETRACT_INPUT_OUTPUT,
    presentCall: presentRetractInputCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_retract_input)
        const agent = requireAgent(exec.agent, 'devlead_retract_input')
        return await ctx.devLead.retractQueuedInput(
          agent,
          requireSessionRef(args.session),
          requireInputId(args.input_id),
          exec.signal,
        )
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_watch_session',
    description: WATCH_SESSION_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_watch_session,
    output: WATCH_SESSION_OUTPUT,
    presentCall: presentWatchSessionCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_watch_session)
        const agent = requireAgent(exec.agent, 'devlead_watch_session')
        const mutation = await ctx.devLead.watchSession(
          agent,
          requireSessionRef(args.session),
          args.watching,
          exec.signal,
        )
        return watchMutationValue(mutation)
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_notifications',
    description: NOTIFICATIONS_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_notifications,
    output: NOTIFICATIONS_OUTPUT,
    presentCall: presentNotificationsCall,
    isConcurrencySafe: READ_ONLY_CONCURRENCY_SAFE,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_notifications)
        const agent = requireAgent(exec.agent, 'devlead_notifications')
        const limit = defaultedLimit(args.limit, 'limit', DEFAULT_NOTIFICATIONS_LIMIT)
        return {
          notifications: ctx.devLead.notifications(agent, { limit }).map(notificationValue),
          reports: ctx.devLead.reports(agent, { limit }).map(report => reportValue(
            report,
            report.kind === 'question' ? ctx.devLead.questionAnswerView(agent, report.id) : undefined,
            reportFacts(ctx, agent, report),
          )),
          watched: watchedIds(ctx.devLead.view(agent)),
        }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_report',
    description: REPORT_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_report,
    output: REPORT_OUTPUT,
    presentCall: presentReportCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_report)
        const agent = requireAgent(exec.agent, 'devlead_report')
        const receipt = await ctx.devLead.reportProgress(agent, {
          message: args.message,
          ...args.kind === undefined ? {} : { kind: args.kind },
          ...args.summary === undefined ? {} : { summary: args.summary },
        }, exec.signal)
        const base = {
          report: reportValue(receipt.report),
          durable: receipt.durable,
          queued: receipt.queued,
          ...(receipt.warning === undefined ? {} : { warning: receipt.warning }),
        }
        if (receipt.report.kind !== 'question') return base
        // A memory-only question must not request a turn end: the child could
        // close the turn while the question itself is one crash away from
        // being lost. The warning asks for a restatement in the final message.
        if (!receipt.durable) {
          return {
            ...base,
            warning: receipt.warning === undefined
              ? QUESTION_MEMORY_ONLY_RESTATE
              : `${receipt.warning}. ${QUESTION_MEMORY_ONLY_RESTATE}`,
          }
        }
        // Durable question: request the turn end through the executor's own
        // marker. It rides this successful result (`concludesTurn`); the batch
        // still completes and committed next-step work still runs, so this is
        // a request, never an immediate close or a cancellation.
        exec.concludeTurn()
        return {
          ...base,
          turnEndRequested: true,
          questionId: receipt.report.id,
          guidance: QUESTION_FORWARDED_GUIDANCE,
        }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isSupervised(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_remove_workspace',
    description: REMOVE_WORKSPACE_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_remove_workspace,
    output: REMOVE_WORKSPACE_OUTPUT,
    presentCall: presentRemoveWorkspaceCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_remove_workspace)
        const agent = requireAgent(exec.agent, 'devlead_remove_workspace')
        const removed = await ctx.devLead.removeWorkspace(
          agent,
          requireWorkspaceRef(args.workspace),
          exec.signal,
        )
        return removedWorkspaceValue(removed)
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_archive_session',
    description: ARCHIVE_SESSION_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_archive_session,
    output: ARCHIVE_SESSION_OUTPUT,
    presentCall: presentArchiveSessionCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_archive_session)
        const agent = requireAgent(exec.agent, 'devlead_archive_session')
        const archived = await ctx.devLead.archiveSession(
          agent,
          requireSessionRef(args.session),
          { stopRunning: args.stop_running ?? false, signal: exec.signal },
        )
        return archivedSessionValue(archived)
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_unarchive_session',
    description: UNARCHIVE_SESSION_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_unarchive_session,
    output: UNARCHIVE_SESSION_OUTPUT,
    presentCall: presentUnarchiveSessionCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_unarchive_session)
        const agent = requireAgent(exec.agent, 'devlead_unarchive_session')
        const unarchived = await ctx.devLead.unarchiveSession(
          agent,
          requireSessionRef(args.session),
          exec.signal,
        )
        return unarchivedSessionValue(unarchived)
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })
}
