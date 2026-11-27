/**
 * Dynamic project-board lifecycle: path resolution, lead activation/switching,
 * cold recovery, and optional-feature degradation.
 *
 * The board follows the single active lead Session: its original workspace root
 * (`SessionHeader.cwd`) owns `.dsh/devlead/board.json`, unless the deployment
 * Config `statePath` names a custom state directory. No lead/workspace means the existing
 * disabled store, and a start failure must never block plugin activation.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEVLEAD_BOARD_DIR_SEGMENTS,
  DEVLEAD_BOARD_FILE_NAME,
  resolveDevLeadStateDir,
} from '../src/board.ts'
import {
  FakeAgent,
  FakeSessionPersistence,
  FakeSessionQuery,
  FakeProjectionCache,
  bootService,
  disposeHarnesses,
  seedPersistedLead,
} from './harness.ts'

const roots: string[] = []

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-devlead-board-lifecycle-${label}-`))
  roots.push(root)
  return root
}

function expectedPath(workspaceRoot: string): string {
  return join(workspaceRoot, ...DEVLEAD_BOARD_DIR_SEGMENTS, DEVLEAD_BOARD_FILE_NAME)
}

async function directoryMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return undefined
  }
}

afterEach(async () => {
  await disposeHarnesses()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('resolveDevLeadStateDir', () => {
  it('resolves the deployment state directory beneath the original workspace', () => {
    expect(resolveDevLeadStateDir({
      statePath: 'custom/shared/../shared/state',
      cwd: '/workspace/alpha',
    })).toEqual({ kind: 'resolved', path: '/workspace/alpha/custom/shared/state', source: 'override' })
    expect(resolveDevLeadStateDir({ statePath: '  custom/state  ', cwd: '/workspace/alpha' })).toEqual({
      kind: 'resolved', path: '/workspace/alpha/custom/state', source: 'override',
    })
  })

  it('derives the default state directory from the original workspace root', () => {
    expect(resolveDevLeadStateDir({ cwd: '/workspace/alpha' })).toEqual({
      kind: 'resolved',
      path: join('/workspace/alpha', '.dsh', 'devlead'),
      source: 'workspace',
    })
    // Trailing separators are normalized, not duplicated.
    expect(resolveDevLeadStateDir({ cwd: '/workspace/alpha/' })).toEqual({
      kind: 'resolved',
      path: join('/workspace/alpha', '.dsh', 'devlead'),
      source: 'workspace',
    })
    // A root workspace still nests under the shared segments.
    expect(resolveDevLeadStateDir({ cwd: '/' })).toEqual({
      kind: 'resolved',
      path: join('/', '.dsh', 'devlead'),
      source: 'workspace',
    })
  })

  it('disables instead of fabricating a relative path', () => {
    expect(resolveDevLeadStateDir({})).toEqual({ kind: 'disabled', reason: 'no-workspace' })
    expect(resolveDevLeadStateDir({ cwd: '   ' })).toEqual({ kind: 'disabled', reason: 'no-workspace' })
    expect(resolveDevLeadStateDir({ cwd: 'relative/project' })).toEqual({
      kind: 'disabled', reason: 'relative-workspace',
    })
    expect(resolveDevLeadStateDir({ statePath: 'custom/state' })).toEqual({
      kind: 'disabled', reason: 'no-workspace',
    })
    expect(() => resolveDevLeadStateDir({ statePath: '/absolute/state', cwd: '/workspace/alpha' }))
      .toThrowError(expect.objectContaining({ code: 'BOARD_INVALID' }))
  })
})

describe('service board lifecycle', () => {
  it('activates the board for the enabled lead and precreates its parent', async () => {
    const workspace = await tempRoot('activate')
    const harness = await bootService({ enabled: true, leadCwd: workspace })
    try {
      expect(harness.service.board.path).toBe(expectedPath(workspace))
      expect(harness.service.board.enabled).toBe(true)
      expect(harness.service.boardLeadSessionId).toBe(String(harness.lead.id))
      expect(harness.service.boardPathOverride).toBe(false)
      expect(harness.service.boardStartError).toBeUndefined()
      expect(await directoryMode(join(workspace, '.dsh', 'devlead'))).toBe(0o700)
      const result = await harness.service.updateBoard(harness.lead.agent, {
        project: 'alpha',
        create: true,
        set: { workspace: { path: workspace, title: 'alpha' } },
      })
      expect(result.revision).toBe(1)
      expect(existsSync(expectedPath(workspace))).toBe(true)
      expect((await harness.service.readBoard(harness.lead.agent)).projects).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('keeps Config statePath as a workspace-relative state directory', async () => {
    const workspace = await tempRoot('override-cwd')
    const override = join(workspace, 'nested', 'board.json')
    const harness = await bootService({ enabled: true, leadCwd: workspace, config: { statePath: 'nested' } })
    try {
      expect(harness.service.board.path).toBe(override)
      expect(harness.service.boardPathOverride).toBe(true)
      expect(harness.service.settings.statePath).toBe('nested')
      expect(await directoryMode(join(workspace, 'nested'))).toBe(0o700)
      // The workspace-derived file is never created while the override is set.
      expect(existsSync(expectedPath(workspace))).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('is disabled without a lead workspace and rejects board operations', async () => {
    const harness = await bootService({ enabled: true })
    try {
      expect(harness.service.board.path).toBeUndefined()
      expect(harness.service.board.enabled).toBe(false)
      expect(harness.service.boardLeadSessionId).toBeUndefined()
      expect(harness.service.board.summary()).toBe('')
      await expect(harness.service.readBoard(harness.lead.agent))
        .rejects.toMatchObject({ code: 'BOARD_DISABLED' })
      await expect(harness.service.updateBoard(harness.lead.agent, { project: 'alpha' }))
        .rejects.toMatchObject({ code: 'BOARD_DISABLED' })
    } finally {
      await harness.dispose()
    }
  })

  it('releases the store when mode turns off and switches it to the next lead workspace', async () => {
    const workspaceA = await tempRoot('switch-a')
    const workspaceB = await tempRoot('switch-b')
    const harness = await bootService({ enabled: true, leadCwd: workspaceA })
    try {
      expect(harness.service.board.path).toBe(expectedPath(workspaceA))
      // A second top-level Session in another workspace becomes the only lead.
      const sessionB = harness.ctx.sessions.create(SessionId('board-lead-b'), { meta: { cwd: workspaceB } })
      const agentB = new FakeAgent(sessionB)
      harness.agents.add(agentB)

      await harness.service.setEnabled(harness.lead.agent, false)
      expect(harness.service.board.path).toBeUndefined()
      expect(harness.service.boardLeadSessionId).toBeUndefined()
      expect(harness.service.board.summary()).toBe('')

      await harness.service.setEnabled(agentB.agent, true)
      expect(harness.service.board.path).toBe(expectedPath(workspaceB))
      expect(harness.service.boardLeadSessionId).toBe('board-lead-b')
      expect(await directoryMode(join(workspaceB, '.dsh', 'devlead'))).toBe(0o700)
      // The new lead writes into its own workspace board.
      await harness.service.updateBoard(agentB.agent, {
        project: 'beta',
        create: true,
        set: { workspace: { path: workspaceB, title: 'beta' } },
      })
      expect(existsSync(expectedPath(workspaceB))).toBe(true)
      expect(existsSync(expectedPath(workspaceA))).toBe(false)

      await harness.service.setEnabled(agentB.agent, false)
      expect(harness.service.board.path).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('recovers a cold lead board path from the persisted header on restart', async () => {
    const workspace = await tempRoot('cold')
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    await seedPersistedLead(query, { sessionId: 'cold-board-lead', cwd: workspace })
    cache.setDevLead('cold-board-lead', { enabled: true, sessions: [] })
    persistence.ids = ['cold-board-lead']
    const harness = await bootService({
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      registerLeadAgent: false,
    })
    try {
      expect(harness.service.board.path).toBe(expectedPath(workspace))
      expect(harness.service.boardLeadSessionId).toBe('cold-board-lead')
      expect(await directoryMode(join(workspace, '.dsh', 'devlead'))).toBe(0o700)
    } finally {
      await harness.dispose()
    }
  })

  it('marks the board path active once the cold lead becomes live and keeps the same store', async () => {
    const workspace = await tempRoot('cold-live')
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    await seedPersistedLead(query, { sessionId: 'cold-live-lead', cwd: workspace })
    cache.setDevLead('cold-live-lead', { enabled: true, sessions: [] })
    persistence.ids = ['cold-live-lead']
    const harness = await bootService({
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      registerLeadAgent: false,
    })
    try {
      const store = harness.service.board
      expect(store.path).toBe(expectedPath(workspace))
      // Resume: the cold Session becomes an Agent; reconciliation keeps the
      // same workspace file and does not churn the store.
      const lead = harness.ctx.sessions.create(SessionId('cold-live-lead'), { meta: { cwd: workspace } })
      const agent = new FakeAgent(lead)
      harness.agents.add(agent)
      harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' } as never)
      await new Promise<void>(resolve => { setTimeout(resolve, 25) })
      expect(harness.service.board.path).toBe(expectedPath(workspace))
      expect(harness.service.board).toBe(store)
      expect(harness.service.boardLeadSessionId).toBe('cold-live-lead')
    } finally {
      await harness.dispose()
    }
  })

  it('keeps a relative override disabled without an original lead workspace root', async () => {
    const harness = await bootService({ config: { statePath: 'nested' } })
    try {
      expect(harness.service.board.path).toBeUndefined()
      expect(harness.service.board.enabled).toBe(false)
      expect(harness.service.boardPathOverride).toBe(false)
      await harness.service.setEnabled(harness.lead.agent, true)
      expect(harness.service.board.path).toBeUndefined()
      expect(harness.service.boardPathOverride).toBe(false)
      expect(harness.service.boardLeadSessionId).toBeUndefined()
      expect(harness.service.boardDisabledReason).toBe('no-workspace')
      expect(harness.service.boardStartError).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('never blocks DevLead activation when the board parent cannot be created', async () => {
    const workspace = await tempRoot('degraded')
    // A regular file where the board parent directory should be makes
    // `mkdir(dirname(boardPath))` fail deterministically (ENOTDIR).
    const blocker = join(workspace, 'blocker')
    await writeFile(blocker, 'not a directory\n')
    const boardPath = join(blocker, 'nested', 'board.json')
    const harness = await bootService({
      enabled: true, leadCwd: workspace, config: { statePath: 'blocker/nested' },
    })
    try {
      // The plugin loaded and every non-board DevLead surface still works.
      expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
      expect(harness.service.settings.notificationBatchMs).toBe(400)
      expect(harness.service.board.path).toBe(boardPath)
      expect(harness.service.boardStartError).toMatchObject({ code: 'BOARD_IO_ERROR' })
      expect(harness.service.board.summary()).toBe('')
      await expect(harness.service.readBoard(harness.lead.agent))
        .rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
      await expect(harness.service.updateBoard(harness.lead.agent, {
        project: 'alpha',
        create: true,
        set: { workspace: { path: workspace, title: 'alpha' } },
      })).rejects.toMatchObject({ code: 'BOARD_IO_ERROR' })
    } finally {
      await harness.dispose()
    }
  })

  it('disables the board again after mode-off and keeps the store releasable', async () => {
    const workspace = await tempRoot('off')
    const harness = await bootService({ enabled: true, leadCwd: workspace })
    try {
      await harness.service.setEnabled(harness.lead.agent, false)
      expect(harness.service.board.enabled).toBe(false)
      expect(harness.service.boardStartError).toBeUndefined()
      const modeOff = await bootService({ enabled: false, leadCwd: workspace })
      try {
        expect(modeOff.service.board.path).toBeUndefined()
        expect(modeOff.service.boardLeadSessionId).toBeUndefined()
      } finally {
        await modeOff.dispose()
      }
    } finally {
      await harness.dispose()
    }
  })

  it('precreates the configured override parent 0700 while keeping an existing parent intact', async () => {
    const workspace = await tempRoot('override-mode')
    const parent = join(workspace, 'existing')
    await mkdir(parent, { mode: 0o755 })
    const harness = await bootService({
      enabled: true,
      leadCwd: workspace,
      config: { statePath: 'existing' },
    })
    try {
      expect((await stat(parent)).mode & 0o777).toBe(0o755)
      expect(harness.service.board.path).toBe(join(parent, 'board.json'))
    } finally {
      await harness.dispose()
    }
  })

  it('disables a derived board instead of recreating a deleted lead workspace', async () => {
    const root = await tempRoot('missing-workspace')
    const missing = join(root, 'moved-away')
    const harness = await bootService({ enabled: true, leadCwd: missing })
    try {
      // The lead Session's recorded workspace root no longer exists: no board
      // store, no mkdir, and no writes under a path that only the board would
      // recreate.
      expect(existsSync(missing)).toBe(false)
      expect(harness.service.board.path).toBeUndefined()
      expect(harness.service.board.enabled).toBe(false)
      expect(harness.service.boardLeadSessionId).toBeUndefined()
      expect(harness.service.boardDisabledReason).toBe('missing-workspace')
      expect(harness.service.boardStartError).toBeUndefined()
      expect(harness.service.board.summary()).toBe('')
      await expect(harness.service.readBoard(harness.lead.agent))
        .rejects.toMatchObject({ code: 'BOARD_DISABLED' })
      await expect(harness.service.updateBoard(harness.lead.agent, {
        project: 'alpha',
        create: true,
        set: { workspace: { path: missing, title: 'alpha' } },
      })).rejects.toMatchObject({ code: 'BOARD_DISABLED' })
      // Nothing under the missing root was created, including `.dsh/devlead`.
      expect(existsSync(missing)).toBe(false)
      expect(existsSync(join(missing, '.dsh'))).toBe(false)

      // A later lead in an existing workspace recovers a normal board.
      const workspaceB = await tempRoot('missing-workspace-recover')
      const sessionB = harness.ctx.sessions.create(SessionId('board-missing-recover-b'), { meta: { cwd: workspaceB } })
      const agentB = new FakeAgent(sessionB)
      harness.agents.add(agentB)
      await harness.service.setEnabled(harness.lead.agent, false)
      await harness.service.setEnabled(agentB.agent, true)
      expect(harness.service.board.path).toBe(expectedPath(workspaceB))
      expect(harness.service.boardDisabledReason).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('keeps a cold lead board disabled when its recorded workspace is gone', async () => {
    const root = await tempRoot('cold-missing-workspace')
    const missing = join(root, 'gone')
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    await seedPersistedLead(query, { sessionId: 'cold-missing-lead', cwd: missing })
    cache.setDevLead('cold-missing-lead', { enabled: true, sessions: [] })
    persistence.ids = ['cold-missing-lead']
    const harness = await bootService({
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      registerLeadAgent: false,
    })
    try {
      // A cold Session's header still names the old root, but the directory is
      // gone; the Host must not rebuild it just to host the default board file.
      expect(existsSync(missing)).toBe(false)
      expect(harness.service.board.path).toBeUndefined()
      expect(harness.service.boardLeadSessionId).toBeUndefined()
      expect(harness.service.boardDisabledReason).toBe('missing-workspace')
      expect(existsSync(missing)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('does not recreate a missing workspace for a relative override', async () => {
    const root = await tempRoot('override-missing-cwd')
    const missing = join(root, 'moved-away')
    const harness = await bootService({
      enabled: true, leadCwd: missing, config: { statePath: 'deploy-board/nested' },
    })
    try {
      expect(harness.service.board.path).toBeUndefined()
      expect(harness.service.boardPathOverride).toBe(false)
      expect(harness.service.boardDisabledReason).toBe('missing-workspace')
      expect(harness.service.boardStartError).toBeUndefined()
      expect(existsSync(missing)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('retries a degraded same-path board start on the next lead sync', async () => {
    const workspace = await tempRoot('same-path-retry')
    // A regular file where the override parent should be makes start() fail
    // deterministically (ENOTDIR) until the blocker is removed.
    const blocker = join(workspace, 'blocker')
    await writeFile(blocker, 'not a directory\n')
    const boardPath = join(blocker, 'nested', 'board.json')
    const harness = await bootService({
      enabled: true, leadCwd: workspace, config: { statePath: 'blocker/nested' },
    })
    try {
      expect(harness.service.boardStartError).toMatchObject({ code: 'BOARD_IO_ERROR' })
      expect(harness.service.board.path).toBe(boardPath)
      // The failure clears; a sync that resolves to the same path retries
      // start() instead of leaving the board degraded until a path switch.
      await rm(blocker, { force: true })
      await harness.service.setEnabled(harness.lead.agent, true)
      expect(harness.service.boardStartError).toBeUndefined()
      expect(harness.service.board.path).toBe(boardPath)
      expect(await directoryMode(join(blocker, 'nested'))).toBe(0o700)
      expect(harness.service.boardDisabledReason).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })
})
