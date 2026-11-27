/** Notes I/O mapping, index-last rollback, and orphan cleanup at dependency seams. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevLeadBoardStore } from '../src/board.ts'
import { DevLeadBoardNotesStore } from '../src/notes.ts'
import type { DevLeadNotesIndex } from '@yankeguo/dsh-devlead-protocol'

let writeFailure: { readonly kind: 'index' | 'body'; readonly code: string } | undefined
let lockFailureCode: string | undefined
let orphanCleanupFailure = false

function injected(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

vi.mock('@deepseek-ai/dsh-atomic-write', async () => {
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>('@deepseek-ai/dsh-atomic-write')
  return {
    ...actual,
    writeFileAtomic: async (
      path: string,
      content: string | Uint8Array,
      options: Parameters<typeof actual.writeFileAtomic>[2],
    ) => {
      const kind = path.endsWith('/index.json') ? 'index' : path.endsWith('.md') ? 'body' : undefined
      if (writeFailure !== undefined && writeFailure.kind === kind) throw injected(writeFailure.code)
      return actual.writeFileAtomic(path, content, options)
    },
    withFileLock: async <T>(
      filename: string,
      operation: () => Promise<T>,
      options?: Parameters<typeof actual.withFileLock>[2],
    ): Promise<T> => {
      if (lockFailureCode !== undefined) throw injected(lockFailureCode)
      return actual.withFileLock(filename, operation, options)
    },
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (orphanCleanupFailure && String(path).endsWith('.md')) throw injected('EACCES')
      return actual.rm(path, options)
    },
  }
})

const actor = { sessionId: 'lead', title: 'DevLead' }
const roots: string[] = []
const boards: DevLeadBoardStore[] = []
const stores: DevLeadBoardNotesStore[] = []
let clock = 1_800_000_000_000

async function boot(): Promise<{ boardPath: string; notes: DevLeadBoardNotesStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-notes-io-'))
  roots.push(root)
  const boardPath = join(root, 'board.json')
  const board = new DevLeadBoardStore(boardPath, { warn: () => undefined }, () => clock++)
  boards.push(board)
  await board.start()
  await board.update({
    project: 'alpha', create: true, updatedBy: actor,
    set: { workspace: { path: '/tmp/alpha', title: 'alpha' } },
  })
  const notes = new DevLeadBoardNotesStore(root, board, { warn: () => undefined }, () => clock++)
  stores.push(notes)
  await notes.start()
  return { boardPath, notes }
}

afterEach(async () => {
  writeFailure = undefined
  lockFailureCode = undefined
  orphanCleanupFailure = false
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const board of boards.splice(0).reverse()) await board.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DevLeadBoardNotesStore I/O surface', () => {
  it.each(['ENOSPC', 'EROFS', 'EFBIG', 'EDQUOT', 'EAGAIN', 'ENOMEM'])(
    'maps first-index %s to BOARD_IO_ERROR and removes the uncommitted body',
    async code => {
      const { notes } = await boot()
      writeFailure = { kind: 'index', code }
      await expect(notes.write({ project: 'alpha', operation: 'create', note: 'n1', title: 'N' }))
        .rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
      expect(existsSync(notes.indexPath!)).toBe(false)
      const listing = await notes.read({ project: 'alpha' })
      expect(listing.notes).toEqual([])
      expect(existsSync(join(notes.path!, listing.project.directory, 'n1.md'))).toBe(false)
    },
  )

  it('leaves a native body untouched when a metadata index commit fails', async () => {
    const { notes } = await boot()
    const created = await notes.write({ project: 'alpha', operation: 'create', note: 'n1', title: 'N' })
    await writeFile(created.note.absolutePath, 'old', 'utf8')
    const beforeIndex = await readFile(notes.indexPath!, 'utf8')
    writeFailure = { kind: 'index', code: 'ENOSPC' }
    await expect(notes.write({ project: 'alpha', operation: 'update-metadata', note: 'n1', title: 'new title' }))
      .rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
    expect(await readFile(created.note.absolutePath, 'utf8')).toBe('old')
    expect(await readFile(notes.indexPath!, 'utf8')).toBe(beforeIndex)
  })

  it('does not create an index when the initial body write fails', async () => {
    const { notes } = await boot()
    writeFailure = { kind: 'body', code: 'EACCES' }
    await expect(notes.write({ project: 'alpha', operation: 'create', note: 'n1', title: 'N' }))
      .rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
    expect(existsSync(notes.indexPath!)).toBe(false)
    expect((await notes.read({ project: 'alpha' })).notes).toEqual([])
  })

  it('does not roll back a native body when reconciliation cannot commit the index', async () => {
    const { notes } = await boot()
    const created = await notes.write({ project: 'alpha', operation: 'create', note: 'n1', title: 'N' })
    const beforeIndex = await readFile(notes.indexPath!, 'utf8')
    await writeFile(created.note.absolutePath, 'native edit', 'utf8')
    writeFailure = { kind: 'index', code: 'ENOSPC' }
    await expect(notes.read({ project: 'alpha', note: 'n1' })).rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
    expect(await readFile(created.note.absolutePath, 'utf8')).toBe('native edit')
    expect(await readFile(notes.indexPath!, 'utf8')).toBe(beforeIndex)
  })

  it('maps lock acquisition failures without changing either file', async () => {
    const { notes } = await boot()
    const created = await notes.write({ project: 'alpha', operation: 'create', note: 'n1', title: 'N' })
    const bodyPath = join(notes.path!, created.note.path)
    await writeFile(bodyPath, 'old', 'utf8')
    const beforeIndex = await readFile(notes.indexPath!, 'utf8')
    lockFailureCode = 'EACCES'
    await expect(notes.write({ project: 'alpha', operation: 'delete', note: 'n1' }))
      .rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
    expect(await readFile(notes.indexPath!, 'utf8')).toBe(beforeIndex)
    expect(await readFile(bodyPath, 'utf8')).toBe('old')
  })

  it('commits deletion before best-effort body cleanup and leaves only an ignored orphan on cleanup failure', async () => {
    const { notes } = await boot()
    const created = await notes.write({ project: 'alpha', operation: 'create', note: 'n1', title: 'N' })
    const bodyPath = join(notes.path!, created.note.path)
    orphanCleanupFailure = true
    const deleted = await notes.write({ project: 'alpha', operation: 'delete', note: 'n1' })
    expect(deleted.deleted).toBe(true)
    expect(existsSync(bodyPath)).toBe(true)
    const index = JSON.parse(await readFile(notes.indexPath!, 'utf8')) as DevLeadNotesIndex
    expect(index.projects).toEqual([])
    expect((await notes.read({ project: 'alpha' })).notes).toEqual([])
  })
})
