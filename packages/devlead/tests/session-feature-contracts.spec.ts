/** Focused acceptance coverage for report excerpts, cancellation, and archive unwatch. */

import { afterEach, describe, expect, it } from 'vitest'
import { DEVLEAD_ASSISTANT_EXCERPT_MAX } from '@yankeguo/dsh-devlead-protocol'
import {
  FakeAgent,
  FakeSessionQuery,
  FakeWorkspaceRegistry,
  appendAssistantMessage,
  appendTurnEnd,
  appendTurnStart,
  bootHub,
  bootService,
  disposeHarnesses,
  flushMicrotasks,
  messageText,
  notificationRecords,
} from './harness.ts'
import { notification, sessionEvent } from './fixtures.ts'
import { renderDevLeadNotice } from '../src/notification.ts'

afterEach(async () => {
  await disposeHarnesses()
})

describe('latest-assistant report contracts', () => {
  it('uses 4096 by default, honors custom limits, and reports truncation without splitting Unicode', async () => {
    const query = new FakeSessionQuery()
    const text = '🙂'.repeat(DEVLEAD_ASSISTANT_EXCERPT_MAX + 100)
    query.seed('cold-report', [sessionEvent(0, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text }] },
      stream: [],
    })])
    const harness = await bootService({ enabled: true, sessionQuery: query })
    const bounded = await harness.service.getSession(harness.lead.agent, 'cold-report')
    expect(Array.from(bounded.lastAssistant ?? '')).toHaveLength(DEVLEAD_ASSISTANT_EXCERPT_MAX)
    expect(bounded.lastAssistant?.endsWith('…')).toBe(true)
    expect(bounded.lastAssistantTruncated).toBe(true)
    expect(bounded.lastAssistant).not.toContain('�')
    const custom = await harness.service.getSession(harness.lead.agent, 'cold-report', undefined, 12)
    expect(Array.from(custom.lastAssistant ?? '')).toHaveLength(12)
    expect(custom.lastAssistantTruncated).toBe(true)
    const complete = await harness.service.getSession(
      harness.lead.agent,
      'cold-report',
      undefined,
      DEVLEAD_ASSISTANT_EXCERPT_MAX + 100,
    )
    expect(complete.lastAssistant).toBe(text)
    expect(complete.lastAssistantTruncated).toBe(false)
    await expect(harness.service.getSession(harness.lead.agent, 'cold-report', undefined, 0))
      .rejects.toMatchObject({ code: 'DEVLEAD_INVALID_INPUT' })
  })

  it('carries the same bound and explicit truncation marker in a wake', async () => {
    const harness = await bootHub({ batchMs: 0 })
    appendAssistantMessage(harness.watched, 1, 'x'.repeat(DEVLEAD_ASSISTANT_EXCERPT_MAX + 20))
    appendTurnEnd(harness.watched, 1)
    await flushMicrotasks()
    const notification = notificationRecords(harness.leads[0]!.session)[0]
    expect(notification?.summary).toHaveLength(DEVLEAD_ASSISTANT_EXCERPT_MAX)
    expect(notification?.summaryTruncated).toBe(true)
    const lead = harness.leads[0]!
    const wake = messageText(lead.agent.followups[0]!)
    expect(wake).toContain('[DEV LEAD NOTIFICATION]')
    expect(wake).toContain('[truncated]')
    expect(wake).toContain('x'.repeat(240))
    expect(lead.agent.steers).toHaveLength(0)
  })

  it('bounds the aggregate wake even when several summaries hit the per-item limit', () => {
    const wake = renderDevLeadNotice(Array.from({ length: 4 }, (_, index) => notification({
      sessionId: `long-report-${String(index)}`,
      summary: '🙂'.repeat(DEVLEAD_ASSISTANT_EXCERPT_MAX),
      summaryTruncated: true,
    })))
    expect(Array.from(wake).length).toBeLessThanOrEqual(8_000)
    expect(wake).toContain('Wake payload truncated; call devlead_notifications / devlead_get_session')
    expect(wake).not.toContain('�')
  })
})

describe('lead-requested interrupt classification', () => {
  it('downgrades only the matching delayed cancellation and preserves external abort review', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target'],
      watched: ['target'],
      config: { notificationBatchMs: 0 },
    })
    const target = new FakeAgent(harness.sessions.target!)
    target.setRunning(true)
    harness.agents.add(target)
    appendTurnStart(harness.sessions.target!, 1)
    await harness.service.promptSession(harness.lead.agent, 'target', 'replace', { interrupt: true })
    // Deliberately publish turn/end after the stop window has closed.
    appendTurnEnd(harness.sessions.target!, 1, { kind: 'aborted', reason: { kind: 'user' } })
    await flushMicrotasks()
    expect(harness.lead.steers).toHaveLength(0)
    const ordinaryWake = messageText(harness.lead.followups[0]!)
    expect(ordinaryWake).toContain('[DEV LEAD NOTIFICATION]')
    expect(ordinaryWake).toContain('cancelled by your interrupt')
    expect(ordinaryWake).toContain('cancelled')
    expect(notificationRecords(harness.leadSession)[0]).toMatchObject({
      transition: 'aborted',
      cancelledByLeadInterrupt: true,
    })

    appendTurnStart(harness.sessions.target!, 2)
    appendTurnEnd(harness.sessions.target!, 2, { kind: 'aborted', reason: { kind: 'user' } })
    await flushMicrotasks()
    const externalWake = messageText(harness.lead.steers[0]!)
    expect(externalWake).toContain('[DEV LEAD REVIEW REQUIRED]')
    expect(notificationRecords(harness.leadSession)[1]?.cancelledByLeadInterrupt).toBeUndefined()
  })
})

describe('archive unwatch', () => {
  it('unwatches successful archives but preserves the watch after an active refusal', async () => {
    const registry = new FakeWorkspaceRegistry()
    registry.add({ path: '/tmp/archive', sessionIds: ['target', 'active'] })
    registry.knownSessions.push('target', 'active')
    registry.activity.set('active', [{ kind: 'turn' }])
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target', 'active'],
      watched: ['target', 'active'],
      workspaceRegistry: registry,
    })
    const archived = await harness.service.archiveSession(harness.lead.agent, 'target')
    expect(archived).toMatchObject({ archived: true, watched: false })
    await expect(harness.service.archiveSession(harness.lead.agent, 'active'))
      .rejects.toMatchObject({ code: 'DEVLEAD_SESSION_ACTIVE' })
    expect(harness.service.view(harness.lead.agent).sessions).toEqual(['active'])
  })

})
