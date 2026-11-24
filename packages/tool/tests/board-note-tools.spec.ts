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

  it('forwards full-note reads and validates the content-bearing output', async () => {
    const harness = boot()
    const metadata = harness.devLead.boardNoteRead.notes![0]!
    harness.devLead.boardNoteRead = {
      revision: 3,
      updatedAt: metadata.updatedAt,
      project: harness.devLead.boardNoteRead.project,
      note: { ...metadata, content: '# Plan\n\nShip it.\n' },
      truncated: true,
    }
    const result = await harness.call('devlead_board_note_read', { project: 'webapp', note: ' note-1 ' })
    expect(result).toEqual(harness.devLead.boardNoteRead)
    expect(harness.devLead.callsOf('readBoardNote')[0]?.[1]).toEqual({ project: 'webapp', note: 'note-1' })
    expect(validateJsonSchemaValue(harness.tool('devlead_board_note_read').definition.output.schema, result)).toEqual([])
  })

  it('maps every write field, both CAS values, caller, and signal', async () => {
    const harness = boot()
    const exec = makeExec(harness.agent)
    const result = await harness.call('devlead_board_note_write', {
      project: ' webapp ', operation: 'update', note: ' note-1 ', title: 'New title', summary: '',
      content: '# replacement', expected_revision: 3, expected_bytes: 7,
    }, exec)
    expect(result).toEqual(harness.devLead.boardNoteWritten)
    expect(harness.devLead.callsOf('writeBoardNote')[0]).toEqual([
      harness.agent,
      {
        project: 'webapp', operation: 'update', note: 'note-1', title: 'New title', summary: '',
        content: '# replacement', expectedRevision: 3, expectedBytes: 7,
      },
      exec.signal,
    ])
    expect(validateJsonSchemaValue(harness.tool('devlead_board_note_write').definition.output.schema, result)).toEqual([])
  })

  it('supports generated-id create, exact append, and delete result shapes', async () => {
    const harness = boot()
    await harness.call('devlead_board_note_write', {
      project: 'webapp', operation: 'create', title: 'Plan', content: '# Plan',
    })
    await harness.call('devlead_board_note_write', {
      project: 'webapp', operation: 'append', note: 'note-1', content: '\nnext',
    })
    harness.devLead.boardNoteWritten = { ...harness.devLead.boardNoteWritten, operation: 'delete', deleted: true }
    const deleted = await harness.call('devlead_board_note_write', {
      project: 'webapp', operation: 'delete', note: 'note-1', expected_bytes: 7,
    })
    expect(harness.devLead.callsOf('writeBoardNote').map(call => call[1])).toEqual([
      { project: 'webapp', operation: 'create', title: 'Plan', content: '# Plan' },
      { project: 'webapp', operation: 'append', note: 'note-1', content: '\nnext' },
      { project: 'webapp', operation: 'delete', note: 'note-1', expectedBytes: 7 },
    ])
    expect(validateJsonSchemaValue(harness.tool('devlead_board_note_write').definition.output.schema, deleted)).toEqual([])
  })

  it('rejects blanks, invalid CAS values, unknown keys, paths, and missing Agents before service calls', async () => {
    const harness = boot()
    for (const args of [
      { project: ' ', operation: 'create', title: 'x' },
      { project: 'webapp', operation: 'update', note: ' ' },
      { project: 'webapp', operation: 'create', title: 'x', expected_revision: -1 },
      { project: 'webapp', operation: 'update', note: 'n', expected_bytes: -1 },
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

  it('translates project, note, CAS, validation, limit, and I/O errors', async () => {
    const harness = boot()
    for (const code of [
      'BOARD_DISABLED', 'BOARD_PROJECT_NOT_FOUND', 'BOARD_PROJECT_AMBIGUOUS', 'BOARD_NOTE_NOT_FOUND',
      'BOARD_REVISION_CONFLICT', 'BOARD_BYTES_CONFLICT', 'BOARD_INVALID', 'BOARD_LIMIT_EXCEEDED', 'BOARD_IO_ERROR',
    ] as const) {
      harness.devLead.failures.set('writeBoardNote', new DevLeadBoardError(code, code))
      expect((await failureOf(harness.call('devlead_board_note_write', {
        project: 'webapp', operation: 'delete', note: 'note-1',
      }))).code).toBe(code)
    }
  })

  it('presents concise cards without leaking Markdown content or Host paths', async () => {
    const harness = boot()
    harness.devLead.boardNoteRead = {
      revision: 3,
      updatedAt: '2026-01-02T00:00:00.000Z',
      project: { id: 'webapp', directory: 'webapp-0123456789ab' },
      note: {
        id: 'note-1', title: 'Release plan', summary: 'private summary', updatedAt: '2026-01-02T00:00:00.000Z',
        bytes: 18, path: 'webapp-0123456789ab/note-1.md', content: '# secret body',
      },
    }
    const read = harness.tool('devlead_board_note_read').definition.presentResult?.({ project: 'webapp' }, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(harness.devLead.boardNoteRead) }],
    })
    expect(JSON.stringify(read)).toContain('Release plan')
    expect(JSON.stringify(read)).not.toContain('secret body')
    const write = harness.tool('devlead_board_note_write').definition.presentResult?.({
      project: 'webapp', operation: 'update', note: 'note-1',
    }, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(harness.devLead.boardNoteWritten) }],
    })
    expect(JSON.stringify(write)).toContain('update note-1')
    expect(JSON.stringify(write)).not.toContain('webapp-0123456789ab/note-1.md')
  })

  it('uses the same enabled-lead when gate for both tools', async () => {
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
