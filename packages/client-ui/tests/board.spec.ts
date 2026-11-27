/** Pure browser-side schema, config resolution, grouping, sorting, and formatting tests. */
import { describe, expect, it } from 'vitest'
import { posix as nodePosix, win32 as nodeWin32 } from 'node:path'
import {
  boardRelativeTime,
  compareDevLeadBoardProjects,
  detectDevLeadBoardPathPlatform,
  DEVLEAD_BOARD_ID_MAX,
  DEVLEAD_BOARD_MAX_BLOCKERS,
  DEVLEAD_BOARD_MAX_BYTES,
  DEVLEAD_BOARD_MAX_PROJECTS,
  DEVLEAD_BOARD_MAX_TASKS,
  DEVLEAD_BOARD_PATH_MAX,
  DEVLEAD_BOARD_TEXT_MAX,
  DEVLEAD_BOARD_TITLE_MAX,
  DevLeadBoardParseError,
  groupDevLeadBoardProjects,
  parseDevLeadBoard,
  parseDevLeadBoardBytes,
  projectStatusTone,
  readDevLeadBoardConfig,
  resolveDevLeadBoardConfig,
  resolveDevLeadBoardSessionConfig,
  joinDevLeadBoardPath,
  summarizeDevLeadBoardProjects,
  taskProgress,
  taskStatusTone,
  truncateSessionId,
  unlistedDevLeadWorkspaces,
  type DevLeadBoard,
  type DevLeadBoardGlobal,
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
    revision: 7,
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
    expect(readDevLeadBoardConfig({ boardFilePath: '/work/.dsh/board.json', schemaVersion: 1, pathPlatform: 'posix' })).toEqual({
      boardFilePath: '/work/.dsh/board.json', schemaVersion: 1, pathPlatform: 'posix',
    })
    expect(readDevLeadBoardConfig({ boardFilePath: 'C:\\work\\board.json', schemaVersion: 1, pathPlatform: 'win32' })).toEqual({
      boardFilePath: 'C:\\work\\board.json', schemaVersion: 1, pathPlatform: 'win32',
    })
    for (const value of [
      undefined,
      null,
      {},
      { boardFilePath: 'relative/board.json', schemaVersion: 1 },
      { boardFilePath: '/work/board.json', schemaVersion: 2 },
      { boardFilePath: '', schemaVersion: 1 },
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

describe('board global contract and per-Session path resolution', () => {
  const BASE = {
    boardFilePath: '/work/.dsh/devlead/board.json',
    schemaVersion: 1 as const,
    pathPlatform: 'posix' as const,
  }

  it('reads the lead-attributed global and keeps the legacy shape unchanged', () => {
    expect(readDevLeadBoardConfig({ ...BASE, leadSessionId: 'session-lead', override: false })).toEqual({
      ...BASE, leadSessionId: 'session-lead', override: false,
    })
    expect(readDevLeadBoardConfig({ ...BASE, leadSessionId: 'session-lead' })).toEqual({
      ...BASE, leadSessionId: 'session-lead',
    })
    expect(readDevLeadBoardConfig({ ...BASE, override: true })).toEqual({ ...BASE, override: true })
    // A legacy Host publishes no lead attribution; it stays readable as-is.
    expect(readDevLeadBoardConfig(BASE)).toEqual(BASE)
  })

  it('rejects a global whose optional lead fields are present but malformed', () => {
    for (const value of [
      { ...BASE, leadSessionId: '' },
      { ...BASE, leadSessionId: 42 },
      { ...BASE, leadSessionId: null },
      { ...BASE, override: 'true' },
      { ...BASE, override: 1 },
      { ...BASE, leadSessionId: 'session-lead', override: 'yes' },
    ]) expect(readDevLeadBoardConfig(value)).toBeUndefined()
  })

  it('detects the Host path platform from workspace-root syntax', () => {
    expect(detectDevLeadBoardPathPlatform('/work/project')).toBe('posix')
    expect(detectDevLeadBoardPathPlatform('//server/share')).toBe('posix')
    expect(detectDevLeadBoardPathPlatform('C:\\work\\project')).toBe('win32')
    expect(detectDevLeadBoardPathPlatform('C:/work/project')).toBe('win32')
    expect(detectDevLeadBoardPathPlatform('\\\\server\\share')).toBe('win32')
    expect(detectDevLeadBoardPathPlatform('C:relative')).toBe('win32')
    expect(detectDevLeadBoardPathPlatform('relative/path')).toBeUndefined()
    expect(detectDevLeadBoardPathPlatform('')).toBeUndefined()
  })

  it.each([
    ['/work/project', '/work/project/.dsh/devlead/board.json'],
    ['/work/project/', '/work/project/.dsh/devlead/board.json'],
    ['/', '/.dsh/devlead/board.json'],
    ['//weird//path/', '/weird/path/.dsh/devlead/board.json'],
    ['/work/../other', '/other/.dsh/devlead/board.json'],
  ])('joins the POSIX default path under %s like node:path.posix', (cwd, expected) => {
    expect(joinDevLeadBoardPath(cwd, 'posix')).toBe(expected)
    expect(joinDevLeadBoardPath(cwd, 'posix')).toBe(nodePosix.join(cwd, '.dsh', 'devlead', 'board.json'))
  })

  it.each([
    ['C:\\work\\project', 'C:\\work\\project\\.dsh\\devlead\\board.json'],
    ['C:/work/project', 'C:\\work\\project\\.dsh\\devlead\\board.json'],
    ['C:\\', 'C:\\.dsh\\devlead\\board.json'],
    ['C:/', 'C:\\.dsh\\devlead\\board.json'],
    ['\\\\server\\share', '\\\\server\\share\\.dsh\\devlead\\board.json'],
    ['\\\\server\\share\\', '\\\\server\\share\\.dsh\\devlead\\board.json'],
    ['/work', '\\work\\.dsh\\devlead\\board.json'],
    ['C:\\a\\..\\b', 'C:\\b\\.dsh\\devlead\\board.json'],
  ])('joins the Windows default path under %s like node:path.win32', (cwd, expected) => {
    expect(joinDevLeadBoardPath(cwd, 'win32')).toBe(expected)
    expect(joinDevLeadBoardPath(cwd, 'win32')).toBe(nodeWin32.join(cwd, '.dsh', 'devlead', 'board.json'))
  })

  it('lets a Config override win for every lead, matching or not', () => {
    const override: DevLeadBoardGlobal = {
      ...BASE, boardFilePath: '/deploy/board.json', leadSessionId: 'session-lead', override: true,
    }
    const expected = { boardFilePath: '/deploy/board.json', schemaVersion: 1, pathPlatform: 'posix' }
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-lead', cwd: '/work/lead', global: override })).toEqual(expected)
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-other', cwd: '/work/other', global: override })).toEqual(expected)
    // The override needs no workspace root: the deployment named the file.
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-other', global: override })).toEqual(expected)
  })

  it('uses the global for the lead it names and derives for other leads', () => {
    const global: DevLeadBoardGlobal = { ...BASE, leadSessionId: 'session-lead' }
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-lead', cwd: '/work/lead', global })).toEqual(BASE)
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-lead', global })).toEqual(BASE)
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-other', cwd: '/work/other', global })).toEqual({
      boardFilePath: '/work/other/.dsh/devlead/board.json', schemaVersion: 1, pathPlatform: 'posix',
    })
    // No workspace root for the other lead: nothing can be derived.
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-other', global })).toBeUndefined()
  })

  it('keeps a legacy deployment-wide global authoritative for every lead', () => {
    expect(resolveDevLeadBoardConfig({ sessionId: 'any-session', cwd: '/work/other', global: BASE })).toEqual(BASE)
    expect(resolveDevLeadBoardConfig({ sessionId: 'any-session', global: BASE })).toEqual(BASE)
  })

  it('derives the default path without any global', () => {
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-lead', cwd: '/work/project' })).toEqual({
      boardFilePath: '/work/project/.dsh/devlead/board.json', schemaVersion: 1, pathPlatform: 'posix',
    })
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-lead', cwd: 'C:\\work\\project' })).toEqual({
      boardFilePath: 'C:\\work\\project\\.dsh\\devlead\\board.json', schemaVersion: 1, pathPlatform: 'win32',
    })
    // The Host trims the recorded root; the browser mirrors that so both sides
    // resolve the same file from a padded summary value.
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-lead', cwd: ' /work/project ' })).toEqual({
      boardFilePath: '/work/project/.dsh/devlead/board.json', schemaVersion: 1, pathPlatform: 'posix',
    })
  })

  it('derives with the Host-published platform when a stale global is present', () => {
    const stale: DevLeadBoardGlobal = {
      ...BASE, boardFilePath: '/stale/board.json', pathPlatform: 'win32', leadSessionId: 'session-lead',
    }
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-other', cwd: 'C:/work/other', global: stale })).toEqual({
      boardFilePath: 'C:\\work\\other\\.dsh\\devlead\\board.json', schemaVersion: 1, pathPlatform: 'win32',
    })
    // A stale POSIX global on a Windows-looking root cannot validate that root:
    // derivation follows the Host-published platform, never a guess.
    const stalePosix: DevLeadBoardGlobal = { ...BASE, leadSessionId: 'session-lead' }
    expect(resolveDevLeadBoardConfig({ sessionId: 'session-other', cwd: 'C:\\work\\other', global: stalePosix })).toBeUndefined()
  })

  it('refuses to derive from a missing, empty, or relative workspace root', () => {
    for (const input of [
      { sessionId: 'session-lead' },
      { sessionId: 'session-lead', cwd: '' },
      { sessionId: 'session-lead', cwd: '   ' },
      { sessionId: 'session-lead', cwd: 'work/project' },
      { sessionId: 'session-lead', cwd: '.' },
    ]) expect(resolveDevLeadBoardConfig(input)).toBeUndefined()
  })

  it('resolves only top-level Sessions whose summary says DevLead mode is on', () => {
    const global: DevLeadBoardGlobal = { ...BASE, leadSessionId: 'session-lead' }
    const lead = {
      cwd: '/work/lead',
      projectionValues: { devLeadMode: { enabled: true } },
    }
    expect(resolveDevLeadBoardSessionConfig('session-lead', lead, global)).toEqual(BASE)
    expect(resolveDevLeadBoardSessionConfig('session-lead', lead, undefined)).toEqual({
      boardFilePath: '/work/lead/.dsh/devlead/board.json', schemaVersion: 1, pathPlatform: 'posix',
    })
    // No row yet, mode off, or a subagent: no board surface at all.
    expect(resolveDevLeadBoardSessionConfig('session-lead', undefined, global)).toBeUndefined()
    expect(resolveDevLeadBoardSessionConfig('session-lead', {
      cwd: '/work/lead',
      projectionValues: { devLeadMode: { enabled: false } },
    }, global)).toBeUndefined()
    expect(resolveDevLeadBoardSessionConfig('session-lead', {
      cwd: '/work/lead',
      origin: 'subagent',
      projectionValues: { devLeadMode: { enabled: true } },
    }, global)).toBeUndefined()
    // A lead whose workspace root is unknown cannot derive a path either.
    expect(resolveDevLeadBoardSessionConfig('session-lead', {
      projectionValues: { devLeadMode: { enabled: true } },
    }, undefined)).toBeUndefined()
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

  it('derives KPI counts from the exact groups, including blocked negative controls', () => {
    const activeWithBlockers = {
      ...project('active-risk', 'active'),
      blockers: [{ id: 'risk', text: 'not yet blocking', since: ISO }],
    }
    const summary = summarizeDevLeadBoardProjects(board([
      activeWithBlockers,
      project('blocked-one', 'blocked'),
      project('blocked-two', 'blocked'),
      project('done', 'done'),
    ]))
    expect(summary.counts).toEqual({ active: 1, blocked: 2, paused: 0, done: 1 })
    expect(summary.groups.map(group => [group.status, group.projects.length])).toEqual([
      ['blocked', 2], ['active', 1], ['done', 1],
    ])
    expect(summarizeDevLeadBoardProjects(board([activeWithBlockers])).counts.blocked).toBe(0)
    // Parsing preserves the status enum that drives both projections.
    const parsed = parseDevLeadBoard(JSON.stringify(board([project('blocked', 'blocked')])))
    expect(summarizeDevLeadBoardProjects(parsed).counts.blocked).toBe(1)
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

/**
 * The Host validator and this browser decoder now share one schema factory in
 * `@yankeguo/dsh-devlead-protocol`; these cases pin the browser side of the
 * cross-package contract so deleting or loosening a shared rule (for example
 * the duplicate-workspace-path rule Step A added to the Host only) fails here
 * too. `packages/protocol/tests/board.spec.ts` carries the full matrix and
 * `packages/devlead/tests/board.spec.ts` the Host-side one.
 */
/** Cast one hostile fixture past the compile-time types; the runtime value is the point. */
function hostile(value: unknown): DevLeadBoardProject {
  return value as DevLeadBoardProject
}

describe('shared host contract (schema convergence)', () => {
  it.each([
    ['duplicate workspace path', JSON.stringify(board([
      { ...project('one'), workspace: { path: '/work/shared', title: 'one' } },
      { ...project('two'), workspace: { path: '/work/shared', title: 'two' } },
    ]))],
    ['duplicate project id', JSON.stringify(board([project('same'), project('same')]))],
    ['duplicate blocker id', JSON.stringify(board([{
      ...project('one'),
      blockers: [
        { id: 'same', text: 'one', since: ISO },
        { id: 'same', text: 'two', since: ISO },
      ],
    }]))],
    ['duplicate task id', JSON.stringify(board([{
      ...project('one'),
      tasks: [
        { id: 'same', title: 'one', status: 'todo', updatedAt: ISO },
        { id: 'same', title: 'two', status: 'done', updatedAt: ISO },
      ],
    }]))],
    ['unknown project field', JSON.stringify(board([hostile({ ...project('one'), extra: true })]))],
    ['unknown workspace field', JSON.stringify(board([hostile({
      ...project('one'),
      workspace: { path: '/work/one', title: 'one', extra: true },
    })]))],
    ['unknown blocker field', JSON.stringify(board([hostile({
      ...project('one'),
      blockers: [{ id: 'b', text: 'x', since: ISO, extra: true }],
    })]))],
    ['unknown task field', JSON.stringify(board([hostile({
      ...project('one'),
      tasks: [{ id: 't', title: 'x', status: 'todo', updatedAt: ISO, extra: true }],
    })]))],
    ['wrong schema version', JSON.stringify({ ...board(), schemaVersion: 2 })],
    ['offset timestamp', JSON.stringify({ ...board(), updatedAt: '2026-11-23T08:00:00+08:00' })],
    ['relative workspace path', JSON.stringify(board([{ ...project('one'), workspace: { path: 'work/one', title: 'one' } }]))],
    ['too many projects', JSON.stringify(board(Array.from(
      { length: DEVLEAD_BOARD_MAX_PROJECTS + 1 },
      (_, index) => project(`p${index}`),
    )))],
    ['too many tasks', JSON.stringify(board([{
      ...project('one'),
      tasks: Array.from({ length: DEVLEAD_BOARD_MAX_TASKS + 1 }, (_, index) => ({
        id: `t${index}`, title: 'task', status: 'todo' as const, updatedAt: ISO,
      })),
    }]))],
    ['too many blockers', JSON.stringify(board([{
      ...project('one'),
      blockers: Array.from({ length: DEVLEAD_BOARD_MAX_BLOCKERS + 1 }, (_, index) => ({
        id: `b${index}`, text: 'blocker', since: ISO,
      })),
    }]))],
    ['oversized free text', JSON.stringify(board([{ ...project('one'), focus: 'x'.repeat(DEVLEAD_BOARD_TEXT_MAX + 1) }]))],
    ['oversized id', JSON.stringify(board([{ ...project('one'), id: 'x'.repeat(DEVLEAD_BOARD_ID_MAX + 1) }]))],
    ['oversized title', JSON.stringify(board([{
      ...project('one'),
      workspace: { path: '/work/one', title: 'x'.repeat(DEVLEAD_BOARD_TITLE_MAX + 1) },
    }]))],
    ['oversized workspace path', JSON.stringify(board([{
      ...project('one'),
      workspace: { path: `/${'x'.repeat(DEVLEAD_BOARD_PATH_MAX)}`, title: 'one' },
    }]))],
  ])('rejects %s exactly like the Host decoder', (_label, text) => {
    expect(() => parseDevLeadBoard(text)).toThrow(DevLeadBoardParseError)
  })

  it.each([
    ['project status', JSON.stringify(board([hostile({ ...project('one'), status: 'unknown' })]))],
    ['project priority', JSON.stringify(board([hostile({ ...project('one'), priority: 'urgent' })]))],
    ['task status', JSON.stringify(board([hostile({
      ...project('one'),
      tasks: [{ id: 't', title: 'task', status: 'unknown', updatedAt: ISO }],
    })]))],
  ])('rejects a bad %s enum value', (_label, text) => {
    expect(() => parseDevLeadBoard(text)).toThrow(/board schema v1 validation failed at \/projects\/0/u)
  })

  it('reports the same JSON pointer for a nested violation as the Host validator', () => {
    const text = JSON.stringify(board([{
      ...project('one'),
      tasks: [{ id: 't', title: 'task', status: 'todo', updatedAt: ISO }],
    }]))
    expect(parseDevLeadBoard(text)).toEqual(board([{
      ...project('one'),
      tasks: [{ id: 't', title: 'task', status: 'todo', updatedAt: ISO }],
    }]))
    const bad = JSON.stringify(board([hostile({
      ...project('one'),
      tasks: [{ id: 't', title: 'task', status: 'unknown', updatedAt: ISO }],
    })]))
    expect(() => parseDevLeadBoard(bad)).toThrow('/projects/0/tasks/0/status')
  })

  it('keeps the byte cap and schema version aligned with the shared wire contract', () => {
    expect(DEVLEAD_BOARD_MAX_BYTES).toBe(256 * 1024)
    expect(parseDevLeadBoard(JSON.stringify(board()))).toEqual(board())
    expect(() => parseDevLeadBoardBytes(new Uint8Array(DEVLEAD_BOARD_MAX_BYTES + 1)))
      .toThrow(/exceeds/u)
  })
})
