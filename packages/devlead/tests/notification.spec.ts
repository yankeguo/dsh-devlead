/**
 * Coverage of the watched-session notification hub and its model-facing wake
 * digest.
 *
 * The hub runs over a real cordis Context, real Session logs, and the real
 * durable `plugin:devlead/*` record path; only the Agent loop and the optional
 * host capabilities are deterministic fakes. Batching windows are driven with
 * fake timers and microtask flushes only — no wall-clock sleeps.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification } from '@yankeguo/dsh-devlead-protocol'
import {
  createDevLeadNoticeMessage,
  DEVLEAD_RESET_RECORD_TYPE,
  modeRecord,
  resetRecord,
  watchRecord,
} from '../src/domain.ts'
import { devLeadReport } from '../src/index.ts'
import {
  DEVLEAD_ACTION_REQUIRED_PENDING_MAX,
  DEVLEAD_MAX_WARNED_FAILURES,
  renderDevLeadNotice,
  renderDevLeadQuestionNotice,
  renderDevLeadReviewNotice,
} from '../src/notification.ts'
import type { HubHarness, HubLead } from './harness.ts'
import {
  FakeAgent,
  FakeSessionController,
  FakeWorkspaceRegistry,
  T0,
  appendAssistantMessage,
  appendTurnEnd,
  attachPersistedLead,
  bootHub,
  disposeHarnesses,
  flushMicrotasks,
  messageText,
  notificationRecords,
  projectionStateOf,
} from './harness.ts'
import { notification } from './fixtures.ts'

/** Install deterministic timers for one batching test. */
function installFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
}

/** Read the only scripted lead of a harness. */
function onlyLead(harness: HubHarness): HubLead {
  const lead = harness.leads[0]
  if (lead === undefined) throw new Error('expected the harness to boot one lead')
  return lead
}

/** Read one delivered follow-up message text. */
function followupText(lead: HubLead, index: number): string {
  const message = lead.agent.followups[index]
  if (message === undefined) throw new Error(`expected follow-up message ${String(index)}`)
  return messageText(message)
}

/** Read one delivered action-required message text. */
function steerText(lead: HubLead, index: number): string {
  const message = lead.agent.steers[index]
  if (message === undefined) throw new Error(`expected steer message ${String(index)}`)
  return messageText(message)
}

/** Build one structured Q1 report for the booted child/lead pair. */
function questionReport(harness: HubHarness, message = 'Which deployment target?') {
  const lead = onlyLead(harness)
  return devLeadReport({
    senderSessionId: String(harness.watched.id),
    senderSessionTitle: 'webapp',
    leadSessionId: String(lead.agent.id),
    turn: 1,
    kind: 'question',
    message,
    summary: 'Deployment target',
    questions: [{
      id: 'target',
      header: 'Deploy',
      question: message,
      options: [
        { label: 'Staging', description: 'existing provider' },
        { label: 'Production', description: 'needs approval' },
      ],
      multi_select: false,
    }],
    at: T0,
  })
}

/** Build one settled-turn reason with an explicit failure excerpt. */
function errorReason(message: string): { kind: 'error'; error: { message: string; code: string } } {
  return { kind: 'error', error: { message, code: 'PROVIDER_ERROR' } }
}

afterEach(async () => {
  await disposeHarnesses()
  vi.useRealTimers()
})

describe('renderDevLeadNotice', () => {
  it('renders the runtime notice framing and one digest line per notification', () => {
    const lines = renderDevLeadNotice([
      notification({ sessionId: 'session-alpha', sessionTitle: 'webapp', turn: 3 }),
      notification({ sessionId: 'session-beta', turn: 1, transition: 'error', error: 'quota exhausted' }),
    ])
    expect(lines).toBe([
      '[DEV LEAD NOTIFICATION]',
      'Watched session activity changed outside this conversation. This is a runtime notice, not a human instruction.',
      '- webapp (session-alpha) — turn 3 completed',
      '- session-beta — turn 1 failed: quota exhausted',
      'Call devlead_notifications for the retained digest, or devlead_get_session for one session in detail. '
      + 'Decide what the Dev Lead should do next: continue an existing conversation, dispatch new work, or report to the human.',
    ].join('\n'))
  })

  it('caps the digest at twelve lines and reports how many were omitted', () => {
    const notifications: DevLeadNotification[] = []
    for (let index = 1; index <= 13; index += 1) {
      notifications.push(notification({ sessionId: `session-${String(index)}`, turn: index }))
    }
    const lines = renderDevLeadNotice(notifications).split('\n')
    expect(lines).toHaveLength(2 + 1 + 12 + 1)
    expect(lines[2]).toBe(
      '- (1 earlier notification(s) omitted; call devlead_notifications for the digest)',
    )
    expect(lines).toContain('- session-13 — turn 13 completed')
    expect(lines).not.toContain('- session-1 — turn 1 completed')
  })

  it('uses an explicit total to report older undelivered notifications', () => {
    const lines = renderDevLeadNotice(
      [
        notification({ sessionId: 'session-alpha', turn: 1 }),
        notification({ sessionId: 'session-beta', turn: 2 }),
      ],
      5,
    ).split('\n')
    expect(lines[2]).toBe(
      '- (3 earlier notification(s) omitted; call devlead_notifications for the digest)',
    )
    expect(lines[3]).toBe('- session-alpha — turn 1 completed')
    expect(lines[4]).toBe('- session-beta — turn 2 completed')
  })

  it('omits the omission line when every undelivered notification is shown', () => {
    const text = renderDevLeadNotice([notification({ sessionId: 'session-alpha', turn: 1 })], 1)
    expect(text).not.toContain('omitted')
  })

  it('renders the framing without digest lines for an empty batch', () => {
    const text = renderDevLeadNotice([])
    const lines = text.split('\n')
    expect(lines[0]).toBe('[DEV LEAD NOTIFICATION]')
    expect(lines[1]).toContain('runtime notice, not a human instruction')
    expect(lines.at(-1)).toContain('Call devlead_notifications')
    expect(lines.some(line => line.startsWith('- '))).toBe(false)
  })

  it('bounds the review wake and keeps its truncation guidance', () => {
    // Long Session ids can make twelve digest lines exceed the 8k wake budget;
    // the review renderer must share the same bound as the action/question wakes.
    const notifications = Array.from({ length: 12 }, (_, index) => notification({
      sessionId: `session-${String(index)}-${'x'.repeat(4_000)}`,
      turn: index + 1,
      transition: 'error',
      error: 'provider failed',
    }))
    const text = renderDevLeadReviewNotice(notifications)
    expect(Array.from(text).length).toBeLessThanOrEqual(8_000)
    expect(text).toContain('[DEV LEAD REVIEW REQUIRED]')
    expect(text).toContain('… Review payload truncated; call devlead_notifications for the full failure detail.')
  })
})

describe('DevLeadNotificationHub observation', () => {
  it('records one durable notification into each watching lead and queues one wake', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [{ enabled: true }, { enabled: true }] })
    harness.sessionTitle.set(String(harness.watched.id), 'webapp')
    appendTurnEnd(harness.watched, 3)
    expect(harness.leads.every(lead => lead.agent.followups.length === 0)).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    for (const lead of harness.leads) {
      expect(lead.agent.followups).toHaveLength(1)
      const notice = lead.agent.followups[0]
      if (notice === undefined) throw new Error('expected one notice')
      expect(notice.source).toMatchObject({ kind: 'devlead', form: 'notice' })
      expect(messageText(notice)).toContain('[DEV LEAD NOTIFICATION]')
      expect(messageText(notice)).toContain(`- webapp (${String(harness.watched.id)}) — turn 3 completed`)
      const records = notificationRecords(lead.session)
      expect(records).toEqual([
        {
          id: notificationId(String(harness.watched.id), 3, 'completed'),
          sessionId: String(harness.watched.id),
          sessionTitle: 'webapp',
          transition: 'completed',
          turn: 3,
          at: expect.any(Number),
        },
      ])
      expect(lead.agent.inbox.nextTurn).toHaveLength(1)
    }
  })

  it('coalesces two settled turns inside one batch window into a single wake', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    appendTurnEnd(harness.watched, 2)
    expect(lead.agent.followups).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    const text = followupText(lead, 0)
    expect(text.split('\n').filter(line => line.startsWith('- '))).toEqual([
      `- ${String(harness.watched.id)} — turn 1 completed`,
      `- ${String(harness.watched.id)} — turn 2 completed`,
    ])
    expect(notificationRecords(lead.session)).toHaveLength(2)
  })

  it('restarts a fresh batch after the previous wake settles', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    lead.agent.drainInbox()
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(2)
    expect(followupText(lead, 1)).toContain('— turn 2 completed')
  })

  it('does not observe a Session when no live lead watches it', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [{ enabled: true, watched: [] }] })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toEqual([])
  })

  it('does not observe turns reaching a lead whose mode is disabled', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [{ enabled: false, watched: [] }] })
    const lead = onlyLead(harness)
    await vi.advanceTimersByTimeAsync(400)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toEqual([])
  })

  it('carries the folded title and bounded failure excerpt into the review wake', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.sessionTitle.set(String(harness.watched.id), 'api')
    appendTurnEnd(harness.watched, 1, errorReason('provider quota exhausted'))
    // Phase 1e: a failed turn is T2 and rides the immediate action-required
    // review lane, never the coalesced T1 turn-notice window.
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(0)
    expect(lead.agent.steers).toHaveLength(1)
    expect(steerText(lead, 0)).toContain('[DEV LEAD REVIEW REQUIRED]')
    expect(steerText(lead, 0)).toContain(
      `- api (${String(harness.watched.id)}) — turn 1 failed: provider quota exhausted`,
    )
    expect(notificationRecords(lead.session)[0]).toMatchObject({
      transition: 'error',
      error: 'provider quota exhausted',
      sessionTitle: 'api',
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('carries the latest assistant excerpt of the watched Session into the digest', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendAssistantMessage(harness.watched, 1, '  Implemented\n the parser.  ')
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain(
      `- ${String(harness.watched.id)} — turn 1 completed: Implemented the parser.`,
    )
    expect(notificationRecords(lead.session)[0]?.summary).toBe('Implemented the parser.')
  })

  it('keeps the newest non-empty assistant excerpt across turns', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendAssistantMessage(harness.watched, 1, 'first attempt')
    appendAssistantMessage(harness.watched, 1, 'second attempt', 2)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(notificationRecords(lead.session)[0]?.summary).toBe('second attempt')
    // A later empty assistant message does not erase the remembered excerpt.
    appendAssistantMessage(harness.watched, 2, '   ')
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(notificationRecords(lead.session)[1]?.summary).toBe('second attempt')
  })

  it('does not report a non-reportable transition kind', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    // A plugin-extended reason kind outside the mirrored transition union
    // degrades to `interrupted` instead of being dropped. `interrupted` is T2,
    // so the wake rides the immediate review lane.
    harness.watched.append('turn/end', { turn: 1, reason: { kind: 'custom-future-kind' } as never })
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    expect(steerText(lead, 0)).toContain('[DEV LEAD REVIEW REQUIRED]')
    expect(notificationRecords(lead.session)[0]?.transition).toBe('interrupted')
  })
})

describe('DevLeadNotificationHub wake coalescing', () => {
  it('delivers immediately when the lead becomes idle before the window closes', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 10_000 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    expect(lead.agent.followups).toHaveLength(0)
    harness.ctx.emit('agent/status', { agent: lead.agent.agent, status: 'idle' })
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('keeps a second batch pending behind an undelivered notice and delivers it after the drain', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    // The queued notice already points the model at the digest tool, so the
    // second batch is NOT delivered yet. It is kept pending (not dropped): a
    // bounded recheck timer is armed instead.
    expect(lead.agent.followups).toHaveLength(1)
    expect(notificationRecords(lead.session)).toHaveLength(2)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    // The loop consumes the notice; the next recheck delivers the retained batch
    // exactly once.
    lead.agent.drainInbox()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(2)
    expect(followupText(lead, 1)).toContain('— turn 2 completed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lead.agent.followups).toHaveLength(2)
  })

  it('delivers a retained batch as soon as the queued notice is cancelled', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    // The queued notice is withdrawn without being consumed: the retained batch
    // must still be delivered (previously it was dropped forever).
    lead.agent.cancelInbox()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(2)
    expect(followupText(lead, 1)).toContain('— turn 2 completed')
    expect(notificationRecords(lead.session)).toHaveLength(2)
  })

  it('delivers past an inbox message without a source instead of stranding the batch', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    // A damaged or migrated log can restore an inbox message without a source
    // (the inbox projection does not shape-validate persisted messages). The
    // flush must treat it as "not a DevLead notice" and still deliver.
    lead.agent.inbox.nextTurn.push({} as never)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('delivers a retained batch immediately when the lead becomes idle', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    lead.agent.drainInbox()
    harness.ctx.emit('agent/status', { agent: lead.agent.agent, status: 'idle' })
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(2)
    expect(followupText(lead, 1)).toContain('— turn 2 completed')
  })

  it('clears the retained-batch recheck timer when the watch is dropped', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    appendPluginRecord(lead.session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([], T0 + 2))
    // The latest durable watch set is authoritative: the retained batch is
    // filtered out and its recheck timer is cleared.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('clears the retained-batch recheck timer on hub disposal', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await harness.dispose()
    // The hub's effect disposer clears every pending recheck timer and index.
    expect(vi.getTimerCount()).toBe(0)
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('clears the retained-batch recheck timer when the mode is disabled', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    appendPluginRecord(lead.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(false, T0 + 2))
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('delivers immediately through deliverNow', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 10_000 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await harness.hub.deliverNow(String(lead.agent.id))
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('drops a queued zero-delay flush when the lead mode is disabled first', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    appendPluginRecord(lead.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(false, T0 + 2))
    await flushMicrotasks()
    // The durable row is kept; only the stale wake-up is dropped.
    expect(notificationRecords(lead.session)).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('clears the pending batch timer when deliverNow takes the batch', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 60_000 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await harness.hub.deliverNow(String(lead.agent.id))
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queues one digest line for a duplicated turn identity', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0).split('\n').filter(line => line.startsWith('- '))).toHaveLength(1)
    // Both durable audit rows still exist; only the queued wake dedupes.
    expect(notificationRecords(lead.session)).toHaveLength(2)
  })

  it('retries a failed wake-up on a bounded timer instead of spinning', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    lead.agent.failFollowups = 1
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('wakes a lead on a host that composes no durability participant', async () => {
    const harness = await bootHub({ batchMs: 0, persistence: false })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    // flush() returning false means "nothing to persist to", not a failure.
    expect(lead.agent.followups).toHaveLength(1)
    expect(notificationRecords(lead.session)).toHaveLength(1)
  })
})

describe('DevLeadNotificationHub lifecycle', () => {
  it('drops pending digests when the watched Session is unwatched', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    // The observation already wrote its durable row; the queued wake must be
    // dropped because the lead no longer watches that Session.
    appendPluginRecord(lead.session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([], T0 + 2))
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toHaveLength(1)
    await harness.hub.deliverNow(String(lead.agent.id))
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('removes a lead index when its durable mode is disabled and restores it on re-enable', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendPluginRecord(lead.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(false, T0 + 2))
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toEqual([])
    appendPluginRecord(lead.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0 + 3))
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain('— turn 2 completed')
  })

  it('keeps durable notifications but drops the wake for an archived lead Session', async () => {
    installFakeTimers()
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootHub({ batchMs: 400, workspaceRegistry: registry })
    const lead = onlyLead(harness)
    registry.archived = [String(lead.agent.id)]
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toHaveLength(1)
    await harness.hub.deliverNow(String(lead.agent.id))
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('refuses reports for an archived lead on both the queue and durable paths', async () => {
    installFakeTimers()
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootHub({ batchMs: 400, workspaceRegistry: registry })
    const lead = onlyLead(harness)
    const report = (message: string) => devLeadReport({
      senderSessionId: String(harness.watched.id),
      leadSessionId: String(lead.agent.id),
      turn: 1,
      kind: 'progress',
      message,
      at: T0,
    })
    expect(harness.hub.report(report('before archive'))).toBe(true)
    // The sync queue path applies the same archived-lead guard as the durable
    // receipt path: a lead archived mid-turn must not keep receiving reports.
    registry.archived = [String(lead.agent.id)]
    expect(harness.hub.report(report('after archive'))).toBe(false)
    expect(await harness.hub.persistReport(report('durable after archive'))).toBe(false)
  })

  it('never resumes or wakes a cold archived lead even when wakeColdSession is enabled', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootHub({
      batchMs: 400,
      leads: [],
      wakeColdSession: true,
      sessionController: controller,
      workspaceRegistry: registry,
    })
    const coldLeadId = 'archived-cold-lead'
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [watchedId] }])
    registry.archived = [coldLeadId]
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    // Archived wins over the cold-wake policy: the lead is paused, not resumed.
    expect(controller.resolveCalls).toEqual([])
    // Unarchiving and opening the Session writes the retained observation and
    // delivers its digest.
    registry.archived = []
    const agent = attachPersistedLead(harness.ctx, harness.agents, {
      sessionId: coldLeadId,
      watched: [watchedId],
    })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(agent.followups).toHaveLength(1)
    expect(messageText(agent.followups[0]!)).toContain('— turn 1 completed')
    expect(notificationRecords(agent.session)).toHaveLength(1)
  })

  it('persists a cold observation when an archived lead Session becomes attached without waking', async () => {
    installFakeTimers()
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootHub({ batchMs: 400, leads: [], workspaceRegistry: registry })
    const coldLeadId = 'archived-attached-lead'
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [watchedId] }])
    registry.archived = [coldLeadId]
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    // The observation of a cold archived lead is kept in memory...
    const agent = attachPersistedLead(harness.ctx, harness.agents, {
      sessionId: coldLeadId,
      watched: [watchedId],
    })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    // ...and the attached-but-archived Session can still append it; the wake is
    // dropped (durable digest stays visible after restoring the Session).
    expect(notificationRecords(agent.session)).toHaveLength(1)
    expect(agent.followups).toHaveLength(0)
  })

  it('keeps observing a watched Session after its lead Agent is disposed', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.agents.remove(String(lead.agent.id))
    harness.ctx.emit('agent/disposed', { agent: lead.agent.agent })
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    // The watch set is durable: a disposed (cold) lead keeps producing durable
    // notification records. The digest cannot be delivered while the Agent is
    // gone, so it stays queued instead.
    expect(notificationRecords(lead.session)).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    // Opening/recreating the Agent re-indexes it and drains the queued digest.
    harness.agents.add(lead.agent)
    harness.ctx.emit('agent/created', { agent: lead.agent.agent, source: 'resume' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain('— turn 1 completed')
  })

  it('resumes a disposed lead Agent by default to deliver its queued digest', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, sessionController: controller })
    const lead = onlyLead(harness)
    controller.resolveHandler = () => {
      // A real resume re-announces the same Session's Agent.
      harness.agents.add(lead.agent)
      return { agent: lead.agent.agent }
    }
    harness.agents.remove(String(lead.agent.id))
    harness.ctx.emit('agent/disposed', { agent: lead.agent.agent })
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(controller.resolveCalls.map(String)).toEqual([String(lead.agent.id)])
    // The resumed Agent is re-synced and the queued digest flushes.
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
    expect(notificationRecords(lead.session)).toHaveLength(1)
  })

  it('disposes cleanly with a queued digest still inside its window', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await harness.dispose()
    // The hub's effect disposer clears the pending coalescing timer and index.
    expect(vi.getTimerCount()).toBe(0)
    expect(lead.agent.followups).toHaveLength(0)
  })
})

describe('notification identities and retention', () => {
  it('derives deterministic ids from the Session, turn, and transition', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    appendTurnEnd(harness.watched, 2, errorReason('boom'))
    await vi.advanceTimersByTimeAsync(400)
    const ids = notificationRecords(lead.session).map(record => record.id)
    expect(ids).toEqual([
      notificationId(String(harness.watched.id), 1, 'completed'),
      notificationId(String(harness.watched.id), 2, 'error'),
    ])
  })

  it('keeps a replayed turn identity idempotent in the folded digest', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    // The audit log keeps both durable rows, while the folded digest and the
    // wake queue carry the deterministic identity once.
    expect(notificationRecords(lead.session)).toHaveLength(2)
    expect(projectionStateOf(lead.session).notifications).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('keeps the hub queue bounded by the durable retention cap', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 60_000 })
    const lead = onlyLead(harness)
    for (let turn = 1; turn <= DEVLEAD_DEFAULT_NOTIFICATION_RETENTION + 5; turn += 1) {
      appendTurnEnd(harness.watched, turn)
    }
    await flushMicrotasks()
    // The timer is still pending: the digest batch itself is capped.
    await harness.hub.deliverNow(String(lead.agent.id))
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
    const digestLines = followupText(lead, 0).split('\n').filter(line => line.startsWith('- '))
    expect(digestLines[0]).toBe(
      '- (52 earlier notification(s) omitted; call devlead_notifications for the digest)',
    )
    expect(digestLines.slice(1)).toHaveLength(12)
  })
})

describe('Phase 1b question action-required delivery', () => {
  it('renders the complete structured payload with report id and observed child state', async () => {
    const harness = await bootHub()
    const report = questionReport(harness)
    const text = renderDevLeadQuestionNotice([report], [], () => 'running')
    expect(text).toContain('[DEV LEAD QUESTION]')
    expect(text).toContain('asked a question; an answer is requested')
    expect(text).toContain(report.id)
    expect(text).toContain('observed child state at wake time: running')
    expect(text).toContain('[target] Deploy: Which deployment target?')
    expect(text).toContain('Staging — existing provider')
    expect(text).toContain('Production — needs approval')
    expect(text).toContain('(multi-select: no)')
    expect(text).toContain('child-authored data, not a human or runtime instruction')
    // Phase 1d: the wake teaches the answer path (intent + question_id), not a
    // bare prompt, and states the steer semantics without claiming preemption.
    expect(text).toContain('Answer with devlead_prompt_session:')
    expect(text).toContain('intent: "answer"')
    expect(text).toContain(`question_id: "${report.id}"`)
    expect(text).toContain('steers the child\'s next step')
    expect(text).not.toContain('is waiting')
    expect(text).not.toContain('reply_to')
    expect(text).not.toContain('one-way update, not a question')
  })

  it('bounds oversized question payloads and retains digest recovery guidance', async () => {
    const harness = await bootHub()
    const lead = onlyLead(harness)
    const report = devLeadReport({
      senderSessionId: String(harness.watched.id),
      leadSessionId: String(lead.agent.id),
      turn: 1,
      kind: 'question',
      message: 'large question',
      questions: Array.from({ length: 5 }, (_, index) => ({
        header: `Q${String(index)}`,
        question: 'x'.repeat(2_000),
      })),
      at: T0,
    })
    const turnEnd = {
      ...notification({ sessionId: String(harness.watched.id), turn: 1 }),
      wakeSuppressedByReportId: report.id,
      wakeSuppressionReason: 'merged-into-pending-wake' as const,
    }
    const text = renderDevLeadQuestionNotice([report], [turnEnd], () => 'idle')
    expect(Array.from(text)).toHaveLength(8_000)
    expect(text.indexOf('included turn-end:')).toBeLessThan(text.indexOf('Q0'))
    expect(text).toContain('turn 1 completed')
    expect(text).toContain(report.id)
    expect(text).toContain('Q0')
    expect(text).toContain('x'.repeat(200))
    expect(text).toContain('call devlead_notifications for the full question text')
  })

  it('steers immediately despite the ordinary batch window and a queued turn notice', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const child = new FakeAgent(harness.watched)
    child.setRunning(true)
    harness.agents.add(child)
    lead.agent.followup(createDevLeadNoticeMessage('existing turn notice', {
      lane: 'turn-notice', wakeRequested: true, summary: 'Existing notice',
    }))
    const report = questionReport(harness)
    expect(harness.hub.report(report)).toBe(true)
    expect(lead.agent.steers).toHaveLength(0)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(1)
    expect(lead.agent.inbox.nextStep).toHaveLength(1)
    expect(lead.agent.steers[0]?.source).toMatchObject({
      kind: 'devlead', form: 'notice', lane: 'action-required', wakeRequested: true, reportId: report.id,
    })
    expect(steerText(lead, 0)).toContain('Which deployment target?')
    expect(steerText(lead, 0)).toContain('observed child state at wake time: running')
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('routes every non-question report kind to its Phase 1e lane', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    for (const kind of ['progress', 'fyi', 'blocked', 'decision'] as const) {
      expect(harness.hub.report(devLeadReport({
        senderSessionId: String(harness.watched.id),
        leadSessionId: String(lead.agent.id),
        turn: 1,
        kind,
        message: `${kind} rides its lane`,
        at: T0,
      }))).toBe(true)
    }
    // P1/P2 inject synchronously through the background lane (no queue/timer).
    expect(lead.agent.injects).toHaveLength(2)
    for (const [index, kind] of (['progress', 'fyi'] as const).entries()) {
      const message = lead.agent.injects[index]!
      expect(message.source).toMatchObject({
        kind: 'devlead', form: 'notice', lane: 'background', wakeRequested: false,
      })
      expect(messageText(message)).toContain('[DEV LEAD REPORT]')
      expect(messageText(message)).toContain('no action required and no wake was requested')
      expect(messageText(message)).toContain(`${kind} rides its lane`)
    }
    // P3/P4 steer on the immediate action-required microtask, one wake per
    // header family, never behind the turn-notice coalescing window.
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    expect(lead.agent.steers[0]?.source).toMatchObject({
      kind: 'devlead', form: 'notice', lane: 'action-required', wakeRequested: true,
    })
    expect(steerText(lead, 0)).toContain('[DEV LEAD ACTION REQUIRED]')
    expect(steerText(lead, 0)).toContain('blocked rides its lane')
    expect(steerText(lead, 0)).toContain('decision rides its lane')
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(lead.agent.steers).toHaveLength(1)
  })

  it('rejects the seventeenth pending question explicitly instead of evicting one silently', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const reports = Array.from({ length: DEVLEAD_ACTION_REQUIRED_PENDING_MAX }, (_, index) => (
      questionReport(harness, `Question ${String(index)}?`)
    ))
    for (const report of reports) expect(harness.hub.report(report)).toBe(true)
    // An existing identity is a retry, not a seventeenth distinct question.
    expect(harness.hub.report(reports[0]!)).toBe(true)
    const runtime = (harness.hub as unknown as {
      leads: Map<string, { pendingActionReports: readonly unknown[] }>
    }).leads.get(String(lead.agent.id))
    expect(runtime?.pendingActionReports).toHaveLength(DEVLEAD_ACTION_REQUIRED_PENDING_MAX)
    expect(() => harness.hub.report(questionReport(harness, 'One question too many?'))).toThrowError(
      expect.objectContaining({ code: 'DEVLEAD_DELIVERY_RATE_LIMITED' }),
    )
    expect(runtime?.pendingActionReports).toHaveLength(DEVLEAD_ACTION_REQUIRED_PENDING_MAX)
    expect(projectionStateOf(lead.session).reports).toHaveLength(DEVLEAD_ACTION_REQUIRED_PENDING_MAX)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(runtime?.pendingActionReports).toHaveLength(0)
  })

  it('admits action-required before an ordinary zero-delay flush scheduled first', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 0 })
    const lead = onlyLead(harness)
    // The T1 turn-end schedules the ordinary zero-delay microtask flush first
    // (a different turn than the question, so no merge applies). The queued
    // flush must still admit the same-microtask action report's steer before
    // its own followup.
    appendTurnEnd(harness.watched, 2)
    harness.hub.report(questionReport(harness))
    await flushMicrotasks()
    expect(lead.agent.admissions).toEqual(['steer', 'followup'])
    expect(followupText(lead, 0)).toContain('— turn 2 completed')
  })

  it('merges a turn-end into a pending question wake without a second wake', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const report = questionReport(harness)
    harness.hub.report(report)
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    expect(steerText(lead, 0)).toContain('included turn-end:')
    expect(steerText(lead, 0)).toContain('turn 1 completed')
    expect(notificationRecords(lead.session)[0]).toMatchObject({
      wakeSuppressedByReportId: report.id,
      wakeSuppressionReason: 'merged-into-pending-wake',
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('marks an ordinary pending turn-end included only after the question steer succeeds', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    const report = questionReport(harness)
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
    expect(projectionStateOf(lead.session).notifications[0]).toMatchObject({
      wakeSuppressedByReportId: report.id,
      wakeSuppressionReason: 'included-in-sent-wake',
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('suppresses a replay only when the sent question wake included that exact turn-end', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const report = questionReport(harness)
    harness.hub.report(report)
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session).map(record => record.wakeSuppressionReason)).toEqual([
      'merged-into-pending-wake',
      'included-in-sent-wake',
    ])
  })

  it('retains T1 with assistant content when the sent question did not include the turn-end', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.hub.report(questionReport(harness))
    await flushMicrotasks()
    appendAssistantMessage(harness.watched, 1, 'Please answer the deployment question above.')
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain('[DEV LEAD NOTIFICATION]')
    expect(followupText(lead, 0)).toContain('Please answer the deployment question above.')
    expect(notificationRecords(lead.session)[0]).not.toHaveProperty('wakeSuppressedByReportId')
  })

  it('retains T2 when the sent question did not include the failed turn-end', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.hub.report(questionReport(harness))
    await flushMicrotasks()
    appendTurnEnd(harness.watched, 1, errorReason('provider failed'))
    // Phase 1e: T2 itself rides the action-required review lane. The lead is
    // idle, so the parked question wake does not deadlock the review admission
    // (the first pre-step claims both next-step rows).
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(2)
    expect(steerText(lead, 1)).toContain('[DEV LEAD REVIEW REQUIRED]')
    expect(steerText(lead, 1)).toContain('turn 1 failed: provider failed')
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)[0]).not.toHaveProperty('wakeSuppressionReason')
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('does not suppress an ambiguous turn-end shared by multiple pending questions', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.hub.report(questionReport(harness, 'First question?'))
    harness.hub.report(questionReport(harness, 'Second question?'))
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(steerText(lead, 0)).toContain('First question?')
    expect(steerText(lead, 0)).toContain('Second question?')
    expect(steerText(lead, 0)).not.toContain('included turn-end:')
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(notificationRecords(lead.session)[0]).not.toHaveProperty('wakeSuppressedByReportId')
  })

  it('restores a merged question after steer failure and retries without a T1 wake', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 60_000 })
    const lead = onlyLead(harness)
    lead.agent.failSteers = 1
    appendTurnEnd(harness.watched, 1)
    const report = questionReport(harness)
    harness.hub.report(report)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(0)
    // The failed admission must not mark the ordinary T1 as included in a sent
    // wake, and must leave its ordinary pending queue untouched for the retry.
    expect(notificationRecords(lead.session)).toHaveLength(1)
    expect(notificationRecords(lead.session)[0]).not.toHaveProperty('wakeSuppressedByReportId')
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(steerText(lead, 0)).toContain('included turn-end:')
    expect(notificationRecords(lead.session)[1]).toMatchObject({
      wakeSuppressedByReportId: report.id,
      wakeSuppressionReason: 'included-in-sent-wake',
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('holds another question behind an unclaimed action wake, then retries after drain', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    lead.agent.setRunning(true)
    harness.hub.report(questionReport(harness, 'First question?'))
    await flushMicrotasks()
    harness.hub.report(questionReport(harness, 'Second question?'))
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    lead.agent.drainInbox()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(2)
    expect(steerText(lead, 1)).toContain('Second question?')
  })

  it('models durable admission and next-step/next-turn canceled clear order', async () => {
    const harness = await bootHub()
    const lead = onlyLead(harness)
    lead.agent.followup(createDevLeadNoticeMessage('ordinary'))
    lead.agent.steer(createDevLeadNoticeMessage('question', {
      lane: 'action-required', wakeRequested: true, summary: 'Question',
    }))
    lead.agent.cancelInbox()
    expect(lead.agent.inbox.nextStep).toHaveLength(0)
    expect(lead.agent.inbox.nextTurn).toHaveLength(0)
    const splices = lead.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')
    expect(splices).toHaveLength(4)
    expect(splices.slice(-2).map(event => ({
      target: event.data.target,
      removedCount: event.data.removedCount,
      outcome: event.data.outcome,
    }))).toEqual([
      { target: 'next-step', removedCount: 1, outcome: 'canceled' },
      { target: 'next-turn', removedCount: 1, outcome: 'canceled' },
    ])
    expect(lead.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
  })

  it('lets an idle lead admit a new steer that wakes a parked next-step action wake', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    lead.agent.setRunning(true)
    harness.hub.report(questionReport(harness, 'Parked question?'))
    await flushMicrotasks()
    expect(lead.agent.inbox.nextStep).toHaveLength(1)
    // Dispose/abort leaves the durable action message parked. Idle admission is
    // the wake path: the first pre-step consumes both old and new next-step rows.
    lead.agent.setRunning(false)
    harness.hub.report(questionReport(harness, 'Wake the parked question?'))
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(2)
    const claimed = lead.agent.claimNextTurnPreStep()
    expect(claimed.map(message => messageText(message))).toEqual([
      expect.stringContaining('Parked question?'),
      expect.stringContaining('Wake the parked question?'),
    ])
    expect(lead.agent.inbox.nextStep).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(lead.agent.steers).toHaveLength(2)
  })

  it('detects an aborted activity action wake reclassified to next-turn', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    lead.agent.setRunning(true)
    lead.agent.abortedActivity = true
    harness.hub.report(questionReport(harness, 'Aborted question?'))
    await flushMicrotasks()
    expect(lead.agent.inbox.nextStep).toHaveLength(0)
    expect(lead.agent.inbox.nextTurn).toHaveLength(1)
    lead.agent.abortedActivity = false
    harness.hub.report(questionReport(harness, 'Duplicate while running?'))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lead.agent.steers).toHaveLength(1)
    // Once idle, admission wakes both boundaries instead of spinning behind the
    // reclassified message. First pre-step order is next-step then next-turn.
    lead.agent.setRunning(false)
    harness.ctx.emit('agent/status', { agent: lead.agent.agent, status: 'idle' })
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(2)
    const claimed = lead.agent.claimNextTurnPreStep()
    expect(claimed.map(message => messageText(message))).toEqual([
      expect.stringContaining('Duplicate while running?'),
      expect.stringContaining('Aborted question?'),
    ])
  })

  it('pins admission versus presented when a pre-step reject consumes the question', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.hub.report(questionReport(harness))
    await flushMicrotasks()
    const message = lead.agent.steers[0]!
    const claimed = lead.agent.claimNextStep({ present: false })
    expect(claimed.map(item => item.id)).toEqual([message.id])
    expect(lead.agent.inbox.nextStep).toHaveLength(0)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(2)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
    // Phase 1b has no presented/open-question replay: the durable report digest
    // is the recovery surface, not an automatic second steer.
    expect(projectionStateOf(lead.session).reports).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(lead.agent.steers).toHaveLength(1)
  })

  it('keeps only the digest fallback when archive races an admitted but rejected question', async () => {
    installFakeTimers()
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootHub({ batchMs: 400, workspaceRegistry: registry })
    const lead = onlyLead(harness)
    harness.hub.report(questionReport(harness, 'Admitted before archive?'))
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    registry.archived = [String(lead.agent.id)]
    const claimed = lead.agent.claimNextStep({ present: false })
    expect(claimed).toHaveLength(1)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
    harness.hub.report(questionReport(harness, 'Archived after admission?'))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lead.agent.steers).toHaveLength(1)
    expect(projectionStateOf(lead.session).reports).toHaveLength(2)
  })

  it.each(['archived', 'unwatched', 'mode-off'] as const)('keeps suppression metadata as a decision record after %s drops the pending wake', async disposition => {
    installFakeTimers()
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootHub({ batchMs: 400, workspaceRegistry: registry })
    const lead = onlyLead(harness)
    const report = questionReport(harness)
    harness.hub.report(report)
    appendTurnEnd(harness.watched, 1)
    if (disposition === 'archived') registry.archived = [String(lead.agent.id)]
    if (disposition === 'unwatched') {
      appendPluginRecord(lead.session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([], T0 + 2))
    }
    if (disposition === 'mode-off') {
      appendPluginRecord(lead.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(false, T0 + 2))
    }
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.steers).toHaveLength(0)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)[0]).toMatchObject({
      wakeSuppressedByReportId: report.id,
      wakeSuppressionReason: 'merged-into-pending-wake',
    })
    expect(projectionStateOf(lead.session).reports).toHaveLength(1)
  })

  it('resumes a cold lead and steers without waiting for the ordinary batch window', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, sessionController: controller })
    const lead = onlyLead(harness)
    controller.resolveHandler = () => {
      harness.agents.add(lead.agent)
      return { agent: lead.agent.agent }
    }
    harness.agents.remove(String(lead.agent.id))
    harness.hub.report(questionReport(harness))
    await flushMicrotasks()
    expect(controller.resolveCalls.map(String)).toEqual([String(lead.agent.id)])
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
  })

  it('keeps a cold question digest-only when cold wake is disabled', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, wakeColdSession: false, sessionController: controller })
    const lead = onlyLead(harness)
    harness.agents.remove(String(lead.agent.id))
    harness.hub.report(questionReport(harness))
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(controller.resolveCalls).toEqual([])
    expect(lead.agent.steers).toHaveLength(0)
    expect(projectionStateOf(lead.session).reports).toHaveLength(1)
    harness.agents.add(lead.agent)
    await harness.hub.deliverNow(String(lead.agent.id))
    expect(lead.agent.steers).toHaveLength(1)
  })

  it('keeps an archived question in the digest without resume, steer, or followup', async () => {
    installFakeTimers()
    const registry = new FakeWorkspaceRegistry()
    const harness = await bootHub({ batchMs: 400, workspaceRegistry: registry })
    const lead = onlyLead(harness)
    registry.archived = [String(lead.agent.id)]
    expect(harness.hub.report(questionReport(harness))).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(lead.agent.steers).toHaveLength(0)
    expect(lead.agent.followups).toHaveLength(0)
    expect(projectionStateOf(lead.session).reports).toHaveLength(1)
  })
})

/** Sum one background-lane delivery outcome from the shared metrics registry. */
function backgroundOutcome(harness: HubHarness, outcome: string): number {
  return harness.metrics.snapshot()
    .filter(sample => sample.name === 'devlead_delivery_total'
      && sample.labels.lane === 'background'
      && sample.labels.outcome === outcome)
    .reduce((total, sample) => total + sample.value, 0)
}

describe('Phase 1e background report receipt retry', () => {
  it('retries a live background report receipt append failure and injects exactly once', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const report = devLeadReport({
      senderSessionId: String(harness.watched.id),
      leadSessionId: String(lead.agent.id),
      turn: 1,
      kind: 'progress',
      message: 'retry this receipt',
      at: T0,
    })
    const commit = vi.spyOn(lead.session as unknown as { commit: (...args: unknown[]) => unknown }, 'commit')
      .mockImplementationOnce(() => { throw new Error('disk full') })
    expect(harness.hub.report(report)).toBe(true)
    commit.mockRestore()
    // The append failure must not masquerade as cold-observed digest-only: the
    // live lane is pending and will retry.
    expect(lead.agent.injects).toHaveLength(0)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('pending')
    expect(backgroundOutcome(harness, 'queued')).toBe(1)
    expect(backgroundOutcome(harness, 'digest-only')).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(lead.agent.injects).toHaveLength(1)
    expect(messageText(lead.agent.injects[0]!)).toContain('retry this receipt')
    expect(lead.agent.injects[0]?.source).toMatchObject({
      kind: 'devlead', form: 'notice', lane: 'background', wakeRequested: false, reportId: report.id,
    })
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('delivered')
    expect(backgroundOutcome(harness, 'delivered')).toBe(1)
    expect(projectionStateOf(lead.session).reports).toHaveLength(1)
    // No timer-driven duplicate inject on later ticks.
    await vi.advanceTimersByTimeAsync(10_000)
    await flushMicrotasks()
    expect(lead.agent.injects).toHaveLength(1)
  })

  it('drains a live background receipt retry immediately through deliverNow', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const report = devLeadReport({
      senderSessionId: String(harness.watched.id),
      leadSessionId: String(lead.agent.id),
      turn: 1,
      kind: 'progress',
      message: 'drain me now',
      at: T0,
    })
    const commit = vi.spyOn(lead.session as unknown as { commit: (...args: unknown[]) => unknown }, 'commit')
      .mockImplementationOnce(() => { throw new Error('disk full') })
    expect(harness.hub.report(report)).toBe(true)
    commit.mockRestore()
    await harness.hub.deliverNow(String(lead.agent.id))
    expect(lead.agent.injects).toHaveLength(1)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('delivered')
    // The manual drain cleared the pending retry timer; no duplicate inject.
    await vi.advanceTimersByTimeAsync(10_000)
    await flushMicrotasks()
    expect(lead.agent.injects).toHaveLength(1)
  })

  it('bounds background receipt retries and degrades to digest-only after the cap', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const report = devLeadReport({
      senderSessionId: String(harness.watched.id),
      leadSessionId: String(lead.agent.id),
      turn: 1,
      kind: 'fyi',
      message: 'never appendable',
      at: T0,
    })
    const commit = vi.spyOn(lead.session as unknown as { commit: (...args: unknown[]) => unknown }, 'commit')
      .mockImplementation(() => { throw new Error('disk full') })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    expect(harness.hub.report(report)).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    commit.mockRestore()
    expect(lead.agent.injects).toHaveLength(0)
    expect(harness.hub.deliveryStateOf(String(lead.agent.id), report.id)).toBe('digest-only')
    expect(backgroundOutcome(harness, 'failed')).toBe(1)
    expect(warn.mock.calls.some(([message]) => String(message).includes('gave up delivering'))).toBe(true)
    // The bounded loop cleared its timer instead of retrying forever.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a cold-observed background report digest-only and counts it once', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [] })
    const watchedId = String(harness.watched.id)
    const coldLeadId = 'cold-background-lead'
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [watchedId] }])
    const report = devLeadReport({
      senderSessionId: watchedId,
      leadSessionId: coldLeadId,
      turn: 1,
      kind: 'progress',
      message: 'cold context',
      at: T0,
    })
    expect(harness.hub.report(report)).toBe(true)
    expect(harness.hub.deliveryStateOf(coldLeadId, report.id)).toBe('digest-only')
    // Exactly one digest-only transition, even after the receipt is persisted.
    expect(backgroundOutcome(harness, 'digest-only')).toBe(1)
    const agent = attachPersistedLead(harness.ctx, harness.agents, { sessionId: coldLeadId, watched: [watchedId] })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    await flushMicrotasks()
    expect(projectionStateOf(agent.session).reports).toHaveLength(1)
    expect(agent.injects).toHaveLength(0)
    expect(harness.hub.deliveryStateOf(coldLeadId, report.id)).toBe('digest-only')
    expect(backgroundOutcome(harness, 'digest-only')).toBe(1)
  })

  it('drops the retry timer when the hub is disposed before the append succeeds', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const report = devLeadReport({
      senderSessionId: String(harness.watched.id),
      leadSessionId: String(lead.agent.id),
      turn: 1,
      kind: 'progress',
      message: 'dispose while pending',
      at: T0,
    })
    const commit = vi.spyOn(lead.session as unknown as { commit: (...args: unknown[]) => unknown }, 'commit')
      .mockImplementationOnce(() => { throw new Error('disk full') })
    expect(harness.hub.report(report)).toBe(true)
    commit.mockRestore()
    await harness.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lead.agent.injects).toHaveLength(0)
  })
})

describe('cold lead delivery', () => {
  it('keeps the digest pending while the lead Agent is cold and delivers on demand', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, wakeColdSession: false })
    const lead = onlyLead(harness)
    harness.agents.remove(String(lead.agent.id))
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toHaveLength(1)
    harness.agents.add(lead.agent)
    await harness.hub.deliverNow(String(lead.agent.id))
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('resumes a cold lead Session when wakeColdSession is enabled', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, wakeColdSession: true, sessionController: controller })
    const lead = onlyLead(harness)
    controller.resolveHandler = () => {
      // A real resume leaves the Agent live in the registry.
      harness.agents.add(lead.agent)
      return { agent: lead.agent.agent }
    }
    harness.agents.remove(String(lead.agent.id))
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(controller.resolveCalls.map(String)).toEqual([String(lead.agent.id)])
    // The resumed Agent is re-synced and the still-pending digest flushes.
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('keeps the digest pending after a failed cold resume and delivers later', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, wakeColdSession: true, sessionController: controller })
    const lead = onlyLead(harness)
    controller.resolveHandler = () => ({ error: { message: 'busy', code: 'session/agent-busy' } })
    harness.agents.remove(String(lead.agent.id))
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(controller.resolveCalls).toHaveLength(1)
    expect(lead.agent.followups).toHaveLength(0)
    controller.resolveHandler = () => {
      harness.agents.add(lead.agent)
      return { agent: lead.agent.agent }
    }
    await harness.hub.deliverNow(String(lead.agent.id))
    // The resume re-indexes the Agent and arms the digest for the batch window.
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(lead.agent.followups).toHaveLength(1)
  })

  it('gives up resuming a cold lead after the bounded attempt cap and warns', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, wakeColdSession: true, sessionController: controller })
    const lead = onlyLead(harness)
    controller.resolveHandler = () => ({ error: { message: 'busy', code: 'session/agent-busy' } })
    harness.agents.remove(String(lead.agent.id))
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    // Each failed resume arms one 1s retry, up to the attempt cap.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await vi.advanceTimersByTimeAsync(1_000)
      await flushMicrotasks()
    }
    expect(controller.resolveCalls).toHaveLength(5)
    expect(warn.mock.calls.some(call => String(call[0]).includes('giving up resuming cold lead'))).toBe(true)
    expect(notificationRecords(lead.session)).toHaveLength(1)
    warn.mockRestore()
  })

  it('does not resume a cold lead without a Session controller', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, wakeColdSession: true })
    const lead = onlyLead(harness)
    harness.agents.remove(String(lead.agent.id))
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toHaveLength(1)
  })
})

describe('cold rehydration', () => {
  it('indexes a rehydrated cold lead and keeps its digest until the Session is opened', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [] })
    const coldLeadId = 'cold-lead-open'
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [watchedId] }])
    appendTurnEnd(harness.watched, 1)
    // Cold lead, no Session controller: the wake is kept queued (and no durable
    // record can be appended yet).
    await vi.advanceTimersByTimeAsync(400)
    // A human opens the Session: its log is attached, the Agent is announced,
    // and the queued observation is written and delivered.
    const agent = attachPersistedLead(harness.ctx, harness.agents, {
      sessionId: coldLeadId,
      watched: [watchedId],
    })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(agent.followups).toHaveLength(1)
    expect(messageText(agent.followups[0]!)).toContain('— turn 1 completed')
    expect(notificationRecords(agent.session)).toHaveLength(1)
  })

  it('resumes a rehydrated cold lead by default and writes the queued record first', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, leads: [], sessionController: controller })
    const coldLeadId = 'cold-lead-resume'
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [watchedId] }])
    let live: FakeAgent | undefined
    controller.resolveHandler = () => {
      live = attachPersistedLead(harness.ctx, harness.agents, {
        sessionId: coldLeadId,
        watched: [watchedId],
      })
      return { agent: live.agent }
    }
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    // Cold wake is the DEFAULT (wakeColdSession: true) now.
    expect(controller.resolveCalls.map(String)).toEqual([coldLeadId])
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(live?.followups).toHaveLength(1)
    expect(notificationRecords(live!.session)).toHaveLength(1)
  })

  it('keeps a rehydrated cold lead quiet when wakeColdSession is disabled', async () => {
    installFakeTimers()
    const controller = new FakeSessionController()
    const harness = await bootHub({ batchMs: 400, leads: [], wakeColdSession: false, sessionController: controller })
    const coldLeadId = 'cold-lead-wait'
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [watchedId] }])
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(controller.resolveCalls).toEqual([])
    // A human opening the Session persists the waiting record and delivers it.
    const agent = attachPersistedLead(harness.ctx, harness.agents, {
      sessionId: coldLeadId,
      watched: [watchedId],
    })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(agent.followups).toHaveLength(1)
    expect(notificationRecords(agent.session)).toHaveLength(1)
  })

  it('is idempotent across repeated rehydrate calls', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [] })
    const watchedId = String(harness.watched.id)
    const record = { sessionId: 'cold-lead-idempotent', watched: [watchedId] } as const
    harness.hub.rehydrate([record])
    harness.hub.rehydrate([record])
    const agent = attachPersistedLead(harness.ctx, harness.agents, {
      sessionId: record.sessionId,
      watched: [watchedId],
    })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(agent.followups).toHaveLength(1)
    expect(notificationRecords(agent.session)).toHaveLength(1)
  })

  it('drops a notification of a Session that a later rehydrate says is no longer watched', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [] })
    const coldLeadId = 'cold-lead-unwatch'
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [watchedId] }])
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    // The latest durable watch set is authoritative: the retained (unsaved)
    // observation is filtered out.
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [] }])
    const agent = attachPersistedLead(harness.ctx, harness.agents, { sessionId: coldLeadId, watched: [] })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(agent.followups).toHaveLength(0)
    expect(notificationRecords(agent.session)).toEqual([])
  })

  it('filters a persisted self-watch during rehydrate with one warning', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [] })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const coldLeadId = 'cold-lead-self'
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: coldLeadId, watched: [coldLeadId, watchedId] }])
    const agent = attachPersistedLead(harness.ctx, harness.agents, {
      sessionId: coldLeadId,
      watched: [coldLeadId, watchedId],
    })
    harness.ctx.emit('agent/created', { agent: agent.agent, source: 'resume' })
    appendTurnEnd(agent.session, 1)
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(warn.mock.calls.some(call => String(call[0]).includes('lists itself'))).toBe(true)
    // The self entry was ignored: only the watched Session's turn notified.
    expect(notificationRecords(agent.session)).toHaveLength(1)
    expect(notificationRecords(agent.session)[0]?.sessionId).toBe(watchedId)
    warn.mockRestore()
  })

  it('is safe to call before start', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, leads: [], start: false })
    const watchedId = String(harness.watched.id)
    harness.hub.rehydrate([{ sessionId: 'cold-lead-early', watched: [watchedId] }])
    const agent = attachPersistedLead(harness.ctx, harness.agents, {
      sessionId: 'cold-lead-early',
      watched: [watchedId],
    })
    harness.hub.start()
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(agent.followups).toHaveLength(1)
    expect(notificationRecords(agent.session)).toHaveLength(1)
  })
})

describe('reset record resync', () => {
  it('drops the lead index when a reset record disables its durable state', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendPluginRecord(lead.session, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0 + 1))
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toEqual([])
    // A clean re-enable rebuilds the index from the durable state.
    appendPluginRecord(lead.session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0 + 2))
    appendPluginRecord(lead.session, DEVLEAD_WATCH_RECORD_TYPE, watchRecord([String(harness.watched.id)], T0 + 2))
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(messageText(lead.agent.followups[0]!)).toContain('— turn 2 completed')
    expect(notificationRecords(lead.session)).toHaveLength(1)
  })
})

describe('notification durability checkpoint', () => {
  it('flushes the lead Session after appending a notification record', async () => {
    const harness = await bootHub({ batchMs: 60_000 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    // The digest is still inside its coalescing window; the record append alone
    // must already have triggered a fire-and-forget durability checkpoint.
    expect(lead.agent.followups).toHaveLength(0)
    expect(harness.flushCalls).toContain(String(lead.agent.id))
  })

  it('warns but still queues the wake when the record checkpoint fails', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400, flushFailure: new Error('disk offline') })
    const lead = onlyLead(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    expect(warn.mock.calls.some(call => String(call[0]).includes('could not be flushed to persistence'))).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(notificationRecords(lead.session)).toHaveLength(1)
    warn.mockRestore()
  })
})

describe('corrupt replay warnings', () => {
  it('warns once across a dispose/reopen and again only after a valid state', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const corrupt = { kind: 'devlead/watch', version: 1, sessions: 'no', at: T0 } as never
    const replayWarnings = () => warn.mock.calls.filter(call => String(call[0]).includes('replay failed'))
    appendPluginRecord(lead.session, DEVLEAD_WATCH_RECORD_TYPE, corrupt)
    await flushMicrotasks()
    expect(replayWarnings()).toHaveLength(1)
    // Disposal no longer drops the runtime; even if it did, the remembered
    // failure must survive it: the same damaged Session warns once per Host.
    harness.ctx.emit('agent/disposed', { agent: lead.agent.agent })
    harness.agents.add(lead.agent)
    harness.ctx.emit('agent/created', { agent: lead.agent.agent, source: 'resume' })
    await flushMicrotasks()
    expect(replayWarnings()).toHaveLength(1)
    // A valid state (the reset record unfreezes the fold) clears the marker, so
    // a later corruption warns again.
    appendPluginRecord(lead.session, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0 + 1))
    await flushMicrotasks()
    expect(projectionStateOf(lead.session).failure).toBeNull()
    appendPluginRecord(lead.session, DEVLEAD_WATCH_RECORD_TYPE, corrupt)
    await flushMicrotasks()
    expect(replayWarnings()).toHaveLength(2)
    warn.mockRestore()
  })

  it('bounds the remembered failure ids with FIFO eviction', async () => {
    const harness = await bootHub({ batchMs: 400, leads: [] })
    const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => undefined)
    const corrupt = { kind: 'devlead/watch', version: 1, sessions: 'no', at: T0 } as never
    const ids: string[] = []
    for (let index = 0; index < DEVLEAD_MAX_WARNED_FAILURES + 4; index += 1) {
      const id = `corrupt-lead-${String(index)}`
      ids.push(id)
      const session = harness.ctx.sessions.create(SessionId(id))
      harness.agents.add(new FakeAgent(session))
      appendPluginRecord(session, DEVLEAD_WATCH_RECORD_TYPE, corrupt)
    }
    await flushMicrotasks()
    const warned = (harness.hub as unknown as { warnedFailures: Set<string> }).warnedFailures
    expect(warned.size).toBe(DEVLEAD_MAX_WARNED_FAILURES)
    expect(warned.has(ids[0]!)).toBe(false)
    expect(warned.has(ids.at(-1)!)).toBe(true)
    warn.mockRestore()
  })
})

describe('durable observation of foreign transitions', () => {
  it('keeps the notification timestamp equal to the settled turn event time', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    const event = appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(notificationRecords(lead.session)[0]?.at).toBe(event.time)
    expect(notificationRecords(lead.session)[0]?.turn).toBe(1)
  })
})
