/**
 * Failure translation of the DevLead tool surface: domain errors become
 * structured `HarnessError`s, tool-input errors keep their invalid-input code,
 * and infrastructure failures are rethrown untouched.
 */

import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { DevLeadError } from '@yankeguo/dsh-devlead'
import { DevLeadToolInputError } from '../src/arguments.ts'
import { runTool, translateToolError } from '../src/errors.ts'

/** Build one `Error` carrying a DevLead code without the core class. */
function codeOnlyError(code: string, message = 'domain failure'): Error {
  return Object.assign(new Error(message), { code })
}

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
  })

  it('maps a code-only duplicate of the core error class', () => {
    const translated = translateToolError(codeOnlyError('DEVLEAD_WATCH_LIMIT', 'watch limit reached'))
    expect(translated).toBeInstanceOf(HarnessError)
    expect((translated as HarnessError).code).toBe('DEVLEAD_WATCH_LIMIT')
    expect((translated as HarnessError).message).toBe('watch limit reached')
  })

  it('maps tool input errors to DEVLEAD_INVALID_INPUT', () => {
    const translated = translateToolError(new DevLeadToolInputError('prompt must not be empty'))
    expect(translated).toBeInstanceOf(HarnessError)
    expect((translated as HarnessError).code).toBe('DEVLEAD_INVALID_INPUT')
    expect((translated as HarnessError).message).toBe('prompt must not be empty')
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
})
