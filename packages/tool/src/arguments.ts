/**
 * Argument validation and request assembly for the `devlead_*` tools.
 *
 * `defineTool` already enforces the JSON-Schema-expressible constraints (types,
 * required keys, booleans, integers). What remains here is the hand-checked
 * part the DSL cannot express: non-blank text, absolute paths, safe positive
 * limits, and the default values the tool table promises.
 *
 * @module @yankeguo/dsh-tool-devlead/arguments
 */

import { isAbsolute } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  DevLeadArchiveSessionsRequest,
  DevLeadCreateSessionRequest,
  DevLeadInterruptInboxPolicy,
  DevLeadIsolationMode,
  DevLeadModelSelection,
  DevLeadPromptIntent,
} from '@yankeguo/dsh-devlead-protocol'
import { DEVLEAD_PROMPT_INTENTS } from '@yankeguo/dsh-devlead-protocol'
import { TOOL_PARAMETERS } from './parameters.ts'

/**
 * Model input rejected before the core service is called.
 *
 * Carries the core's invalid-input code so {@link translateToolError} can map
 * it to a structured `HarnessError` without depending on the core class.
 */
export class DevLeadToolInputError extends Error {
  /** Stable code from the core service's error vocabulary. */
  readonly code = 'DEVLEAD_INVALID_INPUT'

  /**
   * @param message - human-readable description of the violated constraint.
   */
  constructor(message: string) {
    super(message)
    this.name = 'DevLeadToolInputError'
  }
}

/**
 * Exact declared parameter names of every tool, in schema order.
 *
 * Derived from the same {@link TOOL_PARAMETERS} objects that `defineTool`
 * receives, so adding or renaming a parameter cannot leave the undeclared-key
 * guard behind. The mapping keeps each tool's literal key names for callers
 * that index it by a known tool name.
 */
type ToolArgumentKeys = {
  readonly [K in keyof typeof TOOL_PARAMETERS]: readonly (keyof (typeof TOOL_PARAMETERS)[K] & string)[]
}

// `Object.keys` forgets the literal property names; the mapped type restores
// them so a misspelled `TOOL_ARGUMENT_KEYS.devlead_*` access still fails `tsc`.
export const TOOL_ARGUMENT_KEYS = Object.fromEntries(
  Object.entries(TOOL_PARAMETERS).map(([name, parameters]) => [name, Object.keys(parameters)]),
) as unknown as ToolArgumentKeys

/**
 * Reject argument keys the tool schema does not declare.
 *
 * The parameter DSL compiles to `{ type, properties, required }` without
 * `additionalProperties: false`, so model arguments may silently carry a
 * misspelled or camelCase key that the handler then ignores. Rejecting those
 * keys before the core call keeps a typo from becoming a real side effect (a
 * blank Session, an archive without its stop request, a cleared inbox) while
 * leaving every declared argument unchanged.
 * @param args - parsed model arguments.
 * @param allowedKeys - exact parameter names the tool declares, in schema order.
 * @throws {@link DevLeadToolInputError} when one or more keys are undeclared.
 */
export function assertKnownArguments(args: object, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(args).filter(key => !allowed.has(key))
  if (unknown.length === 0) return
  const names = unknown.map(key => `"${key}"`).join(', ')
  throw new DevLeadToolInputError(
    `unknown argument${unknown.length === 1 ? '' : 's'} ${names}; accepted arguments: `
    + `${allowedKeys.length === 0 ? '(none)' : allowedKeys.join(', ')}`,
  )
}

/** Arguments of `devlead_board_read`. */
export interface BoardReadArgs {
  readonly project?: string
  readonly include_tasks?: boolean
  readonly limit?: number
}

/** Arguments of `devlead_board_update`. */
export interface BoardUpdateArgs {
  readonly project: string
  readonly expected_revision?: number
  readonly create?: boolean
  readonly commit?: boolean
  readonly set?: {
    readonly status?: 'active' | 'blocked' | 'paused' | 'done'
    readonly priority?: 'low' | 'medium' | 'high'
    readonly goal?: string
    readonly focus?: string
    readonly next?: string
    readonly workspace?: { readonly path?: string; readonly title?: string }
  }
  readonly blockers?: {
    readonly clear?: boolean
    readonly remove?: readonly string[]
    readonly add?: readonly { readonly id: string; readonly text: string; readonly session_id?: string }[]
  }
  readonly tasks?: {
    readonly remove?: readonly string[]
    readonly upsert?: readonly {
      readonly id: string
      readonly title?: string
      readonly status?: 'todo' | 'doing' | 'blocked' | 'done'
      readonly owner_session_id?: string
    }[]
  }
}

/** Arguments of `devlead_board_note_read`. */
export interface BoardNoteReadArgs {
  readonly project: string
  readonly note?: string
}

/** Arguments of `devlead_board_note_write`. */
export interface BoardNoteWriteArgs {
  readonly project: string
  readonly operation: 'create' | 'update-metadata' | 'delete'
  readonly note?: string
  readonly title?: string
  readonly summary?: string
  readonly expected_revision?: number
}

/** Arguments of `devlead_use_workspace`. */
export interface UseWorkspaceArgs {
  readonly path: string
  readonly title?: string
  readonly create?: boolean
}

/** Arguments of `devlead_list_sessions`. */
export interface ListSessionsArgs {
  readonly workspace?: string
  readonly watched_only?: boolean
  readonly limit?: number
}

/** Arguments of `devlead_create_session`. */
export interface CreateSessionArgs {
  readonly workspace?: string
  readonly prompt?: string
  readonly title?: string
  readonly watch?: boolean
  readonly preset?: string
  /**
   * Requested checkout isolation. Kept as a raw string here: the tool schema's
   * enum is the model-facing contract, and {@link optionalIsolationMode}
   * hand-checks the same vocabulary before forwarding.
   */
  readonly isolation?: string
  /** Optional model provider route; requires `model`. */
  readonly provider?: string
  /** Optional model id; requires `provider`. */
  readonly model?: string
  /** Optional adapter reasoning effort; requires the provider/model pair. */
  readonly reasoning_effort?: string
  /** Optional Agent Teams mode: true enables, false disables, omitted leaves untouched. */
  readonly agent_teams?: boolean
}

/** Arguments of `devlead_get_session`. */
export interface GetSessionArgs {
  readonly session: string
  readonly last_assistant_limit?: number
}

/** Arguments of `devlead_prompt_session`. */
export interface PromptSessionArgs {
  readonly session: string
  readonly prompt: string
  /**
   * Requested semantic intent. Kept as a raw string here: the tool schema's
   * enum is the model-facing contract, and {@link optionalPromptIntent}
   * hand-checks the same vocabulary.
   */
  readonly intent?: string
  readonly question_id?: string
  readonly idempotency_key?: string
  readonly watch?: boolean
  readonly interrupt?: boolean
  /**
   * Requested interrupt inbox policy. Kept as a raw string here: the tool
   * schema's enum is the model-facing contract, and
   * {@link optionalInterruptInbox} hand-checks the same vocabulary.
   */
  readonly interrupt_inbox?: string
}

/** Arguments of `devlead_report`. */
export interface ReportArgs {
  readonly message: string
  readonly kind?: string
  readonly summary?: string
}

/** Arguments of `devlead_watch_session`. */
export interface WatchSessionArgs {
  readonly session: string
  readonly watching: boolean
}

/** Arguments of `devlead_retract_input`. */
export interface RetractInputArgs {
  readonly session: string
  readonly input_id: string
}

/** Arguments of `devlead_notifications`. */
export interface NotificationsArgs {
  readonly limit?: number
}

/** Arguments of `devlead_remove_workspace`. */
export interface RemoveWorkspaceArgs {
  readonly workspace: string
}

/** Arguments of the folded `devlead_archive_session` mutation. */
export interface ArchiveSessionArgs {
  readonly session?: string
  readonly sessions?: readonly string[]
  readonly workspace?: string
  readonly settled_only?: boolean
  readonly archived?: boolean
  readonly stop_running?: boolean
}

/**
 * Recover the exact caller guaranteed by conditional tool discovery. A
 * registered DevLead tool is only visible to a step whose Agent enabled the
 * mode, so a missing Agent is an invariant violation, not model input. It is
 * still reported through the structured error surface so the executor can
 * route on a stable code instead of an unstructured crash.
 * @param agent - Agent carried by the run context.
 * @param tool - tool name used in the failure text.
 * @returns the live caller Agent.
 * @throws {@link HarnessError} `DEVLEAD_AGENT_NOT_LIVE` when the Step carried no Agent.
 */
export function requireAgent(agent: Agent | undefined, tool: string): Agent {
  if (agent === undefined) {
    throw new HarnessError(`${tool} requires a calling Agent`, 'DEVLEAD_AGENT_NOT_LIVE')
  }
  return agent
}

/**
 * Validate one Session reference. The core service resolves an exact id, a
 * unique id prefix, or the uuid prefix with the `session-` prefix omitted; the
 * tool only rejects a blank value early.
 * @param value - model-supplied Session reference.
 * @returns the trimmed reference.
 * @throws {@link DevLeadToolInputError} when the reference is blank.
 */
export function requireSessionRef(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new DevLeadToolInputError('session must not be empty')
  return trimmed
}

/**
 * Validate one queued-input identity. The core matches it against the Host
 * message ids of the pending inbox; the tool only rejects a blank value early.
 * @param value - model-supplied message id.
 * @returns the trimmed identity.
 * @throws {@link DevLeadToolInputError} when the identity is blank.
 */
export function requireInputId(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new DevLeadToolInputError('input_id must not be empty')
  return trimmed
}

/**
 * Validate one prompt. The text is passed through as supplied so the core
 * service owns normalization, but a value that is blank after trimming is
 * rejected before any Session work starts.
 * @param value - model-supplied prompt text.
 * @returns the prompt text.
 * @throws {@link DevLeadToolInputError} when the prompt is blank.
 */
export function requirePrompt(value: string): string {
  if (value.trim().length === 0) throw new DevLeadToolInputError('prompt must not be empty')
  return value
}

/**
 * Trim an optional free-form label and treat a blank value as omitted.
 * @param value - optional display text.
 * @returns the trimmed text, or undefined when absent or blank.
 */
export function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Validate one required board project reference without treating it as a file path. */
export function requireProjectRef(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new DevLeadToolInputError('project must not be empty')
  return trimmed
}

/** Validate an optional project filter; an explicitly blank filter is rejected. */
export function optionalProjectRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return requireProjectRef(value)
}

/** Validate an optional note id; the Host applies the filename-safe id grammar. */
export function optionalNoteRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new DevLeadToolInputError('note must not be empty when provided')
  return trimmed
}

/**
 * Validate a required Workspace reference. A blank reference is a mistake the
 * model should see rather than a silent default, and it is rejected before the
 * core service resolves anything.
 * @param value - model-supplied Workspace id, registered path, or exact title.
 * @returns the trimmed reference.
 * @throws {@link DevLeadToolInputError} when the reference is blank.
 */
export function requireWorkspaceRef(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new DevLeadToolInputError('workspace must not be empty')
  return trimmed
}

/**
 * Validate an optional Workspace reference; unlike a title, a blank reference is
 * a mistake the model should see rather than a silent default.
 * @param value - optional Workspace id, registered path, or exact title.
 * @returns the trimmed reference, or undefined when omitted.
 * @throws {@link DevLeadToolInputError} when a blank reference was supplied.
 */
export function optionalWorkspaceRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new DevLeadToolInputError('workspace must not be empty when provided')
  return trimmed
}

/**
 * Validate an optional checkout-isolation mode.
 *
 * The tool schema already restricts the model-facing enum; this hand-check keeps
 * direct callers of {@link createSessionRequest} on the same vocabulary and gives
 * them the core's stable invalid-input code instead of a loosely typed request.
 * @param value - optional isolation mode supplied by the caller.
 * @returns the validated mode, or undefined when omitted.
 * @throws {@link DevLeadToolInputError} when the value is not `none` or `worktree`.
 */
export function optionalIsolationMode(value: string | undefined): DevLeadIsolationMode | undefined {
  if (value === undefined) return undefined
  if (value === 'none' || value === 'worktree') return value
  throw new DevLeadToolInputError(`isolation must be "none" or "worktree", received "${value}"`)
}

/**
 * Validate an optional interrupt inbox policy.
 *
 * The tool schema already restricts the model-facing enum; this hand-check
 * keeps direct callers on the same vocabulary and gives them the core's stable
 * invalid-input code instead of a loosely typed request.
 * @param value - optional policy supplied by the caller.
 * @returns the validated policy, or undefined when omitted.
 * @throws {@link DevLeadToolInputError} when the value is not a known policy.
 */
export function optionalInterruptInbox(value: string | undefined): DevLeadInterruptInboxPolicy | undefined {
  if (value === undefined) return undefined
  if (value === 'clear-all' || value === 'keep' || value === 'clear-own') return value
  throw new DevLeadToolInputError(`interrupt_inbox must be "clear-all", "keep", or "clear-own", received "${value}"`)
}

/**
 * Validate an optional prompt intent.
 *
 * The tool schema already restricts the model-facing enum; this hand-check
 * keeps direct callers on the same vocabulary and gives them the core's stable
 * invalid-input code instead of a loosely typed request.
 * @param value - optional intent supplied by the caller.
 * @returns the validated intent, or undefined when omitted (the core defaults to instruction).
 * @throws {@link DevLeadToolInputError} when the value is not a known intent.
 */
export function optionalPromptIntent(value: string | undefined): DevLeadPromptIntent | undefined {
  if (value === undefined) return undefined
  if (DEVLEAD_PROMPT_INTENTS.includes(value as DevLeadPromptIntent)) return value as DevLeadPromptIntent
  throw new DevLeadToolInputError(
    `intent must be "instruction", "answer", "correction", or "background", received "${value}"`,
  )
}

/**
 * Validate the absolute directory a Workspace registration addresses.
 * @param value - model-supplied directory path.
 * @returns the trimmed absolute path.
 * @throws {@link DevLeadToolInputError} when the path is blank or relative.
 */
export function requireAbsolutePath(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new DevLeadToolInputError('path must not be empty')
  if (!isAbsolute(trimmed)) {
    throw new DevLeadToolInputError(`path must be absolute, received "${value}"`)
  }
  return trimmed
}

/**
 * Validate an optional positive result limit.
 * @param value - model-supplied limit.
 * @param field - argument name used in the failure text.
 * @returns the limit, or undefined when omitted.
 * @throws {@link DevLeadToolInputError} when the limit is not a positive safe integer.
 */
export function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DevLeadToolInputError(`${field} must be a positive integer`)
  }
  return value
}

/** Validate an optional non-negative safe integer (notably board CAS revisions). */
export function optionalNonNegativeInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DevLeadToolInputError(`${field} must be a non-negative integer`)
  }
  return value
}

/**
 * Apply the deployment-independent default of one optional limit.
 * @param value - model-supplied limit.
 * @param field - argument name used in the failure text.
 * @param fallback - default applied when the model omitted the argument.
 * @returns the validated limit or the fallback.
 */
export function defaultedLimit(value: number | undefined, field: string, fallback: number): number {
  return optionalPositiveInteger(value, field) ?? fallback
}

/**
 * Assemble one model selection from the flat snake_case tool arguments.
 *
 * The provider/model pair and the effort rule are validated here as well as in
 * the core service, so a malformed request fails before any Host work starts.
 * @param args - validated model arguments.
 * @returns the model selection, or undefined when no model was requested.
 * @throws {@link DevLeadToolInputError} for a partial pair or an effort alone.
 */
export function modelSelectionRequest(args: CreateSessionArgs): DevLeadModelSelection | undefined {
  const provider = optionalText(args.provider)
  const model = optionalText(args.model)
  const reasoningEffort = optionalText(args.reasoning_effort)
  if (provider === undefined && model === undefined) {
    if (reasoningEffort !== undefined) {
      throw new DevLeadToolInputError('reasoning_effort requires provider and model')
    }
    return undefined
  }
  if (provider === undefined || model === undefined) {
    throw new DevLeadToolInputError('provider and model must be provided together')
  }
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/**
 * Assemble the core request of `devlead_create_session`.
 * @param args - validated model arguments.
 * @returns the request handed to `ctx.devLead.createSession`.
 * @throws {@link DevLeadToolInputError} on blank prompt, title, preset, or workspace text, an
 *   unknown isolation mode, or an unusable model selection.
 */
export function createSessionRequest(args: CreateSessionArgs): DevLeadCreateSessionRequest {
  const workspace = optionalWorkspaceRef(args.workspace)
  const prompt = args.prompt === undefined ? undefined : requirePrompt(args.prompt)
  const title = optionalText(args.title)
  const preset = optionalText(args.preset)
  const isolation = optionalIsolationMode(args.isolation)
  const model = modelSelectionRequest(args)
  return {
    ...workspace === undefined ? {} : { workspace },
    ...prompt === undefined ? {} : { prompt },
    ...title === undefined ? {} : { title },
    ...preset === undefined ? {} : { preset },
    ...isolation === undefined ? {} : { isolation },
    ...model === undefined ? {} : { model },
    ...args.agent_teams === undefined ? {} : { agentTeams: args.agent_teams },
    watch: args.watch ?? true,
  }
}

/** Validate and assemble the folded archive/unarchive batch request. */
export function archiveSessionRequest(args: ArchiveSessionArgs): DevLeadArchiveSessionsRequest {
  const archived = args.archived ?? true
  const stopRunning = args.stop_running ?? false
  const targetForms = Number(args.session !== undefined)
    + Number(args.sessions !== undefined) + Number(args.workspace !== undefined)
  if (targetForms !== 1) {
    throw new DevLeadToolInputError('provide exactly one of session, sessions, or workspace with settled_only:true')
  }
  if (args.workspace !== undefined && args.settled_only !== true) {
    throw new DevLeadToolInputError('workspace cleanup requires settled_only:true')
  }
  if (args.settled_only !== undefined && (args.workspace === undefined || args.settled_only !== true)) {
    throw new DevLeadToolInputError('settled_only:true is only valid with workspace cleanup')
  }
  if (!archived && (args.workspace !== undefined || args.settled_only !== undefined || stopRunning)) {
    throw new DevLeadToolInputError(
      'archived:false accepts only explicit session/sessions targets and no stop_running/workspace cleanup',
    )
  }
  if (args.session !== undefined) {
    return { session: requireSessionRef(args.session), archived, stopRunning }
  }
  if (args.sessions !== undefined) {
    if (!Array.isArray(args.sessions) || args.sessions.some(value => typeof value !== 'string')) {
      throw new DevLeadToolInputError('sessions must be an array of Session reference strings')
    }
    const sessions = [...new Set(args.sessions.map(requireSessionRef))]
    return { sessions, archived, stopRunning }
  }
  return {
    workspace: optionalWorkspaceRef(args.workspace) as string,
    settledOnly: true,
    archived: true,
    stopRunning,
  }
}
