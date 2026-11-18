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
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@yankeguo/dsh-devlead'
import {
  createSessionRequest,
  defaultedLimit,
  optionalPositiveInteger,
  optionalText,
  optionalWorkspaceRef,
  requireAbsolutePath,
  requireAgent,
  requirePrompt,
  requireSessionRef,
  requireWorkspaceRef,
} from './arguments.ts'
import { runTool } from './errors.ts'
import { devLeadPolicy } from './policy.ts'
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
  presentRemoveWorkspaceCall,
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
  REMOVE_WORKSPACE_OUTPUT,
  UNARCHIVE_SESSION_OUTPUT,
  USE_WORKSPACE_OUTPUT,
  WATCH_SESSION_OUTPUT,
  agentPresetCatalogValue,
  archivedSessionValue,
  createdSessionValue,
  modelCatalogValue,
  notificationValue,
  promptedSessionValue,
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

/**
 * Model-facing description of every `session` argument. Resolution tolerates a
 * truncated uuid head: the id may omit the leading `session-` prefix.
 */
const SESSION_ARGUMENT_DESCRIPTION =
  'Session id: the full id, a unique id prefix, or the uuid prefix without the "session-" prefix (for example '
  + 'e59ab350); it resolves only when unique.'

const LIST_MODELS_DESCRIPTION =
  'List the model routes this Host can dispatch to: the Host default selection, routable providers, each provider\'s '
  + 'models with their reasoning efforts and default effort, and any provider whose catalog could not be loaded. Call '
  + 'this before pinning provider/model/reasoning_effort on devlead_create_session. Most dispatches should omit the '
  + 'model parameters and inherit the Host default; only pin a model when the human explicitly asked, or the brief '
  + 'needs cost/capability routing or reproducibility.'

const LIST_AGENT_PRESETS_DESCRIPTION =
  'List the Agent preset roster this Host currently defines for Session creation. Each entry carries the id accepted by '
  + 'devlead_create_session preset, its published name/description when available, a default marker (the Host effective '
  + 'default: selectedDefault when configured, otherwise its base default), and a broken reason when the preset cannot '
  + 'compose a Session. Call this before setting preset and never assume a fixed list; standard and ptc are examples on '
  + 'some Hosts, not a complete vocabulary. An unknown or unusable preset fails creation with a structured error rather '
  + 'than being silently ignored. If the Host composes no roster, the result reports available false with a reason; '
  + 'omitting preset then falls back to the plugin defaultAgentPreset, then the Host default.'

const LIST_WORKSPACES_DESCRIPTION =
  'List every registered DSH Workspace: its title, canonical directory path, live directory status, and the Sessions '
  + 'the registry accounts to it. Use it first to decide which Workspace owns a request, before registering a new '
  + 'Workspace or dispatching a Session.'

const USE_WORKSPACE_DESCRIPTION =
  'Register a repository directory as a DSH Workspace so Sessions can be created in it. The path must be absolute, and '
  + 'an already-registered path is reused with its existing title. A missing directory is an error by default: set '
  + 'create to true only when the human explicitly asked to create that directory.'

const LIST_SESSIONS_DESCRIPTION =
  'List DSH Sessions this DevLead Session can address: whether each is live, running, watched, or archived, plus '
  + 'latest-turn facts when the Host knows them. Watched and running rows come first. Optionally restrict to one '
  + 'Workspace or to the watched set; use devlead_get_session for a log detail with the latest turn outcome and '
  + 'assistant excerpt. Inspect it after a wake-up or when the human explicitly asks, not as a polling loop while '
  + 'waiting for a dispatched Session.'

const CREATE_SESSION_DESCRIPTION =
  'Create an ordinary DSH Session in a Workspace and optionally start it with a prompt. The child inherits the Host '
  + 'default model unless you explicitly pin provider/model (plus optional reasoning_effort); pin only when the human '
  + 'explicitly asked, or the brief needs cost/capability routing or reproducibility, and call devlead_list_models '
  + 'first so provider/model/effort are real. Agent Teams is your judgment: complex, multi-step, or parallel work that '
  + 'benefits from subagent collaboration may set agent_teams true; simple linear work should omit it; obey an explicit '
  + 'human on/off. Agent Teams requires DSH 0.2.2-rc.2 or newer with the Agent Teams service composed; when the Host '
  + 'reports it unavailable, continue without Team mode instead of retrying or blocking. Never change the Host/profile '
  + 'default, and do not upgrade or downgrade a model on your own. Both '
  + 'settings are creation-time only; the model is validated before the Session is created. Use devlead_list_agent_presets '
  + 'before pinning a preset: omitted or blank follows the plugin defaultAgentPreset, then the Host default/selectedDefault, '
  + 'and an unknown or unusable preset fails creation with a structured error rather than being silently ignored. The Session '
  + 'is a real Session the human can open and take over, not a subagent. It runs independently, so after this call end the '
  + 'turn instead '
  + 'of waiting: never sleep, never poll devlead_get_session, devlead_list_sessions, or devlead_notifications, and '
  + 'never call wait_agent to wait for it. A watched Session is the default, and its settled turn starts a new turn '
  + 'of this lead session with the wake-up message. Use it to dispatch the owning Workspace\'s work to that Session '
  + 'instead of doing the work yourself from this lead session; the brief may carry open questions, because the '
  + 'Session owns the deeper investigation and the implementation.'

const GET_SESSION_DESCRIPTION =
  'Read one Session in detail: whether it is live and running, whether it is archived, and, when the Host can read '
  + 'the Session log, the latest turn number and outcome plus the latest error and assistant excerpts. Address it by '
  + 'full id, a unique id prefix, or the uuid prefix without the "session-" prefix. Use it to inspect state after a '
  + 'wake-up or when the human explicitly asks, not to poll while waiting for a dispatched Session.'

const PROMPT_SESSION_DESCRIPTION =
  'Admit a follow-up prompt into an existing Session, resuming a cold Session first. The prompt is attributed to this '
  + 'DevLead Session. Archived Sessions are rejected. The Session is watched by default, so after this call end the '
  + 'turn instead of waiting: its settled turn starts a new turn of this lead session with the wake-up message.'

const WATCH_SESSION_DESCRIPTION =
  'Add one Session to, or remove it from, this DevLead Session\'s watch set. Only watched Sessions produce wake-up '
  + 'notifications, so unwatch work that no longer needs attention. A Session cannot watch itself.'

const NOTIFICATIONS_DESCRIPTION =
  'Read the retained notification digest of this DevLead Session together with the current watch set. Each entry names '
  + 'a watched Session whose turn settled and how it ended. The digest is newest last. Read it after a wake-up or when '
  + 'the human explicitly asks, not as a polling loop while waiting for a dispatched Session.'

const REMOVE_WORKSPACE_DESCRIPTION =
  'Close (remove) a DSH Workspace registration: the DSH remove action, not a deletion. The directory, its files, and '
  + 'every Session log stay untouched, but the Workspace\'s Sessions become ungrouped: they stay openable and '
  + 'continuable, yet no longer appear under that Workspace, and re-registering the same directory creates a brand new '
  + 'Workspace that does not adopt them. Address it by Workspace id or registered path. Use your judgment to remove '
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
  + 'true only when you mean to cancel that work: the flag archives the Session first and then asks the Host to stop '
  + 'it through the same providers the human\'s own stop action uses, without waiting for it to settle. This lead '
  + 'Session cannot archive itself: ask the human to close it from the sidebar. Report what you archived and why.'

const UNARCHIVE_SESSION_DESCRIPTION =
  'Restore (unarchive) one archived DSH Session, returning it to its recorded Workspace position. Unarchiving is '
  + 'idempotent, and the Session log was kept while it was archived. Use it to reverse an archive you made while '
  + 'wrapping up, or when the human asks to restore a Session; report the restored Session.'

/**
 * Register the thirteen DevLead tools and their shared policy section.
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

  ctx.tools.register(defineTool({
    name: 'devlead_list_workspaces',
    description: LIST_WORKSPACES_DESCRIPTION,
    parameters: {},
    output: LIST_WORKSPACES_OUTPUT,
    presentCall: presentListWorkspacesCall,
    execute(_args, exec) {
      return runTool(async () => ({
        workspaces: (await ctx.devLead.listWorkspaces(exec.signal)).map(workspaceValue),
      }))
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_list_models',
    description: LIST_MODELS_DESCRIPTION,
    parameters: {},
    output: LIST_MODELS_OUTPUT,
    presentCall: presentListModelsCall,
    execute(_args, exec) {
      return runTool(async () => {
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
    execute(_args, exec) {
      return runTool(async () => {
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
        description: 'Optional display title for a newly registered Workspace; an already-registered path keeps its current title.',
      },
      create: {
        type: 'boolean',
        description: 'Defaults to false. Set true only when the human asked to create the directory.',
      },
    },
    output: USE_WORKSPACE_OUTPUT,
    presentCall: presentUseWorkspaceCall,
    execute(args, exec) {
      return runTool(async () => {
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
        description: 'Optional Workspace id or registered path to restrict the listing to.',
      },
      watched_only: {
        type: 'boolean',
        description: 'Only list Sessions in this lead\'s watch set.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of Session rows to return; the Host may return fewer when its listing cap is lower.',
      },
    },
    output: LIST_SESSIONS_OUTPUT,
    presentCall: presentListSessionsCall,
    execute(args, exec) {
      return runTool(async () => {
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
        description: 'Workspace id or registered path of the owning Workspace; omit only when the work truly belongs '
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
        description: 'Watch the new Session and receive its turn notifications. Defaults to true.',
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
        description: 'Agent Teams for the new Session: true for complex, multi-step, or parallel work that benefits from '
          + 'subagent collaboration, false to disable, omit for simple linear work (Host default). Obey an explicit '
          + 'human on/off. Creation-time only. true requires DSH 0.2.2-rc.2 or newer with the Agent Teams service '
          + 'composed; otherwise it fails with DEVLEAD_TEAM_UNAVAILABLE—omit it and continue without Team mode.',
      },
    },
    output: CREATE_SESSION_OUTPUT,
    presentCall: presentCreateSessionCall,
    execute(args, exec) {
      return runTool(async () => {
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
    execute(args, exec) {
      return runTool(async () => {
        const agent = requireAgent(exec.agent, 'devlead_get_session')
        const session = await ctx.devLead.getSession(agent, requireSessionRef(args.session), exec.signal)
        return { session: sessionValue(session) }
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
        description: 'Watch the Session after prompting. Defaults to true.',
      },
    },
    output: PROMPT_SESSION_OUTPUT,
    presentCall: presentPromptSessionCall,
    execute(args, exec) {
      return runTool(async () => {
        const agent = requireAgent(exec.agent, 'devlead_prompt_session')
        const prompted = await ctx.devLead.promptSession(
          agent,
          requireSessionRef(args.session),
          requirePrompt(args.prompt),
          { watch: args.watch ?? true, signal: exec.signal },
        )
        return promptedSessionValue(prompted)
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
        description: `Maximum number of retained notifications to return. Defaults to ${DEFAULT_NOTIFICATIONS_LIMIT}.`,
      },
    },
    output: NOTIFICATIONS_OUTPUT,
    presentCall: presentNotificationsCall,
    execute(args, exec) {
      return runTool(async () => {
        const agent = requireAgent(exec.agent, 'devlead_notifications')
        const limit = defaultedLimit(args.limit, 'limit', DEFAULT_NOTIFICATIONS_LIMIT)
        return {
          notifications: ctx.devLead.notifications(agent, { limit }).map(notificationValue),
          watched: watchedIds(ctx.devLead.view(agent)),
        }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_remove_workspace',
    description: REMOVE_WORKSPACE_DESCRIPTION,
    parameters: {
      workspace: {
        type: 'string',
        required: true,
        description: 'Workspace id or registered canonical path of the Workspace to close (remove).',
      },
    },
    output: REMOVE_WORKSPACE_OUTPUT,
    presentCall: presentRemoveWorkspaceCall,
    execute(args, exec) {
      return runTool(async () => {
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
        description: 'Defaults to false. Set true only when the human asked to close a Session with running work: '
          + 'the Session is archived first and the Host is then asked to stop its running turn, subagents, jobs, and '
          + 'schedules, without waiting for them to settle.',
      },
    },
    output: ARCHIVE_SESSION_OUTPUT,
    presentCall: presentArchiveSessionCall,
    execute(args, exec) {
      return runTool(async () => {
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
