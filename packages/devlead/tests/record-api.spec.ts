import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PluginRecordType } from '@deepseek-ai/dsh-session/types'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_REPORT_ANSWER_RECORD_TYPE,
  DEVLEAD_REPORT_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import { devLeadReport, modeRecord, reportAnswerRecord, reportRecord } from '../src/domain.ts'
import {
  applyDevLeadModeProjection,
  applyDevLeadProjection,
  applyDevLeadWatchProjection,
  emptyDevLeadModeProjectionState,
  emptyDevLeadProjectionState,
  emptyDevLeadWatchProjectionState,
} from '../src/fold.ts'
import {
  RECORD_API_IMPACT,
  appendRecord,
  initializeRecordApi,
  readRecord,
  recordApiStatus,
  resetRecordApiForTests,
  setRecordApiImplementationForTests,
} from '../src/record-api.ts'
import type { RecordApiImplementation } from '../src/record-api.ts'
import { T0, answer, modeEvent } from './fixtures.ts'
import { bootService, disposeHarnesses, projectionStateOf } from './harness.ts'

const session = {} as Session

function logger() {
  return { warn: vi.fn((_message: string) => {}) }
}

afterEach(async () => {
  await disposeHarnesses()
  resetRecordApiForTests()
})

describe('record API facade', () => {
  it('keeps the normal append/read path unchanged (negative control)', () => {
    const append = vi.fn()
    const event = modeEvent(0, true)
    const read = vi.fn(() => ({
      type: DEVLEAD_MODE_RECORD_TYPE as PluginRecordType,
      seq: SessionSeq(0),
      time: 1,
      data: modeRecord(true, 1),
    }))
    const implementation: RecordApiImplementation = {
      appendPluginRecord: (target, type, data) => append(target, type, data),
      pluginRecordOf: read,
    }
    const hostLogger = logger()
    setRecordApiImplementationForTests(implementation, hostLogger)

    expect(recordApiStatus()).toEqual({ status: 'available' })
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(true)
    expect(readRecord(event)).toEqual({
      type: DEVLEAD_MODE_RECORD_TYPE,
      seq: SessionSeq(0),
      time: 1,
      data: modeRecord(true, 1),
    })
    expect(append).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
    expect(hostLogger.warn).not.toHaveBeenCalled()
    expect(applyDevLeadProjection(emptyDevLeadProjectionState(), event).enabled).toBe(true)
  })

  it('detects missing exports at init, warns once, and fails closed without throwing', () => {
    const hostLogger = logger()
    setRecordApiImplementationForTests({}, hostLogger)
    initializeRecordApi(hostLogger)

    expect(recordApiStatus()).toEqual({
      status: 'degraded',
      reason: 'missing or non-function export(s): appendPluginRecord, pluginRecordOf',
    })
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(false)
    expect(readRecord(modeEvent(0, true))).toBeUndefined()
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(false, 2))).toBe(false)
    expect(hostLogger.warn).toHaveBeenCalledOnce()
    const warning = hostLogger.warn.mock.calls[0]?.[0] as string
    expect(warning).toContain('durable_state=unavailable')
    expect(warning).toContain('reason=')
    expect(warning).toContain(RECORD_API_IMPACT)
  })

  it('fails closed when only the reader is missing and never invokes the healthy writer', () => {
    const append = vi.fn()
    const implementation: Partial<RecordApiImplementation> = {
      appendPluginRecord: (target, type, data) => append(target, type, data),
    }
    const hostLogger = logger()
    setRecordApiImplementationForTests(implementation, hostLogger)

    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(false)
    expect(readRecord(modeEvent(0, true))).toBeUndefined()
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(false)
    expect(append).not.toHaveBeenCalled()
    expect(recordApiStatus().status).toBe('degraded')
    expect(hostLogger.warn).toHaveBeenCalledOnce()
  })

  it('fails closed writer-only degradation while the healthy reader serves existing durable state', async () => {
    let questionId = ''
    setRecordApiImplementationForTests({ pluginRecordOf })
    const harness = await bootService({
      enabled: true,
      seedLead: (leadSession) => {
        const question = devLeadReport({
          senderSessionId: 'target',
          leadSessionId: String(leadSession.id),
          turn: 1,
          kind: 'question',
          message: 'Which target?',
          at: T0,
        })
        questionId = question.id
        appendPluginRecord(leadSession, DEVLEAD_REPORT_RECORD_TYPE, reportRecord(question))
        appendPluginRecord(leadSession, DEVLEAD_REPORT_ANSWER_RECORD_TYPE, reportAnswerRecord(answer({
          reportId: question.id,
          leadSessionId: String(leadSession.id),
          sessionId: 'target',
          messageId: 'm1',
          status: 'admitted',
          at: T0,
        })))
      },
    })
    const lead = harness.lead as unknown as Agent

    expect(harness.service.durableState).toEqual({
      status: 'degraded',
      reason: 'missing or non-function export(s): appendPluginRecord',
    })
    expect(harness.service.view(lead).enabled).toBe(true)
    expect(harness.service.questionAnswerView(lead, questionId)).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'admitted',
      answerMessageId: 'm1',
      answeredAt: T0,
    })
    expect(projectionStateOf(harness.leadSession)).toMatchObject({
      enabled: true,
      failure: null,
      reports: [{ id: questionId }],
    })
    expect(appendRecord(harness.leadSession, DEVLEAD_MODE_RECORD_TYPE, modeRecord(false, T0 + 1))).toBe(false)

    const eventCount = harness.leadSession.snapshotEvents().length
    await expect(harness.service.setEnabled(lead, false)).rejects.toThrow(
      'DSH plugin-record API unavailable: missing or non-function export(s): appendPluginRecord',
    )
    expect(harness.service.view(lead).enabled).toBe(true)
    expect(harness.leadSession.snapshotEvents()).toHaveLength(eventCount)
    expect(harness.service.questionAnswerView(lead, questionId)).toMatchObject({
      questionStatus: 'answered',
      answerStatus: 'admitted',
      answerMessageId: 'm1',
    })
  })

  it('degrades on persistent thrown writes and keeps one warning while allowing reads', () => {
    const read = vi.fn()
    const implementation: RecordApiImplementation = {
      appendPluginRecord: () => { throw new Error('append rejected\nread-only session') },
      pluginRecordOf: read,
    }
    const hostLogger = logger()
    setRecordApiImplementationForTests(implementation, hostLogger)

    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(false)
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(false)
    expect(readRecord(modeEvent(0, true))).toBeUndefined()
    expect(recordApiStatus()).toEqual({
      status: 'degraded',
      reason: 'appendPluginRecord threw: append rejected read-only session',
    })
    expect(read).toHaveBeenCalledOnce()
    expect(hostLogger.warn).toHaveBeenCalledOnce()
  })

  it('allows a later write retry without hiding the earlier durability loss', () => {
    let attempts = 0
    const implementation: RecordApiImplementation = {
      appendPluginRecord: () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient rejection')
      },
      pluginRecordOf: () => undefined,
    }
    const hostLogger = logger()
    setRecordApiImplementationForTests(implementation, hostLogger)

    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(false)
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(true)
    expect(attempts).toBe(2)
    expect(recordApiStatus()).toEqual({
      status: 'degraded',
      reason: 'appendPluginRecord threw: transient rejection',
    })
    expect(hostLogger.warn).toHaveBeenCalledOnce()
  })

  it('blocks writes after a later read failure and retains the last valid fold state', () => {
    const event = modeEvent(0, true)
    const append = vi.fn()
    let failRead = false
    const read = vi.fn(() => {
      if (failRead) throw new Error('reader failed after a successful read')
      return {
        type: DEVLEAD_MODE_RECORD_TYPE as PluginRecordType,
        seq: SessionSeq(0),
        time: T0,
        data: modeRecord(true, T0),
      }
    })
    const implementation: RecordApiImplementation = {
      appendPluginRecord: (target, type, data) => append(target, type, data),
      pluginRecordOf: read,
    }
    const hostLogger = logger()
    setRecordApiImplementationForTests(implementation, hostLogger)

    expect(readRecord(event)).toMatchObject({ type: DEVLEAD_MODE_RECORD_TYPE })
    const lastValid = applyDevLeadProjection(emptyDevLeadProjectionState(), event)
    expect(lastValid).toMatchObject({ enabled: true, failure: null })
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, T0))).toBe(true)
    append.mockClear()

    failRead = true
    expect(readRecord(event)).toBeUndefined()
    const afterFailure = applyDevLeadProjection(lastValid, event)
    expect(afterFailure).toBe(lastValid)
    expect(afterFailure).toMatchObject({ enabled: true, failure: null })
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(false, T0 + 1))).toBe(false)
    expect(append).not.toHaveBeenCalled()
    expect(hostLogger.warn).toHaveBeenCalledOnce()
  })

  it('degrades on the first thrown read, blocks later writes, and never freezes any DevLead fold', () => {
    const append = vi.fn()
    const implementation: RecordApiImplementation = {
      appendPluginRecord: (target, type, data) => append(target, type, data),
      pluginRecordOf: () => { throw new Error('reader removed') },
    }
    const hostLogger = logger()
    setRecordApiImplementationForTests(implementation, hostLogger)
    const event = modeEvent(0, true)

    const digest = applyDevLeadProjection(emptyDevLeadProjectionState(), event)
    const watch = applyDevLeadWatchProjection(emptyDevLeadWatchProjectionState(), event)
    const mode = applyDevLeadModeProjection(emptyDevLeadModeProjectionState(), event)
    expect(digest).toEqual(emptyDevLeadProjectionState())
    expect(watch).toEqual(emptyDevLeadWatchProjectionState())
    expect(mode).toEqual(emptyDevLeadModeProjectionState())
    expect(digest.failure).toBeNull()
    expect(watch.failure).toBeNull()
    expect(mode.failure).toBeNull()
    expect(readRecord(event)).toBeUndefined()
    expect(appendRecord(session, DEVLEAD_MODE_RECORD_TYPE, modeRecord(true, 1))).toBe(false)
    expect(append).not.toHaveBeenCalled()
    expect(hostLogger.warn).toHaveBeenCalledOnce()
  })

  it('loads the real service with a missing API and serves the default, unfrozen view', async () => {
    const warnings: string[] = []
    setRecordApiImplementationForTests({})
    const harness = await bootService({
      persistence: false,
      beforeServicePlugin: (ctx) => {
        vi.spyOn(ctx.logger, 'warn').mockImplementation((message) => {
          warnings.push(String(message))
        })
      },
    })
    const lead = harness.lead as unknown as Agent

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('durable_state=unavailable')
    expect(harness.service.durableState.status).toBe('degraded')
    expect(harness.service.view(lead)).toEqual({
      enabled: false,
      sessions: [],
      notifications: [],
      reports: [],
    })
    expect(harness.service.isEnabled(lead)).toBe(false)
    await expect(harness.service.setEnabled(lead, true)).rejects.toThrow('DSH plugin-record API unavailable')
    expect(harness.service.view(lead).enabled).toBe(false)
  })
})
