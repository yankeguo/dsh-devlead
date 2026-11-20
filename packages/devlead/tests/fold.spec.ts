/**
 * Pure fold coverage of the `devLead` Session projection: durable mode
 * selection, whole-value watched-session sets, the bounded notification digest,
 * failure freezing, and replay determinism.
 *
 * Every event is hand-built in memory; no Session, service, timer, or wall
 * clock is involved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_ANSWER_RETENTION,
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_MAX_INSTANT,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_OPEN_QUESTION_PIN_MAX,
  DEVLEAD_PROJECTION_KEY,
  DEVLEAD_RECORD_VERSION,
  DEVLEAD_REPAIR_RECORD_TYPE,
  DEVLEAD_REPORT_ANSWER_RECORD_TYPE,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_REPORT_RETENTION,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadProjection, DevLeadProjectionState } from '@yankeguo/dsh-devlead-protocol'
import { repairRecord, reportAnswerRecord, resetRecord } from '../src/domain.ts'
import {
  applyDevLeadModeProjection,
  applyDevLeadProjection,
  applyDevLeadWatchProjection,
  devLeadModeProjectionDefinition,
  devLeadProjectionDefinition,
  emptyDevLeadModeProjectionState,
  devLeadProjectionSchema,
  devLeadProjectionStateSchema,
  devLeadProjectionView,
  devLeadWatchProjectionDefinition,
  emptyDevLeadProjectionState,
  emptyDevLeadWatchProjectionState,
  initializeDevLeadFoldWarnings,
  latestAnswerOf,
  questionAnswerViewOf,
  questionStatusOf,
  resetDevLeadFoldWarningsForTests,
} from '../src/fold.ts'
import {
  T0,
  answer,
  answerEvent,
  foreignPluginEvent,
  legacyAnswer,
  modeEvent,
  notification,
  notificationEvent,
  pluginRecordEvent,
  report,
  reportEvent,
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
      reports: [],
      answers: [],
      repairPending: [],
      failure: null,
      inheritedEventCount: 0,
    })
    expect(fold([])).toEqual(emptyDevLeadProjectionState())
  })

  it('exposes the registered projection unit contract', () => {
    expect(devLeadProjectionDefinition.key).toBe(DEVLEAD_PROJECTION_KEY)
    expect(devLeadProjectionDefinition.key).toBe('devLead')
    expect(devLeadProjectionDefinition.stateVersion).toBe(7)
    expect(devLeadModeProjectionDefinition.stateVersion).toBe(3)
    expect(devLeadWatchProjectionDefinition.stateVersion).toBe(3)
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

  it('ignores mode/watch/reset records inherited by a forked Session', () => {
    // A subagent_fork seed copies the parent's completed-turn prefix verbatim,
    // including plugin:devlead records. Those events describe the parent, not
    // the child: the child must start disabled with an empty watch set.
    let state = devLeadProjectionDefinition.init(undefined, 3)
    state = apply(state, modeEvent(0, true))
    state = apply(state, watchEvent(1, ['session-parent-watch']))
    state = apply(state, pluginRecordEvent(2, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0)))
    expect(state).toEqual(emptyDevLeadProjectionState(3))
    state = apply(state, modeEvent(3, true))
    expect(state.enabled).toBe(true)
    expect(state.inheritedEventCount).toBe(3)
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
      patternMode(1, { kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: 'yes', at: T0 }),
    ])
    expect(state.failure).toBe(
      `devlead replay failed at session event 1 (${DEVLEAD_MODE_RECORD_TYPE}): mode record enabled must be a boolean`,
    )
    // The last valid state stays served.
    expect(state.enabled).toBe(true)
  })

  it('rejects every malformed mode envelope', () => {
    const cases: Array<[string, SessionEvent]> = [
      ['unsupported version', corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION + 1, enabled: true, at: T0 })],
      ['unexpected kind', corruptModeRecord({ kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION, enabled: true, at: T0 })],
      ['non-object payload', pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, ['not', 'a', 'record'])],
      ['null payload', pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, null)],
      ['fractional timestamp', corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: true, at: 1.5 })],
      ['negative timestamp', corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: true, at: -1 })],
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
      ['duplicate ids', { kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION, sessions: ['a', 'a'], at: T0 }],
      ['empty id', { kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION, sessions: [''], at: T0 }],
      ['non-string id', { kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION, sessions: [1], at: T0 }],
      ['non-array sessions', { kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION, sessions: 'session-alpha', at: T0 }],
      ['unsupported version', { kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION + 1, sessions: [], at: T0 }],
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

  it('upgrades a duplicate only with additive wake-suppression metadata', () => {
    const observed = notification({ sessionId: 'session-alpha', turn: 2, at: T0 })
    const once = fold([notificationEvent(0, observed)])
    const suppressed = apply(once, notificationEvent(1, {
      ...observed,
      wakeSuppressedByReportId: 'session-alpha:2:report:question:abc',
      wakeSuppressionReason: 'included-in-sent-wake',
    }))
    expect(suppressed).not.toBe(once)
    expect(suppressed.notifications).toEqual([{
      ...observed,
      wakeSuppressedByReportId: 'session-alpha:2:report:question:abc',
      wakeSuppressionReason: 'included-in-sent-wake',
    }])
    expect(devLeadProjectionSchema.safeParse(devLeadProjectionView(suppressed)).success).toBe(true)
  })

  it('ignores payload drift and never rewrites existing suppression metadata', () => {
    const observed = notification({ sessionId: 'session-alpha', turn: 2, at: T0 })
    const once = fold([notificationEvent(0, observed)])
    const drifted = apply(once, notificationEvent(1, {
      ...observed,
      at: T0 + 1,
      wakeSuppressedByReportId: 'report-new',
      wakeSuppressionReason: 'included-in-sent-wake',
    }))
    expect(drifted).toBe(once)

    const initiallySuppressed = fold([notificationEvent(0, {
      ...observed,
      wakeSuppressedByReportId: 'report-original',
      wakeSuppressionReason: 'merged-into-pending-wake',
    })])
    const rewritten = apply(initiallySuppressed, notificationEvent(1, {
      ...observed,
      wakeSuppressedByReportId: 'report-new',
      wakeSuppressionReason: 'included-in-sent-wake',
    }))
    expect(rewritten).toBe(initiallySuppressed)
    expect(rewritten.notifications[0]?.wakeSuppressedByReportId).toBe('report-original')
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
        corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: true, at: T0, extra: true }),
      ],
      [
        'watch extra field',
        pluginRecordEvent(1, DEVLEAD_WATCH_RECORD_TYPE, {
          kind: 'devlead/watch',
          version: DEVLEAD_RECORD_VERSION,
          sessions: [],
          at: T0,
          extra: true,
        }),
      ],
      [
        'notification record extra field',
        pluginRecordEvent(1, DEVLEAD_NOTIFICATION_RECORD_TYPE, {
          kind: 'devlead/notification',
          version: DEVLEAD_RECORD_VERSION,
          notification: notification({ sessionId: 'session-alpha', turn: 1 }),
          extra: true,
        }),
      ],
      [
        'notification value extra field',
        pluginRecordEvent(1, DEVLEAD_NOTIFICATION_RECORD_TYPE, {
          kind: 'devlead/notification',
          version: DEVLEAD_RECORD_VERSION,
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
    const state = fold([pluginRecordEvent(1, DEVLEAD_WATCH_RECORD_TYPE, { kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION, at: T0 })])
    expect(state.failure).toContain('missing field "sessions"')
  })

  it('rejects an instant outside the representable Date range', () => {
    const beyond = 8_640_000_000_000_001
    const cases: Array<[string, SessionEvent]> = [
      ['mode', corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: true, at: beyond })],
      [
        'watch',
        pluginRecordEvent(1, DEVLEAD_WATCH_RECORD_TYPE, {
          kind: 'devlead/watch',
          version: DEVLEAD_RECORD_VERSION,
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

describe('legacy record compatibility', () => {
  const warnings: string[] = []

  beforeEach(() => {
    warnings.length = 0
    resetDevLeadFoldWarningsForTests()
    initializeDevLeadFoldWarnings({ warn: message => warnings.push(message) })
  })

  afterEach(() => resetDevLeadFoldWarningsForTests())

  it('ignores old envelope versions in every projection with one warning, then folds current records', () => {
    const oldVersion = DEVLEAD_RECORD_VERSION - 1
    const events = [
      modeEvent(0, true),
      pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, {
        kind: 'devlead/mode', version: oldVersion, enabled: false, at: T0,
      }),
      pluginRecordEvent(2, DEVLEAD_WATCH_RECORD_TYPE, {
        kind: 'devlead/watch', version: oldVersion, sessions: ['session-old'], at: T0,
      }),
      pluginRecordEvent(3, DEVLEAD_RESET_RECORD_TYPE, {
        kind: 'devlead/reset', version: oldVersion, at: T0,
      }),
      watchEvent(4, ['session-current']),
    ]
    const state = fold(events)
    expect(state.enabled).toBe(true)
    expect(state.sessions).toEqual(['session-current'])
    expect(state.failure).toBeNull()

    const watchState = events.reduce(applyDevLeadWatchProjection, emptyDevLeadWatchProjectionState())
    expect(watchState.sessions).toEqual(['session-current'])
    expect(watchState.failure).toBeNull()
    const modeState = events.reduce(applyDevLeadModeProjection, emptyDevLeadModeProjectionState())
    expect(modeState.enabled).toBe(true)
    expect(modeState.failure).toBeNull()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ignored a legacy record')
    expect(warnings[0]).toContain(`version ${String(oldVersion)}`)
  })

  it('ignores a valid pre-sequence answer instead of folding it as sequence zero', () => {
    const question = report({ kind: 'question', message: 'Which target?' })
    const legacy = legacyAnswer({ reportId: question.id, messageId: 'msg-old', answerSeq: 0 })
    const current = answer({ reportId: question.id, messageId: 'msg-current', answerSeq: 1 })
    const events = [reportEvent(0, question), answerEvent(1, legacy), answerEvent(2, current)]
    const state = fold(events)
    expect(state.failure).toBeNull()
    expect(state.answers).toEqual([current])
    expect(latestAnswerOf(state.answers, question.id)?.messageId).toBe('msg-current')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('answerSeq')

    const watchState = events.reduce(applyDevLeadWatchProjection, emptyDevLeadWatchProjectionState())
    expect(watchState.failure).toBeNull()
    const modeState = events.reduce(applyDevLeadModeProjection, emptyDevLeadModeProjectionState())
    expect(modeState.failure).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it('freezes a no-seq answer carrying additional current-schema corruption', () => {
    const question = report({ kind: 'question', message: 'Which target?' })
    const damaged = pluginRecordEvent(1, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, {
      kind: 'devlead/report-answer',
      version: DEVLEAD_RECORD_VERSION,
      answer: { ...legacyAnswer({ reportId: question.id }), textHash: 'not-a-hash' },
    })
    const state = fold([reportEvent(0, question), damaged])
    expect(state.failure).toContain(DEVLEAD_REPORT_ANSWER_RECORD_TYPE)
    expect(state.answers).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe('failure handling', () => {
  it('freezes the fold at the last valid state once a record is corrupt', () => {
    const events: SessionEvent[] = [
      modeEvent(0, true),
      watchEvent(1, ['session-alpha']),
      notificationEvent(2, notification({ sessionId: 'session-alpha', turn: 1 })),
      pluginRecordEvent(3, DEVLEAD_MODE_RECORD_TYPE, { kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION + 1, enabled: true, at: T0 }),
    ]
    const failed = fold(events)
    expect(failed.failure).toBe(
      `devlead replay failed at session event 3 (${DEVLEAD_MODE_RECORD_TYPE}): record "${DEVLEAD_MODE_RECORD_TYPE}" carries unsupported version ${DEVLEAD_RECORD_VERSION + 1}`,
    )
    expect(failed.enabled).toBe(true)
    expect(failed.sessions).toEqual(['session-alpha'])
    expect(failed.notifications).toHaveLength(1)
    // Every later event — valid or not — leaves the frozen state untouched.
    expect(apply(failed, modeEvent(4, false))).toBe(failed)
    expect(apply(failed, notificationEvent(5, notification({ sessionId: 'session-beta', turn: 1 })))).toBe(failed)
    expect(apply(failed, corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: true, at: T0 }))).toBe(failed)
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
    const first = fold([corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION + 1, enabled: true, at: T0 })])
    const second = apply(first, corruptModeRecord({ kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION + 1, sessions: [], at: T0 }))
    expect(second.failure).toBe(first.failure)
  })

  it('reuses the wire view reference when only the host failure field changes', () => {
    const healthy = fold([modeEvent(0, true), watchEvent(1, ['session-alpha'])])
    const view = devLeadProjectionView(healthy)
    const failed = apply(
      healthy,
      corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: 'yes', at: T0 }),
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

describe('report records', () => {
  it('retains a report, deduplicates its identity on replay, and publishes it', () => {
    const value = report()
    const state = fold([
      modeEvent(0, true),
      reportEvent(1, value),
      reportEvent(2, value),
    ])
    expect(state.reports).toEqual([value])
    const view = devLeadProjectionView(state)
    expect(view.reports).toEqual([value])
    expect(view.reports).toBe(state.reports)
    expect('failure' in view).toBe(false)
  })

  it('round-trips structured question reports and legacy records through fold and wire schemas', () => {
    const structured = report({
      kind: 'question',
      message: 'Which target?',
      questions: [{
        id: 'target',
        header: 'Deploy',
        question: 'Which target?',
        options: [{ label: 'Staging', description: 'safe' }],
        multi_select: false,
      }],
    })
    const state = fold([reportEvent(0, structured), reportEvent(1, report())])
    expect(state.reports).toEqual([structured, report()])
    expect(state.reports[1]).not.toHaveProperty('questions')
    expect(devLeadProjectionStateSchema.safeParse(state).success).toBe(true)
    expect(devLeadProjectionSchema.safeParse(devLeadProjectionView(state)).success).toBe(true)
  })

  it('rejects malformed structured questions on durable and wire paths', () => {
    const structured = report({
      kind: 'question',
      message: 'Which target?',
      questions: [{ question: 'Which target?', options: [{ label: 'Staging' }] }],
    })
    const wrongKind = { ...structured, kind: 'progress' as const }
    expect(fold([reportEvent(0, wrongKind)]).failure).toContain('questions are only valid')
    const unknownOption = {
      ...structured,
      questions: [{ question: 'Which target?', options: [{ label: 'Staging', extra: true }] }],
    }
    expect(fold([reportEvent(0, unknownOption)]).failure).toContain('unexpected field "extra"')
    expect(devLeadProjectionSchema.safeParse({
      enabled: false,
      sessions: [],
      notifications: [],
      reports: [wrongKind],
    }).success).toBe(false)
    expect(devLeadProjectionSchema.safeParse({
      enabled: false,
      sessions: [],
      notifications: [],
      reports: [unknownOption],
    }).success).toBe(false)
  })

  it('caps the retained report digest at the shared retention', () => {
    const events = [modeEvent(0, true)]
    for (let index = 0; index < DEVLEAD_REPORT_RETENTION + 1; index += 1) {
      events.push(reportEvent(index + 1, report({ message: `update ${index}` })))
    }
    const state = fold(events)
    expect(state.reports).toHaveLength(DEVLEAD_REPORT_RETENTION)
    expect(state.reports[0]?.message).toBe('update 1')
  })

  it('clears reports on reset', () => {
    const state = fold([
      modeEvent(0, true),
      reportEvent(1, report()),
      pluginRecordEvent(2, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0)),
    ])
    expect(state.reports).toEqual([])
  })

  it('freezes on a malformed report receipt', () => {
    const value = { ...report(), id: 'forged' }
    const state = fold([
      modeEvent(0, true),
      pluginRecordEvent(1, DEVLEAD_REPORT_RECORD_TYPE, {
        kind: 'devlead/report',
        version: DEVLEAD_RECORD_VERSION,
        report: value,
      }),
    ])
    expect(state.failure).toContain(DEVLEAD_REPORT_RECORD_TYPE)
    expect(state.reports).toEqual([])
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
      reports: [],
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

  it('rejects unrepresentable instants, oversized digests, and mismatched ids in cached state', () => {
    const state = fold([
      modeEvent(0, true),
      notificationEvent(1, notification()),
    ])
    const outOfRange = notification({ at: DEVLEAD_MAX_INSTANT + 1 })
    expect(devLeadProjectionStateSchema.safeParse({ ...state, notifications: [outOfRange] }).success).toBe(false)
    expect(devLeadProjectionSchema.safeParse({
      enabled: state.enabled,
      sessions: state.sessions,
      notifications: [outOfRange],
      reports: [],
    }).success).toBe(false)

    const tooMany = Array.from(
      { length: DEVLEAD_DEFAULT_NOTIFICATION_RETENTION + 1 },
      (_, index) => notification({ turn: index + 1 }),
    )
    expect(devLeadProjectionStateSchema.safeParse({ ...state, notifications: tooMany }).success).toBe(false)

    const mismatchedId = { ...notification(), id: 'session-alpha:1:error' }
    expect(devLeadProjectionStateSchema.safeParse({ ...state, notifications: [mismatchedId] }).success).toBe(false)
  })

  it('rejects duplicate watch ids and notification ids in a cached state', () => {
    const state = fold([
      modeEvent(0, true),
      watchEvent(1, ['session-alpha']),
      notificationEvent(2, notification()),
    ])
    // The fold writers never produce duplicates; a hand-edited or migrated
    // checkpoint must be discarded instead of restoring a double-counted row.
    expect(devLeadProjectionStateSchema.safeParse({ ...state, sessions: ['session-alpha', 'session-alpha'] }).success)
      .toBe(false)
    expect(devLeadProjectionStateSchema.safeParse({
      ...state,
      notifications: [notification(), notification()],
    }).success).toBe(false)
  })

  it('requires paired, recognized wake-suppression metadata on the wire', () => {
    const view = devLeadProjectionView(fold([modeEvent(0, true)]))
    for (const invalid of [
      { ...notification(), wakeSuppressedByReportId: 'report-1' },
      { ...notification(), wakeSuppressionReason: 'included-in-sent-wake' },
      { ...notification(), wakeSuppressedByReportId: '', wakeSuppressionReason: 'included-in-sent-wake' },
      { ...notification(), wakeSuppressedByReportId: 'report-1', wakeSuppressionReason: 'other' },
    ]) {
      expect(devLeadProjectionSchema.safeParse({ ...view, notifications: [invalid] }).success).toBe(false)
    }
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
      reports: [],
    }
    expect(devLeadProjectionSchema.safeParse(view).success).toBe(false)
    expect(devLeadProjectionSchema.safeParse({ enabled: false, sessions: [''], notifications: [] }).success).toBe(false)
    expect(
      devLeadProjectionSchema.safeParse({
        enabled: false,
        sessions: [],
        notifications: [{ ...notification(), summary: '' }],
        reports: [],
      }).success,
    ).toBe(false)
  })
})

describe('Phase 1e wire question/answer status', () => {
  it('derives questionStatus open then answered with the newest answerStatus on question rows', () => {
    const question = report({ kind: 'question', message: 'Which target?' })
    let state = fold([modeEvent(0, true), reportEvent(1, question)])
    expect(devLeadProjectionView(state).reports).toEqual([{ ...question, questionStatus: 'open' }])
    state = apply(state, answerEvent(2, answer({ reportId: question.id, status: 'admitted' })))
    expect(devLeadProjectionView(state).reports[0]).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'admitted',
    })
    state = apply(state, answerEvent(3, answer({ reportId: question.id, status: 'claimed', messageId: 'msg-answer-2' })))
    expect(devLeadProjectionView(state).reports[0]).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'claimed',
    })
    state = apply(state, answerEvent(4, answer({ reportId: question.id, status: 'presented', messageId: 'msg-answer-3', presentedAt: T0 + 1 })))
    expect(devLeadProjectionView(state).reports[0]).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'presented',
    })
    // A discard reopens the question; the newest durable record stays visible.
    state = apply(state, answerEvent(5, answer({ reportId: question.id, status: 'discarded', messageId: 'msg-answer-4' })))
    expect(devLeadProjectionView(state).reports[0]).toMatchObject({
      questionStatus: 'open',
      answerStatus: 'discarded',
    })
  })

  it('leaves non-question rows unchanged and reuses the state array when no question is retained', () => {
    const progress = report({ kind: 'progress' })
    const plain = fold([reportEvent(0, progress)])
    const plainView = devLeadProjectionView(plain)
    expect(plainView.reports).toBe(plain.reports)
    expect(plainView.reports[0]).not.toHaveProperty('questionStatus')
    // A mixed digest maps only the question rows; the ordinary row object is
    // reused untouched so unchanged rows keep their identity.
    const question = report({ kind: 'question', message: 'Which target?' })
    const mixed = fold([reportEvent(0, progress), reportEvent(1, question)])
    const mixedView = devLeadProjectionView(mixed)
    expect(mixedView.reports[0]).toBe(mixed.reports[0])
    expect(mixedView.reports[0]).not.toHaveProperty('questionStatus')
    expect(mixedView.reports[1]).toMatchObject({ questionStatus: 'open' })
  })

  it('validates the additive pair on the wire and rejects it on non-question rows', () => {
    const question = report({ kind: 'question', message: 'Which target?' })
    const progress = report({ kind: 'progress' })
    const base = { enabled: true, sessions: [], notifications: [] }
    expect(devLeadProjectionSchema.safeParse({
      ...base,
      reports: [{ ...question, questionStatus: 'open' }],
    }).success).toBe(true)
    expect(devLeadProjectionSchema.safeParse({
      ...base,
      reports: [{ ...question, questionStatus: 'answered', answerStatus: 'presented' }],
    }).success).toBe(true)
    // The derived pair is question-only, and answerStatus requires questionStatus.
    expect(devLeadProjectionSchema.safeParse({
      ...base,
      reports: [{ ...progress, questionStatus: 'open' }],
    }).success).toBe(false)
    expect(devLeadProjectionSchema.safeParse({
      ...base,
      reports: [{ ...question, answerStatus: 'admitted' }],
    }).success).toBe(false)
    expect(devLeadProjectionSchema.safeParse({
      ...base,
      reports: [{ ...question, questionStatus: 'unknown' }],
    }).success).toBe(false)
  })

  it('accepts a wire digest up to the retention plus the open-question pin bound', () => {
    const questions = Array.from(
      { length: DEVLEAD_REPORT_RETENTION + DEVLEAD_OPEN_QUESTION_PIN_MAX },
      (_, index) => ({ ...report({ kind: 'question', message: `Q${String(index)}?` }), questionStatus: 'open' as const }),
    )
    const base = { enabled: true, sessions: [], notifications: [] }
    expect(devLeadProjectionSchema.safeParse({ ...base, reports: questions }).success).toBe(true)
    expect(devLeadProjectionSchema.safeParse({
      ...base,
      reports: [...questions, { ...report({ kind: 'question', message: 'one too many?' }), questionStatus: 'open' as const }],
    }).success).toBe(false)
  })

  it('memoizes the wire view per state object across unchanged folds', () => {
    const state = fold([reportEvent(0, report({ kind: 'question', message: 'Which target?' }))])
    const view = devLeadProjectionView(state)
    expect(devLeadProjectionView(state)).toBe(view)
    // An unrelated event keeps the state reference, so the view stays identical.
    const next = apply(state, turnStartEvent(1))
    expect(next).toBe(state)
    expect(devLeadProjectionView(next)).toBe(view)
    // A new state (an answer record) produces a new view with the derived pair.
    const answered = apply(state, answerEvent(1, answer({ reportId: state.reports[0]!.id })))
    expect(devLeadProjectionView(answered)).not.toBe(view)
    expect(devLeadProjectionView(answered).reports[0]).toMatchObject({ questionStatus: 'answered' })
  })
})

describe('reset records', () => {
  it('discards an earlier mode, watch set, and digest when the fold is healthy', () => {
    const state = fold([
      modeEvent(0, true),
      watchEvent(1, ['session-alpha']),
      notificationEvent(2, notification({ sessionId: 'session-alpha', turn: 1 })),
      pluginRecordEvent(3, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0)),
      modeEvent(4, true),
    ])
    expect(state.failure).toBeNull()
    // The reset restarts the fold: earlier records contribute nothing, and the
    // records after it fold normally (the trailing mode record turns it on).
    expect(state).toEqual({ ...emptyDevLeadProjectionState(), enabled: true })
  })

  it('unfreezes a frozen fold and lets later records fold again', () => {
    const frozen = fold([
      modeEvent(0, true),
      watchEvent(1, ['session-alpha']),
      corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION + 1, enabled: false, at: T0 }),
    ])
    expect(frozen.failure).not.toBeNull()
    const recovered = apply(frozen, pluginRecordEvent(2, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0)))
    expect(recovered).toEqual(emptyDevLeadProjectionState())
    const after = apply(apply(recovered, watchEvent(3, ['session-beta'])), modeEvent(4, true))
    expect(after.failure).toBeNull()
    expect(after.sessions).toEqual(['session-beta'])
    expect(after.enabled).toBe(true)
  })

  it('does not unfreeze on a malformed reset payload', () => {
    const frozen = fold([corruptModeRecord({ kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION + 1, enabled: true, at: T0 })])
    const firstFailure = frozen.failure
    const stillFrozen = apply(
      frozen,
      pluginRecordEvent(1, DEVLEAD_RESET_RECORD_TYPE, { kind: 'devlead/reset', version: DEVLEAD_RECORD_VERSION }),
    )
    // A corrupt marker must not be able to discard the evidence of a corrupt
    // log; only a structurally valid human-written reset recovers.
    expect(stillFrozen).toBe(frozen)
    expect(stillFrozen.failure).toBe(firstFailure)
  })

  it('freezes on a malformed reset record when the state was still valid', () => {
    const failed = fold([pluginRecordEvent(0, DEVLEAD_RESET_RECORD_TYPE, { kind: 'devlead/reset', version: DEVLEAD_RECORD_VERSION, at: -1 })])
    expect(failed.failure).toContain(`(${DEVLEAD_RESET_RECORD_TYPE})`)
    expect(failed.failure).toContain('reset record at')
  })

  it('resets the summary-sized mode projection too', () => {
    const enabled = applyDevLeadModeProjection(
      emptyDevLeadModeProjectionState(),
      pluginRecordEvent(0, DEVLEAD_MODE_RECORD_TYPE, { kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: true, at: T0 }),
    )
    expect(enabled).toEqual({ enabled: true, failure: null, inheritedEventCount: 0 })
    const reset = applyDevLeadModeProjection(
      enabled,
      pluginRecordEvent(1, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0)),
    )
    expect(reset).toEqual(emptyDevLeadModeProjectionState())
    // The definition is the registered unit contract: its init matches the
    // recovered state, so a cached checkpoint of either is interchangeable.
    expect(devLeadModeProjectionDefinition.init()).toEqual(emptyDevLeadModeProjectionState())
  })

  it('keeps the reset record inside the strict model-facing vocabulary', () => {
    // The protocol unit vocabulary must name the record type, or a writer could
    // stamp a type the projection registry never folds.
    expect(DEVLEAD_RESET_RECORD_TYPE.startsWith('plugin:')).toBe(true)
    const bad = apply(
      emptyDevLeadProjectionState(),
      pluginRecordEvent(0, DEVLEAD_RESET_RECORD_TYPE, { ...resetRecord(T0), extra: true }),
    )
    expect(bad.failure).toContain('unexpected field "extra"')
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

describe('answer records (Phase 1d)', () => {
  /** One question report fixture with a stable identity. */
  function questionReport(message = 'Which target?') {
    return report({ kind: 'question', message, senderSessionId: 'session-alpha', leadSessionId: 'lead-1' })
  }

  it('derives open for a question with no answer record (legacy log compatibility)', () => {
    const question = questionReport()
    const state = fold([modeEvent(0, true), reportEvent(1, question)])
    expect(state.answers).toEqual([])
    expect(questionStatusOf(state.answers, question.id)).toBe('open')
    expect(questionAnswerViewOf(state, question.id)).toEqual({ questionStatus: 'open' })
  })

  it('derives answered from an admitted answer and exposes the answer facts', () => {
    const question = questionReport()
    const admitted = answer({ reportId: question.id, messageId: 'msg-1', at: T0 + 5 })
    const state = fold([modeEvent(0, true), reportEvent(1, question), answerEvent(2, admitted)])
    expect(state.answers).toEqual([admitted])
    expect(questionStatusOf(state.answers, question.id)).toBe('answered')
    expect(questionAnswerViewOf(state, question.id)).toEqual({
      questionStatus: 'answered',
      answerStatus: 'admitted',
      answerMessageId: 'msg-1',
      answeredAt: T0 + 5,
    })
    // The wire view stays host-only for the answer audit (Phase 1e exposes it).
    const view = devLeadProjectionView(state)
    expect('answers' in view).toBe(false)
    expect(devLeadProjectionStateSchema.safeParse(state).success).toBe(true)
  })

  it('keeps answered for claimed/presented answers and records presentedAt', () => {
    const question = questionReport()
    const presented = answer({
      reportId: question.id,
      status: 'presented',
      at: T0 + 9,
      answeredAt: T0 + 5,
      presentedAt: T0 + 9,
    })
    const state = fold([reportEvent(0, question), answerEvent(1, presented)])
    expect(questionStatusOf(state.answers, question.id)).toBe('answered')
    expect(questionAnswerViewOf(state, question.id)).toMatchObject({
      answerStatus: 'presented',
      answeredAt: T0 + 5,
      presentedAt: T0 + 9,
    })
  })

  it('reopens the question on a discarded answer but preserves answeredAt', () => {
    const question = questionReport()
    const admitted = answer({ reportId: question.id, messageId: 'msg-1', at: T0 + 5 })
    const discarded = answer({ reportId: question.id, messageId: 'msg-1', status: 'discarded', at: T0 + 8, answeredAt: T0 + 5 })
    const state = fold([reportEvent(0, question), answerEvent(1, admitted), answerEvent(2, discarded)])
    expect(questionStatusOf(state.answers, question.id)).toBe('open')
    expect(questionAnswerViewOf(state, question.id)).toEqual({
      questionStatus: 'open',
      answerStatus: 'discarded',
      answerMessageId: 'msg-1',
      answeredAt: T0 + 5,
    })
    // Both facts stay as audit; the newest is authoritative.
    expect(state.answers).toHaveLength(2)
    expect(latestAnswerOf(state.answers, question.id)?.status).toBe('discarded')
  })

  it('reopens the question on a failed answer', () => {
    const question = questionReport()
    const failed = answer({ reportId: question.id, status: 'failed', at: T0 + 3 })
    const state = fold([reportEvent(0, question), answerEvent(1, failed)])
    expect(questionStatusOf(state.answers, question.id)).toBe('open')
  })

  it('lets a re-answer after a discard become answered again (newest record wins)', () => {
    const question = questionReport()
    const events = [
      reportEvent(0, question),
      answerEvent(1, answer({ reportId: question.id, messageId: 'msg-1', at: T0 + 1 })),
      answerEvent(2, answer({ reportId: question.id, messageId: 'msg-1', status: 'discarded', at: T0 + 2, answeredAt: T0 + 1 })),
      answerEvent(3, answer({ reportId: question.id, messageId: 'msg-2', at: T0 + 3, answeredAt: T0 + 1 })),
    ]
    const state = fold(events)
    expect(questionStatusOf(state.answers, question.id)).toBe('answered')
    expect(questionAnswerViewOf(state, question.id)).toMatchObject({ answerMessageId: 'msg-2', answeredAt: T0 + 1 })
  })

  it('deduplicates an exactly replayed answer fact', () => {
    const question = questionReport()
    const admitted = answer({ reportId: question.id })
    const state = fold([reportEvent(0, question), answerEvent(1, admitted), answerEvent(2, admitted)])
    expect(state.answers).toEqual([admitted])
  })

  it('selects the latest answer by admission sequence, not append order (delayed old discard)', () => {
    const question = questionReport()
    // The old answer's discard drains AFTER the newer re-answer was admitted:
    // append order would make the discard latest, the sequence keeps the
    // re-answer authoritative.
    const events = [
      reportEvent(0, question),
      answerEvent(1, answer({ reportId: question.id, messageId: 'msg-1', at: T0 + 1, answerSeq: 1 })),
      answerEvent(2, answer({ reportId: question.id, messageId: 'msg-2', at: T0 + 2, answeredAt: T0 + 1, answerSeq: 2, text: 'use prod' })),
      answerEvent(3, answer({ reportId: question.id, messageId: 'msg-1', status: 'discarded', at: T0 + 9, answeredAt: T0 + 1, answerSeq: 1 })),
    ]
    const state = fold(events)
    expect(latestAnswerOf(state.answers, question.id)?.messageId).toBe('msg-2')
    expect(questionStatusOf(state.answers, question.id)).toBe('answered')
    expect(questionAnswerViewOf(state, question.id)).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'admitted',
      answerMessageId: 'msg-2',
      answeredAt: T0 + 1,
    })
    expect(devLeadProjectionStateSchema.safeParse(state).success).toBe(true)
  })

  it('a same-sequence lifecycle fact still advances the question state (discard of the only answer)', () => {
    const question = questionReport()
    const events = [
      reportEvent(0, question),
      answerEvent(1, answer({ reportId: question.id, messageId: 'msg-1', at: T0 + 1, answerSeq: 1 })),
      answerEvent(2, answer({ reportId: question.id, messageId: 'msg-1', status: 'discarded', at: T0 + 2, answeredAt: T0 + 1, answerSeq: 1 })),
    ]
    const state = fold(events)
    expect(questionStatusOf(state.answers, question.id)).toBe('open')
    expect(latestAnswerOf(state.answers, question.id)?.status).toBe('discarded')
  })

  it('latestAnswerOf ignores pre-sequence rows regardless of their log position', () => {
    const question = questionReport()
    const legacy = legacyAnswer({ reportId: question.id, messageId: 'msg-old', answerSeq: 0 })
    const current = answer({ reportId: question.id, messageId: 'msg-current', answerSeq: 1 })
    expect(latestAnswerOf([legacy], question.id)).toBeUndefined()
    expect(latestAnswerOf([legacy, current], question.id)).toBe(current)
    expect(latestAnswerOf([current, legacy], question.id)).toBe(current)
  })

  it('rejects a malformed answerSeq through the strict decoder', () => {
    const question = questionReport()
    for (const answerSeq of [-1, undefined]) {
      const bad = pluginRecordEvent(2, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, {
        kind: 'devlead/report-answer',
        version: DEVLEAD_RECORD_VERSION,
        answer: { ...answer({ reportId: question.id }), answerSeq },
      })
      const state = fold([reportEvent(0, question), bad])
      expect(state.failure).toContain('answerSeq')
    }
  })

  it('falls back to the admission instant for a current admitted record without answeredAt', () => {
    const question = questionReport()
    const admitted = answer({ reportId: question.id, messageId: 'msg-1', at: T0 + 5 })
    const { answeredAt: _answeredAt, ...withoutAnsweredAt } = admitted
    const state = fold([reportEvent(0, question), answerEvent(1, withoutAnsweredAt)])
    expect(questionAnswerViewOf(state, question.id)).toMatchObject({
      questionStatus: 'answered',
      answeredAt: T0 + 5,
    })
  })

  it('clears answers on reset', () => {
    const question = questionReport()
    const state = fold([
      modeEvent(0, true),
      reportEvent(1, question),
      answerEvent(2, answer({ reportId: question.id })),
      pluginRecordEvent(3, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0)),
    ])
    expect(state.answers).toEqual([])
    expect(state.reports).toEqual([])
  })

  it('freezes on a malformed answer record and keeps the digest/watch units aligned', () => {
    const question = questionReport()
    const malformed = pluginRecordEvent(2, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, {
      kind: 'devlead/report-answer',
      version: DEVLEAD_RECORD_VERSION,
      answer: { ...answer({ reportId: question.id }), textHash: 'not-a-hash' },
    })
    const events = [modeEvent(0, true), reportEvent(1, question), malformed]
    const state = fold(events)
    expect(state.failure).toContain(DEVLEAD_REPORT_ANSWER_RECORD_TYPE)
    expect(state.answers).toEqual([])
    // The summary units decode the same owned record so they freeze on the same log.
    const watchState = events.reduce(applyDevLeadWatchProjection, emptyDevLeadWatchProjectionState())
    expect(watchState.failure).toContain(DEVLEAD_REPORT_ANSWER_RECORD_TYPE)
    const modeState = events.reduce(applyDevLeadModeProjection, emptyDevLeadModeProjectionState())
    expect(modeState.failure).toContain(DEVLEAD_REPORT_ANSWER_RECORD_TYPE)
  })

  it('rejects presentedAt on a non-presented answer through the strict decoder', () => {
    const question = questionReport()
    const bad = answer({ reportId: question.id, status: 'admitted', presentedAt: T0 + 1 })
    const state = fold([reportEvent(0, question), answerEvent(1, bad)])
    expect(state.failure).toContain('presentedAt is only valid')
  })

  it('pins an open question against report retention and evicts it once answered', () => {
    const question = questionReport('pinned open question')
    const events: SessionEvent[] = [modeEvent(0, true), reportEvent(1, question)]
    // Fill the digest past retention with ordinary reports; the open question stays.
    for (let index = 0; index < DEVLEAD_REPORT_RETENTION + 5; index += 1) {
      events.push(reportEvent(events.length, report({ message: `update ${index}` })))
    }
    let state = fold(events)
    // The digest stays at retention, but the pinned open question survives even
    // though it is the oldest row (an ordinary row was evicted in its place).
    expect(state.reports).toHaveLength(DEVLEAD_REPORT_RETENTION)
    expect(state.reports.some(existing => existing.id === question.id)).toBe(true)
    expect(state.reports.some(existing => existing.message === 'update 0')).toBe(false)
    // Answering the question unpins it: a later append evicts it as the oldest
    // evictable row, so a answered question no longer occupies the digest.
    state = apply(state, answerEvent(events.length, answer({ reportId: question.id })))
    state = apply(state, reportEvent(events.length + 1, report({ message: 'one more' })))
    expect(state.reports).toHaveLength(DEVLEAD_REPORT_RETENTION)
    expect(state.reports.some(existing => existing.id === question.id)).toBe(false)
  })

  it('bounds the open-question pin so a never-answered lead cannot grow without limit', () => {
    const events: SessionEvent[] = [modeEvent(0, true)]
    const total = DEVLEAD_REPORT_RETENTION + DEVLEAD_OPEN_QUESTION_PIN_MAX + 5
    for (let index = 0; index < total; index += 1) {
      events.push(reportEvent(index + 1, report({ kind: 'question', message: `open question ${index}` })))
    }
    const state = fold(events)
    expect(state.reports.length).toBeLessThanOrEqual(DEVLEAD_REPORT_RETENTION + DEVLEAD_OPEN_QUESTION_PIN_MAX)
    // The oldest pinned questions were evicted honestly; the newest remain.
    expect(state.reports.some(existing => existing.message === `open question ${total - 1}`)).toBe(true)
    expect(state.reports.some(existing => existing.message === 'open question 0')).toBe(false)
  })

  it('bounds the answer audit and pins the newest fact of a retained question', () => {
    const question = questionReport()
    const events: SessionEvent[] = [modeEvent(0, true), reportEvent(1, question)]
    // Many answered questions' facts, then the retained question's newest fact.
    for (let index = 0; index < DEVLEAD_ANSWER_RETENTION + 10; index += 1) {
      events.push(answerEvent(events.length, answer({
        reportId: `session-alpha:1:report:question:q${index}`,
        messageId: `msg-${index}`,
        at: T0 + index,
      })))
    }
    const newest = answer({ reportId: question.id, messageId: 'msg-newest', at: T0 + 999 })
    events.push(answerEvent(events.length, newest))
    const state = fold(events)
    expect(state.answers.length).toBeLessThanOrEqual(DEVLEAD_ANSWER_RETENTION)
    expect(latestAnswerOf(state.answers, question.id)?.messageId).toBe('msg-newest')
    expect(devLeadProjectionStateSchema.safeParse(state).success).toBe(true)
  })

  it('round-trips a canonical answer record through the strict decoder', () => {
    const value = answer({ idempotencyKey: 'key-1' })
    const state = fold([answerEvent(0, value)])
    expect(state.answers).toEqual([value])
    expect(state.failure).toBeNull()
    expect(reportAnswerRecord(value).kind).toBe('devlead/report-answer')
  })
})

describe('runtime repair projection', () => {
  it('publishes and clears repairPending through whole-value repair records', () => {
    const question = report({ kind: 'question', message: 'Which target?' })
    const initial = fold([reportEvent(0, question)])
    const durable = devLeadProjectionView(initial)
    expect(durable.reports[0]?.repairPending).toBeUndefined()
    const pendingState = apply(initial, pluginRecordEvent(1, DEVLEAD_REPAIR_RECORD_TYPE, repairRecord('lead-1', [question.id], T0 + 1)))
    const pending = devLeadProjectionView(pendingState)
    expect(pending).not.toBe(durable)
    expect(pending.reports[0]).toMatchObject({ questionStatus: 'open', repairPending: true })
    expect(devLeadProjectionSchema.parse(pending)).toEqual(pending)
    const settledState = apply(pendingState, pluginRecordEvent(2, DEVLEAD_REPAIR_RECORD_TYPE, repairRecord('lead-1', [], T0 + 2)))
    const settled = devLeadProjectionView(settledState)
    expect(settled.reports[0]?.repairPending).toBeUndefined()
    expect(settled.reports[0]?.id).toBe(question.id)
  })

  it('rejects a pre-repair v6 cache row instead of restoring it', () => {
    const { repairPending: _repairPending, ...v6 } = emptyDevLeadProjectionState()
    expect(v6).not.toHaveProperty('repairPending')
    expect(devLeadProjectionStateSchema.safeParse(v6).success).toBe(false)
    expect(devLeadProjectionDefinition.stateVersion).toBe(7)
  })
})
