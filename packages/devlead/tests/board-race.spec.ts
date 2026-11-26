/** Deterministic cross-process races at the board's filesystem read seam. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevLeadBoardStore } from '../src/board.ts'
import type { DevLeadBoard } from '../src/board.ts'

interface ReadGate {
  readonly started: Promise<void>
  readonly release: () => void
}

let pendingGate: {
  readonly markStarted: () => void
  readonly released: Promise<void>
} | undefined
let pendingAfterStatGate: {
  readonly markStarted: () => void
  readonly released: Promise<void>
  statCalls: number
} | undefined
let activeReads = 0
let maximumActiveReads = 0
let boardReadCount = 0

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    stat: async (path: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
      const result = await actual.stat(path, options as never)
      const gate = pendingAfterStatGate
      if (gate !== undefined) {
        gate.statCalls += 1
        if (gate.statCalls === 2) {
          pendingAfterStatGate = undefined
          gate.markStarted()
          await gate.released
        }
      }
      return result
    },
    readFile: async (
      path: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1],
    ) => {
      activeReads += 1
      boardReadCount += 1
      maximumActiveReads = Math.max(maximumActiveReads, activeReads)
      try {
        // Capture the bytes before pausing: an external writer must be able to
        // replace the file while this read remains in flight.
        const content = await actual.readFile(path, options as never)
        const gate = pendingGate
        pendingGate = undefined
        if (gate !== undefined) {
          gate.markStarted()
          await gate.released
        }
        return content
      } finally {
        activeReads -= 1
      }
    },
  }
})

function captureNextRead(): ReadGate {
  let markStarted!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  pendingGate = { markStarted, released }
  return { started, release }
}

function captureAfterStat(): ReadGate {
  let markStarted!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  pendingAfterStatGate = { markStarted, released, statCalls: 0 }
  return { started, release }
}

const actor = { sessionId: 'session-lead', title: 'DevLead' }
const roots: string[] = []
const stores: DevLeadBoardStore[] = []
let clock = 1_800_000_000_000

function initialBoard(): DevLeadBoard {
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: actor,
    projects: [{
      id: 'alpha',
      revision: 1,
      workspace: { path: '/tmp/alpha', title: 'alpha' },
      status: 'active',
      priority: 'medium',
      goal: '',
      focus: '',
      next: '',
      blockers: [],
      tasks: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }
}

async function createStore(file: string): Promise<DevLeadBoardStore> {
  const store = new DevLeadBoardStore(file, { warn: () => undefined }, () => clock++)
  stores.push(store)
  return store
}

async function setup(): Promise<{ file: string; left: DevLeadBoardStore; right: DevLeadBoardStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-race-'))
  roots.push(root)
  const file = join(root, 'board.json')
  await writeFile(file, `${JSON.stringify(initialBoard(), null, 2)}\n`, 'utf8')
  return { file, left: await createStore(file), right: await createStore(file) }
}

function addTask(id: string) {
  return { project: 'alpha', updatedBy: actor, tasks: { upsert: [{ id, title: id }] } }
}

async function releaseInsideLock(file: string, gate: ReadGate): Promise<void> {
  await vi.waitFor(() => {
    expect(existsSync(`${file}.lock`)).toBe(true)
  }, { timeout: 1_000, interval: 5 })
  // Let the lock callback enter refresh(true) while the original read is held.
  await new Promise<void>(resolve => { setImmediate(resolve) })
  gate.release()
}

afterEach(async () => {
  pendingGate = undefined
  pendingAfterStatGate = undefined
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  activeReads = 0
  maximumActiveReads = 0
  boardReadCount = 0
})

describe('DevLeadBoardStore read invalidation races', () => {
  it('serializes forced waiters without sharing or overlapping their fresh reads', async () => {
    const { left } = await setup()
    const before = boardReadCount
    await Promise.all([left.start(), left.start(), left.start()])
    expect(boardReadCount - before).toBe(3)
    expect(maximumActiveReads).toBe(1)
  })

  it('does not lose an external update completed during an in-flight forced refresh', async () => {
    const { file, left, right } = await setup()
    const gate = captureNextRead()
    const starting = left.start()
    await gate.started
    await right.start()
    await right.update(addTask('right'))

    const updating = left.update(addTask('left'))
    await releaseInsideLock(file, gate)
    await starting
    await updating

    const persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    expect(persisted.revision).toBe(3)
    expect(persisted.projects[0]?.tasks.map(task => task.id).sort()).toEqual(['left', 'right'])
  })

  it('forces a locked read after an internally consistent in-flight snapshot', async () => {
    const { file, left, right } = await setup()
    const gate = captureAfterStat()
    const starting = left.start()
    await gate.started
    // The paused load read r1 and saw matching before/after fingerprints. Only
    // after that proof does the external writer commit r2, so load retries
    // alone cannot repair a forced refresh that reuses the old Promise.
    await right.start()
    await right.update(addTask('right'))

    const updating = left.update(addTask('left'))
    await releaseInsideLock(file, gate)
    await starting
    await updating

    const persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    expect(persisted.revision).toBe(3)
    expect(persisted.projects[0]?.tasks.map(task => task.id).sort()).toEqual(['left', 'right'])
  })

  it('checks CAS against a fresh locked snapshot rather than an in-flight stale read', async () => {
    const { file, left, right } = await setup()
    const gate = captureNextRead()
    const starting = left.start()
    await gate.started
    await right.start()
    await right.update(addTask('right'))
    const external = await readFile(file, 'utf8')

    const updating = left.update(addTask('left'), 1)
    await releaseInsideLock(file, gate)
    await starting
    await expect(updating).rejects.toMatchObject({ code: 'BOARD_REVISION_CONFLICT' })
    expect(await readFile(file, 'utf8')).toBe(external)
  })

  it('never overwrites malformed external bytes with an in-flight valid snapshot', async () => {
    const { file, left } = await setup()
    const gate = captureNextRead()
    const starting = left.start()
    await gate.started
    await writeFile(file, '{broken', 'utf8')

    const updating = left.update(addTask('left'))
    await releaseInsideLock(file, gate)
    await starting
    await expect(updating).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })

  it('caches only bytes whose before/after fingerprints match', async () => {
    const { file, left } = await setup()
    const gate = captureNextRead()
    const starting = left.start()
    await gate.started
    const external = initialBoard()
    external.revision = 2
    external.projects[0]!.tasks.push({
      id: 'right', title: 'right', status: 'todo', updatedAt: '2026-01-02T00:00:00.000Z',
    })
    external.updatedAt = '2026-01-02T00:00:00.000Z'
    await writeFile(file, `${JSON.stringify(external, null, 2)}\n`, 'utf8')

    gate.release()
    await starting
    const result = await left.read({ project: 'alpha' })
    expect(result.revision).toBe(2)
    expect(result.projects[0]?.tasks?.map(task => task.id)).toEqual(['right'])
  })
})
