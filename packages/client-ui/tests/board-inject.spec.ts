/** Host-to-browser board global contract (the Step B read boundary). */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { apply, inject } from '../src/index.ts'

function boot(boardPath: string | undefined): { emit(): IndexInjection[] } {
  let listener: ((table: IndexInjection[]) => void) | undefined
  const ctx = {
    devLead: { board: { path: boardPath } },
    on: (name: string, callback: (table: IndexInjection[]) => void) => {
      expect(name).toBe('webserver/index-inject')
      listener = callback
      return () => {}
    },
  } as unknown as Context
  apply(ctx)
  return {
    emit() {
      const table: IndexInjection[] = []
      listener?.(table)
      return table
    },
  }
}

describe('board index injection', () => {
  it('injects the configured absolute path and schema version', () => {
    expect(inject).toEqual(['devLead'])
    const harness = boot('/workbox/.dsh/devlead/board.json')
    expect(harness.emit()).toEqual([{
      kind: 'global',
      name: '__DSH_DEVLEAD_BOARD__',
      value: {
        boardPath: '/workbox/.dsh/devlead/board.json',
        schemaVersion: 1,
        pathPlatform: process.platform === 'win32' ? 'win32' : 'posix',
      },
    }])
  })

  it('omits the global while the board is disabled', () => {
    expect(boot(undefined).emit()).toEqual([])
  })
})
