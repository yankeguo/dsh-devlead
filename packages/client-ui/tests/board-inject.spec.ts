/** Host-to-browser board global contract (the dynamic-board read boundary). */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { apply, inject } from '../src/index.ts'

/** Board facts one fake Host DevLead service publishes. */
interface HostBoard {
  /** Current board file path; undefined while no lead owns a board. */
  readonly path: string | undefined
  /** Lead Session whose workspace root owns the board, when known. */
  readonly leadSessionId?: string | undefined
  /** Whether the path came from the deployment Config override. */
  readonly override?: boolean | undefined
}

function boot(board: HostBoard): { emit(): IndexInjection[] } {
  let listener: ((table: IndexInjection[]) => void) | undefined
  const ctx = {
    devLead: {
      board: { path: board.path },
      boardLeadSessionId: board.leadSessionId,
      boardPathOverride: board.override,
    },
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
  it('injects the default board path, lead identity, and platform', () => {
    expect(inject).toEqual(['devLead'])
    const harness = boot({
      path: '/workbox/project/.dsh/devlead/board.json',
      leadSessionId: 'session-lead',
      override: false,
    })
    expect(harness.emit()).toEqual([{
      kind: 'global',
      name: '__DSH_DEVLEAD_BOARD__',
      value: {
        boardPath: '/workbox/project/.dsh/devlead/board.json',
        schemaVersion: 1,
        pathPlatform: process.platform === 'win32' ? 'win32' : 'posix',
        leadSessionId: 'session-lead',
        override: false,
      },
    }])
  })

  it('marks a deployment Config override explicitly', () => {
    const harness = boot({
      path: 'C:\\workbox\\board.json',
      leadSessionId: 'session-lead',
      override: true,
    })
    expect(harness.emit()).toEqual([{
      kind: 'global',
      name: '__DSH_DEVLEAD_BOARD__',
      value: {
        boardPath: 'C:\\workbox\\board.json',
        schemaVersion: 1,
        pathPlatform: process.platform === 'win32' ? 'win32' : 'posix',
        leadSessionId: 'session-lead',
        override: true,
      },
    }])
  })

  it('omits the global while no lead owns a board', () => {
    expect(boot({ path: undefined }).emit()).toEqual([])
    // A path without an owning lead is not a board the browser can follow: the
    // client would otherwise attribute one deployment-wide path to every lead.
    expect(boot({ path: '/workbox/board.json' }).emit()).toEqual([])
  })

  it('keeps a Host that never reported an override on the safe default', () => {
    const harness = boot({ path: '/workbox/board.json', leadSessionId: 'session-lead' })
    const [entry] = harness.emit()
    expect(entry?.kind === 'global' ? entry.value : undefined).toMatchObject({ override: false })
  })
})
