/** Filesystem CRUD, CAS, locking, validation, lifecycle, and summary of board notes. */

import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_BOARD_SUMMARY_MAX_BYTES,
  DevLeadBoardStore,
  renderDevLeadBoardSummary,
  type DevLeadBoard,
} from '../src/board.ts'
import {
  DEVLEAD_NOTES_INDEX_MAX_BYTES,
  DEVLEAD_NOTES_MAX_PER_PROJECT,
  DEVLEAD_NOTES_NOTE_MAX_BYTES,
  DevLeadBoardNotesStore,
  type DevLeadBoardNoteWrite,
} from '../src/notes.ts'
import type { DevLeadNotesIndex } from '@yankeguo/dsh-devlead-protocol'
import { bootService, FakeAgent } from './harness.ts'

const roots: string[] = []
const boards: DevLeadBoardStore[] = []
const stores: DevLeadBoardNotesStore[] = []
const actor = { sessionId: 'session-lead', title: 'DevLead' }
let clock = 1_800_000_000_000

interface Fixture {
  readonly root: string
  readonly boardPath: string
  readonly board: DevLeadBoardStore
  readonly notes: DevLeadBoardNotesStore
}

async function boot(options: { readonly betaTitle?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-notes-'))
  roots.push(root)
  const boardPath = join(root, 'board.json')
  const board = new DevLeadBoardStore(boardPath, { warn: () => undefined }, () => clock++)
  boards.push(board)
  await board.start()
  await board.update({
    project: 'alpha', create: true, updatedBy: actor,
    set: { workspace: { path: '/tmp/alpha', title: 'Alpha project' } },
  })
  if (options.betaTitle !== undefined) {
    await board.update({
      project: 'beta', create: true, updatedBy: actor,
      set: { workspace: { path: '/tmp/beta', title: options.betaTitle } },
    })
  }
  let generated = 0
  const notes = new DevLeadBoardNotesStore(
    boardPath,
    board,
    { warn: () => undefined },
    () => clock++,
    () => `00000000-0000-4000-8000-${String(generated++).padStart(12, '0')}`,
  )
  stores.push(notes)
  await notes.start()
  return { root, boardPath, board, notes }
}

async function persistedIndex(fixture: Fixture): Promise<DevLeadNotesIndex> {
  return JSON.parse(await readFile(fixture.notes.indexPath!, 'utf8')) as DevLeadNotesIndex
}

function write(patch: DevLeadBoardNoteWrite): DevLeadBoardNoteWrite {
  return patch
}

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const board of boards.splice(0).reverse()) await board.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DevLeadBoardNotesStore', () => {
  it('derives dirname(boardPath)/notes and reads a missing index as revision zero', async () => {
    const fixture = await boot()
    expect(fixture.notes.path).toBe(join(dirname(fixture.boardPath), 'notes'))
    expect(fixture.notes.indexPath).toBe(join(fixture.notes.path!, 'index.json'))
    const result = await fixture.notes.read({ project: 'alpha' })
    expect(result).toMatchObject({ revision: 0, notes: [], project: { id: 'alpha' } })
    expect(result.project.directory).toMatch(/^alpha-[a-f0-9]{12}$/u)
    expect(existsSync(fixture.notes.indexPath!)).toBe(false)
  })

  it('creates an indexed path, natively edits the body, updates metadata, and deletes', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({
      project: 'Alpha project', operation: 'create', title: ' Release plan ', summary: 'checklist',
    }))
    expect(created).toMatchObject({
      revision: 1, changed: true, operation: 'create',
      project: { id: 'alpha' }, note: { title: 'Release plan', bytes: 0 },
    })
    expect(created.note).not.toHaveProperty('content')
    expect(created).not.toHaveProperty('truncated')
    const id = created.note.id
    const bodyPath = join(fixture.notes.path!, created.note.path)
    expect(created.note.absolutePath).toBe(bodyPath)
    expect(await readFile(bodyPath, 'utf8')).toBe('')
    let index = await persistedIndex(fixture)
    expect(index.projects).toHaveLength(1)
    expect(index.projects[0]?.notes[0]?.path).toBe(`${created.project.directory}/${id}.md`)
    expect(JSON.stringify(index)).not.toContain('absolutePath')

    const nativeContent = '# Native\nnext🙂\n'
    const nativeMtime = new Date('2026-11-24T01:02:03.000Z')
    await writeFile(bodyPath, nativeContent, 'utf8')
    await utimes(bodyPath, nativeMtime, nativeMtime)
    const read = await fixture.notes.read({ project: 'alpha', note: id })
    expect(read).toMatchObject({ revision: 2, note: {
      id, absolutePath: bodyPath,
      bytes: Buffer.byteLength(nativeContent), updatedAt: nativeMtime.toISOString(),
    } })
    expect(read.note).not.toHaveProperty('content')
    expect(read).not.toHaveProperty('truncated')
    expect(await readFile(bodyPath, 'utf8')).toBe(nativeContent)
    index = await persistedIndex(fixture)
    expect(JSON.stringify(index)).not.toContain('# Native')

    const listed = await fixture.notes.read({ project: '/tmp/alpha' })
    expect(listed.notes).toEqual([read.note])
    expect(listed.notes?.[0]).not.toHaveProperty('content')
    expect(listed).not.toHaveProperty('truncated')
    expect(listed.note).toBeUndefined()
    const updated = await fixture.notes.write(write({
      project: 'alpha', operation: 'update-metadata', note: id,
      title: 'Release checklist', summary: 'native body', expectedRevision: listed.revision,
    }))
    expect(updated).toMatchObject({
      revision: 3, changed: true,
      note: { bytes: read.note!.bytes, title: 'Release checklist', summary: 'native body', absolutePath: bodyPath },
    })
    const noop = await fixture.notes.write(write({
      project: 'alpha', operation: 'update-metadata', note: id, title: 'Release checklist', summary: 'native body',
    }))
    expect(noop).toMatchObject({ revision: 3, changed: false })
    expect(await readFile(bodyPath, 'utf8')).toBe(nativeContent)

    const deleted = await fixture.notes.write(write({ project: 'alpha', operation: 'delete', note: id }))
    expect(deleted).toMatchObject({ revision: 4, operation: 'delete', changed: true, deleted: true, note: { id, absolutePath: bodyPath } })
    expect(existsSync(bodyPath)).toBe(false)
    index = await persistedIndex(fixture)
    expect(index.projects).toEqual([])
    expect((await fixture.notes.read({ project: 'alpha' })).notes).toEqual([])
  })

  it('keeps index-revision CAS for metadata without changing the native body', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'CAS' }))
    const beforeIndex = await readFile(fixture.notes.indexPath!, 'utf8')
    const bodyPath = created.note.absolutePath
    await writeFile(bodyPath, 'native body', 'utf8')
    const beforeBody = await readFile(bodyPath, 'utf8')
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'update-metadata', note: created.note.id, title: 'lost', expectedRevision: 0,
    }))).rejects.toMatchObject({ code: 'BOARD_REVISION_CONFLICT' })
    expect(await readFile(fixture.notes.indexPath!, 'utf8')).toBe(beforeIndex)
    expect(await readFile(bodyPath, 'utf8')).toBe(beforeBody)
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'update-metadata', note: created.note.id, content: 'not a tool body write',
    } as unknown as DevLeadBoardNoteWrite))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
  })

  it('rejects case-only create collisions without touching the index or any body', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({
      project: 'alpha', operation: 'create', note: 'CaseNote', title: 'Original',
    }))
    const bodyPath = join(fixture.notes.path!, created.note.path)
    await writeFile(bodyPath, 'original body', 'utf8')
    const beforeIndex = await readFile(fixture.notes.indexPath!, 'utf8')
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'create', note: 'casenote', title: 'Collision',
    }))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect(await readFile(fixture.notes.indexPath!, 'utf8')).toBe(beforeIndex)
    expect(await readFile(bodyPath, 'utf8')).toBe('original body')
    expect(await readdir(dirname(bodyPath))).toEqual(['CaseNote.md'])
  })

  it('serializes two store instances through the index lock without lost notes', async () => {
    const fixture = await boot()
    const second = new DevLeadBoardNotesStore(
      fixture.boardPath, fixture.board, { warn: () => undefined }, () => clock++,
    )
    stores.push(second)
    await second.start()
    await Promise.all(Array.from({ length: 12 }, (_, position) =>
      (position % 2 === 0 ? fixture.notes : second).write(write({
        project: 'alpha', operation: 'create', note: `note-${position}`, title: `Note ${position}`,
      }))))
    const index = await persistedIndex(fixture)
    expect(index.revision).toBe(12)
    expect(index.projects[0]?.notes.map(note => note.id).sort()).toEqual(
      Array.from({ length: 12 }, (_, position) => `note-${position}`).sort(),
    )
    expect((await second.read({ project: 'alpha' })).notes).toHaveLength(12)
  })

  it('serializes concurrent read/list reconciliation into one index repair', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'Concurrent' }))
    const nativeMtime = new Date('2026-11-24T02:03:04.000Z')
    await writeFile(created.note.absolutePath, 'external native edit', 'utf8')
    await utimes(created.note.absolutePath, nativeMtime, nativeMtime)
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => fixture.notes.read({
      project: 'alpha', ...index % 2 === 0 ? {} : { note: created.note.id },
    })))
    expect(new Set(results.map(result => result.revision))).toEqual(new Set([2]))
    const index = await persistedIndex(fixture)
    expect(index.revision).toBe(2)
    expect(index.projects[0]?.notes[0]).toMatchObject({
      bytes: Buffer.byteLength('external native edit'), updatedAt: nativeMtime.toISOString(),
    })
    expect(await readFile(created.note.absolutePath, 'utf8')).toBe('external native edit')
  })

  it('rejects unsafe ids and operation shapes without creating files', async () => {
    const fixture = await boot()
    for (const id of ['../escape', '/absolute', 'a/b', 'a\\b', '.hidden', '-leading', 'white space', 'CON', 'com1.txt', 'LPT9.']) {
      await expect(fixture.notes.write(write({
        project: 'alpha', operation: 'create', note: id, title: 'unsafe',
      }))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    }
    await expect(fixture.notes.write(write({ project: 'alpha', operation: 'create', title: ' ' })))
      .rejects.toMatchObject({ code: 'BOARD_INVALID' })
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'create', title: 'body', content: 'not accepted',
    } as unknown as DevLeadBoardNoteWrite))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    await expect(fixture.notes.write(write({ project: 'alpha', operation: 'update-metadata', note: 'missing', title: ' ' })))
      .rejects.toMatchObject({ code: 'BOARD_INVALID' })
    await expect(fixture.notes.write(write({ project: 'alpha', operation: 'update', note: 'missing' } as unknown as DevLeadBoardNoteWrite)))
      .rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect((await fixture.notes.read({ project: 'alpha' })).revision).toBe(0)
    expect(existsSync(fixture.notes.indexPath!)).toBe(false)
  })

  it('preserves project resolution and ambiguity errors', async () => {
    const fixture = await boot({ betaTitle: 'Alpha project' })
    await expect(fixture.notes.read({ project: 'Alpha project' }))
      .rejects.toMatchObject({ code: 'BOARD_PROJECT_AMBIGUOUS' })
    await expect(fixture.notes.read({ project: 'missing' }))
      .rejects.toMatchObject({ code: 'BOARD_PROJECT_NOT_FOUND' })
    const byPath = await fixture.notes.write(write({ project: '/tmp/beta', operation: 'create', title: 'Beta' }))
    expect(byPath.project.id).toBe('beta')
  })

  it('refuses malformed, strict-invalid, and oversized indexes without overwriting them', async () => {
    const fixture = await boot()
    for (const content of [
      '{broken',
      JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: '2026-01-01T00:00:00.000Z', projects: [], extra: true }),
    ]) {
      await writeFile(fixture.notes.indexPath!, content, 'utf8')
      await expect(fixture.notes.read({ project: 'alpha' })).rejects.toMatchObject({ code: 'BOARD_INVALID' })
      await expect(fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'overwrite' })))
        .rejects.toMatchObject({ code: 'BOARD_INVALID' })
      expect(await readFile(fixture.notes.indexPath!, 'utf8')).toBe(content)
    }
    await writeFile(fixture.notes.indexPath!, Buffer.alloc(DEVLEAD_NOTES_INDEX_MAX_BYTES + 1, 32))
    await expect(fixture.notes.read({ project: 'alpha' })).rejects.toMatchObject({ code: 'BOARD_LIMIT_EXCEEDED' })
  })

  it('rejects invalid UTF-8 in the index without overwriting it', async () => {
    const fixture = await boot()
    const invalidIndex = Buffer.from([0x7b, 0xff, 0x7d])
    await writeFile(fixture.notes.indexPath!, invalidIndex)
    await expect(fixture.notes.read({ project: 'alpha' })).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect(await readFile(fixture.notes.indexPath!)).toEqual(invalidIndex)
  })

  it('repairs stale size/mtime metadata, maps missing/oversized bodies, and lets delete repair absence', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'Body' }))
    const bodyPath = created.note.absolutePath
    await rm(bodyPath)
    await expect(fixture.notes.read({ project: 'alpha', note: created.note.id }))
      .rejects.toMatchObject({ code: 'BOARD_NOTE_NOT_FOUND' })
    await expect(fixture.notes.read({ project: 'alpha' }))
      .rejects.toMatchObject({ code: 'BOARD_NOTE_NOT_FOUND' })
    const repaired = await fixture.notes.write(write({ project: 'alpha', operation: 'delete', note: created.note.id }))
    expect(repaired.deleted).toBe(true)
    expect((await persistedIndex(fixture)).projects).toEqual([])

    const second = await fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'Body 2' }))
    const secondPath = second.note.absolutePath
    const nativeMtime = new Date('2026-11-24T03:04:05.000Z')
    await writeFile(secondPath, 'different bytes', 'utf8')
    await utimes(secondPath, nativeMtime, nativeMtime)
    const reconciled = await fixture.notes.read({ project: 'alpha', note: second.note.id })
    expect(reconciled.note).toMatchObject({
      bytes: Buffer.byteLength('different bytes'), updatedAt: nativeMtime.toISOString(),
    })
    expect(reconciled.note).not.toHaveProperty('content')
    expect(reconciled).not.toHaveProperty('truncated')
    expect(await readFile(secondPath, 'utf8')).toBe('different bytes')
    const beforeOversize = await readFile(fixture.notes.indexPath!, 'utf8')
    await writeFile(secondPath, Buffer.alloc(DEVLEAD_NOTES_NOTE_MAX_BYTES + 1, 32))
    await expect(fixture.notes.read({ project: 'alpha', note: second.note.id }))
      .rejects.toMatchObject({ code: 'BOARD_LIMIT_EXCEEDED' })
    await expect(fixture.notes.read({ project: 'alpha' }))
      .rejects.toMatchObject({ code: 'BOARD_LIMIT_EXCEEDED' })
    expect(await readFile(fixture.notes.indexPath!, 'utf8')).toBe(beforeOversize)
  })

  it('enforces per-project count limits and ignores orphan bodies', async () => {
    const fixture = await boot()
    const listed = await fixture.notes.read({ project: 'alpha' })
    const orphan = join(fixture.notes.path!, listed.project.directory, 'orphan.md')
    await mkdir(dirname(orphan), { recursive: true })
    await writeFile(orphan, 'not indexed', 'utf8')
    expect((await fixture.notes.read({ project: 'alpha' })).notes).toEqual([])
    const replacement = await fixture.notes.write(write({ project: 'alpha', operation: 'create', note: 'orphan', title: 'Indexed' }))
    expect(replacement.note.id).toBe('orphan')
    expect(await readFile(orphan, 'utf8')).toBe('')

    for (let position = 1; position < DEVLEAD_NOTES_MAX_PER_PROJECT; position += 1) {
      await fixture.notes.write(write({ project: 'alpha', operation: 'create', note: `n-${position}`, title: 'n' }))
    }
    await expect(fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'overflow' })))
      .rejects.toMatchObject({ code: 'BOARD_LIMIT_EXCEEDED' })
    expect((await fixture.notes.read({ project: 'alpha' })).notes).toHaveLength(DEVLEAD_NOTES_MAX_PER_PROJECT)
  })

  it('merges active-project counts/latest titles into a UTF-8-bounded cached summary', async () => {
    const fixture = await boot()
    await fixture.notes.write(write({ project: 'alpha', operation: 'create', note: 'old', title: 'Old title' }))
    await fixture.notes.write(write({ project: 'alpha', operation: 'create', note: 'new', title: 'Latest🙂 title' }))
    const board = JSON.parse(await readFile(fixture.boardPath, 'utf8')) as DevLeadBoard
    const summary = renderDevLeadBoardSummary(board, fixture.notes.summaryIndex())
    expect(summary).toContain('notes:2')
    expect(summary).toContain('Latest🙂 title')
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(DEVLEAD_BOARD_SUMMARY_MAX_BYTES)
    board.projects.push({ ...board.projects[0]!, id: 'paused', status: 'paused' })
    const pausedNotes = structuredClone(fixture.notes.summaryIndex()!)
    pausedNotes.projects[0]!.id = 'paused'
    const pausedLine = renderDevLeadBoardSummary(board, pausedNotes).split('\n')
      .find(line => line.startsWith('- paused/'))
    expect(pausedLine).toBeDefined()
    expect(pausedLine).not.toContain('notes:')
    expect(pausedLine).not.toContain('Latest🙂 title')
  })

  it('switches and restarts the notes root with the active lead board path', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'dsh-devlead-notes-switch-a-'))
    const workspaceB = await mkdtemp(join(tmpdir(), 'dsh-devlead-notes-switch-b-'))
    roots.push(workspaceA, workspaceB)
    const harness = await bootService({ enabled: true, leadCwd: workspaceA })
    try {
      await harness.service.updateBoard(harness.lead.agent, {
        project: 'alpha', create: true, set: { workspace: { path: '/tmp/alpha', title: 'alpha' } },
      })
      await harness.service.writeBoardNote(harness.lead.agent, { project: 'alpha', operation: 'create', title: 'A note' })
      const rootA = join(workspaceA, '.dsh', 'devlead', 'notes')
      const rootB = join(workspaceB, '.dsh', 'devlead', 'notes')
      expect(harness.service.notes.path).toBe(rootA)
      expect(existsSync(join(rootA, 'index.json'))).toBe(true)

      const sessionB = harness.ctx.sessions.create(SessionId('notes-lead-b'), { meta: { cwd: workspaceB } })
      const agentB = new FakeAgent(sessionB)
      harness.agents.add(agentB)
      await harness.service.setEnabled(harness.lead.agent, false)
      expect(harness.service.notes.enabled).toBe(false)
      await harness.service.setEnabled(agentB.agent, true)
      expect(harness.service.notes.path).toBe(rootB)
      expect(harness.service.notes.path).not.toBe(rootA)
      await harness.service.updateBoard(agentB.agent, {
        project: 'beta', create: true, set: { workspace: { path: '/tmp/beta', title: 'beta' } },
      })
      expect((await harness.service.readBoardNote(agentB.agent, { project: 'beta' }))).toMatchObject({
        revision: 0, notes: [],
      })
      expect(existsSync(join(rootA, 'index.json'))).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('allows only the service active lead and follows mode-off lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-notes-service-'))
    roots.push(root)
    const harness = await bootService({ enabled: true, config: { boardPath: join(root, 'board.json') } })
    try {
      await harness.service.updateBoard(harness.lead.agent, {
        project: 'alpha', create: true, set: { workspace: { path: '/tmp/alpha', title: 'alpha' } },
      })
      const created = await harness.service.writeBoardNote(harness.lead.agent, {
        project: 'alpha', operation: 'create', title: 'Lead note',
      })
      expect(created.note.bytes).toBe(0)
      expect(created.note.absolutePath).toBeTruthy()
      expect(await readFile(created.note.absolutePath, 'utf8')).toBe('')
      await writeFile(created.note.absolutePath, 'body', 'utf8')
      const read = await harness.service.readBoardNote(harness.lead.agent, {
        project: 'alpha', note: created.note.id,
      })
      expect(read.note?.bytes).toBe(4)
      expect(read.note).not.toHaveProperty('content')
      expect(read).not.toHaveProperty('truncated')
      expect(harness.service.boardSummaryFor(harness.lead.agent)).toContain('notes:1 latest:"Lead note"')
      await harness.service.setEnabled(harness.lead.agent, false)
      expect(harness.service.notes.enabled).toBe(false)
      expect(harness.service.boardSummaryFor(harness.lead.agent)).toBe('')
      await expect(harness.service.writeBoardNote(harness.lead.agent, {
        project: 'alpha', operation: 'delete', note: created.note.id,
      })).rejects.toMatchObject({ code: 'DEVLEAD_NOT_ENABLED' })
    } finally {
      await harness.dispose()
    }
  })
})
