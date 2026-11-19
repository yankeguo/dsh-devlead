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
import {
  DEVLEAD_MODE_PROJECTION_KEY,
  DEVLEAD_PROJECTION_KEY,
  DEVLEAD_WATCH_PROJECTION_KEY,
} from '../src/index.ts'
import type {
  DevLeadModeProjection,
  DevLeadProjection,
  DevLeadProjectionReport,
  DevLeadReport,
  DevLeadWatchProjection,
} from '../src/index.ts'

/** One wire value of the digest projection the protocol merges into the shared table. */
const wire: SessionProjectionViewValue<SessionProjectionMap['devLead']> = {
  enabled: false,
  sessions: ['session-alpha'],
  reports: [],
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

/** One wire value of the summary-sized watch projection. */
const watchWire: SessionProjectionViewValue<SessionProjectionMap['devLeadWatch']> = {
  sessions: ['session-alpha'],
}

/** The Session-summary value table must not carry the devLead digest. */
type SummaryKeys = keyof SessionProjectionSummaryValues
const devLeadRidesASummary: Extract<SummaryKeys, typeof DEVLEAD_PROJECTION_KEY> extends never ? false : true = false

/** The Session-summary value table must carry the summary-sized mode projection. */
const modeRidesASummary: Extract<SummaryKeys, typeof DEVLEAD_MODE_PROJECTION_KEY> extends never ? false : true = true

/** The Session-summary value table must carry the summary-sized watch projection. */
const watchRidesASummary: Extract<SummaryKeys, typeof DEVLEAD_WATCH_PROJECTION_KEY> extends never ? false : true = true

/** One plain retained report row: the additive lifecycle pair must stay optional. */
const plainReportRow: DevLeadProjectionReport = {
  id: 'session-alpha:1:progress:migration',
  kind: 'progress',
  message: 'halfway through the migration',
  senderSessionId: 'session-alpha',
  leadSessionId: 'session-lead',
  turn: 1,
  at: 0,
}

/** One question report row carrying the fold-derived Phase 1e lifecycle pair. */
const lifecycleReportRow: DevLeadProjectionReport = {
  ...plainReportRow,
  id: 'session-alpha:1:question:target',
  kind: 'question',
  message: 'Which target?',
  questionStatus: 'answered',
  answerStatus: 'presented',
}

/** The wire report row must stay a superset of the retained report shape. */
const projectionReportExtendsReport: DevLeadProjectionReport extends DevLeadReport ? true : false = true

/** The projection's reports array must carry exactly the projection report row. */
const projectionReportsAreProjectionRows: DevLeadProjection['reports'][number] extends DevLeadProjectionReport
  ? (DevLeadProjectionReport extends DevLeadProjection['reports'][number] ? true : false)
  : false = true

describe('SessionProjectionMap augmentation', () => {
  it('merges the devLead wire value under the projection key', () => {
    const projection: DevLeadProjection = wire
    expect(DEVLEAD_PROJECTION_KEY).toBe('devLead')
    expect(projection).toEqual(wire)
  })

  it('carries the additive question lifecycle on wire report rows', () => {
    // The pair is additive (Phase 1e): a plain row without it stays valid, and
    // a question row may carry the fold-derived lifecycle. Both compile above;
    // the runtime assertions keep the fixtures honest.
    const projection: DevLeadProjection = { ...wire, reports: [plainReportRow, lifecycleReportRow] }
    expect(projection.reports).toEqual([plainReportRow, lifecycleReportRow])
    expect(projection.reports[0]).not.toHaveProperty('questionStatus')
    expect(projection.reports[1]).toMatchObject({ questionStatus: 'answered', answerStatus: 'presented' })
    expect(projectionReportExtendsReport).toBe(true)
    expect(projectionReportsAreProjectionRows).toBe(true)
  })

  it('carries the wake-suppression pair on wire notification rows', () => {
    const projection: DevLeadProjection = {
      ...wire,
      notifications: [{
        ...wire.notifications[0]!,
        wakeSuppressedByReportId: 'session-alpha:1:blocked:credentials',
        wakeSuppressionReason: 'merged-into-pending-wake',
      }],
    }
    expect(projection.notifications[0]).toMatchObject({
      wakeSuppressedByReportId: 'session-alpha:1:blocked:credentials',
      wakeSuppressionReason: 'merged-into-pending-wake',
    })
    // The pair stays optional: the unmarked fixture row remains a valid wire value.
    expect(wire.notifications[0]).not.toHaveProperty('wakeSuppressedByReportId')
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

  it('merges the summary-sized watch wire value under its own key', () => {
    const projection: DevLeadWatchProjection = watchWire
    expect(DEVLEAD_WATCH_PROJECTION_KEY).toBe('devLeadWatch')
    expect(projection).toEqual({ sessions: ['session-alpha'] })
  })

  it('publishes the watch set in Session summaries', () => {
    expect(watchRidesASummary).toBe(true)
  })
})
