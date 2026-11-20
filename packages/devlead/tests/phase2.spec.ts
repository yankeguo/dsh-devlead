import { afterEach, describe, expect, it } from 'vitest'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_REPORT_ANSWER_RECORD_TYPE,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import { DevLeadError } from '../src/error.ts'
import { devLeadReport, modeRecord, reportAnswerRecord, reportRecord, watchRecord } from '../src/domain.ts'
import { devLeadPromptIdempotencyKey, PROMPT_IDEMPOTENCY_SPEC } from '../src/idempotency.ts'
import {
  appendTurnStart,
  bootService,
  disposeHarnesses,
  FakeAgent,
  FakeStorageDomain,
  flushMicrotasks,
  T0,
} from './harness.ts'
import { answer } from './fixtures.ts'

afterEach(async () => { await disposeHarnesses() })

async function expectCode(run: () => Promise<unknown>, code: string): Promise<DevLeadError> {
  try {
    await run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DevLeadError)
    expect((error as DevLeadError).code).toBe(code)
    return error as DevLeadError
  }
  throw new Error(`expected ${code}`)
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

  it('bounds correction/background admissions per pair and child turn, with replay exempt', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(harness.sessions['target']!)
    harness.agents.add(target)
    let keyed = ''
    for (let index = 0; index < 4; index += 1) {
      const receipt = await harness.service.promptSession(harness.lead.agent, 'target', `correction ${index}`, {
        intent: 'correction', ...(index === 0 ? { idempotencyKey: 'first-correction' } : {}),
      })
      if (index === 0) keyed = receipt.delivery.messageId
    }
    await expectCode(
      () => harness.service.promptSession(harness.lead.agent, 'target', 'fifth correction', { intent: 'correction' }),
      'DEVLEAD_DELIVERY_RATE_LIMITED',
    )
    const replay = await harness.service.promptSession(harness.lead.agent, 'target', 'correction 0', {
      intent: 'correction', idempotencyKey: 'first-correction',
    })
    expect(replay.delivery.messageId).toBe(keyed)
    expect(target.steers).toHaveLength(4)

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
    // open-time backup-and-skip (which is a definite discarded legacy row).
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
    harness.ctx.emit('agent/created', { agent: harness.lead.agent, source: 'resume' })
    await flushMicrotasks()
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
})
