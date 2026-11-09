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
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification } from '@yankeguo/dsh-devlead-protocol'
import { modeRecord, watchRecord } from '../src/domain.ts'
import { renderDevLeadNotice } from '../src/notification.ts'
import type { HubHarness, HubLead } from './harness.ts'
import {
  FakeSessionController,
  FakeWorkspaceRegistry,
  T0,
  appendAssistantMessage,
  appendTurnEnd,
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

  it('carries the folded title and bounded failure excerpt into the digest', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.sessionTitle.set(String(harness.watched.id), 'api')
    appendTurnEnd(harness.watched, 1, errorReason('provider quota exhausted'))
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    expect(followupText(lead, 0)).toContain(
      `- api (${String(harness.watched.id)}) — turn 1 failed: provider quota exhausted`,
    )
    expect(notificationRecords(lead.session)[0]).toMatchObject({
      transition: 'error',
      error: 'provider quota exhausted',
      sessionTitle: 'api',
    })
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
    // degrades to `interrupted` instead of being dropped.
    harness.watched.append('turn/end', { turn: 1, reason: { kind: 'custom-future-kind' } as never })
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
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

  it('suppresses a second wake while an undelivered notice is already queued', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(1)
    appendTurnEnd(harness.watched, 2)
    await vi.advanceTimersByTimeAsync(400)
    // The queued notice already points the model at the digest tool, so the
    // second batch does not double the wake; both rows stay durable.
    expect(lead.agent.followups).toHaveLength(1)
    expect(notificationRecords(lead.session)).toHaveLength(2)
    // Once the loop drains the inbox, the next batch wakes again.
    lead.agent.drainInbox()
    appendTurnEnd(harness.watched, 3)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(2)
    expect(followupText(lead, 1)).toContain('— turn 3 completed')
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

  it('treats deliverNow for an unknown lead as a no-op', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    await expect(harness.hub.deliverNow('no-such-lead')).resolves.toBeUndefined()
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

  it('drops one disposed lead runtime without throwing', async () => {
    installFakeTimers()
    const harness = await bootHub({ batchMs: 400 })
    const lead = onlyLead(harness)
    harness.ctx.emit('agent/disposed', { agent: lead.agent.agent })
    appendTurnEnd(harness.watched, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(lead.agent.followups).toHaveLength(0)
    expect(notificationRecords(lead.session)).toEqual([])
    await expect(harness.hub.deliverNow(String(lead.agent.id))).resolves.toBeUndefined()
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
    expect(notificationRecords(lead.session)).toHaveLength(2)
    expect(projectionStateOf(lead.session).notifications).toHaveLength(1)
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
