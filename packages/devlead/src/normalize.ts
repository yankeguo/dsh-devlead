/**
 * Defensive normalization of unknown optional-capability payloads.
 *
 * The optional Host services (model catalog, Agent preset roster) are read
 * through untyped accessors, so every field is narrowed here before it becomes
 * a protocol view. One shared vocabulary keeps the catalog and roster paths
 * from drifting apart.
 *
 * @module @yankeguo/dsh-devlead/normalize
 */

/**
 * Read one string field from an unknown record, or an empty string.
 * @param value - candidate value.
 * @returns the string, or '' when absent.
 */
export function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Treat one unknown value as a record for defensive normalization.
 * @param value - candidate value.
 * @returns the value when it is a non-array object, otherwise undefined.
 */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read the array items of one unknown field, dropping non-array values.
 * @param value - candidate value.
 * @returns an array of unknown items, or an empty array.
 */
export function itemsOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}