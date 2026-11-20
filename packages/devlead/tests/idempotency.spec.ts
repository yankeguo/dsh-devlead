/** Durable non-answer prompt idempotency receipt coverage. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  DEVLEAD_PROMPT_IDEMPOTENCY_RETENTION_MS,
  DevLeadPromptIdempotencyStore,
  PROMPT_IDEMPOTENCY_SPEC,
  devLeadPromptIdempotencyKey,
} from '../src/idempotency.ts'
import type { DevLeadPromptIdempotencyReceipt } from '../src/idempotency.ts'
import { FakeStorageDomain, disposeContext } from './harness.ts'

/** Contexts opened by one test, disposed in afterEach. */
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await disposeContext(ctx)
})

/** Build a context with the shared fake storage-domain facility. */
function storageContext(storage: FakeStorageDomain): Context {
  const ctx = new Context()
  ctx.provide('storageDomain' as never, storage.asService() as never)
  contexts.push(ctx)
  return ctx
}

/** One complete original-admission receipt, overridable per test. */
function receipt(overrides: Partial<DevLeadPromptIdempotencyReceipt> = {}): DevLeadPromptIdempotencyReceipt {
  return {
    leadSessionId: 'lead-1',
    targetSessionId: 'target-1',
    key: 'deploy-1',
    textHash: 'a'.repeat(64),
    at: Date.now(),
    delivery: {
      primitive: 'followup',
      boundary: 'next-turn',
      wakeRequested: true,
      messageId: 'message-1',
      idempotencyKey: 'deploy-1',
    },
    ...overrides,
  }
}

describe('DevLeadPromptIdempotencyStore', () => {
  it('persists and reads the original receipt across close/reopen, then deletes it', async () => {
    const storage = new FakeStorageDomain()
    const original = receipt({
      leadSessionId: 'lead/一',
      targetSessionId: 'target?二',
      key: 'deploy/key + 1',
      delivery: {
        primitive: 'inject',
        boundary: 'next-step',
        wakeRequested: false,
        messageId: 'message-original',
        idempotencyKey: 'deploy/key + 1',
      },
    })
    const first = await DevLeadPromptIdempotencyStore.open(storageContext(storage))
    expect(first).toBeDefined()
    expect(await first!.put(original)).toBe(true)
    expect(first!.get(original.leadSessionId, original.targetSessionId, original.key)).toEqual(original)
    await first!.close()

    const second = await DevLeadPromptIdempotencyStore.open(storageContext(storage))
    expect(second).toBeDefined()
    expect(second!.get(original.leadSessionId, original.targetSessionId, original.key)).toEqual(original)
    expect(await second!.delete(original.leadSessionId, original.targetSessionId, original.key)).toBe(true)
    expect(second!.get(original.leadSessionId, original.targetSessionId, original.key)).toBeUndefined()
    expect(await second!.delete(original.leadSessionId, original.targetSessionId, original.key)).toBe(false)
  })

  it('returns the textHash and original delivery needed for caller-side replay/conflict decisions', async () => {
    const storage = new FakeStorageDomain()
    const store = await DevLeadPromptIdempotencyStore.open(storageContext(storage))
    const original = receipt()
    await store!.put(original)

    const previous = store!.get('lead-1', 'target-1', 'deploy-1')
    expect(previous?.textHash).toBe('a'.repeat(64))
    expect(previous?.textHash === 'b'.repeat(64)).toBe(false)
    expect(previous?.delivery).toEqual(original.delivery)
    expect(previous?.delivery.messageId).toBe('message-1')

    // The storage key includes all three identity components; another target or
    // lead cannot accidentally replay this receipt even with the same text/key.
    expect(store!.get('lead-1', 'target-2', 'deploy-1')).toBeUndefined()
    expect(store!.get('lead-2', 'target-1', 'deploy-1')).toBeUndefined()
    expect(store!.get('lead-1', 'target-1', 'deploy-2')).toBeUndefined()
  })

  it('prunes receipts older than seven days automatically at open', async () => {
    const storage = new FakeStorageDomain()
    const now = Date.now()
    const old = receipt({ key: 'old', at: now - DEVLEAD_PROMPT_IDEMPOTENCY_RETENTION_MS - 1 })
    const fresh = receipt({ key: 'fresh', at: now })
    const handle = await storage.open(PROMPT_IDEMPOTENCY_SPEC)
    await handle.table('receipts').put(devLeadPromptIdempotencyKey(old.leadSessionId, old.targetSessionId, old.key), old)
    await handle.table('receipts').put(devLeadPromptIdempotencyKey(fresh.leadSessionId, fresh.targetSessionId, fresh.key), fresh)
    await handle.close()

    const store = await DevLeadPromptIdempotencyStore.open(storageContext(storage))
    expect(store).toBeDefined()
    expect(store!.get(old.leadSessionId, old.targetSessionId, old.key)).toBeUndefined()
    expect(store!.get(fresh.leadSessionId, fresh.targetSessionId, fresh.key)).toEqual(fresh)
    expect(storage.table('devlead_idempotency', 'receipts').records.size).toBe(1)
    expect(await store!.prune()).toBe(0)
  })

  it('pins the independent v1 domain and path-safe tuple keys', () => {
    expect(PROMPT_IDEMPOTENCY_SPEC.name).toBe('devlead_idempotency')
    expect(PROMPT_IDEMPOTENCY_SPEC.version).toBe(1)
    expect(PROMPT_IDEMPOTENCY_SPEC.layout).toBe('per-record')
    expect(PROMPT_IDEMPOTENCY_SPEC).not.toHaveProperty('invalidRecords')
    expect(PROMPT_IDEMPOTENCY_SPEC.tables.receipts.valueSchema).toBeDefined()

    const key = devLeadPromptIdempotencyKey('lead/一', 'target?二', 'key/+ 三')
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(key).not.toBe(devLeadPromptIdempotencyKey('lead/一', 'target?二', 'other'))
    expect(PROMPT_IDEMPOTENCY_SPEC.tables.receipts.valueSchema.safeParse(receipt()).success).toBe(true)
    expect(PROMPT_IDEMPOTENCY_SPEC.tables.receipts.valueSchema.safeParse({ ...receipt(), extra: true }).success).toBe(false)
    expect(PROMPT_IDEMPOTENCY_SPEC.tables.receipts.valueSchema.safeParse({ ...receipt(), textHash: 'not-a-hash' }).success).toBe(false)
  })

  it('rejects at-rest corruption at open instead of treating it as absent', async () => {
    const storage = new FakeStorageDomain()
    const first = await DevLeadPromptIdempotencyStore.open(storageContext(storage))
    const corrupt = receipt({ key: 'corrupt' })
    await first!.put(corrupt)
    await first!.close()
    const table = storage.table('devlead_idempotency', 'receipts')
    const corruptKey = devLeadPromptIdempotencyKey(corrupt.leadSessionId, corrupt.targetSessionId, corrupt.key)
    const malformed = { ...corrupt, textHash: 'broken' }
    table.records.set(corruptKey, malformed)
    const ctx = storageContext(storage)
    const warn = vi.spyOn(ctx.logger, 'warn')

    const second = await DevLeadPromptIdempotencyStore.open(ctx)
    expect(second).toBeUndefined()
    expect(warn.mock.calls.some(call => String(call[0]).includes('durable prompt idempotency unavailable'))).toBe(true)
    expect(table.records.get(corruptKey)).toEqual(malformed)
    expect(table.backups.size).toBe(0)
  })

  it('degrades an unreadable individual record to an absent receipt with a warning', async () => {
    const storage = new FakeStorageDomain()
    const ctx = storageContext(storage)
    const store = await DevLeadPromptIdempotencyStore.open(ctx)
    const value = receipt()
    await store!.put(value)
    const key = devLeadPromptIdempotencyKey(value.leadSessionId, value.targetSessionId, value.key)
    storage.table('devlead_idempotency', 'receipts').records.set(key, { ...value, textHash: 'broken' })
    const warn = vi.spyOn(ctx.logger, 'warn')

    expect(store!.get(value.leadSessionId, value.targetSessionId, value.key)).toBeUndefined()
    expect(warn.mock.calls.some(call => String(call[0]).includes('corrupt durable prompt idempotency receipt'))).toBe(true)
  })

  it('returns undefined without storage or when an old handle still holds the domain open', async () => {
    expect(await DevLeadPromptIdempotencyStore.open(new Context())).toBeUndefined()

    const storage = new FakeStorageDomain()
    const first = await DevLeadPromptIdempotencyStore.open(storageContext(storage))
    expect(first).toBeDefined()
    const secondCtx = storageContext(storage)
    const warn = vi.spyOn(secondCtx.logger, 'warn')
    expect(await DevLeadPromptIdempotencyStore.open(secondCtx)).toBeUndefined()
    expect(warn.mock.calls.some(call => String(call[0]).includes('already open'))).toBe(true)

    await first!.close()
    expect(await DevLeadPromptIdempotencyStore.open(storageContext(storage))).toBeDefined()
  })

  it('warns and safely degrades put/get/delete/prune failures', async () => {
    const storage = new FakeStorageDomain()
    const ctx = storageContext(storage)
    const store = await DevLeadPromptIdempotencyStore.open(ctx)
    const table = storage.table('devlead_idempotency', 'receipts')
    const warn = vi.spyOn(ctx.logger, 'warn')

    table.putError = new Error('read-only')
    expect(await store!.put(receipt())).toBe(false)
    expect(warn.mock.calls.some(call => String(call[0]).includes('could not persist'))).toBe(true)
    table.putError = undefined

    const getFailure = vi.spyOn(table, 'get').mockImplementation(() => { throw new Error('get failed') })
    expect(store!.get('lead-1', 'target-1', 'deploy-1')).toBeUndefined()
    expect(warn.mock.calls.some(call => String(call[0]).includes('could not read'))).toBe(true)
    getFailure.mockRestore()

    table.deleteError = new Error('delete failed')
    expect(await store!.delete('lead-1', 'target-1', 'deploy-1')).toBe(false)
    expect(warn.mock.calls.some(call => String(call[0]).includes('could not delete'))).toBe(true)
    table.deleteError = undefined

    await store!.put(receipt({ at: Date.now() - DEVLEAD_PROMPT_IDEMPOTENCY_RETENTION_MS - 1 }))
    table.deleteManyError = new Error('sweep failed')
    expect(await store!.prune()).toBe(0)
    expect(warn.mock.calls.some(call => String(call[0]).includes('could not prune'))).toBe(true)
  })

  it('guards every operation after close while leaving durable rows intact', async () => {
    const storage = new FakeStorageDomain()
    const store = await DevLeadPromptIdempotencyStore.open(storageContext(storage))
    const original = receipt()
    await store!.put(original)
    await store!.close()

    expect(store!.available).toBe(false)
    expect(store!.get(original.leadSessionId, original.targetSessionId, original.key)).toBeUndefined()
    expect(await store!.put(receipt({ key: 'late' }))).toBe(false)
    expect(await store!.delete(original.leadSessionId, original.targetSessionId, original.key)).toBe(false)
    expect(await store!.prune()).toBe(0)
    expect(storage.table('devlead_idempotency', 'receipts').records.size).toBe(1)
    await expect(store!.close()).resolves.toBeUndefined()
  })

  it('warns but still closes safely when the domain close fails', async () => {
    const storage = new FakeStorageDomain()
    const ctx = storageContext(storage)
    const store = await DevLeadPromptIdempotencyStore.open(ctx)
    const handle = storage.domains.get('devlead_idempotency')
    if (handle === undefined) throw new Error('idempotency domain missing')
    const close = vi.spyOn(handle, 'close').mockRejectedValue(new Error('close failed'))
    const warn = vi.spyOn(ctx.logger, 'warn')

    await expect(store!.close()).resolves.toBeUndefined()
    expect(store!.available).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.some(call => String(call[0]).includes('could not close'))).toBe(true)
    await store!.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
