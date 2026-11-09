import { describe, expect, it } from 'vitest'
import {
  COMMAND_GRAMMAR,
  USAGE,
  parseDevLeadCommand,
} from '../src/parse.ts'

describe('parseDevLeadCommand', () => {
  it('shows status for empty or whitespace-only input', () => {
    expect(parseDevLeadCommand('')).toEqual({ kind: 'status' })
    expect(parseDevLeadCommand('   \n\t ')).toEqual({ kind: 'status' })
  })

  it('accepts explicit status as an alias', () => {
    expect(parseDevLeadCommand('status')).toEqual({ kind: 'status' })
    expect(parseDevLeadCommand('STATUS')).toEqual({ kind: 'status' })
  })

  it('parses the mode switch case-insensitively', () => {
    expect(parseDevLeadCommand('on')).toEqual({ kind: 'on' })
    expect(parseDevLeadCommand('ON')).toEqual({ kind: 'on' })
    expect(parseDevLeadCommand('  on  ')).toEqual({ kind: 'on' })
    expect(parseDevLeadCommand('off')).toEqual({ kind: 'off' })
    expect(parseDevLeadCommand('Off')).toEqual({ kind: 'off' })
  })

  it('parses watch and unwatch with their Session reference', () => {
    expect(parseDevLeadCommand('watch session-alpha')).toEqual({ kind: 'watch', session: 'session-alpha' })
    expect(parseDevLeadCommand('WATCH session-alpha')).toEqual({ kind: 'watch', session: 'session-alpha' })
    expect(parseDevLeadCommand('unwatch session-beta')).toEqual({ kind: 'unwatch', session: 'session-beta' })
    expect(parseDevLeadCommand('UnWatch abc123')).toEqual({ kind: 'unwatch', session: 'abc123' })
  })

  it('accepts an id prefix and preserves its case', () => {
    expect(parseDevLeadCommand('watch AbC')).toEqual({ kind: 'watch', session: 'AbC' })
    expect(parseDevLeadCommand('unwatch session-')).toEqual({ kind: 'unwatch', session: 'session-' })
  })

  it('strips one surrounding quote pair from a Session reference', () => {
    expect(parseDevLeadCommand('watch "session-alpha"')).toEqual({ kind: 'watch', session: 'session-alpha' })
    expect(parseDevLeadCommand("unwatch 'session-beta'")).toEqual({ kind: 'unwatch', session: 'session-beta' })
  })

  it('rejects watch and unwatch without a Session reference', () => {
    for (const line of ['watch', 'unwatch', 'watch   ']) {
      const command = parseDevLeadCommand(line)
      expect(command.kind).toBe('invalid')
      expect(command.kind === 'invalid' ? command.message : '').toContain('requires a Session id or a unique id prefix')
    }
  })

  it('rejects an empty quoted Session reference', () => {
    expect(parseDevLeadCommand('watch ""')).toMatchObject({ kind: 'invalid' })
    expect(parseDevLeadCommand("unwatch ''")).toMatchObject({ kind: 'invalid' })
  })

  it('rejects multi-word Session references instead of guessing', () => {
    const command = parseDevLeadCommand('watch the webapp session')
    expect(command.kind).toBe('invalid')
    expect(command.kind === 'invalid' ? command.message : '').toContain('without spaces')
  })

  it('rejects stray arguments after a no-argument subcommand', () => {
    for (const line of ['on now', 'off now', 'status please']) {
      const command = parseDevLeadCommand(line)
      expect(command.kind).toBe('invalid')
      expect(command.kind === 'invalid' ? command.message : '').toContain('does not take an argument')
    }
  })

  it('rejects an unknown subcommand', () => {
    const command = parseDevLeadCommand('enable')
    expect(command.kind).toBe('invalid')
    const message = command.kind === 'invalid' ? command.message : ''
    expect(message).toContain('Unknown /devlead subcommand "enable"')
  })

  it('never throws on arbitrary text', () => {
    expect(() => parseDevLeadCommand('\u0000')).not.toThrow()
    expect(() => parseDevLeadCommand('watch\nsession-alpha')).not.toThrow()
    expect(parseDevLeadCommand('watch\nsession-alpha')).toEqual({ kind: 'watch', session: 'session-alpha' })
  })

  it('accepts a complete command line as rawInput', () => {
    // Some command clients pass the whole line rather than the text after the
    // command name; both spellings must resolve to the same grammar.
    expect(parseDevLeadCommand('/devlead')).toEqual({ kind: 'status' })
    expect(parseDevLeadCommand('/devlead/')).toEqual({ kind: 'status' })
    expect(parseDevLeadCommand('/devlead on')).toEqual({ kind: 'on' })
    expect(parseDevLeadCommand('/devlead watch session-alpha')).toEqual({ kind: 'watch', session: 'session-alpha' })
    expect(parseDevLeadCommand(' /devlead  status ')).toEqual({ kind: 'status' })
  })

  it('exposes one stable usage line and its advertised grammar', () => {
    expect(USAGE).toBe(`Usage: /devlead ${COMMAND_GRAMMAR}`)
    for (const token of ['on', 'off', 'watch <session>', 'unwatch <session>']) {
      expect(COMMAND_GRAMMAR).toContain(token)
    }
  })
})
