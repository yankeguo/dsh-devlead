/**
 * Unit coverage of the Phase 1e low-cardinality counter registry
 * (DESIGN §4.4.11): detached snapshots, label-order independence, and the
 * bounded series set with overflow folding. No Session, service, or timer is
 * involved; the registry performs no I/O.
 */

import { describe, expect, it } from 'vitest'
import { DEVLEAD_METRICS_SERIES_MAX, DevLeadMetrics, countDelivery } from '../src/metrics.ts'

describe('DevLeadMetrics', () => {
  it('snapshots an empty registry as an empty array', () => {
    expect(new DevLeadMetrics().snapshot()).toEqual([])
  })

  it('increments one series monotonically and hands out detached samples', () => {
    const metrics = new DevLeadMetrics()
    metrics.increment('devlead_test_total', { lane: 'background' })
    metrics.increment('devlead_test_total', { lane: 'background' })
    const before = metrics.snapshot()
    expect(before).toEqual([
      { name: 'devlead_test_total', labels: { lane: 'background' }, value: 2 },
    ])
    // A later increment must not mutate an already-issued snapshot.
    metrics.increment('devlead_test_total', { lane: 'background' })
    expect(before[0]?.value).toBe(2)
    expect(metrics.snapshot()[0]?.value).toBe(3)
    // Mutating a snapshot's labels must not leak back into the registry.
    const labels = metrics.snapshot()[0]!.labels as Record<string, string>
    labels.lane = 'mutated'
    expect(metrics.snapshot()[0]?.labels).toEqual({ lane: 'background' })
  })

  it('treats label insertion order as the same logical series', () => {
    const metrics = new DevLeadMetrics()
    metrics.increment('devlead_test_total', { a: '1', b: '2' })
    metrics.increment('devlead_test_total', { b: '2', a: '1' })
    const snapshot = metrics.snapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.value).toBe(2)
    expect(Object.keys(snapshot[0]!.labels)).toEqual(['a', 'b'])
  })

  it('keeps distinct names and label values as distinct series in first-increment order', () => {
    const metrics = new DevLeadMetrics()
    metrics.increment('counter_a', { x: '1' })
    metrics.increment('counter_b', { x: '1' })
    metrics.increment('counter_a', { x: '2' })
    expect(metrics.snapshot().map(sample => [sample.name, sample.labels.x])).toEqual([
      ['counter_a', '1'],
      ['counter_b', '1'],
      ['counter_a', '2'],
    ])
  })

  it('folds series beyond the cap into one overflow series per name', () => {
    const metrics = new DevLeadMetrics()
    for (let index = 0; index < DEVLEAD_METRICS_SERIES_MAX; index += 1) {
      metrics.increment('devlead_test_total', { index: String(index) })
    }
    expect(metrics.snapshot()).toHaveLength(DEVLEAD_METRICS_SERIES_MAX)
    // The next distinct series is folded, not dropped and not grown.
    metrics.increment('devlead_test_total', { index: String(DEVLEAD_METRICS_SERIES_MAX) })
    metrics.increment('devlead_test_total', { index: String(DEVLEAD_METRICS_SERIES_MAX + 1) })
    const snapshot = metrics.snapshot()
    expect(snapshot).toHaveLength(DEVLEAD_METRICS_SERIES_MAX + 1)
    expect(snapshot.at(-1)).toEqual({
      name: 'devlead_test_total',
      labels: { overflow: 'true' },
      value: 2,
    })
    // An already-registered series keeps incrementing after the cap.
    metrics.increment('devlead_test_total', { index: '0' })
    expect(metrics.snapshot()[0]?.value).toBe(2)
    // A different counter name folds into its own overflow series.
    metrics.increment('devlead_other_total', { x: '1' })
    expect(metrics.snapshot().at(-1)).toEqual({
      name: 'devlead_other_total',
      labels: { overflow: 'true' },
      value: 1,
    })
    expect(metrics.snapshot()).toHaveLength(DEVLEAD_METRICS_SERIES_MAX + 2)
  })

  it('counts delivery facts under the shared counter name with the design vocabulary', () => {
    const metrics = new DevLeadMetrics()
    countDelivery(metrics, {
      direction: 'child-to-lead',
      lane: 'background',
      primitive: 'inject',
      kind: 'progress',
      outcome: 'delivered',
    })
    countDelivery(metrics, {
      direction: 'child-to-lead',
      lane: 'background',
      primitive: 'inject',
      kind: 'progress',
      outcome: 'delivered',
    })
    expect(metrics.snapshot()).toEqual([
      {
        name: 'devlead_delivery_total',
        labels: {
          direction: 'child-to-lead',
          lane: 'background',
          primitive: 'inject',
          kind: 'progress',
          outcome: 'delivered',
        },
        value: 2,
      },
    ])
  })
})