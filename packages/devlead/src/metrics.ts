/**
 * Process-local delivery/suppression/lane counters for the DevLead message
 * model (Phase 1e, DESIGN §4.4.11 "观测/指标").
 *
 * Every series is identified by a counter name plus a small set of
 * low-cardinality enum labels (lane, primitive, kind, outcome, …). Message
 * text, Session ids, report ids, and question ids are NEVER labels: they would
 * make the series set unbounded and leak child-authored content into
 * diagnostics. The registry is bounded anyway so a future caller cannot grow
 * it without limit; once the cap is reached further distinct series are
 * counted into one `overflow` series per name instead of being dropped.
 *
 * Counters are monotonic for the lifetime of one Host process and reset on
 * restart; they are observations, not durable state. The service exposes a
 * detached snapshot for the E2E probe and diagnostics.
 *
 * @module @yankeguo/dsh-devlead/metrics
 */

/** One counter sample: a name, its enum labels, and the monotonic value. */
export interface DevLeadCounterSample {
  /** Counter name, e.g. `devlead_delivery_total`. */
  readonly name: string
  /** Low-cardinality enum labels of this series. */
  readonly labels: Readonly<Record<string, string>>
  /** Monotonic count since process start. */
  readonly value: number
}

/** Maximum distinct series kept per Host process before overflow folding. */
export const DEVLEAD_METRICS_SERIES_MAX = 512

/** Delivery outcomes counted by `devlead_delivery_total`. */
export type DevLeadDeliveryOutcome =
  | 'queued'
  | 'delivered'
  | 'digest-only'
  | 'rate-limited'
  | 'duplicate'
  | 'retry'
  | 'failed'

/**
 * Bounded low-cardinality counter registry. One instance is owned by the core
 * service and shared with the notification hub; it performs no I/O.
 */
export class DevLeadMetrics {
  private readonly series = new Map<string, { name: string; labels: Record<string, string>; value: number }>()

  /**
   * Increment one counter series.
   * @param name - counter name.
   * @param labels - enum labels; keys are sorted so insertion order cannot
   *   split one logical series into two.
   */
  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const sorted: Record<string, string> = {}
    for (const key of Object.keys(labels).sort()) sorted[key] = labels[key] as string
    const key = `${name}\u0000${JSON.stringify(sorted)}`
    const existing = this.series.get(key)
    if (existing !== undefined) {
      existing.value += 1
      return
    }
    if (this.series.size >= DEVLEAD_METRICS_SERIES_MAX) {
      const overflowKey = `${name}\u0000{"overflow":"true"}`
      const overflow = this.series.get(overflowKey)
      if (overflow !== undefined) overflow.value += 1
      else this.series.set(overflowKey, { name, labels: { overflow: 'true' }, value: 1 })
      return
    }
    this.series.set(key, { name, labels: sorted, value: 1 })
  }

  /**
   * Detached snapshot of every series, in first-increment order.
   * @returns counter samples safe to serialize across a tool/probe boundary.
   */
  snapshot(): DevLeadCounterSample[] {
    return [...this.series.values()].map(entry => ({
      name: entry.name,
      labels: { ...entry.labels },
      value: entry.value,
    }))
  }
}

/**
 * Increment the shared delivery counter with the design's log-field vocabulary.
 * @param metrics - registry to increment.
 * @param facts - direction/lane/primitive/kind/outcome enum facts.
 */
export function countDelivery(
  metrics: DevLeadMetrics,
  facts: {
    readonly direction: 'child-to-lead' | 'lead-to-child'
    readonly lane: string
    readonly primitive: string
    readonly kind: string
    readonly outcome: DevLeadDeliveryOutcome
  },
): void {
  metrics.increment('devlead_delivery_total', { ...facts })
}
