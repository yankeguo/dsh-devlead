/** Watcher recovery after the underlying fs.watch stream fails. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DevLeadBoardStore } from '../src/board.ts'
import type { DevLeadBoard } from '../src/board.ts'

const mocks = vi.hoisted(() => ({ watchers: [] as Array<{ emit: (event: string, value: unknown) => boolean }> }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const { EventEmitter } = await vi.importActual<typeof import('node:events')>('node:events')
  return {
    ...actual,
    watch: () => {
      const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
      mocks.watchers.push(watcher)
      return watcher
    },
  }
})

const actor = { sessionId: 'lead', title: 'DevLead' }
const stores: DevLeadBoardStore[] = []
const roots: string[] = []

function board(revision: number): DevLeadBoard {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: actor,
    projects: [],
  }
}

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  mocks.watchers.length = 0
})

it('rearms a failed watcher after a successful reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-watcher-'))
  roots.push(root)
  const file = join(root, 'board.json')
  await writeFile(file, JSON.stringify(board(1)), 'utf8')
  const store = new DevLeadBoardStore(file)
  stores.push(store)
  await store.start()
  expect(mocks.watchers).toHaveLength(1)

  mocks.watchers[0]!.emit('error', new Error('injected watcher loss'))
  await writeFile(file, JSON.stringify(board(2)), 'utf8')
  expect((await store.read()).revision).toBe(2)
  expect(mocks.watchers).toHaveLength(2)
})
