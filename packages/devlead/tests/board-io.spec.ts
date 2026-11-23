/** Structured read/write failures at the board's filesystem dependency seams. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevLeadBoardStore } from '../src/board.ts'
import type { DevLeadBoard } from '../src/board.ts'

let readErrorCode: string | undefined
let readFileErrorCode: string | undefined
let writeErrorCode: string | undefined
let mkdirErrorCode: string | undefined

function injectedFsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
      if (mkdirErrorCode !== undefined) throw injectedFsError(mkdirErrorCode)
      return actual.mkdir(path, options as never)
    },
    stat: async (path: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
      if (readErrorCode !== undefined) throw injectedFsError(readErrorCode)
      return actual.stat(path, options as never)
    },
    readFile: async (
      path: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1],
    ) => {
      if (readFileErrorCode !== undefined) throw injectedFsError(readFileErrorCode)
      return actual.readFile(path, options as never)
    },
  }
})

vi.mock('@deepseek-ai/dsh-atomic-write', async () => {
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>('@deepseek-ai/dsh-atomic-write')
  return {
    ...actual,
    writeFileAtomic: async (
      path: string,
      content: string | Uint8Array,
      options: Parameters<typeof actual.writeFileAtomic>[2],
    ) => {
      if (writeErrorCode !== undefined) throw injectedFsError(writeErrorCode)
      return actual.writeFileAtomic(path, content, options)
    },
  }
})

const actor = { sessionId: 'lead', title: 'DevLead' }
const stores: DevLeadBoardStore[] = []
const roots: string[] = []
let clock = 1_800_000_000_000

async function boot(): Promise<{ store: DevLeadBoardStore; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-io-'))
  roots.push(root)
  const file = join(root, 'board.json')
  const store = new DevLeadBoardStore(file, { warn: () => undefined }, () => clock++)
  stores.push(store)
  await store.start()
  await store.update({
    project: 'alpha', create: true, updatedBy: actor,
    set: { workspace: { path: '/tmp/alpha', title: 'alpha' } },
  })
  return { store, file }
}

afterEach(async () => {
  readErrorCode = undefined
  readFileErrorCode = undefined
  writeErrorCode = undefined
  mkdirErrorCode = undefined
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DevLeadBoardStore I/O error surface', () => {
  it('maps startup parent precreation failures to BOARD_IO_ERROR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-start-io-'))
    roots.push(root)
    const store = new DevLeadBoardStore(join(root, 'nested', 'board.json'))
    stores.push(store)
    mkdirErrorCode = 'EACCES'
    await expect(store.start()).rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
  })

  // A started store concurrently reloads from its watcher, and a read that
  // waits for that in-flight reload can legitimately answer from the cache
  // without calling `stat` again. That timing is not part of the error-surface
  // contract, so these two tests use a fresh, never-started store: no snapshot,
  // no watcher, and no pending reload, which forces the first read to consult
  // the filesystem seam deterministically.
  it('maps an uncached first-read stat failure to BOARD_IO_ERROR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-read-stat-io-'))
    roots.push(root)
    const store = new DevLeadBoardStore(join(root, 'board.json'))
    stores.push(store)
    expect(store.summary()).toBe('')
    readErrorCode = 'EACCES'
    await expect(store.read()).rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
  })

  it('maps an uncached first-read file failure to BOARD_IO_ERROR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-read-file-io-'))
    roots.push(root)
    const file = join(root, 'board.json')
    await writeFile(file, '{"schemaVersion":1}\n', 'utf8')
    const store = new DevLeadBoardStore(file)
    stores.push(store)
    expect(store.summary()).toBe('')
    readFileErrorCode = 'EACCES'
    await expect(store.read()).rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
  })

  it.each(['ENOSPC', 'EROFS', 'EFBIG', 'EDQUOT', 'EAGAIN', 'ENOMEM'])(
    'maps %s writes to BOARD_IO_ERROR and preserves bytes',
    async code => {
      const { store, file } = await boot()
      const before = await readFile(file, 'utf8')
      writeErrorCode = code
      await expect(store.update({ project: 'alpha', updatedBy: actor, set: { focus: 'not committed' } }))
        .rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
      expect(await readFile(file, 'utf8')).toBe(before)
      const persisted = JSON.parse(before) as DevLeadBoard
      expect(persisted.projects[0]?.focus).toBe('')
    },
  )
})
