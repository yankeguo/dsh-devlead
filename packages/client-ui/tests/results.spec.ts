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
  failureMessage,
  unexpectedFailure,
  type DevLeadCommandAdmission,
  type DevLeadCommandExecution,
  type DevLeadTranslate,
} from '../src/client/results.ts'

/** English dictionary used to prove fallback text is translation-owned. */
const FALLBACKS: Record<string, string> = {
  'error.fallback.transport': 'command failed',
  'error.fallback.rejected': 'command rejected',
  'error.fallback.unknown': 'unknown error',
  'error.fallback.unresolved': 'the Host did not recognize the command',
}
const t: DevLeadTranslate = key => FALLBACKS[key] ?? key

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

  it('leaves a rejection without usable text for the localized fallback', () => {
    expect(commandFailure(admitted({ kind: 'error' }))).toEqual({ kind: 'rejected' })
    expect(commandFailure(admitted({ kind: 'error', text: '   ' }))).toEqual({ kind: 'rejected' })
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

  it('leaves a transport failure without a message for the localized fallback', () => {
    expect(commandFailure({ ok: false, error: { code: 'gateway/internal', message: '  ' } }))
      .toEqual({ kind: 'transport', code: 'gateway/internal' })
  })

  it('returns undefined when no command was executed (classified by admitCommand)', () => {
    expect(commandFailure({ ok: true, value: undefined })).toBeUndefined()
  })
})

describe('unexpectedFailure', () => {
  it('keeps an Error message and substitutes one for a non-Error throw', () => {
    expect(unexpectedFailure(new Error('remote face unmounted')))
      .toEqual({ kind: 'unexpected', message: 'remote face unmounted' })
    expect(unexpectedFailure('boom')).toEqual({ kind: 'unexpected' })
  })

  it('leaves a blank Error message for the localized fallback', () => {
    expect(unexpectedFailure(new Error('   '))).toEqual({ kind: 'unexpected' })
    expect(unexpectedFailure(new Error(''))).toEqual({ kind: 'unexpected' })
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
    expect(failureMessage({ kind: 'transport', message: 'offline', code: 'x' }, t)).toBe('offline')
    expect(failureMessage({ kind: 'rejected', message: 'nope' }, t)).toBe('nope')
    expect(failureMessage({ kind: 'unexpected', message: 'boom' }, t)).toBe('boom')
  })

  it('localizes the core single-active refusal with its occupant label', () => {
    const message = (session: string): string => 'Another Session is already in DevLead mode: '
      + `${session}. Run /devlead off there first, then enable this Session.`
    const translate: DevLeadTranslate = (key, params) => `${key}|${String(params?.session)}`
    expect(failureMessage({ kind: 'rejected', message: message('Webapp (session-1)') }, translate))
      .toBe('error.alreadyActive|Webapp (session-1)')
    // Archived occupants no longer block admission, so the core never emits
    // an archived refusal variant; a prefix-shaped message without our
    // instruction stays verbatim rather than losing text to an over-eager match.
    const foreign = 'Another Session is already in DevLead mode: session-1 (host detail).'
    expect(failureMessage({ kind: 'rejected', message: foreign }, translate)).toBe(foreign)
    // A legacy archived-shaped refusal (the core no longer produces it) has
    // no special client handling anymore and stays verbatim.
    const legacyArchived = 'Another Session is already in DevLead mode: session-1. That Session is archived and '
      + 'could not be released automatically; open it, run /devlead off, then retry.'
    expect(failureMessage({ kind: 'rejected', message: legacyArchived }, translate)).toBe(legacyArchived)
  })

  it('splits the occupant label at the canonical tail, not at instruction text inside a title', () => {
    const translate: DevLeadTranslate = (key, params) => `${key}|${String(params?.session)}`
    // A Session title is free text and may itself contain the instruction
    // sentence. The real instruction is always the final canonical tail, so
    // the label must keep the quoted-looking text instead of splitting early.
    const title = 'Build. Run /devlead off there first fix (session-1)'
    const message = 'Another Session is already in DevLead mode: '
      + `${title}. Run /devlead off there first, then enable this Session.`
    expect(failureMessage({ kind: 'rejected', message }, translate))
      .toBe(`error.alreadyActive|${title}`)

    // The same instruction sentence without the complete canonical tail is
    // foreign text, not the core refusal: it stays verbatim.
    const truncated = 'Another Session is already in DevLead mode: session-1. Run /devlead off there first.'
    expect(failureMessage({ kind: 'rejected', message: truncated }, translate)).toBe(truncated)
  })

  it('localizes every client-owned fallback', () => {
    expect(failureMessage({ kind: 'transport', code: 'x' }, t)).toBe('command failed')
    expect(failureMessage({ kind: 'rejected' }, t)).toBe('command rejected')
    expect(failureMessage({ kind: 'unexpected' }, t)).toBe('unknown error')
    expect(failureMessage({ kind: 'unresolved', line: '/devlead on' }, t))
      .toBe('the Host did not recognize the command')
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
