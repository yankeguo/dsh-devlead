/**
 * Unit tests for the command-result helpers of the DevLead surfaces.
 *
 * Both surfaces must surface every failure layer of a `/devlead` admission: a
 * failed Remote call, a logical Host rejection (`ok: true` with
 * `CommandExecution.result.kind === 'error'`), a settled call that resolved no
 * command, and a thrown command face.
 */

import { describe, expect, it } from 'vitest'
import {
  DEVLEAD_ADMISSION_IDLE,
  admitCommand,
  commandFailure,
  createDevLeadAdmissionGate,
  devLeadAdmissionReducer,
  failureCopy,
  failureMessage,
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

  it('falls back to a generic text for a rejection without usable text', () => {
    expect(commandFailure(admitted({ kind: 'error' })))
      .toEqual({ kind: 'rejected', message: 'command rejected' })
    expect(commandFailure(admitted({ kind: 'error', text: '   ' })))
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

  it('falls back to a generic text for a transport failure without a message', () => {
    expect(commandFailure({ ok: false, error: { code: 'gateway/internal', message: '  ' } }))
      .toEqual({ kind: 'transport', message: 'command failed', code: 'gateway/internal' })
  })

  it('returns undefined when no command was executed (classified by admitCommand)', () => {
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

  it('substitutes one for a blank Error message', () => {
    expect(unexpectedFailure(new Error('   '))).toEqual({ kind: 'unexpected', message: 'unknown error' })
    expect(unexpectedFailure(new Error(''))).toEqual({ kind: 'unexpected', message: 'unknown error' })
  })
})

describe('admitCommand', () => {
  it('returns undefined for a successful admission', async () => {
    await expect(admitCommand(() => Promise.resolve(admitted({ kind: 'success' })), '/devlead on'))
      .resolves.toBeUndefined()
  })

  it('returns the logical rejection', async () => {
    await expect(admitCommand(
      () => Promise.resolve(admitted({ kind: 'error', text: 'this Session has no live Agent' })),
      '/devlead on',
    )).resolves.toEqual({ kind: 'rejected', message: 'this Session has no live Agent' })
  })

  it('returns the transport failure', async () => {
    await expect(admitCommand(
      () => Promise.resolve({ ok: false, error: { code: 'gateway/unavailable', message: 'offline' } }),
      '/devlead off',
    )).resolves.toEqual({ kind: 'transport', message: 'offline', code: 'gateway/unavailable' })
  })

  it('reports a settled admission that resolved no command instead of dropping it', async () => {
    // `undefined` value means the line never reached a command handler (unknown
    // or shadowed name, stale Client after a Host restart): a silent no-op here
    // would make a dead entry point look like a successful toggle.
    await expect(admitCommand(
      () => Promise.resolve({ ok: true, value: undefined }),
      '/devlead on',
    )).resolves.toEqual({ kind: 'unresolved', line: '/devlead on' })
  })

  it('classifies a thrown command face', async () => {
    await expect(admitCommand(
      () => Promise.reject(new Error('remote face unmounted')),
      '/devlead on',
    )).resolves.toEqual({ kind: 'unexpected', message: 'remote face unmounted' })
    await expect(admitCommand(
      () => {
        throw new Error('synchronous assembly fault')
      },
      '/devlead on',
    )).resolves.toEqual({ kind: 'unexpected', message: 'synchronous assembly fault' })
  })
})

describe('failureMessage', () => {
  it('returns the host text of transport, rejection, and unexpected failures', () => {
    expect(failureMessage({ kind: 'transport', message: 'offline', code: 'x' })).toBe('offline')
    expect(failureMessage({ kind: 'rejected', message: 'nope' })).toBe('nope')
    expect(failureMessage({ kind: 'unexpected', message: 'boom' })).toBe('boom')
  })

  it('explains an unresolved line instead of echoing the raw command', () => {
    expect(failureMessage({ kind: 'unresolved', line: '/devlead on' }))
      .toBe('the Host did not recognize the command line')
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

  it('renders an unresolved line as a not-recognized command line', () => {
    expect(failureCopy({ kind: 'unresolved', line: '/devlead off' }))
      .toEqual({ key: 'error.unresolved', params: { line: '/devlead off' } })
  })
})

describe('createDevLeadAdmissionGate', () => {
  it('admits one claim at a time and reopens after release', () => {
    const gate = createDevLeadAdmissionGate()
    expect(gate.tryEnter()).toBe(true)
    expect(gate.tryEnter()).toBe(false)
    gate.leave()
    expect(gate.tryEnter()).toBe(true)
  })

  it('tolerates an idempotent double release', () => {
    const gate = createDevLeadAdmissionGate()
    expect(gate.tryEnter()).toBe(true)
    gate.leave()
    gate.leave()
    expect(gate.tryEnter()).toBe(true)
  })
})

describe('devLeadAdmissionReducer', () => {
  it('enters the in-flight state and clears a previous failure', () => {
    expect(devLeadAdmissionReducer(
      { pending: false, failure: { kind: 'transport', message: 'offline', code: 'x' } },
      { type: 'begin' },
    )).toEqual({ pending: true, failure: null })
  })

  it('settles with a failure and returns to idle', () => {
    const failure = { kind: 'rejected', message: 'nope' } as const
    expect(devLeadAdmissionReducer({ pending: true, failure: null }, { type: 'settle', failure }))
      .toEqual({ pending: false, failure })
    expect(devLeadAdmissionReducer({ pending: true, failure: null }, { type: 'settle', failure: null }))
      .toEqual({ pending: false, failure: null })
  })

  it('resets only a stale failure and keeps an in-flight attempt pending', () => {
    const failure = { kind: 'unexpected', message: 'boom' } as const
    const idle = devLeadAdmissionReducer({ pending: false, failure }, { type: 'reset' })
    expect(idle).toEqual({ pending: false, failure: null })
    expect(devLeadAdmissionReducer({ pending: true, failure: null }, { type: 'reset' }))
      .toEqual({ pending: true, failure: null })
  })

  it('keeps the same reference when a transition changes nothing', () => {
    expect(devLeadAdmissionReducer(DEVLEAD_ADMISSION_IDLE, { type: 'reset' })).toBe(DEVLEAD_ADMISSION_IDLE)
    const idle = { pending: false, failure: null } as const
    expect(devLeadAdmissionReducer(idle, { type: 'settle', failure: null })).toBe(idle)
  })
})
