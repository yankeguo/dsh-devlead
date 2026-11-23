/**
 * Cross-package contract of the durable project-board wire schema (schema v1).
 *
 * The Host validator and the browser decoder both build their strict decoder
 * through `createDevLeadBoardSchema`; this suite pins the acceptance/rejection
 * matrix once, so a drift in either consumer's copy — duplicate workspace
 * paths, unknown nested fields, enum spellings, limits, timestamps, or
 * absolute-path rules — fails here before it can reach a published pair.
 *
 * The two path predicates mirror the real callers: `node:path.isAbsolute` is
 * what the Host passes, and `node:path.win32.isAbsolute` stands in for a
 * Windows Host publishing `pathPlatform: 'win32'` to the browser.
 */

import { isAbsolute, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDevLeadBoardSchema,
  devLeadBoardIssuePointer,
  devLeadBoardIssueViews,
  DEVLEAD_BOARD_ID_MAX,
  DEVLEAD_BOARD_MAX_BLOCKERS,
  DEVLEAD_BOARD_MAX_BYTES,
  DEVLEAD_BOARD_MAX_PROJECTS,
  DEVLEAD_BOARD_MAX_TASKS,
  DEVLEAD_BOARD_PATH_MAX,
  DEVLEAD_BOARD_SCHEMA_VERSION,
  DEVLEAD_BOARD_TEXT_MAX,
  DEVLEAD_BOARD_TIMESTAMP_MAX,
  DEVLEAD_BOARD_TITLE_MAX,
  type DevLeadBoard,
  type DevLeadBoardBlocker,
  type DevLeadBoardProject,
  type DevLeadBoardTask,
} from '@yankeguo/dsh-devlead-protocol'

/** The Host's decoder: absolute paths follow the running platform's node:path. */
const hostSchema = createDevLeadBoardSchema(isAbsolute)
/** A POSIX Host decoder, matching the browser's default pathPlatform. */
const posixSchema = createDevLeadBoardSchema(value => value.startsWith('/'))
/** A Windows Host decoder, matching the browser's `pathPlatform: 'win32'`. */
const win32Schema = createDevLeadBoardSchema(win32.isAbsolute)

const ISO = '2026-11-23T08:00:00.000Z'

/** One blocker row. */
function blocker(id = 'blocker-1'): DevLeadBoardBlocker {
  return { id, text: 'waiting for review', since: ISO, sessionId: 'session-child' }
}

/** One task row. */
function task(id = 'task-1'): DevLeadBoardTask {
  return { id, title: 'ship it', status: 'doing', ownerSessionId: 'session-child', updatedAt: ISO }
}

/** One project row. */
function project(
  id = 'alpha',
  workspacePath = `/work/${id}`,
): DevLeadBoardProject {
  return {
    id,
    workspace: { path: workspacePath, title: `Project ${id}` },
    status: 'active',
    priority: 'medium',
    goal: 'goal',
    focus: 'focus',
    next: 'next',
    blockers: [blocker()],
    tasks: [task()],
    updatedAt: ISO,
  }
}

/** One complete board value. */
function board(projects: DevLeadBoardProject[] = [project()]): DevLeadBoard {
  return {
    schemaVersion: 1,
    revision: 7,
    updatedAt: ISO,
    updatedBy: { sessionId: 'session-lead', title: 'DevLead' },
    projects,
  }
}

/** Parse and return the issue pointers of one rejected value. */
function pointersOf(value: unknown, schema = hostSchema): string[] {
  const parsed = schema.safeParse(value)
  expect(parsed.success).toBe(false)
  if (parsed.success) return []
  return devLeadBoardIssueViews(parsed.error.issues).map(issue => issue.pointer)
}

describe('shared board wire constants', () => {
  it('pins the schema version, byte cap, and every count/length limit', () => {
    // These exact numbers are part of the Host↔browser wire contract and the
    // AI tool documentation; changing one is a compatibility change, not a
    // local tweak.
    expect(DEVLEAD_BOARD_SCHEMA_VERSION).toBe(1)
    expect(DEVLEAD_BOARD_MAX_BYTES).toBe(262_144)
    expect(DEVLEAD_BOARD_MAX_PROJECTS).toBe(50)
    expect(DEVLEAD_BOARD_MAX_TASKS).toBe(200)
    expect(DEVLEAD_BOARD_MAX_BLOCKERS).toBe(50)
    expect(DEVLEAD_BOARD_TEXT_MAX).toBe(4_000)
    expect(DEVLEAD_BOARD_ID_MAX).toBe(128)
    expect(DEVLEAD_BOARD_TITLE_MAX).toBe(200)
    expect(DEVLEAD_BOARD_PATH_MAX).toBe(4_096)
    expect(DEVLEAD_BOARD_TIMESTAMP_MAX).toBe(64)
  })
})

describe('shared board wire acceptance', () => {
  it('accepts a complete board and leaves project order untouched', () => {
    const value = board([project('zulu'), project('alpha')])
    expect(posixSchema.parse(value)).toEqual(value)
    expect(hostSchema.parse(value)).toEqual(value)
  })

  it('accepts empty boards, empty text fields, and omitted optional ids', () => {
    const value = board([])
    expect(posixSchema.parse(value)).toEqual(value)
    const minimal = board([{
      ...project(),
      goal: '',
      focus: '',
      next: '',
      blockers: [{ id: 'blocker-1', text: 'waiting', since: ISO }],
      tasks: [{ id: 'task-1', title: 'todo', status: 'todo', updatedAt: ISO }],
    }])
    expect(posixSchema.parse(minimal)).toEqual(minimal)
  })

  it('accepts the same blocker and task ids in different projects', () => {
    const value = board([project('alpha'), project('beta')])
    expect(posixSchema.safeParse(value).success).toBe(true)
  })
})

describe('shared board wire rejection', () => {
  it.each([
    ['duplicate project id', board([project('same'), project('same', '/work/other')]), '/projects/1/id'],
    ['duplicate workspace path', board([project('alpha', '/work/shared'), project('beta', '/work/shared')]), '/projects/1/workspace/path'],
    ['duplicate blocker id', board([{ ...project(), blockers: [blocker('b'), blocker('b')] }]), '/projects/0/blockers/1/id'],
    ['duplicate task id', board([{ ...project(), tasks: [task('t'), task('t')] }]), '/projects/0/tasks/1/id'],
  ])('rejects %s with its JSON pointer', (_label, value, pointer) => {
    expect(pointersOf(value)).toContain(pointer)
  })

  it('treats workspace path duplicates as exact-string duplicates only', () => {
    // Symlink/realpath and trailing-slash equivalence stay Host-parse
    // (Step C) concerns; the wire schema compares the stored strings.
    const trailingSlash = board([project('alpha', '/work/shared'), project('beta', '/work/shared/')])
    expect(posixSchema.safeParse(trailingSlash).success).toBe(true)
  })

  it.each([
    ['unknown root field', { ...board(), extra: true }, ''],
    ['unknown updatedBy field', { ...board(), updatedBy: { sessionId: 's', title: 't', extra: 1 } }, '/updatedBy'],
    ['unknown project field', { ...board(), projects: [{ ...project(), extra: 1 }] }, '/projects/0'],
    ['unknown workspace field', { ...board(), projects: [{ ...project(), workspace: { path: '/work/alpha', title: 'alpha', extra: 1 } }] }, '/projects/0/workspace'],
    ['unknown blocker field', { ...board(), projects: [{ ...project(), blockers: [{ ...blocker(), extra: 1 }] }] }, '/projects/0/blockers/0'],
    ['unknown task field', { ...board(), projects: [{ ...project(), tasks: [{ ...task(), extra: 1 }] }] }, '/projects/0/tasks/0'],
  ])('rejects %s', (_label, value, pointer) => {
    expect(pointersOf(value)).toContain(pointer)
  })

  it.each([
    ['project status', { ...project(), status: 'unknown' }, '/projects/0/status'],
    ['project priority', { ...project(), priority: 'urgent' }, '/projects/0/priority'],
    ['task status', { ...project(), tasks: [{ ...task(), status: 'unknown' }] }, '/projects/0/tasks/0/status'],
  ])('rejects an unknown %s enum value', (_label, projectValue, pointer) => {
    expect(pointersOf(board([projectValue as DevLeadBoardProject]))).toContain(pointer)
  })

  it('rejects a wrong or missing schema version', () => {
    expect(pointersOf({ ...board(), schemaVersion: 2 })).toContain('/schemaVersion')
    expect(pointersOf({ ...board(), schemaVersion: '1' })).toContain('/schemaVersion')
    const { schemaVersion: _omit, ...missing } = board()
    expect(pointersOf(missing)).toContain('/schemaVersion')
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['string', '7'],
  ])('rejects a %s revision', (_label, revision) => {
    expect(pointersOf({ ...board(), revision })).toContain('/revision')
  })

  it.each([
    ['offset timestamp', '2026-11-23T08:00:00+08:00', '/updatedAt'],
    ['missing timezone', '2026-11-23T08:00:00', '/updatedAt'],
    ['not a timestamp', 'yesterday', '/projects/0/updatedAt'],
    ['project timestamp', '2026-13-40T08:00:00.000Z', '/projects/0/updatedAt'],
    ['blocker since', '2026-11-23', '/projects/0/blockers/0/since'],
    ['task updatedAt', '2026-11-23T08:00:00.000+08:00', '/projects/0/tasks/0/updatedAt'],
  ])('rejects a bad %s', (_label, timestamp, pointer) => {
    const value = pointer === '/updatedAt'
      ? { ...board(), updatedAt: timestamp }
      : pointer === '/projects/0/updatedAt'
        ? board([{ ...project(), updatedAt: timestamp }])
        : pointer === '/projects/0/blockers/0/since'
          ? board([{ ...project(), blockers: [{ ...blocker(), since: timestamp }] }])
          : board([{ ...project(), tasks: [{ ...task(), updatedAt: timestamp }] }])
    expect(pointersOf(value)).toContain(pointer)
  })

  it('rejects a non-absolute workspace path for each path implementation', () => {
    const relative = board([project('alpha', 'work/alpha')])
    expect(pointersOf(relative)).toContain('/projects/0/workspace/path')
    expect(pointersOf(relative, win32Schema)).toContain('/projects/0/workspace/path')
    const driveRelative = board([project('alpha', 'C:work\\alpha')])
    expect(pointersOf(driveRelative, win32Schema)).toContain('/projects/0/workspace/path')
  })

  it.each([
    'C:\\work\\alpha',
    'C:/work/alpha',
    '\\\\work\\alpha',
    '\\\\server\\share\\alpha',
    '/work/alpha',
  ])('accepts the Windows absolute workspace path %s under win32 semantics', workspacePath => {
    const value = board([project('alpha', workspacePath)])
    expect(win32Schema.safeParse(value).success).toBe(true)
    expect(posixSchema.safeParse(value).success).toBe(workspacePath.startsWith('/'))
  })

  it('rejects an oversized project list', () => {
    const value = board(Array.from({ length: DEVLEAD_BOARD_MAX_PROJECTS + 1 }, (_, index) => project(`p${index}`)))
    expect(pointersOf(value)).toContain('/projects')
  })

  it('rejects an oversized task list and blocker list', () => {
    const tasks = Array.from({ length: DEVLEAD_BOARD_MAX_TASKS + 1 }, (_, index) => task(`t${index}`))
    expect(pointersOf(board([{ ...project(), tasks }]))).toContain('/projects/0/tasks')
    const blockers = Array.from({ length: DEVLEAD_BOARD_MAX_BLOCKERS + 1 }, (_, index) => blocker(`b${index}`))
    expect(pointersOf(board([{ ...project(), blockers }]))).toContain('/projects/0/blockers')
  })

  it.each([
    ['project id', { ...project(), id: 'x'.repeat(DEVLEAD_BOARD_ID_MAX + 1) }, '/projects/0/id'],
    ['blocker id', { ...project(), blockers: [{ ...blocker(), id: 'x'.repeat(DEVLEAD_BOARD_ID_MAX + 1) }] }, '/projects/0/blockers/0/id'],
    ['task id', { ...project(), tasks: [{ ...task(), id: 'x'.repeat(DEVLEAD_BOARD_ID_MAX + 1) }] }, '/projects/0/tasks/0/id'],
    ['workspace title', { ...project(), workspace: { path: '/work/alpha', title: 'x'.repeat(DEVLEAD_BOARD_TITLE_MAX + 1) } }, '/projects/0/workspace/title'],
    ['workspace path', { ...project(), workspace: { path: `/${'x'.repeat(DEVLEAD_BOARD_PATH_MAX)}`, title: 'alpha' } }, '/projects/0/workspace/path'],
    ['goal text', { ...project(), goal: 'x'.repeat(DEVLEAD_BOARD_TEXT_MAX + 1) }, '/projects/0/goal'],
    ['blocker text', { ...project(), blockers: [{ ...blocker(), text: 'x'.repeat(DEVLEAD_BOARD_TEXT_MAX + 1) }] }, '/projects/0/blockers/0/text'],
  ])('rejects an oversized %s', (_label, projectValue, pointer) => {
    expect(pointersOf(board([projectValue as DevLeadBoardProject]))).toContain(pointer)
  })

  it('rejects an empty blocker text and an empty required id', () => {
    expect(pointersOf(board([{ ...project(), blockers: [{ ...blocker(), text: '' }] }])))
      .toContain('/projects/0/blockers/0/text')
    expect(pointersOf(board([{ ...project(), id: '' }]))).toContain('/projects/0/id')
  })
})

describe('shared board issue rendering', () => {
  it('renders RFC 6901 JSON pointers and an empty root pointer', () => {
    expect(devLeadBoardIssuePointer([])).toBe('')
    expect(devLeadBoardIssuePointer(['projects', 0, 'status'])).toBe('/projects/0/status')
    expect(devLeadBoardIssuePointer(['a/b', '~x'])).toBe('/a~1b/~0x')
  })

  it('maps every validation issue to a pointer plus message', () => {
    const parsed = posixSchema.safeParse(board([project('same'), project('same', '/work/other')]))
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = devLeadBoardIssueViews(parsed.error.issues)
    expect(issues).toContainEqual({ pointer: '/projects/1/id', message: 'duplicate project id "same"' })
  })
})
