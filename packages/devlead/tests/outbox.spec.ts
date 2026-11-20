/**
 * Durable report outbox coverage: writes survive a handle close (a Host
 * restart), rows are removed only explicitly, retention prunes old entries, and
 * archived-holder tombstones survive the same reopen.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { devLeadReport } from '../src/index.ts'
import { DEVLEAD_ANSWER_DISCARD_RETENTION_MS, DEVLEAD_REPORT_OUTBOX_RETENTION_MS, DevLeadReportOutbox, OUTBOX_SPEC, devLeadAnswerDiscardKey, devLeadOutboxKey } from '../src/outbox.ts'
import { answer } from './fixtures.ts'
import { FakeStorageDomain, T0, disposeContext } from './harness.ts'

/** Contexts opened by one test, disposed in afterEach. */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await disposeContext(ctx)
})

/** One deterministic report fixture. */
function report(message = 'durable update') {
  return devLeadReport({
    senderSessionId: 'child-1',
    leadSessionId: 'lead-1',
    turn: 1,
    kind: 'progress',
    message,
    at: T0,
  })
}

/** Build a context with a fake storage-domain facility. */
function storageContext(storage: FakeStorageDomain): Context {
  const ctx = new Context()
  ctx.provide('storageDomain' as never, storage.asService() as never)
  contexts.push(ctx)
  return ctx
}

describe('DevLeadReportOutbox', () => {
  it('persists a row across a close/reopen and removes it explicitly', async () => {
    const storage = new FakeStorageDomain()
    const first = await DevLeadReportOutbox.open(storageContext(storage))
    expect(first).toBeDefined()
    await first!.put(report())
    expect(first!.entries().map(entry => entry.report.message)).toEqual(['durable update'])
    await first!.close()

    const second = await DevLeadReportOutbox.open(storageContext(storage))
    expect(second).toBeDefined()
    expect(second!.entries().map(entry => entry.report.message)).toEqual(['durable update'])
    await second!.delete(report())
    expect(second!.entries()).toEqual([])
  })

  it('persists the lead-liveness origin and accepts legacy rows without it', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    expect(outbox).toBeDefined()
    expect(await outbox!.put(report('cold row'), 'cold')).toBe(true)
    expect(await outbox!.put(report('live row'), 'live')).toBe(true)
    const entries = outbox!.entries()
    expect(entries.find(entry => entry.report.message === 'cold row')?.origin).toBe('cold')
    expect(entries.find(entry => entry.report.message === 'live row')?.origin).toBe('live')
    // A version-1/2 row without the additive field still parses; replay treats
    // a missing background origin as cold and never injects it.
    const legacy = { report: report('legacy origin-less row'), enqueuedAt: T0 }
    expect(OUTBOX_SPEC.tables.pending.valueSchema.parse(legacy)).toEqual(legacy)
  })

  it('round-trips structured questions and keeps legacy reports compatible', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    expect(outbox).toBeDefined()
    const structured = devLeadReport({
      senderSessionId: 'child-structured',
      leadSessionId: 'lead-1',
      turn: 1,
      kind: 'question',
      message: 'Which target?',
      questions: [{
        header: 'Deploy',
        question: 'Which target?',
        options: [{ label: 'Staging', description: 'safe' }],
        multi_select: false,
      }],
      at: T0,
    })
    expect(await outbox!.put(structured)).toBe(true)
    expect(await outbox!.put(report('legacy update'))).toBe(true)
    const entries = outbox!.entries()
    expect(entries.find(entry => entry.report.id === structured.id)?.report.questions).toEqual(structured.questions)
    expect(entries.find(entry => entry.report.message === 'legacy update')?.report).not.toHaveProperty('questions')
  })

  it('keeps the first enqueue instant when the same id is retried', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    const value = report()
    await outbox!.put(value)
    const first = outbox!.entries()[0]?.enqueuedAt
    await outbox!.put(value)
    expect(outbox!.entries()[0]?.enqueuedAt).toBe(first)
  })

  it('prunes rows older than the retention horizon', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    await outbox!.put(report('old'))
    const row = outbox!.entries()[0]!
    const table = storage.table('devlead_report_outbox', 'pending')
    const [key, stored] = [...table.records.entries()][0] ?? []
    if (key === undefined || stored === undefined) throw new Error('outbox row missing')
    table.records.set(key, {
      ...(stored as typeof row),
      enqueuedAt: Date.now() - DEVLEAD_REPORT_OUTBOX_RETENTION_MS - 1,
    })
    expect(await outbox!.prune()).toBe(1)
    expect(outbox!.entries()).toEqual([])
  })

  it('persists archived-holder tombstones across reopen', async () => {
    const storage = new FakeStorageDomain()
    const first = await DevLeadReportOutbox.open(storageContext(storage))
    await first!.rememberIgnored('session-archived')
    expect(first!.ignoredIds()).toEqual(['session-archived'])
    await first!.close()
    const second = await DevLeadReportOutbox.open(storageContext(storage))
    expect(second!.ignoredIds()).toEqual(['session-archived'])
    await second!.forgetIgnored('session-archived')
    expect(second!.ignoredIds()).toEqual([])
  })

  it('degrades to undefined while the domain name is still held open', async () => {
    const storage = new FakeStorageDomain()
    const first = await DevLeadReportOutbox.open(storageContext(storage))
    expect(first).toBeDefined()
    // The real facility refuses a second open until the first handle closes;
    // the outbox must degrade instead of throwing into service init.
    expect(await DevLeadReportOutbox.open(storageContext(storage))).toBeUndefined()
    await first!.close()
    expect(await DevLeadReportOutbox.open(storageContext(storage))).toBeDefined()
  })

  it('guards writes, reads, and tombstones after close', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    await outbox!.put(report())
    await outbox!.rememberIgnored('session-archived')
    await outbox!.close()
    expect(outbox!.available).toBe(false)
    expect(await outbox!.put(report('late'))).toBe(false)
    expect(await outbox!.delete(report())).toBe(false)
    expect(outbox!.entries()).toEqual([])
    expect(outbox!.ignoredIds()).toEqual([])
    expect(await outbox!.rememberIgnored('session-late')).toBe(false)
    await outbox!.forgetIgnored('session-archived')
    // The rows survive the handle close on disk.
    expect(storage.table('devlead_report_outbox', 'pending').records.size).toBe(1)
  })

  it('drops only the rows of one lead', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    await outbox!.put(report('lead-1 row'))
    await outbox!.put(devLeadReport({
      senderSessionId: 'child-2',
      leadSessionId: 'lead-2',
      turn: 1,
      kind: 'progress',
      message: 'lead-2 row',
      at: T0,
    }))
    expect(await outbox!.dropForLead('lead-1')).toBe(1)
    expect(outbox!.entries().map(entry => entry.report.message)).toEqual(['lead-2 row'])
    expect(await outbox!.dropForLead('lead-1')).toBe(0)
  })

  it('parses stored legacy and structured rows with the exact Host open-time schema', async () => {
    // The real storage-domain facility parses every record with the declared
    // valueSchema at open and backs up + skips a rejection. Pin the round-trip
    // through that exact schema so a questions-schema regression cannot turn
    // already-durable rows into backup-and-skip casualties on the next restart.
    const schema = OUTBOX_SPEC.tables.pending.valueSchema
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    const legacy = report('legacy update')
    const textOnly = devLeadReport({
      senderSessionId: 'child-text',
      leadSessionId: 'lead-1',
      turn: 2,
      kind: 'question',
      message: 'A text-only question?',
      at: T0,
    })
    const structured = devLeadReport({
      senderSessionId: 'child-structured',
      senderSessionTitle: 'Structured child',
      senderWorkspaceId: 'ws-1',
      senderWorkspaceTitle: 'webapp',
      leadSessionId: 'lead-1',
      turn: 3,
      kind: 'question',
      message: 'Which target?',
      summary: 'Question: Deploy',
      questions: [{
        id: 'target',
        header: 'Deploy',
        question: 'Which target?',
        options: [{ label: 'Staging', description: 'safe' }, { label: 'Prod' }],
        multi_select: true,
      }],
      at: T0,
    })
    for (const value of [legacy, textOnly, structured]) {
      expect(await outbox!.put(value)).toBe(true)
    }
    const rows = [...storage.table('devlead_report_outbox', 'pending').records.values()]
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      // Model the durable boundary: the Host re-reads serialized JSON documents.
      const reread: unknown = JSON.parse(JSON.stringify(row))
      const parsed = schema.parse(reread)
      expect(parsed).toEqual(row)
    }
    const parsedStructured = schema.parse(JSON.parse(JSON.stringify(
      rows.find(row => (row as { report: { id: string } }).report.id === structured.id),
    ))) as { report: { questions?: unknown } }
    expect(parsedStructured.report.questions).toEqual(structured.questions)
  })

  it('pins the domain declaration the real Host opens (per-record, backup-and-skip)', () => {
    expect(OUTBOX_SPEC.layout).toBe('per-record')
    expect(OUTBOX_SPEC.invalidRecords).toBe('backup-and-skip')
    expect(OUTBOX_SPEC.tables.pending.valueSchema).toBeDefined()
    expect(OUTBOX_SPEC.tables.ignored.valueSchema).toBeDefined()
  })

  it('reopens structured and legacy rows through the open-time schema parse', async () => {
    // FakeStorageDomain.open parses every existing record with the declared
    // valueSchema exactly like the real facility, so this close/reopen is the
    // restart path itself, not just a direct schema call.
    const storage = new FakeStorageDomain()
    const first = await DevLeadReportOutbox.open(storageContext(storage))
    const structured = devLeadReport({
      senderSessionId: 'child-reopen',
      leadSessionId: 'lead-1',
      turn: 1,
      kind: 'question',
      message: 'Which target?',
      questions: [{
        id: 'target',
        header: 'Deploy',
        question: 'Which target?',
        options: [{ label: 'Staging', description: 'safe' }],
        multi_select: true,
      }],
      at: T0,
    })
    expect(await first!.put(structured)).toBe(true)
    expect(await first!.put(report('legacy reopen'))).toBe(true)
    await first!.close()
    const second = await DevLeadReportOutbox.open(storageContext(storage))
    expect(second).toBeDefined()
    const entries = second!.entries()
    expect(entries).toHaveLength(2)
    expect(entries.find(entry => entry.report.id === structured.id)?.report.questions).toEqual(structured.questions)
    expect(entries.find(entry => entry.report.message === 'legacy reopen')?.report).not.toHaveProperty('questions')
    expect(storage.table('devlead_report_outbox', 'pending').backups.size).toBe(0)
  })

  it('backs up and skips an invalid row at open instead of reading it', async () => {
    const storage = new FakeStorageDomain()
    const first = await DevLeadReportOutbox.open(storageContext(storage))
    const valid = report('surviving row')
    expect(await first!.put(valid)).toBe(true)
    await first!.close()
    // A schema regression would leave exactly this kind of row on disk:
    // questions attached to a non-question report. The reopen must move it
    // aside (backup-and-skip), not read it and not reject the whole domain.
    const invalid = {
      report: { ...valid, questions: [{ question: 'q' }] },
      enqueuedAt: T0,
    }
    storage.table('devlead_report_outbox', 'pending').records.set(devLeadOutboxKey(valid), invalid)
    const second = await DevLeadReportOutbox.open(storageContext(storage))
    expect(second).toBeDefined()
    expect(second!.entries()).toEqual([])
    const table = storage.table('devlead_report_outbox', 'pending')
    expect(table.backups.get(devLeadOutboxKey(valid))).toEqual(invalid)
  })

  it('rejects at the schema boundary the rows the Host would backup-and-skip', () => {
    const schema = OUTBOX_SPEC.tables.pending.valueSchema
    const base = { report: report(), enqueuedAt: T0 }
    expect(schema.safeParse(base).success).toBe(true)
    const structured = devLeadReport({
      senderSessionId: 'child-1',
      leadSessionId: 'lead-1',
      turn: 1,
      kind: 'question',
      message: 'Which target?',
      questions: [{ question: 'Which target?', options: [{ label: 'Staging' }] }],
      at: T0,
    })
    const questionRow = { report: structured, enqueuedAt: T0 }
    expect(schema.safeParse(questionRow).success).toBe(true)
    const invalid: Array<[string, unknown]> = [
      ['questions on a non-question report', {
        ...base,
        report: { ...base.report, questions: [{ question: 'q' }] },
      }],
      ['unknown report field', { ...base, report: { ...base.report, extra: true } }],
      ['unknown question field', {
        ...questionRow,
        report: { ...structured, questions: [{ question: 'q', extra: true }] },
      }],
      ['unknown option field', {
        ...questionRow,
        report: { ...structured, questions: [{ question: 'q', options: [{ label: 'x', extra: true }] }] },
      }],
      ['oversized question field', {
        ...questionRow,
        report: { ...structured, questions: [{ question: 'q'.repeat(2_001) }] },
      }],
      ['too many questions', {
        ...questionRow,
        report: { ...structured, questions: Array.from({ length: 33 }, () => ({ question: 'q' })) },
      }],
      ['too many options', {
        ...questionRow,
        report: {
          ...structured,
          questions: [{ question: 'q', options: Array.from({ length: 17 }, () => ({ label: 'x' })) }],
        },
      }],
      ['report id mismatch', { ...base, report: { ...base.report, id: 'forged-id' } }],
      ['unknown row field', { ...base, extra: true }],
    ]
    for (const [label, row] of invalid) {
      expect(schema.safeParse(row).success, label).toBe(false)
    }
  })

  it('returns undefined without storage-domain and false on write failure', async () => {
    expect(await DevLeadReportOutbox.open(new Context())).toBeUndefined()

    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    storage.table('devlead_report_outbox', 'pending').putError = new Error('read-only')
    expect(await outbox!.put(report())).toBe(false)
    expect(outbox!.entries()).toEqual([])
  })
})

describe('DevLeadReportOutbox answer discard queue', () => {
  /** One deterministic discard fact fixture. */
  function discard(messageId = 'm1', leadSessionId = 'lead-1') {
    return answer({ reportId: 'child-1:1:report:question:abc', leadSessionId, sessionId: 'child-1', messageId, status: 'discarded', at: T0 + 1, answeredAt: T0, answerSeq: 1 })
  }

  it('queues a discard durably across a close/reopen and removes it explicitly', async () => {
    const storage = new FakeStorageDomain()
    const first = await DevLeadReportOutbox.open(storageContext(storage))
    expect(await first!.putAnswerDiscard(discard())).toBe(true)
    expect(first!.answerDiscards().map(row => row.answer.messageId)).toEqual(['m1'])
    await first!.close()
    const second = await DevLeadReportOutbox.open(storageContext(storage))
    expect(second!.answerDiscards().map(row => row.answer.messageId)).toEqual(['m1'])
    expect(await second!.deleteAnswerDiscard(discard())).toBe(true)
    expect(second!.answerDiscards()).toEqual([])
  })

  it('keeps the first enqueue instant when the same discard is re-queued', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    await outbox!.putAnswerDiscard(discard())
    const first = outbox!.answerDiscards()[0]?.enqueuedAt
    await outbox!.putAnswerDiscard(discard())
    expect(outbox!.answerDiscards()).toHaveLength(1)
    expect(outbox!.answerDiscards()[0]?.enqueuedAt).toBe(first)
  })

  it('adds the queue table to a version-1 domain without losing its rows', async () => {
    // A Host incarnation before the queue existed wrote pending/ignored rows
    // under spec version 1. The version-2 open must read them (compatible
    // versions) and materialize the new empty table, not reset the domain.
    const storage = new FakeStorageDomain()
    const legacySpec = {
      name: 'devlead_report_outbox',
      version: 1,
      layout: 'per-record',
      invalidRecords: 'backup-and-skip',
      tables: {
        pending: { valueSchema: OUTBOX_SPEC.tables.pending.valueSchema },
        ignored: { valueSchema: OUTBOX_SPEC.tables.ignored.valueSchema },
      },
    }
    const legacyHandle = await storage.open(legacySpec)
    await legacyHandle.table('pending').put(devLeadOutboxKey(report('v1 row')), { report: report('v1 row'), enqueuedAt: T0 })
    await legacyHandle.close()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    expect(outbox).toBeDefined()
    expect(outbox!.entries().map(entry => entry.report.message)).toEqual(['v1 row'])
    expect(outbox!.answerDiscards()).toEqual([])
    expect(await outbox!.putAnswerDiscard(discard())).toBe(true)
    expect(storage.table('devlead_report_outbox', 'pending').backups.size).toBe(0)
  })

  it('drops only the queued discards of one lead (reset)', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    await outbox!.putAnswerDiscard(discard('m1', 'lead-1'))
    await outbox!.putAnswerDiscard(discard('m2', 'lead-2'))
    expect(await outbox!.dropAnswerDiscardsForLead('lead-1')).toBe(1)
    expect(outbox!.answerDiscards().map(row => row.answer.leadSessionId)).toEqual(['lead-2'])
    expect(await outbox!.dropAnswerDiscardsForLead('lead-1')).toBe(0)
  })

  it('prunes queued discards only past their own longer retention, with an explicit warning', async () => {
    const storage = new FakeStorageDomain()
    const pruneCtx = storageContext(storage)
    const outbox = await DevLeadReportOutbox.open(pruneCtx)
    await outbox!.putAnswerDiscard(discard())
    const table = storage.table('devlead_report_outbox', 'answer_discards')
    const [key, stored] = [...table.records.entries()][0] ?? []
    if (key === undefined || stored === undefined) throw new Error('discard row missing')
    // Older than the report horizon but inside the answer-discard horizon:
    // the ordinary sweep must NOT silently drop the question-state repair.
    table.records.set(key, {
      ...(stored as { answer: unknown }),
      enqueuedAt: Date.now() - DEVLEAD_REPORT_OUTBOX_RETENTION_MS - 1,
    })
    expect(await outbox!.prune()).toBe(0)
    expect(outbox!.answerDiscards()).toHaveLength(1)
    // Past the answer-discard horizon it is pruned, loudly.
    table.records.set(key, {
      ...(stored as { answer: unknown }),
      enqueuedAt: Date.now() - DEVLEAD_ANSWER_DISCARD_RETENTION_MS - 1,
    })
    const warn = vi.spyOn(pruneCtx.logger, 'warn')
    expect(await outbox!.prune()).toBe(1)
    expect(outbox!.answerDiscards()).toEqual([])
    expect(warn.mock.calls.some(call => String(call[0]).includes('answer-discard retention'))).toBe(true)
  })

  it('parses stored discard rows with the exact Host open-time schema', async () => {
    const schema = OUTBOX_SPEC.tables.answer_discards.valueSchema
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    const sequenced = discard('m1')
    const legacy = answer({ reportId: 'child-1:1:report:question:abc', leadSessionId: 'lead-1', sessionId: 'child-1', messageId: 'm2', status: 'discarded', at: T0 + 1, answeredAt: T0 })
    expect(await outbox!.putAnswerDiscard(sequenced)).toBe(true)
    expect(await outbox!.putAnswerDiscard(legacy)).toBe(true)
    const rows = [...storage.table('devlead_report_outbox', 'answer_discards').records.values()]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const reread: unknown = JSON.parse(JSON.stringify(row))
      expect(schema.parse(reread)).toEqual(row)
    }
    // The reopen itself runs the same parse (backup-and-skip on rejection).
    await outbox!.close()
    const second = await DevLeadReportOutbox.open(storageContext(storage))
    expect(second!.answerDiscards()).toHaveLength(2)
    expect(storage.table('devlead_report_outbox', 'answer_discards').backups.size).toBe(0)
  })

  it('rejects malformed discard rows at the schema boundary', () => {
    const schema = OUTBOX_SPEC.tables.answer_discards.valueSchema
    const base = { answer: discard(), enqueuedAt: T0 }
    expect(schema.safeParse(base).success).toBe(true)
    const invalid: Array<[string, unknown]> = [
      ['unknown row field', { ...base, extra: true }],
      ['unknown answer field', { ...base, answer: { ...base.answer, extra: true } }],
      ['negative answerSeq', { ...base, answer: { ...base.answer, answerSeq: -1 } }],
      ['bad textHash', { ...base, answer: { ...base.answer, textHash: 'nope' } }],
      ['presentedAt on a discard', { ...base, answer: { ...base.answer, presentedAt: T0 } }],
      ['missing enqueuedAt', { answer: base.answer }],
    ]
    for (const [label, row] of invalid) {
      expect(schema.safeParse(row).success, label).toBe(false)
    }
  })

  it('guards queue writes and reads after close, and reports write failures', async () => {
    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    await outbox!.putAnswerDiscard(discard())
    await outbox!.close()
    expect(await outbox!.putAnswerDiscard(discard('late'))).toBe(false)
    expect(await outbox!.deleteAnswerDiscard(discard())).toBe(false)
    expect(outbox!.answerDiscards()).toEqual([])
    expect(storage.table('devlead_report_outbox', 'answer_discards').records.size).toBe(1)

    const second = await DevLeadReportOutbox.open(storageContext(storage))
    storage.table('devlead_report_outbox', 'answer_discards').putError = new Error('read-only')
    expect(await second!.putAnswerDiscard(discard('m9'))).toBe(false)
  })

  it('pins the queue key to lead + question + message identity', () => {
    const a = discard('m1', 'lead-1')
    expect(devLeadAnswerDiscardKey(a)).toBe(devLeadAnswerDiscardKey({ ...a, at: T0 + 99 }))
    expect(devLeadAnswerDiscardKey(a)).not.toBe(devLeadAnswerDiscardKey({ ...a, messageId: 'm2' }))
    expect(devLeadAnswerDiscardKey(a)).not.toBe(devLeadAnswerDiscardKey({ ...a, leadSessionId: 'lead-2' }))
  })
})
