/**
 * Type-table contract of the shared protocol package.
 *
 * The `devLead` and `devLeadMode` projection keys reach the browser through a
 * type-only `declare module '@deepseek-ai/dsh-session-projection/types'`
 * augmentation in `src/types.ts`; the meaningful assertions below stop
 * compiling if that merge is dropped or renamed, or if the summary-exclusion
 * marks drift. The runtime assertions keep the fixtures in sync with the wire
 * shapes so the test is not vacuous.
 */

import { describe, expect, it } from 'vitest'
import type {
  SessionProjectionMap,
  SessionProjectionSummaryValues,
  SessionProjectionViewValue,
} from '@deepseek-ai/dsh-session-projection/types'
import { DEVLEAD_MODE_PROJECTION_KEY, DEVLEAD_PROJECTION_KEY } from '../src/index.ts'
import type { DevLeadModeProjection, DevLeadProjection } from '../src/index.ts'

/** One wire value of the digest projection the protocol merges into the shared table. */
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

/** One wire value of the summary-sized mode projection. */
const modeWire: SessionProjectionViewValue<SessionProjectionMap['devLeadMode']> = { enabled: true }

/** The Session-summary value table must not carry the devLead digest. */
type SummaryKeys = keyof SessionProjectionSummaryValues
const devLeadRidesASummary: Extract<SummaryKeys, typeof DEVLEAD_PROJECTION_KEY> extends never ? false : true = false

/** The Session-summary value table must carry the summary-sized mode projection. */
const modeRidesASummary: Extract<SummaryKeys, typeof DEVLEAD_MODE_PROJECTION_KEY> extends never ? false : true = true

describe('SessionProjectionMap augmentation', () => {
  it('merges the devLead wire value under the projection key', () => {
    const projection: DevLeadProjection = wire
    expect(DEVLEAD_PROJECTION_KEY).toBe('devLead')
    expect(projection).toEqual(wire)
  })

  it('merges the summary-sized mode wire value under its own key', () => {
    const projection: DevLeadModeProjection = modeWire
    expect(DEVLEAD_MODE_PROJECTION_KEY).toBe('devLeadMode')
    expect(projection).toEqual({ enabled: true })
  })

  it('keeps the retained digest out of Session summaries', () => {
    expect(devLeadRidesASummary).toBe(false)
  })

  it('publishes the mode selection in Session summaries', () => {
    expect(modeRidesASummary).toBe(true)
  })
})
