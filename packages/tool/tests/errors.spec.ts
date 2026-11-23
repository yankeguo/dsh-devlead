/**
 * Failure translation of the DevLead tool surface: domain errors become
 * structured `HarnessError`s, tool-input errors keep their invalid-input code,
 * and infrastructure failures are rethrown untouched.
 */

import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { DevLeadBoardError, DevLeadError } from '@yankeguo/dsh-devlead'
import { DevLeadToolInputError, requireAgent } from '../src/arguments.ts'
import { runTool, translateToolError } from '../src/errors.ts'

/** Build one `Error` carrying a DevLead code without the core class. */
function codeOnlyError(code: string, message = 'domain failure'): Error {
  return Object.assign(new Error(message), { code })
}

describe('requireAgent', () => {
  it('returns the exact caller when the Step carried one', () => {
    const agent = { id: 'agent-lead' } as unknown as Parameters<typeof requireAgent>[0]
    expect(requireAgent(agent, 'devlead_get_session')).toBe(agent)
  })

  it('reports a missing caller as a structured agent-not-live failure', () => {
    expect(() => requireAgent(undefined, 'devlead_get_session')).toThrow(HarnessError)
    try {
      requireAgent(undefined, 'devlead_get_session')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HarnessError)
      expect((error as HarnessError).code).toBe('DEVLEAD_AGENT_NOT_LIVE')
      expect((error as HarnessError).message).toBe('devlead_get_session requires a calling Agent')
    }
  })
})

describe('translateToolError', () => {
  it('passes an existing HarnessError through unchanged', () => {
    const original = new HarnessError('already structured', 'SOME_CODE')
    expect(translateToolError(original)).toBe(original)
  })

  it('maps a real DevLeadError to a HarnessError with the same message and code', () => {
    const original = new DevLeadError('the Session is archived', 'DEVLEAD_SESSION_ARCHIVED')
    const translated = translateToolError(original)
    expect(translated).toBeInstanceOf(HarnessError)
    const error = translated as HarnessError
    expect(error.message).toBe('the Session is archived')
    expect(error.code).toBe('DEVLEAD_SESSION_ARCHIVED')
    expect(error.cause).toBe(original)
  })

  it('maps a code-only duplicate of the core error class', () => {
    const translated = translateToolError(codeOnlyError('DEVLEAD_WATCH_LIMIT', 'watch limit reached'))
    expect(translated).toBeInstanceOf(HarnessError)
    expect((translated as HarnessError).code).toBe('DEVLEAD_WATCH_LIMIT')
    expect((translated as HarnessError).message).toBe('watch limit reached')
    expect((translated as HarnessError).cause).toBeInstanceOf(Error)
  })

  it('maps ambiguous-project and board-I/O failures, including duplicate core classes', () => {
    for (const [code, message] of [
      ['BOARD_PROJECT_AMBIGUOUS', 'project title "webapp" is ambiguous; use its id or workspace path'],
      ['BOARD_IO_ERROR', 'could not read board: EACCES'],
    ] as const) {
      for (const original of [new DevLeadBoardError(message, code), codeOnlyError(code, message)]) {
        const translated = translateToolError(original)
        expect(translated).toBeInstanceOf(HarnessError)
        expect((translated as HarnessError).code).toBe(code)
        expect((translated as HarnessError).message).toBe(message)
        expect((translated as HarnessError).cause).toBe(original)
      }
    }
  })

  it('maps action-required backpressure to the stable delivery rate code', () => {
    const translated = translateToolError(new DevLeadError('16 questions are pending', 'DEVLEAD_DELIVERY_RATE_LIMITED'))
    expect(translated).toBeInstanceOf(HarnessError)
    expect((translated as HarnessError).code).toBe('DEVLEAD_DELIVERY_RATE_LIMITED')
    expect((translated as HarnessError).message).toContain('16 questions are pending')
  })

  it('maps the Phase 1d question-answer failures to their stable codes', () => {
    for (const [code, message] of [
      ['DEVLEAD_QUESTION_NOT_FOUND', 'no question report "q" was found'],
      ['DEVLEAD_QUESTION_ALREADY_ANSWERED', 'question "q" was already answered'],
    ] as const) {
      const translated = translateToolError(new DevLeadError(message, code))
      expect(translated).toBeInstanceOf(HarnessError)
      expect((translated as HarnessError).code).toBe(code)
      expect((translated as HarnessError).message).toBe(message)
      // A code-only duplicate (duplicated core package) maps too.
      const duplicate = translateToolError(codeOnlyError(code, message))
      expect((duplicate as HarnessError).code).toBe(code)
    }
  })

  it('maps tool input errors to DEVLEAD_INVALID_INPUT', () => {
    const translated = translateToolError(new DevLeadToolInputError('prompt must not be empty'))
    expect(translated).toBeInstanceOf(HarnessError)
    expect((translated as HarnessError).code).toBe('DEVLEAD_INVALID_INPUT')
    expect((translated as HarnessError).message).toBe('prompt must not be empty')
    expect((translated as HarnessError).cause).toBeInstanceOf(DevLeadToolInputError)
  })

  it('keeps dispatch capability failures structured', () => {
    for (const [code, message] of [
      ['DEVLEAD_MODEL_UNAVAILABLE', 'model "p/m" is not available'],
      ['DEVLEAD_TEAM_UNAVAILABLE', 'this Host composes no Agent Teams service'],
    ] as const) {
      const translated = translateToolError(new DevLeadError(message, code))
      expect(translated).toBeInstanceOf(HarnessError)
      expect((translated as HarnessError).code).toBe(code)
      expect((translated as HarnessError).message).toBe(message)
    }
  })

  it('keeps the active-session refusal structured with its activity message', () => {
    const original = new DevLeadError(
      'Session "session-1" is still active (turn); stop that work first',
      'DEVLEAD_SESSION_ACTIVE',
    )
    const translated = translateToolError(original)
    expect(translated).toBeInstanceOf(HarnessError)
    expect((translated as HarnessError).code).toBe('DEVLEAD_SESSION_ACTIVE')
    expect((translated as HarnessError).message).toContain('still active (turn)')
  })

  it('rethrows infrastructure errors and non-Error values unchanged', () => {
    const infrastructure = new Error('socket closed')
    expect(translateToolError(infrastructure)).toBe(infrastructure)
    const foreign = codeOnlyError('EPIPE')
    expect(translateToolError(foreign)).toBe(foreign)
    expect(translateToolError('boom')).toBe('boom')
    expect(translateToolError(undefined)).toBeUndefined()
    const notAnError = { code: 'DEVLEAD_INVALID_INPUT', message: 'looks structured but is not an Error' }
    expect(translateToolError(notAnError)).toBe(notAnError)
  })
})

describe('runTool', () => {
  it('returns the body value on success', async () => {
    await expect(runTool(() => 42)).resolves.toBe(42)
    await expect(runTool(async () => 'done')).resolves.toBe('done')
  })

  it('translates synchronous domain failures', async () => {
    const error = await runTool(() => {
      throw new DevLeadError('no Session matches', 'DEVLEAD_SESSION_NOT_FOUND')
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).code).toBe('DEVLEAD_SESSION_NOT_FOUND')
  })

  it('translates asynchronous input failures', async () => {
    const error = await runTool(async () => {
      throw new DevLeadToolInputError('path must not be empty')
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).code).toBe('DEVLEAD_INVALID_INPUT')
  })

  it('rethrows infrastructure failures as the same instance', async () => {
    const infrastructure = new Error('database offline')
    const error = await runTool(async () => {
      throw infrastructure
    }).catch((thrown: unknown) => thrown)
    expect(error).toBe(infrastructure)
  })

  it('keeps a guard HarnessError structured instead of remapping it', async () => {
    const error = await runTool(() => requireAgent(undefined, 'devlead_notifications'))
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).code).toBe('DEVLEAD_AGENT_NOT_LIVE')
  })
})
