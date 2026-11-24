/** Host/browser contract of the durable notes index (schema v1). */

import { describe, expect, it } from 'vitest'
import {
  createDevLeadNotesIndexSchema,
  DEVLEAD_NOTES_DIRECTORY_MAX,
  DEVLEAD_NOTES_ID_MAX,
  DEVLEAD_NOTES_INDEX_FILE_NAME,
  DEVLEAD_NOTES_INDEX_MAX_BYTES,
  DEVLEAD_NOTES_MAX_PER_PROJECT,
  DEVLEAD_NOTES_MAX_PROJECTS,
  DEVLEAD_NOTES_DIR_NAME,
  DEVLEAD_NOTES_NOTE_MAX_BYTES,
  DEVLEAD_NOTES_PATH_MAX,
  DEVLEAD_NOTES_READ_MAX_BYTES,
  DEVLEAD_NOTES_SCHEMA_VERSION,
  DEVLEAD_NOTES_SUMMARY_MAX,
  DEVLEAD_NOTES_TIMESTAMP_MAX,
  DEVLEAD_NOTES_TITLE_MAX,
  parseDevLeadNotesIndex,
  type DevLeadNoteMetadata,
  type DevLeadNotesIndex,
  type DevLeadNotesProject,
} from '@yankeguo/dsh-devlead-protocol/client'

const ISO = '2026-11-23T08:00:00.000Z'
const schema = createDevLeadNotesIndexSchema()

function note(id = 'note-1', directory = 'alpha-0123456789ab'): DevLeadNoteMetadata {
  return {
    id,
    title: 'Investigation',
    summary: 'What we learned',
    updatedAt: ISO,
    bytes: 42,
    path: `${directory}/${id}.md`,
  }
}

function project(id = 'alpha', directory = 'alpha-0123456789ab'): DevLeadNotesProject {
  return { id, directory, notes: [note('note-1', directory)] }
}

function index(projects = [project()]): DevLeadNotesIndex {
  return { schemaVersion: 1, revision: 7, updatedAt: ISO, projects }
}

function pointersOf(value: unknown): string[] {
  const parsed = schema.safeParse(value)
  expect(parsed.success).toBe(false)
  if (parsed.success) return []
  return parsed.error.issues.map(issue => `/${issue.path.map(String).join('/')}`)
}

describe('shared notes-index wire contract', () => {
  it('publishes the schema, locations, and all byte/count/text limits', () => {
    expect(DEVLEAD_NOTES_SCHEMA_VERSION).toBe(1)
    expect(DEVLEAD_NOTES_DIR_NAME).toBe('notes')
    expect(DEVLEAD_NOTES_INDEX_FILE_NAME).toBe('index.json')
    expect(DEVLEAD_NOTES_INDEX_MAX_BYTES).toBe(128 * 1024)
    expect(DEVLEAD_NOTES_NOTE_MAX_BYTES).toBe(256 * 1024)
    expect(DEVLEAD_NOTES_READ_MAX_BYTES).toBe(64 * 1024)
    expect(DEVLEAD_NOTES_MAX_PROJECTS).toBe(50)
    expect(DEVLEAD_NOTES_MAX_PER_PROJECT).toBe(100)
    expect(DEVLEAD_NOTES_ID_MAX).toBe(128)
    expect(DEVLEAD_NOTES_DIRECTORY_MAX).toBe(128)
    expect(DEVLEAD_NOTES_TITLE_MAX).toBe(200)
    expect(DEVLEAD_NOTES_SUMMARY_MAX).toBe(500)
    expect(DEVLEAD_NOTES_PATH_MAX).toBe(512)
    expect(DEVLEAD_NOTES_TIMESTAMP_MAX).toBe(64)
  })

  it('accepts empty and complete indexes without admitting note content', () => {
    const empty = index([])
    expect(schema.parse(empty)).toEqual(empty)
    const value = index()
    expect(schema.parse(value)).toEqual(value)
    expect(parseDevLeadNotesIndex(value)).toEqual(value)
    expect(JSON.stringify(value)).not.toContain('content')
    expect(pointersOf({ ...value, projects: [{ ...project(), notes: [{ ...note(), content: 'secret' }] }] }))
      .toContain('/projects/0/notes/0')
  })

  it('allows the same note id in different projects but not duplicate paths', () => {
    const accepted = index([
      project('alpha', 'alpha-0123456789ab'),
      project('beta', 'beta-0123456789ab'),
    ])
    expect(schema.safeParse(accepted).success).toBe(true)
    expect(pointersOf(index([project(), project('beta', project().directory)])))
      .toContain('/projects/1/directory')
  })

  it.each([
    ['duplicate project id', index([project(), project()]), '/projects/1/id'],
    ['duplicate note id', index([{ ...project(), notes: [note(), note()] }]), '/projects/0/notes/1/id'],
    ['case-insensitive duplicate note id', index([{ ...project(), notes: [note('CaseNote'), note('casenote')] }]), '/projects/0/notes/1/id'],
    ['case-insensitive duplicate note path', index([{ ...project(), notes: [note('CaseNote'), note('casenote')] }]), '/projects/0/notes/1/path'],
    ['wrong metadata path', index([{ ...project(), notes: [{ ...note(), path: 'other/note-1.md' }] }]), '/projects/0/notes/0/path'],
  ])('rejects %s', (_label, value, pointer) => {
    expect(pointersOf(value)).toContain(pointer)
  })

  it.each(['CON', 'con.txt', 'PRN.', 'aux...', 'NUL .md', 'COM1', 'com9.backup', 'LPT1', 'lpt9.'])(
    'rejects a Windows reserved note id variant: %s',
    id => {
      expect(pointersOf(index([{ ...project(), notes: [note(id)] }]))).toContain('/projects/0/notes/0/id')
    },
  )

  it('rejects reserved project directories while accepting ordinary COM10/LPT0 names', () => {
    for (const directory of ['con', 'prn.txt', 'aux.', 'nul...', 'com1', 'lpt9.md']) {
      expect(pointersOf(index([project('alpha', directory)]))).toContain('/projects/0/directory')
    }
    expect(schema.safeParse(index([{ ...project(), notes: [note('COM10'), note('LPT0')] }])).success).toBe(true)
  })

  it.each([
    '../escape',
    'alpha/../note-1.md',
    '/absolute/note-1.md',
    'alpha\\note-1.md',
    'alpha//note-1.md',
    './note-1.md',
  ])('rejects traversal, absolute, backslash, and empty path segments: %s', path => {
    expect(pointersOf(index([{ ...project(), notes: [{ ...note(), path }] }])))
      .toContain('/projects/0/notes/0/path')
  })

  it.each(['../escape', '.hidden', 'a/b', 'a\\b', '-leading', 'white space', ''])(
    'rejects an unsafe caller-supplied note id %s',
    id => {
      expect(pointersOf(index([{ ...project(), notes: [{ ...note(), id }] }])))
        .toContain('/projects/0/notes/0/id')
    },
  )

  it('rejects unknown fields at every strict object level', () => {
    const extra = { extra: true }
    expect(pointersOf({ ...index(), ...extra })).toContain('/')
    expect(pointersOf(index([{ ...project(), ...extra }]))).toContain('/projects/0')
    expect(pointersOf(index([{ ...project(), notes: [{ ...note(), ...extra }] }])))
      .toContain('/projects/0/notes/0')
  })

  it('enforces revision, timestamp, and note byte limits', () => {
    expect(pointersOf({ ...index(), revision: -1 })).toContain('/revision')
    expect(pointersOf({ ...index(), revision: 1.5 })).toContain('/revision')
    expect(pointersOf({ ...index(), updatedAt: '2026-11-23T08:00:00+08:00' })).toContain('/updatedAt')
    expect(pointersOf(index([{ ...project(), notes: [{ ...note(), bytes: -1 }] }])))
      .toContain('/projects/0/notes/0/bytes')
    expect(pointersOf(index([{ ...project(), notes: [{ ...note(), bytes: DEVLEAD_NOTES_NOTE_MAX_BYTES + 1 }] }])))
      .toContain('/projects/0/notes/0/bytes')
  })

  it('enforces project and per-project note count limits', () => {
    const projects = Array.from({ length: DEVLEAD_NOTES_MAX_PROJECTS + 1 }, (_, position) =>
      project(`p${position}`, `p${position}-0123456789ab`))
    expect(pointersOf(index(projects))).toContain('/projects')
    const notes = Array.from({ length: DEVLEAD_NOTES_MAX_PER_PROJECT + 1 }, (_, position) => note(`n${position}`))
    expect(pointersOf(index([{ ...project(), notes }]))).toContain('/projects/0/notes')
  })

  it('enforces id, directory, title, summary, and path length limits', () => {
    expect(pointersOf(index([{ ...project(), id: 'x'.repeat(DEVLEAD_NOTES_ID_MAX + 1) }])))
      .toContain('/projects/0/id')
    expect(pointersOf(index([{ ...project(), directory: 'x'.repeat(DEVLEAD_NOTES_DIRECTORY_MAX + 1) }])))
      .toContain('/projects/0/directory')
    expect(pointersOf(index([{ ...project(), notes: [{ ...note(), title: 'x'.repeat(DEVLEAD_NOTES_TITLE_MAX + 1) }] }])))
      .toContain('/projects/0/notes/0/title')
    expect(pointersOf(index([{ ...project(), notes: [{ ...note(), summary: 'x'.repeat(DEVLEAD_NOTES_SUMMARY_MAX + 1) }] }])))
      .toContain('/projects/0/notes/0/summary')
    expect(pointersOf(index([{ ...project(), notes: [{ ...note(), path: 'x'.repeat(DEVLEAD_NOTES_PATH_MAX + 1) }] }])))
      .toContain('/projects/0/notes/0/path')
  })
})
