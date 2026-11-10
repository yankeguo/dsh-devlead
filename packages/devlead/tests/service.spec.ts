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
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_RESET_RECORD_TYPE,
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
  modeRecord,
  notificationRecord,
  watchRecord,
} from '../src/index.ts'
import type { Config as DevLeadConfig, DevLeadErrorCode } from '../src/index.ts'
import {
  FakeAgent,
  FakeProjectionCache,
  FakeSessionController,
  FakeSessionPersistence,
  FakeSessionQuery,
  FakeWorkspaceRegistry,
  T0,
  appendAssistantMessage,
  appendTurnEnd,
  appendTurnStart,
  attachPersistedLead,
  bootService,
  disposeHarnesses,
  flushMicrotasks,
  humanMessage,
  messageText,
  nextTask,
  notificationRecords,
  projectionStateOf,
  seedPersistedLead,
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
    // 0.2.0: a cold lead is resumed to deliver by default.
    expect(harness.service.settings.wakeColdSession).toBe(true)
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
      wakeColdSession: true,
      defaultAgentPreset: '',
    })
    expect(() => Config({ notificationBatchMs: -1 })).toThrow()
    expect(() => Config({ maxWatchedSessions: 0 })).toThrow()
    expect(() => Config({ maxListedSessions: 0 })).toThrow()
    expect(() => Config({ notificationBatchMs: 1.5 })).toThrow()
    // Node clamps a larger setTimeout to 1 ms; reject it at the loader boundary.
    expect(() => Config({ notificationBatchMs: 2_147_483_648 })).toThrow()
    expect(Config({ notificationBatchMs: 2_147_483_647 }).notificationBatchMs).toBe(2_147_483_647)
  })

  it('rejects an invalid direct construction outside Loader normalization', () => {
    const cases: Array<Record<string, unknown>> = [
      { notificationBatchMs: -1 },
      { notificationBatchMs: 1.5 },
      { notificationBatchMs: 2_147_483_648 },
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
  /** Boot one enabled harness whose lead log is frozen by a corrupt owned record. */
  async function bootFrozen(): Promise<ServiceHarness> {
    const harness = await bootService({ enabled: true })
    appendPluginRecord(harness.leadSession, DEVLEAD_MODE_RECORD_TYPE, {
      kind: 'devlead/mode',
      version: 1,
      enabled: 'yes',
      at: T0,
    } as never)
    return harness
  }

  it('rejects reads while the first corrupt record freezes the fold', async () => {
    const harness = await bootFrozen()
    expect(projectionStateOf(harness.leadSession).failure).toContain(DEVLEAD_MODE_RECORD_TYPE)
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(false)
    const invalid = expectCode(() => harness.service.view(harness.lead.agent), 'DEVLEAD_PROJECTION_INVALID')
    expect(invalid.message).toContain(DEVLEAD_MODE_RECORD_TYPE)
    expectCode(() => harness.service.notifications(harness.lead.agent), 'DEVLEAD_PROJECTION_INVALID')
    await expectCodeAsync(() => harness.service.listSessions(harness.lead.agent), 'DEVLEAD_PROJECTION_INVALID')
    // assertReady reports the disabled mode (a frozen fold is not "enabled")
    // before the corrupt state; the tool surface cannot mutate a corrupt lead.
    await expectCodeAsync(
      () => harness.service.watchSession(harness.lead.agent, String(harness.lead.id), true),
      'DEVLEAD_NOT_ENABLED',
    )
  })

  it('refuses to enable a frozen fold and points at /devlead reset', async () => {
    const harness = await bootFrozen()
    const error = await expectCodeAsync(
      () => harness.service.setEnabled(harness.lead.agent, true),
      'DEVLEAD_PROJECTION_INVALID',
    )
    expect(error.message).toContain('/devlead reset')
    // Nothing was written: the fold is still frozen and still enabled-never.
    expect(projectionStateOf(harness.leadSession).failure).not.toBeNull()
  })

  it('recovers a frozen fold by turning the mode off', async () => {
    const harness = await bootFrozen()
    await expect(harness.service.setEnabled(harness.lead.agent, false)).resolves.toBeUndefined()
    // The reset marker clears the frozen state: the Session is cleanly disabled.
    expect(projectionStateOf(harness.leadSession)).toEqual({
      enabled: false,
      sessions: [],
      notifications: [],
      failure: null,
    })
    expect(harness.service.view(harness.lead.agent)).toEqual({ enabled: false, sessions: [], notifications: [] })
    // Idempotent: off on an already-off Session writes no extra record.
    const records = durableResetRecords(harness)
    await harness.service.setEnabled(harness.lead.agent, false)
    expect(durableResetRecords(harness)).toEqual(records)
  })

  it('resets damaged state explicitly and can be called repeatedly', async () => {
    const harness = await bootFrozen()
    await expect(harness.service.reset(harness.lead.agent)).resolves.toBeUndefined()
    expect(harness.service.view(harness.lead.agent)).toEqual({ enabled: false, sessions: [], notifications: [] })
    await expect(harness.service.reset(harness.lead.agent)).resolves.toBeUndefined()
    expect(durableResetRecords(harness)).toHaveLength(2)
    // After the reset the Session is a clean disabled state: it can be enabled
    // again and the old corrupt records no longer fold.
    await harness.service.setEnabled(harness.lead.agent, true)
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
  })

  it('resets the watch index and the retained digest as well', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['child-alpha'], watched: ['child-alpha'] })
    appendNotification(harness.leadSession, 'child-alpha', 1)
    await harness.service.reset(harness.lead.agent)
    expect(harness.service.view(harness.lead.agent)).toEqual({ enabled: false, sessions: [], notifications: [] })
  })

  it('requires a live Agent for reset', async () => {
    const harness = await bootService()
    const stale = new FakeAgent(harness.leadSession)
    await expectCodeAsync(() => harness.service.reset(stale.agent), 'DEVLEAD_AGENT_NOT_LIVE')
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

  it('requires a live lead with the mode enabled', async () => {
    const registry = new FakeWorkspaceRegistry()
    const dir = await tempDir()
    const disabled = await bootService({ workspaceRegistry: registry })
    await expectCodeAsync(
      () => disabled.service.useWorkspace(disabled.lead.agent, { path: dir }),
      'DEVLEAD_NOT_ENABLED',
    )
    const enabled = await bootService({ enabled: true, workspaceRegistry: registry })
    const stale = new FakeAgent(enabled.leadSession)
    await expectCodeAsync(
      () => enabled.service.useWorkspace(stale.agent, { path: dir }),
      'DEVLEAD_AGENT_NOT_LIVE',
    )
  })

  it('validates and resolves the directory argument', async () => {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })
    await expectCodeAsync(
      () => harness.service.useWorkspace(harness.lead.agent, { path: '   ' }),
      'DEVLEAD_INVALID_INPUT',
    )

    // The registry (not this service) rejects a relative spelling; the service
    // maps that rejection to the stable input vocabulary.
    registry.createErrors.set(
      'relative/repo',
      new TypeError("Workspace path is not fully qualified: 'relative/repo'"),
    )
    const relative = await expectCodeAsync(
      () => harness.service.useWorkspace(harness.lead.agent, { path: 'relative/repo' }),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(relative.message).toContain('fully qualified')

    const missing = join(await tempDir(), 'missing')
    registry.createErrors.set(missing, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    // `create` defaults to false: a missing directory is never created.
    const missingError = await expectCodeAsync(
      () => harness.service.useWorkspace(harness.lead.agent, { path: missing }),
      'DEVLEAD_DIRECTORY_MISSING',
    )
    expect(missingError.message).toContain('create: true')
    await expect(stat(missing).then(() => true, () => false)).resolves.toBe(false)

    registry.createErrors.set(missing, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    const controller = new AbortController()
    controller.abort()
    await expect(
      harness.service.useWorkspace(harness.lead.agent, { path: missing, create: true }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(stat(missing).then(() => true, () => false)).resolves.toBe(false)
  })

  it('never creates a missing directory when create is false or omitted', async () => {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })
    const missing = join(await tempDir(), 'explicit-false')
    registry.createErrors.set(missing, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    await expectCodeAsync(
      () => harness.service.useWorkspace(harness.lead.agent, { path: missing, create: false }),
      'DEVLEAD_DIRECTORY_MISSING',
    )
    await expect(stat(missing).then(() => true, () => false)).resolves.toBe(false)
    // No mkdir retry happened: only the first registry attempt reached the fake.
    expect(registry.createCalls).toEqual([{ path: missing }])
  })

  it('maps a non-directory path and other registration failures to invalid input', async () => {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })
    const file = join(await tempDir(), 'plain-file')
    await writeFile(file, 'not a directory')
    registry.createErrors.set(file, new Error(`cannot create a workspace at '${file}': path is not a directory`))
    const notDirectory = await expectCodeAsync(
      () => harness.service.useWorkspace(harness.lead.agent, { path: file }),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(notDirectory.message).toContain('not a directory')

    // A parent that is a file makes the recursive creation fail; the failure is
    // classified instead of surfacing a raw `fs` rejection.
    const nested = join(file, 'child')
    registry.createErrors.set(nested, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    await expectCodeAsync(
      () => harness.service.useWorkspace(harness.lead.agent, { path: nested, create: true }),
      'DEVLEAD_INVALID_INPUT',
    )
  })

  it('creates a missing directory only when create is explicitly true', async () => {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })
    const missing = join(await tempDir(), 'nested', 'repo')
    registry.createErrors.set(missing, Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
    const view = await harness.service.useWorkspace(harness.lead.agent, {
      path: missing,
      title: '  Nested Repo  ',
      create: true,
    })
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

  it('reuses an existing registry entry and keeps its registered title', async () => {
    const dir = await tempDir()
    const registry = new FakeWorkspaceRegistry()
    const existing = registry.add({ path: dir, title: 'Known' })
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })
    const view = await harness.service.useWorkspace(harness.lead.agent, { path: dir, title: '  Renamed  ' })
    expect(view.workspaceId).toBe(existing.id)
    expect(view.title).toBe('Known')
    expect(registry.createCalls).toEqual([{ path: dir, title: 'Renamed' }])
  })

  it('fails when no Workspace registry is composed or registration fails', async () => {
    const withoutRegistry = await bootService({ enabled: true })
    const missingDir = await tempDir()
    await expectCodeAsync(
      () => withoutRegistry.service.useWorkspace(withoutRegistry.lead.agent, { path: missingDir }),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )

    const registry = new FakeWorkspaceRegistry()
    registry.createError = new Error('registry is read-only')
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })
    const failedDir = await tempDir()
    // A registration failure is not a missing directory: the path exists, so the
    // caller must not be told to create it.
    const error = await expectCodeAsync(
      () => harness.service.useWorkspace(harness.lead.agent, { path: failedDir }),
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

  it('keeps the latest failure as a bounded single-line excerpt', async () => {
    const query = new FakeSessionQuery()
    query.seed('cold-error', [
      sessionEvent(
        0,
        'turn/end',
        { turn: 1, reason: { kind: 'error', error: { message: `provider\nquota ${'x'.repeat(500)}`, code: 'X' } } },
        T0 + 1,
      ),
    ])
    const harness = await bootService({ enabled: true, sessionQuery: query })
    const view = await harness.service.getSession(harness.lead.agent, 'cold-error')
    expect(view.lastTransition).toBe('error')
    expect(view.lastError).toBeDefined()
    expect(view.lastError).not.toContain('\n')
    expect(view.lastError).toHaveLength(DEVLEAD_ERROR_EXCERPT_MAX)
    expect(view.lastError?.endsWith('…')).toBe(true)
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

  it('compensates the automatic watch when cancellation arrives during prompt resolution', async () => {
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
    // Admission never happened, so the watch this call added is compensated: the
    // failure leaves no newly-added watch behind.
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
    expect(durableWatchRecords(harness)).toHaveLength(2)
    expect(durableWatchRecords(harness).at(-1)).toMatchObject({ sessions: [] })
  })

  it('compensates the automatic watch when admitting the prompt fails', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.failFollowups = 1
    harness.agents.add(target)
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'work'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
    expect(target.followups).toHaveLength(0)
  })

  it('compensates the automatic watch when resuming the target Session fails', async () => {
    const controller = new FakeSessionController()
    const harness = await bootService({ enabled: true, sessionIds: ['target'], sessionController: controller })
    controller.resolveHandler = () => ({ error: { message: 'busy', code: 'session/agent-busy' } })
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'continue'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
  })

  it('preserves a pre-existing explicit watch when admission fails', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.failFollowups = 1
    harness.agents.add(target)
    const before = durableWatchRecords(harness)
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'work'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    // The failure must not undo a watch the caller already had: only a watch
    // this very call added is compensated.
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['target'])
    expect(durableWatchRecords(harness)).toEqual(before)
  })

  it('does not touch the watch set when watch is false and admission fails', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.failFollowups = 1
    harness.agents.add(target)
    const before = durableWatchRecords(harness)
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'work', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(durableWatchRecords(harness)).toEqual(before)
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
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

  it('never truncates a watched-only listing below the watch set even with an explicit limit', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['watch-1', 'watch-2', 'watch-3'],
      watched: ['watch-1', 'watch-2', 'watch-3'],
      config: { maxListedSessions: 2 },
    })
    const views = await harness.service.listSessions(harness.lead.agent, { watchedOnly: true, limit: 1 })
    expect(views.map(view => view.sessionId).sort()).toEqual(['watch-1', 'watch-2', 'watch-3'])
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

describe('session reference resolution', () => {
  /** Real-shaped Session ids: a model often passes only the uuid head. */
  const ALPHA = 'session-e59ab350-65be-4db6-83bd-9261c5847186'
  const ALPHA_SIBLING = 'session-e59ab350-aaaa-4db6-83bd-9261c5847186'
  const BETA = 'session-b91f2c07-1a2b-4c3d-8e4f-5a6b7c8d9e0f'

  it('resolves full ids, session- prefixed prefixes, and bare uuid heads', async () => {
    const harness = await bootService({ enabled: true, sessionIds: [ALPHA, BETA] })
    try {
      // Full id, `session-`-prefixed partial id, bare uuid head, bare full
      // uuid, and a padded bare head all address the same Session.
      for (const reference of [
        ALPHA,
        'session-e59ab350',
        'session-e59ab350-65be',
        'e59ab350',
        'e59ab350-65be-4db6-83bd-9261c5847186',
        '  e59ab350  ',
      ]) {
        const view = await harness.service.getSession(harness.lead.agent, reference)
        expect(view.sessionId).toBe(ALPHA)
      }
      // Watch mutations resolve through the same tolerance and store the full id.
      await harness.service.watchSession(harness.lead.agent, 'b91f2c07', true)
      expect(harness.service.view(harness.lead.agent).sessions).toEqual([BETA])
    } finally {
      await harness.dispose()
    }
  })

  it('keeps a uuid head shared by two Sessions ambiguous and lists the candidates', async () => {
    const harness = await bootService({ enabled: true, sessionIds: [ALPHA, ALPHA_SIBLING, BETA] })
    try {
      const error = await expectCodeAsync(
        () => harness.service.getSession(harness.lead.agent, 'e59ab350'),
        'DEVLEAD_INVALID_INPUT',
      )
      expect(error.message).toContain('ambiguous')
      expect(error.message).toContain(ALPHA)
      expect(error.message).toContain(ALPHA_SIBLING)
      expect(error.message).not.toContain(BETA)
      // A longer reference that is still unique resolves again.
      const view = await harness.service.getSession(harness.lead.agent, 'e59ab350-65be')
      expect(view.sessionId).toBe(ALPHA)
    } finally {
      await harness.dispose()
    }
  })

  it('reports a truncated reference as recoverable instead of final', async () => {
    const harness = await bootService({ enabled: true, sessionIds: [ALPHA] })
    try {
      const error = await expectCodeAsync(
        () => harness.service.getSession(harness.lead.agent, 'deadbeef'),
        'DEVLEAD_SESSION_NOT_FOUND',
      )
      expect(error.message).toContain('incomplete or truncated')
      expect(error.message).toContain('devlead_list_sessions')
    } finally {
      await harness.dispose()
    }
  })

  it('does not address a subagent-origin Session through a truncated reference', async () => {
    const harness = await bootService({ enabled: true, sessionIds: [ALPHA] })
    try {
      harness.ctx.sessions.create(
        SessionId('session-c0ffee00-1111-4222-8333-444455556666'),
        { meta: { origin: 'subagent' } },
      )
      // The subagent Session is routed by the subagent runtime: neither its
      // head nor its full id is addressable here.
      await expectCodeAsync(
        () => harness.service.getSession(harness.lead.agent, 'c0ffee00'),
        'DEVLEAD_SESSION_NOT_FOUND',
      )
      await expectCodeAsync(
        () => harness.service.getSession(harness.lead.agent, 'session-c0ffee00'),
        'DEVLEAD_SESSION_NOT_FOUND',
      )
      // The ordinary Session on the same resolution path still resolves.
      const view = await harness.service.getSession(harness.lead.agent, 'e59ab350')
      expect(view.sessionId).toBe(ALPHA)
    } finally {
      await harness.dispose()
    }
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

  it('reserves the watch slot before creating so a concurrent create cannot orphan', async () => {
    const controller = new FakeSessionController()
    let releaseCreate: (() => void) | undefined
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    let created = 0
    let booted: ServiceHarness | undefined
    controller.createHandler = async () => {
      await createGate
      created += 1
      const session = booted!.ctx.sessions.create(SessionId(`concurrent-${String(created)}`))
      booted!.agents.add(new FakeAgent(session))
      return { sessionId: session.id }
    }
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/concurrent-space', title: 'Concurrent' })
    booted = await bootService({
      enabled: true,
      sessionController: controller,
      workspaceRegistry: registry,
      config: { maxWatchedSessions: 1 },
    })
    const harness = booted
    const first = harness.service.createSession(harness.lead.agent, { workspace: 'ws-1' })
    // The first call has reserved the only slot and is awaiting create; the
    // second must fail before it asks the controller for a Session.
    await flushMicrotasks()
    const secondError = await harness.service
      .createSession(harness.lead.agent, { workspace: 'ws-1' })
      .then(() => undefined, (error: unknown) => error)
    expect((secondError as { code?: unknown } | undefined)?.code).toBe('DEVLEAD_WATCH_LIMIT')
    // Only the first call reached the controller; the second was rejected while
    // the first slot was reserved.
    expect(controller.createCalls).toHaveLength(1)
    releaseCreate?.()
    const result = await first
    expect(result.session.watched).toBe(true)
    expect(controller.createCalls).toHaveLength(1)
    expect(harness.service.view(harness.lead.agent).sessions).toHaveLength(1)
  })

  it('rejects a registered Workspace whose directory disappeared', async () => {
    const controller = new FakeSessionController()
    controller.createHandler = () => {
      throw new Error('controller must not be called for a missing directory')
    }
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/disappeared-space', title: 'Disappeared', status: 'missing-dir' })
    const harness = await bootService({
      enabled: true,
      sessionController: controller,
      workspaceRegistry: registry,
    })
    const error = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, { workspace: 'ws-1' }),
      'DEVLEAD_DIRECTORY_MISSING',
    )
    expect(error.message).toContain('Disappeared')
    expect(controller.createCalls).toEqual([])
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
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

  it('ignores a persisted self-watch instead of notifying the lead on its own turn', async () => {
    const harness = await bootService({
      enabled: true,
      leadId: 'self-lead',
      config: { notificationBatchMs: 0 },
    })
    const spy = vi.spyOn(harness.ctx.logger, 'warn')
    // A hand-edited log can still replay a syntactically valid watch record
    // that names the lead itself; the hub must ignore it at index time.
    appendPluginRecord(harness.leadSession, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(['self-lead'], T0))
    appendTurnEnd(harness.leadSession, 1)
    await flushMicrotasks()
    expect(notificationRecords(harness.leadSession)).toEqual([])
    expect(harness.lead.followups).toHaveLength(0)
    expect(spy.mock.calls.some(call => String(call[0]).includes('lists itself'))).toBe(true)
    spy.mockRestore()
  })

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

describe('cold lead rehydration', () => {
  it('rehydrates a persisted lead the projection cache pre-filters as enabled and resumes it', async () => {
    const controller = new FakeSessionController()
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const watchedId = 'cold-watched-child'
    await seedPersistedLead(query, { sessionId: 'cold-lead-enabled', watched: [watchedId] })
    cache.setDevLead('cold-lead-enabled', { enabled: true, sessions: [watchedId] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['cold-lead-enabled']
    const harness = await bootService({
      enabled: true,
      sessionIds: [watchedId],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      sessionController: controller,
      config: { notificationBatchMs: 0 },
    })
    expect(cache.lookupCalls).toBe(1)
    expect(query.readSessionCalls).toBe(1)
    controller.resolveHandler = () => {
      const agent = attachPersistedLead(harness.ctx, harness.agents, {
        sessionId: 'cold-lead-enabled',
        watched: [watchedId],
      })
      return { agent: agent.agent }
    }
    appendTurnEnd(requireSession(harness, watchedId), 1)
    await flushMicrotasks(512)
    // wakeColdSession defaults to true: the cold lead is resumed so the durable
    // record is written and the coalesced digest delivered.
    expect(controller.resolveCalls.map(String)).toEqual(['cold-lead-enabled'])
    const resumed = harness.agents.resolve('cold-lead-enabled')
    expect(resumed).toBeDefined()
    expect(resumed?.followups).toHaveLength(1)
    expect(notificationRecords(resumed!.session)).toHaveLength(1)
    expect(messageText(resumed!.followups[0]!)).toContain('— turn 1 completed')
  })

  it('skips a persisted Session the projection cache pre-filters as disabled', async () => {
    const controller = new FakeSessionController()
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    await seedPersistedLead(query, { sessionId: 'disabled-lead', watched: ['cold-watched-child'] })
    cache.setDevLead('disabled-lead', { enabled: false, sessions: ['cold-watched-child'] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['disabled-lead']
    const harness = await bootService({
      enabled: true,
      sessionIds: ['cold-watched-child'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      sessionController: controller,
      config: { notificationBatchMs: 0 },
    })
    // The fast path never reads the complete log of a row that positively says
    // "disabled".
    expect(query.readSessionCalls).toBe(0)
    appendTurnEnd(requireSession(harness, 'cold-watched-child'), 1)
    await flushMicrotasks(512)
    expect(controller.resolveCalls).toEqual([])
    expect(harness.lead.followups).toHaveLength(0)
  })

  it('needs an exact fold for an enabled cache row whose log carries no enabled record', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    // The cache row is stale/wrong: the exact fold is authoritative.
    await seedPersistedLead(query, { sessionId: 'stale-cache-lead', enabled: false, watched: ['cold-watched-child'] })
    cache.setDevLead('stale-cache-lead', { enabled: true, sessions: ['cold-watched-child'] })
    const controller = new FakeSessionController()
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['stale-cache-lead']
    const harness = await bootService({
      enabled: true,
      sessionIds: ['cold-watched-child'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      sessionController: controller,
      config: { notificationBatchMs: 0 },
    })
    expect(query.readSessionCalls).toBe(1)
    appendTurnEnd(requireSession(harness, 'cold-watched-child'), 1)
    await flushMicrotasks(512)
    expect(controller.resolveCalls).toEqual([])
  })

  it('adopts a live Session without an Agent as a lead', async () => {
    const harness = await bootService({
      sessionIds: ['attach-only-lead', 'attach-only-child'],
      seedSessions: (sessions) => {
        appendPluginRecord(sessions['attach-only-lead']!, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
        appendPluginRecord(sessions['attach-only-lead']!, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(['attach-only-child'], T0))
      },
      config: { notificationBatchMs: 0 },
    })
    appendTurnEnd(requireSession(harness, 'attach-only-child'), 1)
    await flushMicrotasks(512)
    // The attach-only lead Session can append its durable record even though it
    // has no Agent; the digest waits for the Agent to appear.
    const leadSession = requireSession(harness, 'attach-only-lead')
    expect(notificationRecords(leadSession)).toHaveLength(1)
    const agent = new FakeAgent(leadSession)
    harness.agents.add(agent)
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    await flushMicrotasks(512)
    expect(agent.followups).toHaveLength(1)
  })

  it('waits for the optional persistence binding before adopting cold leads', async () => {
    const controller = new FakeSessionController()
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const watchedId = 'late-persist-child'
    await seedPersistedLead(query, { sessionId: 'late-persist-lead', watched: [watchedId] })
    cache.setDevLead('late-persist-lead', { enabled: true, sessions: [watchedId] })
    // The real query engine is composed, but its optional persistence binding is
    // not installed yet: listing the persisted corpus would silently see nothing.
    const harness = await bootService({
      enabled: true,
      sessionIds: [watchedId],
      sessionQuery: query,
      projectionCache: cache,
      sessionController: controller,
      config: { notificationBatchMs: 0 },
    })
    expect(query.listSessionsCalls).toBe(0)
    expect(query.readSessionCalls).toBe(0)
    appendTurnEnd(requireSession(harness, watchedId), 1)
    await flushMicrotasks(512)
    // Without the cold index the turn is not observed, and the lead is not resumed.
    expect(controller.resolveCalls).toEqual([])
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['late-persist-lead']
    harness.ctx.provide('sessionPersistence', persistence)
    await nextTask()
    // The readiness barrier confirms the corpus, then the authoritative scan
    // rebuilds the index.
    expect(query.listSessionsCalls).toBe(2)
    expect(query.readSessionCalls).toBe(1)
    appendTurnEnd(requireSession(harness, watchedId), 2)
    await flushMicrotasks(512)
    expect(controller.resolveCalls.map(String)).toEqual(['late-persist-lead'])
    expect(notificationRecords(requireSession(harness, watchedId))).toEqual([])
  })

  it('waits out a stale corpus listing before the authoritative scan', async () => {
    const controller = new FakeSessionController()
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const watchedId = 'warmup-child'
    await seedPersistedLead(query, { sessionId: 'warmup-lead', watched: [watchedId] })
    cache.setDevLead('warmup-lead', { enabled: true, sessions: [watchedId] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['warmup-lead']
    // The persistence service reports the stored lead, but the query corpus is
    // still live-only on its first listing: the readiness barrier must wait for
    // consistency instead of scanning (and finalizing) too early.
    query.emptyListings = 1
    const harness = await bootService({
      enabled: true,
      sessionIds: [watchedId],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      sessionController: controller,
      config: { notificationBatchMs: 0 },
    })
    // [Service.init] only resolved after the corpus became consistent: one stale
    // readiness listing, one consistent readiness listing, then the scan.
    expect(persistence.listCalls).toBe(1)
    expect(query.listSessionsCalls).toBe(3)
    expect(query.readSessionCalls).toBe(1)
    // The index is rebuilt: the next watched turn/end resumes the cold lead.
    appendTurnEnd(requireSession(harness, watchedId), 1)
    await flushMicrotasks(512)
    expect(controller.resolveCalls.map(String)).toEqual(['warmup-lead'])
    // Rehydration is final: no further corpus rescans on later traffic.
    appendTurnEnd(requireSession(harness, watchedId), 2)
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    await nextTask()
    expect(query.listSessionsCalls).toBe(3)
  })

  it('loads and serves live leads when the corpus never becomes consistent', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    // The persistence service reports a stored Session the corpus never lists:
    // the barrier must give up after its bound instead of hanging plugin load.
    persistence.ids = ['ghost-session']
    const started = Date.now()
    const harness = await bootService({
      enabled: true,
      sessionIds: ['unrelated-child'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      config: { notificationBatchMs: 0 },
    })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(1_900)
    expect(elapsed).toBeLessThan(5_000)
    // The plugin still loaded and serves the enabled live lead.
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
    expect(harness.service.view(harness.lead.agent).enabled).toBe(true)
    // The barrier polls the corpus, then the authoritative scan still runs.
    expect(query.listSessionsCalls).toBeGreaterThan(1)
  })

  it('does not scan the persisted corpus on events while persistence is absent', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    await seedPersistedLead(query, { sessionId: 'no-persist-lead', watched: ['no-persist-child'] })
    cache.setDevLead('no-persist-lead', { enabled: true, sessions: ['no-persist-child'] })
    const harness = await bootService({
      enabled: true,
      sessionIds: ['no-persist-child'],
      sessionQuery: query,
      projectionCache: cache,
      config: { notificationBatchMs: 0 },
    })
    appendTurnEnd(requireSession(harness, 'no-persist-child'), 1)
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    await nextTask()
    // A Host without persistence can never list a persisted corpus: no event
    // may trigger a pointless scan.
    expect(query.listSessionsCalls).toBe(0)
    expect(query.readSessionCalls).toBe(0)
  })

  it('runs the readiness scan once and stops retrying after it', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['once-child'], config: { notificationBatchMs: 0 } })
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    await seedPersistedLead(query, { sessionId: 'once-lead', watched: ['once-child'] })
    cache.setDevLead('once-lead', { enabled: true, sessions: ['once-child'] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['once-lead']
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    await nextTask()
    // One readiness listing (consistency check) + one authoritative scan, then final.
    expect(query.listSessionsCalls).toBe(2)
    // Later lifecycle traffic must not rescan the corpus.
    appendTurnEnd(requireSession(harness, 'once-child'), 1)
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    harness.ctx.emit('agent/status', { agent: harness.lead.agent, status: 'idle' })
    await nextTask()
    expect(query.listSessionsCalls).toBe(2)
  })

  it('retries a deferred cold scan when the query engine appears, warns on corrupt candidates, and caps unknown reads', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    // One candidate the cache calls a lead but whose exact fold is corrupt.
    await seedPersistedLead(query, {
      sessionId: 'corrupt-cold-lead',
      watched: ['cold-watched-child'],
      seed: (session) => {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, {
          kind: 'devlead/mode',
          version: 1,
          enabled: 'yes',
          at: T0,
        } as never)
      },
    })
    cache.setDevLead('corrupt-cold-lead', { enabled: true, sessions: ['cold-watched-child'] })
    // 70 rows the cache cannot classify: only a bounded number may be read.
    for (let index = 0; index < 70; index += 1) query.seed(`unknown-cold-${String(index)}`, [])
    const harness = await bootService({ enabled: true, sessionIds: ['cold-watched-child'] })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    // Late composition of all three services: the readiness retry fires on the
    // next Session lifecycle event.
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['corrupt-cold-lead']
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    appendTurnEnd(requireSession(harness, 'cold-watched-child'), 1)
    await nextTask()
    // 1 known-enabled candidate + at most 64 unclassified logs.
    expect(query.readSessionCalls).toBe(65)
    expect(warn.mock.calls.some(call => String(call[0]).includes('corrupt DevLead replay'))).toBe(true)
    expect(warn.mock.calls.some(call => String(call[0]).includes('stopped reading unclassified'))).toBe(true)
    warn.mockRestore()
  })

  it('keeps the one-shot rehydration retry armed until the query engine exists', async () => {
    const harness = await bootService({ enabled: true })
    // An event arrives while the query engine is still missing: the retry
    // listeners must not be consumed by it.
    appendTurnEnd(harness.leadSession, 1)
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    await seedPersistedLead(query, { sessionId: 'late-lead', watched: ['late-child'] })
    cache.setDevLead('late-lead', { enabled: true, sessions: ['late-child'] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['late-lead']
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    appendTurnEnd(harness.leadSession, 2)
    await nextTask()
    expect(query.readSessionCalls).toBe(1)
  })

  it('rehydrates only live leads when no projection cache is composed', async () => {
    const query = new FakeSessionQuery()
    await seedPersistedLead(query, { sessionId: 'persisted-lead', watched: ['cold-watched-child'] })
    const harness = await bootService({ enabled: true })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['persisted-lead']
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    appendTurnEnd(harness.leadSession, 1)
    await nextTask()
    expect(query.readSessionCalls).toBe(0)
    expect(warn.mock.calls.some(call => String(call[0]).includes('no Session projection cache'))).toBe(true)
    warn.mockRestore()
  })

  it('never fails the plugin load when the persisted scan rejects', async () => {
    const query = new FakeSessionQuery()
    query.listError = new Error('index unavailable')
    const cache = new FakeProjectionCache()
    const harness = await bootService({ enabled: true })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    // A deferred scan that fails only warns; the service stays usable and the
    // live lead index bootstrapped at load is untouched.
    const persistence = new FakeSessionPersistence()
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    appendTurnEnd(harness.leadSession, 1)
    await nextTask()
    expect(harness.service.view(harness.lead.agent).enabled).toBe(true)
    expect(warn.mock.calls.some(call => String(call[0]).includes('could not list persisted Sessions'))).toBe(true)
    warn.mockRestore()
  })
})

describe('reset recovery through the notification hub', () => {
  it('drops a lead watch index when the hostile fold is reset', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['child-alpha'], watched: ['child-alpha'], config: { notificationBatchMs: 0 } })
    expect(projectionStateOf(harness.leadSession).sessions).toEqual(['child-alpha'])
    await harness.service.reset(harness.lead.agent)
    appendTurnEnd(requireSession(harness, 'child-alpha'), 1)
    await flushMicrotasks(512)
    // The reset disabled the Session, so its stale index no longer observes.
    expect(notificationRecords(harness.leadSession)).toEqual([])
    expect(harness.lead.followups).toHaveLength(0)
  })

  it('recovers a frozen lead fold through setEnabled(false) and clears the index', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['child-alpha'], watched: ['child-alpha'], config: { notificationBatchMs: 0 } })
    appendPluginRecord(harness.leadSession, DEVLEAD_MODE_RECORD_TYPE, {
      kind: 'devlead/mode',
      version: 1,
      enabled: 'yes',
      at: T0,
    } as never)
    expect(projectionStateOf(harness.leadSession).failure).not.toBeNull()
    await expect(harness.service.setEnabled(harness.lead.agent, false)).resolves.toBeUndefined()
    appendTurnEnd(requireSession(harness, 'child-alpha'), 1)
    await flushMicrotasks(512)
    expect(notificationRecords(harness.leadSession)).toEqual([])
    expect(harness.lead.followups).toHaveLength(0)
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

/** Durable reset record payloads of the lead Session, in log order. */
function durableResetRecords(harness: ServiceHarness): Array<Record<string, unknown>> {
  return harness.leadSession.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === DEVLEAD_RESET_RECORD_TYPE ? [record.data as Record<string, unknown>] : []
  })
}
