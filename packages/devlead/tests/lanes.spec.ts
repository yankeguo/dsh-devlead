/**
 * Phase 1e message-lane integration coverage (DESIGN §4.4.4/§4.4.7/§4.4.11/
 * §4.4.12): the three delivery lanes over the real notification hub and the
 * real core service.
 *
 * - T1 (completed/forked) → coalesced `turn-notice` followup digest;
 * - T2 (failed/aborted/blocked/max-tokens/interrupted) → immediate
 *   `action-required` review steer;
 * - P1/P2 (progress/fyi) → immediate `background` inject with no driver wake,
 *   rate-limited per lead/child pair with digest-only degradation;
 * - P3/P4 (blocked/decision) → immediate `action-required` steer sharing the
 *   Q1 pair cap and the narrowed double-wake merge rule.
 *
 * Hub specs drive batching windows with fake timers and microtask flushes;
 * service specs use real timers exactly like service.spec.ts. Only the Agent
 * loop and optional host capabilities are fakes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadReportKind, DevLeadTransition } from '@yankeguo/dsh-devlead-protocol'
import { createDevLeadNoticeMessage, devLeadReport, reportRecord, watchRecord } from '../src/index.ts'
import {
  DEVLEAD_ACTION_REQUIRED_PENDING_MAX,
  DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN,
  DEVLEAD_BACKGROUND_PENDING_MAX,
} from '../src/notification.ts'
import type { HubHarness, HubLead, ServiceHarness } from './harness.ts'
import {
  FakeAgent,
  FakeSessionController,
  FakeWorkspaceRegistry,
  T0,
  appendTurnEnd,
  appendTurnStart,
  attachPersistedLead,
  bootHub,
  bootService,
  disposeHarnesses,
  flushMicrotasks,
  messageText,
  notificationRecords,
  projectionStateOf,
} from './harness.ts'

/** Install deterministic timers for one batching test. */
function installFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
}

/** Read the only scripted lead of a hub harness. */
function onlyLead(harness: HubHarness): HubLead {
  const lead = harness.leads[0]
  if (lead === undefined) throw new Error('expected the harness to boot one lead')
  return lead
}

/** Read one delivered steer message text. */
function steerText(lead: HubLead, index: number): string {
  const message = lead.agent.steers[index]
  if (message === undefined) throw new Error(`expected steer message ${String(index)}`)
  return messageText(message)
}

/** Read one delivered follow-up message text. */
function followupText(lead: HubLead, index: number): string {
  const message = lead.agent.followups[index]
  if (message === undefined) throw new Error(`expected follow-up message ${String(index)}`)
  return messageText(message)
}

/** Build one report for the booted child/lead pair (or an explicit sender/lead). */
function hubReport(
  harness: HubHarness,
  kind: DevLeadReportKind,
  message: string,
  options: { readonly turn?: number; readonly sender?: string; readonly leadId?: string } = {},
) {
  return devLeadReport({
    senderSessionId: options.sender ?? String(harness.watched.id),
    leadSessionId: options.leadId ?? String(onlyLead(harness).agent.id),
    turn: options.turn ?? 1,
    kind,
    message,
    at: T0,
  })
}

/** Park one unclaimed action-required wake and keep the lead running. */
function parkActionWake(lead: HubLead): void {
  lead.agent.setRunning(true)
  lead.agent.steer(createDevLeadNoticeMessage('parked action wake', {
    lane: 'action-required', wakeRequested: true, summary: 'Parked action wake',
  }))
}

/** Build one settled-turn reason with an explicit failure excerpt. */
function errorReason(message: string): TurnEndReason {
  return { kind: 'error', error: { message, code: 'PROVIDER_ERROR' } }
}

/** Read one required Session of a booted service harness. */
function requireSession(harness: ServiceHarness, id: string): Session {
  const session = harness.sessions[id]
  if (session === undefined) throw new Error(`expected a booted Session "${id}"`)
  return session
}

/** Read one exact counter series value from the service's detached snapshot. */
function counterValue(harness: ServiceHarness, name: string, labels: Record<string, string>): number {
  const sample = harness.service.metricsSnapshot().find(entry => entry.name === name
    && Object.keys(entry.labels).length === Object.keys(labels).length
    && Object.entries(labels).every(([key, value]) => entry.labels[key] === value))
  return sample?.value ?? 0
}

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

afterEach(async () => {
  await disposeHarnesses()
  vi.useRealTimers()
})

describe('T2 review lane (Phase 1e)', () => {
  const failedTurns: ReadonlyArray<readonly [DevLeadTransition, TurnEndReason, string]> = [
    ['error', errorReason('provider quota exhausted'), 'turn 1 failed: provider quota exhausted'],
    ['aborted', { kind: 'aborted', reason: { kind: 'user' } }, 'turn 1 cancelled'],
    ['blocked', { kind: 'blocked' }, 'turn 1 blocked'],
    ['max-tokens', { kind: 'max-tokens' }, 'turn 1 hit the output-token limit'],
    ['interrupted', { kind: 'interrupted' }, 'turn 1 interrupted'],
  ]

  it.each(failedTurns)('steers a %s turn-end through the review lane at next-step', async (transition, reason, line) => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1, reason)
    // The review steer rides the immediate action microtask, never behind the
    // 400ms turn-notice coalescing window.
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    const message = lead.agent.steers[0]!
    expect(message.source).toMatchObject({
      kind: 'devlead', form: 'notice', lane: 'action-required', wakeRequested: true,
    })
    expect(messageText(message).startsWith('[DEV LEAD REVIEW REQUIRED]')).toBe(true)
    expect(messageText(message)).toContain(`- ${String(harness.watched.id)} — ${line}`)
    expect(lead.agent.inbox.nextStep).toHaveLength(1)
    expect(lead.agent.inbox.nextTurn).toHaveLength(0)
    expect(notificationRecords(lead.session)).toHaveLength(1)
    expect(notificationRecords(lead.session)[0]?.transition).toBe(transition)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(lead.agent.steers).toHaveLength(1)
  })

  it('does not block the review lane behind a queued turn notice', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    lead.agent.followup(createDevLeadNoticeMessage('existing turn notice', {
      lane: 'turn-notice', wakeRequested: true, summary: 'Existing notice',
    }))
    appendTurnEnd(harness.watched, 1, errorReason('boom'))
    await flushMicrotasks()
    // The turn-notice guard belongs to the T1 lane only; T2 admits its steer.
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(1)
    expect(steerText(lead, 0)).toContain('[DEV LEAD REVIEW REQUIRED]')
  })

  it('does not block the turn-notice lane behind queued action-required or background messages', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    lead.agent.setRunning(true)
    lead.agent.steer(createDevLeadNoticeMessage('parked action wake', {
      lane: 'action-required', wakeRequested: true, summary: 'Parked',
    }))
    lead.agent.inject(createDevLeadNoticeMessage('background context', {
      lane: 'background', wakeRequested: false, summary: 'Background',
    }))
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain('— turn 1 completed')
  })

  it('coalesces two failed turns into one review steer', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1, errorReason('first failure'))
    appendTurnEnd(harness.watched, 2, errorReason('second failure'))
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(steerText(lead, 0)).toContain('turn 1 failed: first failure')
    expect(steerText(lead, 0)).toContain('turn 2 failed: second failure')
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('holds a second review behind an unclaimed action wake while running, then retries after the drain', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    lead.agent.setRunning(true)
    appendTurnEnd(harness.watched, 1, errorReason('first failure'))
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    appendTurnEnd(harness.watched, 2, errorReason('second failure'))
    await flushMicrotasks()
    // The first review steer is still parked at next-step: the second batch is
    // kept pending with the bounded 1s action retry, not dropped or doubled.
    expect(lead.agent.steers).toHaveLength(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    lead.agent.drainInbox()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(2)
    expect(steerText(lead, 1)).toContain('turn 2 failed: second failure')
  })

  it('separates T1 and T2 observed in the same window into one followup and one steer', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    appendTurnEnd(harness.watched, 2, errorReason('boom'))
    await flushMicrotasks()
    // T2 steers immediately; T1 waits for its own coalescing window.
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    expect(steerText(lead, 0)).toContain('turn 2 failed: boom')
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain('— turn 1 completed')
    expect(followupText(lead, 0)).not.toContain('boom')
  })

  it('resumes a cold lead for a failed turn and steers the review without the batch window', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, sessionController: controller })
    const lead = onlyLead(harness)
    controller.resolveHandler = () => {
      harness.agents.add(lead.agent)
      return { agent: lead.agent.agent }
    }
    harness.agents.remove(String(lead.agent.id))
    appendTurnEnd(harness.watched, 1, errorReason('cold failure'))
    await flushMicrotasks()
    expect(controller.resolveCalls.map(String)).toEqual([String(lead.agent.id)])
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(steerText(lead, 0)).toContain('[DEV LEAD REVIEW REQUIRED]')
    expect(steerText(lead, 0)).toContain('turn 1 failed: cold failure')
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('keeps an archived lead digest-only for a failed turn', async () => {
    installFakeTimers()
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootHub({ batchMs: 400, workspaceRegistry: registry })
    const lead = onlyLead(harness)
    registry.archived = [String(lead.agent.id)]
    appendTurnEnd(harness.watched, 1, errorReason('archived failure'))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lead.agent.steers).toHaveLength(0)
    expect(lead.agent.followups).toHaveLength(0)
    // The durable digest row survives; only the wake is dropped.
    expect(notificationRecords(lead.session)).toHaveLength(1)
  })
})

describe('background lane (P1/P2, Phase 1e)', () => {
  it('injects progress at next-step without a wake while the lead is idle', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const report = hubReport(harness, 'progress', 'halfway through the parser')
    expect(harness.hub.report(report)).toBe(true)
    // The background lane has no queue and no timer: the inject is synchronous.
    expect(lead.agent.admissions).toEqual(['inject'])
    const message = lead.agent.injects[0]!
    expect(message.source).toMatchObject({
      kind: 'devlead',
      form: 'notice',
      lane: 'background',
      wakeRequested: false,
      reportId: report.id,
      senderSessionId: String(harness.watched.id),
    })
    const text = messageText(message)
    expect(text.startsWith('[DEV LEAD REPORT]')).toBe(true)
    expect(text).toContain('no action required and no wake was requested')
    expect(text).toContain('halfway through the parser')
    expect(lead.agent.inbox.nextStep).toHaveLength(1)
    expect(lead.agent.inbox.nextTurn).toHaveLength(0)
    // The durable digest retains the report as the recovery authority.
    expect(projectionStateOf(lead.session).reports.map(entry => entry.id)).toEqual([report.id])
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('delivered')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lead.agent.followups).toHaveLength(0)
    expect(lead.agent.steers).toHaveLength(0)
  })

  it('injects fyi the same way while the lead is running', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    lead.agent.setRunning(true)
    const report = hubReport(harness, 'fyi', 'non-urgent context')
    expect(harness.hub.report(report)).toBe(true)
    expect(lead.agent.injects).toHaveLength(1)
    expect(lead.agent.injects[0]?.source).toMatchObject({
      lane: 'background', wakeRequested: false, reportId: report.id,
    })
    expect(messageText(lead.agent.injects[0]!)).toContain('[DEV LEAD REPORT]')
    expect(lead.agent.inbox.nextStep).toHaveLength(1)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(0)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('keeps a cold-observed background report digest-only and never injects it after the lead returns', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, leads: [], wakeColdSession: true, sessionController: controller })
    const coldLeadId = 'cold-background-lead'
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [watchedId] }])
    const report = hubReport(harness, 'progress', 'observed while cold', { leadId: coldLeadId })
    expect(harness.hub.report(report)).toBe(true)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(400)
    // Background context never resumes a cold lead, even with cold wake on.
    expect(controller.resolveCalls).toEqual([])
    expect(harness.hub.deliveryStateOf(coldLeadId, report.id)).toBe('digest-only')
    // The lead returns live: the receipt becomes durable, but no late inject.
    const agent = attachPersistedLead(harness.ctx, harness.agents, {
      sessionId: coldLeadId,
      watched: [watchedId],
    })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(400)
    expect(agent.injects).toHaveLength(0)
    expect(agent.followups).toHaveLength(0)
    expect(projectionStateOf(agent.session).reports.map(entry => entry.id)).toEqual([report.id])
    expect(harness.hub.deliveryStateOf(coldLeadId, report.id)).toBe('digest-only')
  })

  it('degrades to digest-only with a warning when the inject throws', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    lead.agent.failInjects = 1
    const report = hubReport(harness, 'progress', 'inject will fail')
    // A failed inject must not fail the reporter: no throw, receipt kept.
    expect(harness.hub.report(report)).toBe(true)
    expect(lead.agent.injects).toHaveLength(0)
    expect(warn.mock.calls.some(call => String(call[0]).includes('could not inject background report'))).toBe(true)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('digest-only')
    expect(projectionStateOf(lead.session).reports.map(entry => entry.id)).toEqual([report.id])
    warn.mockRestore()
  })
})

describe('background budgets (Phase 1e)', () => {
  it('degrades the ninth inject of one pair within one lead turn to digest-only', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const reports = Array.from({ length: DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN + 1 }, (_, index) => (
      hubReport(harness, 'progress', `update ${String(index)}`)
    ))
    for (const report of reports) expect(harness.hub.report(report)).toBe(true)
    expect(lead.agent.injects).toHaveLength(DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN)
    const overflow = reports.at(-1)!
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), overflow.id)).toBe('digest-only')
    expect(warn.mock.calls.some(call => String(call[0]).includes('degraded to digest-only'))).toBe(true)
    // Every durable receipt is kept; only the context injection is skipped.
    expect(projectionStateOf(lead.session).reports).toHaveLength(reports.length)
    warn.mockRestore()
  })

  it('resets the per-turn inject budget when the lead turn advances', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    for (let index = 0; index < DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN; index += 1) {
      harness.hub.report(hubReport(harness, 'progress', `before ${String(index)}`))
    }
    expect(lead.agent.injects).toHaveLength(DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN)
    appendTurnStart(lead.session, 1)
    const next = hubReport(harness, 'progress', 'after the turn boundary')
    expect(harness.hub.report(next)).toBe(true)
    expect(lead.agent.injects).toHaveLength(DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN + 1)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), next.id)).toBe('delivered')
  })

  it('degrades the seventeenth parked background notice of one pair', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    // Two full per-turn budgets parked without a drain: 16 unclaimed notices.
    for (let index = 0; index < DEVLEAD_BACKGROUND_PENDING_MAX; index += 1) {
      if (index === DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN) appendTurnStart(lead.session, 1)
      harness.hub.report(hubReport(harness, 'progress', `parked ${String(index)}`))
    }
    expect(lead.agent.injects).toHaveLength(DEVLEAD_BACKGROUND_PENDING_MAX)
    appendTurnStart(lead.session, 2)
    const overflow = hubReport(harness, 'progress', 'one parked too many')
    expect(harness.hub.report(overflow)).toBe(true)
    // The per-turn budget is fresh, but the parked-notice budget is exhausted.
    expect(lead.agent.injects).toHaveLength(DEVLEAD_BACKGROUND_PENDING_MAX)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), overflow.id)).toBe('digest-only')
    expect(warn.mock.calls.some(call => String(call[0]).includes('degraded to digest-only'))).toBe(true)
    warn.mockRestore()
  })

  it('keeps another child pair budget independent', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const other = harness.ctx.sessions.create(SessionId('hub-other-child'))
    appendPluginRecord(lead.session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([
      String(harness.watched.id), String(other.id),
    ], T0 + 1))
    for (let index = 0; index < DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN + 1; index += 1) {
      harness.hub.report(hubReport(harness, 'progress', `first child ${String(index)}`))
    }
    expect(lead.agent.injects).toHaveLength(DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN)
    const otherReport = hubReport(harness, 'progress', 'second child first report', { sender: String(other.id) })
    expect(harness.hub.report(otherReport)).toBe(true)
    expect(lead.agent.injects).toHaveLength(DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN + 1)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), otherReport.id)).toBe('delivered')
  })
})

describe('P3/P4 action reports (Phase 1e)', () => {
  it.each(['blocked', 'decision'] as const)('steers a %s report with the full message, report id, and observed child state', async kind => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const child = new FakeAgent(harness.watched)
    child.setRunning(true)
    harness.agents.add(child)
    const report = hubReport(harness, kind, 'line one\nline two')
    expect(harness.hub.report(report)).toBe(true)
    expect(lead.agent.steers).toHaveLength(0)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    expect(lead.agent.steers[0]?.source).toMatchObject({
      kind: 'devlead', form: 'notice', lane: 'action-required', wakeRequested: true, reportId: report.id,
    })
    const text = steerText(lead, 0)
    expect(text.startsWith('[DEV LEAD ACTION REQUIRED]')).toBe(true)
    expect(text).toContain(report.id)
    expect(text).toContain('observed child state at wake time: running')
    expect(text).toContain('  line one')
    expect(text).toContain('  line two')
    expect(lead.agent.inbox.nextStep).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('shares the 16-pair cap: questions fill it, blocked and decision are rejected before the receipt write', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    parkActionWake(lead)
    for (let index = 0; index < DEVLEAD_ACTION_REQUIRED_PENDING_MAX; index += 1) {
      expect(harness.hub.report(hubReport(harness, 'question', `Question ${String(index)}?`))).toBe(true)
    }
    for (const kind of ['blocked', 'decision'] as const) {
      expect(() => harness.hub.report(hubReport(harness, kind, `${kind} overflow`))).toThrowError(
        expect.objectContaining({ code: 'DEVLEAD_DELIVERY_RATE_LIMITED' }),
      )
    }
    // No receipt was written for either rejected report.
    expect(projectionStateOf(lead.session).reports).toHaveLength(DEVLEAD_ACTION_REQUIRED_PENDING_MAX)
  })

  it('shares the cap in the other direction and keeps a same-id retry accepted at the cap', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    parkActionWake(lead)
    const reports = Array.from({ length: DEVLEAD_ACTION_REQUIRED_PENDING_MAX }, (_, index) => (
      hubReport(harness, index % 2 === 0 ? 'blocked' : 'decision', `Action ${String(index)}`)
    ))
    for (const report of reports) expect(harness.hub.report(report)).toBe(true)
    expect(() => harness.hub.report(hubReport(harness, 'question', 'One question too many?'))).toThrowError(
      expect.objectContaining({ code: 'DEVLEAD_DELIVERY_RATE_LIMITED' }),
    )
    // An existing identity is a retry, not a seventeenth distinct report.
    expect(harness.hub.report(reports[0]!)).toBe(true)
    expect(projectionStateOf(lead.session).reports).toHaveLength(DEVLEAD_ACTION_REQUIRED_PENDING_MAX)
  })
})

describe('double-wake suppression extension (P3/P4, Phase 1e)', () => {
  it.each(['blocked', 'decision'] as const)('merges a turn-end into a pending %s wake without a second wake', async kind => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    parkActionWake(lead)
    const report = hubReport(harness, kind, 'needs lead action')
    harness.hub.report(report)
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    // The parked wake holds the batch; the turn-end merged into it durably.
    expect(lead.agent.steers).toHaveLength(1)
    expect(notificationRecords(lead.session)[0]).toMatchObject({
      wakeSuppressedByReportId: report.id,
      wakeSuppressionReason: 'merged-into-pending-wake',
    })
    lead.agent.drainInbox()
    lead.agent.setRunning(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(2)
    const text = steerText(lead, 1)
    expect(text).toContain('included turn-end:')
    expect(text).toContain('turn 1 completed')
    expect(text).toContain(report.id)
    // The merged turn-end line precedes the bounded payload.
    expect(text.indexOf('included turn-end:')).toBeLessThan(text.indexOf('- report:'))
    expect(lead.agent.followups).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('marks a pending T1 included only after the action steer succeeds', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    const report = hubReport(harness, 'blocked', 'needs lead action')
    harness.hub.report(report)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(steerText(lead, 0)).toContain('included turn-end:')
    const records = notificationRecords(lead.session)
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      wakeSuppressedByReportId: report.id,
      wakeSuppressionReason: 'included-in-sent-wake',
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('retains the T1 wake when the sent action wake did not include the turn-end', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.hub.report(hubReport(harness, 'blocked', 'needs lead action'))
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    // Same child+turn, but the wake was already sent without this turn-end.
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain('— turn 1 completed')
    expect(notificationRecords(lead.session)[0]).not.toHaveProperty('wakeSuppressedByReportId')
  })

  it('never suppresses an ambiguous turn-end shared by two pending action reports', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    parkActionWake(lead)
    harness.hub.report(hubReport(harness, 'blocked', 'first action'))
    harness.hub.report(hubReport(harness, 'decision', 'second action'))
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    expect(notificationRecords(lead.session)[0]).not.toHaveProperty('wakeSuppressedByReportId')
    lead.agent.drainInbox()
    lead.agent.setRunning(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(2)
    expect(steerText(lead, 1)).toContain('first action')
    expect(steerText(lead, 1)).toContain('second action')
    expect(steerText(lead, 1)).not.toContain('included turn-end:')
    // The ambiguous turn-end keeps its own T1 wake.
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain('— turn 1 completed')
  })
})

describe('report replay idempotence (Phase 1e)', () => {
  it('returns true for an already-folded action report without a second steer', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const report = hubReport(harness, 'question', 'Which target?')
    expect(await harness.hub.persistReport(report)).toBe(true)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    // An outbox replay of the same durable receipt must not double the wake.
    expect(await harness.hub.persistReport(report)).toBe(true)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.admissions).toEqual(['steer'])
  })

  it('returns true for an already-folded background report without a second inject', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const report = hubReport(harness, 'progress', 'replayed context')
    expect(await harness.hub.persistReport(report)).toBe(true)
    expect(lead.agent.injects).toHaveLength(1)
    expect(await harness.hub.persistReport(report)).toBe(true)
    await flushMicrotasks()
    expect(lead.agent.injects).toHaveLength(1)
    expect(lead.agent.admissions).toEqual(['inject'])
  })

  it('dedupes a sync report against the folded receipt', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const report = hubReport(harness, 'progress', 'same context')
    expect(harness.hub.report(report)).toBe(true)
    expect(harness.hub.report(report)).toBe(true)
    expect(lead.agent.injects).toHaveLength(1)
  })
})

describe('delivery observations (Phase 1e)', () => {
  it('observes pending then delivered for an action report', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    parkActionWake(lead)
    const report = hubReport(harness, 'blocked', 'waiting for capacity')
    harness.hub.report(report)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('pending')
    lead.agent.drainInbox()
    lead.agent.setRunning(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('delivered')
  })

  it('returns undefined for an unknown report id and after the lead is forgotten', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const report = hubReport(harness, 'progress', 'observed once')
    harness.hub.report(report)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), 'no-such-report')).toBeUndefined()
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('delivered')
    harness.hub.forgetLead(String(lead.agent.id))
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBeUndefined()
  })

  it('bounds the remembered observations with FIFO eviction', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    const reports = Array.from({ length: 260 }, (_, index) => (
      hubReport(harness, 'progress', `observation ${String(index)}`)
    ))
    for (const report of reports) harness.hub.report(report)
    // The bounded map keeps the newest 256 observations only.
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), reports[0]!.id)).toBeUndefined()
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), reports[3]!.id)).toBeUndefined()
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), reports[4]!.id)).toBeDefined()
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), reports.at(-1)!.id)).toBeDefined()
  })
})

describe('actionBatchMs scheduling (Phase 1e)', () => {
  it('delays the action flush by actionBatchMs while the turn-notice lane stays independent', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, actionBatchMs: 200 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 2)
    harness.hub.report(hubReport(harness, 'question', 'Which target?'))
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(0)
    expect(lead.agent.followups).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(199)
    expect(lead.agent.steers).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    // The action lane fires at its own 200ms delay, ahead of the T1 window.
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain('— turn 2 completed')
  })
})

describe('service delivery observations and metrics (Phase 1e)', () => {
  /** Boot one live lead watching one live child, ready for report calls. */
  async function bootReporting(config: Record<string, unknown> = {}): Promise<{ harness: ServiceHarness; child: FakeAgent }> {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['child-lanes'],
      watched: ['child-lanes'],
      config: { notificationBatchMs: 0, ...config },
    })
    const child = new FakeAgent(requireSession(harness, 'child-lanes'))
    harness.agents.add(child)
    return { harness, child }
  }

  it('exposes reportDeliveryState through the service and rejects a non-live agent', async () => {
    const { harness, child } = await bootReporting()
    const receipt = await harness.service.reportProgress(child.agent, { message: 'observed delivery' })
    expect(harness.service.reportDeliveryState(harness.lead.agent, receipt.report.id)).toBe('delivered')
    expect(harness.service.reportDeliveryState(harness.lead.agent, 'no-such-report')).toBeUndefined()
    const stale = new FakeAgent(requireSession(harness, 'child-lanes'))
    expect(() => harness.service.reportDeliveryState(stale.agent, receipt.report.id)).toThrowError(
      expect.objectContaining({ code: 'DEVLEAD_AGENT_NOT_LIVE' }),
    )
  })

  it('counts a T1 followup delivery through the turn-notice lane', async () => {
    const { harness } = await bootReporting()
    appendTurnEnd(requireSession(harness, 'child-lanes'), 1)
    await flushMicrotasks()
    expect(harness.lead.followups).toHaveLength(1)
    const labels = { direction: 'child-to-lead', lane: 'turn-notice', primitive: 'followup', kind: 'T1' }
    expect(counterValue(harness, 'devlead_delivery_total', { ...labels, outcome: 'queued' })).toBe(1)
    expect(counterValue(harness, 'devlead_delivery_total', { ...labels, outcome: 'delivered' })).toBe(1)
  })

  it('counts a T2 steer delivery through the action-required lane', async () => {
    const { harness } = await bootReporting()
    appendTurnEnd(requireSession(harness, 'child-lanes'), 1, errorReason('provider failed'))
    await flushMicrotasks()
    expect(harness.lead.steers).toHaveLength(1)
    const labels = { direction: 'child-to-lead', lane: 'action-required', primitive: 'steer', kind: 'T2' }
    expect(counterValue(harness, 'devlead_delivery_total', { ...labels, outcome: 'queued' })).toBe(1)
    expect(counterValue(harness, 'devlead_delivery_total', { ...labels, outcome: 'delivered' })).toBe(1)
  })

  it('counts background injects and the digest-only budget degradation', async () => {
    const { harness, child } = await bootReporting()
    const childSession = requireSession(harness, 'child-lanes')
    // Advance the CHILD turn to reset the service per-turn report budget while
    // the lead turn stays fixed: 12 reports, 8 injects, 4 digest-only.
    for (let turn = 1; turn <= 3; turn += 1) {
      appendTurnStart(childSession, turn)
      for (let index = 0; index < 4; index += 1) {
        await harness.service.reportProgress(child.agent, { message: `turn ${String(turn)} update ${String(index)}` })
      }
    }
    expect(harness.lead.injects).toHaveLength(DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN)
    const labels = { direction: 'child-to-lead', lane: 'background', primitive: 'inject', kind: 'progress' }
    expect(counterValue(harness, 'devlead_delivery_total', { ...labels, outcome: 'delivered' }))
      .toBe(DEVLEAD_BACKGROUND_INJECT_MAX_PER_TURN)
    expect(counterValue(harness, 'devlead_delivery_total', { ...labels, outcome: 'digest-only' })).toBe(4)
  })

  it('counts wake suppression and both lane guard hits', async () => {
    const { harness, child } = await bootReporting()
    const childSession = requireSession(harness, 'child-lanes')
    // Guard 1: a legacy (lane-less) queued notice holds the T1 batch.
    harness.lead.followup(createDevLeadNoticeMessage('legacy queued notice'))
    appendTurnEnd(childSession, 1)
    await flushMicrotasks()
    expect(counterValue(harness, 'devlead_guard_hit_total', { guard: 'queued-turn-notice' })).toBe(1)
    harness.lead.drainInbox()
    // Guard 2: a parked action wake holds the P3 batch while the lead runs.
    harness.lead.setRunning(true)
    harness.lead.steer(createDevLeadNoticeMessage('parked action wake', {
      lane: 'action-required', wakeRequested: true, summary: 'Parked',
    }))
    appendTurnStart(childSession, 2)
    await harness.service.reportProgress(child.agent, { kind: 'blocked', message: 'needs direction' })
    await flushMicrotasks()
    expect(counterValue(harness, 'devlead_guard_hit_total', { guard: 'queued-action-required' })).toBeGreaterThanOrEqual(1)
    // The same child+turn turn-end merges into the pending P3 wake.
    appendTurnEnd(childSession, 2)
    await flushMicrotasks()
    expect(counterValue(harness, 'devlead_wake_suppression_total', { reason: 'merged-into-pending-wake' })).toBe(1)
    expect(notificationRecords(harness.leadSession).at(-1)).toMatchObject({
      wakeSuppressionReason: 'merged-into-pending-wake',
    })
  })

  it('counts answer lifecycle transitions and the answered/open question status', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      config: { notificationBatchMs: 0 },
    })
    const target = new FakeAgent(requireSession(harness, 'target'))
    target.setRunning(true)
    harness.agents.add(target)
    const questionId = seedQuestion(harness, 'target')
    await harness.service.promptSession(harness.lead.agent, 'target', 'use staging', {
      intent: 'answer',
      questionId,
    })
    expect(counterValue(harness, 'devlead_answer_status_total', { status: 'admitted' })).toBe(1)
    expect(counterValue(harness, 'devlead_question_status_total', { status: 'answered' })).toBe(1)
    expect(counterValue(harness, 'devlead_delivery_total', {
      direction: 'lead-to-child', lane: 'action-required', primitive: 'steer', kind: 'answer', outcome: 'delivered',
    })).toBe(1)
    appendTurnStart(target.session, 1)
    target.claimNextStep({ present: true, turn: 1 })
    await flushMicrotasks()
    expect(counterValue(harness, 'devlead_answer_status_total', { status: 'claimed' })).toBe(1)
    expect(counterValue(harness, 'devlead_answer_status_total', { status: 'presented' })).toBe(1)
    // A rejected pre-step discards the second answer and reopens its question.
    const secondQuestion = seedQuestion(harness, 'target', 'Second question?')
    await harness.service.promptSession(harness.lead.agent, 'target', 'use prod', {
      intent: 'answer',
      questionId: secondQuestion,
    })
    appendTurnStart(target.session, 2)
    target.claimNextStep({ present: false, turn: 2 })
    appendTurnEnd(target.session, 2)
    await flushMicrotasks()
    expect(counterValue(harness, 'devlead_answer_status_total', { status: 'discarded' })).toBe(1)
    expect(counterValue(harness, 'devlead_question_status_total', { status: 'open' })).toBe(1)
  })

  it('counts lead-to-child prompt admissions per intent', async () => {
    const harness = await bootService({ enabled: true, sessionIds: ['target'], watched: ['target'] })
    const target = new FakeAgent(requireSession(harness, 'target'))
    harness.agents.add(target)
    await harness.service.promptSession(harness.lead.agent, 'target', 'do X')
    await harness.service.promptSession(harness.lead.agent, 'target', 'stop doing X', { intent: 'correction' })
    await harness.service.promptSession(harness.lead.agent, 'target', 'fyi context', { intent: 'background' })
    expect(counterValue(harness, 'devlead_delivery_total', {
      direction: 'lead-to-child', lane: 'turn-notice', primitive: 'followup', kind: 'instruction', outcome: 'delivered',
    })).toBe(1)
    expect(counterValue(harness, 'devlead_delivery_total', {
      direction: 'lead-to-child', lane: 'action-required', primitive: 'steer', kind: 'correction', outcome: 'delivered',
    })).toBe(1)
    expect(counterValue(harness, 'devlead_delivery_total', {
      direction: 'lead-to-child', lane: 'background', primitive: 'inject', kind: 'background', outcome: 'delivered',
    })).toBe(1)
  })
})