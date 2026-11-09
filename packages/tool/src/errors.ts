/**
 * Failure translation of the `devlead_*` tools.
 *
 * Two failure classes reach a tool body: the core service's `DevLeadError`
 * (stable `DEVLEAD_*` code) and the tool's own input validation. Both must
 * surface as `HarnessError` so the executor and replay can route on the code;
 * anything else is an infrastructure failure and is rethrown unchanged.
 *
 * @module @yankeguo/dsh-tool-devlead/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { isDevLeadError } from '@yankeguo/dsh-devlead'
import { DevLeadToolInputError } from './arguments.ts'

/**
 * Map one caught failure to the structured tool surface.
 *
 * `isDevLeadError` checks the class as well as any `Error` whose `code` starts
 * with `DEVLEAD_`, so a deployment that loads the core package twice still maps
 * its failures instead of leaking them as unstructured crashes.
 * @param error - thrown value.
 * @returns the `HarnessError` to throw, or the original value to rethrow.
 */
export function translateToolError(error: unknown): unknown {
  if (error instanceof HarnessError) return error
  if (error instanceof DevLeadToolInputError) return new HarnessError(error.message, error.code)
  if (isDevLeadError(error)) return new HarnessError(error.message, error.code)
  return error
}

/**
 * Run one tool body, translating parse and domain failures into structured
 * tool errors. The body may be synchronous or asynchronous.
 * @param body - tool implementation.
 * @returns the canonical tool value.
 * @throws {@link HarnessError} for DevLead domain and input failures.
 */
export async function runTool<T>(body: () => T | Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error: unknown) {
    throw translateToolError(error)
  }
}
