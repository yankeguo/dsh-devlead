/**
 * Runtime boundary around DSH's experimental Session plugin-record API.
 *
 * This is the only production module that accesses `appendPluginRecord` and
 * `pluginRecordOf`. A namespace import is intentional: a future DSH can omit
 * either named export without preventing this plugin from being instantiated.
 * The first missing-function probe or thrown read/write marks this process
 * degraded instead of throwing through a fold. A failed write may be retried
 * only while the read path stays healthy; writes always fail closed after a
 * read failure so they cannot create durable state the projections cannot see.
 *
 * @module @yankeguo/dsh-devlead
 */

import * as dshSessionRecordApi from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  PluginRecord,
  PluginRecordMap,
  PluginRecordType,
} from '@deepseek-ai/dsh-session/types'
import { thrownMessage } from './error.ts'

/** Structural subset of the Host logger used by the capability boundary. */
export interface RecordApiLogger {
  warn(message: string): void
}

/** The two experimental Host functions on which DevLead durable state depends. */
export interface RecordApiImplementation {
  readonly appendPluginRecord: <K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
    session: Session,
    type: K,
    data: NoInfer<PluginRecordMap[K]>,
  ) => unknown
  readonly pluginRecordOf: (event: SessionEvent) => PluginRecord | undefined
}

/** Process-wide capability state of the experimental record API. */
export type RecordApiStatus =
  | { readonly status: 'available' }
  | { readonly status: 'degraded'; readonly reason: string }

/** User-visible consequence included in both the warning and `/devlead status`. */
export const RECORD_API_IMPACT =
  'DevLead durable state is memory-only; mode/watch/notification/report/report-answer/reset changes will not persist or replay'

const hostImplementation = dshSessionRecordApi as unknown as Partial<RecordApiImplementation>
let implementation: Partial<RecordApiImplementation> = hostImplementation
let logger: RecordApiLogger | undefined
let warningEmitted = false
let currentStatus: RecordApiStatus = probeImplementation(implementation)
// Sticky read-health guard: a writer must never create state that this process
// has already shown it cannot read back into the projections/admission scans.
let readRejected = typeof implementation.pluginRecordOf !== 'function'

/** Probe both functions without invoking them or writing a probe event. */
function probeImplementation(candidate: Partial<RecordApiImplementation>): RecordApiStatus {
  const missing = [
    typeof candidate.appendPluginRecord === 'function' ? undefined : 'appendPluginRecord',
    typeof candidate.pluginRecordOf === 'function' ? undefined : 'pluginRecordOf',
  ].filter((name): name is string => name !== undefined)
  return missing.length === 0
    ? { status: 'available' }
    : { status: 'degraded', reason: `missing or non-function export(s): ${missing.join(', ')}` }
}

/** Keep failures single-line and bounded before they reach logs or status output. */
function failureReason(operation: string, error: unknown): string {
  const detail = thrownMessage(error).replace(/\s+/g, ' ').trim()
  return `${operation} threw: ${detail.slice(0, 240) || 'unknown failure'}`
}

/** Emit exactly one structured warning per process/degradation episode. */
function warnOnce(): void {
  if (warningEmitted || currentStatus.status === 'available' || logger === undefined) return
  warningEmitted = true
  logger.warn(
    `devlead: durable_state=unavailable reason=${JSON.stringify(currentStatus.reason)} `
    + `impact=${JSON.stringify(RECORD_API_IMPACT)}`,
  )
}

/** Mark the process degraded after the first rejected read or write. */
function degrade(reason: string): void {
  if (currentStatus.status === 'degraded') return
  currentStatus = { status: 'degraded', reason }
  warnOnce()
}

/**
 * Probe at service initialization and connect the one-time warning to the Host
 * logger. Detection itself is synchronous and does not append a canary record.
 */
export function initializeRecordApi(hostLogger: RecordApiLogger): void {
  logger = hostLogger
  if (currentStatus.status === 'available') currentStatus = probeImplementation(implementation)
  warnOnce()
}

/** Return the current process-wide record capability and its degradation cause. */
export function recordApiStatus(): RecordApiStatus {
  return currentStatus
}

/**
 * Append one DevLead record without allowing the experimental API to throw into
 * the caller. A missing API or thrown write returns false and emits one warning.
 * Writes also fail closed whenever the reader is missing or has thrown, even if
 * the writer itself is healthy. A successful write retry does not erase the
 * degraded status because an earlier durable write may have been lost.
 */
export function appendRecord<K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
  session: Session,
  type: K,
  data: NoInfer<PluginRecordMap[K]>,
): boolean {
  if (readRejected || typeof implementation.pluginRecordOf !== 'function') {
    readRejected = true
    degrade('pluginRecordOf missing or previously rejected; durable writes are disabled')
    return false
  }
  const append = implementation.appendPluginRecord
  if (typeof append !== 'function') {
    degrade('missing or non-function export: appendPluginRecord')
    return false
  }
  try {
    append(session, type, data)
    return true
  } catch (error: unknown) {
    degrade(failureReason('appendPluginRecord', error))
    return false
  }
}

/**
 * Preserve a legacy caller's append-failure path while keeping the raw facade
 * non-throwing. Existing domain code uses this wrapper inside its established
 * retry/rollback boundaries, so a rejected write is never reported as durable.
 */
export function appendRecordOrThrow<K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
  session: Session,
  type: K,
  data: NoInfer<PluginRecordMap[K]>,
): void {
  if (appendRecord(session, type, data)) return
  const reason = currentStatus.status === 'degraded' ? currentStatus.reason : 'unknown failure'
  throw new Error(`DSH plugin-record API unavailable: ${reason}`)
}

/**
 * Read one event as a plugin record. Non-record events still return undefined;
 * a missing/throwing reader also returns undefined but additionally exposes the
 * degraded status, so API loss is not silently represented as an empty log.
 */
export function readRecord(event: SessionEvent): PluginRecord | undefined {
  const read = implementation.pluginRecordOf
  if (typeof read !== 'function') {
    readRejected = true
    degrade('missing or non-function export: pluginRecordOf')
    return undefined
  }
  try {
    return read(event)
  } catch (error: unknown) {
    readRejected = true
    degrade(failureReason('pluginRecordOf', error))
    return undefined
  }
}

/**
 * Replace the Host implementation in unit tests and re-run the init probe.
 * Production callers must use the real namespace import above. The optional
 * logger makes the init-time missing-export warning observable.
 */
export function setRecordApiImplementationForTests(
  replacement: Partial<RecordApiImplementation>,
  testLogger?: RecordApiLogger,
): void {
  implementation = replacement
  logger = testLogger
  warningEmitted = false
  currentStatus = probeImplementation(replacement)
  readRejected = typeof replacement.pluginRecordOf !== 'function'
  warnOnce()
}

/** Restore the real Host implementation after a facade test. */
export function resetRecordApiForTests(): void {
  implementation = hostImplementation
  logger = undefined
  warningEmitted = false
  currentStatus = probeImplementation(implementation)
  readRejected = typeof implementation.pluginRecordOf !== 'function'
}
