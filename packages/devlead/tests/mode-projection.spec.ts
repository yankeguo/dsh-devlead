/**
 * Pure fold coverage of the summary-sized `devLeadMode` Session projection.
 *
 * The sidebar renders one mark per listed Session row, and the digest-bearing
 * `devLead` unit is excluded from Session summaries; this unit carries the
 * selection alone. The tests pin the facts the row depends on: the key and the
 * summary membership, identity-stable client views, the same freeze-on-corrupt
 * policy as the digest unit, and independence from the watch/notification data.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_MODE_PROJECTION_KEY,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import {
  applyDevLeadModeProjection,
  devLeadModeProjectionDefinition,
  devLeadModeProjectionSchema,
  devLeadModeProjectionStateSchema,
  devLeadModeProjectionView,
  emptyDevLeadModeProjectionState,
} from '../src/fold.ts'
import type { DevLeadModeProjectionState } from '../src/fold.ts'
import {
  T0,
  foreignPluginEvent,
  modeEvent,
  notification,
  notificationEvent,
  pluginRecordEvent,
  turnStartEvent,
  unmarkedEvent,
  watchEvent,
} from './fixtures.ts'

/** Fold an explicit event list from the empty state through the mode fold. */
function fold(events: readonly SessionEvent[]): DevLeadModeProjectionState {
  return events.reduce<DevLeadModeProjectionState>(
    (state, event) => applyDevLeadModeProjection(state, event),
    emptyDevLeadModeProjectionState(),
  )
}

/** Build one corrupt payload for one owned record type at an explicit seq. */
function corruptEvent(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return pluginRecordEvent(seq, type, payload)
}

describe('mode projection unit contract', () => {
  it('starts disabled with no failure', () => {
    expect(emptyDevLeadModeProjectionState()).toEqual({ enabled: false, failure: null })
    expect(fold([])).toEqual(emptyDevLeadModeProjectionState())
  })

  it('registers under its own key with the default summary membership', () => {
    expect(devLeadModeProjectionDefinition.key).toBe(DEVLEAD_MODE_PROJECTION_KEY)
    expect(devLeadModeProjectionDefinition.key).toBe('devLeadMode')
    expect(devLeadModeProjectionDefinition.stateVersion).toBe(1)
    expect(devLeadModeProjectionDefinition.apply).toBe(applyDevLeadModeProjection)
    expect(devLeadModeProjectionDefinition.init()).toEqual(emptyDevLeadModeProjectionState())
    // Every init call hands out an independent empty state: the registry seeds
    // each Session from it and a shared object would leak state across Sessions.
    expect(devLeadModeProjectionDefinition.init()).not.toBe(devLeadModeProjectionDefinition.init())
    // No `wire.summary: false`: the registry's default (true) is what lets a
    // Session-list row carry this value.
    expect(devLeadModeProjectionDefinition.wire.viewSchema).toBe(devLeadModeProjectionSchema)
    // The definition literal omits the flag entirely (the registry defaults it
    // to true); read it through the registration shape to assert its absence.
    expect((devLeadModeProjectionDefinition.wire as { summary?: boolean }).summary).toBeUndefined()
  })

  it('keeps the persisted state schema strict', () => {
    expect(devLeadModeProjectionStateSchema.parse({ enabled: true, failure: null }))
      .toEqual({ enabled: true, failure: null })
    expect(() => devLeadModeProjectionStateSchema.parse({ enabled: true, failure: null, extra: 1 })).toThrow()
    expect(() => devLeadModeProjectionStateSchema.parse({ enabled: 'yes', failure: null })).toThrow()
  })
})

describe('mode fold', () => {
  it('enables and disables the selection', () => {
    const enabled = fold([modeEvent(0, true)])
    expect(enabled).toEqual({ enabled: true, failure: null })
    const disabled = applyDevLeadModeProjection(enabled, modeEvent(1, false))
    expect(disabled).toEqual({ enabled: false, failure: null })
  })

  it('keeps the state reference when the selection is unchanged', () => {
    const enabled = fold([modeEvent(0, true)])
    expect(applyDevLeadModeProjection(enabled, modeEvent(1, true))).toBe(enabled)
    const disabled = emptyDevLeadModeProjectionState()
    expect(applyDevLeadModeProjection(disabled, modeEvent(1, false))).toBe(disabled)
  })

  it('ignores unowned, unmarked, and foreign events by reference', () => {
    const state = fold([modeEvent(0, true)])
    expect(applyDevLeadModeProjection(state, turnStartEvent(1))).toBe(state)
    expect(applyDevLeadModeProjection(state, unmarkedEvent(2))).toBe(state)
    expect(applyDevLeadModeProjection(state, foreignPluginEvent(3))).toBe(state)
  })

  it('ignores valid watch and notification records without changing the selection', () => {
    const state = fold([modeEvent(0, true), watchEvent(1, ['session-alpha']), notificationEvent(2, notification())])
    expect(state).toEqual({ enabled: true, failure: null })
  })

  it('freezes the last valid selection when an owned record is corrupt', () => {
    const cases = [
      corruptEvent(1, DEVLEAD_MODE_RECORD_TYPE, { kind: 'devlead/mode', version: 1, enabled: 'yes', at: T0 }),
      corruptEvent(1, DEVLEAD_WATCH_RECORD_TYPE, { kind: 'devlead/watch', version: 1, sessions: 'no', at: T0 }),
      corruptEvent(1, DEVLEAD_NOTIFICATION_RECORD_TYPE, { kind: 'devlead/notification', version: 1, notification: {} }),
    ]
    for (const corrupt of cases) {
      const state = fold([modeEvent(0, true), corrupt])
      expect(state.enabled).toBe(true)
      expect(state.failure).toContain(`session event 1 (${corrupt.type})`)
      // A frozen fold never recovers, even on a later valid selection flip.
      expect(applyDevLeadModeProjection(state, modeEvent(2, false))).toBe(state)
    }
  })
})

describe('mode view', () => {
  it('hands out identity-stable enabled/disabled views', () => {
    const enabled = devLeadModeProjectionView({ enabled: true, failure: null })
    const disabled = devLeadModeProjectionView({ enabled: false, failure: null })
    expect(enabled).toEqual({ enabled: true })
    expect(disabled).toEqual({ enabled: false })
    // The registry suppresses a push on Object.is-equal views; a fresh object
    // per read would republish the same value on every Session event.
    expect(devLeadModeProjectionView({ enabled: true, failure: null })).toBe(enabled)
    expect(devLeadModeProjectionView({ enabled: true, failure: 'boom' })).toBe(enabled)
    expect(devLeadModeProjectionView({ enabled: false, failure: null })).toBe(disabled)
    expect(devLeadModeProjectionSchema.parse(enabled)).toEqual({ enabled: true })
  })
})
