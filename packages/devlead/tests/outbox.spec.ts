/**
 * Durable report outbox coverage: writes survive a handle close (a Host
 * restart), rows are removed only explicitly, retention prunes old entries, and
 * archived-holder tombstones survive the same reopen.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { devLeadReport } from '../src/index.ts'
import { DEVLEAD_REPORT_OUTBOX_RETENTION_MS, DevLeadReportOutbox } from '../src/outbox.ts'
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

  it('returns undefined without storage-domain and false on write failure', async () => {
    expect(await DevLeadReportOutbox.open(new Context())).toBeUndefined()

    const storage = new FakeStorageDomain()
    const outbox = await DevLeadReportOutbox.open(storageContext(storage))
    storage.table('devlead_report_outbox', 'pending').putError = new Error('read-only')
    expect(await outbox!.put(report())).toBe(false)
    expect(outbox!.entries()).toEqual([])
  })
})
