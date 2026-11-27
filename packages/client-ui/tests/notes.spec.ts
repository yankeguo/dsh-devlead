/** Notes location, strict decoding, and metadata-only path confinement. */
import { describe, expect, it } from 'vitest'
import type { DevLeadNoteMetadata } from '../src/client/notes.ts'
import {
  deriveDevLeadNotesPaths,
  parseDevLeadNotesIndexBytes,
  resolveDevLeadNotePath,
} from '../src/client/notes.ts'

const INDEX = {
  schemaVersion: 1,
  revision: 1,
  updatedAt: '2026-11-23T08:00:00.000Z',
  projects: [{
    id: 'project',
    directory: 'project-dir',
    notes: [{
      id: 'note', title: 'Note', summary: '', updatedAt: '2026-11-23T08:00:00.000Z', bytes: 4, path: 'project-dir/note.md',
    }],
  }],
}

function encoded(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>
}

describe('notes paths and decoder', () => {
  it('derives notes/index.json beside POSIX and Windows boards', () => {
    expect(deriveDevLeadNotesPaths({ boardFilePath: '/work/.dsh/devlead/board.json', schemaVersion: 1, pathPlatform: 'posix' })).toEqual({
      root: '/work/.dsh/devlead/notes', indexPath: '/work/.dsh/devlead/notes/index.json', pathPlatform: 'posix',
    })
    expect(deriveDevLeadNotesPaths({ boardFilePath: 'C:\\work\\.dsh\\devlead\\board.json', schemaVersion: 1, pathPlatform: 'win32' })).toEqual({
      root: 'C:\\work\\.dsh\\devlead\\notes', indexPath: 'C:\\work\\.dsh\\devlead\\notes\\index.json', pathPlatform: 'win32',
    })
  })

  it('joins only validated metadata beneath the fixed root', () => {
    const paths = deriveDevLeadNotesPaths({ boardFilePath: '/work/board.json', schemaVersion: 1, pathPlatform: 'posix' })
    const metadata = INDEX.projects[0]!.notes[0]!
    expect(resolveDevLeadNotePath(paths, metadata)).toBe('/work/notes/project-dir/note.md')
    for (const path of ['../outside.md', '/tmp/outside.md', 'project-dir/../../outside.md', 'project-dir\\outside.md']) {
      expect(() => resolveDevLeadNotePath(paths, { ...metadata, path })).toThrow('notes root')
    }
    // Type bypass emulates untrusted metadata at the final path boundary.
    expect(() => resolveDevLeadNotePath(paths, { ...metadata, path: 'project-dir/note.md\0' } as DevLeadNoteMetadata)).toThrow()
  })

  it('uses the shared strict schema and maps malformed JSON/schema to parse errors', () => {
    expect(parseDevLeadNotesIndexBytes(encoded(INDEX))).toEqual(INDEX)
    expect(() => parseDevLeadNotesIndexBytes(new TextEncoder().encode('{bad'))).toThrow('not valid JSON')
    expect(() => parseDevLeadNotesIndexBytes(encoded({
      ...INDEX,
      projects: [{ ...INDEX.projects[0]!, notes: [{ ...INDEX.projects[0]!.notes[0]!, path: '../outside.md' }] }],
    }))).toThrow('notes schema v1 validation failed')
    expect(() => parseDevLeadNotesIndexBytes(encoded({ ...INDEX, extra: true }))).toThrow('notes schema v1 validation failed')
  })

  it('rejects case-only collisions and Windows reserved names through the shared schema', () => {
    const project = INDEX.projects[0]!
    const metadata = project.notes[0]!
    const withNotes = (notes: Array<Record<string, unknown>>) => encoded({
      ...INDEX,
      projects: [{ ...project, notes: notes.map(note => ({ ...metadata, ...note })) }],
    })
    expect(() => parseDevLeadNotesIndexBytes(withNotes([
      { id: 'CaseNote', path: 'project-dir/CaseNote.md' },
      { id: 'casenote', path: 'project-dir/casenote.md' },
    ]))).toThrow('notes schema v1 validation failed')
    for (const id of ['CON', 'prn.txt', 'AUX.', 'com1', 'LPT9.md']) {
      expect(() => parseDevLeadNotesIndexBytes(withNotes([{ id, path: `project-dir/${id}.md` }])))
        .toThrow('notes schema v1 validation failed')
    }
  })
})
