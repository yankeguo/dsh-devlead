/**
 * Integration coverage of the DevLead core service against a real cordis
 * Context, the real Session log, and the real `devLead` Session projection.
 *
 * Only the host capabilities around the service (`agents`, `workspaceRegistry`,
 * `sessionController`, `sessionTitle`) are deterministic fakes: there is no
 * Agent loop, model, network, or persistent store, and the notification batch
 * window is flushed on microtasks instead of wall-clock sleeps.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  DEVLEAD_REPORT_ANSWER_RECORD_TYPE,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadReportAnswer, DevLeadSessionView, DevLeadTransition } from '@yankeguo/dsh-devlead-protocol'
import {
  Config,
  DevLeadError,
  DevLeadService,
  answerTextHash,
  createDevLeadNoticeMessage,
  devLeadNotification,
  devLeadReport,
  isDevLeadError,
  modeRecord,
  notificationRecord,
  reportAnswerRecord,
  reportRecord,
  watchRecord,
} from '../src/index.ts'
import type { Config as DevLeadConfig, DevLeadErrorCode } from '../src/index.ts'
import {
  FakeAgent,
  FakeAgentDefaultModel,
  FakeAgentTeams,
  FakeModelValidator,
  FakeProjectionCache,
  FakeSessionController,
  FakeSessionPersistence,
  FakeSessionQuery,
  FakeStorageDomain,
  FakeWorkspaceRegistry,
  T0,
  appendAssistantMessage,
  appendTurnEnd,
  appendTurnStart,
  attachPersistedLead,
  bootService,
  buildForkedPersistedLogs,
  disposeHarnesses,
  flushMicrotasks,
  humanMessage,
  messageText,
  nextTask,
  notificationRecords,
  projectionStateOf,
  queuedMessage,
  seedPersistedLead,
  seedPersistedLog,
} from './harness.ts'
import type { ServiceHarness } from './harness.ts'
import { answer, sessionEvent } from './fixtures.ts'

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

/**
 * Seed one pending outbox row into a fake storage table, exactly as a previous
 * Host incarnation would have left it.
 * @param storage - fake storage-domain facility backing the service.
 * @param report - durable report payload.
 * @param enqueuedAt - epoch milliseconds when the row was first written.
 */
function seedOutboxRow(
  storage: FakeStorageDomain,
  report: ReturnType<typeof devLeadReport>,
  enqueuedAt: number,
): void {
  storage.table('devlead_report_outbox', 'pending').records.set(
    Buffer.from(`${report.leadSessionId}\u0000${report.id}`, 'utf8').toString('base64url'),
    { report, enqueuedAt },
  )
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
      reports: [],
    })
    expect(projectionStateOf(harness.leadSession)).toEqual({
      enabled: false,
      sessions: [],
      notifications: [],
      reports: [],
      answers: [],
      failure: null,
      inheritedEventCount: 0,
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

  it('eagerly checkpoints the projection cache after durable mode and watch writes', async () => {
    const cache = new FakeProjectionCache()
    const harness = await bootService({
      projectionCache: cache,
      sessionIds: ['child-alpha'],
    })
    await harness.service.setEnabled(harness.lead.agent, true)
    expect(cache.writeCalls).toBe(1)
    await harness.service.watchSession(harness.lead.agent, 'child-alpha', true)
    expect(cache.writeCalls).toBe(2)
    await harness.service.setEnabled(harness.lead.agent, false)
    expect(cache.writeCalls).toBe(3)
  })

  it('keeps a cache checkpoint failure a warning, not a failed mutation', async () => {
    const cache = new FakeProjectionCache()
    cache.writeError = new Error('cache offline')
    const harness = await bootService({ projectionCache: cache })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    try {
      await expect(harness.service.setEnabled(harness.lead.agent, true)).resolves.toBeUndefined()
      expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cache offline'))
    } finally {
      warn.mockRestore()
    }
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

  it('never lets a subagent Session hold or expose DevLead mode', async () => {
    const harness = await bootService({ sessionIds: ['sec-child'] })
    const child = new FakeAgent(requireSession(harness, 'sec-child'))
    harness.agents.add(child)
    const subSession = harness.ctx.sessions.create(
      SessionId('session-subagent-lead'),
      { meta: { origin: 'subagent' } },
    )
    const sub = new FakeAgent(subSession)
    harness.agents.add(sub)
    // A fork/hand-edited log could carry an enabled mode and a watch set.
    appendPluginRecord(subSession, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
    appendPluginRecord(subSession, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(['sec-child'], T0))
    harness.ctx.emit('agent/created', { agent: sub.agent, source: 'resume' })
    await flushMicrotasks(64)

    expect(harness.service.isEnabled(sub.agent)).toBe(false)
    expect(harness.service.isSupervised(child.agent)).toBe(false)
    await expectCodeAsync(
      () => harness.service.setEnabled(sub.agent, true),
      'DEVLEAD_INVALID_INPUT',
    )
  })
})

describe('global single active mode', () => {
  it('rejects a second Session and names the active occupant', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['child-b'] })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)
    harness.sessionTitle.set(String(harness.lead.id), 'Lead Alpha')

    const error = await expectCodeAsync(
      () => harness.service.setEnabled(child.agent, true),
      'DEVLEAD_ALREADY_ACTIVE',
    )
    expect(error.message).toContain('Lead Alpha')
    expect(error.message).toContain(String(harness.lead.id))
    expect(error.message).toContain('/devlead off')
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
    expect(harness.service.isEnabled(child.agent)).toBe(false)
  })

  it('serializes two simultaneous activations so only one wins', async () => {
    const harness = await bootService({ sessionIds: ['child-a', 'child-b'] })
    const alpha = new FakeAgent(requireSession(harness, 'child-a'))
    const beta = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(alpha)
    harness.agents.add(beta)

    const results = await Promise.allSettled([
      harness.service.setEnabled(alpha.agent, true),
      harness.service.setEnabled(beta.agent, true),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') {
      expect((rejected.reason as DevLeadError).code).toBe('DEVLEAD_ALREADY_ACTIVE')
    }
    expect([alpha, beta].filter(candidate => harness.service.isEnabled(candidate.agent))).toHaveLength(1)
  })

  it('releases the global slot immediately on off', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['child-b'] })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)
    await expectCodeAsync(() => harness.service.setEnabled(child.agent, true), 'DEVLEAD_ALREADY_ACTIVE')

    await harness.service.setEnabled(harness.lead.agent, false)
    await harness.service.setEnabled(child.agent, true)
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(false)
    expect(harness.service.isEnabled(child.agent)).toBe(true)
  })

  it('releases an archived holder before enabling the waiting Session', async () => {
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootService({ enabled: true, sessionIds: ['child-b'], workspaceRegistry: registry })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)
    registry.archived = [String(harness.lead.id)]

    await harness.service.setEnabled(child.agent, true)
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(false)
    expect(harness.service.isEnabled(child.agent)).toBe(true)
    expect(durableModeRecords(harness).map(record => record.enabled)).toEqual([true, false])
  })

  it('keeps exactly one live Session when startup finds several enabled', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['duplicate-a', 'duplicate-b'],
      seedSessions: (sessions) => {
        appendPluginRecord(sessions['duplicate-a']!, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0 + 1))
        appendPluginRecord(sessions['duplicate-b']!, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0 + 2))
      },
    })
    const sessions = [
      harness.leadSession,
      requireSession(harness, 'duplicate-a'),
      requireSession(harness, 'duplicate-b'),
    ]
    expect(sessions.filter(session => projectionStateOf(session).enabled)).toHaveLength(1)
  })

  it('drops the watch index of an attach-only duplicate released during boot reconciliation', async () => {
    const harness = await bootService({
      leadId: 'lead-attach-only',
      enabled: true,
      sessionIds: ['attach-only-child', 'attach-only-dup'],
      extraAgents: (agents) => {
        // Keep the primary lead ahead of the attach-only duplicate in the
        // recovery ranking so this test exercises releasing the duplicate.
        agents.resolve(SessionId('lead-attach-only'))?.setRunning(true)
      },
      seedSessions: (sessions) => {
        appendPluginRecord(sessions['attach-only-dup']!, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0 + 1))
        appendPluginRecord(sessions['attach-only-dup']!, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(['attach-only-child'], T0 + 1))
      },
    })
    const duplicate = requireSession(harness, 'attach-only-dup')
    // Startup reconciliation wrote the durable mode-off without an Agent.
    expect(projectionStateOf(duplicate).enabled).toBe(false)

    const child = new FakeAgent(requireSession(harness, 'attach-only-child'))
    harness.agents.add(child)
    expect(harness.service.isSupervised(child.agent)).toBe(false)

    appendTurnEnd(child.session, 1)
    await flushMicrotasks(256)
    expect(notificationRecords(duplicate)).toEqual([])
  })

  it('skips a legacy subagent fork inherited prefix during cold admission', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const watchedId = 'fork-admission-child'
    const logs = await buildForkedPersistedLogs({
      parentId: 'fork-admission-parent',
      childId: 'fork-admission-subagent',
      origin: 'subagent',
      buildInherited: (session) => {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
        appendPluginRecord(session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([watchedId], T0))
      },
    })
    expect(logs.child.inheritedEventCount).toBeGreaterThan(0)
    seedPersistedLog(query, logs.child)
    cache.setDevLead('fork-admission-subagent', { enabled: true, sessions: [watchedId] })
    const harness = await bootService({
      sessionIds: [watchedId],
      sessionQuery: query,
      projectionCache: cache,
    })
    const child = new FakeAgent(requireSession(harness, watchedId))
    harness.agents.add(child)
    await harness.service.setEnabled(child.agent, true)
    expect(harness.service.isEnabled(child.agent)).toBe(true)
    // The subagent origin is skipped before the cache pre-filter or log read.
    expect(query.readSessionCalls).toBe(0)
  })

  it('does not treat an ordinary fork inherited prefix as a cold occupant', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const watchedId = 'ordinary-fork-admission-watched-child'
    const logs = await buildForkedPersistedLogs({
      parentId: 'ordinary-fork-admission-parent',
      childId: 'ordinary-fork-admission-child',
      buildInherited: (session) => {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
        appendPluginRecord(session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([watchedId], T0))
      },
    })
    // This is the scanActiveSessions branch, not the subagent origin skip: the
    // fork header has no subagent origin.
    expect(logs.child.header.origin).not.toBe('subagent')
    expect(logs.child.inheritedEventCount).toBeGreaterThan(0)
    seedPersistedLog(query, logs.child)
    cache.setDevLead('ordinary-fork-admission-child', { enabled: true, sessions: [watchedId] })
    const harness = await bootService({
      sessionIds: ['fresh-admission-lead', watchedId],
      sessionQuery: query,
      projectionCache: cache,
    })
    const fresh = new FakeAgent(requireSession(harness, 'fresh-admission-lead'))
    harness.agents.add(fresh)
    await harness.service.setEnabled(fresh.agent, true)
    expect(harness.service.isEnabled(fresh.agent)).toBe(true)
    // The cold scan really read the fork log and folded it with its prefix.
    expect(query.readSessionCalls).toBe(1)
  })

  it('does not rehydrate an ordinary fork as a lead or displace its parent', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    const watchedId = 'fork-watched-child'
    const logs = await buildForkedPersistedLogs({
      parentId: 'fork-parent-lead',
      childId: 'fork-ordinary-child',
      buildInherited: (session) => {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
        appendPluginRecord(session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([watchedId], T0))
      },
    })
    expect(logs.child.inheritedEventCount).toBeGreaterThan(0)
    seedPersistedLog(query, logs.parent)
    seedPersistedLog(query, logs.child)
    cache.setDevLead('fork-parent-lead', { enabled: true, sessions: [watchedId] })
    cache.setDevLead('fork-ordinary-child', { enabled: true, sessions: [watchedId] })
    persistence.ids = ['fork-parent-lead', 'fork-ordinary-child']
    const harness = await bootService({
      sessionIds: [watchedId],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      config: { notificationBatchMs: 0 },
    })
    const watched = new FakeAgent(requireSession(harness, watchedId))
    harness.agents.add(watched)
    expect(harness.service.supervisorOf(watched.agent)).toBe('fork-parent-lead')
    expect(harness.service.isSupervised(watched.agent)).toBe(true)
    // The hub does not expose its watcher index, so observe routing directly:
    // a report from the watched child must name the real parent, never the fork.
    const receipt = await harness.service.reportProgress(watched.agent, { message: 'ghost absence probe' })
    expect(receipt.report.leadSessionId).toBe('fork-parent-lead')
  })

  it('refolds a stale fork cache row with its inherited prefix', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    const watchedId = 'stale-fork-watched-child'
    const logs = await buildForkedPersistedLogs({
      parentId: 'stale-fork-parent',
      childId: 'stale-fork-child',
      buildInherited: (session) => {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
        appendPluginRecord(session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([watchedId], T0))
      },
    })
    seedPersistedLog(query, logs.parent)
    seedPersistedLog(query, logs.child)
    cache.setDevLead('stale-fork-parent', { enabled: true, sessions: [watchedId] })
    // The stateVersion bump discards the old cache row: the pre-filter becomes
    // unknown and the cold fold must still honor the inherited prefix.
    cache.setDevLead('stale-fork-child', { enabled: true, sessions: [watchedId] }, { stale: true })
    persistence.ids = ['stale-fork-parent', 'stale-fork-child']
    const harness = await bootService({
      sessionIds: [watchedId],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      config: { notificationBatchMs: 0 },
    })
    const watched = new FakeAgent(requireSession(harness, watchedId))
    harness.agents.add(watched)
    expect(harness.service.supervisorOf(watched.agent)).toBe('stale-fork-parent')
    expect(query.readSessionCalls).toBeGreaterThanOrEqual(2)
  })

  it('rejects a live activation when a cold persisted Session holds the mode', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    await seedPersistedLead(query, { sessionId: 'cold-holder' })
    cache.setDevLead('cold-holder', { enabled: true })
    const harness = await bootService({ sessionIds: ['child-b'], sessionQuery: query, projectionCache: cache })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)

    const error = await expectCodeAsync(
      () => harness.service.setEnabled(child.agent, true),
      'DEVLEAD_ALREADY_ACTIVE',
    )
    expect(error.message).toContain('cold-holder')
    expect(harness.service.isEnabled(child.agent)).toBe(false)
  })

  it('fails closed when the persisted corpus listing cannot be verified during admission', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    await seedPersistedLead(query, { sessionId: 'cold-holder' })
    cache.setDevLead('cold-holder', { enabled: true })
    const harness = await bootService({ sessionIds: ['child-b'], sessionQuery: query, projectionCache: cache })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)
    query.listError = new Error('index unavailable')

    const error = await expectCodeAsync(
      () => harness.service.setEnabled(child.agent, true),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('could not verify global DevLead occupancy')
    expect(harness.service.isEnabled(child.agent)).toBe(false)
    expect(projectionStateOf(child.session).enabled).toBe(false)
  })

  it('fails closed when a cache-active holder log cannot be read during admission', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    await seedPersistedLead(query, { sessionId: 'cold-holder' })
    cache.setDevLead('cold-holder', { enabled: true })
    const harness = await bootService({ sessionIds: ['child-b'], sessionQuery: query, projectionCache: cache })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)
    query.readError = new Error('log unavailable')

    const error = await expectCodeAsync(
      () => harness.service.setEnabled(child.agent, true),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('could not verify global DevLead occupancy')
    expect(harness.service.isEnabled(child.agent)).toBe(false)
    expect(projectionStateOf(child.session).enabled).toBe(false)
  })

  it('frees the slot when the cold holder disappears from persistence', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    await seedPersistedLead(query, { sessionId: 'cold-deleted' })
    cache.setDevLead('cold-deleted', { enabled: true })
    const harness = await bootService({ sessionIds: ['child-b'], sessionQuery: query, projectionCache: cache })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)
    await expectCodeAsync(() => harness.service.setEnabled(child.agent, true), 'DEVLEAD_ALREADY_ACTIVE')

    expect(query.delete('cold-deleted')).toBe(true)
    await harness.service.setEnabled(child.agent, true)
    expect(harness.service.isEnabled(child.agent)).toBe(true)
  })

  it('releases an archived cold holder when the controller can resume it', async () => {
    const controller = new FakeSessionController()
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const registry = new FakeWorkspaceRegistry()
    await seedPersistedLead(query, { sessionId: 'cold-archived' })
    cache.setDevLead('cold-archived', { enabled: true })
    registry.archived = ['cold-archived']
    const harness = await bootService({
      sessionIds: ['child-b'],
      sessionQuery: query,
      projectionCache: cache,
      workspaceRegistry: registry,
      sessionController: controller,
    })
    // Startup could not release the cold holder (no handler yet); now the
    // controller can attach it, so the next admission releases the slot.
    controller.resolveHandler = () => ({
      agent: attachPersistedLead(harness.ctx, harness.agents, {
        sessionId: 'cold-archived',
        watched: [],
      }).agent,
    })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)

    await harness.service.setEnabled(child.agent, true)
    expect(harness.service.isEnabled(child.agent)).toBe(true)
    const released = harness.agents.resolve('cold-archived')
    expect(released).toBeDefined()
    expect(projectionStateOf(released!.session).enabled).toBe(false)
  })

  it('keeps a durable report queued while its lead is archived', async () => {
    const storage = new FakeStorageDomain()
    const registry = new FakeWorkspaceRegistry()
    const report = devLeadReport({
      senderSessionId: 'child-report',
      leadSessionId: 'lead-archived',
      turn: 1,
      kind: 'progress',
      message: 'wait for the lead',
      at: T0,
    })
    await storage.open({
      name: 'devlead_report_outbox',
      tables: { pending: {}, ignored: {} },
    })
    storage.table('devlead_report_outbox', 'pending').records.set(
      Buffer.from(`${report.leadSessionId}\u0000${report.id}`, 'utf8').toString('base64url'),
      { report, enqueuedAt: Date.now() },
    )
    registry.archived = ['lead-archived']
    const harness = await bootService({
      leadId: 'lead-archived',
      enabled: true,
      sessionIds: ['child-report'],
      watched: ['child-report'],
      storageDomain: storage,
      workspaceRegistry: registry,
    })
    expect(harness.service.view(harness.lead.agent).reports).toEqual([])
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(1)
  })

  it('does not let an unresumable archived cold holder block a new lead', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const registry = new FakeWorkspaceRegistry()
    await seedPersistedLead(query, { sessionId: 'cold-archived' })
    cache.setDevLead('cold-archived', { enabled: true })
    registry.archived = ['cold-archived']
    const harness = await bootService({
      sessionIds: ['child-b'],
      sessionQuery: query,
      projectionCache: cache,
      workspaceRegistry: registry,
    })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')

    await harness.service.setEnabled(child.agent, true)
    expect(harness.service.isEnabled(child.agent)).toBe(true)
    expect(await harness.service.archivedOccupants()).toEqual([
      { sessionId: 'cold-archived' },
    ])
    expect(warn.mock.calls.some(call => String(call[0]).includes('ignored for admission'))).toBe(true)
    warn.mockRestore()
  })

  it('drops a tombstoned holder from the report index even when it is not archived', async () => {
    const storage = new FakeStorageDomain()
    const seeded = await storage.open({
      name: 'devlead_report_outbox',
      tables: { pending: {}, ignored: {} },
    })
    seeded.table('ignored').records.set(
      Buffer.from('cold-holder', 'utf8').toString('base64url'),
      { sessionId: 'cold-holder', at: T0 },
    )
    await seeded.close()
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    const registry = new FakeWorkspaceRegistry()
    await seedPersistedLead(query, { sessionId: 'cold-holder', watched: ['child-b'] })
    cache.setDevLead('cold-holder', { enabled: true, sessions: ['child-b'] })
    persistence.ids = ['cold-holder']
    const harness = await bootService({
      sessionIds: ['child-b'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      workspaceRegistry: registry,
      storageDomain: storage,
      config: { notificationBatchMs: 0 },
    })
    const child = new FakeAgent(requireSession(harness, 'child-b'))
    harness.agents.add(child)
    // The holder is not archived but carries a tombstone and cannot be resumed
    // (no controller): it stays out of admission, and its hub index must be
    // dropped so it cannot supervise the child's reports.
    expect(harness.service.supervisorOf(child.agent)).toBeUndefined()
  })
})

  it('persists the archived-holder tombstone and reconciles an unarchived holder on open', async () => {
    const storage = new FakeStorageDomain()
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const registry = new FakeWorkspaceRegistry()
    await seedPersistedLead(query, { sessionId: 'cold-archived' })
    cache.setDevLead('cold-archived', { enabled: true })
    registry.archived = ['cold-archived']
    const first = await bootService({
      sessionIds: ['child-b'],
      sessionQuery: query,
      projectionCache: cache,
      workspaceRegistry: registry,
      storageDomain: storage,
    })
    const firstChild = new FakeAgent(requireSession(first, 'child-b'))
    first.agents.add(firstChild)
    await first.service.setEnabled(firstChild.agent, true)
    expect(storage.table('devlead_report_outbox', 'ignored').records.size).toBe(1)
    await first.dispose()

    // Restart with the holder unarchived. The tombstone lets a new lead pass
    // admission even though the cold holder cannot be resumed yet.
    registry.archived = []
    const second = await bootService({
      sessionIds: ['child-b'],
      sessionQuery: query,
      projectionCache: cache,
      workspaceRegistry: registry,
      storageDomain: storage,
    })
    const child = new FakeAgent(requireSession(second, 'child-b'))
    second.agents.add(child)
    await second.service.setEnabled(child.agent, true)
    // Opening the old holder runs reconciliation; because it is now live, the
    // mode-off can be appended and the tombstone is cleared.
    const attached = attachPersistedLead(second.ctx, second.agents, {
      sessionId: 'cold-archived',
      watched: [],
    })
    second.ctx.emit('agent/created', { agent: attached.agent, source: 'resume' })
    await flushMicrotasks(64)
    expect(projectionStateOf(attached.session).enabled).toBe(false)
    expect(storage.table('devlead_report_outbox', 'ignored').records.size).toBe(0)
    expect(second.service.isEnabled(child.agent)).toBe(true)
  })

describe('mid-turn reports', () => {
  /** Boot one live lead watching one live child, ready for report calls. */
  async function bootReporting(config: { notificationBatchMs?: number } = {}, extra: { storageDomain?: import('./harness.ts').FakeStorageDomain } = {}) {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['child-report'],
      watched: ['child-report'],
      config: { notificationBatchMs: 0, ...config },
      ...extra,
    })
    const child = new FakeAgent(requireSession(harness, 'child-report'))
    harness.agents.add(child)
    harness.sessionTitle.set(String(harness.lead.id), 'Lead')
    harness.sessionTitle.set(String(child.id), 'Child')
    return { harness, child }
  }

  it('resolves exactly the watching lead and is false for a lead or an unwatched Session', async () => {
    const { harness, child } = await bootReporting()
    expect(harness.service.supervisorOf(child.agent)).toBe(String(harness.lead.id))
    expect(harness.service.isSupervised(child.agent)).toBe(true)
    expect(harness.service.isSupervised(harness.lead.agent)).toBe(false)
    const other = new FakeAgent(requireSession(harness, 'child-report'))
    harness.agents.remove(child.id)
    harness.agents.add(other)
    await harness.service.watchSession(harness.lead.agent, String(child.id), false)
    const unwatched = new FakeAgent(requireSession(harness, 'child-report'))
    harness.agents.add(unwatched)
    expect(harness.service.isSupervised(unwatched.agent)).toBe(false)
  })

  it('persists a report, exposes it on the projection and digest, and wakes the lead', async () => {
    const { harness, child } = await bootReporting()
    const receipt = await harness.service.reportProgress(child.agent, {
      message: '  halfway through the parser  ',
      kind: 'progress',
      summary: ' parser progress ',
    })
    const report = receipt.report
    expect(receipt.durable).toBe(false)
    expect(receipt.queued).toBe(true)
    expect(receipt.warning).toContain('durable report storage is unavailable')
    expect(report.senderSessionId).toBe(String(child.id))
    expect(report.senderSessionTitle).toBe('Child')
    expect(report.leadSessionId).toBe(String(harness.lead.id))
    expect(report.message).toBe('halfway through the parser')
    expect(report.summary).toBe('parser progress')
    expect(harness.service.view(harness.lead.agent).reports).toEqual([report])
    expect(harness.service.reports(harness.lead.agent)).toEqual([report])
    const records = harness.leadSession.snapshotEvents().flatMap((event) => {
      const record = pluginRecordOf(event)
      return record?.type === DEVLEAD_REPORT_RECORD_TYPE ? [record.data] : []
    })
    expect(records).toHaveLength(1)
    await flushMicrotasks()
    expect(harness.lead.followups).toHaveLength(1)
    const text = messageText(harness.lead.followups[0]!)
    expect(text).toContain('[DEV LEAD REPORT]')
    expect(text).toContain('parser progress')
  })

  it('persists a detached structured question payload on question reports only', async () => {
    const { harness, child } = await bootReporting()
    const questions = [{
      id: 'target',
      header: 'Deploy',
      question: 'Which target?',
      options: [{ label: 'Staging', description: 'safe' }, { label: 'Prod' }],
      multi_select: false,
    }]
    const receipt = await harness.service.reportProgress(child.agent, {
      kind: 'question',
      message: 'Which target?',
      summary: 'Question: Deploy',
      questions,
    })
    expect(receipt.report.questions).toEqual(questions)
    expect(receipt.report.questions).not.toBe(questions)
    expect(receipt.report.questions?.[0]?.options).not.toBe(questions[0]!.options)
    expect(harness.service.view(harness.lead.agent).reports).toEqual([receipt.report])
    const records = harness.leadSession.snapshotEvents().flatMap((event) => {
      const record = pluginRecordOf(event)
      return record?.type === DEVLEAD_REPORT_RECORD_TYPE ? [record.data] : []
    })
    expect(records).toHaveLength(1)
    expect((records[0] as { report: { questions?: unknown } }).report.questions).toEqual(questions)

    questions[0]!.question = 'changed later'
    questions[0]!.options[0]!.description = 'changed later'
    expect(receipt.report.questions?.[0]?.question).toBe('Which target?')
    expect(receipt.report.questions?.[0]?.options?.[0]?.description).toBe('safe')

    const textOnly = await harness.service.reportProgress(child.agent, {
      kind: 'question',
      message: 'A text-only question',
    })
    expect(textOnly.report).not.toHaveProperty('questions')
  })

  it('pins the receipt-flush to wake-admission crash window without claiming replay recovery', async () => {
    const storage = new FakeStorageDomain()
    const { harness, child } = await bootReporting({}, { storageDomain: storage })
    harness.lead.setRunning(true)
    harness.lead.steer(createDevLeadNoticeMessage('parked action wake', {
      lane: 'action-required', wakeRequested: true, summary: 'Parked question',
    }))
    const admitted = harness.lead.steers.length
    await harness.service.reportProgress(child.agent, { kind: 'question', message: 'Crash before wake?' })
    // persistReport has flushed the lead receipt and cleared the outbox, while
    // the Q1 microtask has not yet admitted the wake. A crash here leaves the
    // durable digest as the only Phase 1b recovery surface.
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(0)
    expect(harness.lead.steers).toHaveLength(admitted)
    expect(harness.service.reports(harness.lead.agent)).toHaveLength(1)
    await flushMicrotasks()
    expect(harness.lead.steers).toHaveLength(admitted)
  })

  it('reports to the single active lead while a second lead enable is refused', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['child-report', 'other-lead'],
      watched: ['child-report'],
      config: { notificationBatchMs: 0 },
    })
    const child = new FakeAgent(requireSession(harness, 'child-report'))
    const other = new FakeAgent(requireSession(harness, 'other-lead'))
    harness.agents.add(child)
    harness.agents.add(other)
    await expectCodeAsync(
      () => harness.service.setEnabled(other.agent, true),
      'DEVLEAD_ALREADY_ACTIVE',
    )
    expect(harness.service.supervisorOf(child.agent)).toBe(String(harness.lead.id))
    const receipt = await harness.service.reportProgress(child.agent, { message: 'single lead update' })
    const report = receipt.report
    expect(report.leadSessionId).toBe(String(harness.lead.id))
    expect(harness.service.view(harness.lead.agent).reports).toEqual([report])
  })

  it('keeps a report queued behind an undelivered notice and delivers it when the inbox clears', async () => {
    const { harness, child } = await bootReporting()
    harness.lead.followup(createDevLeadNoticeMessage('existing queued notice'))
    expect(harness.lead.followups).toHaveLength(1)
    await harness.service.reportProgress(child.agent, {
      message: 'queued behind a notice',
      summary: 'queued report',
    })
    await flushMicrotasks()
    // The existing notice must not be duplicated or dropped; the report batch
    // waits for the bounded retry instead of producing a second notice.
    expect(harness.lead.followups).toHaveLength(1)
    harness.lead.drainInbox()
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await flushMicrotasks()
    expect(harness.lead.followups).toHaveLength(2)
    expect(messageText(harness.lead.followups[1]!)).toContain('[DEV LEAD REPORT]')
    expect(messageText(harness.lead.followups[1]!)).toContain('queued report')
  })

  it('writes the report to durable storage before returning and clears it after delivery', async () => {
    const storage = new FakeStorageDomain()
    const { harness, child } = await bootReporting({}, { storageDomain: storage })
    const receipt = await harness.service.reportProgress(child.agent, { message: 'durable update' })
    expect(receipt.durable).toBe(true)
    expect(receipt.queued).toBe(false)
    expect(receipt.warning).toBeUndefined()
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(0)
    expect(harness.service.view(harness.lead.agent).reports.map(report => report.message))
      .toEqual(['durable update'])
  })

  it('releases the outbox domain on dispose so a reload opens it durably again', async () => {
    const storage = new FakeStorageDomain()
    const first = await bootReporting({}, { storageDomain: storage })
    const before = await first.harness.service.reportProgress(first.child.agent, { message: 'before reload' })
    expect(before.durable).toBe(true)
    // dispose must await the domain close: the facility releases the name only
    // after a full close, and an `already-open` refusal would silently degrade
    // every report of the reloaded instance to the non-durable fallback.
    await first.harness.dispose()
    const second = await bootReporting({}, { storageDomain: storage })
    const after = await second.harness.service.reportProgress(second.child.agent, { message: 'after reload' })
    expect(after.durable).toBe(true)
    expect(after.warning).toBeUndefined()
  })

  it('prunes over-age outbox rows on a throttled report write sweep', async () => {
    const storage = new FakeStorageDomain()
    const harness = await bootService({
      leadId: 'lead-prune',
      enabled: true,
      sessionIds: ['child-prune'],
      watched: ['child-prune'],
      storageDomain: storage,
      // Force the new report to stay queued so both rows are observable.
      flushFailure: new Error('simulated persistence failure'),
    })
    const child = new FakeAgent(requireSession(harness, 'child-prune'))
    harness.agents.add(child)
    const base = Date.now()
    const stale = devLeadReport({
      senderSessionId: 'child-prune',
      leadSessionId: 'lead-prune',
      turn: 1,
      kind: 'progress',
      message: 'over-age row',
      at: T0,
    })
    seedOutboxRow(storage, stale, base - 8 * 24 * 60 * 60 * 1_000)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base + 2 * 60 * 60 * 1_000)
    try {
      const receipt = await harness.service.reportProgress(child.agent, { message: 'fresh row' })
      expect(receipt.durable).toBe(true)
      expect(receipt.queued).toBe(true)
    } finally {
      clock.mockRestore()
    }
    const rows = [...storage.table('devlead_report_outbox', 'pending').records.values()] as Array<{
      report: { message: string }
    }>
    expect(rows.map(row => row.report.message)).toEqual(['fresh row'])
  })

  it('throttles report-write outbox sweeps to once per hour', async () => {
    const storage = new FakeStorageDomain()
    const harness = await bootService({
      enabled: true,
      sessionIds: ['child-throttle'],
      watched: ['child-throttle'],
      storageDomain: storage,
    })
    const child = new FakeAgent(requireSession(harness, 'child-throttle'))
    harness.agents.add(child)
    const table = storage.table('devlead_report_outbox', 'pending')
    const base = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base + 2 * 60 * 60 * 1_000)
    try {
      await harness.service.reportProgress(child.agent, { message: 'first sweep' })
      const afterFirst = table.entriesCalls
      expect(afterFirst).toBeGreaterThan(0)
      // One minute later the throttle must skip the second sweep entirely.
      clock.mockReturnValue(base + 2 * 60 * 60 * 1_000 + 60 * 1_000)
      await harness.service.reportProgress(child.agent, { message: 'second write' })
      expect(table.entriesCalls).toBe(afterFirst)
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps report delivery alive when the outbox sweep rejects', async () => {
    const storage = new FakeStorageDomain()
    const harness = await bootService({
      enabled: true,
      sessionIds: ['child-prune-failure'],
      watched: ['child-prune-failure'],
      storageDomain: storage,
    })
    const child = new FakeAgent(requireSession(harness, 'child-prune-failure'))
    harness.agents.add(child)
    const table = storage.table('devlead_report_outbox', 'pending')
    const base = Date.now()
    // Seed after boot so the open-time sweep cannot consume the stale row.
    seedOutboxRow(
      storage,
      devLeadReport({
        senderSessionId: 'child-prune-failure',
        leadSessionId: String(harness.lead.id),
        turn: 1,
        kind: 'progress',
        message: 'stale before failed sweep',
        at: T0,
      }),
      base - 8 * 24 * 60 * 60 * 1_000,
    )
    table.deleteManyError = new Error('simulated prune failure')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base + 2 * 60 * 60 * 1_000)
    try {
      const receipt = await harness.service.reportProgress(child.agent, { message: 'fresh report' })
      expect(receipt.durable).toBe(true)
      expect(table.deleteManyCalls).toBeGreaterThan(0)
    } finally {
      clock.mockRestore()
      table.deleteManyError = undefined
    }
    const rows = [...table.records.values()] as Array<{ report: { message: string } }>
    expect(rows.some(row => row.report.message === 'stale before failed sweep')).toBe(true)
    expect(rows.some(row => row.report.message === 'fresh report')).toBe(false)
  })

  it('closes a late outbox open that races disposal and reopens cleanly', async () => {
    const storage = new FakeStorageDomain()
    const first = await bootService({
      enabled: true,
      sessionIds: ['child-late-open'],
      watched: ['child-late-open'],
    })
    let release!: () => void
    storage.openGate = new Promise<void>((resolve) => { release = resolve })
    first.ctx.provide('storageDomain' as never, storage.asService() as never)
    for (let attempt = 0; attempt < 16 && !storage.isOpen('devlead_report_outbox'); attempt += 1) {
      await nextTask()
    }
    expect(storage.isOpen('devlead_report_outbox')).toBe(true)

    const disposing = first.dispose()
    release()
    await disposing
    // The handle opened while disposal was already running must be closed, or
    // the reload below would be refused as `already-open`.
    expect(storage.isOpen('devlead_report_outbox')).toBe(false)

    storage.openGate = undefined
    const second = await bootService({ storageDomain: storage })
    expect(second.service.reportOutboxAvailable).toBe(true)
  })

  it('leaves the outbox row when the lead flush fails and replays it after restart', async () => {
    const storage = new FakeStorageDomain()
    const flushFailure = new Error('simulated persistence failure')
    const first = await bootService({
      leadId: 'lead-outbox-restart',
      enabled: true,
      sessionIds: ['child-report'],
      watched: ['child-report'],
      storageDomain: storage,
      flushFailure,
      config: { notificationBatchMs: 0 },
    })
    const child = new FakeAgent(requireSession(first, 'child-report'))
    first.agents.add(child)
    const failed = await first.service.reportProgress(child.agent, { message: 'replay me' })
    expect(failed.durable).toBe(true)
    expect(failed.queued).toBe(true)
    const outbox = storage.table('devlead_report_outbox', 'pending')
    expect(outbox.records.size).toBe(1)
    await first.dispose()

    const second = await bootService({
      leadId: 'lead-outbox-restart',
      enabled: true,
      watched: ['child-report'],
      storageDomain: storage,
      config: { notificationBatchMs: 0 },
    })
    expect(second.service.view(second.lead.agent).reports.map(report => report.message))
      .toEqual(['replay me'])
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(0)
  })

  it('drops undelivered outbox rows on reset', async () => {
    const storage = new FakeStorageDomain()
    const harness = await bootService({
      leadId: 'lead-outbox-reset',
      enabled: true,
      sessionIds: ['child-report'],
      watched: ['child-report'],
      storageDomain: storage,
      flushFailure: new Error('simulated persistence failure'),
      config: { notificationBatchMs: 0 },
    })
    const child = new FakeAgent(requireSession(harness, 'child-report'))
    harness.agents.add(child)
    await harness.service.reportProgress(child.agent, { message: 'discard me' })
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(1)
    await harness.service.reset(harness.lead.agent)
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(0)
  })

  it('drops queued outbox rows when a frozen fold is recovered by turning the mode off', async () => {
    const storage = new FakeStorageDomain()
    const harness = await bootService({
      leadId: 'lead-frozen-off',
      enabled: true,
      storageDomain: storage,
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, {
          kind: 'devlead/mode',
          version: 1,
          enabled: 'yes',
          at: T0,
        } as never)
      },
    })
    const stale = devLeadReport({
      senderSessionId: 'child-frozen',
      leadSessionId: 'lead-frozen-off',
      turn: 1,
      kind: 'progress',
      message: 'stale frozen row',
      at: T0,
    })
    seedOutboxRow(storage, stale, Date.now())
    await harness.service.setEnabled(harness.lead.agent, false)
    expect(durableResetRecords(harness)).toHaveLength(1)
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(0)
  })

  it('uses the explicit non-durable fallback when outbox writes fail', async () => {
    const storage = new FakeStorageDomain()
    const seeded = await storage.open({ name: 'devlead_report_outbox', tables: { pending: {}, ignored: {} } })
    storage.table('devlead_report_outbox', 'pending').putError = new Error('storage read-only')
    // Release the single-open name so the service under test can open it.
    await seeded.close()
    const { harness, child } = await bootReporting({}, { storageDomain: storage })
    const receipt = await harness.service.reportProgress(child.agent, { message: 'fallback update' })
    expect(receipt.durable).toBe(false)
    expect(receipt.queued).toBe(true)
    expect(receipt.warning).toContain('durable report storage is unavailable')
    expect(harness.service.view(harness.lead.agent).reports.map(report => report.message))
      .toEqual(['fallback update'])
  })

  it('deduplicates the same message in one turn and enforces the per-turn budget', async () => {
    const { harness, child } = await bootReporting()
    const first = await harness.service.reportProgress(child.agent, { message: 'same update' })
    const duplicate = await harness.service.reportProgress(child.agent, { message: 'same update' })
    expect(duplicate.report.id).toBe(first.report.id)
    expect(harness.service.reports(harness.lead.agent)).toHaveLength(1)
    for (const message of ['one', 'two', 'three']) {
      await harness.service.reportProgress(child.agent, { message })
    }
    const error = await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, { message: 'four' }),
      'DEVLEAD_REPORT_RATE_LIMITED',
    )
    expect(error.message).toContain('4')
    expect(harness.service.reports(harness.lead.agent)).toHaveLength(4)
  })

  it('delivers the same text as a question after a progress report instead of swallowing it', async () => {
    const { harness, child } = await bootReporting()
    const progress = await harness.service.reportProgress(child.agent, { message: 'Which target?' })
    // The question gate can forward text the child already reported as
    // progress; the upgrade to the answer-seeking channel must still arrive.
    const question = await harness.service.reportProgress(child.agent, { kind: 'question', message: 'Which target?' })
    expect(question.report.kind).toBe('question')
    expect(question.report.id).not.toBe(progress.report.id)
    expect(harness.service.reports(harness.lead.agent).map(report => report.kind)).toEqual(['progress', 'question'])
    // Same kind and text stays idempotent.
    const again = await harness.service.reportProgress(child.agent, { kind: 'question', message: 'Which target?' })
    expect(again.report.id).toBe(question.report.id)
    expect(harness.service.reports(harness.lead.agent)).toHaveLength(2)
  })

  it('deduplicates only identical structured questions and rejects a same-id payload mismatch', async () => {
    const { harness, child } = await bootReporting()
    const first = await harness.service.reportProgress(child.agent, {
      kind: 'question',
      message: 'Which target?',
      questions: [{ header: 'Deploy', question: 'Which target?', options: [{ label: 'Staging' }] }],
    })
    const retry = await harness.service.reportProgress(child.agent, {
      kind: 'question',
      message: 'Which target?',
      questions: [{ header: 'Deploy', question: 'Which target?', options: [{ label: 'Staging' }] }],
    })
    expect(retry.report.id).toBe(first.report.id)
    expect(retry.report.questions).toEqual(first.report.questions)
    const error = await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, {
        kind: 'question',
        message: 'Which target?',
        questions: [{ header: 'Deploy', question: 'Which target?', options: [{ label: 'Production' }] }],
      }),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(error.message).toContain('different structured questions')
    expect(harness.service.reports(harness.lead.agent)).toHaveLength(1)
  })

  it('lets a question report through the exhausted progress budget', async () => {
    const { harness, child } = await bootReporting()
    for (const message of ['one', 'two', 'three', 'four']) {
      await harness.service.reportProgress(child.agent, { message })
    }
    const question = await harness.service.reportProgress(child.agent, {
      kind: 'question',
      message: 'Which deployment target should I use?',
      summary: 'deployment target',
    })
    expect(question.report.kind).toBe('question')
    // The question is a control-flow channel, not a fifth progress report.
    expect(harness.service.reports(harness.lead.agent).map(report => report.kind))
      .toEqual(['progress', 'progress', 'progress', 'progress', 'question'])
    await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, { message: 'five' }),
      'DEVLEAD_REPORT_RATE_LIMITED',
    )
  })

  it('returns delivery backpressure before writing a seventeenth question or its outbox row', async () => {
    const storage = new FakeStorageDomain()
    const { harness, child } = await bootReporting({}, { storageDomain: storage })
    harness.lead.setRunning(true)
    harness.lead.steer(createDevLeadNoticeMessage('parked action wake', {
      lane: 'action-required', wakeRequested: true, summary: 'Parked question',
    }))
    for (let index = 0; index < 16; index += 1) {
      await harness.service.reportProgress(child.agent, {
        kind: 'question', message: `Question ${String(index)}?`,
      })
    }
    const error = await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, { kind: 'question', message: 'Question overflow?' }),
      'DEVLEAD_DELIVERY_RATE_LIMITED',
    )
    expect(error.message).toContain('16 pending action-required reports')
    expect(harness.service.reports(harness.lead.agent)).toHaveLength(16)
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(0)
  })

  it('surfaces the concurrent cap race explicitly and leaves no orphan outbox row', async () => {
    const storage = new FakeStorageDomain()
    const { harness, child } = await bootReporting({}, { storageDomain: storage })
    harness.lead.setRunning(true)
    harness.lead.steer(createDevLeadNoticeMessage('parked action wake', {
      lane: 'action-required', wakeRequested: true, summary: 'Parked question',
    }))
    for (let index = 0; index < 15; index += 1) {
      await harness.service.reportProgress(child.agent, {
        kind: 'question', message: `Question ${String(index)}?`,
      })
    }
    // Both calls pass the synchronous capacity preflight at 15 pending; the
    // loser's receipt write then hits the cap inside the hub. Its just-written
    // outbox row must be removed and the explicit error must reach the child,
    // instead of a warn-swallowed { durable: true, queued: true } orphan.
    const [first, second] = await Promise.allSettled([
      harness.service.reportProgress(child.agent, { kind: 'question', message: 'Race winner?' }),
      harness.service.reportProgress(child.agent, { kind: 'question', message: 'Race loser?' }),
    ])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    if (first.status !== 'fulfilled' && second.status !== 'fulfilled') throw new Error('no race winner')
    const winner = first.status === 'fulfilled' ? first : second
    const loser = first.status === 'rejected' ? first : second
    if (winner.status !== 'fulfilled' || loser.status !== 'rejected') throw new Error('unexpected race outcome')
    expect(winner.value.durable).toBe(true)
    expect(winner.value.report.kind).toBe('question')
    const error = loser.reason as { code?: string; message?: string }
    expect(error.code).toBe('DEVLEAD_DELIVERY_RATE_LIMITED')
    expect(error.message).toContain('16 pending action-required reports')
    expect(harness.service.reports(harness.lead.agent)).toHaveLength(16)
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(0)
    // The rejected question was not cached as a receipt: once capacity frees,
    // the same text is accepted as a fresh report.
    harness.lead.drainInbox()
    harness.lead.setRunning(false)
    harness.ctx.emit('agent/status', { agent: harness.lead.agent, status: 'idle' })
    await flushMicrotasks(64)
    const retry = await harness.service.reportProgress(child.agent, { kind: 'question', message: 'Race loser?' })
    expect(retry.durable).toBe(true)
    expect(harness.service.reports(harness.lead.agent)).toHaveLength(17)
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(0)
  })

  it('keeps the explicit capacity error and the row when the race cleanup delete fails', async () => {
    const storage = new FakeStorageDomain()
    const { harness, child } = await bootReporting({}, { storageDomain: storage })
    harness.lead.setRunning(true)
    harness.lead.steer(createDevLeadNoticeMessage('parked action wake', {
      lane: 'action-required', wakeRequested: true, summary: 'Parked question',
    }))
    for (let index = 0; index < 15; index += 1) {
      await harness.service.reportProgress(child.agent, {
        kind: 'question', message: `Question ${String(index)}?`,
      })
    }
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const table = storage.table('devlead_report_outbox', 'pending')
    table.deleteError = new Error('outbox delete unavailable')
    const [first, second] = await Promise.allSettled([
      harness.service.reportProgress(child.agent, { kind: 'question', message: 'Race winner?' }),
      harness.service.reportProgress(child.agent, { kind: 'question', message: 'Race loser?' }),
    ])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    const loser = first.status === 'rejected' ? first : second
    if (loser.status !== 'rejected') throw new Error('expected the race loser to reject')
    // The cleanup delete failed, but the child still sees the original
    // capacity error (never a swallowed durable receipt), the loser's row is
    // retained for a later replay, and the failed cleanup is warned about.
    expect((loser.reason as { code?: string }).code).toBe('DEVLEAD_DELIVERY_RATE_LIMITED')
    const rows = [...table.records.values()] as Array<{ report: { message: string } }>
    expect(rows.some(row => row.report.message === 'Race loser?')).toBe(true)
    expect(warn.mock.calls.some(([message]) =>
      String(message).includes('could not remove the capacity-rejected report'))).toBe(true)
  })

  it('rejects empty, oversized, and malformed reports before writing', async () => {
    const { harness, child } = await bootReporting()
    await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, { message: '   ' }),
      'DEVLEAD_INVALID_INPUT',
    )
    await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, { message: 'x'.repeat(4_001) }),
      'DEVLEAD_INVALID_INPUT',
    )
    await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, {
        message: 'update',
        kind: 'urgent' as never,
      }),
      'DEVLEAD_INVALID_INPUT',
    )
    await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, {
        message: 'update',
        summary: 'x'.repeat(201),
      }),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(harness.service.reports(harness.lead.agent)).toEqual([])
  })

  it('rejects invalid structured questions before writing', async () => {
    const { harness, child } = await bootReporting()
    const valid = [{ question: 'Which target?', options: [{ label: 'Staging' }] }]
    const cases: Array<[string, { message: string; kind?: 'progress' | 'question'; questions?: never }]> = [
      ['non-question report', { message: 'update', kind: 'progress', questions: valid as never }],
      ['too many questions', {
        message: 'question',
        kind: 'question',
        questions: Array.from({ length: 33 }, () => ({ question: 'q' })) as never,
      }],
      ['too many options', {
        message: 'question',
        kind: 'question',
        questions: [{ question: 'q', options: Array.from({ length: 17 }, () => ({ label: 'x' })) }] as never,
      }],
      ['oversized field', {
        message: 'question',
        kind: 'question',
        questions: [{ id: 'x'.repeat(2_001), question: 'q' }] as never,
      }],
      ['unknown question field', {
        message: 'question',
        kind: 'question',
        questions: [{ question: 'q', extra: true }] as never,
      }],
      ['unknown option field', {
        message: 'question',
        kind: 'question',
        questions: [{ question: 'q', options: [{ label: 'x', extra: true }] }] as never,
      }],
      ['invalid multi-select', {
        message: 'question',
        kind: 'question',
        questions: [{ question: 'q', multi_select: 'yes' }] as never,
      }],
    ]
    for (const [label, request] of cases) {
      await expectCodeAsync(
        () => harness.service.reportProgress(child.agent, request),
        'DEVLEAD_INVALID_INPUT',
      ).then(error => expect(error.message, label).toContain('questions'))
    }
    expect(harness.service.reports(harness.lead.agent)).toEqual([])
  })

  it('becomes unwatched after unwatch, lead off, or lead archive', async () => {
    const { harness, child } = await bootReporting()
    await harness.service.watchSession(harness.lead.agent, String(child.id), false)
    await expectCodeAsync(
      () => harness.service.reportProgress(child.agent, { message: 'after unwatch' }),
      'DEVLEAD_NOT_SUPERVISED',
    )

    const fresh = await bootReporting()
    await fresh.harness.service.setEnabled(fresh.harness.lead.agent, false)
    await expectCodeAsync(
      () => fresh.harness.service.reportProgress(fresh.child.agent, { message: 'after off' }),
      'DEVLEAD_NOT_SUPERVISED',
    )

    const registry = new FakeWorkspaceRegistry()
    const archived = await bootService({
      enabled: true,
      sessionIds: ['child-report'],
      watched: ['child-report'],
      workspaceRegistry: registry,
      config: { notificationBatchMs: 0 },
    })
    const archivedChild = new FakeAgent(requireSession(archived, 'child-report'))
    archived.agents.add(archivedChild)
    registry.archived = [String(archived.lead.id)]
    expect(archived.service.isSupervised(archivedChild.agent)).toBe(false)
    await expectCodeAsync(
      () => archived.service.reportProgress(archivedChild.agent, { message: 'after archive' }),
      'DEVLEAD_NOT_SUPERVISED',
    )
  })

  it('replays a durable report receipt into the lead projection after restart', async () => {
    const report = devLeadReport({
      senderSessionId: 'child-replay',
      senderSessionTitle: 'Replay child',
      leadSessionId: 'lead-replay',
      turn: 2,
      kind: 'decision',
      message: 'choose a database',
      summary: 'needs a decision',
      at: T0,
    })
    const harness = await bootService({
      leadId: 'lead-replay',
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(report))
      },
    })
    expect(harness.service.view(harness.lead.agent).reports).toEqual([report])
    expect(harness.service.reports(harness.lead.agent)).toEqual([report])
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
      reports: [],
      answers: [],
      failure: null,
      inheritedEventCount: 0,
    })
    expect(harness.service.view(harness.lead.agent)).toEqual({ enabled: false, sessions: [], notifications: [], reports: [] })
    // Idempotent: off on an already-off Session writes no extra record.
    const records = durableResetRecords(harness)
    await harness.service.setEnabled(harness.lead.agent, false)
    expect(durableResetRecords(harness)).toEqual(records)
  })

  it('resets damaged state explicitly and can be called repeatedly', async () => {
    const harness = await bootFrozen()
    await expect(harness.service.reset(harness.lead.agent)).resolves.toBeUndefined()
    expect(harness.service.view(harness.lead.agent)).toEqual({ enabled: false, sessions: [], notifications: [], reports: [] })
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
    expect(harness.service.view(harness.lead.agent)).toEqual({ enabled: false, sessions: [], notifications: [], reports: [] })
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

describe('workspace removal', () => {
  it('removes a registration by id without touching the directory, its files, or the Session log', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'README.md'), 'keep me')
    const registry = new FakeWorkspaceRegistry()
    const workspace = registry.add({ path: dir, title: 'kept', sessionIds: ['session-child'] })
    const harness = await bootService({
      enabled: true,
      sessionIds: ['session-child'],
      workspaceRegistry: registry,
    })
    const child = requireSession(harness, 'session-child')
    appendTurnStart(child, 1)
    const logLength = child.snapshotEvents().length

    const removed = await harness.service.removeWorkspace(harness.lead.agent, workspace.id)

    // The view is the pre-removal snapshot: it still names the accounted Session,
    // so the caller can report what the removal ungrouped.
    expect(removed).toEqual({
      workspace: {
        workspaceId: 'ws-1',
        title: 'kept',
        path: dir,
        status: 'ok',
        sessionIds: ['session-child'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      removed: true,
    })
    expect(registry.deleteCalls).toEqual(['ws-1'])
    expect(registry.list()).toEqual([])
    // The Workspace listing no longer carries the removed registration.
    await expect(harness.service.listWorkspaces()).resolves.toEqual([])
    // Closing a Workspace is a registry operation, never a filesystem or log
    // operation: the directory, its files, and the Session log all survive.
    await expect(stat(dir).then(result => result.isDirectory())).resolves.toBe(true)
    await expect(readFile(join(dir, 'README.md'), 'utf8')).resolves.toBe('keep me')
    expect(child.snapshotEvents()).toHaveLength(logLength)
    const sessions = await harness.service.listSessions(harness.lead.agent)
    expect(requireView(sessions, 'session-child').live).toBe(true)
  })

  it('resolves the registration by path and leaves a re-registration without the old Sessions', async () => {
    const dir = await tempDir()
    const registry = new FakeWorkspaceRegistry()
    registry.add({ id: 'ws-old', path: dir, sessionIds: ['session-child'] })
    const harness = await bootService({
      enabled: true,
      sessionIds: ['session-child'],
      workspaceRegistry: registry,
    })

    await expect(harness.service.removeWorkspace(harness.lead.agent, `  ${dir}  `)).resolves.toMatchObject({
      workspace: { workspaceId: 'ws-old', path: dir, sessionIds: ['session-child'] },
      removed: true,
    })
    // Re-registering the same directory is a new registration: it does not adopt
    // the Sessions of the removed one, which stay addressable as ungrouped rows.
    registry.add({ id: 'ws-new', path: dir })
    expect(registry.list().map(entry => ({ id: entry.id, sessionIds: entry.sessionIds })))
      .toEqual([{ id: 'ws-new', sessionIds: [] }])
    const row = requireView(await harness.service.listSessions(harness.lead.agent), 'session-child')
    expect(row.workspaceId).toBeUndefined()
    await expect(harness.service.removeWorkspace(harness.lead.agent, dir)).resolves.toMatchObject({
      workspace: { workspaceId: 'ws-new' },
      removed: true,
    })
  })

  it('resolves a unique registration by exact title, trimmed and case-sensitive', async () => {
    const registry = new FakeWorkspaceRegistry()
    const workspace = registry.add({ path: '/tmp/title-repo', title: 'deepcal' })
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })

    // Case folding is deliberately not a fallback: titles, like ids and paths,
    // are matched exactly after trimming.
    const wrongCase = await expectCodeAsync(
      () => harness.service.removeWorkspace(harness.lead.agent, 'DeepCal'),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )
    expect(wrongCase.message).toContain('exact title')
    expect(registry.deleteCalls).toEqual([])

    await expect(harness.service.removeWorkspace(harness.lead.agent, '  deepcal  ')).resolves.toMatchObject({
      workspace: { workspaceId: String(workspace.id), title: 'deepcal', path: '/tmp/title-repo' },
      removed: true,
    })
    expect(registry.deleteCalls).toEqual([String(workspace.id)])
  })

  it('prefers a Workspace id over another Workspace title that spells the same string', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.add({ id: 'ws-id', path: '/tmp/by-id', title: 'Id Space' })
    registry.add({ path: '/tmp/by-title', title: 'ws-id' })
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })

    await expect(harness.service.removeWorkspace(harness.lead.agent, 'ws-id')).resolves.toMatchObject({
      workspace: { workspaceId: 'ws-id', path: '/tmp/by-id' },
      removed: true,
    })
    expect(registry.deleteCalls).toEqual(['ws-id'])
    // The Workspace whose title was "ws-id" is untouched.
    expect(registry.list().map(workspace => String(workspace.id))).toEqual(['ws-2'])
  })

  it('prefers a registered path over a path-shaped title and still reaches a title when the path is unknown', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.add({ id: 'ws-path', path: '/tmp/path-wins', title: 'Path Space' })
    registry.add({ id: 'ws-title', path: '/tmp/title-holder', title: '/tmp/path-wins' })
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })

    // The path branch runs before title matching, so the registration that owns
    // the path wins even though another Workspace uses that string as a title.
    await expect(harness.service.removeWorkspace(harness.lead.agent, '/tmp/path-wins')).resolves.toMatchObject({
      workspace: { workspaceId: 'ws-path' },
      removed: true,
    })
    expect(registry.deleteCalls).toEqual(['ws-path'])

    // A title shaped like an unregistered absolute path stays addressable:
    // path resolution misses, then the exact title match applies.
    registry.add({ id: 'ws-shaped', path: '/tmp/shaped-holder', title: '/tmp/not-registered' })
    await expect(
      harness.service.removeWorkspace(harness.lead.agent, '  /tmp/not-registered  '),
    ).resolves.toMatchObject({
      workspace: { workspaceId: 'ws-shaped', path: '/tmp/shaped-holder' },
      removed: true,
    })
    expect(registry.deleteCalls).toEqual(['ws-path', 'ws-shaped'])
  })

  it('refuses an ambiguous title and lists every candidate id and path', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.add({ id: 'ws-a', path: '/tmp/dup-a', title: 'deepcal' })
    registry.add({ id: 'ws-b', path: '/tmp/dup-b', title: 'deepcal' })
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })

    const error = await expectCodeAsync(
      () => harness.service.removeWorkspace(harness.lead.agent, 'deepcal'),
      'DEVLEAD_WORKSPACE_AMBIGUOUS',
    )
    expect(error.message).toContain('Workspace title "deepcal" is ambiguous')
    expect(error.message).toContain('2 Workspaces share it')
    expect(error.message).toContain('ws-a (/tmp/dup-a)')
    expect(error.message).toContain('ws-b (/tmp/dup-b)')
    expect(error.message).toContain('pass a Workspace id or registered path')
    // Ambiguity is never resolved by picking the first registration.
    expect(registry.deleteCalls).toEqual([])
    expect(registry.list()).toHaveLength(2)
  })

  it('reports an unknown reference and a missing registry with the workspace code', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/repo-known' })
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })
    const unknown = await expectCodeAsync(
      () => harness.service.removeWorkspace(harness.lead.agent, '/tmp/repo-unknown'),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )
    expect(unknown.message).toContain('no Workspace matches')
    // The failure teaches all three address forms instead of implying that the
    // directory was never registered.
    expect(unknown.message).toContain('Workspace id, a registered directory path, or an exact title')
    expect(unknown.message).toContain('devlead_list_workspaces')
    expect(unknown.message).not.toContain('register the repository directory first')
    expect(registry.deleteCalls).toEqual([])

    const blank = await expectCodeAsync(
      () => harness.service.removeWorkspace(harness.lead.agent, '   '),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(blank.message).toContain('a Workspace reference is required')

    const withoutRegistry = await bootService({ enabled: true })
    const missing = await expectCodeAsync(
      () => withoutRegistry.service.removeWorkspace(withoutRegistry.lead.agent, '/tmp/repo-known'),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )
    expect(missing.message).toContain('composes no Workspace registry')
  })

  it('rethrows an infrastructure registry failure unchanged', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/repo-one' })
    const harness = await bootService({ enabled: true, workspaceRegistry: registry })
    const failure = new Error('registry storage offline')
    registry.deleteError = failure
    await expect(harness.service.removeWorkspace(harness.lead.agent, 'ws-1')).rejects.toBe(failure)
  })

  it('requires a live lead with the mode enabled and honors cancellation', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/repo-one' })
    const disabled = await bootService({ workspaceRegistry: registry })
    await expectCodeAsync(
      () => disabled.service.removeWorkspace(disabled.lead.agent, 'ws-1'),
      'DEVLEAD_NOT_ENABLED',
    )
    const enabled = await bootService({ enabled: true, workspaceRegistry: registry })
    const stale = new FakeAgent(enabled.leadSession)
    await expectCodeAsync(
      () => enabled.service.removeWorkspace(stale.agent, 'ws-1'),
      'DEVLEAD_AGENT_NOT_LIVE',
    )
    const controller = new AbortController()
    controller.abort()
    await expect(
      enabled.service.removeWorkspace(enabled.lead.agent, 'ws-1', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(registry.deleteCalls).toEqual([])
    expect(registry.list()).toHaveLength(1)
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

  it('filters by exact Workspace title, trimmed and case-sensitive', async () => {
    const { harness } = await bootListing()
    const byTitle = await harness.service.listSessions(harness.lead.agent, { workspace: '  Alpha Space  ' })
    expect(byTitle.map(view => view.sessionId)).toEqual(['child-alpha'])
    await expectCodeAsync(
      () => harness.service.listSessions(harness.lead.agent, { workspace: 'alpha space' }),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )
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

  it('omits lastTurn for a live Agent that has not completed a turn', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['fresh-child'] })
    harness.agents.add(new FakeAgent(requireSession(harness, 'fresh-child')))
    const views = await harness.service.listSessions(harness.lead.agent)
    expect(requireView(views, 'fresh-child')).toMatchObject({ live: true, running: false })
    expect(requireView(views, 'fresh-child').lastTurn).toBeUndefined()
  })

  it('reads cold titles only for the retained listing rows', async () => {
    const query = new FakeSessionQuery()
    for (let index = 0; index < 20; index += 1) {
      query.seed(`cold-${String(index).padStart(2, '0')}`, [], `Cold ${index}`)
    }
    const harness = await bootService({ enabled: true, sessionQuery: query })
    const views = await harness.service.listSessions(harness.lead.agent, { limit: 1 })
    expect(views).toHaveLength(1)
    // Ranking uses the query engine's headers; only the retained row pays for
    // a cold title read (which folds that Session's complete log).
    expect(query.readTitleSnapshotsCalls).toBe(1)
    expect(query.readSessionCalls).toBe(0)
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

  it('fails identity resolution instead of silently matching live rows only', async () => {
    const query = new FakeSessionQuery()
    query.listError = new Error('index unavailable')
    const harness = await bootService({ enabled: true, sessionIds: ['child-alpha'], sessionQuery: query })
    await expectCodeAsync(
      () => harness.service.getSession(harness.lead.agent, 'child-'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
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

  it('keeps the automatic watch when an interrupt stop was committed but admission failed', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    target.failFollowups = 1
    harness.agents.add(target)
    const stops: string[] = []
    harness.ctx.on('workspace/session-stop', ({ sessionId }) => {
      stops.push(String(sessionId))
      target.setRunning(false)
    })
    const error = await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'replace', { interrupt: true }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('already asked to stop')
    expect(stops).toEqual(['target'])
    // The stop cannot be rolled back, so the watch must survive: it is the
    // lead's path to observe the cancelled turn and retry the prompt.
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['target'])
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
  /** Register one fake stop provider and return the Session ids it observed. */
  function recordStops(harness: ServiceHarness, target?: FakeAgent): string[] {
    const stops: string[] = []
    harness.ctx.on('workspace/session-stop', ({ sessionId }) => {
      stops.push(String(sessionId))
      target?.setRunning(false)
    })
    return stops
  }

  it('admits a relay prompt into a live watched Session', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    harness.agents.add(target)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', '  do the thing  ')
    expect(receipt).toEqual({
      sessionId: 'target',
      watched: true,
      resumed: false,
      interrupted: false,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: expect.any(String) },
    })
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

  it('leaves a running Session queued when interrupt is omitted', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    const stops = recordStops(harness, target)

    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'queue me')

    // Default delivery is non-destructive: no stop provider is asked and the
    // prompt waits behind the running turn.
    expect(stops).toEqual([])
    expect(target.followups).toHaveLength(1)
    expect(receipt).toEqual({
      sessionId: 'target',
      watched: true,
      resumed: false,
      interrupted: false,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: expect.any(String) },
    })
  })

  it('interrupts a running turn through the Host stop providers before admitting', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    const stops = recordStops(harness, target)

    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'replace the current work', {
      interrupt: true,
    })

    // The stop event is the same fan-out archive stop_running uses; the
    // replacement prompt is admitted after it returns.
    expect(stops).toEqual(['target'])
    expect(target.followups).toHaveLength(1)
    expect(receipt).toEqual({
      sessionId: 'target',
      watched: true,
      resumed: false,
      interrupted: true,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: expect.any(String) },
    })
  })

  it('treats interrupt as a no-op on an idle Session', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    harness.agents.add(target)
    const stops = recordStops(harness)

    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'start now', { interrupt: true })

    expect(stops).toEqual([])
    expect(target.followups).toHaveLength(1)
    expect(receipt).toEqual({
      sessionId: 'target',
      watched: true,
      resumed: false,
      interrupted: false,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: expect.any(String) },
    })
  })

  it('treats interrupt as a no-op after resuming a cold Session', async () => {
    const controller = new FakeSessionController()
    const harness = await bootService({ enabled: true, sessionIds: ['target'], sessionController: controller })
    const target = new FakeAgent(requireSession(harness, 'target'))
    controller.resolveHandler = () => {
      harness.agents.add(target)
      return { agent: target.agent }
    }
    const stops = recordStops(harness)

    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'start now', { interrupt: true })

    expect(receipt).toEqual({
      sessionId: 'target',
      watched: true,
      resumed: true,
      interrupted: false,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: expect.any(String) },
    })
    expect(stops).toEqual([])
    expect(target.followups).toHaveLength(1)
  })

  it('logs stop-provider failures and still admits the replacement prompt', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    harness.ctx.on('workspace/session-stop', () => {
      throw new Error('schedule stop failed')
    })

    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'replace', { interrupt: true })

    expect(receipt.interrupted).toBe(true)
    expect(target.followups).toHaveLength(1)
    expect(warn.mock.calls.some(call => String(call[0]).includes('prompt interrupt failed'))).toBe(true)
    warn.mockRestore()
  })

  it('renders the interrupted turn as an aborted watched notification', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      config: { notificationBatchMs: 0 },
    })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    const stops = recordStops(harness, target)

    await harness.service.promptSession(harness.lead.agent, 'target', 'replace', { interrupt: true })
    expect(stops).toEqual(['target'])

    // The real Host stop provider cancels the turn with the user cause, which
    // closes the log as `aborted`; the notification hub reports it as the
    // normal watched-turn transition before the replacement turn settles.
    appendTurnStart(requireSession(harness, 'target'), 1)
    appendTurnEnd(requireSession(harness, 'target'), 1, { kind: 'aborted', reason: { kind: 'user' } })
    await flushMicrotasks()

    expect(harness.service.notifications(harness.lead.agent)).toContainEqual(expect.objectContaining({
      sessionId: 'target',
      turn: 1,
      transition: 'aborted',
    }))
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

describe('session archival', () => {
  /**
   * Boot one archival fixture whose fake registry knows the booted Sessions.
   * @param sessionIds - extra Sessions created in the store.
   * @param options - fake registry overrides.
   * @returns the harness and its fake registry.
   */
  async function bootArchive(
    sessionIds: readonly string[] = ['session-child'],
    options: { known?: readonly string[] } = {},
  ): Promise<{ harness: ServiceHarness; registry: FakeWorkspaceRegistry }> {
    const registry = new FakeWorkspaceRegistry()
    registry.knownSessions.push(...(options.known ?? sessionIds))
    const harness = await bootService({ enabled: true, sessionIds, workspaceRegistry: registry })
    return { harness, registry }
  }

  it('archives one Session, marks it archived in the view, and reports no stop', async () => {
    const { harness, registry } = await bootArchive()
    const result = await harness.service.archiveSession(harness.lead.agent, 'session-child')
    expect(result).toEqual({ sessionId: 'session-child', archived: true, stopped: false })
    expect(registry.archiveCalls).toEqual([{ sessionId: 'session-child', stopActivity: false }])
    expect(registry.archived).toEqual(['session-child'])
    expect(registry.stopCalls).toEqual([])
    const view = await harness.service.getSession(harness.lead.agent, 'session-child')
    expect(view.archived).toBe(true)
    // Archiving never touches the log.
    expect(requireSession(harness, 'session-child').snapshotEvents()).toEqual([])
  })

  it('archives by unique prefix and by the bare uuid head', async () => {
    const fullId = 'session-e59ab350-65be-4a90-9f3e-6a1f7f9e2b11'
    const { harness, registry } = await bootArchive([fullId])
    await expect(harness.service.archiveSession(harness.lead.agent, 'e59ab350')).resolves.toEqual({
      sessionId: fullId,
      archived: true,
      stopped: false,
    })
    expect(registry.archived).toEqual([fullId])
  })

  it('keeps an already archived Session archived without writing, asking, or stopping', async () => {
    const { harness, registry } = await bootArchive()
    registry.archived = ['session-child']
    await expect(harness.service.archiveSession(harness.lead.agent, 'session-child')).resolves.toEqual({
      sessionId: 'session-child',
      archived: true,
      stopped: false,
    })
    // A stop must not be reported for an archive the Host turned into a no-op.
    await expect(
      harness.service.archiveSession(harness.lead.agent, 'session-child', { stopRunning: true }),
    ).resolves.toEqual({ sessionId: 'session-child', archived: true, stopped: false })
    expect(registry.archiveCalls).toEqual([])
    expect(registry.stopCalls).toEqual([])
  })

  it('refuses a Session with running work and names the activity', async () => {
    const { harness, registry } = await bootArchive()
    registry.activity.set('session-child', [
      { kind: 'turn' },
      {
        kind: 'job',
        items: [
          { id: 'job-1', label: 'nightly build' },
          { id: 'job-2' },
          { id: 'job-3' },
          { id: 'job-4' },
        ],
      },
    ])
    const error = await expectCodeAsync(
      () => harness.service.archiveSession(harness.lead.agent, 'session-child'),
      'DEVLEAD_SESSION_ACTIVE',
    )
    expect(error.message).toContain('still active')
    expect(error.message).toContain('turn')
    expect(error.message).toContain('job (nightly build, job-2, job-3, +1 more)')
    expect(error.message).toContain('stop_running: true')
    expect(registry.archived).toEqual([])
    expect(registry.stopCalls).toEqual([])
  })

  it('archives first and asks the Host to stop running work with stopRunning', async () => {
    const { harness, registry } = await bootArchive()
    registry.activity.set('session-child', [{ kind: 'turn' }])
    const result = await harness.service.archiveSession(harness.lead.agent, 'session-child', {
      stopRunning: true,
    })
    expect(result).toEqual({ sessionId: 'session-child', archived: true, stopped: true })
    expect(registry.archiveCalls).toEqual([{ sessionId: 'session-child', stopActivity: true }])
    expect(registry.archived).toEqual(['session-child'])
    expect(registry.stopCalls).toEqual(['session-child'])
  })

  it('refuses to archive the lead Session itself', async () => {
    const { harness, registry } = await bootArchive()
    const error = await expectCodeAsync(
      () => harness.service.archiveSession(harness.lead.agent, harness.lead.id),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(error.message).toContain('cannot archive itself')
    expect(error.message).toContain('sidebar')
    expect(registry.archiveCalls).toEqual([])
    // stop_running cannot bypass the guard either: it would cancel this turn.
    await expectCodeAsync(
      () => harness.service.archiveSession(harness.lead.agent, harness.lead.id, { stopRunning: true }),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(registry.archiveCalls).toEqual([])
  })

  it('maps unknown Sessions and a missing registry to the stable codes', async () => {
    const { harness } = await bootArchive()
    const missing = await expectCodeAsync(
      () => harness.service.archiveSession(harness.lead.agent, 'session-missing'),
      'DEVLEAD_SESSION_NOT_FOUND',
    )
    expect(missing.message).toContain('devlead_list_sessions')

    // Subagent Sessions are routed by the runtime and stay unaddressable, so an
    // archive request for one is an ordinary not-found instead of a special case.
    harness.ctx.sessions.create(SessionId('session-subagent'), { meta: { origin: 'subagent' } })
    await expectCodeAsync(
      () => harness.service.archiveSession(harness.lead.agent, 'session-subagent'),
      'DEVLEAD_SESSION_NOT_FOUND',
    )

    // A Session the resolver addressed can vanish before the registry write; the
    // registry's own unknown-Session refusal maps to the same stable code.
    const { harness: raced } = await bootArchive(['session-child'], { known: [] })
    const vanished = await expectCodeAsync(
      () => raced.service.archiveSession(raced.lead.agent, 'session-child'),
      'DEVLEAD_SESSION_NOT_FOUND',
    )
    expect(vanished.message).toContain('disappeared')

    const withoutRegistry = await bootService({ enabled: true, sessionIds: ['session-child'] })
    const noRegistry = await expectCodeAsync(
      () => withoutRegistry.service.archiveSession(withoutRegistry.lead.agent, 'session-child'),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
    )
    expect(noRegistry.message).toContain('composes no Workspace registry')
  })

  it('requires a live lead with the mode enabled and honors cancellation', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.knownSessions.push('session-child')
    const disabled = await bootService({
      sessionIds: ['session-child'],
      workspaceRegistry: registry,
    })
    await expectCodeAsync(
      () => disabled.service.archiveSession(disabled.lead.agent, 'session-child'),
      'DEVLEAD_NOT_ENABLED',
    )
    const enabled = await bootService({
      enabled: true,
      sessionIds: ['session-child'],
      workspaceRegistry: registry,
    })
    const stale = new FakeAgent(enabled.leadSession)
    await expectCodeAsync(
      () => enabled.service.archiveSession(stale.agent, 'session-child'),
      'DEVLEAD_AGENT_NOT_LIVE',
    )
    const controller = new AbortController()
    controller.abort()
    await expect(
      enabled.service.archiveSession(enabled.lead.agent, 'session-child', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(registry.archiveCalls).toEqual([])
  })

  it('restores an archived Session and treats an unarchived id as an idempotent success', async () => {
    const { harness, registry } = await bootArchive()
    registry.archived = ['session-child']
    await expect(harness.service.unarchiveSession(harness.lead.agent, 'session-child')).resolves.toEqual({
      sessionId: 'session-child',
      archived: false,
    })
    expect(registry.unarchiveCalls).toEqual(['session-child'])
    expect(registry.archived).toEqual([])
    // Calling restore on an id that is not archived is still a success: the
    // Host's write is the no-op and the reported state is the same.
    await expect(harness.service.unarchiveSession(harness.lead.agent, 'session-child')).resolves.toEqual({
      sessionId: 'session-child',
      archived: false,
    })
    expect(registry.archived).toEqual([])
    expect(registry.unarchiveCalls).toEqual(['session-child', 'session-child'])
  })

  it('restores a cold persisted Session through the query engine', async () => {
    const query = new FakeSessionQuery()
    query.seed('cold-archived', [], 'Cold Archived')
    const registry = new FakeWorkspaceRegistry()
    registry.archived = ['cold-archived']
    const harness = await bootService({
      enabled: true,
      sessionQuery: query,
      workspaceRegistry: registry,
    })
    // Resolution and the archived flag both come from the query engine and the
    // registry: the Session has no live Agent or attached Session.
    const view = await harness.service.getSession(harness.lead.agent, 'cold-archived')
    expect(view).toMatchObject({ live: false, archived: true, title: 'Cold Archived' })
    await expect(harness.service.unarchiveSession(harness.lead.agent, 'cold-archived')).resolves.toEqual({
      sessionId: 'cold-archived',
      archived: false,
    })
    expect(registry.unarchiveCalls).toEqual(['cold-archived'])
    expect(registry.archived).toEqual([])
  })

  it('reports unknown Sessions and a missing registry on restore', async () => {
    const { harness } = await bootArchive()
    await expectCodeAsync(
      () => harness.service.unarchiveSession(harness.lead.agent, 'session-missing'),
      'DEVLEAD_SESSION_NOT_FOUND',
    )
    const withoutRegistry = await bootService({ enabled: true, sessionIds: ['session-child'] })
    await expectCodeAsync(
      () => withoutRegistry.service.unarchiveSession(withoutRegistry.lead.agent, 'session-child'),
      'DEVLEAD_WORKSPACE_NOT_FOUND',
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

  it('resolves the target Workspace by exact title', async () => {
    const controller = new FakeSessionController()
    const registry = new FakeWorkspaceRegistry()
    registry.add({ id: 'ws-title', path: '/tmp/title-space', title: 'Title Space' })
    const harness = await bootService({
      enabled: true,
      sessionController: controller,
      workspaceRegistry: registry,
    })
    controller.createHandler = () => {
      const session = harness.ctx.sessions.create(SessionId('created-by-title'))
      harness.agents.add(new FakeAgent(session))
      return { sessionId: session.id }
    }
    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: '  Title Space  ',
      watch: false,
    })
    expect(controller.createCalls).toEqual([{ workspaceId: 'ws-title' }])
    expect(result.workspace).toMatchObject({ workspaceId: 'ws-title', path: '/tmp/title-space' })
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

  it('surfaces an invalid preset from the Host as a structured creation failure', async () => {
    const controller = new FakeSessionController(
      Object.assign(new Error('Unknown agent preset: nope'), { code: 'agent-preset/not-found' }),
    )
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/invalid-preset', title: 'Invalid Preset' })
    const harness = await bootService({
      enabled: true,
      sessionController: controller,
      workspaceRegistry: registry,
    })
    const error = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, { workspace: 'ws-1', preset: 'nope' }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('could not create a Session')
    expect(error.message).toContain('Unknown agent preset: nope')
    expect(controller.createCalls).toEqual([{ workspaceId: 'ws-1', agentPreset: 'nope' }])
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
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

describe('dispatch model and Agent Teams settings', () => {
  /** Result of one dispatch-settings fixture boot. */
  interface DispatchFixture {
    readonly harness: ServiceHarness
    readonly controller: FakeSessionController
    readonly registry: FakeWorkspaceRegistry
    readonly defaultModel: FakeAgentDefaultModel
  }

  /**
   * Boot one creation fixture whose controller registers every created child
   * Agent in the fake registry, so creation-time settings have a target.
   * @param options - optional model/Team fakes.
   * @returns the booted fixture.
   */
  async function bootDispatch(
    options: {
      readonly llm?: FakeModelValidator
      readonly agentTeams?: FakeAgentTeams
      readonly defaultModel?: FakeAgentDefaultModel
      readonly failChildModel?: boolean
    } = {},
  ): Promise<DispatchFixture> {
    const controller = new FakeSessionController()
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/dispatch-space', title: 'Dispatch' })
    const defaultModel = options.defaultModel ?? new FakeAgentDefaultModel()
    const harness = await bootService({
      enabled: true,
      sessionController: controller,
      workspaceRegistry: registry,
      ...(options.llm === undefined ? {} : { llm: options.llm }),
      ...(options.agentTeams === undefined ? {} : { agentTeams: options.agentTeams }),
      agentDefaultModel: defaultModel,
    })
    let sequence = 0
    controller.createHandler = () => {
      sequence += 1
      const session = harness.ctx.sessions.create(SessionId(`created-${String(sequence)}`))
      const agent = new FakeAgent(session)
      if (options.failChildModel === true) agent.failModelSelect = 1
      harness.agents.add(agent)
      return { sessionId: session.id }
    }
    return { harness, controller, registry, defaultModel }
  }

  it('requires provider and model together and rejects an effort alone', async () => {
    const validator = new FakeModelValidator()
    const { harness, controller } = await bootDispatch({ llm: validator })
    await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {
        workspace: 'ws-1',
        model: { provider: 'p', model: '' },
      }),
      'DEVLEAD_INVALID_INPUT',
    )
    await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {
        workspace: 'ws-1',
        model: { provider: '', model: '', reasoningEffort: 'high' },
      }),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(controller.createCalls).toEqual([])
    expect(validator.calls).toEqual([])
  })

  it('validates the model before creating and maps an unavailable route', async () => {
    const validator = new FakeModelValidator().withProvider('provider-x', ['model-y'])
    validator.routeErrors.set('provider-x/model-y', new Error('no such model'))
    const { harness, controller } = await bootDispatch({ llm: validator })
    const error = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {
        workspace: 'ws-1',
        model: { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' },
      }),
      'DEVLEAD_MODEL_UNAVAILABLE',
    )
    expect(error.message).toContain('provider-x/model-y')
    expect(error.message).toContain('high')
    expect(error.message).toContain('no such model')
    expect(error.message).toContain('devlead_list_models')
    expect(validator.calls).toEqual([{ provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' }])
    expect(controller.createCalls).toEqual([])
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
  })

  it('rejects a model the provider does not advertise', async () => {
    const validator = new FakeModelValidator().withProvider('provider-x', ['other-model'])
    const { harness, controller } = await bootDispatch({ llm: validator })
    const error = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {
        workspace: 'ws-1',
        model: { provider: 'provider-x', model: 'model-y' },
      }),
      'DEVLEAD_MODEL_UNAVAILABLE',
    )
    expect(error.message).toContain('available model list')
    expect(validator.calls).toEqual([])
    expect(controller.createCalls).toEqual([])
  })

  it('reports a missing LLM registry as an unavailable model', async () => {
    const { harness, controller } = await bootDispatch()
    const error = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {
        workspace: 'ws-1',
        model: { provider: 'p', model: 'm' },
      }),
      'DEVLEAD_MODEL_UNAVAILABLE',
    )
    expect(error.message).toContain('no LLM registry')
    expect(error.message).toContain('devlead_list_models')
    expect(controller.createCalls).toEqual([])
  })

  it('applies the model to the child Agent without rewriting the profile default', async () => {
    const validator = new FakeModelValidator().withProvider('provider-x', ['model-y'])
    const { harness, registry, defaultModel } = await bootDispatch({ llm: validator })
    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: 'ws-1',
      model: { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' },
    })
    expect(result.model).toEqual({ provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' })
    expect(result.agentTeams).toBeUndefined()
    expect(harness.agents.resolve('created-1')?.modelSelections).toEqual([
      { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' },
    ])
    // The profile default is never touched: no `selectModel`/saveSelection path.
    expect(defaultModel.saveCalls).toBe(0)
    expect(defaultModel.currentSelection()).toEqual({ provider: 'default-provider', model: 'default-model' })
    expect(result.session.watched).toBe(true)
    expect(registry.createCalls).toEqual([])
  })

  it('applies explicit Agent Teams on and off and reports the requested mode', async () => {
    const teams = new FakeAgentTeams()
    const { harness } = await bootDispatch({ agentTeams: teams })
    const enabled = await harness.service.createSession(harness.lead.agent, {
      workspace: 'ws-1',
      agentTeams: true,
    })
    expect(enabled.agentTeams).toBe(true)
    const disabled = await harness.service.createSession(harness.lead.agent, {
      workspace: 'ws-1',
      agentTeams: false,
    })
    expect(disabled.agentTeams).toBe(false)
    expect(teams.calls).toEqual([
      { agentId: 'created-1', enabled: true },
      { agentId: 'created-2', enabled: false },
    ])
    const created = harness.agents.resolve('created-1')
    if (created === undefined) throw new Error('expected the created child Agent')
    expect(teams.isEnabled(created.agent)).toBe(true)
  })

  it('leaves optional services untouched when neither setting is requested', async () => {
    const validator = new FakeModelValidator()
    const teams = new FakeAgentTeams()
    const { harness } = await bootDispatch({ llm: validator, agentTeams: teams })
    const result = await harness.service.createSession(harness.lead.agent, { workspace: 'ws-1' })
    expect(result.model).toBeUndefined()
    expect(result.agentTeams).toBeUndefined()
    expect(validator.calls).toEqual([])
    expect(teams.calls).toEqual([])
  })

  it('fails before creating when Agent Teams is requested on a Team-less (rc.1-shaped) Host', async () => {
    const { harness, controller } = await bootDispatch()
    const error = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, { workspace: 'ws-1', agentTeams: true }),
      'DEVLEAD_TEAM_UNAVAILABLE',
    )
    expect(error.message).toContain('no Agent Teams service')
    expect(error.message).toContain('0.2.2-rc.2')
    expect(error.message).toContain('continue without Team mode')
    expect(controller.createCalls).toEqual([])
    // An explicit `false` is already satisfied when no Team service exists.
    const off = await harness.service.createSession(harness.lead.agent, { workspace: 'ws-1', agentTeams: false })
    expect(off.agentTeams).toBe(false)
    expect(controller.createCalls).toHaveLength(1)
  })

  it('names the created Session when applying the model fails and keeps watch capacity', async () => {
    const validator = new FakeModelValidator().withProvider('provider-x', ['model-y'])
    const { harness, controller } = await bootDispatch({ llm: validator, failChildModel: true })
    const error = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, {
        workspace: 'ws-1',
        model: { provider: 'provider-x', model: 'model-y' },
      }),
      'DEVLEAD_MODEL_UNAVAILABLE',
    )
    expect(error.message).toContain('created-1')
    expect(error.message).toContain('remains')
    expect(error.message).toContain('devlead_list_models')
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
    // The reservation was released: the next create can still take a watch slot.
    const next = await harness.service.createSession(harness.lead.agent, { workspace: 'ws-1' })
    expect(next.session.watched).toBe(true)
    expect(controller.createCalls).toHaveLength(2)
  })

  it('names the created Session when Agent Teams cannot be applied', async () => {
    const teams = new FakeAgentTeams()
    teams.error = new Error('team store offline')
    const { harness } = await bootDispatch({ agentTeams: teams })
    const error = await expectCodeAsync(
      () => harness.service.createSession(harness.lead.agent, { workspace: 'ws-1', agentTeams: true }),
      'DEVLEAD_TEAM_UNAVAILABLE',
    )
    expect(error.message).toContain('created-1')
    expect(error.message).toContain('team store offline')
    expect(harness.agents.resolve('created-1')).toBeDefined()
    expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
  })
})

describe('model catalog', () => {
  it('maps the Host catalog onto the compact protocol view', async () => {
    const controller = new FakeSessionController()
    controller.modelCatalogResult = {
      default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' },
      routableProviders: ['provider-a'],
      groups: [
        {
          id: 'provider-a',
          name: 'Provider A',
          models: [
            {
              id: 'model-a',
              name: 'Model A',
              description: 'display-only',
              badge: 'new',
              reasoning: {
                efforts: [{ id: 'low', name: 'Low', description: 'display-only' }],
                defaultEffort: 'low',
              },
            },
            { id: 'model-b' },
          ],
        },
      ],
      failures: [{ id: 'provider-b', name: 'Provider B', message: 'catalog offline' }],
    }
    const harness = await bootService({ enabled: true, sessionController: controller })
    const catalog = await harness.service.listModels(harness.lead.agent)
    expect(catalog).toEqual({
      default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' },
      routableProviders: ['provider-a'],
      providers: [
        {
          id: 'provider-a',
          name: 'Provider A',
          models: [
            {
              id: 'model-a',
              name: 'Model A',
              reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
            },
            { id: 'model-b', name: 'model-b' },
          ],
        },
      ],
      failures: [{ id: 'provider-b', name: 'Provider B', message: 'catalog offline' }],
    })
    expect(controller.modelCatalogCalls).toBe(1)
  })

  it('maps an empty catalog without inventing entries', async () => {
    const controller = new FakeSessionController()
    controller.modelCatalogResult = {
      default: { provider: 'provider-a', model: 'model-a' },
      routableProviders: [],
      groups: [],
      failures: [],
    }
    const harness = await bootService({ enabled: true, sessionController: controller })
    const catalog = await harness.service.listModels(harness.lead.agent)
    expect(catalog).toEqual({
      default: { provider: 'provider-a', model: 'model-a' },
      routableProviders: [],
      providers: [],
      failures: [],
    })
  })

  it('drops malformed catalog entries instead of failing the read', async () => {
    const controller = new FakeSessionController()
    controller.modelCatalogResult = {
      default: { provider: 'provider-a', model: 'model-a' },
      routableProviders: ['provider-a', 7, ''],
      groups: [
        { name: 'no id' },
        {
          id: 'provider-a',
          models: [
            { name: 'no model id' },
            { id: 'model-a', reasoning: { efforts: [{ name: 'no effort id' }, { id: 'low' }] } },
          ],
        },
      ],
      failures: [{ name: 'no failure id' }, { id: 'provider-b' }],
    }
    const harness = await bootService({ enabled: true, sessionController: controller })
    const catalog = await harness.service.listModels(harness.lead.agent)
    expect(catalog.routableProviders).toEqual(['provider-a'])
    expect(catalog.providers).toEqual([
      {
        id: 'provider-a',
        name: 'provider-a',
        models: [
          { id: 'model-a', name: 'model-a', reasoning: { efforts: [{ id: 'low', name: 'low' }] } },
        ],
      },
    ])
    expect(catalog.failures).toEqual([{ id: 'provider-b', name: 'provider-b', message: '' }])
  })

  it('requires a composed controller and maps read failures to the session-unavailable code', async () => {
    const withoutController = await bootService({ enabled: true })
    const missing = await expectCodeAsync(
      () => withoutController.service.listModels(withoutController.lead.agent),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(missing.message).toContain('cannot list models')

    const controller = new FakeSessionController()
    controller.modelCatalogError = new Error('catalog store offline')
    const harness = await bootService({ enabled: true, sessionController: controller })
    const failed = await expectCodeAsync(
      () => harness.service.listModels(harness.lead.agent),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(failed.message).toContain('catalog store offline')
  })

  it('requires a live lead with the mode enabled and honors cancellation', async () => {
    const controller = new FakeSessionController()
    const disabled = await bootService({ sessionController: controller })
    await expectCodeAsync(
      () => disabled.service.listModels(disabled.lead.agent),
      'DEVLEAD_NOT_ENABLED',
    )
    const enabled = await bootService({ enabled: true, sessionController: controller })
    const stale = new FakeAgent(enabled.leadSession)
    await expectCodeAsync(
      () => enabled.service.listModels(stale.agent),
      'DEVLEAD_AGENT_NOT_LIVE',
    )
    const aborter = new AbortController()
    aborter.abort()
    await expect(
      enabled.service.listModels(enabled.lead.agent, aborter.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(controller.modelCatalogCalls).toBe(0)
  })
})

describe('agent preset roster', () => {
  it('maps the optional Host roster onto the compact protocol view', async () => {
    const harness = await bootService({ enabled: true })
    const list = vi.fn(async () => [
      { id: 'standard', name: 'Standard', description: 'General-purpose preset', order: 1 },
      { id: 'ptc', name: 'PTC' },
      { id: 'broken', broken: 'missing service' },
    ])
    harness.ctx.provide('agentPresets', { defaultId: 'ptc', list })
    const catalog = await harness.service.listAgentPresets(harness.lead.agent)
    expect(catalog).toEqual({
      available: true,
      presets: [
        { id: 'standard', name: 'Standard', description: 'General-purpose preset', default: false },
        { id: 'ptc', name: 'PTC', default: true },
        { id: 'broken', default: false, broken: 'missing service' },
      ],
    })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('distinguishes an empty roster from an absent roster service', async () => {
    const empty = await bootService({ enabled: true })
    empty.ctx.provide('agentPresets', { defaultId: 'standard', list: async () => [] })
    await expect(empty.service.listAgentPresets(empty.lead.agent)).resolves.toEqual({
      available: true,
      presets: [],
    })

    const absent = await bootService({ enabled: true })
    await expect(absent.service.listAgentPresets(absent.lead.agent)).resolves.toEqual({
      available: false,
      presets: [],
      reason: 'this Host composes no Agent preset roster; omit preset to use the Host default',
    })
  })

  it('drops malformed roster rows and derives the default marker from defaultId', async () => {
    const harness = await bootService({ enabled: true })
    harness.ctx.provide('agentPresets', {
      defaultId: 'standard',
      list: async () => [
        null,
        {},
        { id: '   ' },
        { id: ' standard ', name: '   ', description: ' keep ', broken: '   ' },
      ],
    })
    await expect(harness.service.listAgentPresets(harness.lead.agent)).resolves.toEqual({
      available: true,
      presets: [{ id: 'standard', description: 'keep', default: true }],
    })
  })

  it('maps a roster read failure to a structured error', async () => {
    const harness = await bootService({ enabled: true })
    harness.ctx.provide('agentPresets', {
      defaultId: 'standard',
      list: async () => {
        throw new Error('roster store offline')
      },
    })
    const error = await expectCodeAsync(
      () => harness.service.listAgentPresets(harness.lead.agent),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('roster store offline')
  })

  it('requires a live lead with the mode enabled and honors cancellation', async () => {
    const disabled = await bootService({})
    await expectCodeAsync(
      () => disabled.service.listAgentPresets(disabled.lead.agent),
      'DEVLEAD_NOT_ENABLED',
    )
    const harness = await bootService({ enabled: true })
    const stale = new FakeAgent(harness.leadSession)
    await expectCodeAsync(
      () => harness.service.listAgentPresets(stale.agent),
      'DEVLEAD_AGENT_NOT_LIVE',
    )
    const list = vi.fn(async () => [])
    harness.ctx.provide('agentPresets', { defaultId: 'standard', list })
    const aborter = new AbortController()
    aborter.abort()
    await expect(
      harness.service.listAgentPresets(harness.lead.agent, aborter.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(list).not.toHaveBeenCalled()
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

  it('bounds the readiness barrier when the persistence listing keeps failing', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    persistence.listError = new Error('persistence is still opening')
    const started = Date.now()
    const harness = await bootService({
      enabled: true,
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
      config: { notificationBatchMs: 0 },
    })
    const elapsed = Date.now() - started
    // The probe keeps failing, so the barrier spends its bound and then lets
    // the service load; plugin load must never hang on the listing.
    expect(elapsed).toBeGreaterThanOrEqual(1_900)
    expect(elapsed).toBeLessThan(5_000)
    expect(persistence.listCalls).toBeGreaterThan(1)
    expect(harness.service.isEnabled(harness.lead.agent)).toBe(true)
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

describe('queued inbox visibility', () => {
  it('projects pending inputs with identity, boundary, source, excerpt, and enqueue instant', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    harness.agents.add(target)
    const own = queuedMessage(
      'msg-own',
      { kind: 'devlead', form: 'relay', senderSessionId: String(harness.lead.id) },
      'stale instruction',
    )
    const human = queuedMessage('msg-human', { kind: 'user' }, 'human follow-up')
    target.inbox.nextTurn.push(own)
    target.inbox.nextStep.push(human)
    // The durable enqueue splice is the source of enqueuedAt; the human message
    // has no recorded splice in this log and must omit the field.
    const event = target.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [own] })
    expect(harness.service.sessionQueuedInputs(harness.lead.agent, 'target')).toEqual([
      {
        id: 'msg-own',
        boundary: 'next-turn',
        sourceKind: 'devlead',
        sourceForm: 'relay',
        senderSessionId: String(harness.lead.id),
        excerpt: 'stale instruction',
        enqueuedAt: event.time,
      },
      { id: 'msg-human', boundary: 'next-step', sourceKind: 'user', excerpt: 'human follow-up' },
    ])
  })

  it('reports an empty list for a live empty inbox and undefined for a cold target', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    harness.agents.add(target)
    expect(harness.service.sessionQueuedInputs(harness.lead.agent, 'target')).toEqual([])
    harness.agents.remove(target.id)
    expect(harness.service.sessionQueuedInputs(harness.lead.agent, 'target')).toBeUndefined()
  })
})

describe('retract queued input', () => {
  async function bootTarget(): Promise<{ harness: ServiceHarness; target: FakeAgent }> {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    harness.agents.add(target)
    return { harness, target }
  }

  it('withdraws an own relay from either boundary and is idempotent', async () => {
    const { harness, target } = await bootTarget()
    const own = queuedMessage('msg-own', { kind: 'devlead', form: 'relay', senderSessionId: String(harness.lead.id) })
    const step = queuedMessage('msg-step', { kind: 'devlead', form: 'relay', senderSessionId: String(harness.lead.id) })
    target.inbox.nextTurn.push(own)
    target.inbox.nextStep.push(step)
    expect(await harness.service.retractQueuedInput(harness.lead.agent, 'target', 'msg-own'))
      .toEqual({ sessionId: 'target', inputId: 'msg-own', retracted: true })
    expect(target.inbox.nextTurn).toEqual([])
    expect(target.inbox.nextStep).toHaveLength(1)
    expect(await harness.service.retractQueuedInput(harness.lead.agent, 'target', 'msg-step'))
      .toEqual({ sessionId: 'target', inputId: 'msg-step', retracted: true })
    // Already withdrawn: the idempotent outcome, not an error.
    expect(await harness.service.retractQueuedInput(harness.lead.agent, 'target', 'msg-own'))
      .toEqual({ sessionId: 'target', inputId: 'msg-own', retracted: false })
  })

  it('refuses human, scheduled, notice, and other-lead inputs and leaves them pending', async () => {
    const { harness, target } = await bootTarget()
    const foreign = [
      queuedMessage('msg-human', { kind: 'user' }),
      queuedMessage('msg-sched', { kind: 'schedule' }),
      queuedMessage('msg-notice', { kind: 'devlead', form: 'notice' }),
      queuedMessage('msg-other', { kind: 'devlead', form: 'relay', senderSessionId: 'another-lead' }),
    ]
    target.inbox.nextTurn.push(...foreign)
    for (const message of foreign) {
      const error = await expectCodeAsync(
        () => harness.service.retractQueuedInput(harness.lead.agent, 'target', String(message.id)),
        'DEVLEAD_INVALID_INPUT',
      )
      expect(error.message).toContain('not authored by this DevLead Session')
    }
    expect(target.inbox.nextTurn.map(message => String(message.id)))
      .toEqual(['msg-human', 'msg-sched', 'msg-notice', 'msg-other'])
  })

  it('refuses a self-addressed retraction and a cold target', async () => {
    const { harness, target } = await bootTarget()
    await expectCodeAsync(
      () => harness.service.retractQueuedInput(harness.lead.agent, String(harness.lead.id), 'msg-1'),
      'DEVLEAD_INVALID_INPUT',
    )
    harness.agents.remove(target.id)
    await expectCodeAsync(
      () => harness.service.retractQueuedInput(harness.lead.agent, 'target', 'msg-1'),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
  })

  it('resolves a unique prefix before retracting', async () => {
    const { harness, target } = await bootTarget()
    target.inbox.nextTurn.push(
      queuedMessage('msg-own', { kind: 'devlead', form: 'relay', senderSessionId: String(harness.lead.id) }),
    )
    expect(await harness.service.retractQueuedInput(harness.lead.agent, 'tar', 'msg-own'))
      .toEqual({ sessionId: 'target', inputId: 'msg-own', retracted: true })
  })
})

describe('interrupt inbox policies', () => {
  /**
   * Register one fake stop provider and return the Session ids it observed.
   * Emulates the Host turn provider: `agent.cancel({kind:'user'})` clears the
   * inbox before aborting the turn, which is exactly the behavior the retention
   * policies restore against.
   */
  function recordStops(harness: ServiceHarness, target?: FakeAgent): string[] {
    const stops: string[] = []
    harness.ctx.on('workspace/session-stop', ({ sessionId }) => {
      stops.push(String(sessionId))
      target?.inbox.clear()
      target?.setRunning(false)
    })
    return stops
  }

  async function bootRunning(): Promise<{ harness: ServiceHarness; target: FakeAgent }> {
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    return { harness, target }
  }

  /** Seed one own relay, one human turn prompt, and one human steering note. */
  function seed(target: FakeAgent, leadId: string): { own: ReturnType<typeof queuedMessage>; human: ReturnType<typeof queuedMessage>; steering: ReturnType<typeof queuedMessage> } {
    const own = queuedMessage('msg-own', { kind: 'devlead', form: 'relay', senderSessionId: leadId }, 'stale own instruction')
    const human = queuedMessage('msg-human', { kind: 'user' }, 'human instruction')
    const steering = queuedMessage('msg-step', { kind: 'user' }, 'steering note')
    target.inbox.nextTurn.push(own, human)
    target.inbox.nextStep.push(steering)
    return { own, human, steering }
  }

  it('keep restores every pending message with its id, boundary, and order ahead of the replacement', async () => {
    const { harness, target } = await bootRunning()
    const { own, human, steering } = seed(target, String(harness.lead.id))
    const stops = recordStops(harness, target)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'replacement', {
      interrupt: true,
      interruptInbox: 'keep',
    })
    expect(stops).toEqual(['target'])
    expect(receipt.interrupted).toBe(true)
    expect(receipt.retainedInputs).toBe(3)
    // Restored messages keep their identity and queue order; the replacement
    // prompt is admitted after them.
    expect(target.inbox.nextTurn).toHaveLength(3)
    expect(target.inbox.nextTurn[0]).toBe(own)
    expect(target.inbox.nextTurn[1]).toBe(human)
    expect(messageText(target.inbox.nextTurn[2]!)).toContain('replacement')
    expect(target.inbox.nextStep).toHaveLength(1)
    expect(target.inbox.nextStep[0]).toBe(steering)
  })

  it('clear-own drops only this lead\'s relays and keeps human input', async () => {
    const { harness, target } = await bootRunning()
    const { human, steering } = seed(target, String(harness.lead.id))
    recordStops(harness, target)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'replacement', {
      interrupt: true,
      interruptInbox: 'clear-own',
    })
    expect(receipt.retainedInputs).toBe(2)
    expect(target.inbox.nextTurn).toHaveLength(2)
    expect(target.inbox.nextTurn[0]).toBe(human)
    expect(messageText(target.inbox.nextTurn[1]!)).toContain('replacement')
    expect(target.inbox.nextStep[0]).toBe(steering)
  })

  it('clear-all stays the default: the stop clears everything and no retention is reported', async () => {
    for (const options of [{ interrupt: true }, { interrupt: true, interruptInbox: 'clear-all' as const }]) {
      const { harness, target } = await bootRunning()
      seed(target, String(harness.lead.id))
      recordStops(harness, target)
      const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'replacement', options)
      expect(receipt.interrupted).toBe(true)
      expect(receipt.retainedInputs).toBeUndefined()
      expect(target.inbox.nextTurn).toHaveLength(1)
      expect(messageText(target.inbox.nextTurn[0]!)).toContain('replacement')
      expect(target.inbox.nextStep).toEqual([])
    }
  })

  it('ignores the policy without interrupt and for an idle target', async () => {
    const running = await bootRunning()
    const { own } = seed(running.target, String(running.harness.lead.id))
    const stops = recordStops(running.harness, running.target)
    // No interrupt: the prompt queues behind the running turn, inbox untouched.
    const queued = await running.harness.service.promptSession(running.harness.lead.agent, 'target', 'follow-up', {
      interruptInbox: 'clear-own',
    })
    expect(stops).toEqual([])
    expect(queued.interrupted).toBe(false)
    expect(queued.retainedInputs).toBeUndefined()
    expect(running.target.inbox.nextTurn[0]).toBe(own)
    // Idle target: interrupt is a no-op, so the policy never runs.
    const idle = await bootRunning()
    idle.target.setRunning(false)
    const idleStops = recordStops(idle.harness, idle.target)
    const idleReceipt = await idle.harness.service.promptSession(idle.harness.lead.agent, 'target', 'go', {
      interrupt: true,
      interruptInbox: 'keep',
    })
    expect(idleStops).toEqual([])
    expect(idleReceipt.interrupted).toBe(false)
    expect(idleReceipt.retainedInputs).toBeUndefined()
  })

  it('restores kept messages ahead of inputs enqueued during the stop', async () => {
    const { harness, target } = await bootRunning()
    const { own, human } = seed(target, String(harness.lead.id))
    const late = queuedMessage('msg-late', { kind: 'user' }, 'arrived during the stop')
    const stops: string[] = []
    harness.ctx.on('workspace/session-stop', ({ sessionId }) => {
      stops.push(String(sessionId))
      target.inbox.clear()
      target.setRunning(false)
      // A human prompt lands after the provider cleared the inbox.
      target.inbox.nextTurn.push(late)
    })
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'replacement', {
      interrupt: true,
      interruptInbox: 'keep',
    })
    expect(stops).toEqual(['target'])
    expect(receipt.retainedInputs).toBe(3)
    expect(target.inbox.nextTurn).toHaveLength(4)
    expect(target.inbox.nextTurn[0]).toBe(own)
    expect(target.inbox.nextTurn[1]).toBe(human)
    expect(target.inbox.nextTurn[2]).toBe(late)
    expect(messageText(target.inbox.nextTurn[3]!)).toContain('replacement')
    expect(target.inbox.nextStep).toHaveLength(1)
  })

  it('keeps restored inputs when the replacement admission fails after the stop', async () => {
    const { harness, target } = await bootRunning()
    const { own, human } = seed(target, String(harness.lead.id))
    target.failFollowups = 1
    recordStops(harness, target)
    const error = await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'replacement', {
        interrupt: true,
        interruptInbox: 'keep',
      }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('already asked to stop')
    // The restore happened before the failed admission and survives it.
    expect(target.inbox.nextTurn[0]).toBe(own)
    expect(target.inbox.nextTurn[1]).toBe(human)
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['target'])
  })

  it('admits the replacement prompt when the inbox restore fails after the stop', async () => {
    const { harness, target } = await bootRunning()
    seed(target, String(harness.lead.id))
    target.inbox.prependFailure = new Error('inbox is closed')
    const stops = recordStops(harness, target)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'replacement', {
      interrupt: true,
      interruptInbox: 'keep',
    })
    expect(stops).toEqual(['target'])
    // The restore could not run, so no retention count is reported.
    expect(receipt.interrupted).toBe(true)
    expect(receipt.retainedInputs).toBeUndefined()
    // The stop is committed: the replacement prompt still runs and the watch
    // this call added is not rolled back.
    expect(target.followups.map(messageText).some(text => text.includes('replacement'))).toBe(true)
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['target'])
  })
})

describe('answer routing (Phase 1d, cases 13–25)', () => {
  /** Seed one durable question report into the lead log and return its id. */
  function seedQuestion(harness: ServiceHarness, senderId: string, message = 'Which target?'): string {
    const value = devLeadReport({
      senderSessionId: senderId,
      leadSessionId: String(harness.lead.id),
      turn: 1,
      kind: 'question',
      message,
      at: T0,
    })
    appendPluginRecord(harness.leadSession, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(value))
    return value.id
  }

  /** Durable answer lifecycle records of the lead Session, in log order. */
  function answerRecords(harness: ServiceHarness): DevLeadReportAnswer[] {
    return harness.leadSession.snapshotEvents().flatMap((event) => {
      const record = pluginRecordOf(event)
      return record?.type === DEVLEAD_REPORT_ANSWER_RECORD_TYPE
        ? [(record.data as { answer: DevLeadReportAnswer }).answer]
        : []
    })
  }

  /**
   * Register one fake stop provider that clears the inbox and idles the target.
   * Uses `cancelInbox` so the clear emits the same `agent/inbox/discarded`
   * events the real Host stop emits, exercising the interrupt-window suppression.
   */
  function recordStops(harness: ServiceHarness, target: FakeAgent): string[] {
    const stops: string[] = []
    harness.ctx.on('workspace/session-stop', ({ sessionId }) => {
      stops.push(String(sessionId))
      target.cancelInbox()
      target.setRunning(false)
    })
    return stops
  }

  async function bootTarget(running = false): Promise<{ harness: ServiceHarness; target: FakeAgent }> {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(running)
    harness.agents.add(target)
    return { harness, target }
  }

  it('case 13: answers a running child via steer and observes admitted → claimed → presented', async () => {
    const { harness, target } = await bootTarget(true)
    const questionId = seedQuestion(harness, 'target')
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', {
      intent: 'answer',
      questionId,
    })
    expect(receipt.delivery).toMatchObject({
      primitive: 'steer',
      boundary: 'next-step',
      wakeRequested: true,
      questionId,
    })
    expect(target.steers).toHaveLength(1)
    expect(target.followups).toHaveLength(0)
    const admitted = target.steers[0]!
    expect(messageText(admitted)).toContain(`[DEV LEAD ANSWER to question ${questionId}]`)
    expect(messageText(admitted)).toContain('use staging')
    expect(admitted.source).toMatchObject({ kind: 'devlead', form: 'relay', intent: 'answer', questionId })
    // Durable admitted record + derived answered state.
    expect(answerRecords(harness)).toHaveLength(1)
    expect(answerRecords(harness)[0]).toMatchObject({ reportId: questionId, status: 'admitted', messageId: receipt.delivery.messageId })
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'admitted',
      answerMessageId: receipt.delivery.messageId,
    })
    // A real pre-step claim then presentation advances the in-memory lifecycle.
    appendTurnStart(target.session, 1)
    target.claimNextStep({ present: true, turn: 1 })
    await flushMicrotasks()
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'presented',
    })
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.presentedAt).toBeTypeOf('number')
  })

  it('case 14: answers an idle child via steer without isolating an older next-turn input', async () => {
    const { harness, target } = await bootTarget(false)
    const questionId = seedQuestion(harness, 'target')
    const older = queuedMessage('msg-older', { kind: 'user' }, 'older instruction')
    target.inbox.nextTurn.push(older)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', {
      intent: 'answer',
      questionId,
    })
    expect(receipt.delivery).toMatchObject({ primitive: 'steer', boundary: 'next-step' })
    // The older next-turn input is still queued: steer is priority, not isolation.
    expect(target.inbox.nextTurn).toHaveLength(1)
    expect(target.inbox.nextStep).toHaveLength(1)
    // The first pre-step claims the answer (next-step) and the older next-turn together.
    appendTurnStart(target.session, 1)
    const claimed = target.claimNextTurnPreStep({ present: true, turn: 1 })
    expect(claimed.map(message => String(message.id))).toContain(receipt.delivery.messageId)
    expect(claimed.map(message => String(message.id))).toContain('msg-older')
  })

  it('case 15: answers a cold child via resume + steer', async () => {
    const controller = new FakeSessionController()
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'], sessionController: controller })
    const target = new FakeAgent(requireSession(harness, 'target'))
    controller.resolveHandler = () => {
      harness.agents.add(target)
      return { agent: target.agent }
    }
    const questionId = seedQuestion(harness, 'target')
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', {
      intent: 'answer',
      questionId,
    })
    expect(receipt.resumed).toBe(true)
    expect(receipt.delivery).toMatchObject({ primitive: 'steer', boundary: 'next-step' })
    expect(target.steers).toHaveLength(1)
  })

  it('case 16: rejects an answer to an archived child without writing an answer record', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.archived = ['target']
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'], workspaceRegistry: registry })
    const questionId = seedQuestion(harness, 'target')
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId }),
      'DEVLEAD_SESSION_ARCHIVED',
    )
    expect(answerRecords(harness)).toEqual([])
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.questionStatus).toBe('open')
  })

  it('case 17: a rejected pre-step discards the answer, reopens the question, and accepts a re-answer', async () => {
    const { harness, target } = await bootTarget(true)
    const questionId = seedQuestion(harness, 'target')
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', {
      intent: 'answer',
      questionId,
    })
    // Claimed but the proposed step is rejected: no user/message is appended.
    appendTurnStart(target.session, 1)
    target.claimNextStep({ present: false, turn: 1 })
    appendTurnEnd(target.session, 1)
    await flushMicrotasks()
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)).toMatchObject({
      questionStatus: 'open',
      answerStatus: 'discarded',
    })
    // The discard is durable so the reopen survives a restart.
    expect(answerRecords(harness).some(record => record.status === 'discarded' && record.messageId === receipt.delivery.messageId)).toBe(true)
    // A fresh answer is accepted again.
    const again = await harness.service.promptSession(harness.lead.agent, 'target', 'use prod', { intent: 'answer', questionId })
    expect(again.delivery.messageId).not.toBe(receipt.delivery.messageId)
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.questionStatus).toBe('answered')
  })

  it('case 18: a same-text/same-key answer retry returns the original receipt; a different answer conflicts', async () => {
    const { harness, target } = await bootTarget(true)
    const questionId = seedQuestion(harness, 'target')
    const first = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', {
      intent: 'answer',
      questionId,
      idempotencyKey: 'k1',
    })
    // Same text (no key) → same-text replay.
    const byText = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    expect(byText.delivery.messageId).toBe(first.delivery.messageId)
    // Same key + same text → same-key replay.
    const byKey = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', {
      intent: 'answer',
      questionId,
      idempotencyKey: 'k1',
    })
    expect(byKey.delivery.messageId).toBe(first.delivery.messageId)
    // No second delivery happened.
    expect(target.steers).toHaveLength(1)
    expect(answerRecords(harness)).toHaveLength(1)
    // A different answer is an explicit conflict.
    const error = await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'use prod', { intent: 'answer', questionId }),
      'DEVLEAD_QUESTION_ALREADY_ANSWERED',
    )
    expect(error.message).toContain('use staging')
    expect(target.steers).toHaveLength(1)
  })

  it('case 19: answer + interrupt cancels the running work and admits the answer as a followup', async () => {
    const { harness, target } = await bootTarget(true)
    const questionId = seedQuestion(harness, 'target')
    const stops = recordStops(harness, target)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', {
      intent: 'answer',
      questionId,
      interrupt: true,
    })
    expect(stops).toEqual(['target'])
    expect(receipt.interrupted).toBe(true)
    expect(receipt.delivery).toMatchObject({ primitive: 'followup', boundary: 'next-turn', wakeRequested: true })
    expect(target.followups).toHaveLength(1)
    expect(answerRecords(harness)[0]).toMatchObject({ status: 'admitted', primitive: 'followup', boundary: 'next-turn' })
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.questionStatus).toBe('answered')
  })

  it('case 20: background injects without a wake (idle/running) and rejects a cold target', async () => {
    const idle = await bootTarget(false)
    const idleReceipt = await idle.harness.service.promptSession(idle.harness.lead.agent, 'target', 'fyi context', { intent: 'background' })
    expect(idleReceipt.delivery).toMatchObject({ primitive: 'inject', boundary: 'next-step', wakeRequested: false })
    expect(idle.target.injects).toHaveLength(1)
    expect(idle.target.injects[0]!.source).toMatchObject({
      kind: 'devlead',
      form: 'notice',
      intent: 'background',
      wakeRequested: false,
      lane: 'background',
      senderSessionId: String(idle.harness.lead.id),
    })
    // A later followup presents the queued background context.
    appendTurnStart(idle.target.session, 1)
    const claimed = idle.target.claimNextTurnPreStep({ present: true, turn: 1 })
    expect(claimed.map(message => String(message.id))).toContain(idleReceipt.delivery.messageId)

    const running = await bootTarget(true)
    const runningReceipt = await running.harness.service.promptSession(running.harness.lead.agent, 'target', 'fyi', { intent: 'background' })
    expect(runningReceipt.delivery).toMatchObject({ primitive: 'inject', boundary: 'next-step', wakeRequested: false })

    const cold = await bootService({ enabled: true, sessionIds: ['target'] })
    await expectCodeAsync(
      () => cold.service.promptSession(cold.lead.agent, 'target', 'fyi', { intent: 'background' }),
      'DEVLEAD_INVALID_INPUT',
    )
  })

  it('case 21: correction steers the next step for running and idle targets', async () => {
    const running = await bootTarget(true)
    const runningReceipt = await running.harness.service.promptSession(running.harness.lead.agent, 'target', 'stop doing X', { intent: 'correction' })
    expect(runningReceipt.delivery).toMatchObject({ primitive: 'steer', boundary: 'next-step', wakeRequested: true })
    expect(running.target.steers).toHaveLength(1)
    expect(running.target.steers[0]!.source).toMatchObject({ intent: 'correction', form: 'relay' })

    const idle = await bootTarget(false)
    const idleReceipt = await idle.harness.service.promptSession(idle.harness.lead.agent, 'target', 'stop doing X', { intent: 'correction' })
    expect(idleReceipt.delivery).toMatchObject({ primitive: 'steer', boundary: 'next-step' })
    expect(idle.target.steers).toHaveLength(1)
  })

  it('case 22: clear-own keeps a pending answer; clear-all discards it and reopens the question', async () => {
    // clear-own: the answer survives, the own instruction is dropped, human input stays.
    const own = await bootTarget(true)
    const ownQuestion = seedQuestion(own.harness, 'target')
    await own.harness.service.promptSession(own.harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId: ownQuestion })
    const ownInstruction = queuedMessage('msg-own', { kind: 'devlead', form: 'relay', senderSessionId: String(own.harness.lead.id), intent: 'instruction' }, 'stale')
    const human = queuedMessage('msg-human', { kind: 'user' }, 'human')
    own.target.inbox.nextTurn.push(ownInstruction, human)
    recordStops(own.harness, own.target)
    const ownReceipt = await own.harness.service.promptSession(own.harness.lead.agent, 'target', 'replacement', {
      interrupt: true,
      interruptInbox: 'clear-own',
    })
    expect(ownReceipt.retainedInputs).toBe(2) // answer + human
    expect(own.target.inbox.nextStep.some(message => String(message.id) === ownReceipt.delivery.messageId)).toBe(false)
    // The answer is still pending at next-step and the question stays answered.
    expect(own.target.inbox.nextStep).toHaveLength(1)
    expect(own.harness.service.questionAnswerView(own.harness.lead.agent, ownQuestion)?.questionStatus).toBe('answered')

    // clear-all: the answer is discarded and the question reopens.
    const all = await bootTarget(true)
    const allQuestion = seedQuestion(all.harness, 'target')
    const answerReceipt = await all.harness.service.promptSession(all.harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId: allQuestion })
    recordStops(all.harness, all.target)
    await all.harness.service.promptSession(all.harness.lead.agent, 'target', 'replacement', { interrupt: true, interruptInbox: 'clear-all' })
    await flushMicrotasks()
    expect(all.harness.service.questionAnswerView(all.harness.lead.agent, allQuestion)).toMatchObject({
      questionStatus: 'open',
      answerStatus: 'discarded',
    })
    expect(answerRecords(all.harness).some(record => record.status === 'discarded' && record.messageId === answerReceipt.delivery.messageId)).toBe(true)
  })

  it('case 23: retract withdraws own instruction/background but refuses an answer', async () => {
    const { harness, target } = await bootTarget(false)
    const questionId = seedQuestion(harness, 'target')
    const answerReceipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    const background = await harness.service.promptSession(harness.lead.agent, 'target', 'fyi', { intent: 'background' })
    const instruction = await harness.service.promptSession(harness.lead.agent, 'target', 'do X')
    // The answer cannot be retracted.
    const error = await expectCodeAsync(
      () => harness.service.retractQueuedInput(harness.lead.agent, 'target', answerReceipt.delivery.messageId),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(error.message).toContain('answer')
    // Background and instruction can be retracted.
    expect(await harness.service.retractQueuedInput(harness.lead.agent, 'target', background.delivery.messageId))
      .toMatchObject({ retracted: true })
    expect(await harness.service.retractQueuedInput(harness.lead.agent, 'target', instruction.delivery.messageId))
      .toMatchObject({ retracted: true })
    // The answer is still pending.
    expect(target.inbox.nextStep.some(message => String(message.id) === answerReceipt.delivery.messageId)).toBe(true)
  })

  it('case 24: next-step precedes next-turn, same-boundary FIFO, and concurrent prompts serialize', async () => {
    const { harness, target } = await bootTarget(false)
    const first = await harness.service.promptSession(harness.lead.agent, 'target', 'first correction', { intent: 'correction' })
    const second = await harness.service.promptSession(harness.lead.agent, 'target', 'second correction', { intent: 'correction' })
    const turnPrompt = await harness.service.promptSession(harness.lead.agent, 'target', 'a new turn')
    // Two next-step steers (FIFO) then one next-turn followup.
    expect(target.inbox.nextStep.map(message => String(message.id)))
      .toEqual([first.delivery.messageId, second.delivery.messageId])
    expect(target.inbox.nextTurn.map(message => String(message.id))).toEqual([turnPrompt.delivery.messageId])
    appendTurnStart(target.session, 1)
    const claimed = target.claimNextTurnPreStep({ present: true, turn: 1 })
    expect(claimed.map(message => String(message.id)))
      .toEqual([first.delivery.messageId, second.delivery.messageId, turnPrompt.delivery.messageId])

    // Concurrent calls for one target land in call order (per-target serialization).
    const concurrent = await bootTarget(false)
    const [a, b] = await Promise.all([
      concurrent.harness.service.promptSession(concurrent.harness.lead.agent, 'target', 'A'),
      concurrent.harness.service.promptSession(concurrent.harness.lead.agent, 'target', 'B'),
    ])
    expect(concurrent.target.inbox.nextTurn.map(message => String(message.id)))
      .toEqual([a.delivery.messageId, b.delivery.messageId])
  })

  it('case 25: a steer admitted near turn close stays pending (admitted, not lost)', async () => {
    const { harness, target } = await bootTarget(true)
    const questionId = seedQuestion(harness, 'target')
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    // No claim yet: the message waits in next-step for the next pre-step/wake.
    expect(receipt.delivery.boundary).toBe('next-step')
    expect(target.inbox.nextStep.some(message => String(message.id) === receipt.delivery.messageId)).toBe(true)
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.answerStatus).toBe('admitted')
    // A later wake claims and presents it; nothing was lost.
    appendTurnStart(target.session, 1)
    target.claimNextStep({ present: true, turn: 1 })
    await flushMicrotasks()
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.answerStatus).toBe('presented')
  })

  it('validates question_id ownership, kind, and the intent combination guards', async () => {
    const { harness } = await bootTarget(true)
    const questionId = seedQuestion(harness, 'target')
    // answer without question_id.
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'x', { intent: 'answer' }),
      'DEVLEAD_INVALID_INPUT',
    )
    // unknown question id.
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'x', { intent: 'answer', questionId: 'nope' }),
      'DEVLEAD_QUESTION_NOT_FOUND',
    )
    // question_id on a non-answer intent.
    for (const intent of ['instruction', 'correction', 'background'] as const) {
      await expectCodeAsync(
        () => harness.service.promptSession(harness.lead.agent, 'target', 'x', { intent, questionId }),
        'DEVLEAD_INVALID_INPUT',
      )
    }
    // background + interrupt.
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'x', { intent: 'background', interrupt: true }),
      'DEVLEAD_INVALID_INPUT',
    )
    // A question report from another sender does not match this target.
    const foreign = seedQuestion(harness, 'another-child', 'Foreign?')
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'x', { intent: 'answer', questionId: foreign }),
      'DEVLEAD_QUESTION_NOT_FOUND',
    )
    // A non-question report id is not a question.
    const progress = devLeadReport({ senderSessionId: 'target', leadSessionId: String(harness.lead.id), turn: 1, kind: 'progress', message: 'p', at: T0 })
    appendPluginRecord(harness.leadSession, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(progress))
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'x', { intent: 'answer', questionId: progress.id }),
      'DEVLEAD_QUESTION_NOT_FOUND',
    )
  })

  it('deduplicates non-answer prompts through the idempotency_key memory window', async () => {
    const { harness, target } = await bootTarget(false)
    const first = await harness.service.promptSession(harness.lead.agent, 'target', 'do X', { idempotencyKey: 'k' })
    const retry = await harness.service.promptSession(harness.lead.agent, 'target', 'do X', { idempotencyKey: 'k' })
    expect(retry.delivery.messageId).toBe(first.delivery.messageId)
    expect(target.followups).toHaveLength(1)
    // A different text under the same key is a conflict.
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do Y', { idempotencyKey: 'k' }),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(target.followups).toHaveLength(1)
  })

  it('stamps the runtime source on every intent and never lets the model forge it', async () => {
    const { harness, target } = await bootTarget(false)
    const questionId = seedQuestion(harness, 'target')
    await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId, idempotencyKey: 'k' })
    await harness.service.promptSession(harness.lead.agent, 'target', 'correct', { intent: 'correction' })
    await harness.service.promptSession(harness.lead.agent, 'target', 'background', { intent: 'background' })
    await harness.service.promptSession(harness.lead.agent, 'target', 'instruction')
    const leadId = String(harness.lead.id)
    expect(target.steers[0]!.source).toMatchObject({ kind: 'devlead', form: 'relay', intent: 'answer', questionId, idempotencyKey: 'k', senderSessionId: leadId, wakeRequested: true })
    expect(target.steers[1]!.source).toMatchObject({ kind: 'devlead', form: 'relay', intent: 'correction', senderSessionId: leadId })
    expect(target.injects[0]!.source).toMatchObject({ kind: 'devlead', form: 'notice', intent: 'background', senderSessionId: leadId, wakeRequested: false })
    expect(target.followups[0]!.source).toMatchObject({ kind: 'devlead', form: 'relay', intent: 'instruction', senderSessionId: leadId })
    // The answer text hash covers the lead's prompt, not the runtime prefix.
    expect(answerRecords(harness)[0]?.textHash).toBe(answerTextHash('use staging'))
  })

  it('exposes intent/questionId/wakeRequested/deliveryState on queuedInputs for a pending answer', async () => {
    const { harness } = await bootTarget(false)
    const questionId = seedQuestion(harness, 'target')
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    const queued = harness.service.sessionQueuedInputs(harness.lead.agent, 'target')
    expect(queued).toEqual([expect.objectContaining({
      id: receipt.delivery.messageId,
      boundary: 'next-step',
      sourceKind: 'devlead',
      sourceForm: 'relay',
      intent: 'answer',
      questionId,
      wakeRequested: true,
      deliveryState: 'admitted',
    })])
  })
})

describe('answer restart and durability (Phase 1d review fixes)', () => {
  /** Seed one question report into the lead log and return its id. */
  function seedQuestion(harness: ServiceHarness, senderId = 'target', message = 'Which target?'): string {
    const value = devLeadReport({
      senderSessionId: senderId,
      leadSessionId: String(harness.lead.id),
      turn: 1,
      kind: 'question',
      message,
      at: T0,
    })
    appendPluginRecord(harness.leadSession, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(value))
    return value.id
  }

  /** Durable answer records of the lead Session, in log order. */
  function answerRecords(harness: ServiceHarness): DevLeadReportAnswer[] {
    return harness.leadSession.snapshotEvents().flatMap((event) => {
      const record = pluginRecordOf(event)
      return record?.type === DEVLEAD_REPORT_ANSWER_RECORD_TYPE
        ? [(record.data as { answer: DevLeadReportAnswer }).answer]
        : []
    })
  }

  it('restart seeds the latest discarded answer as open, not the earlier admitted row', async () => {
    let questionId = ''
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      seedLead: (session) => {
        const q = devLeadReport({ senderSessionId: 'target', leadSessionId: String(session.id), turn: 1, kind: 'question', message: 'Which target?', at: T0 })
        questionId = q.id
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(q))
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: q.id, messageId: 'm1', status: 'admitted', at: T0 })))
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: q.id, messageId: 'm1', status: 'discarded', at: T0 + 1, answeredAt: T0 })))
      },
    })
    harness.agents.add(new FakeAgent(requireSession(harness, 'target')))
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)).toEqual({
      questionStatus: 'open',
      answerStatus: 'discarded',
      answerMessageId: 'm1',
      answeredAt: T0,
    })
    // The open question accepts a new answer (not rejected as already answered).
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use prod', { intent: 'answer', questionId })
    expect(receipt.delivery.messageId).not.toBe('m1')
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.questionStatus).toBe('answered')
  })

  it('restart seeds the newest re-answer after a discard (latest messageId wins)', async () => {
    let questionId = ''
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      seedLead: (session) => {
        const q = devLeadReport({ senderSessionId: 'target', leadSessionId: String(session.id), turn: 1, kind: 'question', message: 'Which target?', at: T0 })
        questionId = q.id
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(q))
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: q.id, messageId: 'm1', status: 'admitted', at: T0, text: 'use staging' })))
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: q.id, messageId: 'm1', status: 'discarded', at: T0 + 1, answeredAt: T0, text: 'use staging' })))
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: q.id, messageId: 'm2', status: 'admitted', at: T0 + 2, answeredAt: T0, text: 'use prod' })))
      },
    })
    harness.agents.add(new FakeAgent(requireSession(harness, 'target')))
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'admitted',
      answerMessageId: 'm2',
    })
    // A same-text retry of the newest answer replays m2; a different text conflicts.
    const retry = await harness.service.promptSession(harness.lead.agent, 'target', 'use prod', { intent: 'answer', questionId })
    expect(retry.delivery.messageId).toBe('m2')
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId }),
      'DEVLEAD_QUESTION_ALREADY_ANSWERED',
    )
  })

  it('restart after a clear-all discard restores the question as open', async () => {
    let questionId = ''
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      seedLead: (session) => {
        const q = devLeadReport({ senderSessionId: 'target', leadSessionId: String(session.id), turn: 1, kind: 'question', message: 'Which target?', at: T0 })
        questionId = q.id
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(q))
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: q.id, messageId: 'm1', status: 'admitted', at: T0 })))
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: q.id, messageId: 'm1', status: 'discarded', at: T0 + 1, answeredAt: T0 })))
      },
    })
    harness.agents.add(new FakeAgent(requireSession(harness, 'target')))
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.questionStatus).toBe('open')
  })

  it('restart restores the durable admitted state (in-memory presentation is Phase 2 backfill)', async () => {
    let questionId = ''
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      seedLead: (session) => {
        const q = devLeadReport({ senderSessionId: 'target', leadSessionId: String(session.id), turn: 1, kind: 'question', message: 'Which target?', at: T0 })
        questionId = q.id
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(q))
        // Phase 1d writes only admitted durably; presented is an in-memory observation.
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: q.id, messageId: 'm1', status: 'admitted', at: T0 })))
      },
    })
    harness.agents.add(new FakeAgent(requireSession(harness, 'target')))
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'admitted',
      answerMessageId: 'm1',
    })
  })

  it('reconciles a discard observed while the lead was cold when the lead becomes live', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    const questionId = seedQuestion(harness)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    const message = target.inbox.nextStep.find(entry => String(entry.id) === receipt.delivery.messageId)
    if (message === undefined) throw new Error('expected the admitted answer to be pending')
    // Simulate a cold/detached lead log: the discard cannot be appended yet.
    const realGet = harness.ctx.sessions.get.bind(harness.ctx.sessions)
    const spy = vi.spyOn(harness.ctx.sessions, 'get')
      .mockImplementation((id: Parameters<typeof realGet>[0]) => String(id) === String(harness.lead.id) ? undefined : realGet(id))
    harness.ctx.emit('agent/inbox/discarded', { agent: target.agent, message })
    await flushMicrotasks()
    // Memory reopened the question, but the durable discard is queued, not written.
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.questionStatus).toBe('open')
    expect(answerRecords(harness).some(record => record.status === 'discarded')).toBe(false)
    spy.mockRestore()
    // The lead becomes live again: the queued discard is drained to the durable audit.
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    await flushMicrotasks()
    expect(answerRecords(harness).some(record => record.status === 'discarded' && record.messageId === receipt.delivery.messageId)).toBe(true)
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)).toMatchObject({ questionStatus: 'open', answerStatus: 'discarded' })
  })

  it('surfaces a receipt warning when the durable answer record append fails', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    harness.agents.add(new FakeAgent(requireSession(harness, 'target')))
    const questionId = seedQuestion(harness)
    // appendPluginRecord commits through the Session's internal commit path;
    // failing it once makes the durable answer-record append throw.
    const spy = vi.spyOn(harness.leadSession as unknown as { commit: (...args: unknown[]) => unknown }, 'commit')
      .mockImplementationOnce(() => {
        throw new Error('disk full')
      })
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    spy.mockRestore()
    expect(receipt.warning).toContain('durable record could not be written')
    // The delivery still happened; the in-memory state tracks the answer.
    expect(receipt.delivery.primitive).toBe('steer')
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.questionStatus).toBe('answered')
  })

  it('surfaces a receipt warning when the answer record flush fails', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'], flushFailure: new Error('flush down') })
    harness.agents.add(new FakeAgent(requireSession(harness, 'target')))
    const questionId = seedQuestion(harness)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    expect(receipt.warning).toContain('could not be flushed')
  })

  it('conflicts on a same-key different-text answer retry; same key + same text replays', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    harness.agents.add(new FakeAgent(requireSession(harness, 'target')))
    const questionId = seedQuestion(harness)
    const first = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId, idempotencyKey: 'k' })
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'use prod', { intent: 'answer', questionId, idempotencyKey: 'k' }),
      'DEVLEAD_QUESTION_ALREADY_ANSWERED',
    )
    const retry = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId, idempotencyKey: 'k' })
    expect(retry.delivery.messageId).toBe(first.delivery.messageId)
  })

  it('clear-all does not discard an answer the stop provider left pending', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    const questionId = seedQuestion(harness)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    // A stop provider that fails and does NOT clear the inbox.
    harness.ctx.on('workspace/session-stop', () => {
      throw new Error('stop provider failed')
    })
    await harness.service.promptSession(harness.lead.agent, 'target', 'replacement', { interrupt: true, interruptInbox: 'clear-all' })
    await flushMicrotasks()
    // The answer is still pending and its question stays answered (no false discard).
    expect(target.inbox.nextStep.some(entry => String(entry.id) === receipt.delivery.messageId)).toBe(true)
    expect(harness.service.questionAnswerView(harness.lead.agent, questionId)?.questionStatus).toBe('answered')
    expect(answerRecords(harness).some(record => record.status === 'discarded')).toBe(false)
  })

  it('interrupt+answer cannot replace an active pending answer (the policy rejects first)', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    const questionId = seedQuestion(harness)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId })
    await expectCodeAsync(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'use prod', { intent: 'answer', questionId, interrupt: true }),
      'DEVLEAD_QUESTION_ALREADY_ANSWERED',
    )
    // The active answer is untouched; no discard, no replacement.
    expect(target.inbox.nextStep.some(entry => String(entry.id) === receipt.delivery.messageId)).toBe(true)
    expect(answerRecords(harness).some(record => record.status === 'discarded')).toBe(false)
  })
})
