/**
 * Read-only recovery for current JSONL Session logs that the Host cannot replay
 * solely because an old plugin wrote a non-ignorable event unknown to this
 * Harness. The normal `sessionQuery.readSession` path remains authoritative.
 * This fallback is only for that precise error: it reads the complete physical
 * log, preserves every record, checks the contiguous envelope and inherited
 * cut, and lets DevLead's strict projection fold judge every DevLead record.
 * It never edits, truncates, publishes, or resumes the user's Session.
 *
 * @module @yankeguo/dsh-devlead
 */

import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdDecompress } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

const decompress = promisify(zstdDecompress)
const utf8 = new TextDecoder('utf-8', { fatal: true })
const ZSTD_MAGIC = 0xFD2FB528
const DEVLEAD_RECORD_PREFIX = 'plugin:devlead/'
const HEADER_REQUIRED = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const HEADER_OPTIONAL = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const EVENT_REQUIRED = ['type', 'seq', 'time', 'data'] as const
const EVENT_OPTIONAL = ['ignorable', 'sourceEventSeqs', 'surfaceOp'] as const

/** One structurally complete zstd frame in the physical artifact. */
interface FrameRange {
  readonly start: number
  readonly end: number
}

/** Complete logical facts needed by the ordinary DevLead projection fold. */
export interface RecoveredSessionLog {
  readonly path: string
  readonly inheritedEventCount: SessionLogOffset
  readonly events: SessionEvent[]
}

/** Whether an error chain is specifically the Host's unknown-event refusal. */
export function isUnknownNonIgnorableEventError(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object') {
      const candidate = current as { name?: unknown; message?: unknown; cause?: unknown }
      if (candidate.name === 'SessionFormatUnsupportedError'
        && typeof candidate.message === 'string'
        && candidate.message.includes('unknown to this harness and not marked ignorable')) return true
      current = candidate.cause
      continue
    }
    break
  }
  return false
}

/**
 * Locate and read a current JSONL artifact through the composed persistence
 * service's own metadata. No path is accepted from an error string or caller.
 * @param ctx - Host context owning the optional persistence service.
 * @param header - immutable header from the validated corpus listing.
 * @param signal - bounded scan-attempt cancellation.
 * @returns the complete recovered log, or a diagnostic failure that stays fail closed.
 */
export async function recoverUnknownEventSessionLog(
  ctx: Context,
  header: SessionHeader,
  signal?: AbortSignal,
): Promise<RecoveredSessionLog> {
  const persistence: unknown = ctx.get('sessionPersistence')
  const stat = (persistence as { stat?: unknown } | null | undefined)?.stat
  if (typeof stat !== 'function') {
    throw new Error(`Session "${String(header.id)}" needs read-only log recovery, but the persistence backend exposes no stat()`)
  }
  signal?.throwIfAborted()
  const snapshot: unknown = await (stat as (id: SessionId, options?: unknown) => unknown).call(
    persistence,
    header.id,
    signal === undefined ? undefined : { signal },
  )
  signal?.throwIfAborted()
  const location = (snapshot as { location?: unknown } | null | undefined)?.location
  const path = (location as { path?: unknown } | null | undefined)?.path
  const kind = (location as { kind?: unknown } | null | undefined)?.kind
  if (kind !== 'jsonl' || typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`Session "${String(header.id)}" has no backend-verified absolute JSONL artifact path for read-only recovery`)
  }
  return await readCurrentJsonlForDevLead(path, header, signal)
}

/**
 * Read one current-generation JSONL artifact without interpreting unrelated
 * event payloads. Only `session.v4.jsonl[.zstd]` is supported; historical
 * generations still require the Host's migrator and fail closed here.
 * @param path - backend-verified absolute artifact path.
 * @param expectedHeader - immutable header from the validated corpus listing.
 * @param signal - bounded scan-attempt cancellation.
 * @returns every complete record and the exact fork-inherited cut.
 */
export async function readCurrentJsonlForDevLead(
  path: string,
  expectedHeader: SessionHeader,
  signal?: AbortSignal,
): Promise<RecoveredSessionLog> {
  if (!isAbsolute(path) || !/session\.v4\.jsonl(?:\.zstd)?$/.test(path)) {
    throw new Error(`read-only DevLead recovery supports only current session.v4.jsonl[.zstd] artifacts: ${path}`)
  }
  signal?.throwIfAborted()
  const beforePath = await stat(path, { bigint: true })
  const handle = await open(path, 'r')
  let bytes: Buffer
  try {
    const beforeHandle = await handle.stat({ bigint: true })
    assertSamePhysicalFile(beforePath, beforeHandle, path)
    bytes = await handle.readFile(signal === undefined ? undefined : { signal })
    const afterHandle = await handle.stat({ bigint: true })
    const afterPath = await stat(path, { bigint: true })
    assertSamePhysicalFile(beforeHandle, afterHandle, path)
    assertSamePhysicalFile(afterHandle, afterPath, path)
  } finally {
    await handle.close()
  }
  signal?.throwIfAborted()
  let plaintext: Buffer
  try {
    plaintext = path.endsWith('.zstd') ? await decodeZstdFrames(bytes, signal) : bytes
  } catch (error: unknown) {
    signal?.throwIfAborted()
    throw new Error(`could not decode Session log ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  signal?.throwIfAborted()
  const events = parseCurrentJsonl(plaintext, expectedHeader, path)
  return { path, inheritedEventCount: inheritedCut(events, expectedHeader, path), events }
}

/** Reject appends and path replacement between the path and opened-handle identities. */
function assertSamePhysicalFile(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  path: string,
): void {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size
    || left.mtimeNs !== right.mtimeNs || left.ctimeNs !== right.ctimeNs) {
    throw new Error(`Session log changed during read-only recovery; retry the bounded scan: ${path}`)
  }
}

/** Decode every complete frame plus complete records recoverable from a torn final frame. */
async function decodeZstdFrames(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const { frames, tornStart } = scanFrames(bytes)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const chunks: Buffer[] = []
  for (const frame of frames) {
    signal?.throwIfAborted()
    chunks.push(await decompress(bytes.subarray(frame.start, frame.end)))
  }
  const header = chunks[0]!
  if (header.length === 0 || header.indexOf(0x0A) !== header.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
  const complete = Buffer.concat(chunks)
  if (complete.length === 0 || complete.at(-1) !== 0x0A) {
    throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
  }
  if (tornStart === undefined) return complete
  signal?.throwIfAborted()
  // A physically incomplete final frame may contribute only complete
  // newline-terminated records. parseCurrentJsonl discards its final incomplete
  // line. If the fragment ends before Node can decode anything, complete prior
  // frames remain authoritative; the uncommitted fragment is not evidence.
  try {
    const recovered = await decompress(bytes.subarray(tornStart), {
      finishFlush: constants.ZSTD_e_flush,
    })
    return Buffer.concat([complete, recovered])
  } catch (error: unknown) {
    signal?.throwIfAborted()
    if (error instanceof Error && error.name === 'AbortError') throw error
    return complete
  }
}

/** Locate frame boundaries without accepting invalid complete-frame structure. */
function scanFrames(bytes: Buffer): { frames: FrameRange[]; tornStart?: number } {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < bytes.length) {
    const start = offset
    if (bytes.length - offset < 4) return { frames, tornStart: start }
    if (bytes.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === bytes.length) return { frames, tornStart: start }
    const descriptor = bytes.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (bytes.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (bytes.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = bytes.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (bytes.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (bytes.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Parse the header and every complete event row, retaining the final fragment only as a torn tail. */
function parseCurrentJsonl(bytes: Buffer, expectedHeader: SessionHeader, path: string): SessionEvent[] {
  const headerEnd = bytes.indexOf(0x0A)
  if (headerEnd < 0) throw new Error(`empty or header-less Session log: ${path}`)
  const header = parseRecord(bytes.subarray(0, headerEnd), 'header', path)
  assertExactKeys(header, HEADER_REQUIRED, HEADER_OPTIONAL, 'physical Session header', path)
  if (header['type'] !== 'session' || header['version'] !== 4 || typeof header['id'] !== 'string'
    || typeof header['isSeeded'] !== 'boolean' || (header['origin'] !== undefined && header['origin'] !== 'subagent')) {
    throw new Error(`invalid physical v4 Session header in ${path}`)
  }
  assertCount(header['createdAt'], 'header createdAt', path)
  assertCount(header['delegationDepth'], 'header delegationDepth', path)
  for (const key of ['parentSession', 'agentPreset'] as const) {
    if (header[key] !== undefined && typeof header[key] !== 'string') {
      throw new Error(`invalid physical Session header ${key} in ${path}`)
    }
  }
  if (header['cwd'] !== undefined && (typeof header['cwd'] !== 'string' || !isAbsolute(header['cwd']))) {
    throw new Error(`invalid physical Session header cwd in ${path}`)
  }
  if (header['id'] !== String(expectedHeader.id) || header['createdAt'] !== expectedHeader.createdAt
    || header['isSeeded'] !== (expectedHeader.isSeeded === true) || header['cwd'] !== expectedHeader.cwd
    || header['parentSession'] !== expectedHeader.parentSession || header['origin'] !== expectedHeader.origin
    || header['agentPreset'] !== expectedHeader.agentPreset
    || header['delegationDepth'] !== (expectedHeader.delegationDepth ?? 0)) {
    throw new Error(`Session log header does not match the validated corpus listing: ${path}`)
  }
  const events: SessionEvent[] = []
  let lineStart = headerEnd + 1
  while (lineStart < bytes.length) {
    const newline = bytes.indexOf(0x0A, lineStart)
    if (newline < 0) break
    const line = bytes.subarray(lineStart, newline)
    lineStart = newline + 1
    const event = parseRecord(line, `event ${String(events.length)}`, path)
    assertExactKeys(event, EVENT_REQUIRED, EVENT_OPTIONAL, `Session event ${String(events.length)}`, path)
    if (typeof event['type'] !== 'string' || event['type'].length === 0) {
      throw new Error(`invalid Session event type at seq ${String(events.length)} in ${path}`)
    }
    assertCount(event['seq'], `Session event ${String(events.length)} seq`, path)
    if (event['seq'] !== events.length) {
      throw new Error(`non-contiguous Session event ${String(events.length)} in ${path}`)
    }
    if (!Number.isSafeInteger(event['time']) || Object.is(event['time'], -0)) {
      throw new Error(`invalid Session event time at seq ${String(events.length)} in ${path}`)
    }
    if (event['ignorable'] !== undefined && event['ignorable'] !== true) {
      throw new Error(`Session event ignorable must be true when present at seq ${String(events.length)} in ${path}`)
    }
    if (event['type'] === 'session/end-seed') assertEndSeedData(event['data'], events.length, path)
    if (event['type'].startsWith(DEVLEAD_RECORD_PREFIX) && event['ignorable'] !== true) {
      throw new Error(`DevLead record at seq ${String(events.length)} is not marked ignorable in ${path}`)
    }
    const decoded = event['sourceEventSeqs'] === undefined ? event : {
      ...event,
      sourceEventSeqs: decodeSourceEventSeqs(event['sourceEventSeqs'], events.length, path),
    }
    events.push(decoded as unknown as SessionEvent)
  }
  return events
}

/** Validate the marker that controls which prefix is inherited rather than owned. */
function assertEndSeedData(data: unknown, seq: number, path: string): void {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`session/end-seed data must be an object at seq ${String(seq)} in ${path}`)
  }
  const record = data as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'inherited')
    || (record['inherited'] !== undefined && record['inherited'] !== true)) {
    throw new Error(`invalid session/end-seed data at seq ${String(seq)} in ${path}`)
  }
}

/** Require exactly the released v4 physical envelope keys. */
function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  path: string,
): void {
  const allowed = new Set([...required, ...optional])
  const missing = required.find(key => !Object.hasOwn(record, key))
  if (missing !== undefined) throw new Error(`${label} lacks required field ${missing} in ${path}`)
  const unexpected = Object.keys(record).find(key => !allowed.has(key))
  if (unexpected !== undefined) throw new Error(`${label} has unexpected field ${unexpected} in ${path}`)
}

/** Validate a non-negative safe integer used by physical v4 framing. */
function assertCount(value: unknown, label: string, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new Error(`${label} must be a non-negative safe integer in ${path}`)
  }
}

/** Expand and validate the released v4 source-event range representation. */
function decodeSourceEventSeqs(value: unknown, maxEntries: number, path: string): readonly number[] {
  if (!Array.isArray(value)) throw new Error(`sourceEventSeqs must be an array in ${path}`)
  const output: number[] = []
  let hasRange = false
  for (const entry of value) {
    if (!Array.isArray(entry)) {
      assertCount(entry, 'sourceEventSeqs member', path)
      output.push(entry)
      continue
    }
    if (entry.length !== 2) throw new Error(`sourceEventSeqs range must be a [start, end] pair in ${path}`)
    assertCount(entry[0], 'sourceEventSeqs range start', path)
    assertCount(entry[1], 'sourceEventSeqs range end', path)
    const start = entry[0]
    const end = entry[1]
    if (start > end || end >= maxEntries || end - start + 1 > maxEntries - output.length) {
      throw new Error(`sourceEventSeqs range exceeds its event seq in ${path}`)
    }
    for (let current = start; current <= end; current += 1) output.push(current)
    hasRange = true
  }
  const seen = new Set<number>()
  for (const source of output) {
    if (source >= maxEntries || seen.has(source)) {
      throw new Error(`sourceEventSeqs must contain unique earlier seqs in ${path}`)
    }
    seen.add(source)
  }
  if (hasRange && output.some((source, index) => index > 0 && source <= output[index - 1]!)) {
    throw new Error(`sourceEventSeqs ranges must be strictly increasing in ${path}`)
  }
  return output
}

/** Decode one JSON object without accepting malformed UTF-8 or array/scalar rows. */
function parseRecord(line: Buffer, label: string, path: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(utf8.decode(line))
  } catch (error: unknown) {
    throw new Error(`invalid committed ${label} JSON in ${path}`, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid committed ${label}: expected a JSON object in ${path}`)
  }
  return value as Record<string, unknown>
}

/** Recover the exact inherited cut; inherited DevLead records must stay excluded. */
function inheritedCut(events: readonly SessionEvent[], header: SessionHeader, path: string): SessionLogOffset {
  let inherited: number | undefined
  for (const event of events) {
    if (event.type !== 'session/end-seed') continue
    const data = event.data as { inherited?: unknown } | null | undefined
    if (data?.inherited === true) inherited = event.seq
  }
  if (header.isSeeded === true) {
    if (inherited === undefined) throw new Error(`seeded Session has no inherited-cut marker: ${path}`)
    return SessionLogOffset(inherited)
  }
  if (inherited !== undefined) throw new Error(`unseeded Session has an inherited-cut marker: ${path}`)
  return SessionLogOffset(0)
}
