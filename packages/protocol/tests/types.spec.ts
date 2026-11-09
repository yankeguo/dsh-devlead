/**
 * Type-table contract of the shared protocol package.
 *
 * The `devLead` projection key reaches the browser through a type-only
 * `declare module '@deepseek-ai/dsh-session-projection/types'` augmentation in
 * `src/types.ts`; the meaningful assertions below stop compiling if that merge
 * is dropped or renamed, or if the summary-exclusion mark drifts. The runtime
 * assertion keeps the fixture in sync with the wire shape so the test is not
 * vacuous.
 */

import { describe, expect, it } from 'vitest'
import type {
  SessionProjectionMap,
  SessionProjectionSummaryValues,
  SessionProjectionViewValue,
} from '@deepseek-ai/dsh-session-projection/types'
import { DEVLEAD_PROJECTION_KEY } from '../src/index.ts'
import type { DevLeadProjection } from '../src/index.ts'

/** One wire value of the key the protocol merges into the shared table. */
const wire: SessionProjectionViewValue<SessionProjectionMap['devLead']> = {
  enabled: false,
  sessions: ['session-alpha'],
  notifications: [{
    id: 'session-alpha:1:completed',
    sessionId: 'session-alpha',
    transition: 'completed',
    turn: 1,
    at: 0,
  }],
}

/** The Session-summary value table must not carry the devLead digest. */
type SummaryKeys = keyof SessionProjectionSummaryValues
const devLeadRidesASummary: Extract<SummaryKeys, typeof DEVLEAD_PROJECTION_KEY> extends never ? false : true = false

describe('SessionProjectionMap augmentation', () => {
  it('merges the devLead wire value under the projection key', () => {
    const projection: DevLeadProjection = wire
    expect(DEVLEAD_PROJECTION_KEY).toBe('devLead')
    expect(projection).toEqual(wire)
  })

  it('keeps the retained digest out of Session summaries', () => {
    expect(devLeadRidesASummary).toBe(false)
  })
})
