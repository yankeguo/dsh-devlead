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
} from './arguments.ts'
import { runTool } from './errors.ts'
import { devLeadPolicy } from './policy.ts'
import {
  presentCreateSessionCall,
  presentGetSessionCall,
  presentListSessionsCall,
  presentListWorkspacesCall,
  presentNotificationsCall,
  presentPromptSessionCall,
  presentUseWorkspaceCall,
  presentWatchSessionCall,
} from './presentation.ts'
import {
  CREATE_SESSION_OUTPUT,
  GET_SESSION_OUTPUT,
  LIST_SESSIONS_OUTPUT,
  LIST_WORKSPACES_OUTPUT,
  NOTIFICATIONS_OUTPUT,
  PROMPT_SESSION_OUTPUT,
  USE_WORKSPACE_OUTPUT,
  WATCH_SESSION_OUTPUT,
  createdSessionValue,
  notificationValue,
  promptedSessionValue,
  sessionValue,
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

const LIST_WORKSPACES_DESCRIPTION =
  'List every registered DSH Workspace: its title, canonical directory path, live directory status, and the Sessions '
  + 'the registry accounts to it. Use it first to decide which Workspace owns a request, before registering a new '
  + 'Workspace or dispatching a Session.'

const USE_WORKSPACE_DESCRIPTION =
  'Register a repository directory as a DSH Workspace so Sessions can be created in it. The path must be absolute; an '
  + 'already-registered path is reused with its existing title, and when the directory is missing it is created first '
  + 'unless create is false.'

const LIST_SESSIONS_DESCRIPTION =
  'List DSH Sessions this DevLead Session can address: whether each is live, running, watched, or archived, plus '
  + 'latest-turn facts when the Host knows them. Watched and running rows come first. Optionally restrict to one '
  + 'Workspace or to the watched set; use devlead_get_session for a log detail with the latest turn outcome and '
  + 'assistant excerpt.'

const CREATE_SESSION_DESCRIPTION =
  'Create an ordinary DSH Session in a Workspace and optionally start it with a prompt. The Session is a real Session '
  + 'the human can open and take over, not a subagent. It is watched by default, so this lead is notified when its '
  + 'turns settle. Use it to dispatch the owning Workspace\'s work to that Session instead of doing the work yourself '
  + 'from this lead session.'

const GET_SESSION_DESCRIPTION =
  'Read one Session in detail: whether it is live and running, whether it is archived, and, when the Host can read '
  + 'the Session log, the latest turn number and outcome plus the latest error and assistant excerpts. Address it by '
  + 'full id or unique id prefix.'

const PROMPT_SESSION_DESCRIPTION =
  'Admit a follow-up prompt into an existing Session, resuming a cold Session first. The prompt is attributed to this '
  + 'DevLead Session. Archived Sessions are rejected. The Session is watched by default.'

const WATCH_SESSION_DESCRIPTION =
  'Add one Session to, or remove it from, this DevLead Session\'s watch set. Only watched Sessions produce wake-up '
  + 'notifications, so unwatch work that no longer needs attention. A Session cannot watch itself.'

const NOTIFICATIONS_DESCRIPTION =
  'Read the retained notification digest of this DevLead Session together with the current watch set. Each entry names '
  + 'a watched Session whose turn settled and how it ended. The digest is newest last.'

/**
 * Register the eight DevLead tools and their shared policy section.
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
        description: 'Create the directory when it is missing. Defaults to true.',
      },
    },
    output: USE_WORKSPACE_OUTPUT,
    presentCall: presentUseWorkspaceCall,
    execute(args, exec) {
      return runTool(async () => {
        requireAgent(exec.agent, 'devlead_use_workspace')
        const path = requireAbsolutePath(args.path)
        const title = optionalText(args.title)
        const workspace = await ctx.devLead.useWorkspace(path, {
          create: args.create ?? true,
          signal: exec.signal,
          ...title === undefined ? {} : { title },
        })
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
        description: 'Optional self-contained prompt the new Session starts with. The child cannot see this conversation.',
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
        description: 'Optional Agent preset id for the new Session.',
      },
      isolation: {
        type: 'string',
        enum: ['none', 'worktree'],
        description: 'Optional checkout isolation for the new Session; defaults to "none". "worktree" asks for a '
          + 'best-effort isolated Git checkout of the owning Workspace for the new Session. It is applied only when '
          + 'the Host composes the experimental Git worktree service, and a non-active outcome (unavailable or '
          + 'failed) is returned in the isolation field of the result, never as an error.',
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
        description: 'Session id, or a unique Session id prefix.',
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
        description: 'Session id, or a unique Session id prefix.',
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
        description: 'Session id, or a unique Session id prefix.',
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
}
