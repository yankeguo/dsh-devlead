/**
 * Pure global single-active vocabulary: durable enable-time extraction,
 * deterministic recovery ranking, and the human-facing refusal. The service
 * scan is covered in `service.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_RESET_RECORD_TYPE,
  modeRecord,
  resetRecord,
} from '../src/index.ts'
import {
  activeSessionLabel,
  alreadyActiveMessage,
  lastEnabledAt,
  rankActiveSessions,
  type DevLeadActiveSession,
} from '../src/active.ts'
import { T0 } from './harness.ts'
import { modeEvent, pluginRecordEvent, sessionEvent } from './fixtures.ts'

/** Build one active occupant fixture. */
function occupant(
  sessionId: string,
  overrides: Partial<Omit<DevLeadActiveSession, 'sessionId'>> = {},
): DevLeadActiveSession {
  return {
    sessionId,
    live: true,
    archived: false,
    running: false,
    createdAt: T0,
    enabledAt: 0,
    ...overrides,
  }
}

describe('lastEnabledAt', () => {
  it('tracks the latest enable and clears on a reset', () => {
    expect(lastEnabledAt([
      modeEvent(0, true, T0),
      modeEvent(1, false, T0 + 1),
      modeEvent(2, true, T0 + 2),
    ])).toBe(T0 + 2)
    expect(lastEnabledAt([
      modeEvent(0, true, T0),
      pluginRecordEvent(1, DEVLEAD_RESET_RECORD_TYPE, resetRecord(T0 + 1), T0 + 1),
    ])).toBeUndefined()
  })

  it('ignores unrelated and malformed records without throwing', () => {
    expect(lastEnabledAt([
      sessionEvent(0, 'turn/start', { turn: 1 }),
      pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, { enabled: 'yes', at: T0 }),
      pluginRecordEvent(2, DEVLEAD_MODE_RECORD_TYPE, { enabled: true, at: 'later' }),
      pluginRecordEvent(3, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, Number.NaN)),
    ])).toBeUndefined()
  })
})

describe('rankActiveSessions', () => {
  it('prefers the incumbent, then non-archived, live, running, newest enable, and id', () => {
    const archived = occupant('archived', { archived: true, running: true, enabledAt: T0 + 99 })
    const cold = occupant('cold', { live: false, enabledAt: T0 + 50 })
    const idle = occupant('idle', { enabledAt: T0 + 10 })
    const running = occupant('running', { running: true, enabledAt: T0 + 1 })
    expect(rankActiveSessions([archived, cold, idle, running]).map(item => item.sessionId))
      .toEqual(['running', 'idle', 'cold', 'archived'])
    expect(rankActiveSessions([archived, cold, idle, running], 'cold')[0]?.sessionId).toBe('cold')
  })

  it('breaks complete ties by Session id', () => {
    expect(rankActiveSessions([occupant('b'), occupant('a')]).map(item => item.sessionId))
      .toEqual(['a', 'b'])
  })
})

describe('single-active copy', () => {
  it('labels an occupant by title plus id, or by id alone', () => {
    expect(activeSessionLabel(occupant('session-1', { title: 'Webapp' }))).toBe('Webapp (session-1)')
    expect(activeSessionLabel(occupant('session-1', { title: '   ' }))).toBe('session-1')
  })

  it('folds the occupant title to one bounded line before it reaches a human error', () => {
    expect(activeSessionLabel(occupant('session-1', { title: 'Web\napp' }))).toBe('Web app (session-1)')
    const long = activeSessionLabel(occupant('session-1', { title: 'x'.repeat(400) }))
    expect(long.endsWith(' (session-1)')).toBe(true)
    expect(long.length).toBeLessThan(260)
    expect(long).not.toContain('\n')
  })

  it('tells the human which Session holds the mode and how to switch', () => {
    const message = alreadyActiveMessage(occupant('session-1', { title: 'Webapp' }))
    expect(message).toContain('Webapp (session-1)')
    expect(message).toContain('/devlead off')
    expect(message).toContain('enable this Session')
  })
})
