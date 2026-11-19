/**
 * Pure fold coverage of the summary-sized `devLeadWatch` projection used by the
 * sidebar to mark watched rows without loading the digest-bearing `devLead`.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_PROJECTION_KEY,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import { resetRecord } from '../src/domain.ts'
import {
  applyDevLeadWatchProjection,
  devLeadWatchProjectionDefinition,
  devLeadWatchProjectionSchema,
  devLeadWatchProjectionView,
  emptyDevLeadWatchProjectionState,
} from '../src/fold.ts'
import { T0, modeEvent, pluginRecordEvent, turnStartEvent, watchEvent } from './fixtures.ts'

/** Fold one explicit event list from the empty state. */
function fold(events: readonly SessionEvent[]) {
  return events.reduce(
    (state, event) => applyDevLeadWatchProjection(state, event),
    emptyDevLeadWatchProjectionState(),
  )
}

describe('devLeadWatch projection', () => {
  it('starts empty and exposes its unit contract', () => {
    expect(emptyDevLeadWatchProjectionState()).toEqual({ sessions: [], failure: null, inheritedEventCount: 0 })
    expect(devLeadWatchProjectionDefinition.key).toBe(DEVLEAD_WATCH_PROJECTION_KEY)
    expect(devLeadWatchProjectionDefinition.stateVersion).toBe(2)
    expect(devLeadWatchProjectionDefinition.init()).toEqual(emptyDevLeadWatchProjectionState())
    expect(devLeadWatchProjectionDefinition.apply).toBe(applyDevLeadWatchProjection)
  })

  it('follows whole-value watch records and keeps the view array stable', () => {
    const state = fold([watchEvent(1, ['session-a']), watchEvent(2, ['session-a', 'session-b'])])
    expect(state).toEqual({ sessions: ['session-a', 'session-b'], failure: null, inheritedEventCount: 0 })
    const view = devLeadWatchProjectionView(state)
    expect(view).toEqual({ sessions: ['session-a', 'session-b'] })
    expect(view.sessions).toBe(state.sessions)
    expect(devLeadWatchProjectionSchema.safeParse(view).success).toBe(true)
  })

  it('tracks an unwatch back to the empty set', () => {
    const state = fold([watchEvent(1, ['session-a', 'session-b']), watchEvent(2, [])])
    expect(state).toEqual({ sessions: [], failure: null, inheritedEventCount: 0 })
  })

  it('ignores repeated watch values, mode changes, and unrelated events by reference', () => {
    const state = fold([watchEvent(1, ['session-a'])])
    expect(applyDevLeadWatchProjection(state, watchEvent(2, ['session-a']))).toBe(state)
    expect(applyDevLeadWatchProjection(state, modeEvent(3, true))).toBe(state)
    expect(applyDevLeadWatchProjection(state, turnStartEvent(4))).toBe(state)
  })

  it('ignores watch records inherited by a forked Session', () => {
    let state = devLeadWatchProjectionDefinition.init(undefined, 2)
    state = applyDevLeadWatchProjection(state, watchEvent(0, ['session-parent']))
    state = applyDevLeadWatchProjection(state, pluginRecordEvent(1, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0)))
    expect(state).toEqual(emptyDevLeadWatchProjectionState(2))
    state = applyDevLeadWatchProjection(state, watchEvent(2, ['session-child']))
    expect(state).toEqual({ sessions: ['session-child'], failure: null, inheritedEventCount: 2 })
  })

  it('clears on reset and freezes on a malformed watch record', () => {
    const reset = fold([
      watchEvent(1, ['session-a']),
      pluginRecordEvent(2, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0)),
    ])
    expect(reset).toEqual({ sessions: [], failure: null, inheritedEventCount: 0 })

    const frozen = fold([
      pluginRecordEvent(1, DEVLEAD_WATCH_RECORD_TYPE, {
        kind: 'devlead/watch',
        version: 1,
        sessions: ['session-a', 'session-a'],
        at: T0,
      }),
      watchEvent(2, ['session-b']),
    ])
    expect(frozen.sessions).toEqual([])
    expect(frozen.failure).toContain(DEVLEAD_WATCH_RECORD_TYPE)
  })

  it('rejects a duplicate-session wire value', () => {
    expect(devLeadWatchProjectionSchema.safeParse({
      sessions: ['session-a', 'session-a'],
    }).success).toBe(false)
  })
})
