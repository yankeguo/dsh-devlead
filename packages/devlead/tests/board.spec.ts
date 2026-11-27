/** Filesystem, validation, concurrency, and cache behavior of the project board. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEVLEAD_BOARD_MAX_BYTES,
  DEVLEAD_BOARD_READ_MAX_BYTES,
  DEVLEAD_BOARD_SUMMARY_MAX_BYTES,
  DevLeadBoardError,
  DevLeadBoardStore,
  devLeadBoardSchema,
  renderDevLeadBoardSummary,
} from '../src/board.ts'
import type {
  DevLeadBoard,
  DevLeadBoardProject,
  DevLeadBoardUpdate,
} from '../src/board.ts'
import { bootService } from './harness.ts'

/**
 * Deterministic writer-lock failure injection. The board acquires its
 * cross-process writer lock through `withFileLock`, so while `code` is set the
 * mock fails lock acquisition with that errno exactly as a read-only or
 * foreign-owned parent directory would; every other call passes through to the
 * real implementation. This replaces the old real-chmod test: no permission
 * bits, non-root uid, or platform-specific access semantics are involved.
 */
const lockIoInjection = vi.hoisted(() => ({ code: undefined as string | undefined }))

vi.mock('@deepseek-ai/dsh-atomic-write', async () => {
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>(
    '@deepseek-ai/dsh-atomic-write',
  )
  return {
    ...actual,
    withFileLock: async <T>(
      filename: string,
      operation: () => Promise<T>,
      options?: Parameters<typeof actual.withFileLock>[2],
    ): Promise<T> => {
      const code = lockIoInjection.code
      if (code !== undefined) {
        throw Object.assign(new Error(`injected ${code} while acquiring the writer lock`), { code })
      }
      return actual.withFileLock(filename, operation, options)
    },
  }
})

const roots: string[] = []
const stores: DevLeadBoardStore[] = []
let clock = 1_800_000_000_000
const actor = { sessionId: 'session-lead', title: 'DevLead' }

function project(id = 'alpha', path = '/tmp/alpha'): DevLeadBoardProject {
  return {
    id,
    revision: 1,
    workspace: { path, title: id },
    status: 'active',
    priority: 'medium',
    goal: '',
    focus: '',
    next: '',
    blockers: [],
    tasks: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function board(projects: DevLeadBoardProject[]): DevLeadBoard {
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: actor,
    projects,
  }
}

function patch(id = 'alpha', path = '/tmp/alpha'): Omit<DevLeadBoardUpdate, 'updatedBy'> {
  return { project: id, create: true, set: { workspace: { path, title: id } } }
}

async function boot(path?: string): Promise<{ store: DevLeadBoardStore; file: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-'))
  roots.push(root)
  const file = path ?? join(root, 'nested', 'board.json')
  const store = new DevLeadBoardStore(file, { warn: () => undefined }, () => clock++)
  stores.push(store)
  await store.start()
  return { store, file, root }
}

async function failureOf(promise: Promise<unknown>): Promise<DevLeadBoardError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DevLeadBoardError)
    return error as DevLeadBoardError
  }
  throw new Error('expected board operation to fail')
}

afterEach(async () => {
  lockIoInjection.code = undefined
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DevLeadBoardStore', () => {
  it('is disabled without configuration and resolves a configured path once', async () => {
    const disabled = new DevLeadBoardStore('')
    expect(disabled.enabled).toBe(false)
    expect(disabled.summary()).toBe('')
    expect((await failureOf(disabled.read())).code).toBe('BOARD_DISABLED')
    expect(() => new DevLeadBoardStore('relative/board.json')).toThrowError(expect.objectContaining({
      code: 'BOARD_INVALID',
    }))
    await expect(disabled.update({ project: 'alpha', updatedBy: actor })).rejects.toMatchObject({ code: 'BOARD_DISABLED' })
    const configured = new DevLeadBoardStore(join(tmpdir(), 'devlead-invalid-revision.json'))
    stores.push(configured)
    await expect(configured.update({ project: 'alpha', updatedBy: actor }, -1)).rejects.toMatchObject({ code: 'BOARD_INVALID' })
  })

  it('precreates the watchable parent at startup without creating the board file', async () => {
    const { store, file } = await boot()
    expect((await failureOf(store.read())).code).toBe('BOARD_NOT_FOUND')
    expect(existsSync(dirname(file))).toBe(true)
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)
    expect(existsSync(file)).toBe(false)
  })

  it('keeps an existing parent and its permissions across idempotent starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-start-'))
    roots.push(root)
    const parent = join(root, 'existing')
    await mkdir(parent, { mode: 0o755 })
    const store = new DevLeadBoardStore(join(parent, 'board.json'))
    stores.push(store)
    await store.start()
    await store.start()
    expect((await stat(parent)).mode & 0o777).toBe(0o755)
  })

  it('creates parent directories and schema-v1 JSON on the first atomic write', async () => {
    const { store, file } = await boot()
    const result = await store.update({ ...patch(), updatedBy: actor })
    expect(result.revision).toBe(1)
    expect(result.changed).toEqual(['project.create'])
    expect(existsSync(dirname(file))).toBe(true)
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.revision).toBe(1)
    expect(persisted.updatedBy).toEqual(actor)
    expect(persisted.projects[0]?.workspace).toEqual({ path: '/tmp/alpha', title: 'alpha' })
    expect((await store.read()).projects[0]?.tasks).toBeUndefined()
  })

  it('backfills and persists legacy project revisions from the file revision on read', async () => {
    const { store, file } = await boot()
    const legacy = JSON.parse(JSON.stringify(board([project()]))) as {
      revision: number
      projects: Array<Record<string, unknown>>
    }
    legacy.revision = 7
    delete legacy.projects[0]!.revision
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(legacy), 'utf8')
    const result = await store.read({ project: 'alpha' })
    expect(result.revision).toBe(7)
    expect(result.projects[0]?.revision).toBe(7)
    const persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    expect(persisted.revision).toBe(7)
    expect(persisted.projects[0]?.revision).toBe(7)
  })

  it('creates its own parent when the first update runs without start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-late-start-'))
    roots.push(root)
    const file = join(root, 'nested', 'board.json')
    const store = new DevLeadBoardStore(file, { warn: () => undefined }, () => clock++)
    stores.push(store)
    const result = await store.update({ ...patch(), updatedBy: actor })
    expect(result.revision).toBe(1)
    expect(existsSync(file)).toBe(true)
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('rejects an invalid first update without creating its parent tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-preflight-'))
    roots.push(root)
    const parent = join(root, 'nested')
    const store = new DevLeadBoardStore(join(parent, 'board.json'))
    stores.push(store)
    expect((await failureOf(store.update({ project: 'alpha', create: true, updatedBy: actor }))).code)
      .toBe('BOARD_INVALID')
    expect((await failureOf(store.update({ ...patch(), updatedBy: actor }, 3))).code)
      .toBe('BOARD_REVISION_CONFLICT')
    expect(existsSync(parent)).toBe(false)
  })

  it('stamps the enabled lead identity in the core service and rejects writes after mode-off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-service-'))
    roots.push(root)
    const file = join(root, 'state', 'board.json')
    const harness = await bootService({ enabled: true, leadCwd: root, config: { statePath: 'state' } })
    try {
      harness.sessionTitle.set(String(harness.lead.id), 'Lead title')
      const result = await harness.service.updateBoard(harness.lead.agent, patch())
      expect(result.revision).toBe(1)
      expect(harness.service.settings.statePath).toBe('state')
      const persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
      expect(persisted.updatedBy).toEqual({ sessionId: String(harness.lead.id), title: 'Lead title' })
      await harness.service.setEnabled(harness.lead.agent, false)
      await expect(harness.service.updateBoard(harness.lead.agent, { project: 'alpha', set: { focus: 'off' } }))
        .rejects.toMatchObject({ code: 'DEVLEAD_NOT_ENABLED' })
    } finally {
      await harness.dispose()
    }
  })

  it('requires explicit create and a workspace path for a new project', async () => {
    const { store, file } = await boot()
    expect((await failureOf(store.update({ project: 'alpha', updatedBy: actor }))).code).toBe('BOARD_PROJECT_NOT_FOUND')
    expect((await failureOf(store.update({ project: 'alpha', create: true, updatedBy: actor }))).code).toBe('BOARD_INVALID')
    expect(existsSync(file)).toBe(false)
    // start() owns parent creation for browser watchers; failed updates add nothing else.
    expect(existsSync(dirname(file))).toBe(true)
  })

  it('applies scalar, blocker, and task patches and keeps no-op revisions stable', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    const changed = await store.update({
      project: 'alpha',
      updatedBy: actor,
      set: { status: 'blocked', priority: 'high', goal: 'ship', focus: 'tests', next: 'verify' },
      blockers: { add: [{ id: 'b1', text: 'credentials' }] },
      tasks: { upsert: [{ id: 't1', title: 'write tests', status: 'doing', ownerSessionId: 'session-child' }] },
    })
    expect(changed.revision).toBe(2)
    expect(changed.changed).toEqual([
      'set.status', 'set.priority', 'set.goal', 'set.focus', 'set.next', 'blockers.add:b1', 'tasks.upsert:t1',
    ])
    expect(changed.project.blockers[0]?.sessionId).toBeUndefined()
    expect(changed.project.tasks).toBeUndefined()
    const detail = await store.read({ project: 'alpha' })
    expect(detail.projects[0]?.tasks?.[0]?.ownerSessionId).toBe('session-child')
    const before = await readFile(file, 'utf8')
    const noop = await store.update({ project: 'alpha', updatedBy: actor, set: { focus: 'tests' } })
    expect(noop.revision).toBe(2)
    expect(noop.changed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(before)
    const removed = await store.update({
      project: 'alpha',
      updatedBy: actor,
      blockers: { clear: true },
      tasks: { remove: ['t1'] },
    })
    expect(removed.project.blockers).toEqual([])
    expect(removed.project.tasks).toBeUndefined()
    expect((await store.read({ project: 'alpha' })).projects[0]?.tasks).toEqual([])
  })

  it('allows an existing task upsert to omit its title', async () => {
    const { store } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    await store.update({
      project: 'alpha', updatedBy: actor, tasks: { upsert: [{ id: 't1', title: 'write tests' }] },
    })
    const result = await store.update({
      project: 'alpha', updatedBy: actor, tasks: { upsert: [{ id: 't1', status: 'done' }] },
    })
    expect(result.changed).toEqual(['tasks.upsert:t1'])
    expect((await store.read({ project: 'alpha' })).projects[0]?.tasks?.[0]).toMatchObject({
      id: 't1', title: 'write tests', status: 'done',
    })
  })

  it('still rejects a title-less upsert for a genuinely new task', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    const before = await readFile(file, 'utf8')
    const failure = await failureOf(store.update({
      project: 'alpha', updatedBy: actor, tasks: { upsert: [{ id: 't2', status: 'doing' }] },
    }))
    expect(failure.code).toBe('BOARD_INVALID')
    expect(failure.message).toContain('new task "t2" requires a non-empty title')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('resolves one project by id, title, and path and bounds unfiltered reads', async () => {
    const { store } = await boot()
    await store.update({
      project: 'alpha', create: true, updatedBy: actor,
      set: { workspace: { path: '/tmp/alpha', title: 'Pretty project' } },
    })
    await store.update({ ...patch('beta', '/tmp/beta'), updatedBy: actor })
    for (const reference of ['alpha', 'Pretty project', '/tmp/alpha']) {
      expect((await store.read({ project: reference })).projects.map(item => item.id)).toEqual(['alpha'])
    }
    expect((await store.read({ limit: 1 })).truncated).toBe(true)
    expect((await store.read({ limit: 1 })).projects).toHaveLength(1)
    expect((await failureOf(store.read({ limit: 0 }))).code).toBe('BOARD_INVALID')
  })

  it('rejects stale expected revisions without changing the file', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    const before = await readFile(file, 'utf8')
    const conflict = await failureOf(store.update({
      project: 'alpha', updatedBy: actor, set: { focus: 'lost update' },
    }, 0))
    expect(conflict.code).toBe('BOARD_REVISION_CONFLICT')
    expect(conflict.issues[0]?.pointer).toBe('/revision')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('serializes concurrent Host updates without losing tasks', async () => {
    const { store } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => store.update({
      project: 'alpha',
      updatedBy: actor,
      tasks: { upsert: [{ id: `t${index}`, title: `task ${index}` }] },
    })))
    expect(results.map(result => result.revision).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 2),
    )
    const detail = await store.read({ project: 'alpha' })
    expect(detail.projects[0]?.tasks).toHaveLength(12)
  })

  it('coordinates two store instances through the cross-process file lock', async () => {
    const { store, file } = await boot()
    const second = new DevLeadBoardStore(file, { warn: () => undefined }, () => clock++)
    stores.push(second)
    await second.start()
    await store.update({ ...patch(), updatedBy: actor })
    await Promise.all([
      store.update({ project: 'alpha', updatedBy: actor, tasks: { upsert: [{ id: 'left', title: 'left' }] } }),
      second.update({ project: 'alpha', updatedBy: actor, tasks: { upsert: [{ id: 'right', title: 'right' }] } }),
    ])
    const persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    expect(persisted.revision).toBe(3)
    expect(persisted.projects[0]?.tasks.map(task => task.id).sort()).toEqual(['left', 'right'])
  })

  it('keeps the last valid cached summary and never overwrites malformed JSON', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor, set: { workspace: { path: '/tmp/alpha', title: 'alpha' }, focus: 'valid' } })
    await writeFile(file, '{broken', 'utf8')
    const failure = await failureOf(store.read())
    expect(failure.code).toBe('BOARD_INVALID')
    expect(failure.issues[0]?.pointer).toBe('')
    expect(store.summary()).toContain('alpha')
    expect((await failureOf(store.update({ project: 'alpha', updatedBy: actor, set: { focus: 'overwrite' } }))).code)
      .toBe('BOARD_INVALID')
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })

  it('returns JSON pointers for invalid fields and refuses unknown fields', async () => {
    const { store, file } = await boot()
    const invalid = board([project()])
    invalid.projects[0]!.status = 'unknown' as never
    Object.assign(invalid, { unexpected: true })
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(invalid), 'utf8')
    const failure = await failureOf(store.read())
    expect(failure.code).toBe('BOARD_INVALID')
    expect(failure.issues.some(issue => issue.pointer === '/projects/0/status')).toBe(true)
    expect(failure.issues.some(issue => issue.message.toLowerCase().includes('unrecognized'))).toBe(true)
  })

  it('rejects oversized files while retaining the last valid cache', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    await writeFile(file, Buffer.alloc(DEVLEAD_BOARD_MAX_BYTES + 1, 32))
    expect((await failureOf(store.read())).code).toBe('BOARD_LIMIT_EXCEEDED')
    expect(store.summary()).toContain('alpha')
  })

  it('enforces project, task, and free-text limits before committing', async () => {
    const { store, file } = await boot()
    const tooMany = board(Array.from({ length: 51 }, (_, index) => project(`p${index}`, `/tmp/p${index}`)))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(tooMany), 'utf8')
    expect((await failureOf(store.read())).code).toBe('BOARD_LIMIT_EXCEEDED')
    expect(devLeadBoardSchema.safeParse(board([{
      ...project(),
      tasks: Array.from({ length: 201 }, (_, index) => ({
        id: `t${index}`, title: 'task', status: 'todo', updatedAt: '2026-01-01T00:00:00.000Z',
      })),
    }])).success).toBe(false)

    await rm(file, { force: true })
    await store.update({ ...patch(), updatedBy: actor })
    const before = await readFile(file, 'utf8')
    expect((await failureOf(store.update({
      project: 'alpha', updatedBy: actor, set: { goal: 'x'.repeat(4_001) },
    }))).code).toBe('BOARD_LIMIT_EXCEEDED')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('refreshes its cached summary after a valid external watch event', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    const external = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    external.revision += 1
    external.projects[0]!.focus = 'external focus'
    external.updatedAt = '2026-01-02T00:00:00.000Z'
    await writeFile(file, JSON.stringify(external), 'utf8')
    await vi.waitFor(() => {
      expect(store.summary()).toContain('external focus')
    }, { timeout: 3_000, interval: 20 })
    expect((await store.read()).revision).toBe(2)
  })

  it('rejects duplicate project ids and workspace paths, non-UTC timestamps, and relative workspaces', () => {
    const duplicateId = board([project(), project('alpha', '/tmp/other')])
    expect(devLeadBoardSchema.safeParse(duplicateId).success).toBe(false)
    const duplicatePath = board([project('alpha', '/tmp/shared'), project('beta', '/tmp/shared')])
    expect(devLeadBoardSchema.safeParse(duplicatePath).success).toBe(false)
    const offsetTime = board([project()])
    offsetTime.updatedAt = '2026-01-01T08:00:00+08:00'
    expect(devLeadBoardSchema.safeParse(offsetTime).success).toBe(false)
    const invalidTime = board([project()])
    invalidTime.projects[0]!.updatedAt = 'yesterday'
    expect(devLeadBoardSchema.safeParse(invalidTime).success).toBe(false)
    const relativePath = board([project('alpha', 'relative/workspace')])
    expect(devLeadBoardSchema.safeParse(relativePath).success).toBe(false)
  })

  it('scopes CAS to the selected project and still reports ambiguous titles', async () => {
    const { store, file } = await boot()
    await store.update({
      ...patch('alpha', '/tmp/alpha'), updatedBy: actor, set: { workspace: { path: '/tmp/alpha', title: 'same' } },
    })
    await store.update({
      ...patch('beta', '/tmp/beta'), updatedBy: actor, set: { workspace: { path: '/tmp/beta', title: 'same' } },
    })
    expect((await failureOf(store.read({ project: 'same' }))).code).toBe('BOARD_PROJECT_AMBIGUOUS')
    // Beta advanced the file to r2, but alpha is still at its own r1.
    const alpha = await store.update({ project: 'alpha', updatedBy: actor, set: { focus: 'fresh' } }, 1)
    expect(alpha.revision).toBe(3)
    expect(alpha.project.revision).toBe(3)
    const beta = await store.update({ project: 'beta', updatedBy: actor, set: { focus: 'independent' } }, 2)
    expect(beta.revision).toBe(4)
    expect(beta.project.revision).toBe(4)
    const before = await readFile(file, 'utf8')
    expect((await failureOf(store.update({ project: 'alpha', updatedBy: actor, set: { focus: 'lost' } }, 1))).code)
      .toBe('BOARD_REVISION_CONFLICT')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await store.read({ project: 'alpha' })).projects[0]?.focus).toBe('fresh')
  })

  it('recovers when an external actor deletes and recreates the file', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    await rm(file)
    expect((await failureOf(store.read())).code).toBe('BOARD_NOT_FOUND')
    const recreated = board([project()])
    recreated.revision = 7
    await writeFile(file, JSON.stringify(recreated), 'utf8')
    expect((await store.read()).revision).toBe(7)
  })

  it('normalizes blank and overlong lead titles on the write path', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: { sessionId: 'lead', title: ' \n ' } })
    let persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    expect(persisted.updatedBy.title).toBe('DevLead')
    await store.update({
      project: 'alpha', updatedBy: { sessionId: 'lead', title: `  ${'x'.repeat(210)}  ` }, set: { focus: 'next' },
    })
    persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    expect(persisted.updatedBy.title).toBe('x'.repeat(200))
  })

  it('keeps omitted blocker fields and treats a repeated add as a no-op', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    await store.update({
      project: 'alpha', updatedBy: actor,
      blockers: { add: [{ id: 'b1', text: 'waiting', sessionId: 'child' }] },
    })
    const before = await readFile(file, 'utf8')
    const repeated = await store.update({
      project: 'alpha', updatedBy: actor,
      blockers: { add: [{ id: 'b1', text: 'waiting' }] },
    })
    expect(repeated.changed).toEqual([])
    expect(repeated.revision).toBe(2)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await store.read({ project: 'alpha' })).projects[0]?.blockers[0]?.sessionId).toBe('child')
  })

  it('bounds selected-project task output and reports truncation', async () => {
    const { store, file } = await boot()
    const value = board([{
      ...project(),
      tasks: Array.from({ length: 60 }, (_, index) => ({
        id: `t${index}`, title: `task ${index}`, status: 'todo' as const, updatedAt: '2026-01-01T00:00:00.000Z',
      })),
    }])
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value), 'utf8')
    const result = await store.read({ project: 'alpha' })
    expect(result.projects[0]?.tasks).toHaveLength(50)
    expect(result.truncated).toBe(true)
  })

  it('single-lines project ids and workspace titles in dynamic summaries', () => {
    const value = board([{
      ...project('alpha\ninjected'),
      workspace: { path: '/tmp/alpha', title: 'title\r\n\u0007injected' },
    }])
    const summary = renderDevLeadBoardSummary(value)
    expect(summary).toContain('- alpha injected/title injected')
    expect(summary).not.toMatch(/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u)
  })

  it('maps a writer-lock acquisition permission failure to BOARD_IO_ERROR without changing bytes', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    const before = await readFile(file, 'utf8')
    // A real EACCES/EPERM on `<board>.lock` acquisition stands in for a
    // read-only parent directory (or one owned by another user), without
    // depending on the runner's uid or real permission semantics.
    lockIoInjection.code = 'EACCES'
    try {
      const failure = await failureOf(store.update({ project: 'alpha', updatedBy: actor, set: { focus: 'no' } }))
      expect(failure.code).toBe('BOARD_IO_ERROR')
      // The mapping preserved the injected errno instead of masking its cause.
      expect(failure.message).toContain('injected EACCES')
      expect(await readFile(file, 'utf8')).toBe(before)
    } finally {
      lockIoInjection.code = undefined
    }
  })

  it('maps writer-lock timeout to a retryable BOARD_IO_ERROR without changing bytes', async () => {
    const { store, file } = await boot()
    await store.update({ ...patch(), updatedBy: actor })
    const before = await readFile(file, 'utf8')
    await writeFile(`${file}.lock`, `${process.pid}\n`, { flag: 'wx' })
    try {
      const failure = await failureOf(store.update({ project: 'alpha', updatedBy: actor, set: { focus: 'no' } }))
      expect(failure.code).toBe('BOARD_IO_ERROR')
      expect(failure.message).toMatch(/retry/iu)
      expect(await readFile(file, 'utf8')).toBe(before)
    } finally {
      await rm(`${file}.lock`, { force: true })
    }
  }, 5_000)

  it('resolves long workspace paths and titles as project references without a false limit error', async () => {
    const { store } = await boot()
    const longTitle = 'T'.repeat(160)
    const longPath = `/tmp/${'p'.repeat(300)}`
    await store.update({
      project: 'long-project',
      create: true,
      updatedBy: actor,
      set: { workspace: { path: longPath, title: longTitle } },
    })
    // The workspace path is far longer than the id limit but is still a valid
    // reference: preflight must not treat it as a synthetic id.
    const byPath = await store.update({ project: longPath, updatedBy: actor, set: { focus: 'by path' } })
    expect(byPath.revision).toBe(2)
    expect(byPath.project.workspace.path).toBe(longPath)
    const byTitle = await store.update({ project: longTitle, updatedBy: actor, set: { focus: 'by title' } })
    expect(byTitle.revision).toBe(3)
    expect(byTitle.project.focus).toBe('by title')
    // An unknown long reference is decided after the locked apply, with the
    // project-reference code rather than the id-length limit.
    expect((await failureOf(store.update({
      project: `/tmp/${'x'.repeat(300)}`, updatedBy: actor, set: { focus: 'missing' },
    }))).code).toBe('BOARD_PROJECT_NOT_FOUND')
    expect((await failureOf(store.update({ project: '   ', updatedBy: actor }))).code).toBe('BOARD_INVALID')
  })

  it('caps a selected-project read at 64 KiB by trimming task and blocker rows', async () => {
    const { store, file } = await boot()
    const long = 'x'.repeat(4_000)
    const value = board([{
      ...project(),
      tasks: Array.from({ length: 40 }, (_, index) => ({
        id: `t${index}`, title: long, status: 'todo' as const, updatedAt: '2026-01-01T00:00:00.000Z',
      })),
    }])
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value), 'utf8')
    const tasksRead = await store.read({ project: 'alpha' })
    expect(Buffer.byteLength(JSON.stringify(tasksRead), 'utf8')).toBeLessThanOrEqual(DEVLEAD_BOARD_READ_MAX_BYTES)
    expect(tasksRead.truncated).toBe(true)
    expect(tasksRead.revision).toBe(1)
    expect(tasksRead.projects[0]?.tasks?.length ?? 0).toBeLessThan(40)

    const blocked = board([{
      ...project('blocked-project'),
      blockers: Array.from({ length: 50 }, (_, index) => ({
        id: `b${index}`, text: long, since: '2026-01-01T00:00:00.000Z',
      })),
    }])
    await writeFile(file, JSON.stringify(blocked), 'utf8')
    const blockersRead = await store.read({ project: 'blocked-project' })
    expect(Buffer.byteLength(JSON.stringify(blockersRead), 'utf8')).toBeLessThanOrEqual(DEVLEAD_BOARD_READ_MAX_BYTES)
    expect(blockersRead.truncated).toBe(true)
    expect(blockersRead.projects[0]?.blockers.length ?? 0).toBeLessThan(50)
  })

  it('caps an unfiltered read by trimming project rows from the tail', async () => {
    const { store, file } = await boot()
    const value = board(Array.from({ length: 40 }, (_, index) => ({
      ...project(`p${index}`, `/tmp/p${index}`),
      focus: 'f'.repeat(4_000),
    })))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value), 'utf8')
    const result = await store.read({ limit: 50 })
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(DEVLEAD_BOARD_READ_MAX_BYTES)
    expect(result.truncated).toBe(true)
    expect(result.projects.length).toBeLessThan(40)
    expect(result.projects[0]?.id).toBe('p0')
    expect(result.projects.at(-1)?.id).toBe(`p${String(result.projects.length - 1)}`)
  })

  it('keeps the last valid cache and never overwrites a schema-invalid external edit', async () => {
    const { store, file } = await boot()
    await store.update({
      ...patch(),
      updatedBy: actor,
      set: { workspace: { path: '/tmp/alpha', title: 'alpha' }, focus: 'valid' },
    })
    expect(store.summary()).toContain('alpha')
    // Valid JSON that violates the strict schema (unknown field).
    const invalid = JSON.stringify({ ...board([project()]), unexpected: true })
    await writeFile(file, invalid, 'utf8')
    const failure = await failureOf(store.read({ project: 'alpha' }))
    expect(failure.code).toBe('BOARD_INVALID')
    // The last valid snapshot still feeds the dynamic summary, but no mutation
    // may replace the malformed file.
    expect(store.summary()).toContain('alpha')
    expect((await failureOf(store.update({ project: 'alpha', updatedBy: actor, set: { focus: 'overwrite' } }))).code)
      .toBe('BOARD_INVALID')
    expect(await readFile(file, 'utf8')).toBe(invalid)
  })

  it('renders stable, status-counted summaries capped at 1.5 KiB', () => {
    const projects = Array.from({ length: 50 }, (_, index) => ({
      ...project(`项目-${index}`, `/tmp/p${index}`),
      status: (['active', 'blocked', 'paused', 'done'] as const)[index % 4]!,
      focus: '专注🙂'.repeat(100),
      blockers: [{ id: 'b', text: 'blocked', since: '2026-01-01T00:00:00.000Z' }],
    }))
    const value = board(projects)
    const first = renderDevLeadBoardSummary(value)
    expect(first).toBe(renderDevLeadBoardSummary(value))
    expect(first).toContain('projects 50: active 13, blocked 13, paused 12, done 12')
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(DEVLEAD_BOARD_SUMMARY_MAX_BYTES)
    expect(renderDevLeadBoardSummary(board([]))).toBe('')
    expect(renderDevLeadBoardSummary(undefined)).toBe('')
  })
})
