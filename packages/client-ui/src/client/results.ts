/**
 * Pure result helpers for the `/devlead` command face of the dock.
 *
 * A command admission has two failure layers:
 * - the Remote call itself can fail (`ok: false`, e.g. a carrier or Host error);
 * - the Host command can settle with a *logical* failure (`ok: true` but the
 *   embedded `CommandExecution.result.kind === 'error'`, e.g. the Session has
 *   no live Agent for `on` or the command grammar is invalid).
 *
 * The dock must surface both instead of silently dropping the second one.
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

/** One inline command failure the dock must surface. */
export type DevLeadCommandFailure =
  /** The admission never reached the Host, or the Host failed it outright. */
  | { readonly kind: 'transport'; readonly message: string; readonly code: string }
  /** The Host executed the command and the command itself rejected the input. */
  | { readonly kind: 'rejected'; readonly message: string }
  /** The command face threw instead of settling (an assembly fault, not a command outcome). */
  | { readonly kind: 'unexpected'; readonly message: string }

/** Dictionary key of one rendered command failure. */
export type DevLeadCommandFailureKey = Extract<DevLeadKey, 'error.command' | 'error.rejected' | 'error.unknown'>

/** One inline error line: dictionary key plus interpolation parameters. */
export interface DevLeadCommandFailureCopy {
  /** Dictionary key the strip renders. */
  readonly key: DevLeadCommandFailureKey
  /** Template parameters interpolated by the locale runtime. */
  readonly params: Readonly<Record<string, string>>
}

/** Human text used when the Host rejects a command without a reason. */
const REJECTED_FALLBACK = 'command rejected'

/** Message used when the command face throws a non-Error value. */
const UNEXPECTED_FALLBACK = 'unknown error'

/**
 * Classify the failure of one settled admission.
 * @param result - settled admission result.
 * @returns the failure to render, or undefined when the command succeeded or never ran.
 */
export function commandFailure(result: DevLeadCommandAdmission): DevLeadCommandFailure | undefined {
  if (!result.ok) {
    return { kind: 'transport', message: result.error.message, code: result.error.code }
  }
  const outcome = result.value?.result
  if (outcome === undefined || outcome.kind !== 'error') return undefined
  return { kind: 'rejected', message: outcome.text ?? REJECTED_FALLBACK }
}

/**
 * Wrap a thrown command-face error as a renderable failure.
 * @param error - caught value; an Error contributes its message.
 * @returns the failure to render.
 */
export function unexpectedFailure(error: unknown): DevLeadCommandFailure {
  return { kind: 'unexpected', message: error instanceof Error ? error.message : UNEXPECTED_FALLBACK }
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
    return commandFailure(await executeCommand(line))
  } catch (error: unknown) {
    return unexpectedFailure(error)
  }
}

/**
 * One-line human text of a classified failure, for surfaces that report through
 * a toast instead of an inline row (the model menu closes on selection).
 * @param failure - classified command failure.
 * @returns the Host failure text.
 */
export function failureMessage(failure: DevLeadCommandFailure): string {
  return failure.message
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
  }
}
