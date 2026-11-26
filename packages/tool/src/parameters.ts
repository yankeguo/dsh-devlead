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
  DEVLEAD_ASSISTANT_EXCERPT_MAX,
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

/** Default latest-assistant detail budget in Unicode code points. */
export const DEFAULT_LAST_ASSISTANT_LIMIT = DEVLEAD_ASSISTANT_EXCERPT_MAX

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
  devlead_board_read: {
    project: {
      type: 'string',
      description: 'Optional project reference: exact id, exact workspace title, or exact absolute workspace path. '
        + 'Omit it for a bounded listing of project summaries.',
    },
    include_tasks: {
      type: 'boolean',
      description: 'Include task rows. Defaults to true for a single selected project and false for the all-project listing.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum project rows in an unfiltered listing, capped at 50. The result marks truncation.',
    },
  },
  devlead_board_update: {
    project: {
      type: 'string',
      required: true,
      description: 'Existing project id/title/workspace path. With create:true this is the new project id. '
        + 'This never addresses the board file itself.',
    },
    expected_revision: {
      type: 'integer',
      description: 'Optional non-negative CAS revision of this project (not the board file). The update fails with '
        + 'BOARD_REVISION_CONFLICT only when the selected project advanced since devlead_board_read.',
    },
    create: {
      type: 'boolean',
      default: false,
      description: 'Set true to create a missing project; creation requires set.workspace.path. Defaults to false.',
    },
    set: {
      type: 'object',
      additionalProperties: false,
      description: 'Scalar project fields to change; empty goal/focus/next strings clear them.',
      properties: {
        status: { type: 'string', enum: ['active', 'blocked', 'paused', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        goal: { type: 'string' },
        focus: { type: 'string' },
        next: { type: 'string' },
        workspace: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Absolute workspace directory; required when creating a project.' },
            title: { type: 'string', description: 'Display title; creation defaults to the workspace directory basename.' },
          },
        },
      },
    },
    blockers: {
      type: 'object',
      additionalProperties: false,
      description: 'Blocker changes, applied in clear, remove, add order.',
      properties: {
        clear: { type: 'boolean', default: false },
        remove: { type: 'array', items: { type: 'string' }, description: 'Blocker ids to remove.' },
        add: {
          type: 'array',
          description: 'Blockers to add or replace by id; since is preserved on replacement.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              text: { type: 'string', required: true },
              session_id: { type: 'string', description: 'Optional Session associated with the blocker.' },
            },
          },
        },
      },
    },
    tasks: {
      type: 'object',
      additionalProperties: false,
      description: 'Task changes, applied in remove then upsert order.',
      properties: {
        remove: { type: 'array', items: { type: 'string' }, description: 'Task ids to remove.' },
        upsert: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              title: { type: 'string', description: 'Required when the upsert creates a new task.' },
              status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'], description: 'Defaults to todo for a new task.' },
              owner_session_id: { type: 'string', description: 'Optional owning Session id.' },
            },
          },
        },
      },
    },
  },
  devlead_board_note_read: {
    project: {
      type: 'string',
      required: true,
      description: 'Board project reference: exact id, exact workspace title, or exact absolute workspace path. '
        + 'Title ambiguity uses the same BOARD_PROJECT_AMBIGUOUS error as the board tools.',
    },
    note: {
      type: 'string',
      description: 'Optional note id from a prior create/read result. Omit to list metadata; provide it for one '
        + 'metadata row. Markdown bodies are never returned; use native read on absolutePath. This is an id, never a path.',
    },
  },
  devlead_board_note_write: {
    project: {
      type: 'string',
      required: true,
      description: 'Existing board project id/title/workspace path. Notes cannot be created for a project absent '
        + 'from the board. This never addresses the notes index or a Markdown file.',
    },
    operation: {
      type: 'string',
      required: true,
      enum: ['create', 'update-metadata', 'delete'],
      description: 'create makes an index entry and empty body; update-metadata changes only title/summary; delete '
        + 'removes the index entry and body when possible. All body reads/edits use DSH-native tools on absolutePath.',
    },
    note: {
      type: 'string',
      description: 'Note id. Required for update-metadata/delete. Optional for create: omit it to have the Host '
        + 'generate a UUID. Supplied ids must be filename-safe; do not pass paths or traversal segments.',
    },
    title: {
      type: 'string',
      description: 'Non-empty display title, required for create and optionally replaced by update-metadata. Not '
        + 'accepted for delete. Maximum 200 UTF-16 code units.',
    },
    summary: {
      type: 'string',
      description: 'Optional short metadata summary for create/update-metadata; defaults to empty on create and '
        + 'remains unchanged when omitted on update-metadata. Maximum 500 UTF-16 code units. Not accepted for delete.',
    },
    expected_revision: {
      type: 'integer',
      description: 'Optional non-negative notes-index compare-and-swap revision from devlead_board_note_read. '
        + 'A stale value fails with BOARD_REVISION_CONFLICT before any mutation.',
    },
  },
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
      description: 'Optional model provider route for the new Session; requires model. Omit to use workspaceModels/defaultModel, '
        + 'then the Host default. Call '
        + 'devlead_list_models first when pinning; validated before the Session is created. Creation-time only.',
    },
    model: {
      type: 'string',
      description: 'Optional model id for the new Session; requires provider. Omit for configured routing, then the Host default. Use it '
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
    last_assistant_limit: {
      type: 'integer',
      default: DEVLEAD_ASSISTANT_EXCERPT_MAX,
      description: `Latest-assistant excerpt budget in Unicode code points (default ${DEVLEAD_ASSISTANT_EXCERPT_MAX}); the result reports truncation.`,
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
    archived: {
      type: 'boolean',
      default: true,
      description: 'True archives (default); false restores this Session. archived:false forbids stop_running.',
    },
    stop_running: {
      type: 'boolean',
      default: false,
      description: 'Archive first, then ask the Host to stop running work without awaiting settlement; true only for intentional cancellation.',
    },
  },
} as const satisfies Record<string, ParameterSchemaSpec>