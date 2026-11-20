import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendPluginRecord, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_REPORT_ANSWER_RECORD_TYPE,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import { DevLeadError } from '../src/error.ts'
import { devLeadReport, modeRecord, reportAnswerRecord, reportRecord, watchRecord } from '../src/domain.ts'
import { devLeadPromptIdempotencyKey, PROMPT_IDEMPOTENCY_SPEC } from '../src/idempotency.ts'
import { devLeadAnswerDiscardKey } from '../src/outbox.ts'
import { emptyDevLeadProjectionState } from '../src/fold.ts'
import { ASK_USER_QUESTION_TOOL, registerQuestionRouting } from '../../tool/src/question-routing.ts'
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
} from './harness.ts'
import { answer, modeEvent, watchEvent } from './fixtures.ts'

afterEach(async () => { await disposeHarnesses() })

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
      'DEVLEAD_SESSION_UNAVAILABLE',
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
    const cache = new FakeProjectionCache()
    harness.ctx.provide('sessionProjectionCache', cache.asService())
    await new Promise(resolve => setTimeout(resolve, 300))
    await nextTask()
    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'allowed after recovery')
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
    await new Promise(resolve => setTimeout(resolve, 700))
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
      { devLead: { ver: 6, seq: -1, val: legacy } } as never,
      harness.leadSession.snapshotEvents(),
      SessionLogOffset(0),
      harness.leadSession.header,
      SessionLogOffset(0),
    )
    expect(restored.checkpoint.devLead).toMatchObject({
      ver: 7,
      val: { enabled: true, repairPending: [] },
    })
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
    const admitted = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId: value.id })
    const pending = target.inbox.nextStep.find(message => String(message.id) === admitted.delivery.messageId)
    if (pending === undefined) throw new Error('expected pending answer')
    target.inbox.remove(admitted.delivery.messageId)
    target.session.append('agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    })
    harness.ctx.emit('agent/inbox/discarded', { agent: target.agent, message: pending })
    await flushMicrotasks()
    expect(harness.service.questionAnswerView(harness.lead.agent, value.id)?.repairPending).toBeUndefined()
    const retry = await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', { intent: 'answer', questionId: value.id })
    expect(retry.delivery.messageId).not.toBe(admitted.delivery.messageId)
  })

  it('scopes answer-related overflow to the affected message instead of a global latch', async () => {
    const leadId = 'answer-overflow-lead'
    const first = question(leadId, T0, 'First question?')
    const second = question(leadId, T0, 'Second question?')
    const storage = new FakeStorageDomain()
    const seeded = await storage.open({ name: 'devlead_report_outbox', tables: { answer_discards: {} } })
    const stale = answer({
      reportId: second.id,
      leadSessionId: leadId,
      sessionId: 'target',
      messageId: 'overflow-discard',
      status: 'discarded',
      at: T0 + 1,
    })
    storage.table('devlead_report_outbox', 'answer_discards').records.set(
      devLeadAnswerDiscardKey(stale),
      { answer: stale, enqueuedAt: Date.now() },
    )
    await seeded.close()
    const harness = await bootService({
      leadId,
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      storageDomain: storage,
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
    await flushMicrotasks()
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
