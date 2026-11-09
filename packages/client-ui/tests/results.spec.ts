/**
 * Unit tests for the command-result helpers of the DevLeadBar dock.
 *
 * The dock must surface both failure layers of a `/devlead` admission: a failed
 * Remote call and a logical Host rejection (`ok: true` with
 * `CommandExecution.result.kind === 'error'`).
 */

import { describe, expect, it } from 'vitest'
import {
  commandFailure,
  failureCopy,
  unexpectedFailure,
  type DevLeadCommandAdmission,
  type DevLeadCommandExecution,
} from '../src/client/results.ts'

/**
 * Build a settled admission result.
 * @param result - host command outcome.
 * @returns the Remote-shaped admission result.
 */
function admitted(result: DevLeadCommandExecution['result']): DevLeadCommandAdmission {
  return { ok: true, value: { result } }
}

describe('commandFailure', () => {
  it('returns the Host text of a logical command rejection', () => {
    expect(commandFailure(admitted({ kind: 'error', text: 'This Session has no live Agent.' })))
      .toEqual({ kind: 'rejected', message: 'This Session has no live Agent.' })
  })

  it('falls back to a generic text for a rejection without text', () => {
    expect(commandFailure(admitted({ kind: 'error' })))
      .toEqual({ kind: 'rejected', message: 'command rejected' })
  })

  it('returns undefined for a successful command, with or without text', () => {
    expect(commandFailure(admitted({ kind: 'success', text: 'DevLead mode is on.' }))).toBeUndefined()
    expect(commandFailure(admitted({ kind: 'success' }))).toBeUndefined()
  })

  it('classifies a transport failure from the Remote error branch', () => {
    expect(commandFailure({
      ok: false,
      error: { code: 'gateway/internal', message: 'connection reset' },
    })).toEqual({ kind: 'transport', message: 'connection reset', code: 'gateway/internal' })
  })

  it('returns undefined when no command was executed', () => {
    expect(commandFailure({ ok: true, value: undefined })).toBeUndefined()
  })
})

describe('unexpectedFailure', () => {
  it('keeps an Error message and substitutes one for a non-Error throw', () => {
    expect(unexpectedFailure(new Error('remote face unmounted')))
      .toEqual({ kind: 'unexpected', message: 'remote face unmounted' })
    expect(unexpectedFailure('boom'))
      .toEqual({ kind: 'unexpected', message: 'unknown error' })
  })
})

describe('failureCopy', () => {
  it('renders transport failures with the message/code template', () => {
    expect(failureCopy({ kind: 'transport', message: 'connection reset', code: 'gateway/internal' }))
      .toEqual({
        key: 'error.command',
        params: { message: 'connection reset', code: 'gateway/internal' },
      })
  })

  it('renders a logical rejection as a rejected-command line', () => {
    expect(failureCopy({ kind: 'rejected', message: 'This Session has no live Agent.' }))
      .toEqual({
        key: 'error.rejected',
        params: { message: 'This Session has no live Agent.' },
      })
  })

  it('renders an unexpected throw as an unknown command failure', () => {
    expect(failureCopy({ kind: 'unexpected', message: 'boom' }))
      .toEqual({ key: 'error.unknown', params: { message: 'boom' } })
  })
})
