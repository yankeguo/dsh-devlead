/** Pure browser-side schema, grouping, sorting, and formatting tests. */
import { describe, expect, it } from 'vitest'
import {
  boardRelativeTime,
  compareDevLeadBoardProjects,
  DEVLEAD_BOARD_MAX_BYTES,
  DevLeadBoardParseError,
  groupDevLeadBoardProjects,
  parseDevLeadBoard,
  parseDevLeadBoardBytes,
  projectStatusTone,
  readDevLeadBoardConfig,
  taskProgress,
  taskStatusTone,
  truncateSessionId,
  unlistedDevLeadWorkspaces,
  type DevLeadBoard,
  type DevLeadBoardPriority,
  type DevLeadBoardProject,
  type DevLeadBoardProjectStatus,
} from '../src/client/board.ts'

const NOW = Date.UTC(2026, 10, 23, 8, 0, 0)
const ISO = '2026-11-23T08:00:00.000Z'

function project(
  id: string,
  status: DevLeadBoardProjectStatus = 'active',
  priority: DevLeadBoardPriority = 'medium',
  updatedAt = ISO,
): DevLeadBoardProject {
  return {
    id,
    workspace: { path: `/work/${id}`, title: id },
    status,
    priority,
    goal: `goal ${id}`,
    focus: `focus ${id}`,
    next: `next ${id}`,
    blockers: status === 'blocked' ? [{ id: 'b1', text: 'waiting', since: ISO }] : [],
    tasks: [
      { id: 't1', title: 'done task', status: 'done', updatedAt: ISO },
      { id: 't2', title: 'open task', status: 'todo', ownerSessionId: 'session-1234567890abcdef', updatedAt: ISO },
    ],
    updatedAt,
  }
}

function board(projects: DevLeadBoardProject[] = [project('one')]): DevLeadBoard {
  return {
    schemaVersion: 1,
    revision: 7,
    updatedAt: ISO,
    updatedBy: { sessionId: 'session-lead', title: 'DevLead' },
    projects,
  }
}

describe('board config and schema', () => {
  it('accepts only a complete current absolute-path global', () => {
    expect(readDevLeadBoardConfig({ boardPath: '/work/.dsh/board.json', schemaVersion: 1, pathPlatform: 'posix' })).toEqual({
      boardPath: '/work/.dsh/board.json', schemaVersion: 1, pathPlatform: 'posix',
    })
    expect(readDevLeadBoardConfig({ boardPath: 'C:\\work\\board.json', schemaVersion: 1, pathPlatform: 'win32' })).toEqual({
      boardPath: 'C:\\work\\board.json', schemaVersion: 1, pathPlatform: 'win32',
    })
    for (const value of [
      undefined,
      null,
      {},
      { boardPath: 'relative/board.json', schemaVersion: 1 },
      { boardPath: '/work/board.json', schemaVersion: 2 },
      { boardPath: '', schemaVersion: 1 },
    ]) expect(readDevLeadBoardConfig(value)).toBeUndefined()
  })

  it('round-trips a valid board without changing project order in the decoder', () => {
    const value = board([project('z'), project('a')])
    expect(parseDevLeadBoard(JSON.stringify(value))).toEqual(value)
  })

  it.each([
    ['invalid JSON', '{'],
    ['unknown root fields', JSON.stringify({ ...board(), extra: true })],
    ['wrong schema version', JSON.stringify({ ...board(), schemaVersion: 2 })],
    ['relative workspace', JSON.stringify(board([{ ...project('one'), workspace: { path: 'work/one', title: 'one' } }]))],
    ['duplicate project ids', JSON.stringify(board([project('same'), project('same')]))],
    ['duplicate task ids', JSON.stringify(board([{
      ...project('one'),
      tasks: [
        { id: 'same', title: 'one', status: 'todo', updatedAt: ISO },
        { id: 'same', title: 'two', status: 'done', updatedAt: ISO },
      ],
    }]))],
  ])('rejects %s with a parse error', (_label, text) => {
    expect(() => parseDevLeadBoard(text)).toThrow(DevLeadBoardParseError)
  })

  it('uses POSIX absolute-path semantics for a POSIX board location', () => {
    const windows = board([{ ...project('one'), workspace: { path: 'C:\\work\\one', title: 'one' } }])
    expect(() => parseDevLeadBoard(JSON.stringify(windows), 'posix')).toThrow(/workspace path must be absolute/u)
    expect(() => parseDevLeadBoard(JSON.stringify(windows))).toThrow(/workspace path must be absolute/u)
  })

  it.each([
    'C:\\work\\one',
    'C:/work/one',
    '\\\\work\\one',
    '\\\\server\\share\\one',
    '/work/one',
  ])('accepts the Windows absolute path %s for a Windows board location', path => {
    const value = board([{ ...project('one'), workspace: { path, title: 'one' } }])
    expect(parseDevLeadBoard(JSON.stringify(value), 'win32').projects[0]?.workspace.path).toBe(path)
  })

  it('rejects a drive-relative Windows path', () => {
    const value = board([{ ...project('one'), workspace: { path: 'C:work\\one', title: 'one' } }])
    expect(() => parseDevLeadBoard(JSON.stringify(value), 'win32')).toThrow(/workspace path must be absolute/u)
  })

  it('decodes UTF-8 fatally and enforces the 256 KiB bound before decoding', () => {
    const encoded = new TextEncoder().encode(JSON.stringify(board()))
    expect(parseDevLeadBoardBytes(encoded)).toEqual(board())
    expect(() => parseDevLeadBoardBytes(new Uint8Array([0xff]))).toThrow(/UTF-8/u)
    expect(() => parseDevLeadBoardBytes(new Uint8Array(DEVLEAD_BOARD_MAX_BYTES + 1))).toThrow(/exceeds/u)
  })
})

describe('board grouping and presentation helpers', () => {
  it('puts blocked first, then active/paused/done, omitting empty groups', () => {
    const value = board([
      project('done', 'done'),
      project('active', 'active'),
      project('blocked', 'blocked'),
      project('paused', 'paused'),
    ])
    expect(groupDevLeadBoardProjects(value).map(group => group.status)).toEqual([
      'blocked', 'active', 'paused', 'done',
    ])
    expect(groupDevLeadBoardProjects(board([]))).toEqual([])
  })

  it('sorts each group by priority, descending updatedAt, then stable id', () => {
    const projects = [
      project('low-new', 'active', 'low', '2026-11-23T07:00:00.000Z'),
      project('high-old', 'active', 'high', '2026-11-22T07:00:00.000Z'),
      project('medium', 'active', 'medium'),
      project('high-new', 'active', 'high', '2026-11-23T07:00:00.000Z'),
      project('a-tie', 'active', 'medium'),
    ]
    projects.sort(compareDevLeadBoardProjects)
    expect(projects.map(entry => entry.id)).toEqual(['high-new', 'high-old', 'a-tie', 'medium', 'low-new'])
    // Input board order does not leak into group ordering.
    expect(groupDevLeadBoardProjects(board(projects))[0]?.projects.map(entry => entry.id)).toEqual(
      projects.map(entry => entry.id),
    )
  })

  it('summarizes tasks and truncates only long owner ids', () => {
    expect(taskProgress(project('one'))).toEqual({ done: 1, total: 2 })
    expect(truncateSessionId('short')).toBe('short')
    expect(truncateSessionId('session-1234567890abcdef')).toBe('session-12…bcdef')
  })

  it('maps statuses to stable tones', () => {
    expect(projectStatusTone('blocked')).toBe('warning')
    expect(projectStatusTone('active')).toBe('info')
    expect(projectStatusTone('paused')).toBe('neutral')
    expect(projectStatusTone('done')).toBe('success')
    expect(taskStatusTone('todo')).toBe('quiet')
    expect(taskStatusTone('doing')).toBe('info')
    expect(taskStatusTone('blocked')).toBe('warning')
    expect(taskStatusTone('done')).toBe('success')
  })

  it('lists only exact-path unlisted workspaces with authoritative session activity', () => {
    const listed = { ...project('listed'), workspace: { path: '/work/listed/', title: 'listed' } }
    const rows = unlistedDevLeadWorkspaces(board([listed]), [
      { workspaceId: 'w-listed', path: '/work/listed', title: 'Listed', sessionIds: ['s-listed'] },
      { workspaceId: 'w-idle', path: '/work/idle', title: 'Idle', sessionIds: [] },
      { workspaceId: 'w-recent', path: '/work/recent', title: 'Recent', sessionIds: ['s-old', 's-new'] },
    ], {
      's-listed': { updatedAt: NOW },
      's-old': { updatedAt: NOW - 10_000 },
      's-new': { updatedAt: NOW - 1_000 },
    })
    expect(rows.map(row => row.workspaceId)).toEqual(['w-recent', 'w-idle'])
    expect(rows[0]).toMatchObject({ sessionCount: 2, lastActivityAt: new Date(NOW - 1_000).toISOString() })
    expect(rows[1]).toMatchObject({ sessionCount: 0 })
    expect(rows[1]?.lastActivityAt).toBeUndefined()
  })

  it('normalizes Windows separators, case, and trailing slashes without claiming realpath', () => {
    const listed = { ...project('listed'), workspace: { path: 'C:\\Work\\Listed\\', title: 'listed' } }
    const rows = unlistedDevLeadWorkspaces(board([listed]), [
      { workspaceId: 'w-same', path: 'c:/work/listed', title: 'Same', sessionIds: [] },
      { workspaceId: 'w-other', path: 'C:/work/other', title: 'Other', sessionIds: [] },
    ], {}, 'win32')
    expect(rows.map(row => row.workspaceId)).toEqual(['w-other'])
  })

  it('buckets relative timestamps without letting future times go negative', () => {
    expect(boardRelativeTime(ISO, NOW)).toEqual({ unit: 'now', n: 0 })
    expect(boardRelativeTime('2026-11-23T07:58:00.000Z', NOW)).toEqual({ unit: 'minutes', n: 2 })
    expect(boardRelativeTime('2026-11-23T05:00:00.000Z', NOW)).toEqual({ unit: 'hours', n: 3 })
    expect(boardRelativeTime('2026-11-21T08:00:00.000Z', NOW)).toEqual({ unit: 'days', n: 2 })
    expect(boardRelativeTime('2026-11-24T08:00:00.000Z', NOW)).toEqual({ unit: 'now', n: 0 })
  })
})
