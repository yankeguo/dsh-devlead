/** Note tool forwarding, schemas, validation, errors, presentation, and gating. */

import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { DevLeadBoardError } from '@yankeguo/dsh-devlead'
import { boot, makeExec } from './harness.ts'

async function failureOf(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected note tool call to reject')
}

describe('devlead board note tools', () => {
  it('describes metadata-only reads, native body access, and index-only mutations', () => {
    const harness = boot()
    const read = harness.tool('devlead_board_note_read').definition.description
    const write = harness.tool('devlead_board_note_write').definition.description
    expect(read).toContain('Read only the notes index')
    expect(read).toContain('never returns Markdown bodies')
    expect(read).toContain('absolutePath')
    expect(read).toContain('DSH-native read/write/edit')
    expect(read).toContain('never edit notes/index.json directly')
    expect(read).not.toContain('Prefer this list/read interface over direct filesystem reads')
    expect(read).not.toContain('capped at 64 KiB')
    expect(read).not.toContain('truncated')
    expect(write).toContain('create makes an empty Markdown file and returns its absolutePath')
    expect(write).toContain('update-metadata changes only title/summary')
    expect(write).toContain('never returns or accepts Markdown bodies')
    expect(write).toContain('DSH-native read/write/edit')
    expect(write).toContain('expected_revision')
    expect(write).not.toContain('expected_bytes')
  })

  it('exposes only create/update-metadata/delete and no body content parameter', () => {
    const harness = boot()
    const parameters = harness.tool('devlead_board_note_write').definition.parameters as {
      properties: Record<string, { enum?: readonly string[]; description?: string }>
    }
    expect(parameters.properties.operation?.enum).toEqual(['create', 'update-metadata', 'delete'])
    expect(parameters.properties).not.toHaveProperty('expected_bytes')
    expect(parameters.properties).not.toHaveProperty('content')
    expect(parameters.properties.title?.description).toContain('update-metadata')
    expect(parameters.properties.summary?.description).toContain('update-metadata')
  })

  it('forwards metadata reads and preserves the canonical result', async () => {
    const harness = boot()
    const result = await harness.call('devlead_board_note_read', { project: ' webapp ' })
    expect(result).toEqual(harness.devLead.boardNoteRead)
    expect(harness.devLead.callsOf('readBoardNote')[0]).toEqual([
      harness.agent,
      { project: 'webapp' },
    ])
    expect(validateJsonSchemaValue(harness.tool('devlead_board_note_read').definition.output.schema, result)).toEqual([])
  })

  it('forwards single-note metadata reads without content or truncation fields', async () => {
    const harness = boot()
    const metadata = harness.devLead.boardNoteRead.notes![0]!
    harness.devLead.boardNoteRead = {
      revision: 3,
      updatedAt: metadata.updatedAt,
      project: harness.devLead.boardNoteRead.project,
      note: metadata,
    }
    const result = await harness.call('devlead_board_note_read', { project: 'webapp', note: ' note-1 ' })
    expect(result).toEqual(harness.devLead.boardNoteRead)
    expect(result).not.toHaveProperty('note.content')
    expect(result).not.toHaveProperty('truncated')
    expect(harness.devLead.callsOf('readBoardNote')[0]?.[1]).toEqual({ project: 'webapp', note: 'note-1' })
    const schema = harness.tool('devlead_board_note_read').definition.output.schema
    expect(validateJsonSchemaValue(schema, result)).toEqual([])
    expect(validateJsonSchemaValue(schema, {
      ...harness.devLead.boardNoteRead, truncated: true, note: { ...metadata, content: '# Plan\n\nShip it.\n' },
    })).not.toEqual([])
  })

  it('maps metadata-only updates, index CAS, caller, and signal', async () => {
    const harness = boot()
    const exec = makeExec(harness.agent)
    const result = await harness.call('devlead_board_note_write', {
      project: ' webapp ', operation: 'update-metadata', note: ' note-1 ', title: 'New title', summary: '',
      expected_revision: 3,
    }, exec)
    expect(result).toEqual(harness.devLead.boardNoteWritten)
    expect(harness.devLead.callsOf('writeBoardNote')[0]).toEqual([
      harness.agent,
      {
        project: 'webapp', operation: 'update-metadata', note: 'note-1', title: 'New title', summary: '',
        expectedRevision: 3,
      },
      exec.signal,
    ])
    expect(validateJsonSchemaValue(harness.tool('devlead_board_note_write').definition.output.schema, result)).toEqual([])
  })

  it('supports generated-id create with an empty-body contract and delete', async () => {
    const harness = boot()
    harness.devLead.boardNoteWritten = { ...harness.devLead.boardNoteWritten, operation: 'create' }
    const created = await harness.call('devlead_board_note_write', {
      project: 'webapp', operation: 'create', title: 'Plan', summary: 'handoff',
    })
    expect(created).toMatchObject({ operation: 'create', note: { absolutePath: expect.any(String) } })
    expect(created).not.toHaveProperty('note.content')
    expect(created).not.toHaveProperty('truncated')
    expect(validateJsonSchemaValue(harness.tool('devlead_board_note_write').definition.output.schema, created)).toEqual([])
    await harness.call('devlead_board_note_write', {
      project: 'webapp', operation: 'create', title: 'Empty note',
    })
    harness.devLead.boardNoteWritten = { ...harness.devLead.boardNoteWritten, operation: 'delete', deleted: true }
    const deleted = await harness.call('devlead_board_note_write', {
      project: 'webapp', operation: 'delete', note: 'note-1', expected_revision: 3,
    })
    expect(harness.devLead.callsOf('writeBoardNote').map(call => call[1])).toEqual([
      { project: 'webapp', operation: 'create', title: 'Plan', summary: 'handoff' },
      { project: 'webapp', operation: 'create', title: 'Empty note' },
      { project: 'webapp', operation: 'delete', note: 'note-1', expectedRevision: 3 },
    ])
    expect(deleted).toMatchObject({ operation: 'delete', note: { absolutePath: expect.any(String) } })
    expect(validateJsonSchemaValue(harness.tool('devlead_board_note_write').definition.output.schema, deleted)).toEqual([])
  })

  it('rejects blanks, invalid CAS, removed body fields, paths, and missing Agents before service calls', async () => {
    const harness = boot()
    for (const args of [
      { project: ' ', operation: 'create', title: 'x' },
      { project: 'webapp', operation: 'update-metadata', note: ' ' },
      { project: 'webapp', operation: 'create', title: 'x', expected_revision: -1 },
      { project: 'webapp', operation: 'create', title: 'x', content: '# Plan' },
      { project: 'webapp', operation: 'update-metadata', note: 'n', content: 'replacement' },
      { project: 'webapp', operation: 'delete', note: 'n', content: '' },
      { project: 'webapp', operation: 'update-metadata', note: 'n', expected_bytes: 7 },
      { project: 'webapp', operation: 'delete', note: 'n', expected_bytes: -1 },
      { project: 'webapp', operation: 'create', title: 'x', path: '/tmp/note.md' },
    ]) {
      expect((await failureOf(harness.call('devlead_board_note_write', args))).code).toBe('DEVLEAD_INVALID_INPUT')
    }
    expect((await failureOf(harness.call('devlead_board_note_read', { project: 'webapp', path: 'x.md' }))).code)
      .toBe('DEVLEAD_INVALID_INPUT')
    expect((await failureOf(harness.call('devlead_board_note_read', { project: 'webapp' }, makeExec(undefined)))).code)
      .toBe('DEVLEAD_AGENT_NOT_LIVE')
    expect((await failureOf(harness.call(
      'devlead_board_note_write',
      { project: 'webapp', operation: 'create', title: 'x' },
      makeExec(undefined),
    ))).code).toBe('DEVLEAD_AGENT_NOT_LIVE')
    expect(harness.devLead.callsOf('readBoardNote')).toHaveLength(0)
    expect(harness.devLead.callsOf('writeBoardNote')).toHaveLength(0)
  })

  it('translates project, note, index-CAS, validation, limit, and I/O errors', async () => {
    const harness = boot()
    for (const code of [
      'BOARD_DISABLED', 'BOARD_PROJECT_NOT_FOUND', 'BOARD_PROJECT_AMBIGUOUS', 'BOARD_NOTE_NOT_FOUND',
      'BOARD_REVISION_CONFLICT', 'BOARD_INVALID', 'BOARD_LIMIT_EXCEEDED', 'BOARD_IO_ERROR',
    ] as const) {
      harness.devLead.failures.set('writeBoardNote', new DevLeadBoardError(code, code))
      expect((await failureOf(harness.call('devlead_board_note_write', {
        project: 'webapp', operation: 'delete', note: 'note-1',
      }))).code).toBe(code)
    }
  })

  it('presents concise cards without leaking Markdown content or Host paths', async () => {
    const harness = boot()
    const legacyReadResult = {
      revision: 3,
      updatedAt: '2026-01-02T00:00:00.000Z',
      project: { id: 'webapp', directory: 'webapp-0123456789ab' },
      note: {
        id: 'note-1', title: 'Release plan', summary: 'private summary', updatedAt: '2026-01-02T00:00:00.000Z',
        bytes: 18, path: 'webapp-0123456789ab/note-1.md',
        absolutePath: '/private/lead/notes/webapp-0123456789ab/note-1.md', content: '# secret body',
      },
    }
    const read = harness.tool('devlead_board_note_read').definition.presentResult?.({ project: 'webapp' }, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(legacyReadResult) }],
    })
    expect(JSON.stringify(read)).toContain('Release plan')
    expect(JSON.stringify(read)).not.toContain('secret body')
    expect(JSON.stringify(read)).not.toContain('/private/lead/notes')
    const write = harness.tool('devlead_board_note_write').definition.presentResult?.({
      project: 'webapp', operation: 'update-metadata', note: 'note-1',
    }, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(harness.devLead.boardNoteWritten) }],
    })
    expect(JSON.stringify(write)).toContain('update-metadata note-1')
    expect(JSON.stringify(write)).not.toContain('webapp-0123456789ab/note-1.md')
    expect(JSON.stringify(write)).not.toContain('/tmp/lead/.dsh/devlead/notes')
  })

  it('keeps both read and index-only write tools behind the same enabled-lead gate', async () => {
    const harness = boot()
    for (const name of ['devlead_board_note_read', 'devlead_board_note_write']) {
      expect(await harness.visible(harness.agent, name)).toBe(false)
      harness.devLead.enabled.add(harness.agent.id)
      expect(await harness.visible(harness.agent, name)).toBe(true)
      harness.devLead.enabled.delete(harness.agent.id)
      expect(await harness.visible(harness.agent, name)).toBe(false)
    }
  })
})
