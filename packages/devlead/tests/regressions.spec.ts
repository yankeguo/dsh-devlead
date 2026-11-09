/**
 * Regression coverage for review findings in the DevLead core:
 *
 * 1. The automatic watch performed by `promptSession` must not bypass the
 *    self-watch rejection (a lead watching itself would self-wake forever).
 * 2. A watched Session must survive `listSessions({ limit })` truncation, since
 *    relevance ordering is a contract of the row listing.
 * 3. Notification decoders must reject the empty-string values the projection
 *    wire/state schemas already reject, so a folded state always re-validates.
 */

import { describe, expect, it } from 'vitest'
import { DevLeadError, decodeNotification, devLeadNotification } from '../src/index.ts'
import { bootService } from './harness.ts'

describe('self-watch regression', () => {
  it('rejects prompting the lead Session itself instead of silently self-watching', async () => {
    const harness = await bootService({ enabled: true })
    try {
      const failure = await harness.service
        .promptSession(harness.lead.agent, String(harness.lead.id), 'continue')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DevLeadError)
      expect((failure as DevLeadError).code).toBe('DEVLEAD_INVALID_INPUT')
      // No watch record can have been committed before the rejection.
      expect(harness.service.view(harness.lead.agent).sessions).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
})

describe('listSessions row-limit regression', () => {
  it('orders watched rows before capping the listing', async () => {
    const harness = await bootService({
      enabled: true,
      sessionIds: ['plain-a', 'plain-b', 'watched-z'],
      watched: ['watched-z'],
    })
    try {
      const all = await harness.service.listSessions(harness.lead.agent)
      expect(all[0]?.sessionId).toBe('watched-z')
      const limited = await harness.service.listSessions(harness.lead.agent, { limit: 2 })
      expect(limited.map(view => view.sessionId)).toContain('watched-z')
    } finally {
      await harness.dispose()
    }
  })
})

describe('notification decode regression', () => {
  it('rejects empty optional strings the fold schemas reject', () => {
    const base = { ...devLeadNotification('session-x', undefined, 'completed', 1, 1) }
    expect(() => decodeNotification({ ...base, sessionTitle: '' })).toThrow(/sessionTitle/)
    expect(() => decodeNotification({ ...base, error: '' })).toThrow(/error/)
    expect(() => decodeNotification({ ...base, summary: '' })).toThrow(/summary/)
  })

  it('accepts the canonical non-empty values', () => {
    const notification = devLeadNotification(
      'session-x',
      'Child',
      'completed',
      2,
      1_700_000_000_000,
      undefined,
      'all green',
    )
    expect(decodeNotification(notification)).toEqual(notification)
  })
})
