/**
 * Optional Agent preset roster capability for dispatch-time preset selection.
 *
 * The DSH Agent preset registry is not a hard dependency of this package: a
 * Host may compose it or not, and the service lives in a package this plugin
 * does not install. This module declares only the structural slice DevLead
 * reads, detects it through the Cordis context at call time, and normalizes the
 * Host rows onto the stable protocol vocabulary. No preset is ever invented.
 *
 * @module @yankeguo/dsh-devlead/presets
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DevLeadAgentPresetView } from '@yankeguo/dsh-devlead-protocol'

/** One Host Agent preset row, structurally narrowed for roster reads. */
export interface AgentPresetRosterRow {
  /** Stable preset identity. */
  readonly id: string
  /** Published display name, when the Host supplies one. */
  readonly name?: string
  /** Published purpose text, when the Host supplies one. */
  readonly description?: string
  /** Activation failure detail, when this preset cannot compose a Session. */
  readonly broken?: string
}

/** Optional Agent preset roster service slice DevLead reads. */
export interface AgentPresetRosterCapability {
  /** Effective default preset id (selected default when configured, otherwise the base default). */
  readonly defaultId: string
  /**
   * List every declared preset, including activation failures.
   * @returns Host roster rows in roster order.
   */
  list(): Promise<readonly AgentPresetRosterRow[]>
}

/**
 * Treat one unknown value as a record for defensive roster normalization.
 * @param value - candidate value.
 * @returns the value when it is a non-array object, otherwise undefined.
 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read one string field, or an empty string when absent.
 * @param value - candidate value.
 * @returns the string, or ''.
 */
function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Detect the optional Agent preset roster service.
 *
 * Read through the untyped Cordis accessor so the core keeps no dependency on
 * the preset registry package. A malformed service is treated as absent rather
 * than as a roster with invented entries.
 * @param ctx - context whose optional roster service is consulted.
 * @returns the structurally narrowed roster, or undefined when absent.
 */
export function agentPresetRosterCapabilityOf(ctx: Context): AgentPresetRosterCapability | undefined {
  const candidate: unknown = ctx.get('agentPresets')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const defaultId = (candidate as { defaultId?: unknown }).defaultId
  const list = (candidate as { list?: unknown }).list
  if (typeof defaultId !== 'string' || typeof list !== 'function') return undefined
  return candidate as AgentPresetRosterCapability
}

/**
 * Map Host roster rows onto the stable protocol view.
 *
 * Rows without a usable id are dropped, optional blank display fields are
 * omitted, and the default marker is derived from the Host's effective
 * `defaultId`. The Host's row order is preserved.
 * @param rows - rows returned by the roster service.
 * @param defaultId - Host effective default preset id.
 * @returns normalized preset rows.
 */
export function devLeadAgentPresetsOf(
  rows: readonly unknown[],
  defaultId: string,
): DevLeadAgentPresetView[] {
  const presets: DevLeadAgentPresetView[] = []
  for (const row of rows) {
    const record = recordOf(row)
    if (record === undefined) continue
    const id = stringField(record.id).trim()
    if (id.length === 0) continue
    const name = stringField(record.name).trim()
    const description = stringField(record.description).trim()
    const broken = stringField(record.broken).trim()
    presets.push({
      id,
      default: id === defaultId,
      ...(name.length === 0 ? {} : { name }),
      ...(description.length === 0 ? {} : { description }),
      ...(broken.length === 0 ? {} : { broken }),
    })
  }
  return presets
}
