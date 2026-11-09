/**
 * Unit tests for the sidebar DevLead row-mark predicate.
 *
 * The predicate is the whole decision the row component makes: it must read the
 * summary-sized `devLeadMode` value, ignore the digest-bearing `devLead` value
 * (which Session summaries never carry), and fail closed on missing or drifting
 * data rather than painting a mark the Host did not publish.
 */

import { describe, expect, it } from 'vitest'
import { DEVLEAD_MODE_PROJECTION_KEY } from '@yankeguo/dsh-devlead-protocol/client'
import { devLeadRowEnabled } from '../src/client/sessionMark.ts'
import type { DevLeadRowSummary } from '../src/client/sessionMark.ts'

/** Build one row summary around the projection values under test. */
function summary(projectionValues: DevLeadRowSummary['projectionValues'] | undefined): DevLeadRowSummary {
  return projectionValues === undefined ? {} : { projectionValues }
}

describe('devLeadRowEnabled', () => {
  it('is false before the Session list or the projection lands', () => {
    expect(devLeadRowEnabled(undefined)).toBe(false)
    expect(devLeadRowEnabled(summary(undefined))).toBe(false)
    expect(devLeadRowEnabled(summary({}))).toBe(false)
  })

  it('is true only while the summary reports the mode enabled', () => {
    expect(devLeadRowEnabled(summary({ [DEVLEAD_MODE_PROJECTION_KEY]: { enabled: true } }))).toBe(true)
    expect(devLeadRowEnabled(summary({ devLeadMode: { enabled: false } }))).toBe(false)
  })

  it('fails closed on a missing or drifting value', () => {
    expect(devLeadRowEnabled(summary({ devLeadMode: {} }))).toBe(false)
    expect(devLeadRowEnabled(summary({ devLeadMode: { enabled: 'yes' as never } }))).toBe(false)
  })

  it('never reads the digest projection that summaries exclude', () => {
    // A digest value alone (as an attached Session's store can still hold)
    // must not light the mark: rows read the summary-sized key only.
    const attachedOnly = {
      projectionValues: { devLead: { enabled: true, sessions: [], notifications: [] } },
    } as DevLeadRowSummary
    expect(devLeadRowEnabled(attachedOnly)).toBe(false)
  })
})
