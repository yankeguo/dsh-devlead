/**
 * Pure grammar of the human-facing `/devlead` command. Kept free of Cordis and
 * service imports so it is unit-testable without booting the harness.
 *
 * The grammar is deliberately small: the mode switch, the watch-set mutation,
 * and the status view. A Session reference is only parsed here — resolving an
 * exact id or a unique id prefix needs the Session listing and therefore lives
 * in `./resolve.ts` and the handler.
 *
 * @module @yankeguo/dsh-command-devlead/parse
 */

import { DEVLEAD_COMMAND_NAME } from '@yankeguo/dsh-devlead-protocol'

/**
 * Grammar advertised to command-aware clients: the text after
 * `Usage: /devlead `.
 */
export const COMMAND_GRAMMAR = '[status|on|off|watch <session>|unwatch <session>]'

/** One-line usage hint shown by every invalid input. */
export const USAGE = `Usage: /${DEVLEAD_COMMAND_NAME} ${COMMAND_GRAMMAR}`

/** One parsed `/devlead` invocation. */
export type DevLeadCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'on' }
  | { readonly kind: 'off' }
  | { readonly kind: 'watch'; readonly session: string }
  | { readonly kind: 'unwatch'; readonly session: string }
  | { readonly kind: 'invalid'; readonly message: string }

/** Build one invalid-grammar command with a specific explanation. */
function invalid(message: string): DevLeadCommand {
  return { kind: 'invalid', message }
}

/** Split one non-empty trimmed input into its first token and the remaining text. */
function splitHead(input: string): { readonly head: string; readonly rest: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input)
  if (match === null) return { head: input.toLowerCase(), rest: '' }
  return { head: (match[1] as string).toLowerCase(), rest: (match[2] ?? '').trim() }
}

/**
 * Strip one matching pair of surrounding single or double quotes from one
 * command argument. Humans naturally copy ids and titles from the UI, and the
 * composer passes the text through verbatim, so the quotes are grammar rather
 * than part of the value.
 * @param text - trimmed argument text.
 * @returns the argument without one surrounding quote pair, trimmed again.
 */
function unquote(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  const pair = (first === '"' && last === '"') || (first === '\'' && last === '\'')
  return pair ? trimmed.slice(1, -1).trim() : trimmed
}

/** Build the invalid result of one known subcommand that takes no argument. */
function unexpectedArgument(subcommand: string): DevLeadCommand {
  return invalid(`The /devlead ${subcommand} subcommand does not take an argument.`)
}

/**
 * Parse one Session reference argument. Session identities are opaque host
 * strings, but they never contain whitespace, so an unquoted multi-word value
 * can never match one; reject it here instead of returning a confusing
 * "no such Session" from the resolver.
 * @param subcommand - canonical subcommand keyword used in the error message.
 * @param text - argument text after the keyword.
 * @returns the parsed command or an invalid result with a specific explanation.
 */
function parseSessionArgument(subcommand: 'watch' | 'unwatch', text: string): DevLeadCommand {
  const session = unquote(text)
  if (session.length === 0) {
    return invalid(
      `/devlead ${subcommand} requires a Session id or a unique id prefix. `
      + 'Run /devlead to inspect the current watch set.',
    )
  }
  if (/\s/u.test(session)) {
    return invalid(
      `"/devlead ${subcommand}" takes one Session reference without spaces; `
      + 'pass the full Session id or a unique id prefix.',
    )
  }
  return { kind: subcommand, session }
}

/**
 * Parse the `/devlead` grammar.
 *
 * A bare command (or the explicit `status` alias) shows the lead's status;
 * `on` and `off` flip the human-only mode switch; `watch` and `unwatch` take
 * one Session reference. Keywords are case-insensitive; a Session reference is
 * never lower-cased, and one pair of matching surrounding quotes is stripped
 * from it.
 * @param rawInput - exact text following the command name.
 * @returns the parsed command; malformed known subcommands yield `invalid`.
 */
export function parseDevLeadCommand(rawInput: string): DevLeadCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'status' }
  switch (input.toLowerCase()) {
    case 'status': return { kind: 'status' }
    case 'on': return { kind: 'on' }
    case 'off': return { kind: 'off' }
    default: break
  }
  const { head, rest } = splitHead(input)
  switch (head) {
    case 'watch': return parseSessionArgument('watch', rest)
    case 'unwatch': return parseSessionArgument('unwatch', rest)
    // A no-argument subcommand followed by stray text is a typo, not a
    // Session reference; name the offending subcommand instead of guessing.
    case 'status':
    case 'on':
    case 'off':
      return unexpectedArgument(head)
    default:
      return invalid(`Unknown /devlead subcommand "${head}".`)
  }
}
