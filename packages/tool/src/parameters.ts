/**
 * Model-facing parameter schemas of the `devlead_*` tools.
 *
 * The registry in `index.ts` forwards these objects to `defineTool`, and
 * {@link TOOL_ARGUMENT_KEYS} in `arguments.ts` derives the undeclared-key guard
 * from the same objects. Keeping the schemas here makes the parameter schema
 * and its guard one source instead of two hand-maintained lists.
 *
 * @module @yankeguo/dsh-tool-devlead/parameters
 */

import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  DEVLEAD_REPORT_KINDS,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_SUMMARY_MAX,
} from '@yankeguo/dsh-devlead-protocol'

/**
 * Model-facing description of every `session` argument. Resolution tolerates a
 * truncated uuid head: the id may omit the leading `session-` prefix.
 */
export const SESSION_ARGUMENT_DESCRIPTION =
  'Session id: the full id, a unique id prefix, or the uuid prefix without the "session-" prefix (for example '
  + 'e59ab350); it resolves only when unique.'

/**
 * Model-facing description shared by every `workspace` argument. All three
 * tools resolve the reference the same way, so the wording lives in one place.
 */
export const WORKSPACE_ARGUMENT_DESCRIPTION =
  'Address the Workspace by id, registered directory path, or exact display title. Resolution tries the id first, '
  + 'then the registered path, then the title (trimmed, case-sensitive). A title shared by several Workspaces fails '
  + 'with DEVLEAD_WORKSPACE_AMBIGUOUS listing their ids and paths; use the id or path then.'

/** Default size of the notification digest `devlead_notifications` reads. */
export const DEFAULT_NOTIFICATIONS_LIMIT = 20

/**
 * Exact parameter schema of every tool, keyed by registered tool name.
 *
 * `defineTool` receives these objects unchanged, so a parameter added here is
 * visible to the model and accepted by the undeclared-key guard at once.
 */
export const TOOL_PARAMETERS = {
  devlead_list_workspaces: {},
  devlead_list_models: {},
  devlead_list_agent_presets: {},
  devlead_use_workspace: {
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
  devlead_list_sessions: {
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
  devlead_create_session: {
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
  devlead_get_session: {
    session: {
      type: 'string',
      required: true,
      description: SESSION_ARGUMENT_DESCRIPTION,
    },
  },
  devlead_prompt_session: {
    session: {
      type: 'string',
      required: true,
      description: SESSION_ARGUMENT_DESCRIPTION,
    },
    prompt: {
      type: 'string',
      required: true,
      description: 'The message admitted as a user message attributed to this DevLead Session: an instruction, '
        + 'an answer to a question, a correction, or background context (see intent).',
    },
    intent: {
      type: 'string',
      enum: ['instruction', 'answer', 'correction', 'background'],
      default: 'instruction',
      description: 'Semantic intent; defaults to "instruction" (a new next-turn boundary queued behind the '
        + 'Session\'s current turn). "answer" replies to a question report and requires question_id; it steers '
        + 'the child\'s next step (opening a turn if idle). "correction" changes the current approach and also '
        + 'steers the next step. "background" injects non-urgent context without requesting a wake (queued for '
        + 'the next step; a cold Session rejects it). steer is next-step priority, not preemption: the current '
        + 'model request/tool batch still finishes, and an idle answer may share a request with an older '
        + 'next-turn input — it is not isolation. Use interrupt:true to replace the current work instead.',
    },
    question_id: {
      type: 'string',
      description: 'Required for intent "answer": the question report id from the [DEV LEAD QUESTION] wake or '
        + 'devlead_notifications. Only valid with intent "answer". An open question accepts a new answer; an '
        + 'already-answered question accepts only a retry with the SAME answer text (returns the original '
        + 'receipt); a different text fails with DEVLEAD_QUESTION_ALREADY_ANSWERED even under the same '
        + 'idempotency_key. An unknown/expired/cancelled question fails with DEVLEAD_QUESTION_NOT_FOUND — '
        + 'continue with a normal instruction then.',
    },
    idempotency_key: {
      type: 'string',
      description: 'Optional key (max 200 code points) making a retry safe: resending the same key with the same '
        + 'prompt text returns the original admission receipt without a second delivery; a different text under '
        + 'the same key is rejected. For answers the same text is required regardless of the key (a matching key '
        + 'with the same text is a key replay); the key is mainly for instruction/correction/background retries.',
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
        + 'discards queued inbox input per interrupt_inbox, then admits this prompt as a new turn (overriding '
        + 'answer/correction steering). Illegal with intent "background". An idle or cold Session is a no-op '
        + 'and receives the prompt normally. The interrupted turn still produces its normal watched-turn '
        + 'notification as cancelled.',
    },
    interrupt_inbox: {
      type: 'string',
      enum: ['clear-all', 'keep', 'clear-own'],
      default: 'clear-all',
      description: 'Inbox policy applied when interrupt stops a running turn; defaults to "clear-all" (the stop '
        + 'discards every pending input, the historical behavior). "keep" restores every pending message after '
        + 'the stop; "clear-own" restores everything except the instruction/correction relay prompts and '
        + 'background notices this lead Session authored, so human and other producers\' queued inputs survive. '
        + 'Pending answer messages are always kept by "clear-own" (removing one would desynchronize the question '
        + 'state); "clear-all" discards them and reopens their questions. Restored messages keep their id and '
        + 'queue order ahead of the replacement prompt. Ignored without interrupt:true and for an idle or cold '
        + 'target. The result reports retainedInputs when a retention policy ran.',
    },
  },
  devlead_retract_input: {
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
  devlead_watch_session: {
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
  devlead_notifications: {
    limit: {
      type: 'integer',
      default: DEFAULT_NOTIFICATIONS_LIMIT,
      description: 'Maximum number of rows to return from each digest: notifications and reports are limited '
        + `separately, newest rows kept. Defaults to ${DEFAULT_NOTIFICATIONS_LIMIT}.`,
    },
  },
  devlead_report: {
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
  devlead_remove_workspace: {
    workspace: {
      type: 'string',
      required: true,
      description: `The Workspace to close (remove). ${WORKSPACE_ARGUMENT_DESCRIPTION}`,
    },
  },
  devlead_archive_session: {
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
  devlead_unarchive_session: {
    session: {
      type: 'string',
      required: true,
      description: SESSION_ARGUMENT_DESCRIPTION,
    },
  },
} as const satisfies Record<string, ParameterSchemaSpec>