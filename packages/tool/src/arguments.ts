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
import type { DevLeadCreateSessionRequest } from '@yankeguo/dsh-devlead-protocol'

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
}

/** Arguments of `devlead_get_session`. */
export interface GetSessionArgs {
  readonly session: string
}

/** Arguments of `devlead_prompt_session`. */
export interface PromptSessionArgs {
  readonly session: string
  readonly prompt: string
  readonly watch?: boolean
}

/** Arguments of `devlead_watch_session`. */
export interface WatchSessionArgs {
  readonly session: string
  readonly watching: boolean
}

/** Arguments of `devlead_notifications`. */
export interface NotificationsArgs {
  readonly limit?: number
}

/**
 * Recover the exact caller guaranteed by conditional tool discovery. A
 * registered DevLead tool is only visible to a step whose Agent enabled the
 * mode, so a missing Agent is an invariant violation, not model input.
 * @param agent - Agent carried by the run context.
 * @param tool - tool name used in the failure text.
 * @returns the live caller Agent.
 */
export function requireAgent(agent: Agent | undefined, tool: string): Agent {
  if (agent === undefined) throw new Error(`${tool} requires a calling Agent`)
  return agent
}

/**
 * Validate one Session reference. The core service resolves an exact id or a
 * unique id prefix; the tool only rejects a blank value early.
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
 * Validate one prompt. The text is passed through unchanged so intentional
 * formatting survives, but a blank prompt is rejected.
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

/**
 * Validate an optional Workspace reference; unlike a title, a blank reference is
 * a mistake the model should see rather than a silent default.
 * @param value - optional Workspace id or path.
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
 * Assemble the core request of `devlead_create_session`.
 * @param args - validated model arguments.
 * @returns the request handed to `ctx.devLead.createSession`.
 * @throws {@link DevLeadToolInputError} on blank prompt, title, preset, or workspace text.
 */
export function createSessionRequest(args: CreateSessionArgs): DevLeadCreateSessionRequest {
  const workspace = optionalWorkspaceRef(args.workspace)
  const prompt = args.prompt === undefined ? undefined : requirePrompt(args.prompt)
  const title = optionalText(args.title)
  const preset = optionalText(args.preset)
  return {
    ...workspace === undefined ? {} : { workspace },
    ...prompt === undefined ? {} : { prompt },
    ...title === undefined ? {} : { title },
    ...preset === undefined ? {} : { preset },
    watch: args.watch ?? true,
  }
}
