/**
 * Pure result helpers for the `/devlead` command face shared by both surfaces.
 *
 * A command admission has two failure layers:
 * - the Remote call itself can fail (`ok: false`, e.g. a carrier or Host error);
 * - the Host command can settle with a *logical* failure (`ok: true` but the
 *   embedded `CommandExecution.result.kind === 'error'`, e.g. the Session has
 *   no live Agent for `on` or the command grammar is invalid).
 *
 * There is also a third, quieter outcome: a settled Remote call with no value
 * means the Host resolved no command for the line (`/devlead` unknown or
 * shadowed, a stale Client after a Host restart). The surfaces report that too
 * instead of silently doing nothing.
 *
 * These helpers stay free of React and platform-module imports so they are
 * unit-testable; the types are structural copies of the generated Remote face,
 * keeping the client bundle's type-only imports erased.
 */

import type { DevLeadKey } from './locales.ts'

/** Structural view of one settled Host command execution. */
export interface DevLeadCommandExecution {
  /** Host command outcome the human surface renders. */
  readonly result: {
    readonly kind: 'success' | 'error'
    readonly text?: string
  }
}

/**
 * Structural view of one `/devlead` command admission. Assignable from the
 * generated `RemoteResult<CommandExecution | undefined>` without a cast.
 */
export type DevLeadCommandAdmission =
  | { readonly ok: true; readonly value: DevLeadCommandExecution | undefined }
  | { readonly ok: false; readonly error: { readonly message: string; readonly code: string } }

/** One inline command failure the surfaces must report. */
export type DevLeadCommandFailure =
  /** The admission never reached the Host, or the Host failed it outright. */
  | { readonly kind: 'transport'; readonly message: string; readonly code: string }
  /** The Host executed the command and the command itself rejected the input. */
  | { readonly kind: 'rejected'; readonly message: string }
  /** The command face threw instead of settling (an assembly fault, not a command outcome). */
  | { readonly kind: 'unexpected'; readonly message: string }
  /** The Host settled the RPC without resolving a command for the line. */
  | { readonly kind: 'unresolved'; readonly line: string }

/** Dictionary key of one rendered command failure. */
export type DevLeadCommandFailureKey = Extract<
  DevLeadKey,
  'error.command' | 'error.rejected' | 'error.unknown' | 'error.unresolved'
>

/** One inline error line: dictionary key plus interpolation parameters. */
export interface DevLeadCommandFailureCopy {
  /** Dictionary key the strip renders. */
  readonly key: DevLeadCommandFailureKey
  /** Template parameters interpolated by the locale runtime. */
  readonly params: Readonly<Record<string, string>>
}

/** Human text used when the Host rejects a command without a reason. */
const REJECTED_FALLBACK = 'command rejected'

/** Human text used when a transport failure carries no message. */
const TRANSPORT_FALLBACK = 'command failed'

/** Message used when the command face throws a non-Error value. */
const UNEXPECTED_FALLBACK = 'unknown error'

/** One-line explanation used by tooltip-only surfaces for an unresolved line. */
const UNRESOLVED_TEXT = 'the Host did not recognize the command line'

/**
 * Trimmed text of one optional message, or undefined when it is absent or
 * blank. Failure text crosses the Remote boundary, so a blank value must not
 * render an empty error line.
 * @param value - optional message text.
 * @returns the trimmed message, when there is one.
 */
function presentMessage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Classify the failure of one settled admission that carried a command
 * execution. A settled admission with no execution is classified by
 * {@link admitCommand}, which owns the submitted line.
 * @param result - settled admission result.
 * @returns the failure to render, or undefined when the command succeeded or never ran.
 */
export function commandFailure(result: DevLeadCommandAdmission): DevLeadCommandFailure | undefined {
  if (!result.ok) {
    return {
      kind: 'transport',
      message: presentMessage(result.error.message) ?? TRANSPORT_FALLBACK,
      code: result.error.code,
    }
  }
  const outcome = result.value?.result
  if (outcome === undefined || outcome.kind !== 'error') return undefined
  return { kind: 'rejected', message: presentMessage(outcome.text) ?? REJECTED_FALLBACK }
}

/**
 * Wrap a thrown command-face error as a renderable failure.
 * @param error - caught value; an Error contributes its message.
 * @returns the failure to render.
 */
export function unexpectedFailure(error: unknown): DevLeadCommandFailure {
  const message = error instanceof Error ? presentMessage(error.message) : undefined
  return { kind: 'unexpected', message: message ?? UNEXPECTED_FALLBACK }
}

/**
 * Admit one `/devlead` command and classify its failure without throwing.
 * @param executeCommand - injected command face bound to the Session.
 * @param line - full command line, leading slash included.
 * @returns the classified failure, or undefined when the command succeeded.
 */
export async function admitCommand(
  executeCommand: (line: string) => Promise<DevLeadCommandAdmission>,
  line: string,
): Promise<DevLeadCommandFailure | undefined> {
  try {
    const result = await executeCommand(line)
    // A settled call with no value means the line resolved to no command
    // (unknown or shadowed name, silent Host mismatch). Reporting it keeps a
    // dead entry point from looking like a successful toggle.
    if (result.ok && result.value === undefined) return { kind: 'unresolved', line }
    return commandFailure(result)
  } catch (error: unknown) {
    return unexpectedFailure(error)
  }
}

/**
 * One-line human text of a classified failure, for surfaces that report
 * through a tooltip instead of an inline row (the compact off-state toggle has
 * no inline error seat).
 * @param failure - classified command failure.
 * @returns the failure text.
 */
export function failureMessage(failure: DevLeadCommandFailure): string {
  return failure.kind === 'unresolved' ? UNRESOLVED_TEXT : failure.message
}

/**
 * Project one failure onto the localized inline error line.
 * @param failure - classified command failure.
 * @returns the dictionary key and template parameters the strip renders.
 */
export function failureCopy(failure: DevLeadCommandFailure): DevLeadCommandFailureCopy {
  switch (failure.kind) {
    case 'transport':
      return { key: 'error.command', params: { message: failure.message, code: failure.code } }
    case 'rejected':
      return { key: 'error.rejected', params: { message: failure.message } }
    case 'unexpected':
      return { key: 'error.unknown', params: { message: failure.message } }
    case 'unresolved':
      return { key: 'error.unresolved', params: { line: failure.line } }
  }
}

/** One shared re-entrancy gate for a surface with a single command control. */
export interface DevLeadAdmissionGate {
  /**
   * Claim the in-flight slot.
   * @returns true when the caller claimed it, false while a command is already in flight.
   */
  tryEnter(): boolean
  /** Release the in-flight slot; idempotent. */
  leave(): void
}

/**
 * Create the same-render re-entrancy gate shared by both surfaces.
 *
 * React state disables the control on the next render; the gate closes the
 * same-render window so a rapid double click cannot admit two commands.
 * @returns a fresh closed gate.
 */
export function createDevLeadAdmissionGate(): DevLeadAdmissionGate {
  let entered = false
  return {
    tryEnter: () => {
      if (entered) return false
      entered = true
      return true
    },
    leave: () => {
      entered = false
    },
  }
}

/** State machine of one command attempt rendered by a surface. */
export interface DevLeadAdmissionState {
  /** Whether the command is in flight; the control is disabled while true. */
  readonly pending: boolean
  /** Failure of the last settled attempt, or null while none is shown. */
  readonly failure: DevLeadCommandFailure | null
}

/** Initial, idle admission state shared by every surface instance. */
export const DEVLEAD_ADMISSION_IDLE: DevLeadAdmissionState = { pending: false, failure: null }

/** Transition of one command attempt. */
export type DevLeadAdmissionAction =
  /** A new command was admitted: enter the in-flight state and clear the previous failure. */
  | { readonly type: 'begin' }
  /** The admitted command settled; `failure` is null on success. */
  | { readonly type: 'settle'; readonly failure: DevLeadCommandFailure | null }
  /** The mode changed from another source: retire the previous attempt's failure. */
  | { readonly type: 'reset' }

/**
 * Pure transition of one surface's admission state.
 *
 * `reset` keeps an in-flight attempt untouched: only the settled failure is
 * stale after a mode change, and the pending flag still gates the control.
 * @param state - current admission state.
 * @param action - transition to apply.
 * @returns the next state, or the same reference when nothing changes.
 */
export function devLeadAdmissionReducer(
  state: DevLeadAdmissionState,
  action: DevLeadAdmissionAction,
): DevLeadAdmissionState {
  switch (action.type) {
    case 'begin':
      return state.pending && state.failure === null ? state : { pending: true, failure: null }
    case 'settle':
      return state.pending || state.failure !== action.failure
        ? { pending: false, failure: action.failure }
        : state
    case 'reset':
      return state.failure === null ? state : { pending: state.pending, failure: null }
  }
}
