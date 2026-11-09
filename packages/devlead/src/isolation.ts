/**
 * Optional Git-worktree isolation capability.
 *
 * Checkout isolation is best effort: a Host either composes the experimental
 * DSH Git worktree service or it does not, and DevLead must work in both cases.
 * This module therefore declares only the small structural slice of that
 * service DevLead calls, and detects it at call time through the Cordis
 * context. Nothing here imports the experimental package — not even for types —
 * so the DevLead package keeps zero build- and runtime dependency on it.
 *
 * @module @yankeguo/dsh-devlead/isolation
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One checkout the optional Git worktree capability reports after creation. */
export interface WorktreeCheckout {
  /** Canonical checkout path. */
  readonly path: string
  /** Branch created for the checkout. */
  readonly branch: string
  /** Commit the branch was pinned to. */
  readonly baseCommit: string
}

/**
 * Narrow one optional capability result to the checkout facts DevLead reports.
 *
 * The capability is experimental and structurally detected, so a future
 * version can change or truncate its result. A malformed result must degrade
 * to a reported `failed` isolation, never become a `worktree` outcome with
 * untrustworthy path/branch fields (and never crash the renderer/projection).
 * @param value - value resolved by the optional capability.
 * @returns a detached checkout, or undefined when any reported fact is missing
 *   or not a non-empty string.
 */
export function worktreeCheckoutOf(value: unknown): WorktreeCheckout | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const path = record.path
  const branch = record.branch
  const baseCommit = record.baseCommit
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (typeof branch !== 'string' || branch.length === 0) return undefined
  if (typeof baseCommit !== 'string' || baseCommit.length === 0) return undefined
  return { path, branch, baseCommit }
}

/**
 * Structural view of the optional experimental Git worktree service.
 *
 * The real service takes the calling Agent, whose current directory selects
 * the source repository and whose sandbox policy confines the Git commands,
 * creates a branch and checkout, and enters the checkout (`ctx.workingDirectory`
 * changes; the Session's header cwd does not).
 */
export interface WorktreeCapability {
  /**
   * Create one worktree owned by an Agent and enter its checkout.
   * @param agent - owner Agent whose directory selects the source repository.
   * @param request - optional name and revision; an empty request uses the
   *   service-generated name and `HEAD`.
   * @param signal - cancellation of lookup, creation, and directory publication.
   * @returns the created checkout.
   */
  create(agent: Agent, request?: object, signal?: AbortSignal): Promise<WorktreeCheckout>
}

/**
 * Detect one context's optional Git worktree capability.
 *
 * The service name is read from the Cordis context at every call (DevLead does
 * not declare it as an injected dependency), then narrowed structurally, so:
 * - a Host that never composes the experimental package reports no capability;
 * - a Host that composes it later starts reporting one without a DevLead
 *   reload, and one disposed again stops reporting it;
 * - a foreign object registered under the same name is only trusted when it
 *   exposes a callable `create`.
 * @param ctx - context whose optional service is consulted.
 * @returns the structurally narrowed capability, or undefined when absent or
 *   unusable.
 */
export function worktreeCapabilityOf(ctx: Context): WorktreeCapability | undefined {
  // Cordis' untyped `get` overload serves service names outside the typed
  // Context surface; a missing service resolves to undefined.
  const candidate: unknown = ctx.get('worktrees')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const create = (candidate as { create?: unknown }).create
  if (typeof create !== 'function') return undefined
  return candidate as WorktreeCapability
}
