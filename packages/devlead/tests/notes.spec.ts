/** Filesystem CRUD, CAS, locking, validation, lifecycle, and summary of board notes. */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  DEVLEAD_NOTES_READ_MAX_BYTES,
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

  it('creates, lists, reads, updates, appends, and deletes with a consistent index and body', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({
      project: 'Alpha project', operation: 'create', title: ' Release plan ', summary: 'checklist', content: '# Plan\n',
    }))
    expect(created).toMatchObject({
      revision: 1, changed: true, operation: 'create',
      project: { id: 'alpha' }, note: { title: 'Release plan', bytes: 7 },
    })
    const id = created.note.id
    const bodyPath = join(fixture.notes.path!, created.note.path)
    expect(await readFile(bodyPath, 'utf8')).toBe('# Plan\n')
    let index = await persistedIndex(fixture)
    expect(index.projects).toHaveLength(1)
    expect(index.projects[0]?.notes[0]?.path).toBe(`${created.project.directory}/${id}.md`)
    expect(JSON.stringify(index)).not.toContain('# Plan')

    const listed = await fixture.notes.read({ project: '/tmp/alpha' })
    expect(listed.notes).toEqual([created.note])
    expect(listed.note).toBeUndefined()
    const read = await fixture.notes.read({ project: 'alpha', note: id })
    expect(read.note?.content).toBe('# Plan\n')
    expect(read.truncated).toBeUndefined()

    const updated = await fixture.notes.write(write({
      project: 'alpha', operation: 'update', note: id, title: 'Release checklist', content: '# New\n', expectedBytes: 7,
    }))
    expect(updated).toMatchObject({ revision: 2, changed: true, note: { bytes: 6, title: 'Release checklist', summary: 'checklist' } })
    const noop = await fixture.notes.write(write({
      project: 'alpha', operation: 'update', note: id, title: 'Release checklist', content: '# New\n',
    }))
    expect(noop).toMatchObject({ revision: 2, changed: false })
    const appended = await fixture.notes.write(write({
      project: 'alpha', operation: 'append', note: id, content: 'next🙂\n', expectedRevision: 2, expectedBytes: 6,
    }))
    const expected = '# New\nnext🙂\n'
    expect(appended.note.bytes).toBe(Buffer.byteLength(expected, 'utf8'))
    expect((await fixture.notes.read({ project: 'alpha', note: id })).note?.content).toBe(expected)

    const deleted = await fixture.notes.write(write({ project: 'alpha', operation: 'delete', note: id }))
    expect(deleted).toMatchObject({ revision: 4, operation: 'delete', changed: true, deleted: true, note: { id } })
    expect(existsSync(bodyPath)).toBe(false)
    index = await persistedIndex(fixture)
    expect(index.projects).toEqual([])
    expect((await fixture.notes.read({ project: 'alpha' })).notes).toEqual([])
  })

  it('enforces both index-revision and existing-note-byte CAS without changing bytes', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'CAS', content: '🙂' }))
    const beforeIndex = await readFile(fixture.notes.indexPath!, 'utf8')
    const bodyPath = join(fixture.notes.path!, created.note.path)
    const beforeBody = await readFile(bodyPath, 'utf8')
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'append', note: created.note.id, content: 'lost', expectedRevision: 0,
    }))).rejects.toMatchObject({ code: 'BOARD_REVISION_CONFLICT' })
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'update', note: created.note.id, content: 'lost', expectedBytes: 1,
    }))).rejects.toMatchObject({ code: 'BOARD_BYTES_CONFLICT' })
    expect(await readFile(fixture.notes.indexPath!, 'utf8')).toBe(beforeIndex)
    expect(await readFile(bodyPath, 'utf8')).toBe(beforeBody)
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'create', title: 'bad CAS', expectedBytes: 0,
    }))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
  })

  it('rejects case-only create collisions without touching the index or any body', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({
      project: 'alpha', operation: 'create', note: 'CaseNote', title: 'Original', content: 'original body',
    }))
    const bodyPath = join(fixture.notes.path!, created.note.path)
    const beforeIndex = await readFile(fixture.notes.indexPath!, 'utf8')
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'create', note: 'casenote', title: 'Collision', content: 'lost body',
    }))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect(await readFile(fixture.notes.indexPath!, 'utf8')).toBe(beforeIndex)
    expect(await readFile(bodyPath, 'utf8')).toBe('original body')
    expect(await readdir(dirname(bodyPath))).toEqual(['CaseNote.md'])
  })

  it('bounds a single-note model read to 64 KiB at a Unicode boundary', async () => {
    const fixture = await boot()
    const content = '🙂'.repeat(DEVLEAD_NOTES_NOTE_MAX_BYTES / 4)
    const created = await fixture.notes.write(write({
      project: 'alpha', operation: 'create', note: 'large', title: 'Large', content,
    }))
    const result = await fixture.notes.read({ project: 'alpha', note: created.note.id })
    expect(result.truncated).toBe(true)
    expect(result.note?.bytes).toBe(DEVLEAD_NOTES_NOTE_MAX_BYTES)
    expect(result.note?.content.length).toBeGreaterThan(0)
    expect(result.note?.content.length).toBeLessThan(content.length)
    expect(content.startsWith(result.note!.content)).toBe(true)
    expect(result.note?.content).not.toContain('�')
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(DEVLEAD_NOTES_READ_MAX_BYTES)
    // The storage/client limit remains 256 KiB; only the model result is cut.
    expect(await readFile(join(fixture.notes.path!, created.note.path), 'utf8')).toBe(content)
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
        project: 'alpha', operation: 'create', note: `note-${position}`, title: `Note ${position}`, content: String(position),
      }))))
    const index = await persistedIndex(fixture)
    expect(index.revision).toBe(12)
    expect(index.projects[0]?.notes.map(note => note.id).sort()).toEqual(
      Array.from({ length: 12 }, (_, position) => `note-${position}`).sort(),
    )
    expect((await second.read({ project: 'alpha' })).notes).toHaveLength(12)
  })

  it('rejects unsafe ids and operation shapes without creating files', async () => {
    const fixture = await boot()
    for (const id of ['../escape', '/absolute', 'a/b', 'a\\b', '.hidden', '-leading', 'white space', 'CON', 'com1.txt', 'LPT9.']) {
      await expect(fixture.notes.write(write({
        project: 'alpha', operation: 'create', note: id, title: 'unsafe', content: 'no',
      }))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    }
    await expect(fixture.notes.write(write({ project: 'alpha', operation: 'create', title: ' ' })))
      .rejects.toMatchObject({ code: 'BOARD_INVALID' })
    await expect(fixture.notes.write(write({ project: 'alpha', operation: 'append', note: 'missing', title: 'no', content: 'x' })))
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

  it('rejects invalid UTF-8 even when byte counts still match', async () => {
    const fixture = await boot()
    const invalidIndex = Buffer.from([0x7b, 0xff, 0x7d])
    await writeFile(fixture.notes.indexPath!, invalidIndex)
    await expect(fixture.notes.read({ project: 'alpha' })).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect(await readFile(fixture.notes.indexPath!)).toEqual(invalidIndex)

    await rm(fixture.notes.indexPath!)
    const created = await fixture.notes.write(write({
      project: 'alpha', operation: 'create', note: 'utf8', title: 'UTF-8', content: 'abc',
    }))
    const bodyPath = join(fixture.notes.path!, created.note.path)
    await writeFile(bodyPath, Buffer.from([0x61, 0xff, 0x62]))
    await expect(fixture.notes.read({ project: 'alpha', note: 'utf8' }))
      .rejects.toMatchObject({ code: 'BOARD_INVALID' })
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'update', note: 'utf8', content: 'overwrite',
    }))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect((await readFile(bodyPath)).length).toBe(created.note.bytes)
  })

  it('maps missing, oversized, and metadata-mismatched bodies and lets delete repair a missing body', async () => {
    const fixture = await boot()
    const created = await fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'Body', content: 'abc' }))
    const bodyPath = join(fixture.notes.path!, created.note.path)
    await rm(bodyPath)
    await expect(fixture.notes.read({ project: 'alpha', note: created.note.id }))
      .rejects.toMatchObject({ code: 'BOARD_NOTE_NOT_FOUND' })
    const repaired = await fixture.notes.write(write({ project: 'alpha', operation: 'delete', note: created.note.id }))
    expect(repaired.deleted).toBe(true)
    expect((await persistedIndex(fixture)).projects).toEqual([])

    const second = await fixture.notes.write(write({ project: 'alpha', operation: 'create', title: 'Body 2', content: 'abc' }))
    const secondPath = join(fixture.notes.path!, second.note.path)
    await writeFile(secondPath, 'different bytes', 'utf8')
    await expect(fixture.notes.read({ project: 'alpha', note: second.note.id }))
      .rejects.toMatchObject({ code: 'BOARD_INVALID' })
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'update', note: second.note.id, content: 'overwrite',
    }))).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    await writeFile(secondPath, Buffer.alloc(DEVLEAD_NOTES_NOTE_MAX_BYTES + 1, 32))
    await expect(fixture.notes.read({ project: 'alpha', note: second.note.id }))
      .rejects.toMatchObject({ code: 'BOARD_LIMIT_EXCEEDED' })
  })

  it('enforces note size and per-project count limits and ignores orphan bodies', async () => {
    const fixture = await boot()
    await expect(fixture.notes.write(write({
      project: 'alpha', operation: 'create', title: 'too large', content: 'x'.repeat(DEVLEAD_NOTES_NOTE_MAX_BYTES + 1),
    }))).rejects.toMatchObject({ code: 'BOARD_LIMIT_EXCEEDED' })
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
    await fixture.notes.write(write({ project: 'alpha', operation: 'create', note: 'old', title: 'Old title', content: 'x' }))
    await fixture.notes.write(write({ project: 'alpha', operation: 'create', note: 'new', title: 'Latest🙂 title', content: 'y' }))
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
        project: 'alpha', operation: 'create', title: 'Lead note', content: 'body',
      })
      expect(created.note.bytes).toBe(4)
      expect((await harness.service.readBoardNote(harness.lead.agent, {
        project: 'alpha', note: created.note.id,
      })).note?.content).toBe('body')
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
