import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendPluginRecord, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_REPORT_ANSWER_RECORD_TYPE,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import { DevLeadError } from '../src/error.ts'
import { devLeadReport, modeRecord, reportAnswerRecord, reportRecord, resetRecord, watchRecord } from '../src/domain.ts'
import { devLeadPromptIdempotencyKey, PROMPT_IDEMPOTENCY_SPEC } from '../src/idempotency.ts'
import { emptyDevLeadProjectionState } from '../src/fold.ts'
import { emptyDevLeadChildAnswersState } from '../src/child-answer-projection.ts'
import { ASK_USER_QUESTION_TOOL, registerQuestionRouting } from '../../tool/src/question-routing.ts'
import { DevLeadNotificationHub, type DevLeadPersistedLead } from '../src/notification.ts'
import {
  appendTurnStart,
  bootService,
  disposeHarnesses,
  FakeAgent,
  FakeProjectionCache,
  FakeSessionPersistence,
  FakeSessionQuery,
  FakeStorageDomain,
  flushMicrotasks,
  nextTask,
  queuedMessage,
  T0,
  type ServiceHarness,
} from './harness.ts'
import { answer, modeEvent, watchEvent } from './fixtures.ts'

afterEach(async () => { await disposeHarnesses() })

async function eventually<T>(run: () => Promise<T>, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await run()
    } catch (error: unknown) {
      if (!(error instanceof DevLeadError) || error.code !== 'DEVLEAD_SESSION_UNAVAILABLE') throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw new Error(`operation did not recover within ${timeoutMs}ms`)
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<DevLeadError> {
  try {
    await run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DevLeadError)
    expect((error as DevLeadError).code).toBe(code)
    return error as DevLeadError
  }
  throw new Error(`expected ${code}, but the call succeeded`)
}

/** Sleep for one real timer tick; only used for bounded condition polling. */
async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) })
}

/** Wait until a synchronous predicate holds, polling at a bounded cadence. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`condition "${label}" did not settle within ${timeoutMs}ms`)
}

/**
 * Retry one prompt until it fails with the expected code. A
 * `DEVLEAD_SESSION_UNAVAILABLE` fail-closed answer is retried (the index is
 * still recovering); any other outcome fails immediately.
 */
async function eventuallyCode(run: () => Promise<unknown>, code: string, timeoutMs = 8_000): Promise<DevLeadError> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await run()
    } catch (error: unknown) {
      if (error instanceof DevLeadError && error.code === code) return error
      if (!(error instanceof DevLeadError) || error.code !== 'DEVLEAD_SESSION_UNAVAILABLE') throw error
      await sleep(50)
      continue
    }
    throw new Error(`expected ${code}, but the call succeeded`)
  }
  throw new Error(`operation never failed with ${code} within ${timeoutMs}ms`)
}

/**
 * Advance vitest fake timers until a synchronous predicate holds. The bounded
 * step count fails loudly instead of letting a wedged timer chain hang a spec.
 */
async function advanceUntil(predicate: () => boolean, label: string, stepMs = 100, maxSteps = 900): Promise<void> {
  for (let index = 0; index < maxSteps; index += 1) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(stepMs)
    await flushMicrotasks(128)
  }
  if (predicate()) return
  throw new Error(`condition "${label}" did not settle within ${String(maxSteps * stepMs)}ms of advanced time`)
}

/**
 * Boot the service while vitest fake timers are active: the readiness barrier,
 * the bounded retry timer and the attempt deadline are all fake-timer driven,
 * so boot settles only when those timers advance. A backend promise that never
 * settles must not keep the boot promise pending past the advanced-time bound.
 */
async function bootUnderFakeTimers(options: Parameters<typeof bootService>[0]): Promise<ServiceHarness> {
  const pending = bootService(options)
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  for (let index = 0; index < 600 && !settled; index += 1) {
    await vi.advanceTimersByTimeAsync(100)
    await flushMicrotasks(128)
  }
  if (!settled) throw new Error('bootService did not settle within 60s of advanced fake time')
  return await pending
}

function question(leadSessionId: string, at = T0, message = 'Which target?') {
  return devLeadReport({ senderSessionId: 'target', leadSessionId, turn: 1, kind: 'question', message, at })
}

describe('Batch 1 prompt supervision and budgets', () => {
  it('rejects foreign and conflicting supervisors without delivering', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target', 'other-lead'],
      watched: ['target'],
      extraAgents: (agents, sessions) => { agents.add(new FakeAgent(sessions['other-lead']!)) },
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    const other = new FakeAgent(harness.sessions['other-lead']!)
    appendPluginRecord(other.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
    appendPluginRecord(other.session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(['target'], T0))
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do not broadcast', { watch: false }),
      'DEVLEAD_MULTIPLE_SUPERVISORS',
    )
    await harness.service.watchSession(harness.lead.agent, 'target', false)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'still not yours', { watch: false }),
      'DEVLEAD_FOREIGN_SUPERVISOR',
    )
    expect(target.followups).toHaveLength(0)
    expect(target.steers).toHaveLength(0)
  })

  it('fails closed when a composed cold index cannot be proven complete', async () => {
    const query = new FakeSessionQuery()
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['foreign-lead']
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await nextTask()
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do not deliver', { watch: false }),
      'DEVLEAD_FOREIGN_SUPERVISOR',
    )
    expect(target.followups).toHaveLength(0)
  })

  it('clears live-only authorization before a late corpus read finishes', async () => {
    const query = new FakeSessionQuery()
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    const cache = new FakeProjectionCache()
    cache.setDevLead('foreign-lead', { enabled: true, sessions: ['target'] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['foreign-lead']
    const originalRead = query.readSession.bind(query)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let readStarted = false
    query.readSession = async (sessionId) => {
      readStarted = true
      await gate
      return await originalRead(sessionId)
    }
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    await new Promise(resolve => setTimeout(resolve, 300))
    await nextTask()
    expect(readStarted).toBe(true)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    release()
    await nextTask()
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do not deliver', { watch: false }),
      'DEVLEAD_FOREIGN_SUPERVISOR',
    )
  })

  it('recovers prompt authorization after an incomplete scan succeeds on retry', async () => {
    const query = new FakeSessionQuery()
    query.seed('ordinary', [])
    query.readError = new Error('transient read failure')
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['ordinary']
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await nextTask()
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do not deliver yet', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    query.readError = undefined
    const cache = new FakeProjectionCache()
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    await new Promise(resolve => setTimeout(resolve, 300))
    await nextTask()
    const receipt = await eventually(() => harness.service.promptSession(harness.lead.agent, 'target', 'allowed after recovery'))
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
  })

  it('reschedules after a slow first scan fails without requiring another injection', async () => {
    const query = new FakeSessionQuery()
    query.seed('ordinary', [])
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['ordinary']
    const originalRead = query.readSession.bind(query)
    let calls = 0
    query.readSession = async (sessionId) => {
      calls += 1
      if (calls === 1) {
        await new Promise(resolve => setTimeout(resolve, 600))
        throw new Error('transient read failure')
      }
      return await originalRead(sessionId)
    }
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    await new Promise(resolve => setTimeout(resolve, 350))
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do not deliver yet', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 2_200))
    await nextTask()
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'allowed after scheduled retry')
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('fails closed when the unknown cold-read budget is capped', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    const ids = ['foreign-lead']
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    cache.setDevLead('foreign-lead', { enabled: true, sessions: ['target'] })
    for (let index = 0; index < 65; index += 1) {
      const id = `unknown-${index}`
      ids.push(id)
      query.seed(id, [])
    }
    persistence.ids = ids
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await nextTask()
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
  })

  it('exact-folds stale-negative cache rows instead of hiding a foreign supervisor', async () => {
    const query = new FakeSessionQuery()
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    const cache = new FakeProjectionCache()
    cache.setDevLead('foreign-lead', { enabled: false, sessions: ['target'] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['foreign-lead']
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await nextTask()
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'do not deliver', { watch: false }),
      'DEVLEAD_FOREIGN_SUPERVISOR',
    )
    expect(target.followups).toHaveLength(0)
  })

  it('bounds correction/background admissions per pair and child turn, with replay exempt', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    let keyed = ''
    for (let index = 0; index < 3; index += 1) {
      const receipt = await harness.service.promptSession(harness.lead.agent, 'target', `correction ${index}`, {
        intent: 'correction', ...(index === 0 ? { idempotencyKey: 'first-correction' } : {}),
      })
      if (index === 0) keyed = receipt.delivery.messageId
    }
    const replay = await harness.service.promptSession(harness.lead.agent, 'target', 'correction 0', {
      intent: 'correction', idempotencyKey: 'first-correction',
    })
    expect(replay.delivery.messageId).toBe(keyed)
    expect(target.steers).toHaveLength(3)
    // Discriminating assertion: if replay consumed budget, this fourth new
    // correction would be rejected as the fifth. Only the fifth may fail.
    await harness.service.promptSession(harness.lead.agent, 'target', 'fourth correction', { intent: 'correction' })
    expect(target.steers).toHaveLength(4)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'fifth correction', { intent: 'correction' }),
      'DEVLEAD_DELIVERY_RATE_LIMITED',
    )

    for (let index = 0; index < 8; index += 1) {
      await harness.service.promptSession(harness.lead.agent, 'target', `background ${index}`, { intent: 'background' })
    }
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'ninth background', { intent: 'background' }),
      'DEVLEAD_DELIVERY_RATE_LIMITED',
    )
    expect(target.injects).toHaveLength(8)
    appendTurnStart(target.session, 1)
    await harness.service.promptSession(harness.lead.agent, 'target', 'new-turn correction', { intent: 'correction' })
    expect(target.steers).toHaveLength(5)
  })

  it('replays non-answer idempotency receipts after a restart and rejects key conflicts', async () => {
    const storage = new FakeStorageDomain()
    const first = await bootService({
      leadId: 'durable-key-lead', enabled: true, sessionIds: ['target'], watched: ['target'], storageDomain: storage,
    })
    const firstTarget = new FakeAgent(first.sessions['target']!)
    first.agents.add(firstTarget)
    const admitted = await first.service.promptSession(first.lead.agent, 'target', 'do X', { idempotencyKey: 'restart-key' })
    expect(admitted.warning).toBeUndefined()
    await first.dispose()

    const restarted = await bootService({
      leadId: 'durable-key-lead', enabled: true, sessionIds: ['target'], watched: ['target'], storageDomain: storage,
    })
    const target = new FakeAgent(restarted.sessions['target']!)
    restarted.agents.add(target)
    const replay = await restarted.service.promptSession(restarted.lead.agent, 'target', 'do X', { idempotencyKey: 'restart-key' })
    expect(replay.delivery).toEqual(admitted.delivery)
    expect(target.followups).toHaveLength(0)
    await expectCode(
      () => restarted.service.promptSession(restarted.lead.agent, 'target', 'do Y', { idempotencyKey: 'restart-key' }),
      'DEVLEAD_INVALID_INPUT',
    )
    expect(target.followups).toHaveLength(0)
  })

  it('fails closed when composed idempotency storage cannot open', async () => {
    const storage = new FakeStorageDomain()
    const held = await storage.open(PROMPT_IDEMPOTENCY_SPEC)
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'], storageDomain: storage })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not duplicate', { idempotencyKey: 'closed-store' }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    await held.close()
  })

  it('fails closed on at-rest receipt corruption before the store opens', async () => {
    const storage = new FakeStorageDomain()
    const first = await bootService({
      leadId: 'at-rest-corrupt-lead', enabled: true, sessionIds: ['target'], watched: ['target'], storageDomain: storage,
    })
    const firstTarget = new FakeAgent(first.sessions['target']!)
    first.agents.add(firstTarget)
    await first.service.promptSession(first.lead.agent, 'target', 'execute once', { idempotencyKey: 'at-rest-key' })
    const storageKey = devLeadPromptIdempotencyKey('at-rest-corrupt-lead', 'target', 'at-rest-key')
    const table = storage.table('devlead_idempotency', 'receipts')
    const original = table.records.get(storageKey)
    expect(original).toBeDefined()
    await first.dispose()
    table.records.set(storageKey, { ...original as object, textHash: 'not-a-hash' })

    const restarted = await bootService({
      leadId: 'at-rest-corrupt-lead', enabled: true, sessionIds: ['target'], watched: ['target'], storageDomain: storage,
    })
    const target = new FakeAgent(restarted.sessions['target']!)
    restarted.agents.add(target)
    await expectCode(
      () => restarted.service.promptSession(restarted.lead.agent, 'target', 'execute once', { idempotencyKey: 'at-rest-key' }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
  })

  it('fails closed on an unreadable durable idempotency receipt instead of duplicating', async () => {
    const storage = new FakeStorageDomain()
    const first = await bootService({
      leadId: 'unreadable-key-lead', enabled: true, sessionIds: ['target'], watched: ['target'], storageDomain: storage,
    })
    const firstTarget = new FakeAgent(first.sessions['target']!)
    first.agents.add(firstTarget)
    const admitted = await first.service.promptSession(first.lead.agent, 'target', 'side effect once', { idempotencyKey: 'fragile-key' })
    const storageKey = devLeadPromptIdempotencyKey('unreadable-key-lead', 'target', 'fragile-key')
    const table = storage.table('devlead_idempotency', 'receipts')
    const original = table.records.get(storageKey)
    expect(original).toBeDefined()
    await first.dispose()

    const restarted = await bootService({
      leadId: 'unreadable-key-lead', enabled: true, sessionIds: ['target'], watched: ['target'], storageDomain: storage,
    })
    const target = new FakeAgent(restarted.sessions['target']!)
    restarted.agents.add(target)
    // Corrupt only after open/prune so this is a live read failure, not an
    // open-time schema rejection (which fails closed before the store opens).
    table.records.set(storageKey, { corrupt: true })
    await expectCode(
      () => restarted.service.promptSession(restarted.lead.agent, 'target', 'side effect once', { idempotencyKey: 'fragile-key' }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    table.records.set(storageKey, original)
    const replay = await restarted.service.promptSession(restarted.lead.agent, 'target', 'side effect once', { idempotencyKey: 'fragile-key' })
    expect(replay.delivery).toEqual(admitted.delivery)
    expect(target.followups).toHaveLength(0)
  })
})

describe('Batch 1 question TTL and cold replay', () => {
  it('expires only open questions lazily, supports zero, and refuses expired answers', async () => {
    const expiring = await bootService({
      leadId: 'ttl-lead', enabled: true, sessionIds: ['target'], watched: ['target'], config: { questionTtlMs: 1_000 },
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(question('ttl-lead', Date.now() - 1_000)))
      },
    })
    const target = new FakeAgent(expiring.sessions['target']!)
    expiring.agents.add(target)
    const expired = question('ttl-lead', Date.now() - 1_000)
    expect(expiring.service.questionAnswerView(expiring.lead.agent, expired.id)?.questionStatus).toBe('expired')
    await expectCode(
      () => expiring.service.promptSession(expiring.lead.agent, 'target', 'too late', { intent: 'answer', questionId: expired.id }),
      'DEVLEAD_QUESTION_NOT_FOUND',
    )

    const answeredHarness = await bootService({
      leadId: 'ttl-answered', enabled: true, sessionIds: ['target'], watched: ['target'], config: { questionTtlMs: 1_000 },
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(question('ttl-answered', T0)))
        const value = question('ttl-answered', T0)
        appendPluginRecord(session, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({ reportId: value.id, leadSessionId: 'ttl-answered' })))
      },
    })
    const answered = question('ttl-answered', T0)
    expect(answeredHarness.service.questionAnswerView(answeredHarness.lead.agent, answered.id)?.questionStatus).toBe('answered')

    const disabled = await bootService({
      leadId: 'ttl-disabled', enabled: true, sessionIds: ['target'], watched: ['target'], config: { questionTtlMs: 0 },
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(question('ttl-disabled', T0)))
      },
    })
    const stillOpen = question('ttl-disabled', T0)
    expect(disabled.service.questionAnswerView(disabled.lead.agent, stillOpen.id)?.questionStatus).toBe('open')
  })

  it('replays one action-required wake for a cold open question, dedupes, and skips expired', async () => {
    const leadId = 'cold-replay-lead'
    const harness = await bootService({
      leadId,
      enabled: true,
      watched: ['target'],
      registerLeadAgent: false,
      config: { notificationBatchMs: 0 },
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(question(leadId)))
      },
    })
    harness.agents.add(harness.lead)
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    await flushMicrotasks()
    expect(harness.lead.steers).toHaveLength(1)
    expect(harness.lead.steers[0]?.source).toMatchObject({ reportId: question(leadId).id, lane: 'action-required' })
    // Trigger a real second rehydration by composing the cold corpus late;
    // the once-per-question replay marker must still suppress a duplicate wake.
    const query = new FakeSessionQuery()
    query.seedRecord(harness.leadSession.header, harness.leadSession.snapshotEvents())
    const cache = new FakeProjectionCache()
    cache.setDevLead(leadId, { enabled: true, sessions: ['target'] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = [leadId]
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    await nextTask()
    expect(harness.lead.steers).toHaveLength(1)

    const expiredId = 'cold-expired-lead'
    const expired = await bootService({
      leadId: expiredId,
      enabled: true,
      watched: ['target'],
      registerLeadAgent: false,
      config: { notificationBatchMs: 0, questionTtlMs: 1_000 },
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(question(expiredId, Date.now() - 1_000)))
      },
    })
    expired.agents.add(expired.lead)
    expired.ctx.emit('agent/created', { agent: expired.lead.agent, source: 'resume' })
    await flushMicrotasks()
    expect(expired.lead.steers).toHaveLength(0)
  })

  it('retains cold replay above 16 per pair and drains it in capacity-bounded batches', async () => {
    const leadId = 'cold-cap-replay-lead'
    const questions = Array.from({ length: 17 }, (_, index) => question(leadId, T0, `Question ${index}?`))
    const harness = await bootService({
      leadId,
      enabled: true,
      watched: ['target'],
      registerLeadAgent: false,
      config: { notificationBatchMs: 0 },
      seedLead: (session) => {
        for (const value of questions) appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(value))
      },
    })
    harness.agents.add(harness.lead)
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    await flushMicrotasks(256)
    expect(harness.lead.steers.length).toBeGreaterThanOrEqual(2)
    for (const value of questions) {
      expect(harness.service.reportDeliveryState(harness.lead.agent, value.id)).toBe('delivered')
    }
    expect(harness.lead.steers.length).toBeLessThanOrEqual(2)
  })

  it('does not replay a capacity-deferred question answered while it waited', async () => {
    const leadId = 'cold-cap-answered-lead'
    const questions = Array.from({ length: 17 }, (_, index) => question(leadId, T0, `Question ${index}?`))
    const deferred = questions[16]!
    const harness = await bootService({
      leadId,
      enabled: true,
      watched: ['target'],
      registerLeadAgent: false,
      config: { notificationBatchMs: 0 },
      seedLead: (session) => {
        for (const value of questions) appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(value))
      },
    })
    // The first 16 occupy the action lane; the 17th is deferred. Answer it
    // before any capacity is released, then let the lane drain.
    appendPluginRecord(harness.leadSession, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({
      reportId: deferred.id, leadSessionId: leadId, sessionId: 'target', messageId: 'answered-deferred',
    })))
    harness.agents.add(harness.lead)
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    await flushMicrotasks(256)
    for (const value of questions.slice(0, 16)) {
      expect(harness.service.reportDeliveryState(harness.lead.agent, value.id)).toBe('delivered')
    }
    expect(harness.service.reportDeliveryState(harness.lead.agent, deferred.id)).toBeUndefined()
    expect(harness.lead.steers.map(message => String(message.id))).toHaveLength(1)
  })
})

describe('repair projection publication', () => {
  it('publishes both pending and resolved transitions through the real registry listener', async () => {
    const leadId = 'repair-publish-lead'
    const value = question(leadId)
    const harness = await bootService({
      leadId,
      enabled: true,
      watched: ['target'],
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(value))
      },
    })
    const changes: boolean[] = []
    const dispose = harness.ctx.sessionProjections.onChanged((_session, key, projection) => {
      if (key !== 'devLead') return
      const report = (projection as { reports?: Array<{ id: string; repairPending?: boolean }> }).reports?.find(row => row.id === value.id)
      changes.push(report?.repairPending === true)
    })
    const service = harness.service as unknown as {
      markRepairPending(lead: string, report: string): void
      clearRepairPending(lead: string, report: string): void
    }
    service.markRepairPending(leadId, value.id)
    expect(changes).toEqual([true])
    expect(harness.service.view(harness.lead.agent).reports[0]?.repairPending).toBe(true)
    service.clearRepairPending(leadId, value.id)
    expect(changes).toEqual([true, false])
    expect(harness.service.view(harness.lead.agent).reports[0]?.repairPending).toBeUndefined()
    dispose()
  })

  it('refolds a pre-repair cache row through the real projection registry', async () => {
    const harness = await bootService({ enabled: true })
    const { repairPending: _repairPending, ...legacy } = emptyDevLeadProjectionState()
    const restored = harness.ctx.sessionProjections.restore(
      { devLead: { ver: 5, seq: -1, val: legacy } } as never,
      harness.leadSession.snapshotEvents(),
      SessionLogOffset(0),
      harness.leadSession.header,
      SessionLogOffset(0),
    )
    expect(restored.checkpoint.devLead).toMatchObject({
      ver: 7,
      val: { enabled: true, repairPending: [] },
    })

    const child = emptyDevLeadChildAnswersState()
    const childRestored = harness.ctx.sessionProjections.restore(
      { devLeadChildAnswers: { ver: 1, seq: -1, val: { ...child, complete: true } } } as never,
      harness.leadSession.snapshotEvents(),
      SessionLogOffset(0),
      harness.leadSession.header,
      SessionLogOffset(0),
    )
    expect(childRestored.checkpoint.devLeadChildAnswers).toMatchObject({
      ver: 2,
      val: { overflow: { claimed: false, cancelCandidates: false, presented: false, discards: false } },
    })
  })
})

describe('cold supervision cursor and retry behavior', () => {
  it('resumes beyond 64 benign rows and mixed missing/legacy cache rows', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    const ids: string[] = []
    for (let index = 0; index < 70; index += 1) {
      const id = `benign-${index}`
      ids.push(id)
      query.seed(id, [])
      if (index < 35) cache.setDevLead(id, { enabled: false, sessions: [] })
    }
    persistence.ids = ids
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await new Promise(resolve => setTimeout(resolve, 900))
    await nextTask()
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'allowed after paginated scan')
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
    expect(query.readSessionCalls).toBeLessThanOrEqual(70)
  })

  it('recovers a no-cache corpus without a hot retry loop', async () => {
    const query = new FakeSessionQuery()
    const persistence = new FakeSessionPersistence()
    const ids: string[] = []
    for (let index = 0; index < 70; index += 1) {
      const id = `uncached-${index}`
      ids.push(id)
      query.seed(id, [])
    }
    persistence.ids = ids
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await new Promise(resolve => setTimeout(resolve, 900))
    await nextTask()
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'allowed after uncached scan')
    expect(receipt.sessionId).toBe('target')
    expect(query.listSessionsCalls).toBeLessThanOrEqual(3)
    expect(query.readSessionCalls).toBeLessThanOrEqual(70)
  })

  it('bounds failed retries and recovers after the cause clears', async () => {
    const query = new FakeSessionQuery()
    query.seed('transient', [])
    query.readError = new Error('temporary read failure')
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['transient']
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(query.listSessionsCalls).toBeLessThanOrEqual(4)
    expect(query.readSessionCalls).toBeLessThanOrEqual(4)
    query.readError = undefined
    await new Promise(resolve => setTimeout(resolve, 650))
    await nextTask()
    const receipt = await eventually(() => harness.service.promptSession(harness.lead.agent, 'target', 'recovered'))
    expect(receipt.sessionId).toBe('target')
  })

  it('does not finalize when applying the rehydrated index fails', async () => {
    const spy = vi.spyOn(DevLeadNotificationHub.prototype, 'rehydrate').mockImplementation(() => {
      throw new Error('apply failed')
    })
    try {
      const harness = await bootService({
        leadId: 'apply-failure-lead',
        enabled: true,
        sessionIds: ['target'],
        watched: ['target'],
        registerLeadAgent: false,
      })
      harness.agents.add(harness.lead)
      const target = new FakeAgent(harness.sessions['target']!)
      harness.agents.add(target)
      await expectCode(
        () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver'),
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('fails closed when a live attached DevLead projection is corrupt', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_MODE_RECORD_TYPE, {
          kind: 'devlead/mode', version: 2, enabled: 'yes', at: T0,
        } as never)
      },
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    expect((harness.service as unknown as { supervisionIndexComplete: boolean }).supervisionIndexComplete).toBe(false)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_NOT_ENABLED',
    )
    expect(target.followups).toHaveLength(0)
  })

  it('retains query lifecycle retries when persistence arrives before sessionQuery', async () => {
    const persistence = new FakeSessionPersistence()
    persistence.ids = []
    const harness = await bootService({ enabled: true, sessionIds: ['target'], sessionPersistence: persistence })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    await new Promise(resolve => setTimeout(resolve, 300))
    await nextTask()
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'query arrived')
    expect(receipt.sessionId).toBe('target')
  })
})

describe('cold cursor sticky corruption and retry bounds', () => {
  it('keeps a corrupt first batch closed after later benign batches', async () => {
    const query = new FakeSessionQuery()
    query.seed('corrupt', [{
      type: 'plugin:devlead/mode', seq: 0, time: T0, ignorable: true,
      data: { kind: 'devlead/mode', version: 2, enabled: 'yes', at: T0 },
    } as never])
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    const ids = ['corrupt']
    for (let index = 0; index < 64; index += 1) {
      const id = `benign-${index}`
      ids.push(id)
      query.seed(id, [])
    }
    persistence.ids = ids
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const service = harness.service as unknown as {
      persistedLeadRecords(): Promise<{ complete: boolean }>
    }
    const first = await service.persistedLeadRecords()
    expect(first.complete).toBe(false)
    const second = await service.persistedLeadRecords()
    expect(second.complete).toBe(false)
    const calls = query.readSessionCalls
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(query.readSessionCalls).toBe(calls)
    query.delete('corrupt')
    persistence.ids = persistence.ids.filter(id => id !== 'corrupt')
    await harness.service.reset(harness.lead.agent)
    await harness.service.setEnabled(harness.lead.agent, true)
    harness.agents.add(new FakeAgent(harness.sessions['target']!))
    const recovered = await eventually(() => harness.service.promptSession(harness.lead.agent, 'target', 'reset recovered'))
    expect(recovered.sessionId).toBe('target')
  })

  it('does not consume the failure cap while paginating a large corpus', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    const ids: string[] = []
    for (let index = 0; index < 770; index += 1) {
      const id = `large-${index}`
      ids.push(id)
      query.seed(id, [])
    }
    persistence.ids = ids
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const service = harness.service as unknown as {
      persistedLeadRecords(): Promise<{ complete: boolean }>
    }
    let result = { complete: false }
    for (let index = 0; index < 13; index += 1) {
      result = await service.persistedLeadRecords()
      if (result.complete) break
    }
    expect(result.complete).toBe(true)
    expect(query.readSessionCalls).toBeLessThanOrEqual(770)
  })

  it('does not start a timer when no corpus service exists', async () => {
    const harness = await bootService()
    await new Promise(resolve => setTimeout(resolve, 350))
    expect((harness.service as unknown as { rehydrationRetryTimer: unknown }).rehydrationRetryTimer).toBeUndefined()
  })

  it('recomputes live-only authorization immediately after reset without a corpus', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await harness.service.reset(harness.lead.agent)
    await harness.service.setEnabled(harness.lead.agent, true)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'reset without corpus')
    expect(receipt.sessionId).toBe('target')
  })
})

describe('cold supervisor trust, epoch and degraded recovery', () => {
  it('re-lists after corpus readiness instead of trusting a pre-ready partial snapshot', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    // The foreign supervisor is a legitimate cold lead; the pre-ready listing
    // silently omits it (the real query engine merges only live Sessions until
    // its optional persistence binding is installed).
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    cache.setDevLead('foreign-lead', { enabled: true, sessions: ['target'] })
    const ids = ['foreign-lead']
    for (let index = 0; index < 10; index += 1) {
      const id = `ordinary-${index}`
      ids.push(id)
      query.seed(id, [])
    }
    persistence.ids = ids
    const originalList = query.listSessions.bind(query)
    let corpusWarm = false
    query.listSessions = async () => {
      const rows = await originalList()
      return corpusWarm ? rows : rows.filter(row => String(row.header.id) !== 'foreign-lead')
    }
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    // The bounded readiness barrier gave up, so the boot scan must not finalize
    // the warmup listing: prompting stays fail-closed.
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    const listingsBefore = query.listSessionsCalls
    corpusWarm = true
    // The next attempt re-lists from scratch once the corpus is ready and only
    // then discovers the foreign supervisor.
    await eventuallyCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'still must not deliver', { watch: false }),
      'DEVLEAD_FOREIGN_SUPERVISOR',
    )
    expect(query.listSessionsCalls).toBeGreaterThan(listingsBefore)
    expect(query.readSessionCalls).toBeGreaterThan(0)
    expect(target.followups).toHaveLength(0)
  }, 15_000)

  it('rejects immediately when corpus services arrive before the retry timer runs', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    cache.setDevLead('foreign-lead', { enabled: true, sessions: ['target'] })
    persistence.ids = ['foreign-lead']
    const harness = await bootService({ enabled: true, sessionIds: ['target'] })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    harness.ctx.provide('sessionPersistence', persistence)
    // No await, no timer advancement: the optional-service hook itself must
    // revoke the stale live-only authorization synchronously.
    const error = await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(error.message).toContain('no prompt was delivered')
    expect(query.readSessionCalls).toBe(0)
    expect(target.followups).toHaveLength(0)
    await eventuallyCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_FOREIGN_SUPERVISOR',
    )
    expect(target.followups).toHaveLength(0)
  })

  it('keeps terminal corruption across lifecycle events without resetting the retry budget', async () => {
    const query = new FakeSessionQuery()
    query.seed('corrupt', [{
      type: 'plugin:devlead/mode', seq: 0, time: T0, ignorable: true,
      data: { kind: 'devlead/mode', version: 2, enabled: 'yes', at: T0 },
    } as never])
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['corrupt']
    // Persistence arrives before the query engine: the lifecycle wake listeners
    // are armed and must be rebuilt, not left stale, when the query engine lands.
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionPersistence: persistence,
    })
    const service = harness.service as unknown as {
      coldScan?: { corrupt: boolean; liveFailure: boolean; complete: boolean }
      rehydrationRetryAttempts: number
      rehydrationRetryDelayMs: number
      rehydrationRetryTimer: unknown
      rehydrationLifecycle?: { queryReady: boolean }
    }
    expect(service.rehydrationLifecycle?.queryReady).toBe(false)
    harness.ctx.provide('sessionQuery', query.asService())
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    await waitFor(() => service.coldScan?.corrupt === true, 'terminal corruption')
    expect(service.rehydrationLifecycle?.queryReady).toBe(true)
    expect(service.coldScan?.complete).toBe(false)
    expect(service.rehydrationRetryTimer).toBeDefined()
    const state = service.coldScan
    const attempts = service.rehydrationRetryAttempts
    const delay = service.rehydrationRetryDelayMs
    const reads = query.readSessionCalls
    for (let index = 0; index < 4; index += 1) {
      harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    }
    await sleep(300)
    // The terminal state, its retained cursor and the retry budget survive
    // ordinary Session traffic; only reset or a service recomposition clears it.
    expect(service.coldScan).toBe(state)
    expect(service.coldScan?.corrupt).toBe(true)
    expect(service.rehydrationRetryAttempts).toBe(attempts)
    expect(service.rehydrationRetryDelayMs).toBe(delay)
    expect(query.readSessionCalls).toBe(reads)
  })

  it('keeps a live projection failure terminal and recovers via the production slow probe', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const query = new FakeSessionQuery()
      for (let index = 0; index < 8; index += 1) query.seed(`ordinary-${index}`, [])
      const cache = new FakeProjectionCache()
      const persistence = new FakeSessionPersistence()
      persistence.ids = Array.from({ length: 8 }, (_, index) => `ordinary-${index}`)
      const harness = await bootUnderFakeTimers({
        enabled: true,
        sessionIds: ['target'],
        sessionQuery: query,
        projectionCache: cache,
        sessionPersistence: persistence,
        // An attach-only Session (no Agent) with a corrupt DevLead replay: the
        // live-attach fallback cannot prove the supervisor set.
        beforeServicePlugin: (ctx) => {
          const broken = ctx.sessions.create(SessionId('broken-attach'))
          appendPluginRecord(broken, DEVLEAD_MODE_RECORD_TYPE, {
            kind: 'devlead/mode', version: 2, enabled: 'yes', at: T0,
          } as never)
        },
      })
      const target = new FakeAgent(harness.sessions['target']!)
      harness.agents.add(target)
      const service = harness.service as unknown as {
        coldScan?: { liveFailure: boolean; complete: boolean }
        supervisionIndexComplete: boolean
        rehydrationRetryProbe: boolean
      }
      expect(service.supervisionIndexComplete).toBe(false)
      expect(service.coldScan?.liveFailure).toBe(true)
      expect(service.coldScan?.complete).toBe(false)
      await expectCode(
        () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
      // The scan's own end armed exactly one slow probe; no manual timer staging.
      expect(service.rehydrationRetryProbe).toBe(true)
      const reads = query.readSessionCalls
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks(128)
      // A live projection failure must not turn into an endless full rescan: the
      // single slow probe owns recovery.
      expect(query.readSessionCalls).toBe(reads)
      // Repair the corrupt Session (the human `/devlead reset` equivalent); the
      // production probe re-lists and rescans once the cause is gone.
      const broken = harness.ctx.sessions.get(SessionId('broken-attach'))!
      appendPluginRecord(broken, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0 + 1))
      await advanceUntil(() => service.supervisionIndexComplete, 'live-failure probe recovery', 500, 80)
      const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'recovered after live-failure probe')
      expect(receipt.sessionId).toBe('target')
      expect(target.followups).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('keeps the retry-cap probe sticky instead of restarting the fast backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const query = new FakeSessionQuery()
      query.seed('transient', [])
      query.readError = new Error('persistent read failure')
      const cache = new FakeProjectionCache()
      const persistence = new FakeSessionPersistence()
      persistence.ids = ['transient']
      const harness = await bootUnderFakeTimers({
        enabled: true,
        sessionIds: ['target'],
        sessionQuery: query,
        projectionCache: cache,
        sessionPersistence: persistence,
      })
      const target = new FakeAgent(harness.sessions['target']!)
      harness.agents.add(target)
      const service = harness.service as unknown as {
        supervisionIndexComplete: boolean
        rehydrationRetryAttempts: number
        rehydrationRetryCapped: boolean
        rehydrationRetryProbe: boolean
      }
      await expectCode(
        () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
      const warn = vi.spyOn(harness.ctx.logger, 'warn')
      // Stage the last bounded attempt; the production timer walks into the cap
      // and the scan's own end arms the single slow probe.
      service.rehydrationRetryAttempts = 11
      await advanceUntil(() => service.rehydrationRetryProbe, 'retry-cap probe', 50, 120)
      expect(service.rehydrationRetryCapped).toBe(true)
      const capMessages = warn.mock.calls
        .map(call => String(call[0]))
        .filter(text => text.includes('slow 30s recovery probe'))
      expect(capMessages).toHaveLength(1)
      expect(capMessages[0]).toContain('Open (resume)')
      expect(capMessages[0]).toContain('/devlead reset there')
      // Fire the probe while the cause is still present: it must re-arm the one
      // slow probe, never restart the 12-attempt fast backoff.
      await vi.advanceTimersByTimeAsync(30_000)
      await advanceUntil(() => service.rehydrationRetryAttempts >= 13, 'probe failure counted', 50, 60)
      await advanceUntil(() => service.rehydrationRetryProbe, 'second slow probe', 50, 20)
      expect(service.rehydrationRetryCapped).toBe(true)
      expect(service.rehydrationRetryAttempts).toBeGreaterThanOrEqual(13)
      const listsAfterProbe = query.listSessionsCalls
      await vi.advanceTimersByTimeAsync(10_000)
      await flushMicrotasks(256)
      // A sticky cap means no fast retry may fire inside the next probe window.
      expect(query.listSessionsCalls).toBe(listsAfterProbe)
      expect(service.rehydrationRetryProbe).toBe(true)
      // Only one cap warning: the re-armed probe reuses the deduped reason.
      expect(warn.mock.calls.map(call => String(call[0])).filter(text => text.includes('slow 30s recovery probe'))).toHaveLength(1)
      // Remove the cause; the next slow probe recovers the index.
      query.readError = undefined
      await advanceUntil(() => service.supervisionIndexComplete, 'sticky probe recovery', 500, 120)
      const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'recovered after sticky probe')
      expect(receipt.sessionId).toBe('target')
      expect(target.followups).toHaveLength(1)
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('refreshes a vanished Session listing inside the attempt without a retry cycle', async () => {
    const query = new FakeSessionQuery()
    query.seed('deleted', [])
    query.seed('stable', [])
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['deleted', 'stable']
    const originalRead = query.readSession.bind(query)
    let vanished = true
    const seen: string[] = []
    query.readSession = async (sessionId) => {
      seen.push(String(sessionId))
      if (String(sessionId) === 'deleted' && vanished) {
        vanished = false
        throw new Error('Session deleted does not exist')
      }
      return await originalRead(sessionId)
    }
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    // Boot completed inside the same attempt: one readiness listing, one scan
    // listing, one re-list after the vanished Session, then the exact folds.
    expect(query.listSessionsCalls).toBe(3)
    // The failed read does not increment the fake's successful-read counter, so
    // the exact sequence proves the re-list: failed read, then the fresh reads.
    expect(seen).toEqual(['deleted', 'deleted', 'stable'])
    expect(query.readSessionCalls).toBe(2)
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'listing refreshed')
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
  })

  it('rejects when the persisted scan application fails after a complete scan', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    query.seed('cold-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    cache.setDevLead('cold-lead', { enabled: true, sessions: ['target'] })
    persistence.ids = ['cold-lead']
    const originalRehydrate = DevLeadNotificationHub.prototype.rehydrate
    const applied: Array<readonly DevLeadPersistedLead[]> = []
    const spy = vi.spyOn(DevLeadNotificationHub.prototype, 'rehydrate').mockImplementation(function (
      this: DevLeadNotificationHub,
      leads: readonly DevLeadPersistedLead[],
    ) {
      applied.push([...leads])
      // The first call applies the live-attach fallback; the second is the
      // persisted scan application and must fail closed.
      if (applied.length === 2) throw new Error('persisted apply failed')
      return originalRehydrate.call(this, leads)
    })
    try {
      const harness = await bootService({
        enabled: true,
        sessionIds: ['target'],
        sessionQuery: query,
        projectionCache: cache,
        sessionPersistence: persistence,
      })
      const target = new FakeAgent(harness.sessions['target']!)
      harness.agents.add(target)
      await expectCode(
        () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
        'DEVLEAD_SESSION_UNAVAILABLE',
      )
      // Discrimination: the failure really belongs to the persisted scan
      // application, not to the live-attach fallback.
      expect(applied.length).toBeGreaterThanOrEqual(2)
      expect(applied[1]?.map(lead => lead.sessionId)).toEqual(['cold-lead'])
      expect(query.readSessionCalls).toBeGreaterThan(0)
      expect(target.followups).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('ignores an in-flight pre-reset scan and rescans after it settles', async () => {
    const query = new FakeSessionQuery()
    query.seed('ordinary', [])
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['ordinary']
    query.readError = new Error('transient read failure at boot')
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    // The boot scan failed; the armed retry is the next in-flight candidate.
    query.readError = undefined
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let startedFirst!: () => void
    const firstReadStarted = new Promise<void>((resolve) => { startedFirst = resolve })
    let releaseSecond!: () => void
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    let startedSecond!: () => void
    const secondReadStarted = new Promise<void>((resolve) => { startedSecond = resolve })
    const originalRead = query.readSession.bind(query)
    let reads = 0
    query.readSession = async (sessionId) => {
      reads += 1
      if (reads === 1) {
        startedFirst()
        await firstGate
      } else if (reads === 2) {
        startedSecond()
        await secondGate
      }
      return await originalRead(sessionId)
    }
    const service = harness.service as unknown as { supervisionIndexComplete: boolean }
    await firstReadStarted
    // Reset while the retry scan is blocked mid-read.
    await harness.service.reset(harness.lead.agent)
    // The reset discards the lead's mode; restore it with the same durable
    // record `/devlead on` appends, without the corpus scan of setEnabled().
    appendPluginRecord(harness.leadSession, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))
    releaseFirst()
    await Promise.race([secondReadStarted, sleep(1_500)])
    // The pre-reset run may not finalize or re-arm its stale cursor: prompting
    // stays fail-closed until the post-reset scan completes.
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    releaseSecond()
    await waitFor(() => service.supervisionIndexComplete, 'post-reset rehydration')
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'allowed after reset settle')
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
  })

  it('does not count live-only early returns against the retry budget', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const service = harness.service as unknown as {
      rehydrationRetryAttempts: number
      rehydrationRetryTimer: unknown
    }
    expect(service.rehydrationRetryAttempts).toBe(0)
    await sleep(350)
    expect(service.rehydrationRetryAttempts).toBe(0)
    expect(service.rehydrationRetryTimer).toBeUndefined()
    // Persistence-before-query likewise waits without consuming the budget.
    harness.ctx.provide('sessionPersistence', new FakeSessionPersistence())
    await sleep(200)
    expect(service.rehydrationRetryAttempts).toBe(0)
    expect(service.rehydrationRetryTimer).toBeUndefined()
  })
})

describe('cold supervision authorization binding and bounded attempts', () => {
  it('refuses delivery when the listing authorized by the barrier changes before finalize', async () => {
    const query = new FakeSessionQuery()
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    for (let index = 0; index < 5; index += 1) query.seed(`ordinary-${index}`, [])
    const cache = new FakeProjectionCache()
    cache.setDevLead('foreign-lead', { enabled: true, sessions: ['target'] })
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['foreign-lead', ...Array.from({ length: 5 }, (_, index) => `ordinary-${index}`)]
    const originalList = query.listSessions.bind(query)
    let listings = 0
    query.listSessions = async () => {
      listings += 1
      const rows = await originalList()
      // The barrier's first listing is the complete authoritative corpus; every
      // later listing silently omits a legitimate foreign supervisor, exactly
      // like a corpus whose persistence binding was lost/replaced mid-scan.
      return listings === 1 ? rows : rows.filter(row => String(row.header.id) !== 'foreign-lead')
    }
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    const service = harness.service as unknown as {
      rehydrated: boolean
      supervisionIndexComplete: boolean
      rehydrationListingSeq: number
    }
    // The finalize recheck sees the corpus changed: no stale snapshot may
    // authorize the prompt and no prompt may be delivered.
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    expect(service.rehydrated).toBe(false)
    // The barrier's complete listing was rejected by the finalize recheck when
    // the corpus changed; a second, partial listing was observed.
    expect(listings).toBeGreaterThanOrEqual(2)
    // A later retry also cannot obtain a complete validated listing: still closed.
    await sleep(400)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'still must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
  }, 15_000)

  it('does not trust a scan re-list that omits a stored foreign supervisor', async () => {
    const query = new FakeSessionQuery()
    query.seed('deleted', [])
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['deleted', 'foreign-lead']
    const originalRead = query.readSession.bind(query)
    const originalList = query.listSessions.bind(query)
    let notFoundOnce = true
    let omitForeign = true
    query.readSession = async (sessionId) => {
      if (String(sessionId) === 'deleted' && notFoundOnce) {
        notFoundOnce = false
        throw new Error('persisted Session deleted does not exist')
      }
      return await originalRead(sessionId)
    }
    query.listSessions = async () => {
      const rows = await originalList()
      // The not-found refresh returns a listing that silently omits a stored
      // foreign supervisor; that re-list must not be trusted as authorization.
      return omitForeign ? rows.filter(row => String(row.header.id) !== 'foreign-lead') : rows
    }
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    // Stop lying: the next bounded attempt gets a complete validated listing and
    // discovers the stored foreign supervisor instead of delivering.
    omitForeign = false
    await eventuallyCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'still must not deliver', { watch: false }),
      'DEVLEAD_FOREIGN_SUPERVISOR',
    )
    expect(target.followups).toHaveLength(0)
  }, 15_000)

  it('counts a repeated not-found as a read failure instead of forgiving the budget every round', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const query = new FakeSessionQuery()
      query.seed('ghost', [])
      const originalRead = query.readSession.bind(query)
      query.readSession = async () => { throw new Error('persisted Session ghost does not exist') }
      const cache = new FakeProjectionCache()
      const persistence = new FakeSessionPersistence()
      persistence.ids = ['ghost']
      const harness = await bootUnderFakeTimers({
        enabled: true,
        sessionIds: ['target'],
        sessionQuery: query,
        projectionCache: cache,
        sessionPersistence: persistence,
      })
      const service = harness.service as unknown as {
        rehydrated: boolean
        supervisionIndexComplete: boolean
        rehydrationRetryAttempts: number
        rehydrationRetryCapped: boolean
        rehydrationRetryProbe: boolean
      }
      expect(service.supervisionIndexComplete).toBe(false)
      // The first attempt already failed; the re-list still lists the id, so it
      // is a read failure that consumes the bounded budget.
      expect(service.rehydrationRetryAttempts).toBeGreaterThanOrEqual(1)
      const listsAfterFirst = query.listSessionsCalls
      await advanceUntil(() => service.rehydrationRetryAttempts >= 2, 'second bounded retry', 50, 200)
      expect(query.listSessionsCalls).toBeLessThanOrEqual(listsAfterFirst + 6)
      const warn = vi.spyOn(harness.ctx.logger, 'warn')
      // The production path walks the remaining bounded retries and the scan's
      // own end arms exactly one slow probe at the cap.
      await advanceUntil(() => service.rehydrationRetryProbe, 'retry-cap probe', 500, 200)
      expect(service.rehydrationRetryCapped).toBe(true)
      const capMessages = warn.mock.calls
        .map(call => String(call[0]))
        .filter(text => text.includes('slow 30s recovery probe'))
      expect(capMessages).toHaveLength(1)
      expect(capMessages[0]).toContain('Open (resume)')
      // Remove the cause; the probe recovers the index.
      query.readSession = originalRead
      await advanceUntil(
        () => service.rehydrated === true && service.supervisionIndexComplete,
        'probe recovery after repeated not-found',
        500,
        200,
      )
      const target = new FakeAgent(harness.sessions['target']!)
      harness.agents.add(target)
      const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'recovered after repeated not-found')
      expect(receipt.sessionId).toBe('target')
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('abandons a scan attempt whose backend never settles and recovers on a later attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const query = new FakeSessionQuery()
      query.seed('cold-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
      const originalRead = query.readSession.bind(query)
      let hang = true
      query.readSession = async (sessionId) => {
        if (hang) return await new Promise<never>(() => {})
        return await originalRead(sessionId)
      }
      const cache = new FakeProjectionCache()
      const persistence = new FakeSessionPersistence()
      persistence.ids = ['cold-lead']
      const started = Date.now()
      const harness = await bootUnderFakeTimers({
        enabled: true,
        sessionIds: ['target'],
        sessionQuery: query,
        projectionCache: cache,
        sessionPersistence: persistence,
      })
      // The attempt deadline abandoned the hung backend instead of hanging
      // [Service.init]; the whole attempt is bounded well under the 60s
      // advanced-time budget above (it takes the 5s attempt deadline).
      expect(Date.now() - started).toBeLessThan(1_000)
      const service = harness.service as unknown as {
        supervisionIndexComplete: boolean
        rehydrated: boolean
        rehydrationRetryAttempts: number
      }
      expect(service.supervisionIndexComplete).toBe(false)
      expect(service.rehydrated).toBe(false)
      expect(service.rehydrationRetryAttempts).toBeGreaterThanOrEqual(1)
      // Repair the backend: the next bounded attempt succeeds.
      hang = false
      await advanceUntil(
        () => service.rehydrated === true && service.supervisionIndexComplete,
        'next attempt after abandoned scan',
        100,
        200,
      )
      const target = new FakeAgent(harness.sessions['target']!)
      harness.agents.add(target)
      // The recovered scan discovered the stored foreign supervisor.
      await expectCode(
        () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
        'DEVLEAD_FOREIGN_SUPERVISOR',
      )
      expect(target.followups).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('invalidates the proven index when a corpus service is replaced in place', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    persistence.ids = []
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await waitFor(() => (harness.service as unknown as { rehydrated: boolean }).rehydrated, 'initial finalize')
    // A legitimate foreign supervisor appears and the persistence binding is
    // replaced in place (no fiber unload, so no inject callback fires).
    query.seed('foreign-lead', [modeEvent(0, true), watchEvent(1, ['target'])])
    const replacement = new FakeSessionPersistence()
    replacement.ids = ['foreign-lead']
    harness.ctx.set('sessionPersistence', replacement as never)
    // The old proof was bound to the old service instance: fail closed now.
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    // The invalidated index is re-proven against the new binding and finds the
    // foreign supervisor instead of delivering.
    await eventuallyCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'still must not deliver', { watch: false }),
      'DEVLEAD_FOREIGN_SUPERVISOR',
    )
    expect(target.followups).toHaveLength(0)
  }, 15_000)

  it('stays fail-closed when the corpus binding is removed after a proof', async () => {
    const query = new FakeSessionQuery()
    const cache = new FakeProjectionCache()
    const persistence = new FakeSessionPersistence()
    persistence.ids = []
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      projectionCache: cache,
      sessionPersistence: persistence,
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    await waitFor(() => (harness.service as unknown as { rehydrated: boolean }).rehydrated, 'initial finalize')
    harness.ctx.set('sessionPersistence', undefined)
    // A proven corpus must not degrade back to live-only authorization: the
    // removed binding could hide a foreign cold supervisor.
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    await sleep(300)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'still must not deliver', { watch: false }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
    expect(target.followups).toHaveLength(0)
    // Restoring the binding plus a lifecycle wake re-proves the corpus.
    harness.ctx.set('sessionPersistence', persistence as never)
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    await waitFor(
      () => (harness.service as unknown as { rehydrated: boolean }).rehydrated,
      're-proof after binding restore',
    )
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'allowed after re-proof')
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
  }, 15_000)

  it('warns about a read failure instead of the read-cap when a candidate cannot be read', async () => {
    const query = new FakeSessionQuery()
    for (const id of ['row-a', 'row-b', 'row-c']) query.seed(id, [])
    query.readError = new Error('storage unavailable')
    const persistence = new FakeSessionPersistence()
    persistence.ids = ['row-a', 'row-b', 'row-c']
    const warnings: string[] = []
    await bootService({
      enabled: true,
      sessionIds: ['target'],
      sessionQuery: query,
      sessionPersistence: persistence,
      beforeServicePlugin: (ctx) => {
        vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
          warnings.push(String(args[0]))
        })
      },
    })
    expect(warnings.some(text => text.includes('could not read a cold lead candidate'))).toBe(true)
    expect(warnings.some(text => text.includes('stopped reading unclassified Session logs after'))).toBe(false)
  })
})

describe('answer projection liveness under message volume', () => {
  it('does not lock repair state after more than 256 ordinary user messages', async () => {
    const leadId = 'ordinary-overflow-lead'
    const value = question(leadId)
    const harness = await bootService({
      leadId,
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(value))
      },
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    for (let index = 0; index < 257; index += 1) {
      const message = queuedMessage(`ordinary-${String(index)}`, { kind: 'user' }, `ordinary ${index}`)
      target.session.append('user/message', { ...message, turn: 1, step: 1 } as never, { surfaceOp: 'append' })
    }
    const service = harness.service as unknown as {
      queueAnswerDiscard(discard: ReturnType<typeof answer>): void
      reconcileAnswerDiscards(lead: string): Promise<void>
      survivalProof(discard: ReturnType<typeof answer>, cache: Map<string, unknown>): Promise<unknown>
    }
    const stale = answer({ reportId: value.id, leadSessionId: leadId, sessionId: 'target', messageId: 'ordinary-discard', status: 'discarded' })
    service.queueAnswerDiscard(stale)
    const proof = vi.spyOn(service, 'survivalProof')
    await service.reconcileAnswerDiscards(leadId)
    expect(proof).toHaveBeenCalled()
    expect(harness.service.questionAnswerView(harness.lead.agent, value.id)?.repairPending).toBeUndefined()
    const retry = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId: value.id })
    expect(retry.sessionId).toBe('target')
  })

  it('scopes answer-related overflow to the affected message instead of a global latch', async () => {
    const leadId = 'answer-overflow-lead'
    const first = question(leadId, T0, 'First question?')
    const second = question(leadId, T0, 'Second question?')
    const harness = await bootService({
      leadId,
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      seedSessions: (sessions) => {
        const target = sessions['target']!
        for (let index = 0; index < 257; index += 1) {
          const message = queuedMessage(`answer-presented-${String(index)}`, {
            kind: 'devlead', questionId: first.id, senderSessionId: leadId,
          }, 'answer presented')
          target.append('user/message', { ...message, turn: 1, step: 1 } as never, { surfaceOp: 'append' })
        }
      },
      seedLead: (session) => {
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(first))
        appendPluginRecord(session, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(second))
      },
    })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    const service = harness.service as unknown as {
      queueAnswerDiscard(discard: ReturnType<typeof answer>): void
      reconcileAnswerDiscards(lead: string): Promise<void>
      survivalProof(discard: ReturnType<typeof answer>, cache: Map<string, unknown>): Promise<unknown>
    }
    const stale = answer({ reportId: second.id, leadSessionId: leadId, sessionId: 'target', messageId: 'overflow-discard', status: 'discarded' })
    service.queueAnswerDiscard(stale)
    const proof = vi.spyOn(service, 'survivalProof')
    await service.reconcileAnswerDiscards(leadId)
    expect(proof).toHaveBeenCalled()
    expect(harness.service.questionAnswerView(harness.lead.agent, second.id)?.repairPending).toBe(true)
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'use prod', { intent: 'answer', questionId: second.id }),
      'DEVLEAD_SESSION_UNAVAILABLE',
    )
  })

  it('caps concurrent cold answer-projection reads at 64 without growing the pending map', async () => {
    const query = new FakeSessionQuery()
    let release!: () => void
    query.observeGate = new Promise<void>((resolve) => { release = resolve })
    const harness = await bootService({ sessionQuery: query })
    const service = harness.service as unknown as {
      childAnswerState(childId: string): Promise<unknown>
      childAnswerReads: Map<string, Promise<unknown>>
    }
    const calls = Array.from({ length: 65 }, (_, index) => service.childAnswerState(`cold-${index}`))
    await flushMicrotasks()
    expect(query.observeSessionCalls).toBe(64)
    expect(service.childAnswerReads.size).toBe(64)
    await expect(calls.at(-1)).resolves.toBeUndefined()
    release()
    await Promise.all(calls)
    await flushMicrotasks()
    expect(service.childAnswerReads.size).toBe(0)
  })
})

describe('native question gate production wiring', () => {
  it('uses the real DevLead projection reader and never the deprecated Session reader', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    const projectionHandle = (harness.service as unknown as {
      turnSourceHandle: { stateOf(session: unknown): unknown }
    }).turnSourceHandle
    const projectionSpy = vi.spyOn(projectionHandle, 'stateOf')
    let gate: ((exec: unknown, next: () => unknown) => Promise<unknown>) | undefined
    const originalOn = harness.ctx.on.bind(harness.ctx)
    const onSpy = vi.spyOn(harness.ctx, 'on').mockImplementation(((name: string, listener: unknown) => {
      if (name === 'tools/pre-execute') gate = listener as typeof gate
      return originalOn(name as never, listener as never)
    }) as typeof harness.ctx.on)
    registerQuestionRouting(harness.ctx, harness.service)
    onSpy.mockRestore()
    expect(gate).toBeDefined()
    appendTurnStart(target.session, 1)
    const human = queuedMessage('human-turn', { kind: 'user' }, 'human question')
    target.session.append('user/message', { ...human, turn: 1, step: 1 } as never, { surfaceOp: 'append' })
    const exec = {
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [{ id: 'q', question: 'Continue?' }] },
      agent: target.agent,
      signal: new AbortController().signal,
    }
    let nextCalls = 0
    await gate!(exec, () => { nextCalls += 1; return { kind: 'allow' } })
    expect(nextCalls).toBe(1)

    const relay = queuedMessage('lead-turn', { kind: 'devlead', form: 'relay', senderSessionId: String(harness.lead.id) }, 'lead instruction')
    target.session.append('user/message', { ...relay, turn: 1, step: 1 } as never, { surfaceOp: 'append' })
    const decision = await gate!(exec, () => { nextCalls += 1; return { kind: 'allow' } })
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(nextCalls).toBe(1)
    // The production gate must reach DevLeadService's registered projection,
    // not the tool fake's snapshotEvents helper.
    expect(projectionSpy).toHaveBeenCalledWith(target.session)
  })
})
