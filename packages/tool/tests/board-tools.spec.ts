/** Board tool forwarding, validation, errors, presentation, and dynamic context. */

import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { DevLeadBoardError } from '@yankeguo/dsh-devlead'
import { BOARD_PROJECT, boot, makeExec } from './harness.ts'

async function failureOf(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected tool call to reject')
}

describe('devlead board tools', () => {
  it('forwards read filters and preserves the bounded read result', async () => {
    const harness = boot()
    const result = await harness.call('devlead_board_read', { project: ' webapp ', include_tasks: false, limit: 5 })
    expect(result).toEqual(harness.devLead.boardRead)
    expect(harness.devLead.callsOf('board.read')[0]?.[0]).toEqual({
      project: 'webapp', includeTasks: false, limit: 5,
    })
    expect(validateJsonSchemaValue(harness.tool('devlead_board_read').definition.output.schema, result)).toEqual([])
  })

  it('preserves bounded read truncation and summarizes large listings', async () => {
    const harness = boot()
    const { tasks: _tasks, ...summaryProject } = BOARD_PROJECT
    harness.devLead.boardRead = {
      ...harness.devLead.boardRead,
      projects: Array.from({ length: 50 }, (_, index) => ({ ...summaryProject, id: `project-${index}` })),
      truncated: true,
    }
    const result = await harness.call('devlead_board_read', { limit: 50 })
    expect(result).toEqual(harness.devLead.boardRead)
    expect(validateJsonSchemaValue(harness.tool('devlead_board_read').definition.output.schema, result)).toEqual([])
    const presented = harness.tool('devlead_board_read').definition.presentResult?.({ limit: 50 }, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    })
    expect(JSON.stringify(presented)).toContain('50 project(s) (truncated)')
    expect(JSON.stringify(presented)).not.toContain('/tmp/webapp')
    expect(JSON.stringify(presented).length).toBeLessThan(200)
  })

  it('validates read arguments before touching the service', async () => {
    const harness = boot()
    expect((await failureOf(harness.call('devlead_board_read', { project: '  ' }))).code).toBe('DEVLEAD_INVALID_INPUT')
    expect((await failureOf(harness.call('devlead_board_read', { limit: 0 }))).code).toBe('DEVLEAD_INVALID_INPUT')
    expect((await failureOf(harness.call('devlead_board_read', { boardPath: '/tmp/other.json' }))).code)
      .toBe('DEVLEAD_INVALID_INPUT')
    expect(harness.devLead.callsOf('board.read')).toHaveLength(0)
  })

  it('maps read service failures into stable tool errors', async () => {
    const harness = boot()
    for (const code of ['BOARD_DISABLED', 'BOARD_NOT_FOUND', 'BOARD_PROJECT_AMBIGUOUS', 'BOARD_IO_ERROR'] as const) {
      harness.devLead.failures.set('board.read', new DevLeadBoardError(code, code))
      expect((await failureOf(harness.call('devlead_board_read'))).code).toBe(code)
    }
  })

  it('maps the complete update patch, CAS revision, caller, and signal', async () => {
    const harness = boot()
    const exec = makeExec(harness.agent)
    const result = await harness.call('devlead_board_update', {
      project: ' webapp ',
      expected_revision: 7,
      create: true,
      set: {
        status: 'blocked', priority: 'high', goal: 'goal', focus: 'focus', next: 'next',
        workspace: { path: '/tmp/webapp', title: 'Web app' },
      },
      blockers: {
        clear: true,
        remove: ['old'],
        add: [{ id: 'b1', text: 'waiting', session_id: 'session-blocker' }],
      },
      tasks: {
        remove: ['old-task'],
        upsert: [{ id: 't1', title: 'task', status: 'doing', owner_session_id: 'session-owner' }],
      },
    }, exec)
    const { tasks: _tasks, ...project } = harness.devLead.boardUpdated.project
    expect(result).toEqual({ ...harness.devLead.boardUpdated, project })
    expect(result).not.toHaveProperty('project.tasks')
    const call = harness.devLead.callsOf('updateBoard')[0]
    expect(call?.[0]).toBe(harness.agent)
    expect(call?.[1]).toEqual({
      project: 'webapp',
      create: true,
      set: {
        status: 'blocked', priority: 'high', goal: 'goal', focus: 'focus', next: 'next',
        workspace: { path: '/tmp/webapp', title: 'Web app' },
      },
      blockers: {
        clear: true,
        remove: ['old'],
        add: [{ id: 'b1', text: 'waiting', sessionId: 'session-blocker' }],
      },
      tasks: {
        remove: ['old-task'],
        upsert: [{ id: 't1', title: 'task', status: 'doing', ownerSessionId: 'session-owner' }],
      },
    })
    expect(call?.[2]).toBe(7)
    expect(call?.[3]).toBe(exec.signal)
    expect(validateJsonSchemaValue(harness.tool('devlead_board_update').definition.output.schema, result)).toEqual([])
  })

  it('bounds update results even when a legacy Host returns every task', async () => {
    const harness = boot()
    harness.devLead.boardUpdated = {
      ...harness.devLead.boardUpdated,
      project: {
        ...BOARD_PROJECT,
        tasks: Array.from({ length: 200 }, (_, index) => ({
          id: `task-${index}`,
          title: `task-${index}-${'x'.repeat(4_000)}`,
          status: 'todo' as const,
          updatedAt: '2026-01-02T00:00:00.000Z',
        })),
      },
    }
    expect(JSON.stringify(harness.devLead.boardUpdated).length).toBeGreaterThan(200_000)
    const result = await harness.call('devlead_board_update', { project: 'webapp' })
    expect(result).not.toHaveProperty('project.tasks')
    expect(result).toMatchObject({
      revision: 8,
      updatedAt: '2026-01-02T00:00:00.000Z',
      changed: ['set.focus'],
      project: { id: 'webapp', goal: 'ship', focus: 'tests', next: 'verify', blockers: [] },
    })
    expect(JSON.stringify(result)).not.toContain('task-199')
    expect(JSON.stringify(result).length).toBeLessThan(1_024)
    const schema = harness.tool('devlead_board_update').definition.output.schema
    expect(validateJsonSchemaValue(schema, result)).toEqual([])
    expect(validateJsonSchemaValue(schema, harness.devLead.boardUpdated)).not.toEqual([])
  })

  it('rejects invalid update input and requires the lead Agent', async () => {
    const harness = boot()
    expect((await failureOf(harness.call('devlead_board_update', { project: ' ' }))).code).toBe('DEVLEAD_INVALID_INPUT')
    expect((await failureOf(harness.call('devlead_board_update', { project: 'p', expected_revision: -1 }))).code)
      .toBe('DEVLEAD_INVALID_INPUT')
    expect((await failureOf(harness.call('devlead_board_update', { project: 'p', path: '/tmp/board.json' }))).code)
      .toBe('DEVLEAD_INVALID_INPUT')
    expect((await failureOf(harness.call('devlead_board_update', { project: 'p' }, makeExec(undefined)))).code)
      .toBe('DEVLEAD_AGENT_NOT_LIVE')
    expect(harness.devLead.callsOf('updateBoard')).toHaveLength(0)
  })

  it('translates revision, validation, project, and limit failures', async () => {
    const harness = boot()
    for (const code of [
      'BOARD_REVISION_CONFLICT', 'BOARD_INVALID', 'BOARD_PROJECT_NOT_FOUND', 'BOARD_PROJECT_AMBIGUOUS',
      'BOARD_LIMIT_EXCEEDED', 'BOARD_IO_ERROR',
    ] as const) {
      harness.devLead.failures.set('updateBoard', new DevLeadBoardError(code, code))
      expect((await failureOf(harness.call('devlead_board_update', { project: 'webapp' }))).code).toBe(code)
    }
  })

  it('presents only result summaries rather than complete projects', async () => {
    const harness = boot()
    const readResult = harness.tool('devlead_board_read').definition.presentResult?.({}, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(harness.devLead.boardRead) }],
    })
    expect(readResult).toMatchObject({ card: 'generic' })
    expect(JSON.stringify(readResult)).toContain('1 project(s)')
    expect(JSON.stringify(readResult)).not.toContain('/tmp/webapp')
    const updateResult = harness.tool('devlead_board_update').definition.presentResult?.({ project: 'webapp' }, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(harness.devLead.boardUpdated) }],
    })
    expect(JSON.stringify(updateResult)).toContain('changed set.focus')
    expect(JSON.stringify(updateResult)).not.toContain('ship')
  })

  it('truncates oversized update summaries instead of exposing result fields', () => {
    const harness = boot()
    harness.devLead.boardUpdated = {
      ...harness.devLead.boardUpdated,
      changed: Array.from({ length: 100 }, (_, index) => `set.${'long-field-'.repeat(4)}${index}`),
    }
    const presented = harness.tool('devlead_board_update').definition.presentResult?.({ project: 'webapp' }, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(harness.devLead.boardUpdated) }],
    })
    expect(presented).toMatchObject({ card: 'generic' })
    expect(JSON.stringify(presented).length).toBeLessThan(600)
    expect(JSON.stringify(presented)).not.toContain('ship')
    expect(JSON.stringify(presented)).not.toContain('/tmp/webapp')
  })

  it('resolves cache-safe board context only for an enabled lead', () => {
    const harness = boot()
    const agent = harness.agent
    expect(harness.boardContext.name).toBe('devlead:board-summary')
    expect(harness.boardContext.order).toBe(220)
    expect(harness.boardSummaryText(agent)).toBe('')
    expect(harness.boardSummaryText(undefined)).toBe('')
    harness.devLead.enabled.add(agent.id)
    const first = harness.boardSummaryText(agent)
    expect(first).toBe(harness.devLead.boardSummary)
    expect(harness.boardSummaryText(agent)).toBe(first)
    harness.devLead.boardSummary = 'DevLead board r8 changed'
    expect(harness.boardSummaryText(agent)).toBe('DevLead board r8 changed')
    harness.devLead.enabled.delete(agent.id)
    expect(harness.boardSummaryText(agent)).toBe('')
  })
})
