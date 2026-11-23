/** Filesystem, validation, concurrency, and cache behavior of the project board. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEVLEAD_BOARD_MAX_BYTES,
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

const roots: string[] = []
const stores: DevLeadBoardStore[] = []
let clock = 1_800_000_000_000
const actor = { sessionId: 'session-lead', title: 'DevLead' }

function project(id = 'alpha', path = '/tmp/alpha'): DevLeadBoardProject {
  return {
    id,
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
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DevLeadBoardStore', () => {
  it('is disabled without configuration and resolves a configured path once', async () => {
    const disabled = new DevLeadBoardStore('')
    expect(disabled.enabled).toBe(false)
    expect(disabled.summary()).toBe('')
    expect((await failureOf(disabled.read())).code).toBe('BOARD_DISABLED')
    expect(new DevLeadBoardStore('relative/board.json').path).toBe(resolve('relative/board.json'))
  })

  it('reports a missing file without creating it at startup', async () => {
    const { store, file } = await boot()
    expect((await failureOf(store.read())).code).toBe('BOARD_NOT_FOUND')
    expect(existsSync(file)).toBe(false)
  })

  it('creates parent directories and schema-v1 JSON on the first atomic write', async () => {
    const { store, file } = await boot()
    const result = await store.update({ ...patch(), updatedBy: actor })
    expect(result.revision).toBe(1)
    expect(result.changed).toEqual(['project.create'])
    expect(existsSync(dirname(file))).toBe(true)
    const persisted = JSON.parse(await readFile(file, 'utf8')) as DevLeadBoard
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.revision).toBe(1)
    expect(persisted.updatedBy).toEqual(actor)
    expect(persisted.projects[0]?.workspace).toEqual({ path: '/tmp/alpha', title: 'alpha' })
    expect((await store.read()).projects[0]?.tasks).toBeUndefined()
  })

  it('stamps the enabled lead identity in the core service and rejects writes after mode-off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-service-'))
    roots.push(root)
    const file = join(root, 'board.json')
    const harness = await bootService({ enabled: true, config: { boardPath: file } })
    try {
      harness.sessionTitle.set(String(harness.lead.id), 'Lead title')
      const result = await harness.service.updateBoard(harness.lead.agent, patch())
      expect(result.revision).toBe(1)
      expect(harness.service.settings.boardPath).toBe(file)
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
    expect(changed.project.tasks[0]?.ownerSessionId).toBe('session-child')
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
    expect(removed.project.tasks).toEqual([])
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
