/**
 * Pure unit coverage of the Host-side DevLead vocabulary: strict record
 * decoders, message builders, and the shared excerpt helpers.
 *
 * Every payload is hand-built in memory; no Session, service, timer, or wall
 * clock is involved.
 */

import { describe, expect, it } from 'vitest'
import {
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_QUESTIONS_MAX,
  DEVLEAD_QUESTION_FIELD_MAX,
  DEVLEAD_QUESTION_OPTIONS_MAX,
  DEVLEAD_RECORD_VERSION,
  DEVLEAD_WATCH_RECORD_TYPE,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assistantExcerpt,
  createDevLeadNoticeMessage,
  createDevLeadPromptMessage,
  decodeModeRecord,
  decodeNotification,
  decodeNotificationRecord,
  decodeReport,
  decodeWatchRecord,
  devLeadNotification,
  devLeadReport,
  failureExcerpt,
  modeRecord,
  notificationRecord,
  representableInstant,
  watchRecord,
} from '../src/domain.ts'
import { T0 } from './harness.ts'

/** One canonical mode payload. */
function modePayload(): Record<string, unknown> {
  return { kind: 'devlead/mode', version: DEVLEAD_RECORD_VERSION, enabled: true, at: T0 }
}

/** One canonical watch payload. */
function watchPayload(): Record<string, unknown> {
  return { kind: 'devlead/watch', version: DEVLEAD_RECORD_VERSION, sessions: ['s1'], at: T0 }
}

/** One canonical notification value. */
function notificationValue(): Record<string, unknown> {
  return { ...devLeadNotification('session-alpha', undefined, 'completed', 1, T0) }
}

/** One canonical notification record payload. */
function notificationPayload(): Record<string, unknown> {
  return {
    kind: 'devlead/notification',
    version: DEVLEAD_RECORD_VERSION,
    notification: notificationValue(),
  }
}

/** One canonical structured question report value. */
function questionReportValue(): Record<string, unknown> {
  return {
    ...devLeadReport({
      senderSessionId: 'child-1',
      leadSessionId: 'lead-1',
      turn: 2,
      kind: 'question',
      message: 'Which target?',
      questions: [{
        id: 'target',
        header: 'Deploy',
        question: 'Which target?',
        options: [{ label: 'Staging', description: 'safe' }, { label: 'Prod' }],
        multi_select: false,
      }],
      at: T0,
    }),
  }
}

describe('builders', () => {
  it('stamps the record envelope and version on every durable payload', () => {
    expect(modeRecord(true, T0)).toEqual({ kind: 'devlead/mode', version: 1, enabled: true, at: T0 })
    expect(watchRecord(['a', 'b'], T0)).toEqual({
      kind: 'devlead/watch',
      version: 1,
      sessions: ['a', 'b'],
      at: T0,
    })
    const value = devLeadNotification('session-alpha', 'webapp', 'error', 2, T0, 'boom', 'summary')
    expect(notificationRecord(value)).toEqual({ kind: 'devlead/notification', version: 1, notification: value })
  })

  it('omits absent optional notification fields instead of writing undefined', () => {
    const value = devLeadNotification('session-alpha', undefined, 'completed', 1, T0)
    expect(Object.keys(value).sort()).toEqual(['at', 'id', 'sessionId', 'transition', 'turn'])
    expect(value.id).toBe(notificationId('session-alpha', 1, 'completed'))
  })

  it('stores notification titles in the same bounded single-line form readers draw', () => {
    const multiline = devLeadNotification('session-alpha', 'webapp\n- forged line', 'completed', 1, T0)
    expect(multiline.sessionTitle).toBe('webapp - forged line')
    const long = devLeadNotification('session-alpha', 'x'.repeat(500), 'completed', 1, T0)
    expect(long.sessionTitle).toHaveLength(DEVLEAD_ERROR_EXCERPT_MAX)
    expect(long.sessionTitle?.endsWith('…')).toBe(true)
    expect(devLeadNotification('session-alpha', '   ', 'completed', 1, T0)).not.toHaveProperty('sessionTitle')
  })

  it('attributes relay and notice messages to the devlead kind', () => {
    const lead = { id: SessionId('lead-session') } as unknown as Agent
    const relay = createDevLeadPromptMessage('work', lead)
    expect(relay.source).toEqual({ kind: 'devlead', form: 'relay', senderSessionId: 'lead-session' })
    const notice = createDevLeadNoticeMessage('digest')
    expect(notice.source).toEqual({ kind: 'devlead', form: 'notice' })
  })

  it('adds optional wake classification to notice sources without changing the default', () => {
    const notice = createDevLeadNoticeMessage('question', {
      wakeRequested: true,
      lane: 'action-required',
      summary: 'Question: Deploy',
      reportId: 'child:1:report:question:abc',
    })
    expect(notice.source).toEqual({
      kind: 'devlead',
      form: 'notice',
      wakeRequested: true,
      lane: 'action-required',
      summary: 'Question: Deploy',
      reportId: 'child:1:report:question:abc',
    })
    expect(createDevLeadNoticeMessage('plain').source).toEqual({ kind: 'devlead', form: 'notice' })
  })
})

describe('strict decoders', () => {
  it('round-trips the canonical payloads', () => {
    expect(decodeModeRecord(modePayload())).toEqual(modeRecord(true, T0))
    expect(decodeWatchRecord(watchPayload())).toEqual(watchRecord(['s1'], T0))
    expect(decodeNotification(notificationValue())).toEqual(
      devLeadNotification('session-alpha', undefined, 'completed', 1, T0),
    )
    expect(decodeNotificationRecord(notificationPayload())).toEqual(
      devLeadNotification('session-alpha', undefined, 'completed', 1, T0),
    )
  })

  it('round-trips paired wake-suppression metadata', () => {
    const suppressed = {
      ...notificationValue(),
      wakeSuppressedByReportId: 'child:1:report:question:abc',
      wakeSuppressionReason: 'included-in-sent-wake',
    }
    expect(decodeNotification(suppressed)).toEqual(suppressed)
    for (const payload of [
      { ...notificationValue(), wakeSuppressedByReportId: 'report-1' },
      { ...notificationValue(), wakeSuppressionReason: 'merged-into-pending-wake' },
      { ...notificationValue(), wakeSuppressedByReportId: '', wakeSuppressionReason: 'included-in-sent-wake' },
      { ...notificationValue(), wakeSuppressedByReportId: 'report-1', wakeSuppressionReason: 'other' },
    ]) {
      expect(() => decodeNotification(payload)).toThrow(/wakeSuppress/u)
    }
  })

  it('round-trips structured questions and keeps legacy reports absent-field compatible', () => {
    expect(decodeReport(questionReportValue())).toEqual(questionReportValue())
    const legacy = devLeadReport({
      senderSessionId: 'child-1',
      leadSessionId: 'lead-1',
      turn: 1,
      kind: 'progress',
      message: 'plain update',
      at: T0,
    })
    expect(decodeReport({ ...legacy })).toEqual(legacy)
    expect(decodeReport({ ...legacy })).not.toHaveProperty('questions')
  })

  it('deep-copies structured questions at the builder and decoder boundaries', () => {
    const payload = questionReportValue()
    const decoded = decodeReport(payload)
    const questions = payload.questions as Array<{
      question: string
      options: Array<{ label: string; description?: string }>
    }>
    questions[0]!.question = 'changed'
    questions[0]!.options[0]!.description = 'changed'
    expect(decoded.questions?.[0]?.question).toBe('Which target?')
    expect(decoded.questions?.[0]?.options?.[0]?.description).toBe('safe')
    expect(decoded.questions).not.toBe(payload.questions)
    expect(decoded.questions?.[0]?.options).not.toBe(questions[0]!.options)
  })

  it('rejects malformed, oversized, or non-question structured payloads', () => {
    const baseQuestion = (questionReportValue().questions as unknown[])[0]!
    const cases: Array<[string, unknown]> = [
      ['non-array', 'not-an-array'],
      ['too many questions', Array.from({ length: DEVLEAD_QUESTIONS_MAX + 1 }, () => baseQuestion)],
      ['wrong report kind', [baseQuestion]],
      ['unknown question field', [{ ...baseQuestion as object, extra: true }]],
      ['missing question', [{ id: 'q' }]],
      ['empty question', [{ question: '   ' }]],
      ['oversized question', [{ question: 'x'.repeat(DEVLEAD_QUESTION_FIELD_MAX + 1) }]],
      ['non-boolean multi-select', [{ ...baseQuestion as object, multi_select: 'yes' }]],
      ['non-array options', [{ ...baseQuestion as object, options: 'invalid' }]],
      [
        'too many options',
        [{ ...baseQuestion as object, options: Array.from({ length: DEVLEAD_QUESTION_OPTIONS_MAX + 1 }, () => ({ label: 'x' })) }],
      ],
      ['unknown option field', [{ question: 'q', options: [{ label: 'x', extra: true }] }]],
      ['missing option label', [{ question: 'q', options: [{ description: 'x' }] }]],
      ['oversized option description', [{ question: 'q', options: [{ label: 'x', description: 'x'.repeat(2_001) }] }]],
    ]
    for (const [label, questions] of cases) {
      const kind = label === 'wrong report kind' ? 'progress' : 'question'
      expect(() => decodeReport({ ...questionReportValue(), kind, questions }), label).toThrow()
    }
  })

  it('copies the decoded watch set so callers cannot mutate a persisted array', () => {
    const payload = watchPayload()
    const sessions = payload.sessions as string[]
    const decoded = decodeWatchRecord(payload)
    sessions.push('s2')
    expect(decoded.sessions).toEqual(['s1'])
    expect(decoded.sessions).not.toBe(sessions)
  })

  it('rejects persisted excerpts longer than the writer contract', () => {
    const oversized = 'x'.repeat(DEVLEAD_ERROR_EXCERPT_MAX + 1)
    for (const field of ['sessionTitle', 'error', 'summary']) {
      expect(() => decodeNotification({ ...notificationValue(), [field]: oversized })).toThrow(/at most 240/)
    }
    // The exact writer budget is accepted.
    expect(decodeNotification({
      ...notificationValue(),
      summary: 'y'.repeat(DEVLEAD_ERROR_EXCERPT_MAX),
    }).summary).toHaveLength(DEVLEAD_ERROR_EXCERPT_MAX)
  })

  it('rejects unknown and missing fields on every payload', () => {
    const cases: Array<[string, () => unknown]> = [
      ['mode extra', () => decodeModeRecord({ ...modePayload(), extra: 1 })],
      ['mode missing', () => decodeModeRecord({ kind: 'devlead/mode', version: 1, at: T0 })],
      ['watch extra', () => decodeWatchRecord({ ...watchPayload(), extra: 1 })],
      ['watch missing', () => decodeWatchRecord({ kind: 'devlead/watch', version: 1, at: T0 })],
      ['notification extra', () => decodeNotification({ ...notificationValue(), extra: 1 })],
      ['notification missing', () => decodeNotification({ sessionId: 's', turn: 1 })],
      ['notification record extra', () => decodeNotificationRecord({ ...notificationPayload(), extra: 1 })],
      [
        'notification record missing',
        () => decodeNotificationRecord({ kind: 'devlead/notification', version: 1 }),
      ],
    ]
    for (const [label, run] of cases) {
      expect(() => run(), label).toThrow(/unexpected field|missing field/u)
    }
  })

  it('rejects an instant outside the representable Date range', () => {
    for (const at of [-1, 1.5, 8_640_000_000_000_001]) {
      expect(() => decodeModeRecord({ ...modePayload(), at })).toThrow(/epoch milliseconds/u)
      expect(() => decodeWatchRecord({ ...watchPayload(), at })).toThrow(/epoch milliseconds/u)
      expect(() => decodeNotification({ ...notificationValue(), at })).toThrow(/epoch milliseconds/u)
    }
  })

  it('rejects a turn outside the positive safe-integer range', () => {
    for (const turn of [0, -2, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => decodeNotification({ ...notificationValue(), turn })).toThrow(/positive safe integer/u)
    }
  })

  it('rejects a notification whose id is not the deterministic identity', () => {
    const payload = { ...notificationValue(), id: 'session-alpha:2:completed' }
    expect(() => decodeNotification(payload)).toThrow(/id must be session-alpha:1:completed/u)
  })

  it('rejects a transition outside the mirrored union', () => {
    expect(() => decodeNotification({ ...notificationValue(), transition: 'failed' })).toThrow(/not recognized/u)
  })
})

describe('representableInstant', () => {
  it('keeps representable instants and substitutes the fallback otherwise', () => {
    expect(representableInstant(0, 1)).toBe(0)
    expect(representableInstant(8_640_000_000_000_000, 1)).toBe(8_640_000_000_000_000)
    expect(representableInstant(8_640_000_000_000_001, 1)).toBe(1)
    expect(representableInstant(-1, 1)).toBe(1)
    expect(representableInstant(Number.NaN, 1)).toBe(1)
    expect(representableInstant(1.5, 1)).toBe(1)
  })
})

describe('excerpt helpers', () => {
  it('joins and collapses assistant text blocks into one bounded line', () => {
    expect(assistantExcerpt([
      { type: 'text', text: '  first\n' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: ' second  ' },
    ])).toBe('first second')
    expect(assistantExcerpt([{ type: 'reasoning', text: 'hidden' }])).toBeUndefined()
    expect(assistantExcerpt([{ type: 'text', text: '   ' }])).toBeUndefined()
  })

  it('bounds the assistant excerpt with one ellipsis at the protocol maximum', () => {
    const excerpt = assistantExcerpt([{ type: 'text', text: 'x'.repeat(DEVLEAD_ERROR_EXCERPT_MAX + 100) }])
    expect(excerpt).toHaveLength(DEVLEAD_ERROR_EXCERPT_MAX)
    expect(excerpt?.endsWith('…')).toBe(true)
  })

  it('extracts the message of Error and structured failure values', () => {
    expect(failureExcerpt(new Error('  boom\n happened '))).toBe('boom happened')
    // LlmFailure is a plain record rather than an Error instance.
    expect(failureExcerpt({ message: 'quota exhausted', code: 'PROVIDER_ERROR' })).toBe('quota exhausted')
    expect(failureExcerpt('raw failure')).toBe('raw failure')
  })

  it('returns undefined when no excerpt remains', () => {
    expect(failureExcerpt('   ')).toBeUndefined()
  })

  it('exports the record type names the plugin record map declares', () => {
    expect(DEVLEAD_MODE_RECORD_TYPE).toBe('plugin:devlead/mode')
    expect(DEVLEAD_WATCH_RECORD_TYPE).toBe('plugin:devlead/watch')
    expect(DEVLEAD_NOTIFICATION_RECORD_TYPE).toBe('plugin:devlead/notification')
  })
})
