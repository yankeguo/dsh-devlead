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
import {
  DEVLEAD_REPORT_KINDS,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_SUMMARY_MAX,
} from '@yankeguo/dsh-devlead-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@yankeguo/dsh-devlead'
import {
  TOOL_ARGUMENT_KEYS,
  assertKnownArguments,
  createSessionRequest,
  defaultedLimit,
  optionalInterruptInbox,
  optionalPositiveInteger,
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
import { DEVLEAD_REPORT_POLICY, devLeadPolicy } from './policy.ts'
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

/** Default size of the notification digest `devlead_notifications` reads. */
const DEFAULT_NOTIFICATIONS_LIMIT = 20

/** Newest retained mid-turn reports `devlead_get_session` adds when reading the lead itself. */
const SELF_REPORTS_LIMIT = 5

/**
 * Concurrency classifier of the read-only tools: they only project Host state,
 * so a batch of sibling reads may overlap instead of running exclusively.
 * Mutations keep the default exclusive classification.
 */
const READ_ONLY_CONCURRENCY_SAFE = (): boolean => true

/**
 * Model-facing description of every `session` argument. Resolution tolerates a
 * truncated uuid head: the id may omit the leading `session-` prefix.
 */
const SESSION_ARGUMENT_DESCRIPTION =
  'Session id: the full id, a unique id prefix, or the uuid prefix without the "session-" prefix (for example '
  + 'e59ab350); it resolves only when unique.'

/**
 * Model-facing description shared by every `workspace` argument. All three
 * tools resolve the reference the same way, so the wording lives in one place.
 */
const WORKSPACE_ARGUMENT_DESCRIPTION =
  'Address the Workspace by id, registered directory path, or exact display title. Resolution tries the id first, '
  + 'then the registered path, then the title (trimmed, case-sensitive). A title shared by several Workspaces fails '
  + 'with DEVLEAD_WORKSPACE_AMBIGUOUS listing their ids and paths; use the id or path then.'

const LIST_MODELS_DESCRIPTION =
  'List the model routes this Host can dispatch to: the Host default selection, routable providers, each provider\'s '
  + 'models with their reasoning efforts and default effort, and any provider whose catalog could not be loaded. Call '
  + 'this before pinning provider/model/reasoning_effort on devlead_create_session; the pinning rules live on those '
  + 'parameters.'

const LIST_AGENT_PRESETS_DESCRIPTION =
  'List the Agent preset roster this Host currently defines for Session creation. Each entry carries the id accepted by '
  + 'devlead_create_session preset, its published name/description when available, a default marker (the Host effective '
  + 'default: selectedDefault when configured, otherwise its base default), and a broken reason when the preset cannot '
  + 'compose a Session. Call this before setting preset and never assume a fixed list; standard and ptc are examples on '
  + 'some Hosts, not a complete vocabulary. If the Host composes no roster, the result reports available false with a '
  + 'reason; the preset parameter of devlead_create_session states the fallback and rejection rules.'

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
  'Create an ordinary DSH Session in a Workspace and optionally start it with a prompt. The Session is a real Session '
  + 'the human can open and take over, not a subagent. Use it to dispatch the owning Workspace\'s work to that Session '
  + 'instead of doing the work yourself from this lead session; the brief may carry open questions, because the '
  + 'Session owns the deeper investigation and the implementation. The child inherits the Host default model unless '
  + 'you explicitly pin provider/model (plus optional reasoning_effort); preset and agent_teams follow the same '
  + 'inherit-by-default stance. These are creation-time only settings, and each parameter states its pinning rules '
  + 'and what to call first. Never change the Host/profile default, and do not upgrade or downgrade a model on your '
  + 'own. It runs independently, so after this call end the turn instead '
  + 'of waiting: never sleep, never poll devlead_get_session, devlead_list_sessions, or devlead_notifications, and '
  + 'never call wait_agent to wait for it. A watched Session is the default, and its settled turn starts a new turn '
  + 'of this lead session with the wake-up message. When watched, the child can use devlead_report '
  + 'for mid-turn blockers, decision forks, or scheduling-critical progress; mention it only in a long-running '
  + 'brief whose mid-turn milestones matter, and omit that advice with watch=false (the tool is absent).'

const GET_SESSION_DESCRIPTION =
  'Read one Session in detail: whether it is live and running, whether it is archived, and, when the Host can read '
  + 'the Session log, the latest turn number and outcome plus the latest error and assistant excerpts. While a live '
  + 'Agent owns the target, the output also lists its queued inbox inputs (id, boundary, source, text excerpt, enqueue '
  + 'time), so stale or duplicate queued instructions can be identified before they run. Use it to '
  + 'inspect state after a wake-up or when the human explicitly asks, not to poll while waiting for a dispatched Session. '
  + `When the target is this lead Session itself, the output also carries its ${SELF_REPORTS_LIMIT} newest retained mid-turn reports.`

const PROMPT_SESSION_DESCRIPTION =
  'Admit a follow-up prompt into an existing Session, resuming a cold Session first. The prompt is attributed to this '
  + 'DevLead Session. Archived Sessions are rejected. The Session is watched by default, so after this call end the '
  + 'turn instead of waiting: its settled turn starts a new turn of this lead session with the wake-up message. A '
  + 'watched Session gains devlead_report; in a long-running continuation whose mid-turn milestones matter, tell it '
  + 'to report blockers, decision forks, or scheduling-critical progress. With watch=false this call only skips '
  + 'adding a watch: an already-watched Session stays watched and keeps devlead_report, so use devlead_watch_session '
  + 'with watching:false to remove it. Default delivery queues the prompt behind the '
  + 'Session\'s current turn; set interrupt true only to replace that work, with the exact stop-and-replace semantics '
  + 'described on the interrupt parameter and the inbox retention options on interrupt_inbox.'

const RETRACT_INPUT_DESCRIPTION =
  'Withdraw one queued inbox input from a Session before it runs, addressed by the id devlead_get_session reports '
  + 'in queuedInputs. Only relay prompts this lead Session authored can be withdrawn; human, scheduled, and other '
  + 'producers\' queued inputs are refused with an explanation — they are not yours to remove. Idempotent: an input '
  + 'already consumed or withdrawn reports retracted false. The target must be live (a cold Session has no folded '
  + 'inbox) and cannot be this lead Session itself. Use it to clean up a stale or misdelivered instruction you '
  + 'queued, instead of layering another prompt on top of it.'

const WATCH_SESSION_DESCRIPTION =
  'Add one Session to, or remove it from, this DevLead Session\'s watch set. A watch is a one-way follow '
  + 'relationship, not a permission grant: it only routes turn notifications/reports and allows steering; it does '
  + 'not grant file access or ownership. Only watched Sessions produce wake-up notifications, so unwatch work that '
  + 'no longer needs attention. A Session cannot watch itself.'

const NOTIFICATIONS_DESCRIPTION =
  'Read the retained notification digest of this DevLead Session together with the current watch set. Each notification '
  + 'names a watched Session whose turn settled and how it ended; the reports array carries mid-turn reports from '
  + 'watched Sessions. Both digests are newest last. A question report means the watched Session needs a decision; '
  + 'answer it yourself or ask the human, then relay the answer with devlead_prompt_session. Read it after a wake-up '
  + 'or when the human explicitly asks, not as a polling loop while waiting for a dispatched Session.'

const REPORT_DESCRIPTION =
  'Send a one-way mid-turn report to the single active DevLead Session that watches this Session; the lead cannot '
  + 'reply through the report itself. The lead is already notified when your turn settles, so do not report routine '
  + 'progress or a final summary here. Use it only mid-turn, on a long-running task, for a milestone the lead must '
  + 'know before the turn ends: a real blocker, a fork that needs the lead\'s decision, or progress that would '
  + 'change scheduling correctness if it waited; a short or linear task should not call it. Use kind question when '
  + 'you are blocked on missing information or a decision, '
  + 'then end your turn; the lead answers in a new turn (directly, or after asking the human). Keep the message '
  + 'concise and actionable; at most four distinct non-question reports are accepted per turn, question reports are '
  + 'exempt from that budget, the same kind and message in one turn is deduplicated, and no target Session can be '
  + 'chosen. The result '
  + 'carries `durable` and `queued`; `durable` false means no durable receipt was written on this attempt (durable '
  + 'storage is absent, or the outbox write failed), so treat the warning as a possible-loss receipt and retry when '
  + 'the lead is reachable.'

const REMOVE_WORKSPACE_DESCRIPTION =
  'Close (remove) a DSH Workspace registration: the DSH remove action, not a deletion. The directory, its files, and '
  + 'every Session log stay untouched, but the Workspace\'s Sessions become ungrouped: they stay openable and '
  + 'continuable, yet no longer appear under that Workspace, and re-registering the same directory creates a brand new '
  + 'Workspace that does not adopt them. Use your '
  + 'judgment to remove '
  + 'registrations that are clearly stale, duplicate, or empty, or that you created, or when the human asks to tidy up; '
  + 'do not remove a Workspace the human is using, and report what you closed and why. When tidying up, prefer '
  + 'archiving finished Sessions over unregistering their Workspace; removal has the wider blast radius. The returned '
  + 'workspace is the pre-removal snapshot, including the Session ids that just became ungrouped.'

const ARCHIVE_SESSION_DESCRIPTION =
  'Close (archive) one DSH Session: it disappears from the sidebar grouping while its log is kept, and '
  + 'devlead_unarchive_session restores it to its recorded Workspace position. Archiving is idempotent and reversible; '
  + 'an already archived Session is a no-op and reports stopped false. Use your judgment to archive Sessions '
  + 'you created or dispatched for a task once they are done, or when the human asks to wrap up or clean up. When '
  + 'tidying up, archive finished Sessions and keep the Workspace registration, unless the registration itself is '
  + 'stale, duplicate, empty, or one you created. Do not archive a Session the human is using or talking to now, and '
  + 'never use closing to hide a failure. By default a Session with '
  + 'running work (a turn, subagents, jobs, or schedules) is refused with DEVLEAD_SESSION_ACTIVE; set stop_running '
  + 'true only when you mean to cancel that work, with the archive-then-stop semantics described on the stop_running '
  + 'parameter. This lead '
  + 'Session cannot archive itself: ask the human to close it from the sidebar. Report what you archived and why.'

const UNARCHIVE_SESSION_DESCRIPTION =
  'Restore (unarchive) one archived DSH Session, returning it to its recorded Workspace position. Unarchiving is '
  + 'idempotent, and the Session log was kept while it was archived. Use it to reverse an archive you made while '
  + 'wrapping up, or when the human asks to restore a Session; report the restored Session.'

/**
 * Register the fourteen lead tools, the watched-Session report tool, and
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

  ctx.tools.register(defineTool({
    name: 'devlead_list_workspaces',
    description: LIST_WORKSPACES_DESCRIPTION,
    parameters: {},
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
    parameters: {},
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
    parameters: {},
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
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path of the repository directory to register.',
      },
      title: {
        type: 'string',
        description: 'Optional display title for a newly registered Workspace; the exact title also becomes an '
          + 'addressable reference for workspace arguments. An already-registered path keeps its current title.',
      },
      create: {
        type: 'boolean',
        default: false,
        description: 'Defaults to false. Set true only when the human asked to create the directory.',
      },
    },
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
    parameters: {
      workspace: {
        type: 'string',
        description: `Optional Workspace filter. ${WORKSPACE_ARGUMENT_DESCRIPTION}`,
      },
      watched_only: {
        type: 'boolean',
        description: 'Only list Sessions in this lead\'s watch set.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of Session rows to return; the Host may return fewer when its listing cap is lower. With watched_only, the whole watch set is returned even when it exceeds this limit, so no watched Session is hidden.',
      },
    },
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
    parameters: {
      workspace: {
        type: 'string',
        description: `The owning Workspace. ${WORKSPACE_ARGUMENT_DESCRIPTION} Omit only when the work truly belongs `
          + 'to this lead\'s directory.',
      },
      prompt: {
        type: 'string',
        description: 'Optional self-contained prompt the new Session starts with: background, target result, open '
          + 'questions to confirm, deliverables, verification, and boundaries. The child cannot see this conversation. '
          + 'When the prompt pins a model, call devlead_list_models first.',
      },
      title: {
        type: 'string',
        description: 'Optional display title for the new Session.',
      },
      watch: {
        type: 'boolean',
        default: true,
        description: 'Watch the new Session and receive its turn notifications; watched Sessions also gain '
          + 'devlead_report. Defaults to true.',
      },
      preset: {
        type: 'string',
        description: 'Optional Host-defined Agent preset id for the new Session; call devlead_list_agent_presets to read '
          + 'this Host\'s roster. Do not assume a fixed list (standard and ptc are examples on some Hosts). Omit or leave '
          + 'blank to inherit the plugin defaultAgentPreset, then the Host default/selectedDefault. An unknown or unusable '
          + 'preset fails creation with a structured error; it is never silently ignored.',
      },
      isolation: {
        type: 'string',
        enum: ['none', 'worktree'],
        default: 'none',
        description: 'Optional checkout isolation for the new Session; defaults to "none". "worktree" asks for a '
          + 'best-effort isolated Git checkout of the owning Workspace for the new Session. It is applied only when '
          + 'the Host composes the experimental Git worktree service, and a non-active outcome (unavailable or '
          + 'failed) is returned in the isolation field of the result, never as an error.',
      },
      provider: {
        type: 'string',
        description: 'Optional model provider route for the new Session; requires model. Omit to inherit the Host '
          + 'default (recommended unless the human asked or the brief requires a specific route). Call '
          + 'devlead_list_models first when pinning; validated before the Session is created. Creation-time only.',
      },
      model: {
        type: 'string',
        description: 'Optional model id for the new Session; requires provider. Omit to inherit the Host default. Use it '
          + 'only for explicit cost/capability routing or reproducibility, and call devlead_list_models first. '
          + 'Creation-time only; never changes the Host/profile default.',
      },
      reasoning_effort: {
        type: 'string',
        description: 'Optional adapter reasoning effort for the new Session; requires provider and model. Omit to '
          + 'inherit the model\'s default effort (recommended unless the human asked). Call devlead_list_models for '
          + 'the supported effort ids.',
      },
      agent_teams: {
        type: 'boolean',
        description: 'Agent Teams is your judgment: true for complex, multi-step, or parallel work that benefits from '
          + 'subagent collaboration, false to disable, omit for simple linear work (Host default). Obey an explicit '
          + 'human on/off. Creation-time only. true requires DSH 0.2.2-rc.2 or newer with the Agent Teams service '
          + 'composed; otherwise it fails with DEVLEAD_TEAM_UNAVAILABLE—omit it and continue without Team mode '
          + 'instead of retrying or blocking.',
      },
    },
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
    parameters: {
      session: {
        type: 'string',
        required: true,
        description: SESSION_ARGUMENT_DESCRIPTION,
      },
    },
    output: GET_SESSION_OUTPUT,
    presentCall: presentGetSessionCall,
    isConcurrencySafe: READ_ONLY_CONCURRENCY_SAFE,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_get_session)
        const agent = requireAgent(exec.agent, 'devlead_get_session')
        const session = await ctx.devLead.getSession(agent, requireSessionRef(args.session), exec.signal)
        const reports = String(session.sessionId) === String(agent.id)
          ? ctx.devLead.reports(agent, { limit: SELF_REPORTS_LIMIT }).map(reportValue)
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
    parameters: {
      session: {
        type: 'string',
        required: true,
        description: SESSION_ARGUMENT_DESCRIPTION,
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'Follow-up instruction admitted as a user message attributed to this DevLead Session.',
      },
      watch: {
        type: 'boolean',
        default: true,
        description: 'Watch the Session after prompting. Defaults to true.',
      },
      interrupt: {
        type: 'boolean',
        default: false,
        description: 'Defaults to false. Set true only to replace the Session\'s current work: the Host stops its '
          + 'running turn and the work its stop providers report (running subagents, owned jobs, active schedules), '
          + 'discards queued inbox input, then admits this prompt as a new turn. An idle or cold Session is a no-op '
          + 'and receives the prompt normally. The interrupted turn still produces its normal watched-turn '
          + 'notification as cancelled.',
      },
      interrupt_inbox: {
        type: 'string',
        enum: ['clear-all', 'keep', 'clear-own'],
        default: 'clear-all',
        description: 'Inbox policy applied when interrupt stops a running turn; defaults to "clear-all" (the stop '
          + 'discards every pending input, the historical behavior). "keep" restores every pending message after '
          + 'the stop; "clear-own" restores everything except the relay prompts this lead Session authored, so '
          + 'human and other producers\' queued inputs survive. Restored messages keep their id and queue order '
          + 'ahead of the replacement prompt. Ignored without interrupt:true and for an idle or cold target. The '
          + 'result reports retainedInputs when a retention policy ran.',
      },
    },
    output: PROMPT_SESSION_OUTPUT,
    presentCall: presentPromptSessionCall,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_prompt_session)
        const agent = requireAgent(exec.agent, 'devlead_prompt_session')
        const interruptInbox = optionalInterruptInbox(args.interrupt_inbox)
        const prompted = await ctx.devLead.promptSession(
          agent,
          requireSessionRef(args.session),
          requirePrompt(args.prompt),
          {
            watch: args.watch ?? true,
            interrupt: args.interrupt ?? false,
            ...interruptInbox === undefined ? {} : { interruptInbox },
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
    parameters: {
      session: {
        type: 'string',
        required: true,
        description: SESSION_ARGUMENT_DESCRIPTION,
      },
      input_id: {
        type: 'string',
        required: true,
        description: 'Stable message id of the queued input, as reported by devlead_get_session queuedInputs.',
      },
    },
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
    parameters: {
      session: {
        type: 'string',
        required: true,
        description: SESSION_ARGUMENT_DESCRIPTION,
      },
      watching: {
        type: 'boolean',
        required: true,
        description: 'True to watch the Session, false to stop watching it.',
      },
    },
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
    parameters: {
      limit: {
        type: 'integer',
        default: DEFAULT_NOTIFICATIONS_LIMIT,
        description: 'Maximum number of rows to return from each digest: notifications and reports are limited '
          + `separately, newest rows kept. Defaults to ${DEFAULT_NOTIFICATIONS_LIMIT}.`,
      },
    },
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
          reports: ctx.devLead.reports(agent, { limit }).map(reportValue),
          watched: watchedIds(ctx.devLead.view(agent)),
        }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_report',
    description: REPORT_DESCRIPTION,
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'Plain-text report: what happened, what it affects, and the next step or decision needed '
          + `(max ${DEVLEAD_REPORT_MESSAGE_MAX} Unicode code points).`,
      },
      kind: {
        type: 'string',
        enum: [...DEVLEAD_REPORT_KINDS],
        default: 'progress',
        description: 'Why this report is being sent; defaults to progress. Use question for a decision or missing '
          + 'information the lead must answer; then end your turn and wait for the lead\'s new turn.',
      },
      summary: {
        type: 'string',
        description: `Optional short title for the lead's digest row (max ${DEVLEAD_REPORT_SUMMARY_MAX} Unicode code points).`,
      },
    },
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
        return {
          report: reportValue(receipt.report),
          durable: receipt.durable,
          queued: receipt.queued,
          ...(receipt.warning === undefined ? {} : { warning: receipt.warning }),
        }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isSupervised(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_remove_workspace',
    description: REMOVE_WORKSPACE_DESCRIPTION,
    parameters: {
      workspace: {
        type: 'string',
        required: true,
        description: `The Workspace to close (remove). ${WORKSPACE_ARGUMENT_DESCRIPTION}`,
      },
    },
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
    parameters: {
      session: {
        type: 'string',
        required: true,
        description: SESSION_ARGUMENT_DESCRIPTION,
      },
      stop_running: {
        type: 'boolean',
        default: false,
        description: 'Defaults to false. Set true only when you mean to cancel that Session\'s running work: '
          + 'the Session is archived first and the Host is then asked to stop its running turn, subagents, jobs, and '
          + 'schedules, without waiting for them to settle. The safety boundaries are on the tool description.',
      },
    },
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
    parameters: {
      session: {
        type: 'string',
        required: true,
        description: SESSION_ARGUMENT_DESCRIPTION,
      },
    },
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
