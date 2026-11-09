/**
 * Pure fold coverage of the `devLead` Session projection: durable mode
 * selection, whole-value watched-session sets, the bounded notification digest,
 * failure freezing, and replay determinism.
 *
 * Every event is hand-built in memory; no Session, service, timer, or wall
 * clock is involved.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_PROJECTION_KEY,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadProjection, DevLeadProjectionState } from '@yankeguo/dsh-devlead-protocol'
import {
  applyDevLeadProjection,
  devLeadProjectionDefinition,
  devLeadProjectionSchema,
  devLeadProjectionStateSchema,
  devLeadProjectionView,
  emptyDevLeadProjectionState,
} from '../src/fold.ts'
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

/** Fold an explicit event list from the empty state through the public fold. */
function fold(events: readonly SessionEvent[]): DevLeadProjectionState {
  return events.reduce<DevLeadProjectionState>(
    (state, event) => applyDevLeadProjection(state, event),
    emptyDevLeadProjectionState(),
  )
}

/** Fold one event over one explicit prior state. */
function apply(state: DevLeadProjectionState, event: SessionEvent): DevLeadProjectionState {
  return applyDevLeadProjection(state, event)
}

/** Build a corrupt mode payload at seq 1 for failure tests. */
function corruptModeRecord(payload: Record<string, unknown>): SessionEvent {
  return pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, payload)
}

/** Build one corrupt mode payload at an explicit seq. */
function patternMode(seq: number, payload: Record<string, unknown>): SessionEvent {
  return pluginRecordEvent(seq, DEVLEAD_MODE_RECORD_TYPE, payload)
}

/** Build one notification whose identity is unique per Session. */
function sessionNotification(sessionId: string): DevLeadNotification {
  return notification({ sessionId, turn: 1 })
}

describe('empty state and projection definition', () => {
  it('starts disabled, watching nothing, with no notifications and no failure', () => {
    expect(emptyDevLeadProjectionState()).toEqual({
      enabled: false,
      sessions: [],
      notifications: [],
      failure: null,
    })
    expect(fold([])).toEqual(emptyDevLeadProjectionState())
  })

  it('exposes the registered projection unit contract', () => {
    expect(devLeadProjectionDefinition.key).toBe(DEVLEAD_PROJECTION_KEY)
    expect(devLeadProjectionDefinition.key).toBe('devLead')
    expect(devLeadProjectionDefinition.stateVersion).toBe(1)
    expect(devLeadProjectionDefinition.apply).toBe(applyDevLeadProjection)
    expect(devLeadProjectionDefinition.init()).toEqual(emptyDevLeadProjectionState())
    // Every init call hands out an independent empty state: the registry seeds
    // each Session from it and a shared object would leak state across Sessions.
    expect(devLeadProjectionDefinition.init()).not.toBe(devLeadProjectionDefinition.init())
  })

  it('builds the client view from the same unit', () => {
    const state = fold([modeEvent(0, true), watchEvent(1, ['session-alpha'])])
    expect(devLeadProjectionDefinition.wire.view(state)).toEqual(devLeadProjectionView(state))
    expect(devLeadProjectionDefinition.wire.viewSchema).toBe(devLeadProjectionSchema)
    // The retained digest only matters to the open conversation, so the unit
    // must stay out of Session summaries (the protocol map carries the matching
    // SessionProjectionSummaryExcluded mark).
    expect(devLeadProjectionDefinition.wire.summary).toBe(false)
  })
})

describe('mode records', () => {
  it('enables and disables DevLead mode', () => {
    const enabled = fold([modeEvent(0, true)])
    expect(enabled.enabled).toBe(true)
    expect(enabled.failure).toBeNull()
    const disabled = apply(enabled, modeEvent(1, false))
    expect(disabled.enabled).toBe(false)
  })

  it('keeps the current state reference when the selection is unchanged', () => {
    const enabled = fold([modeEvent(0, true)])
    expect(apply(enabled, modeEvent(1, true))).toBe(enabled)
    const disabled = emptyDevLeadProjectionState()
    expect(apply(disabled, modeEvent(1, false))).toBe(disabled)
  })

  it('freezes the fold on an invalid mode payload', () => {
    const state = fold([
      modeEvent(0, true),
      patternMode(1, { kind: 'devlead/mode', version: 1, enabled: 'yes', at: T0 }),
    ])
    expect(state.failure).toBe(
      `devlead replay failed at session event 1 (${DEVLEAD_MODE_RECORD_TYPE}): mode record enabled must be a boolean`,
    )
    // The last valid state stays served.
    expect(state.enabled).toBe(true)
  })

  it('rejects every malformed mode envelope', () => {
    const cases: Array<[string, SessionEvent]> = [
      ['unsupported version', corruptModeRecord({ kind: 'devlead/mode', version: 2, enabled: true, at: T0 })],
      ['unexpected kind', corruptModeRecord({ kind: 'devlead/watch', version: 1, enabled: true, at: T0 })],
      ['non-object payload', pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, ['not', 'a', 'record'])],
      ['null payload', pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, null)],
      ['fractional timestamp', corruptModeRecord({ kind: 'devlead/mode', version: 1, enabled: true, at: 1.5 })],
      ['negative timestamp', corruptModeRecord({ kind: 'devlead/mode', version: 1, enabled: true, at: -1 })],
    ]
    for (const [label, event] of cases) {
      const state = fold([modeEvent(0, false), event])
      expect(state.failure, label).toContain('devlead replay failed at session event 1')
      expect(state.failure, label).toContain(DEVLEAD_MODE_RECORD_TYPE)
    }
  })
})

describe('watch records', () => {
  it('replaces the complete watch set instead of merging it', () => {
    const first = fold([watchEvent(0, ['session-alpha', 'session-beta'])])
    expect(first.sessions).toEqual(['session-alpha', 'session-beta'])
    const second = apply(first, watchEvent(1, ['session-beta', 'session-gamma']))
    expect(second.sessions).toEqual(['session-beta', 'session-gamma'])
    expect(second.sessions).not.toContain('session-alpha')
  })

  it('clears the watch set with an empty replacement', () => {
    const watched = fold([watchEvent(0, ['session-alpha'])])
    expect(apply(watched, watchEvent(1, [])).sessions).toEqual([])
  })

  it('keeps add order of the recorded whole value', () => {
    const state = fold([watchEvent(0, ['session-gamma', 'session-alpha', 'session-beta'])])
    expect(state.sessions).toEqual(['session-gamma', 'session-alpha', 'session-beta'])
  })

  it('does not change the mode selection', () => {
    const enabled = fold([modeEvent(0, true), watchEvent(1, ['session-alpha'])])
    expect(enabled.enabled).toBe(true)
    expect(enabled.sessions).toEqual(['session-alpha'])
  })

  it('keeps the state reference when a whole-value record repeats the current set', () => {
    const state = fold([watchEvent(0, ['session-alpha', 'session-beta'])])
    expect(apply(state, watchEvent(1, ['session-alpha', 'session-beta']))).toBe(state)
  })

  it('rejects duplicate, empty, or non-string Session ids', () => {
    const cases: Array<[string, unknown]> = [
      ['duplicate ids', { kind: 'devlead/watch', version: 1, sessions: ['a', 'a'], at: T0 }],
      ['empty id', { kind: 'devlead/watch', version: 1, sessions: [''], at: T0 }],
      ['non-string id', { kind: 'devlead/watch', version: 1, sessions: [1], at: T0 }],
      ['non-array sessions', { kind: 'devlead/watch', version: 1, sessions: 'session-alpha', at: T0 }],
      ['unsupported version', { kind: 'devlead/watch', version: 3, sessions: [], at: T0 }],
    ]
    for (const [label, payload] of cases) {
      const state = fold([pluginRecordEvent(1, DEVLEAD_WATCH_RECORD_TYPE, payload)])
      expect(state.failure, label).not.toBeNull()
      expect(state.failure, label).toContain(DEVLEAD_WATCH_RECORD_TYPE)
    }
  })
})

describe('notification records', () => {
  it('appends one notification and keeps its decoded fields', () => {
    const observed = notification({ sessionId: 'session-alpha', sessionTitle: 'webapp', turn: 3, transition: 'error', error: 'boom' })
    const state = fold([notificationEvent(0, observed)])
    expect(state.notifications).toEqual([observed])
  })

  it('keeps the latest assistant summary observed before the turn settled', () => {
    const observed = notification({ sessionId: 'session-alpha', turn: 2, summary: 'implemented the parser' })
    const state = fold([notificationEvent(0, observed)])
    expect(state.notifications).toEqual([observed])
    expect(state.notifications[0]?.summary).toBe('implemented the parser')
  })

  it('keeps notifications in oldest-first log order', () => {
    const state = fold([
      notificationEvent(0, notification({ sessionId: 'session-alpha', turn: 1 })),
      notificationEvent(1, notification({ sessionId: 'session-beta', turn: 1 })),
      notificationEvent(2, notification({ sessionId: 'session-gamma', turn: 1 })),
    ])
    expect(state.notifications.map(item => item.sessionId)).toEqual([
      'session-alpha',
      'session-beta',
      'session-gamma',
    ])
  })

  it('treats a replayed identity as idempotent', () => {
    const observed = notification({ sessionId: 'session-alpha', turn: 2 })
    const once = fold([notificationEvent(0, observed)])
    const twice = apply(once, notificationEvent(1, observed))
    expect(twice).toBe(once)
    expect(twice.notifications).toHaveLength(1)
  })

  it('ignores a duplicate identity even when its payload differs', () => {
    const once = fold([notificationEvent(0, notification({ sessionId: 'session-alpha', turn: 2, at: T0 }))])
    const replayed = apply(
      once,
      notificationEvent(1, notification({ sessionId: 'session-alpha', turn: 2, at: T0 + 5_000, sessionTitle: 'renamed' })),
    )
    expect(replayed).toBe(once)
    expect(replayed.notifications[0]?.sessionTitle).toBeUndefined()
  })

  it('bounds the digest to the protocol retention constant, dropping the oldest', () => {
    const events: SessionEvent[] = []
    for (let index = 0; index < DEVLEAD_DEFAULT_NOTIFICATION_RETENTION + 1; index += 1) {
      events.push(notificationEvent(index, sessionNotification(`session-${String(index)}`)))
    }
    const state = fold(events)
    expect(DEVLEAD_DEFAULT_NOTIFICATION_RETENTION).toBe(64)
    expect(state.notifications).toHaveLength(DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    expect(state.notifications[0]?.sessionId).toBe('session-1')
    expect(state.notifications.at(-1)?.sessionId).toBe('session-64')
  })

  it('rejects notifications whose identity or fields are invalid', () => {
    const cases: Array<[string, DevLeadNotification]> = [
      ['id mismatch', { ...notification(), id: 'session-alpha:3:error' }],
      ['empty session id', { ...notification(), sessionId: '' }],
      ['zero turn', { ...notification(), turn: 0 }],
      ['negative timestamp', { ...notification(), at: -1 }],
      ['unknown transition', { ...notification(), transition: 'failed' as never }],
      ['non-string summary', { ...notification(), summary: 42 as never }],
    ]
    for (const [label, observed] of cases) {
      const state = fold([notificationEvent(1, observed)])
      expect(state.failure, label).toContain(DEVLEAD_NOTIFICATION_RECORD_TYPE)
    }
  })
})

describe('unrelated events', () => {
  it('returns the same state reference for non-plugin events', () => {
    const state = fold([modeEvent(0, true)])
    expect(apply(state, turnStartEvent(1))).toBe(state)
  })

  it('returns the same state reference for another plugin’s record', () => {
    const state = emptyDevLeadProjectionState()
    expect(apply(state, foreignPluginEvent(0))).toBe(state)
  })

  it('returns the same state reference for an unmarked unknown event', () => {
    const state = emptyDevLeadProjectionState()
    expect(apply(state, unmarkedEvent(0))).toBe(state)
  })
})

describe('record strictness', () => {
  it('rejects unknown fields on owned record payloads', () => {
    const cases: Array<[string, SessionEvent]> = [
      [
        'mode extra field',
        corruptModeRecord({ kind: 'devlead/mode', version: 1, enabled: true, at: T0, extra: true }),
      ],
      [
        'watch extra field',
        pluginRecordEvent(1, DEVLEAD_WATCH_RECORD_TYPE, {
          kind: 'devlead/watch',
          version: 1,
          sessions: [],
          at: T0,
          extra: true,
        }),
      ],
      [
        'notification record extra field',
        pluginRecordEvent(1, DEVLEAD_NOTIFICATION_RECORD_TYPE, {
          kind: 'devlead/notification',
          version: 1,
          notification: notification({ sessionId: 'session-alpha', turn: 1 }),
          extra: true,
        }),
      ],
      [
        'notification value extra field',
        pluginRecordEvent(1, DEVLEAD_NOTIFICATION_RECORD_TYPE, {
          kind: 'devlead/notification',
          version: 1,
          notification: { ...notification({ sessionId: 'session-alpha', turn: 1 }), extra: true },
        }),
      ],
    ]
    for (const [label, event] of cases) {
      const state = fold([event])
      expect(state.failure, label).not.toBeNull()
      expect(state.failure, label).toContain('unexpected field')
    }
  })

  it('rejects a missing required field instead of coercing it', () => {
    const state = fold([pluginRecordEvent(1, DEVLEAD_WATCH_RECORD_TYPE, { kind: 'devlead/watch', version: 1, at: T0 })])
    expect(state.failure).toContain('missing field "sessions"')
  })

  it('rejects an instant outside the representable Date range', () => {
    const beyond = 8_640_000_000_000_001
    const cases: Array<[string, SessionEvent]> = [
      ['mode', corruptModeRecord({ kind: 'devlead/mode', version: 1, enabled: true, at: beyond })],
      [
        'watch',
        pluginRecordEvent(1, DEVLEAD_WATCH_RECORD_TYPE, {
          kind: 'devlead/watch',
          version: 1,
          sessions: ['session-alpha'],
          at: beyond,
        }),
      ],
      [
        'notification',
        notificationEvent(1, notification({ sessionId: 'session-alpha', turn: 1, at: beyond })),
      ],
    ]
    for (const [label, event] of cases) {
      const state = fold([event])
      expect(state.failure, label).toContain('epoch milliseconds')
    }
  })
})

describe('failure handling', () => {
  it('freezes the fold at the last valid state once a record is corrupt', () => {
    const events: SessionEvent[] = [
      modeEvent(0, true),
      watchEvent(1, ['session-alpha']),
      notificationEvent(2, notification({ sessionId: 'session-alpha', turn: 1 })),
      pluginRecordEvent(3, DEVLEAD_MODE_RECORD_TYPE, { kind: 'devlead/mode', version: 9, enabled: true, at: T0 }),
    ]
    const failed = fold(events)
    expect(failed.failure).toBe(
      `devlead replay failed at session event 3 (${DEVLEAD_MODE_RECORD_TYPE}): record "${DEVLEAD_MODE_RECORD_TYPE}" carries unsupported version 9`,
    )
    expect(failed.enabled).toBe(true)
    expect(failed.sessions).toEqual(['session-alpha'])
    expect(failed.notifications).toHaveLength(1)
    // Every later event — valid or not — leaves the frozen state untouched.
    expect(apply(failed, modeEvent(4, false))).toBe(failed)
    expect(apply(failed, notificationEvent(5, notification({ sessionId: 'session-beta', turn: 1 })))).toBe(failed)
    expect(apply(failed, corruptModeRecord({ kind: 'devlead/mode', version: 1, enabled: true, at: T0 }))).toBe(failed)
  })

  it('records a failure for a corrupt first record', () => {
    const failed = fold([pluginRecordEvent(0, DEVLEAD_NOTIFICATION_RECORD_TYPE, { kind: 'devlead/notification' })])
    expect(failed.failure).toBe(
      `devlead replay failed at session event 0 (${DEVLEAD_NOTIFICATION_RECORD_TYPE}): notification record is missing field "version"`,
    )
    expect(failed.enabled).toBe(false)
    expect(failed.sessions).toEqual([])
    expect(failed.notifications).toEqual([])
  })

  it('records only the first failure message', () => {
    const first = fold([corruptModeRecord({ kind: 'devlead/mode', version: 2, enabled: true, at: T0 })])
    const second = apply(first, corruptModeRecord({ kind: 'devlead/watch', version: 4, sessions: [], at: T0 }))
    expect(second.failure).toBe(first.failure)
  })

  it('reuses the wire view reference when only the host failure field changes', () => {
    const healthy = fold([modeEvent(0, true), watchEvent(1, ['session-alpha'])])
    const view = devLeadProjectionView(healthy)
    const failed = apply(
      healthy,
      corruptModeRecord({ kind: 'devlead/mode', version: 1, enabled: 'yes', at: T0 }),
    )
    expect(failed.failure).not.toBeNull()
    // The registry compares consecutive wire views with Object.is: an
    // internal-only change must not publish a deep-equal client value.
    expect(devLeadProjectionView(failed)).toBe(view)
  })

  it('keeps the failure state schema-valid', () => {
    const failed = fold([corruptModeRecord(null as never)])
    expect(devLeadProjectionStateSchema.safeParse(failed).success).toBe(true)
  })
})

describe('wire view and schemas', () => {
  it('omits the host-only failure field and reuses the retained arrays', () => {
    const state = fold([
      modeEvent(0, true),
      watchEvent(1, ['session-alpha']),
      notificationEvent(2, notification({ sessionId: 'session-alpha', turn: 1 })),
    ])
    const view = devLeadProjectionView(state)
    expect(view).toEqual({
      enabled: true,
      sessions: ['session-alpha'],
      notifications: [notification({ sessionId: 'session-alpha', turn: 1 })],
    })
    expect('failure' in view).toBe(false)
    expect(view.sessions).toBe(state.sessions)
    expect(view.notifications).toBe(state.notifications)
  })

  it('validates the wire value before it leaves the host', () => {
    const state = fold([modeEvent(0, true), watchEvent(1, ['session-alpha'])])
    expect(devLeadProjectionSchema.safeParse(devLeadProjectionView(state)).success).toBe(true)
  })

  it('rejects state and wire values with unknown keys', () => {
    const state = fold([modeEvent(0, true)])
    const view = devLeadProjectionView(state)
    expect(devLeadProjectionSchema.safeParse({ ...view, failure: null }).success).toBe(false)
    expect(devLeadProjectionStateSchema.safeParse({ ...state, extra: true }).success).toBe(false)
  })

  it('rejects a notification carrying an unknown wire field', () => {
    const view = devLeadProjectionView(fold([modeEvent(0, true)]))
    expect(
      devLeadProjectionSchema.safeParse({
        ...view,
        notifications: [{ ...notification(), extra: true }],
      }).success,
    ).toBe(false)
  })

  it('rejects malformed retained notifications on the wire', () => {
    const view: DevLeadProjection = {
      enabled: false,
      sessions: [],
      notifications: [{ ...notification(), sessionTitle: '' }],
    }
    expect(devLeadProjectionSchema.safeParse(view).success).toBe(false)
    expect(devLeadProjectionSchema.safeParse({ enabled: false, sessions: [''], notifications: [] }).success).toBe(false)
    expect(
      devLeadProjectionSchema.safeParse({
        enabled: false,
        sessions: [],
        notifications: [{ ...notification(), summary: '' }],
      }).success,
    ).toBe(false)
  })
})

describe('replay determinism', () => {
  /** Build the full lifecycle event list folded by the determinism tests. */
  function lifecycleEvents(): SessionEvent[] {
    return [
      modeEvent(0, true),
      watchEvent(1, ['session-alpha']),
      notificationEvent(2, notification({ sessionId: 'session-alpha', turn: 1 })),
      turnStartEvent(3),
      foreignPluginEvent(4),
      watchEvent(5, ['session-alpha', 'session-beta']),
      notificationEvent(6, notification({ sessionId: 'session-beta', turn: 2, transition: 'error', error: 'boom' })),
      modeEvent(7, false),
    ]
  }

  it('produces equal state for the same event sequence', () => {
    const first = fold(lifecycleEvents())
    const second = fold(lifecycleEvents())
    expect(second).toEqual(first)
    expect(second.sessions).not.toBe(first.sessions)
    expect(second.notifications).not.toBe(first.notifications)
  })

  it('is insensitive to interleaved unrelated events', () => {
    const events = lifecycleEvents()
    const withNoise: SessionEvent[] = []
    events.forEach((event, index) => {
      withNoise.push(event, turnStartEvent(100 + index))
    })
    expect(fold(withNoise)).toEqual(fold(events))
  })

  it('converges when a notification identity is replayed later', () => {
    const observed = notification({ sessionId: 'session-alpha', turn: 1 })
    const once = fold([modeEvent(0, true), notificationEvent(1, observed)])
    const replayed = fold([modeEvent(0, true), notificationEvent(1, observed), notificationEvent(2, observed)])
    expect(replayed).toEqual(once)
  })
})
