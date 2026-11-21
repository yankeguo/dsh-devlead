import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, chmod, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress } from 'node:zlib'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { DEVLEAD_MODE_RECORD_TYPE } from '@yankeguo/dsh-devlead-protocol'
import { readCurrentJsonlForDevLead } from '../src/session-log-recovery.ts'
import { DevLeadError } from '../src/error.ts'
import {
  bootService,
  disposeHarnesses,
  FakeAgent,
  FakeProjectionCache,
  FakeSessionPersistence,
  FakeSessionQuery,
  projectionStateOf,
  T0,
  type ServiceHarness,
} from './harness.ts'
import { modeEvent, pluginRecordEvent, sessionEvent, watchEvent } from './fixtures.ts'

const compress = promisify(zstdCompress)
const temporaryRoots: string[] = []

afterEach(async () => {
  await disposeHarnesses()
  await Promise.all(temporaryRoots.splice(0).map(async path => {
    await rm(path, { recursive: true, force: true })
  }))
})

/** Build the exact rc.5 error chain for an old, non-ignorable plugin event. */
function unknownEventError(sessionId: string, event: SessionEvent, path: string): Error {
  const cause = Object.assign(new Error(
    `session "${sessionId}" contains event type "${event.type}" (seq ${String(event.seq)}) `
    + 'unknown to this harness and not marked ignorable; refusing to interpret the log '
    + `— it was likely written by a newer harness (raw log: ${path})`,
  ), {
    name: 'SessionFormatUnsupportedError',
    location: { kind: 'jsonl', path },
  })
  return Object.assign(new Error(
    `failed to read stored session "${sessionId}": ${cause.message}`,
    { cause },
  ), {
    name: 'SessionQueryError',
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
  })
}

/** Write one current-generation JSONL artifact using independent zstd frames. */
async function writeV4Log(
  root: string,
  sessionId: string,
  frames: readonly (readonly SessionEvent[])[],
  isSeeded = false,
): Promise<string> {
  const path = join(root, 'session.v4.jsonl.zstd')
  const header = `${JSON.stringify({
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: T0,
    isSeeded,
    delegationDepth: 0,
  })}\n`
  const chunks = [await compress(header)]
  for (const events of frames) {
    chunks.push(await compress(`${events.map(event => JSON.stringify(event)).join('\n')}\n`))
  }
  await writeFile(path, Buffer.concat(chunks))
  return path
}

function headerFor(sessionId: string, isSeeded = false): SessionHeader {
  return {
    id: SessionId(sessionId), createdAt: T0, isSeeded, delegationDepth: 0,
  } as SessionHeader
}

/** Boot a corpus whose only cold row fails normal replay on its first old event. */
async function bootWithUnknownEventLog(
  sessionId: string,
  events: readonly SessionEvent[],
  path: string,
): Promise<{ harness: ServiceHarness; target: FakeAgent }> {
  const query = new FakeSessionQuery()
  query.seedRecord(headerFor(sessionId, events.some(event => event.type === 'session/end-seed')), events)
  const originalRead = query.readSession.bind(query)
  query.readSession = async id => {
    const oldEvent = events.find(event => String(event.type) === 'infini-goal/change')!
    if (String(id) === sessionId) throw unknownEventError(sessionId, oldEvent, path)
    return await originalRead(id)
  }
  const persistence = new FakeSessionPersistence()
  persistence.ids = [sessionId]
  persistence.locations.set(sessionId, path)
  const harness = await bootService({
    enabled: true,
    sessionIds: ['target'],
    sessionQuery: query,
    sessionPersistence: persistence,
  })
  const target = new FakeAgent(harness.sessions['target']!)
  harness.agents.add(target)
  return { harness, target }
}

async function expectPromptFailure(harness: ServiceHarness, code: string): Promise<DevLeadError> {
  try {
    await harness.service.promptSession(harness.lead.agent, 'target', 'must remain fail closed')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DevLeadError)
    expect((error as DevLeadError).code).toBe(code)
    return error as DevLeadError
  }
  throw new Error(`expected prompt to fail with ${code}`)
}

describe('cold supervision recovery for unrelated unknown events', () => {
  it('reproduces the old infini-goal event blocking prompt delivery and recovers without editing the log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-unknown-event-'))
    temporaryRoots.push(root)
    const legacyId = 'session-ffaba61a-27d3-4a6e-a910-2df05935df4e'
    const oldEvent = sessionEvent(0, 'infini-goal/change', { goalId: 'historical', enabled: false })
    const path = await writeV4Log(root, legacyId, [[oldEvent]])
    const originalBytes = await readFile(path)
    const { harness, target } = await bootWithUnknownEventLog(legacyId, [oldEvent], path)

    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'continue after unrelated legacy event')
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
    expect(await readFile(path)).toEqual(originalBytes)
    expect(harness.ctx.sessions.get(SessionId(legacyId))).toBeUndefined()
  })

  it('still rejects a foreign supervisor hidden behind an unrelated unknown event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-unknown-foreign-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-foreign-lead'
    const events = [
      sessionEvent(0, 'infini-goal/change', { enabled: false }),
      modeEvent(1, true),
      watchEvent(2, ['target']),
    ]
    const path = await writeV4Log(root, legacyId, [[events[0]!], [events[1]!, events[2]!]])
    const { harness, target } = await bootWithUnknownEventLog(legacyId, events, path)

    await expectPromptFailure(harness, 'DEVLEAD_FOREIGN_SUPERVISOR')
    expect(target.followups).toHaveLength(0)
  })

  it('fails closed with the Session id, path, and decoder cause for a corrupt DevLead record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-unknown-corrupt-record-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-corrupt-devlead'
    const events = [
      sessionEvent(0, 'infini-goal/change', { enabled: false }),
      pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, {
        kind: 'devlead/mode', version: 2, enabled: 'yes', at: T0,
      }),
    ]
    const path = await writeV4Log(root, legacyId, [events])
    const { harness, target } = await bootWithUnknownEventLog(legacyId, events, path)

    const error = await expectPromptFailure(harness, 'DEVLEAD_SESSION_UNAVAILABLE')
    expect(error.message).toContain(legacyId)
    expect(error.message).toContain(path)
    expect(error.message).toContain('corrupt DevLead replay')
    expect(error.message).not.toContain('repair/delete')
    expect(target.followups).toHaveLength(0)
  })

  it('fails closed with a diagnostic path for physical zstd corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-unknown-corrupt-zstd-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-corrupt-zstd'
    const oldEvent = sessionEvent(0, 'infini-goal/change', { enabled: false })
    const path = await writeV4Log(root, legacyId, [[oldEvent]])
    const bytes = await readFile(path)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xFF
    await writeFile(path, bytes)
    const { harness, target } = await bootWithUnknownEventLog(legacyId, [oldEvent], path)

    const error = await expectPromptFailure(harness, 'DEVLEAD_SESSION_UNAVAILABLE')
    expect(error.message).toContain(legacyId)
    expect(error.message).toContain(path)
    expect(error.message).toContain('could not be read')
    expect(target.followups).toHaveLength(0)
  })

  it('recovers complete DevLead records from a torn final frame without writing repairs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-unknown-torn-frame-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-torn-frame'
    const events = [
      sessionEvent(0, 'infini-goal/change', { enabled: false }),
      modeEvent(1, true),
      watchEvent(2, ['target']),
    ]
    const path = join(root, 'session.v4.jsonl.zstd')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
    const chunks = [
      await compress(header),
      await compress(`${JSON.stringify(events[0])}\n`),
      await compress(`${events.slice(1).map(event => JSON.stringify(event)).join('\n')}\n`, checksum),
    ]
    // Remove only the final checksum: all event rows remain recoverable, but
    // the physical frame is incomplete and must never be rewritten by a read.
    chunks[2] = chunks[2]!.subarray(0, chunks[2]!.length - 4)
    await writeFile(path, Buffer.concat(chunks))
    const originalBytes = await readFile(path)
    const { harness, target } = await bootWithUnknownEventLog(legacyId, events, path)

    await expectPromptFailure(harness, 'DEVLEAD_FOREIGN_SUPERVISOR')
    expect(target.followups).toHaveLength(0)
    expect(await readFile(path)).toEqual(originalBytes)
  })

  it('ignores only the incomplete plain-JSONL tail and rejects a complete malformed row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-plain-tail-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-plain-tail'
    const path = join(root, 'session.v4.jsonl')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const oldEvent = sessionEvent(0, 'infini-goal/change', { enabled: false })
    await writeFile(path, `${header}${JSON.stringify(oldEvent)}\n{"type":"plugin:devlead/mode"`)

    const recovered = await readCurrentJsonlForDevLead(path, headerFor(legacyId))
    expect(recovered.events).toHaveLength(1)
    expect(recovered.events[0]?.type).toBe('infini-goal/change')
    await appendFile(path, ',"seq":1}\n')
    await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/Session event 1 lacks required field time/)
  })

  it('detects a concurrent append between the read and the stability recheck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-concurrent-append-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-concurrent-append'
    const path = join(root, 'session.v4.jsonl')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const oldEvent = sessionEvent(0, 'infini-goal/change', { enabled: false })
    await writeFile(path, `${header}${JSON.stringify(oldEvent)}\n`)
    const probe = await open(path, 'r')
    const prototype = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const originalRead = prototype.readFile
    const spy = vi.spyOn(prototype, 'readFile').mockImplementationOnce((async function (this: FileHandle) {
      const bytes = await originalRead.call(this, null) as Buffer
      await appendFile(path, `${JSON.stringify(modeEvent(1, true))}\n`)
      return bytes
    }) as never)
    try {
      await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/changed during read-only recovery/)
    } finally {
      spy.mockRestore()
    }
  })

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'surfaces an unreadable-file permission failure instead of treating it as an empty log',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'devlead-unreadable-log-'))
      temporaryRoots.push(root)
      const legacyId = 'legacy-unreadable'
      const path = join(root, 'session.v4.jsonl')
      const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
      await writeFile(path, header)
      await chmod(path, 0)
      try {
        await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/EACCES|permission/i)
      } finally {
        await chmod(path, 0o600)
      }
    },
  )

  it('keeps complete frames when a torn suffix is too short to decode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-early-torn-frame-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-early-torn-frame'
    const oldEvent = sessionEvent(0, 'infini-goal/change', { enabled: false })
    const complete = await writeV4Log(root, legacyId, [[oldEvent]])
    const bytes = await readFile(complete)
    const torn = await compress(`${JSON.stringify(modeEvent(1, true))}\n`)
    await writeFile(complete, Buffer.concat([bytes, torn.subarray(0, 6)]))
    const { harness, target } = await bootWithUnknownEventLog(legacyId, [oldEvent], complete)

    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'ignore only uncommitted fragment')
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
  })

  it('honors cancellation before touching a recovery artifact', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readCurrentJsonlForDevLead(
      join(tmpdir(), 'session.v4.jsonl.zstd'),
      headerFor('cancelled-recovery'),
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses the same recovery for cache-positive global single-active admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-active-admission-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-active-admission'
    const events = [
      sessionEvent(0, 'infini-goal/change', { enabled: false }),
      modeEvent(1, true),
    ]
    const path = await writeV4Log(root, legacyId, [events])
    const query = new FakeSessionQuery()
    query.seedRecord(headerFor(legacyId), events)
    query.readSession = async () => { throw unknownEventError(legacyId, events[0]!, path) }
    const persistence = new FakeSessionPersistence()
    persistence.ids = [legacyId]
    persistence.locations.set(legacyId, path)
    const cache = new FakeProjectionCache()
    cache.setDevLead(legacyId, { enabled: true })
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target', 'second-lead'],
      sessionQuery: query,
      sessionPersistence: persistence,
      projectionCache: cache,
    })
    const second = new FakeAgent(harness.sessions['second-lead']!)
    harness.agents.add(second)

    await expect(harness.service.setEnabled(second.agent, true)).rejects.toMatchObject({
      code: 'DEVLEAD_ALREADY_ACTIVE',
    })
  })

  it('fails strict admission when an unknown-cache candidate cannot be recovered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-unknown-admission-read-failure-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-unknown-admission-read-failure'
    const oldEvent = sessionEvent(0, 'infini-goal/change', { enabled: false })
    const path = join(root, 'session.v4.jsonl.zstd')
    const query = new FakeSessionQuery()
    query.seedRecord(headerFor(legacyId), [oldEvent])
    query.readSession = async () => { throw unknownEventError(legacyId, oldEvent, path) }
    const persistence = new FakeSessionPersistence()
    persistence.ids = [legacyId]
    // No backend-verified location: the fallback must not guess a path.
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target', 'second-lead'],
      sessionQuery: query,
      sessionPersistence: persistence,
      projectionCache: new FakeProjectionCache(),
    })
    const second = new FakeAgent(harness.sessions['second-lead']!)
    harness.agents.add(second)

    await expect(harness.service.setEnabled(second.agent, true)).rejects.toMatchObject({
      code: 'DEVLEAD_SESSION_UNAVAILABLE',
    })
    expect(projectionStateOf(second.session).enabled).toBe(false)
  })

  it('fails strict admission when an unknown-cache candidate has a corrupt DevLead fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-unknown-admission-fold-failure-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-unknown-admission-fold-failure'
    const events = [
      sessionEvent(0, 'infini-goal/change', { enabled: false }),
      pluginRecordEvent(1, DEVLEAD_MODE_RECORD_TYPE, {
        kind: 'devlead/mode', version: 2, enabled: 'yes', at: T0,
      }),
    ]
    const path = await writeV4Log(root, legacyId, [events])
    const query = new FakeSessionQuery()
    query.seedRecord(headerFor(legacyId), events)
    query.readSession = async () => { throw unknownEventError(legacyId, events[0]!, path) }
    const persistence = new FakeSessionPersistence()
    persistence.ids = [legacyId]
    persistence.locations.set(legacyId, path)
    const harness = await bootService({
      enabled: true,
      sessionIds: ['target', 'second-lead'],
      sessionQuery: query,
      sessionPersistence: persistence,
      projectionCache: new FakeProjectionCache(),
    })
    const second = new FakeAgent(harness.sessions['second-lead']!)
    harness.agents.add(second)

    await expect(harness.service.setEnabled(second.agent, true)).rejects.toMatchObject({
      code: 'DEVLEAD_SESSION_UNAVAILABLE',
    })
    expect(projectionStateOf(second.session).enabled).toBe(false)
  })

  it('requires the first complete zstd frame to contain only the header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-mixed-header-frame-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-mixed-header-frame'
    const path = join(root, 'session.v4.jsonl.zstd')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const oldEvent = sessionEvent(0, 'infini-goal/change', { enabled: false })
    await writeFile(path, await compress(`${header}${JSON.stringify(oldEvent)}\n`))
    await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/first frame is not exactly one header line/)
  })

  it('refuses a log with no complete header frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-torn-header-frame-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-torn-header-frame'
    const path = join(root, 'session.v4.jsonl.zstd')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const frame = await compress(header)
    await writeFile(path, frame.subarray(0, 6))
    await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/empty or header-less Zstandard/)
  })

  it('rejects an incomplete JSONL record inside the complete-frame prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-complete-frame-fragment-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-complete-frame-fragment'
    const path = join(root, 'session.v4.jsonl.zstd')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const oldEvent = sessionEvent(0, 'infini-goal/change', { enabled: false })
    const line = JSON.stringify(oldEvent)
    await writeFile(path, Buffer.concat([
      await compress(header),
      await compress(line.slice(0, -1)),
    ]))
    await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/complete frame contains a torn JSONL record/)
  })

  it('detects atomic path replacement even while the opened inode stays unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-path-replacement-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-path-replacement'
    const path = join(root, 'session.v4.jsonl')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const oldEvent = sessionEvent(0, 'infini-goal/change', { enabled: false })
    await writeFile(path, `${header}${JSON.stringify(oldEvent)}\n`)
    const probe = await open(path, 'r')
    const prototype = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const originalRead = prototype.readFile
    const spy = vi.spyOn(prototype, 'readFile').mockImplementationOnce((async function (this: FileHandle, options: null) {
      const bytes = await originalRead.call(this, options) as Buffer
      await rename(path, `${path}.old`)
      await writeFile(path, bytes)
      return bytes
    }) as never)
    try {
      await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/changed during read-only recovery/)
    } finally {
      spy.mockRestore()
    }
  })

  it('decodes compressed sourceEventSeqs ranges into logical event sequences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-source-ranges-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-source-ranges'
    const path = join(root, 'session.v4.jsonl')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const events = [
      sessionEvent(0, 'infini-goal/change', { enabled: false }),
      sessionEvent(1, 'infini-goal/change', { enabled: true }),
      {
        ...sessionEvent(2, 'infini-goal/change', { enabled: false }),
        sourceEventSeqs: [[0, 1]],
      } as unknown as SessionEvent,
    ]
    await writeFile(path, `${header}${events.map(event => JSON.stringify(event)).join('\n')}\n`)
    const recovered = await readCurrentJsonlForDevLead(path, headerFor(legacyId))
    expect(recovered.events[2]?.sourceEventSeqs).toEqual([0, 1])
  })

  it('rejects malformed UTF-8 rather than silently changing a committed row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-invalid-utf8-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-invalid-utf8'
    const path = join(root, 'session.v4.jsonl')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const oldEvent = sessionEvent(0, 'infini-goal/change', { text: 'historical' })
    const line = Buffer.from(`${JSON.stringify(oldEvent)}\n`)
    line[line.indexOf('historical')] = 0xFF
    await writeFile(path, Buffer.concat([Buffer.from(header), line]))
    await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/invalid committed event 0 JSON/)
  })

  it('rejects a same-id artifact whose optional lineage header differs from the listing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-header-mismatch-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-header-mismatch'
    const path = join(root, 'session.v4.jsonl')
    const physical = {
      ...headerFor(legacyId), type: 'session', version: 4, parentSession: 'parent-a',
    }
    await writeFile(path, `${JSON.stringify(physical)}\n`)
    const expected = { ...headerFor(legacyId), parentSession: SessionId('parent-b') } as SessionHeader
    await expect(readCurrentJsonlForDevLead(path, expected)).rejects.toThrow(/does not match the validated corpus listing/)
  })

  it('passes the scan signal into FileHandle.readFile for mid-read cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-mid-read-abort-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-mid-read-abort'
    const path = join(root, 'session.v4.jsonl')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    await writeFile(path, header)
    const probe = await open(path, 'r')
    const prototype = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const originalRead = prototype.readFile
    const controller = new AbortController()
    const spy = vi.spyOn(prototype, 'readFile').mockImplementationOnce((async function (
      this: FileHandle,
      options: { signal?: AbortSignal },
    ) {
      expect(options.signal).toBe(controller.signal)
      controller.abort()
      return await originalRead.call(this, options)
    }) as never)
    try {
      await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId), controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses historical formats rather than guessing their event representation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-old-format-'))
    temporaryRoots.push(root)
    const path = join(root, 'session.v3.jsonl.zstd')
    await writeFile(path, 'not a current artifact')
    await expect(readCurrentJsonlForDevLead(path, headerFor('legacy-old-format'))).rejects.toThrow(/supports only current/)
  })

  it('bounds neither valid history nor DevLead proof to the first unknown event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-large-log-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-large-log'
    const events = Array.from({ length: 2_000 }, (_, seq) => sessionEvent(
      seq,
      'infini-goal/change',
      { seq, payload: 'x'.repeat(1_024) },
    ))
    const path = await writeV4Log(root, legacyId, [events])
    const recovered = await readCurrentJsonlForDevLead(path, headerFor(legacyId))
    expect(recovered.events).toHaveLength(2_000)
    expect(recovered.events.at(-1)?.seq).toBe(1_999)
  })

  it('rejects a malformed inherited-cut marker instead of guessing ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-invalid-seed-marker-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-invalid-seed-marker'
    const path = join(root, 'session.v4.jsonl')
    const header = `${JSON.stringify({ ...headerFor(legacyId), type: 'session', version: 4 })}\n`
    const marker = sessionEvent(0, 'session/end-seed', { inherited: 'yes' })
    await writeFile(path, `${header}${JSON.stringify(marker)}\n`)
    await expect(readCurrentJsonlForDevLead(path, headerFor(legacyId))).rejects.toThrow(/invalid session\/end-seed data/)
  })

  it('excludes inherited DevLead records at the exact fork cut', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlead-inherited-log-'))
    temporaryRoots.push(root)
    const legacyId = 'legacy-inherited-log'
    const events = [
      modeEvent(0, true),
      sessionEvent(1, 'session/end-seed', { inherited: true }),
      sessionEvent(2, 'infini-goal/change', { enabled: false }),
      watchEvent(3, ['owned-target']),
    ]
    const path = await writeV4Log(root, legacyId, [events], true)
    const recovered = await readCurrentJsonlForDevLead(path, headerFor(legacyId, true))
    expect(recovered.inheritedEventCount).toBe(1)
    expect(recovered.events[3]?.type).toBe('plugin:devlead/watch')
    const { harness, target } = await bootWithUnknownEventLog(legacyId, events, path)

    const receipt = await harness.service.promptSession(harness.lead.agent, 'target', 'inherited watch is not owned')
    expect(receipt.sessionId).toBe('target')
    expect(target.followups).toHaveLength(1)
  })
})
