/**
 * Stable failure vocabulary of the DevLead core service. Tool and command
 * plugins translate these codes into their own surfaces; the model tool
 * package maps them to `HarnessError`, the command package to friendly text.
 *
 * @module @yankeguo/dsh-devlead
 */

/** Every stable code the core service throws. */
export type DevLeadErrorCode =
  | 'DEVLEAD_INVALID_INPUT'
  | 'DEVLEAD_NOT_ENABLED'
  | 'DEVLEAD_AGENT_NOT_LIVE'
  | 'DEVLEAD_WORKSPACE_NOT_FOUND'
  | 'DEVLEAD_DIRECTORY_MISSING'
  | 'DEVLEAD_SESSION_NOT_FOUND'
  | 'DEVLEAD_SESSION_ARCHIVED'
  | 'DEVLEAD_SESSION_UNAVAILABLE'
  | 'DEVLEAD_WATCH_LIMIT'
  | 'DEVLEAD_SELF_WATCH'
  | 'DEVLEAD_PROJECTION_INVALID'

/**
 * One domain failure with a stable machine-readable code.
 *
 * The class is intentionally structural (`code` plus an `Error`): a deployment
 * that loads this package twice still recognizes the failure through its code.
 */
export class DevLeadError extends Error {
  /**
   * @param message - human-readable failure text.
   * @param code - stable code from {@link DevLeadErrorCode}.
   */
  constructor(message: string, readonly code: DevLeadErrorCode) {
    super(message)
    this.name = 'DevLeadError'
  }
}

/**
 * Whether a thrown value is a DevLead domain failure, checked by code so a
 * duplicated module instance still maps.
 * @param error - thrown value.
 * @returns whether {@link error} carries a `DEVLEAD_` code.
 */
export function isDevLeadError(error: unknown): error is DevLeadError {
  if (error instanceof DevLeadError) return true
  if (!(error instanceof Error)) return false
  const candidate = error as unknown as { code?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('DEVLEAD_')
}

/**
 * Extract the human message of any thrown value. Structured DSH failures
 * (`LlmFailure`, typed remote failures) are plain records rather than `Error`
 * instances, so `String(error)` would render `[object Object]`; their own
 * `message` field is preferred, and the value is stringified only as a last
 * resort.
 * @param error - thrown value.
 * @returns the message text.
 */
export function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
