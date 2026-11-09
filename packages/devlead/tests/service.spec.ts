/**
 * Integration coverage of the DevLead core service against a real cordis
 * Context, the real Session log, and the real `devLead` Session projection.
 *
 * Only the host capabilities around the service (`agents`, `workspaceRegistry`,
 * `sessionController`, `sessionTitle`) are deterministic fakes: there is no
 * Agent loop, model, network, or persistent store, and the notification batch
 * window is flushed on microtasks instead of wall-clock sleeps.
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_DEFAULT_MAX_WATCHED,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadSessionView, DevLeadTransition } from '@yankeguo/dsh-devlead-protocol'
import {
  Config,
  DevLeadError,
  DevLeadService,
  devLeadNotification,
  isDevLeadError,
  notificationRecord,
} from '../src/index.ts'
import type { Config as DevLeadConfig, DevLeadErrorCode } from '../src/index.ts'
import {
  FakeAgent,
  FakeSessionController,
  FakeSessionQuery,
  FakeWorkspaceRegistry,
  T0,
  appendAssistantMessage,
  appendTurnEnd,
  appendTurnStart,
  bootService,
  disposeHarnesses,
  flushMicrotasks,
  humanMessage,
  messageText,
  notificationRecords,
  projectionStateOf,
} from './harness.ts'
import type { ServiceHarness } from './harness.ts'
import { sessionEvent } from './fixtures.ts'

/** Temporary directories created by the specs, removed after each test. */
const tempDirs: string[] = []

/** Capture one synchronous rejection. */
function capture(run: () => unknown): unknown {
  try {
    run()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected the operation to throw')
}

/** Capture one asynchronous rejection. */
async function captureAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected the operation to reject')
}

/** Assert one synchronous operation fails with the expected stable code. */
function expectCode(run: () => unknown, code: DevLeadErrorCode): DevLeadError {
  const error = capture(run)
  expect(error).toBeInstanceOf(DevLeadError)
  expect((error as DevLeadError).code).toBe(code)
  return error as DevLeadError
}

/** Assert one asynchronous operation fails with the expected stable code. */
async function expectCodeAsync(run: () => Promise<unknown>, code: DevLeadErrorCode): Promise<DevLeadError> {
  const error = await captureAsync(run)
  expect(error).toBeInstanceOf(DevLeadError)
  expect((error as DevLeadError).code).toBe(code)
  return error as DevLeadError
}

/** Create one temporary directory and schedule its removal. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-devlead-service-'))
  tempDirs.push(dir)
  return dir
}

/** Read one required Session from a booted harness session record. */
function requireSession2(sessions: Readonly<Record<string, Session>>, id: string): Session {
  const session = sessions[id]
  if (session === undefined) throw new Error(`expected a booted Session "${id}"`)
  return session
}

/** Read one required Session of a booted harness. */
function requireSession(harness: ServiceHarness, id: string): Session {
  const session = harness.sessions[id]
  if (session === undefined) throw new Error(`expected a booted Session "${id}"`)
  return session
}

/** Read one required Session view of a listing. */
function requireView(views: readonly DevLeadSessionView[], id: string): DevLeadSessionView {
  const view = views.find(candidate => candidate.sessionId === id)
  if (view === undefined) throw new Error(`expected a Session view for "${id}"`)
  return view
}

/** Append one durable notification record to a Session log. */
function appendNotification(
  session: Session,
  sessionId: string,
  turn: number,
  transition: DevLeadTransition = 'completed',
  at: number = T0,
): DevLeadNotification {
  const value = devLeadNotification(sessionId, undefined, transition, turn, at)
  appendPluginRecord(session, DEVLEAD_NOTIFICATION_RECORD_TYPE, notificationRecord(value))
  return value
}

afterEach(async () => {
  await disposeHarnesses()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('configuration', () => {
  it('materializes deployment defaults', async () => {
    const harness = await bootService()
    expect(harness.service.settings.notificationBatchMs).toBe(400)
    expect(harness.service.settings.maxWatchedSessions).toBe(DEVLEAD_DEFAULT_MAX_WATCHED)
    expect(harness.service.settings.maxListedSessions).toBe(200)
    expect(harness.service.settings.wakeColdSession).toBe(false)
    expect(harness.service.settings.defaultAgentPreset).toBeUndefined()
  })

  it('resolves explicit configuration and trims the preset', async () => {
    const harness = await bootService({
      config: {
        notificationBatchMs: 0,
        maxWatchedSessions: 2,
        maxListedSessions: 5,
        wakeColdSession: true,
        defaultAgentPreset: '  reviewer  ',
      },
    })
    expect(harness.service.settings).toEqual({
      notificationBatchMs: 0,
      maxWatchedSessions: 2,
      maxListedSessions: 5,
      wakeColdSession: true,
      defaultAgentPreset: 'reviewer',
    })
  })

  it('exposes the loader schema with defaults and bounds', () => {
    expect(DevLeadService.Config).toBe(Config)
    expect(Config({})).toMatchObject({
      notificationBatchMs: 400,
      maxWatchedSessions: DEVLEAD_DEFAULT_MAX_WATCHED,
      maxListedSessions: 200,
      wakeColdSession: false,
      defaultAgentPreset: '',
    })
    expect(() => Config({ notificationBatchMs: -1 })).toThrow()
    expect(() => Config({ maxWatchedSessions: 0 })).toThrow()
    expect(() => Config({ maxListedSessions: 0 })).toThrow()
    expect(() => Config({ notificationBatchMs: 1.5 })).toThrow()
  })

  it('rejects an invalid direct construction outside Loader normalization', () => {
    const cases: Array<Record<string, unknown>> = [
      { notificationBatchMs: -1 },
      { notificationBatchMs: 1.5 },
      { maxWatchedSessions: 0 },
      { maxListedSessions: 0 },
      { wakeColdSession: 'yes' },
      { defaultAgentPreset: 1 },
    ]
    for (const config of cases) {
      expect(() => new DevLeadService(new Context(), config as DevLeadConfig), JSON.stringify(config)).toThrow(TypeError)
    }
  })
})

describe('mode selection', () => {
  it('starts disabled and reports the empty projection view', async () => {
    const harness = await bootService()
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(false)
    expect(harness.service.view(harness.lead.agent)).toEqual({
      enabled: false,
      sessions: [],
      notifications: [],
    })
    expect(projectionStateOf(harness.leadSession)).toEqual({
      enabled: false,
      sessions: [],
      notifications: [],
      failure: null,
    })
  })

  it('persists the mode selection and keeps an idempotent write', async () => {
    const harness = await bootService()
    await harness.service.setEnabled(harness.lead.agent, true)
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
    expect(harness.service.view(harness.lead.agent).enabled).toBe(true)
    expect(durableModeRecords(harness)).toEqual([{ kind: 'devlead/mode', version: 1, enabled: true, at: expect.any(Number) }])
    await harness.service.setEnabled(harness.lead.agent, true)
    expect(durableModeRecords(harness)).toHaveLength(1)
    await harness.service.setEnabled(harness.lead.agent, false)
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(false)
    expect(durableModeRecords(harness)).toHaveLength(2)
    expect(durableModeRecords(harness)[1]?.enabled).toBe(false)
  })

  it('rejects an Agent that is not the registry’s live instance', async () => {
    const harness = await bootService()
    const stale = new FakeAgent(harness.leadSession)
    expect(harness.service.isEnabled(stale.agent)).toBe(false)
    expectCode(() => harness.service.view(stale.agent), 'DEVLEAD_AGENT_NOT_LIVE')
    expectCode(() => harness.service.notifications(stale.agent), 'DEVLEAD_AGENT_NOT_LIVE')
    await expectCodeAsync(() => harness.service.setEnabled(stale.agent, true), 'DEVLEAD_AGENT_NOT_LIVE')
    await expectCodeAsync(() => harness.service.watchSession(stale.agent, String(harness.lead.id), true), 'DEVLEAD_AGENT_NOT_LIVE')
    await expectCodeAsync(() => harness.service.listSessions(stale.agent), 'DEVLEAD_AGENT_NOT_LIVE')
  })

  it('keeps writes working on a host without a persistence participant', async () => {
    const harness = await bootService({ persistence: false })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    try {
      // flush() returning false means "no durability participant composed",
      // which is normal for a headless/SDK Host and must stay silent.
      await expect(harness.service.setEnabled(harness.lead.agent, true)).resolves.toBeUndefined()
      expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('reports a failing durability participant without rejecting the mutation', async () => {
    const harness = await bootService({ flushFailure: new Error('disk offline') })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    try {
      // The append already committed to the live log: a persistence failure is
      // a warning, not a thrown error with no DevLead code.
      await expect(harness.service.setEnabled(harness.lead.agent, true)).resolves.toBeUndefined()
      expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk offline'))
    } finally {
      warn.mockRestore()
    }
  })

  it('honors a pre-aborted signal before writing', async () => {
    const harness = await bootService()
    const controller = new AbortController()
    controller.abort()
    await expect(harness.service.setEnabled(harness.lead.agent, true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(durableModeRecords(harness)).toEqual([])
  })
})

describe('watch set', () => {
  it('adds and removes one Session with whole-value records', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['child-alpha'] })
    const added = await harness.service.watchSession(harness.lead.agent, 'child-alpha', true)
    expect(added).toEqual({ sessionId: 'child-alpha', watched: true, sessions: ['child-alpha'] })
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['child-alpha'])
    expect(durableWatchRecords(harness)).toEqual([
      { kind: 'devlead/watch', version: 1, sessions: ['child-alpha'], at: expect.any(Number) },
    ])
    const removed = await harness.service.watchSession(harness.lead.agent, 'child-alpha', false)
    expect(removed).toEqual({ sessionId: 'child-alpha', watched: false, sessions: [] })
    expect(durableWatchRecords(harness)).toHaveLength(2)
  })

  it('does not write when the watch state is already the requested one', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['child-alpha'], watched: ['child-alpha'] })
    const before = durableWatchRecords(harness)
    expect(await harness.service.watchSession(harness.lead.agent, 'child-alpha', true)).toEqual({
      sessionId: 'child-alpha',
      watched: true,
      sessions: ['child-alpha'],
    })
    expect(durableWatchRecords(harness)).toEqual(before)
  })

  it('rejects watching itself', async () => {
    const harness = await bootService({ enabled: true })
    const error = await expectCodeAsync(
      () => harness.service.watchSession(harness.lead.agent, String(harness.lead.id), true),
      'DEVLEAD_SELF_WATCH',
    )
    expect(error.message).toContain('cannot watch itself')
  })

  it('enforces the configured watch limit', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['child-alpha', 'child-beta'],
      config: { maxWatchedSessions: 1 },
    })
    await harness.service.watchSession(harness.lead.agent, 'child-alpha', true)
    await expectCodeAsync(
      () => harness.service.watchSession(harness.lead.agent, 'child-beta', true),
      'DEVLEAD_WATCH_LIMIT',
    )
    // Re-watching the one admitted Session stays idempotent under the limit.
    await expect(harness.service.watchSession(harness.lead.agent, 'child-alpha', true)).resolves.toMatchObject({
      watched: true,
    })
    await harness.service.watchSession(harness.lead.agent, 'child-alpha', false)
    await expect(harness.service.watchSession(harness.lead.agent, 'child-beta', true)).resolves.toMatchObject({
      watched: true,
    })
  })

  it('rejects unknown and ambiguous Session references', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['prefix-one', 'prefix-two'] })
    await expectCodeAsync(
      () => harness.service.watchSession(harness.lead.agent, 'missing-session', true),
      'DEVLEAD_SESSION_NOT_FOUND',
    )
    const ambiguous = await expectCodeAsync(
      () => harness.service.watchSession(harness.lead.agent, 'prefix', true),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(ambiguous.message).toContain('ambiguous')
  })

  it('requires DevLead mode for watch mutations', async () => {
    const harness = await bootService({ sessionIds: ['child-alpha'] })
    await expectCodeAsync(
      () => harness.service.watchSession(harness.lead.agent, 'child-alpha', true),
      'DEVLEAD_NOT_ENABLED',
    )
  })
})

describe('notification digest', () => {
  it('returns the retained notifications oldest first', async () => {
    const harness = await bootService({
      enabled: true,
      seedLead: (session) => {
        appendNotification(session, 'session-alpha', 1)
        appendNotification(session, 'session-beta', 2, 'error')
        appendNotification(session, 'session-gamma', 3, 'blocked')
      },
    })
    const digest = harness.service.notifications(harness.lead.agent)
    expect(digest.map(item => item.id)).toEqual([
      'session-alpha:1:completed',
      'session-beta:2:error',
      'session-gamma:3:blocked',
    ])
    expect(harness.service.notifications(harness.lead.agent, { limit: 2 }).map(item => item.id)).toEqual([
      'session-beta:2:error',
      'session-gamma:3:blocked',
    ])
    expect(harness.service.notifications(harness.lead.agent, { limit: 0 })).toHaveLength(3)
    expect(harness.service.notifications(harness.lead.agent, { limit: -3 })).toHaveLength(3)
    expect(harness.service.notifications(harness.lead.agent, { limit: 1.5 })).toHaveLength(3)
  })

  it('defaults to the newest twenty rows', async () => {
    const harness = await bootService({
      enabled: true,
      seedLead: (session) => {
        for (let turn = 1; turn <= 25; turn += 1) appendNotification(session, 'session-alpha', turn)
      },
    })
    const digest = harness.service.notifications(harness.lead.agent)
    expect(digest).toHaveLength(20)
    expect(digest[0]?.turn).toBe(6)
    expect(digest.at(-1)?.turn).toBe(25)
  })

  it('returns an empty digest for a disabled Session', async () => {
    const harness = await bootService()
    expect(harness.service.notifications(harness.lead.agent)).toEqual([])
  })
})

describe('projection failure handling', () => {
  it('rejects reads while the first corrupt record freezes the fold', async () => {
    const harness = await bootService({ enabled: true })
    appendPluginRecord(harness.leadSession, DEVLEAD_MODE_RECORD_TYPE, {
      kind: 'devlead/mode',
      version: 1,
      enabled: 'yes',
      at: T0,
    } as never)
    expect(projectionStateOf(harness.leadSession).failure).toContain(DEVLEAD_MODE_RECORD_TYPE)
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(false)
    const invalid = expectCode(() => harness.service.view(harness.lead.agent), 'DEVLEAD_PROJECTION_INVALID')
    expect(invalid.message).toContain(DEVLEAD_MODE_RECORD_TYPE)
    expectCode(() => harness.service.notifications(harness.lead.agent), 'DEVLEAD_PROJECTION_INVALID')
    await expectCodeAsync(() => harness.service.setEnabled(harness.lead.agent, false), 'DEVLEAD_PROJECTION_INVALID')
    await expectCodeAsync(() => harness.service.listSessions(harness.lead.agent), 'DEVLEAD_PROJECTION_INVALID')
    // assertReady currently reports the disabled mode before the corrupt state;
    // the tool surface therefore cannot mutate a corrupt lead either way.
    await expectCodeAsync(
      () => harness.service.watchSession(harness.lead.agent, String(harness.lead.id), true),
      'DEVLEAD_NOT_ENABLED',
    )
  })
})

describe('workspace orchestration', () => {
  it('lists Workspace rows only when the registry is composed', async () => {
    const withoutRegistry = await bootService()
    await expect(withoutRegistry.service.listWorkspaces()).resolves.toEqual([])

    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/repo-one', title: 'one', sessionIds: ['session-a'] })
    registry.add({ path: '/tmp/repo-two', status: 'missing-dir' })
    const harness = await bootService({ workspaceRegistry: registry })
    const views = await harness.service.listWorkspaces()
    expect(views).toEqual([
      {
        workspaceId: 'ws-1',
        title: 'one',
        path: '/tmp/repo-one',
        status: 'ok',
        sessionIds: ['session-a'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        workspaceId: 'ws-2',
        title: 'repo-two',
        path: '/tmp/repo-two',
        status: 'missing-dir',
        sessionIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })

  it('validates and resolves the directory argument', async () => {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({ workspaceRegistry: registry })
    await expectCodeAsync(() => harness.service.useWorkspace('   '), 'DEVLEAD_INVALID_INPUT')

    // The registry (not this service) rejects a relative spelling; the service
    // maps that rejection to the stable input vocabulary.
    registry.createErrors.set(
      'relative/repo',
      new TypeError("Workspace path is not fully qualified: 'relative/repo'"),
    )
    const relative = await expectCodeAsync(
      () => harness.service.useWorkspace('relative/repo'),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(relative.message).toContain('fully qualified')

    const missing = join(await tempDir(), 'missing')
    registry.createErrors.set(missing, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    const missingError = await expectCodeAsync(
      () => harness.service.useWorkspace(missing, { create: false }),
      'DEVLEAD_DIRECTORY_MISSING',
    )
    expect(missingError.message).toContain('create')
    // No directory was created when creation was disabled.
    await expect(stat(missing).then(() => true, () => false)).resolves.toBe(false)

    registry.createErrors.set(missing, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    const controller = new AbortController()
    controller.abort()
    await expect(harness.service.useWorkspace(missing, { create: true, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('maps a non-directory path and other registration failures to invalid input', async () => {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({ workspaceRegistry: registry })
    const file = join(await tempDir(), 'plain-file')
    await writeFile(file, 'not a directory')
    registry.createErrors.set(file, new Error(`cannot create a workspace at '${file}': path is not a directory`))
    const notDirectory = await expectCodeAsync(
      () => harness.service.useWorkspace(file),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(notDirectory.message).toContain('not a directory')

    // A parent that is a file makes the recursive creation fail; the failure is
    // classified instead of surfacing a raw `fs` rejection.
    const nested = join(file, 'child')
    registry.createErrors.set(nested, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    await expectCodeAsync(() => harness.service.useWorkspace(nested), 'DEVLEAD_INVALID_INPUT')
  })

  it('creates a missing directory and registers it as a Workspace', async () => {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({ workspaceRegistry: registry })
    const missing = join(await tempDir(), 'nested', 'repo')
    registry.createErrors.set(missing, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    const view = await harness.service.useWorkspace(missing, { title: '  Nested Repo  ' })
    await expect(stat(missing).then(result => result.isDirectory())).resolves.toBe(true)
    // One rejected attempt, then the registration after creating the directory;
    // the title is trimmed because the registry uses it verbatim.
    expect(registry.createCalls).toEqual([
      { path: missing, title: 'Nested Repo' },
      { path: missing, title: 'Nested Repo' },
    ])
    expect(view).toMatchObject({
      title: 'Nested Repo',
      path: missing,
      status: 'ok',
      workspaceId: 'ws-1',
    })
  })

  it('reuses an existing registry entry for a known directory', async () => {
    const dir = await tempDir()
    const registry = new FakeWorkspaceRegistry()
    const existing = registry.add({ path: dir, title: 'Known' })
    const harness = await bootService({ workspaceRegistry: registry })
    const view = await harness.service.useWorkspace(dir)
    expect(view.workspaceId).toBe(existing.id)
    expect(registry.createCalls).toEqual([{ path: dir }])
  })

  it('fails when no Workspace registry is composed or registration fails', async () => {
    const withoutRegistry = await bootService()
    const missingDir = await tempDir()
    await expectCodeAsync(
      () => withoutRegistry.service.useWorkspace(missingDir),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )

    const registry = new FakeWorkspaceRegistry()
    registry.createError = new Error('registry is read-only')
    const harness = await bootService({ workspaceRegistry: registry })
    const failedDir = await tempDir()
    // A registration failure is not a missing directory: the path exists, so the
    // caller must not be told to create it.
    const error = await expectCodeAsync(
      () => harness.service.useWorkspace(failedDir),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(error.message).toContain('registry is read-only')
  })
})

describe('session listings', () => {
  /** Boot one listing fixture with a live running child and a watched cold child. */
  async function bootListing(): Promise<{ harness: ServiceHarness; registry: FakeWorkspaceRegistry }> {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({
      enabled: true,
      sessionIds: ['child-alpha', 'child-beta', 'prefix-one', 'prefix-two'],
      // child-beta is only watched; the external id is watched without any
      // live Session object, so its row degrades to `live: false`.
      watched: ['child-beta', 'cold-external'],
      workspaceRegistry: registry,
    })
    const alpha = new FakeAgent(requireSession(harness, 'child-alpha'))
    alpha.setRunning(true)
    // Two pending inbox rows, emulating queued human input.
    alpha.inbox.nextTurn.push(humanMessage('first queued prompt'), humanMessage('second queued prompt'))
    alpha.inbox.nextStep.push(humanMessage('steering prompt'))
    appendTurnStart(requireSession(harness, 'child-alpha'), 1)
    harness.agents.add(alpha)
    harness.sessionTitle.set('child-alpha', 'Alpha Repo')
    registry.add({ path: '/tmp/alpha', title: 'Alpha Space', sessionIds: ['child-alpha'] })
    registry.add({ path: '/tmp/beta', title: 'Beta Space', sessionIds: ['child-beta'] })
    registry.archived = ['child-beta']
    return { harness, registry }
  }

  it('lists every addressable Session with live, running, watched, archived, and title facts', async () => {
    const { harness } = await bootListing()
    const views = await harness.service.listSessions(harness.lead.agent)
    expect(views.map(view => view.sessionId).sort()).toEqual([
      'child-alpha',
      'child-beta',
      'cold-external',
      'prefix-one',
      'prefix-two',
      String(harness.lead.id),
    ])
    const alpha = requireView(views, 'child-alpha')
    expect(alpha).toMatchObject({
      title: 'Alpha Repo',
      live: true,
      running: true,
      watched: false,
      archived: false,
      workspaceId: 'ws-1',
      workspaceTitle: 'Alpha Space',
      lastTurn: 1,
    })
    expect(alpha.pendingInputs).toBe(3)
    const beta = requireView(views, 'child-beta')
    // `live` means the Session object is live in the store; the exercised
    // Session has no Agent, so `running` stays false.
    expect(beta).toMatchObject({ live: true, running: false, watched: true, archived: true })
    const cold = requireView(views, 'cold-external')
    expect(cold).toMatchObject({ live: false, running: false, watched: true, archived: false })
    expect(cold.pendingInputs).toBeUndefined()
    // Watched rows sort first (cold last among them), then the running row.
    expect(views[0]?.sessionId).toBe('child-beta')
    expect(views[1]?.sessionId).toBe('cold-external')
    expect(views[2]?.sessionId).toBe('child-alpha')
  })

  it('filters to watched Sessions and applies the row limit', async () => {
    const { harness } = await bootListing()
    const watchedOnly = await harness.service.listSessions(harness.lead.agent, { watchedOnly: true })
    expect(watchedOnly.map(view => view.sessionId)).toEqual(['child-beta', 'cold-external'])
    // The row limit applies after relevance sorting, so watched rows survive the
    // cap even when they are not the first candidates collected.
    const limited = await harness.service.listSessions(harness.lead.agent, { limit: 2 })
    expect(limited).toHaveLength(2)
    expect(limited.map(view => view.sessionId)).toEqual(['child-beta', 'cold-external'])
  })

  it('filters to one Workspace’s accounting', async () => {
    const { harness } = await bootListing()
    const views = await harness.service.listSessions(harness.lead.agent, { workspace: 'ws-2' })
    expect(views.map(view => view.sessionId).sort()).toEqual(['child-beta'])
    const alphaOnly = await harness.service.listSessions(harness.lead.agent, { workspace: '/tmp/alpha' })
    expect(alphaOnly.map(view => view.sessionId)).toEqual(['child-alpha'])
  })

  it('rejects an unknown Workspace filter', async () => {
    const { harness } = await bootListing()
    await expectCodeAsync(
      () => harness.service.listSessions(harness.lead.agent, { workspace: 'no-such-workspace' }),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )
  })

  it('reads one Session in detail by exact id and by unique prefix', async () => {
    const { harness } = await bootListing()
    const exact = await harness.service.getSession(harness.lead.agent, 'child-alpha')
    expect(exact).toMatchObject({ sessionId: 'child-alpha', live: true, running: true, lastTurn: 1 })
    const prefixed = await harness.service.getSession(harness.lead.agent, 'child-al')
    expect(prefixed.sessionId).toBe('child-alpha')
  })

  it('rejects missing, ambiguous, and empty Session references', async () => {
    const { harness } = await bootListing()
    await expectCodeAsync(
      () => harness.service.getSession(harness.lead.agent, 'no-such-session'),
      'DEVLEAD_SESSION_NOT_FOUND',
    )
    await expectCodeAsync(
      () => harness.service.getSession(harness.lead.agent, 'prefix'),
      'DEVLEAD_INVALID_INPUT',
    )
    await expectCodeAsync(
      () => harness.service.getSession(harness.lead.agent, '   '),
      'DEVLEAD_INVALID_INPUT',
    )
  })

  it('folds turn and assistant facts for one persisted Session detail', async () => {
    const query = new FakeSessionQuery()
    query.seed(
      'cold-persisted',
      [
        sessionEvent(0, 'turn/start', { turn: 1 }, T0 + 1),
        sessionEvent(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 2),
        sessionEvent(2, 'turn/start', { turn: 2 }, T0 + 3),
        sessionEvent(3, 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'provider quota', code: 'X' } } }, T0 + 4),
        sessionEvent(
          4,
          'assistant/message',
          { turn: 2, step: 1, message: { content: [{ type: 'text', text: '  final\n answer  ' }] }, stream: [] },
          T0 + 5,
        ),
      ],
      'Cold Space',
    )
    const harness = await bootService({ enabled: true, sessionQuery: query })
    const view = await harness.service.getSession(harness.lead.agent, 'cold-persisted')
    expect(view).toMatchObject({
      sessionId: 'cold-persisted',
      title: 'Cold Space',
      live: false,
      running: false,
      watched: false,
      archived: false,
      lastTurn: 2,
      lastTransition: 'error',
      lastError: 'provider quota',
      lastAssistant: 'final answer',
      updatedAt: T0 + 5,
    })
  })

  it('lists persisted Sessions and their folded titles through the query engine', async () => {
    const query = new FakeSessionQuery()
    query.seed('cold-alpha', [sessionEvent(0, 'turn/start', { turn: 1 }, T0 + 1)], 'Persisted Alpha')
    query.seed('cold-beta', [], 'Persisted Beta')
    const harness = await bootService({ enabled: true, sessionQuery: query })
    const views = await harness.service.listSessions(harness.lead.agent)
    // Listing rows stay cheap: folded turn facts belong to the detail view.
    expect(requireView(views, 'cold-alpha')).toMatchObject({
      title: 'Persisted Alpha',
      live: false,
      running: false,
      watched: false,
    })
    expect(requireView(views, 'cold-beta').title).toBe('Persisted Beta')
  })

  it('keeps live rows when the query engine fails', async () => {
    const query = new FakeSessionQuery()
    query.listError = new Error('index unavailable')
    const harness = await bootService({ enabled: true, sessionIds: ['live-child'], sessionQuery: query })
    const views = await harness.service.listSessions(harness.lead.agent)
    expect(views.map(view => view.sessionId).sort()).toEqual(['live-child', String(harness.lead.id)])
    query.readError = new Error('title index unavailable')
    const degraded = await harness.service.listSessions(harness.lead.agent)
    expect(requireView(degraded, 'live-child').title).toBeUndefined()
  })

  it('honors a pre-aborted read signal', async () => {
    const { harness } = await bootListing()
    const controller = new AbortController()
    controller.abort()
    await expect(
      harness.service.listSessions(harness.lead.agent, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(harness.service.getSession(harness.lead.agent, 'child-alpha', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('honors a pre-aborted write signal before it mutates anything', async () => {
    const controller = new FakeSessionController()
    const harness = await bootService({ enabled: true, sessionIds: ['child-alpha'], sessionController: controller })
    const aborter = new AbortController()
    aborter.abort()
    await expect(
      harness.service.watchSession(harness.lead.agent, 'child-alpha', true, aborter.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      harness.service.promptSession(harness.lead.agent, 'child-alpha', 'continue', { signal: aborter.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      harness.service.createSession(harness.lead.agent, { workspace: 'missing-workspace' }, aborter.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // No watch record, no admitted prompt, and no created Session were left
    // behind by a call whose caller had already cancelled.
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
    expect(durableWatchRecords(harness)).toEqual([])
    expect(controller.createCalls).toEqual([])
    expect(controller.resolveCalls).toEqual([])
  })

  it('stops a cancellation that arrives during prompt resolution', async () => {
    const controller = new FakeSessionController()
    const harness = await bootService({ enabled: true, sessionIds: ['child-alpha'], sessionController: controller })
    const aborter = new AbortController()
    // Abort while the core is resolving the cold Session, before admission.
    controller.resolveHandler = () => {
      aborter.abort()
      const target = new FakeAgent(requireSession(harness, 'child-alpha'))
      harness.agents.add(target)
      return { agent: target.agent }
    }
    await expect(
      harness.service.promptSession(harness.lead.agent, 'child-alpha', 'continue', { signal: aborter.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['child-alpha'])
  })

  it('builds views only for the retained rows and scans the registry once', async () => {
    const ids = ['kid-1', 'kid-2', 'kid-3', 'kid-4', 'kid-5', 'kid-6']
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({
      enabled: true,
      sessionIds: ids,
      workspaceRegistry: registry,
      extraAgents: (agents, sessions) => {
        for (const id of ids) agents.add(new FakeAgent(requireSession2(sessions, id)))
      },
    })
    const listCalls = registry.listCalls
    const boundaryCalls = harness.agents.turnBoundaryCalls
    const views = await harness.service.listSessions(harness.lead.agent, { limit: 2 })
    expect(views).toHaveLength(2)
    // Exactly the retained rows pay for Agent projection folds, and the
    // Workspace registry is scanned once for collection and once for facts
    // rather than once per row.
    expect(harness.agents.turnBoundaryCalls - boundaryCalls).toBe(views.length)
    expect(registry.listCalls - listCalls).toBe(2)
  })

  it('caps an explicit limit at the configured listing maximum', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['cap-1', 'cap-2', 'cap-3'],
      config: { maxListedSessions: 2 },
    })
    const views = await harness.service.listSessions(harness.lead.agent, { limit: 50 })
    expect(views).toHaveLength(2)
  })

  it('never truncates a watched-only listing below the watch set', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['watch-1', 'watch-2', 'watch-3'],
      watched: ['watch-1', 'watch-2', 'watch-3'],
      config: { maxListedSessions: 2 },
    })
    const views = await harness.service.listSessions(harness.lead.agent, { watchedOnly: true })
    expect(views.map(view => view.sessionId).sort()).toEqual(['watch-1', 'watch-2', 'watch-3'])
    // A plain listing still honors the configured cap.
    const plain = await harness.service.listSessions(harness.lead.agent)
    expect(plain).toHaveLength(2)
  })

  it('rejects a non-positive or fractional row limit', async () => {
    const harness = await bootService({ enabled: true })
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expectCodeAsync(() => harness.service.listSessions(harness.lead.agent, { limit }), 'DEVLEAD_INVALID_INPUT')
    }
  })

  it('resolves a live exact id without listing the persisted corpus', async () => {
    const query = new FakeSessionQuery()
    query.seed('cold-persisted', [], 'Cold')
    const harness = await bootService({ enabled: true, sessionIds: ['live-child'], sessionQuery: query })
    await harness.service.watchSession(harness.lead.agent, 'live-child', true)
    // Identity resolution short-circuits on the live Session: no corpus listing
    // or title observation is needed for an already-known id.
    expect(query.listSessionsCalls).toBe(0)
    expect(query.readTitleCalls).toBe(0)
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['live-child'])
  })

  it('reports an unknown future turn-end kind as interrupted instead of a stale outcome', async () => {
    const query = new FakeSessionQuery()
    query.seed('cold-future', [
      sessionEvent(0, 'turn/start', { turn: 1 }, T0 + 1),
      sessionEvent(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 2),
      sessionEvent(2, 'turn/start', { turn: 2 }, T0 + 3),
      sessionEvent(3, 'turn/end', { turn: 2, reason: { kind: 'custom-future-kind' } }, T0 + 4),
    ])
    const harness = await bootService({ enabled: true, sessionQuery: query })
    const view = await harness.service.getSession(harness.lead.agent, 'cold-future')
    expect(view.lastTurn).toBe(2)
    expect(view.lastTransition).toBe('interrupted')
    expect(view.lastError).toBeUndefined()
  })

  it('resolves exact ids and unique prefixes beyond the listing window', async () => {
    const query = new FakeSessionQuery()
    const persisted = ['out-alpha', 'out-beta', 'out-gamma', 'out-delta', 'out-epsilon']
    for (const [index, id] of persisted.entries()) {
      query.seed(id, [sessionEvent(0, 'turn/start', { turn: 1 }, T0 + index)])
    }
    const harness = await bootService({
      enabled: true,
      sessionQuery: query,
      config: { maxListedSessions: 2 },
    })
    // The listing stays bounded by the configured window...
    const listed = await harness.service.listSessions(harness.lead.agent)
    expect(listed).toHaveLength(2)
    // ...while identity resolution still sees every persisted Session.
    const exact = await harness.service.getSession(harness.lead.agent, 'out-epsilon')
    expect(exact.sessionId).toBe('out-epsilon')
    const prefixed = await harness.service.getSession(harness.lead.agent, 'out-e')
    expect(prefixed.sessionId).toBe('out-epsilon')
    await harness.service.watchSession(harness.lead.agent, 'out-delta', true)
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['out-delta'])
  })
})

describe('prompt admission', () => {
  it('admits a relay prompt into a live watched Session', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    harness.agents.add(target)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', '  do the thing  ')
    expect(receipt).toEqual({ sessionId: 'target', watched: true, resumed: false })
    expect(target.followups).toHaveLength(1)
    const message = target.followups[0]
    if (message === undefined) throw new Error('expected one admitted prompt')
    expect(message.source).toMatchObject({
      kind: 'devlead',
      form: 'relay',
      senderSessionId: String(harness.lead.id),
    })
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['target'])
  })

  it('honors the watch policy and trailing-whitespace prompt text', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    harness.agents.add(target)
    const before = durableWatchRecords(harness)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', '  keep going \n', { watch: false })
    expect(receipt.watched).toBe(false)
    expect(durableWatchRecords(harness)).toEqual(before)
    expect(target.followups).toHaveLength(1)
    const admitted = target.followups[0]
    if (admitted === undefined) throw new Error('expected one admitted prompt')
    expect(messageText(admitted)).toBe('keep going')
  })

  it('rejects empty prompts and missing Sessions', async () => {
    const harness = await bootService({ enabled: true })
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'missing', 'work'),
      'DEVLEAD_SESSION_NOT_FOUND',
    )
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'missing', '   '),
      'DEVLEAD_INVALID_INPUT',
    )
  })

  it('rejects an archived Session', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.archived = ['target']
    const harness = await bootService({ enabled: true, sessionIds: ['target'], workspaceRegistry: registry })
    const error = await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'resume it'),
      'DEVLEAD_SESSION_ARCHIVED',
    )
    expect(error.message).toContain('archived')
  })

  it('resumes a cold Session through the Session controller', async () => {
    const controller = new FakeSessionController()
    const harness = await bootService({ enabled: true, sessionIds: ['target'], sessionController: controller })
    const target = new FakeAgent(requireSession(harness, 'target'))
    controller.resolveHandler = () => {
      harness.agents.add(target)
      return { agent: target.agent }
    }
    // `target` is not registered in the fake agents registry: a real resume
    // leaves it live, so the controller handler registers it.
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'continue')
    expect(receipt.resumed).toBe(true)
    expect(controller.resolveCalls.map(String)).toEqual(['target'])
    expect(target.followups).toHaveLength(1)
  })

  it('rejects a cold Session when no controller or resume fails', async () => {
    const withoutController = await bootService({ enabled: true, sessionIds: ['target'] })
    const unavailable = await expectCodeAsync(
      () => withoutController.service.promptSession(withoutController.lead.agent, 'target', 'continue'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(unavailable.message).toContain('no Session activator')

    const controller = new FakeSessionController()
    const harness = await bootService({ enabled: true, sessionIds: ['target'], sessionController: controller })
    controller.resolveHandler = () => ({ error: { message: 'gone', code: 'session/not-found' } })
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'continue'),
      'DEVLEAD_SESSION_NOT_FOUND',
    )
    controller.resolveHandler = () => ({ error: { message: 'busy', code: 'session/agent-busy' } })
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'continue'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
  })

  it('rejects a cold Session before applying the automatic watch when no controller is composed', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['cold-target'] })
    const error = await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'cold-target', 'continue'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('no Session activator')
    // The failed call left no half-applied watch behind.
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
    expect(durableWatchRecords(harness)).toEqual([])
  })

  it('maps an admission failure to a stable unreachable-Session error', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.failFollowups = 1
    harness.agents.add(target)
    const error = await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'work'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('refused the followup')
  })

  it('requires DevLead mode', async () => {
    const harness = await bootService({ sessionIds: ['target'] })
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'work'),
      'DEVLEAD_NOT_ENABLED',
    )
  })
})

describe('session creation', () => {
  it('requires DevLead mode and a Session controller', async () => {
    const disabled = await bootService()
    await expectCodeAsync(() => disabled.service.createSession(disabled.lead.agent, {}), 'DEVLEAD_NOT_ENABLED')

    const enabled = await bootService({ enabled: true })
    const error = await expectCodeAsync(() => enabled.service.createSession(enabled.lead.agent, {}), 'DEVLEAD_SESSION_UNAVAILABLE')
    expect(error.message).toContain('no API Session controller')
  })

  it('requires an explicit Workspace when the lead records no cwd', async () => {
    const controller = new FakeSessionController()
    const harness = await bootService({ enabled: true, sessionController: controller, workspaceRegistry: new FakeWorkspaceRegistry() })
    const error = await expectCodeAsync(() => harness.service.createSession(harness.lead.agent, {}), 'DEVLEAD_INVALID_INPUT')
    expect(error.message).toContain('no working directory')
  })

  it('creates, renames, watches, and prompts a Session in a Workspace', async () => {
    const controller = new FakeSessionController()
    const registry = new FakeWorkspaceRegistry()
    const dir = await tempDir()
    const harness = await bootService({
      enabled: true,
      leadCwd: dir,
      sessionController: controller,
      workspaceRegistry: registry,
    })
    controller.createHandler = () => {
      const session = harness.ctx.sessions.create(SessionId('created-session'))
      harness.agents.add(new FakeAgent(session))
      return { sessionId: session.id }
    }
    const result = await harness.service.createSession(harness.lead.agent, {
      title: '  New Work  ',
      prompt: '  start on the task  ',
    })
    expect(controller.createCalls).toEqual([{ workspaceId: 'ws-1' }])
    expect(registry.createCalls).toEqual([{ path: dir }])
    expect(harness.sessionTitle.renames).toEqual([{ sessionId: 'created-session', title: 'New Work' }])
    expect(result.workspace).toMatchObject({ workspaceId: 'ws-1', path: dir, status: 'ok' })
    expect(result.prompted).toBe(true)
    expect(result.session).toMatchObject({ sessionId: 'created-session', live: true, watched: true, title: 'New Work' })
    const agent = harness.agents.resolve('created-session')
    expect(agent?.followups).toHaveLength(1)
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['created-session'])
  })

  it('passes the preset through and honors watch:false', async () => {
    const controller = new FakeSessionController()
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/preset-space', title: 'Preset Space' })
    const harness = await bootService({
      enabled: true,
      sessionController: controller,
      workspaceRegistry: registry,
      config: { defaultAgentPreset: 'reviewer' },
    })
    controller.createHandler = () => {
      const session = harness.ctx.sessions.create(SessionId('created-2'))
      harness.agents.add(new FakeAgent(session))
      return { sessionId: session.id }
    }
    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: '/tmp/preset-space',
      preset: 'fast',
      watch: false,
    })
    expect(controller.createCalls).toEqual([{ workspaceId: 'ws-1', agentPreset: 'fast' }])
    expect(result.prompted).toBe(false)
    expect(result.session.watched).toBe(false)
    expect(result.session.live).toBe(true)
    expect(durableWatchRecords(harness)).toEqual([])
  })

  it('falls back to the configured default preset', async () => {
    const controller = new FakeSessionController()
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/default-preset', title: 'Default' })
    const harness = await bootService({
      enabled: true,
      sessionController: controller,
      workspaceRegistry: registry,
      config: { defaultAgentPreset: 'reviewer' },
    })
    controller.createHandler = () => ({ sessionId: SessionId('created-3') })
    await harness.service.createSession(harness.lead.agent, { workspace: 'ws-1' })
    expect(controller.createCalls).toEqual([{ workspaceId: 'ws-1', agentPreset: 'reviewer' }])
  })

  it('maps creation failures to the stable error vocabulary', async () => {
    const notFound = new FakeSessionController(Object.assign(new Error('gone'), { code: 'session/not-found' }))
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/create-space', title: 'Create' })
    const notFoundHarness = await bootService({
      enabled: true,
      sessionController: notFound,
      workspaceRegistry: registry,
    })
    await expectCodeAsync(
      () => notFoundHarness.service.createSession(notFoundHarness.lead.agent, { workspace: 'ws-1' }),
      'DEVLEAD_SESSION_NOT_FOUND',
    )
    const unavailable = new FakeSessionController(new Error('gateway down'))
    const unavailableHarness = await bootService({
      enabled: true,
      sessionController: unavailable,
      workspaceRegistry: registry,
    })
    const error = await expectCodeAsync(
      () => unavailableHarness.service.createSession(unavailableHarness.lead.agent, { workspace: 'ws-1' }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('gateway down')
  })

  it('rejects a create that cannot be watched before creating the Session', async () => {
    const controller = new FakeSessionController()
    controller.createHandler = () => ({ sessionId: SessionId('unused-created') })
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/full-watch-space', title: 'Full' })
    const harness = await bootService({
      enabled: true,
      watched: ['already-watched'],
      sessionController: controller,
      workspaceRegistry: registry,
      config: { maxWatchedSessions: 1 },
    })
    await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, { workspace: 'ws-1' }),
      'DEVLEAD_WATCH_LIMIT',
    )
    expect(controller.createCalls).toEqual([])
    expect(harness.ctx.sessions.get(SessionId('unused-created'))).toBeUndefined()
  })

  it('maps an unusable lead directory to the stable error vocabulary', async () => {
    const controller = new FakeSessionController()
    const registry = new FakeWorkspaceRegistry()
    registry.createError = Object.assign(new Error('gone'), { code: 'ENOENT' })
    const leadCwd = join(await tempDir(), 'moved-away')
    const harness = await bootService({
      enabled: true,
      leadCwd,
      sessionController: controller,
      workspaceRegistry: registry,
    })
    const missing = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {}),
      'DEVLEAD_DIRECTORY_MISSING',
    )
    expect(missing.message).toContain('moved-away')

    registry.createError = new Error('storage offline')
    await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {}),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(controller.createCalls).toEqual([])
  })

  it('requires a Workspace registry when no explicit target is named', async () => {
    const controller = new FakeSessionController()
    const dir = await tempDir()
    const harness = await bootService({ enabled: true, leadCwd: dir, sessionController: controller })
    await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {}),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )
  })
})

describe('notification delivery through the real service', () => {
  /** Boot one enabled lead watching two child Sessions, with an immediate batch window. */
  async function bootWatching(): Promise<ServiceHarness> {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['child-alpha', 'child-beta'],
      config: { notificationBatchMs: 0 },
    })
    await harness.service.watchSession(harness.lead.agent, 'child-alpha', true)
    await harness.service.watchSession(harness.lead.agent, 'child-beta', true)
    return harness
  }

  it('wakes the lead with the durable notification digest of a settled turn', async () => {
    const harness = await bootWatching()
    appendAssistantMessage(requireSession(harness, 'child-alpha'), 1, 'Refactored the loader')
    appendTurnEnd(requireSession(harness, 'child-alpha'), 1)
    await flushMicrotasks()
    expect(harness.lead.followups).toHaveLength(1)
    const notice = harness.lead.followups[0]
    if (notice === undefined) throw new Error('expected one notice')
    expect(notice.source).toMatchObject({ kind: 'devlead', form: 'notice' })
    expect(notificationRecords(harness.leadSession)).toHaveLength(1)
    expect(harness.service.notifications(harness.lead.agent)).toEqual([
      {
        id: notificationId('child-alpha', 1, 'completed'),
        sessionId: 'child-alpha',
        transition: 'completed',
        turn: 1,
        summary: 'Refactored the loader',
        at: expect.any(Number),
      },
    ])
    expect(projectionStateOf(harness.leadSession).notifications).toHaveLength(1)
  })

  it('coalesces transitions of both watched Sessions into one wake', async () => {
    const harness = await bootWatching()
    appendTurnEnd(requireSession(harness, 'child-alpha'), 1)
    appendTurnEnd(requireSession(harness, 'child-beta'), 2, { kind: 'error', error: { message: 'boom', code: 'X' } })
    await flushMicrotasks()
    expect(harness.lead.followups).toHaveLength(1)
    const notice = harness.lead.followups[0]
    if (notice === undefined) throw new Error('expected one notice')
    const text = messageText(notice)
    expect(text).toContain('- child-alpha — turn 1 completed')
    expect(text).toContain('- child-beta — turn 2 failed: boom')
    expect(harness.service.notifications(harness.lead.agent).map(item => item.id)).toEqual([
      'child-alpha:1:completed',
      'child-beta:2:error',
    ])
  })

  it('does not wake when the lead stopped watching the Session', async () => {
    const harness = await bootWatching()
    await harness.service.watchSession(harness.lead.agent, 'child-alpha', false)
    await harness.service.watchSession(harness.lead.agent, 'child-beta', false)
    appendTurnEnd(requireSession(harness, 'child-alpha'), 1)
    await flushMicrotasks()
    expect(harness.lead.followups).toEqual([])
    expect(notificationRecords(harness.leadSession)).toEqual([])
  })
})

describe('domain error surface', () => {
  it('recognizes structural DevLead failures across module instances', () => {
    const domain = new DevLeadError('watch limit reached', 'DEVLEAD_WATCH_LIMIT')
    expect(domain.name).toBe('DevLeadError')
    expect(domain.code).toBe('DEVLEAD_WATCH_LIMIT')
    expect(isDevLeadError(domain)).toBe(true)
    expect(isDevLeadError(Object.assign(new Error('structural'), { code: 'DEVLEAD_SELF_WATCH' }))).toBe(true)
    expect(isDevLeadError(new Error('plain'))).toBe(false)
    expect(isDevLeadError({ code: 'DEVLEAD_WATCH_LIMIT' })).toBe(false)
    expect(isDevLeadError('DEVLEAD_WATCH_LIMIT')).toBe(false)
  })
})

/** Durable mode record payloads of the lead Session, in log order. */
function durableModeRecords(harness: ServiceHarness): Array<Record<string, unknown>> {
  return harness.leadSession.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === DEVLEAD_MODE_RECORD_TYPE ? [record.data as Record<string, unknown>] : []
  })
}

/** Durable watch record payloads of the lead Session, in log order. */
function durableWatchRecords(harness: ServiceHarness): Array<Record<string, unknown>> {
  return harness.leadSession.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === DEVLEAD_WATCH_RECORD_TYPE ? [record.data as Record<string, unknown>] : []
  })
}
