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
export const COMMAND_GRAMMAR = '[status|on|off|reset|watch <session>|unwatch <session>]'

/** One-line usage hint shown by every invalid input. */
export const USAGE = `Usage: /${DEVLEAD_COMMAND_NAME} ${COMMAND_GRAMMAR}`

/** One parsed `/devlead` invocation. */
export type DevLeadCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'on' }
  | { readonly kind: 'off' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'watch'; readonly session: string }
  | { readonly kind: 'unwatch'; readonly session: string }
  | { readonly kind: 'invalid'; readonly message: string }

/** Build one invalid-grammar command with a specific explanation. */
function invalid(message: string): DevLeadCommand {
  return { kind: 'invalid', message }
}

/** Split one non-empty trimmed input into its first token and the remaining text. */
function splitHead(input: string): { readonly head: string; readonly rest: string } {
  const separator = input.search(/\s/u)
  if (separator === -1) return { head: input.toLowerCase(), rest: '' }
  return { head: input.slice(0, separator).toLowerCase(), rest: input.slice(separator).trim() }
}

/** Opening quote characters a human may wrap a copied Session reference in. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['＂', '＂'],
]

/**
 * The closing quote paired with one opening quote, when it is one DevLead
 * recognizes. ASCII quotes are paired with themselves; the CJK full-width and
 * curly forms are the ones a Chinese IME produces around a pasted id.
 * @param opening - first character of the argument.
 * @returns the matching closing character, or undefined.
 */
function closingQuoteOf(opening: string): string | undefined {
  return QUOTE_PAIRS.find(([open]) => open === opening)?.[1]
}

/**
 * Whether one character is any recognized closing quote.
 * @param value - candidate character.
 * @returns whether it closes a quote pair.
 */
function isClosingQuote(value: string): boolean {
  return QUOTE_PAIRS.some(([, close]) => close === value)
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
 *
 * One matching surrounding quote pair (ASCII or the curly/full-width forms a
 * Chinese IME inserts) is grammar, not part of the value. A closed quote with
 * trailing text is reported as such instead of as an "unmatched quote".
 * @param subcommand - canonical subcommand keyword used in the error message.
 * @param text - argument text after the keyword.
 * @returns the parsed command or an invalid result with a specific explanation.
 */
function parseSessionArgument(subcommand: 'watch' | 'unwatch', text: string): DevLeadCommand {
  const raw = text.trim()
  if (raw.length === 0) {
    return invalid(
      `/devlead ${subcommand} requires a Session id or a unique id prefix. `
      + 'Run /devlead to inspect the current watch set.',
    )
  }
  const closer = closingQuoteOf(raw[0] ?? '')
  if (closer !== undefined) {
    const end = raw.indexOf(closer, 1)
    if (end === -1) {
      return invalid(
        `The /devlead ${subcommand} Session reference has an unmatched quote; `
        + 'wrap the whole reference in one matching pair of quotes.',
      )
    }
    if (raw.slice(end + 1).trim().length > 0) {
      return invalid(
        `"/devlead ${subcommand}" takes exactly one Session reference; `
        + 'unexpected text follows the quoted reference.',
      )
    }
    const session = raw.slice(1, end).trim()
    if (session.length === 0) {
      return invalid(`/devlead ${subcommand} requires a Session id or a unique id prefix.`)
    }
    if (/\s/u.test(session)) {
      return invalid(
        `"/devlead ${subcommand}" takes one Session reference without spaces; `
        + 'pass the full Session id or a unique id prefix.',
      )
    }
    return { kind: subcommand, session }
  }
  // A closing quote with no opener is the other half of the same paste mistake.
  if (isClosingQuote(raw[raw.length - 1] ?? '')) {
    return invalid(
      `The /devlead ${subcommand} Session reference has an unmatched quote; `
      + 'wrap the whole reference in one matching pair of quotes.',
    )
  }
  if (/\s/u.test(raw)) {
    return invalid(
      `"/devlead ${subcommand}" takes one Session reference without spaces; `
      + 'pass the full Session id or a unique id prefix.',
    )
  }
  return { kind: subcommand, session: raw }
}

/**
 * Parse the `/devlead` grammar.
 *
 * A bare command (or the explicit `status` alias) shows the lead's status;
 * `on` and `off` flip the human-only mode switch; `reset` discards a damaged
 * durable state; `watch` and `unwatch` take one Session reference. Keywords are
 * case-insensitive; a Session reference is never lower-cased, and one pair of
 * matching surrounding quotes is stripped from it.
 *
 * `rawInput` is the text following the registered command name (DSH's
 * `CommandInvocation.rawInput` contract), so the leading separator whitespace
 * is the only wrapper the parser tolerates: a complete line such as
 * `/devlead on` is not silently accepted, because no command adapter passes one
 * and a loud grammar error surfaces such a client bug instead of hiding it.
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
    case 'reset': return { kind: 'reset' }
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
    case 'reset':
      return unexpectedArgument(head)
    default:
      if (head === `/${DEVLEAD_COMMAND_NAME.toLowerCase()}`) {
        return invalid(
          'Pass only the text after the command name (for example "on"), not the full /devlead line.',
        )
      }
      return invalid(`Unknown /devlead subcommand "${head}".`)
  }
}
