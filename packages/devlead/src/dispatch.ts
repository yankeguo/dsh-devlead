/**
 * Optional dispatch-time capabilities: Session model selection and Agent Teams.
 *
 * A dispatched Session may be pinned to a model and switched into Agent Teams
 * mode. Both are creation-time settings applied through the created Agent
 * itself (`Agent.model.select` and `ctx.agentTeams.setEnabled`), never through
 * the Session controller's `selectModel` (which also rewrites the profile
 * default model). Neither capability is a hard dependency: this module declares
 * only the structural slices DevLead calls, detects them through the Cordis
 * context at call time, and degrades to a stable domain error when a requested
 * capability is absent.
 *
 * The model selection is normalized here (provider/model pairing and trimming)
 * so the core, the tool layer, and tests share one rule set.
 *
 * @module @yankeguo/dsh-devlead/dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DevLeadModelSelection } from '@yankeguo/dsh-devlead-protocol'
import { DevLeadError } from './error.ts'

/** One trimmed, paired model selection ready for validation and application. */
export interface NormalizedModelSelection {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Explicit adapter reasoning effort, when requested. */
  readonly reasoningEffort?: string
}

/**
 * Structural view of the LLM registry slice used to validate a selection.
 * The real service resolves the exact provider/model capability and rejects an
 * unsupported route or reasoning effort before any dispatch.
 */
export interface ModelValidatorCapability {
  /**
   * List the currently registered provider routes.
   * @returns provider descriptors with their route ids.
   */
  listProviders(): readonly { readonly id: string }[]

  /**
   * List the models one provider currently advertises.
   * @param provider - registered provider route.
   * @returns model descriptors with their ids.
   */
  listModels(provider: string): Promise<readonly { readonly id: string }[]>

  /**
   * Validate one conversation call config against its exact model capability.
   * @param config - provider/model route and optional reasoning effort.
   * @param signal - optional cancellation for adapter-owned lookup.
   * @returns a detached resolved config (its value is not used here).
   */
  resolveCallConfig(config: NormalizedModelSelection, signal?: AbortSignal): Promise<unknown>
}

/**
 * Structural view of the optional Agent Teams service.
 *
 * The real service requires the exact live root Agent and appends a durable
 * `team/mode` event when the selection changes.
 */
export interface AgentTeamsCapability {
  /**
   * Read the Team selection shared by the caller's subagent tree.
   * @param agent - exact live root or descendant.
   * @returns whether Team mode is enabled.
   */
  isEnabled(agent: Agent): boolean

  /**
   * Save one root Session's Team selection.
   * @param agent - exact live root whose tree receives the selection.
   * @param enabled - selected Team mode.
   * @param signal - cancellation checked before changing the selection.
   * @returns fulfillment after the selection flushes.
   */
  setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>
}

/**
 * Render one selection for a model-facing failure message.
 * @param selection - normalized selection.
 * @returns text such as `deepseek-official/deepseek-chat (reasoning effort "high")`.
 */
export function modelSelectionLabel(selection: NormalizedModelSelection): string {
  const base = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort === undefined ? base : `${base} (reasoning effort "${selection.reasoningEffort}")`
}

/**
 * Normalize one requested model selection.
 *
 * `provider` and `model` must be supplied together; a reasoning effort is only
 * meaningful with the pair. A request that names none of them resolves to
 * `undefined` (the Host default model stays untouched).
 * @param value - protocol selection supplied by a caller, when any.
 * @returns the trimmed selection, or undefined when nothing was requested.
 * @throws {@link DevLeadError} `DEVLEAD_INVALID_INPUT` for a partial pair or an
 *   effort without a pair.
 */
export function normalizeModelSelection(value: DevLeadModelSelection | undefined): NormalizedModelSelection | undefined {
  if (value === undefined) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  if (provider.length === 0 && model.length === 0) {
    if (effort.length > 0) {
      throw new DevLeadError(
        'reasoningEffort requires an explicit provider and model; the Host default model has no dispatch-time effort override',
        'DEVLEAD_INVALID_INPUT',
      )
    }
    return undefined
  }
  if (provider.length === 0 || model.length === 0) {
    throw new DevLeadError(
      'provider and model must be provided together',
      'DEVLEAD_INVALID_INPUT',
    )
  }
  return {
    provider,
    model,
    ...(effort.length === 0 ? {} : { reasoningEffort: effort }),
  }
}

/**
 * Detect one context's optional LLM registry slice.
 *
 * Read through the untyped Cordis accessor so the DevLead core keeps no hard
 * dependency on the LLM service being injected; the value is trusted only when
 * it exposes a callable `resolveCallConfig`.
 * @param ctx - context whose optional service is consulted.
 * @returns the structurally narrowed validator, or undefined when absent.
 */
export function modelValidatorOf(ctx: Context): ModelValidatorCapability | undefined {
  const candidate: unknown = ctx.get('llm')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const listProviders = (candidate as { listProviders?: unknown }).listProviders
  const listModels = (candidate as { listModels?: unknown }).listModels
  const resolve = (candidate as { resolveCallConfig?: unknown }).resolveCallConfig
  if (typeof listProviders !== 'function' || typeof listModels !== 'function' || typeof resolve !== 'function') {
    return undefined
  }
  return candidate as ModelValidatorCapability
}

/**
 * Detect one context's optional Agent Teams service.
 *
 * The service is not a dependency of this package (the default web composition
 * includes it, other compositions may not). Detection is structural so a Host
 * that composes no Team service fails a `agentTeams: true` request with
 * `DEVLEAD_TEAM_UNAVAILABLE` instead of loading differently.
 * @param ctx - context whose optional service is consulted.
 * @returns the structurally narrowed capability, or undefined when absent.
 */
export function agentTeamsCapabilityOf(ctx: Context): AgentTeamsCapability | undefined {
  const candidate: unknown = ctx.get('agentTeams')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const isEnabled = (candidate as { isEnabled?: unknown }).isEnabled
  const setEnabled = (candidate as { setEnabled?: unknown }).setEnabled
  if (typeof isEnabled !== 'function' || typeof setEnabled !== 'function') return undefined
  return candidate as AgentTeamsCapability
}
