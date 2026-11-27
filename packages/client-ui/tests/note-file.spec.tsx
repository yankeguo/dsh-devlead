/** Live note-body reads: stale index metadata cannot override Workspace Files stat/readBytes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import {
  deriveDevLeadNotesPaths,
  DEVLEAD_NOTES_NOTE_MAX_BYTES,
  useDevLeadNote,
  type DevLeadNoteMetadata,
} from '../src/client/notes.ts'
import type {
  DevLeadBoardChangeStream,
  DevLeadBoardFiles,
} from '../src/client/useBoardFile.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const SESSION = 'session-1' as SessionId
const PATHS = deriveDevLeadNotesPaths({ boardFilePath: '/work/board.json', schemaVersion: 1, pathPlatform: 'posix' })
const NOTE_PATH = `${PATHS.root}/project-dir/note.md`
const METADATA: DevLeadNoteMetadata = {
  id: 'note',
  title: 'Note',
  summary: '',
  updatedAt: '2026-11-23T07:00:00.000Z',
  // Deliberately stale: native edits do not update the index transactionally.
  bytes: 1,
  path: 'project-dir/note.md',
}
const NOW = Date.UTC(2026, 10, 23, 8, 0, 0)
const ISO = '2026-11-23T08:00:00.000Z'

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

function failure(code: 'workspace-file/not-found'): RemoteResult<never> {
  return {
    ok: false,
    error: {
      name: 'RemoteError',
      isDSHRemoteError: true,
      code,
      message: code,
      details: undefined as never,
    },
  }
}

function encoded(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>
}

/** Direct stream handle with the same disposal contract as the Remote client. */
class FakeStream implements DevLeadBoardChangeStream {
  readonly dispose = vi.fn(() => {
    this.ended = true
    this.wake?.()
  })
  private readonly frames: WorkspaceFileWatchFrame[] = []
  private wake: (() => void) | undefined
  private ended = false

  push(frame: WorkspaceFileWatchFrame): void {
    this.frames.push(frame)
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WorkspaceFileWatchFrame> {
    while (true) {
      if (this.ended) return
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

function fakeFiles(initial = encoded('# First body')) {
  let data = initial
  const streams: FakeStream[] = []
  const stat = vi.fn<DevLeadBoardFiles['stat']>(async (_sessionId, path) => ok({
    absolutePath: path,
    // A timestamp-looking but opaque value must never be parsed by the hook.
    version: '2020-01-01T00:00:00.000Z/opaque',
    bytes: data.byteLength,
  }))
  const readBytes = vi.fn<DevLeadBoardFiles['readBytes']>(async (_sessionId, path) => ok({
    absolutePath: path,
    version: 'opaque-read-version',
    bytes: data.byteLength,
    offset: 0,
    data,
    eof: true,
  }))
  const changes = vi.fn<DevLeadBoardFiles['changes']>((_sessionId, _path, signal) => {
    const stream = new FakeStream()
    signal?.addEventListener('abort', () => { stream.dispose() }, { once: true })
    streams.push(stream)
    return stream
  })
  return {
    files: { stat, readBytes, changes },
    stat,
    readBytes,
    changes,
    streams,
    setData(next: Uint8Array<ArrayBuffer>): void { data = next },
  }
}

function Probe({ files, metadata, now, debounceMs = 20, pollMs = 5_000 }: {
  readonly files: DevLeadBoardFiles
  readonly metadata: DevLeadNoteMetadata
  readonly now: () => number
  readonly debounceMs?: number
  readonly pollMs?: number
}) {
  const note = useDevLeadNote({ sessionId: SESSION, paths: PATHS, metadata, files, now, debounceMs, pollMs })
  return <span
    data-probe="note"
    data-status={note.status}
    data-markdown={note.value?.markdown ?? ''}
    data-error-kind={note.error?.kind ?? ''}
    data-error-message={note.error?.message ?? ''}
    data-value-path={note.valuePath ?? ''}
    data-observed-at={note.observedAt ?? ''}
    data-observed-bytes={note.observedBytes ?? ''}
  />
}

const mounted: ReactTestRenderer[] = []

async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(element)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  if (renderer === undefined) throw new Error('no renderer')
  mounted.push(renderer)
  return renderer
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

function noteState(renderer: ReactTestRenderer): Record<string, unknown> {
  return renderer.root.findByProps({ 'data-probe': 'note' }).props as Record<string, unknown>
}

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useDevLeadNote live Workspace Files observation', () => {
  it('reads live bytes and stat time despite stale index bytes, without reopening for metadata refreshes', async () => {
    const fake = fakeFiles()
    const now = () => NOW
    const renderer = await mount(<Probe files={fake.files} metadata={METADATA} now={now} />)
    await flush()
    expect(noteState(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-markdown': '# First body',
      'data-error-kind': '',
      'data-value-path': NOTE_PATH,
      'data-observed-at': ISO,
      'data-observed-bytes': encoded('# First body').byteLength,
    })
    expect(fake.stat).toHaveBeenCalledWith(SESSION, NOTE_PATH, expect.any(AbortSignal))
    expect(fake.readBytes).toHaveBeenCalledWith(SESSION, NOTE_PATH, {}, expect.any(AbortSignal))

    const stream = fake.streams[0]
    await act(async () => {
      renderer.update(<Probe
        files={fake.files}
        metadata={{ ...METADATA, bytes: DEVLEAD_NOTES_NOTE_MAX_BYTES + 1, updatedAt: '2026-11-23T07:30:00.000Z' }}
        now={now}
      />)
    })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(1)
    expect(fake.readBytes).toHaveBeenCalledTimes(1)
    expect(fake.changes).toHaveBeenCalledTimes(1)
    expect(fake.streams[0]).toBe(stream)
    expect(noteState(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-markdown': '# First body',
      'data-observed-bytes': encoded('# First body').byteLength,
    })
  })

  it('refreshes body, live bytes, and observation time after both watch events and polling', async () => {
    vi.useFakeTimers()
    let clock = NOW
    const now = () => clock
    const fake = fakeFiles()
    const renderer = await mount(<Probe files={fake.files} metadata={METADATA} now={now} />)
    await flush()
    expect(noteState(renderer)['data-observed-at']).toBe(ISO)

    const watched = encoded('# Watched body\n\nMore bytes')
    fake.setData(watched)
    clock += 60_000
    await act(async () => {
      fake.streams[0]!.push({ kind: 'change', change: { absolutePath: NOTE_PATH, version: 'opaque-new-version' } })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(20)
    })
    await flush()
    expect(noteState(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-markdown': '# Watched body\n\nMore bytes',
      'data-observed-at': new Date(clock).toISOString(),
      'data-observed-bytes': watched.byteLength,
    })

    const polled = encoded('# Polled body\n\nMore bytes still')
    fake.setData(polled)
    clock += 5_000
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    await flush()
    expect(noteState(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-markdown': '# Polled body\n\nMore bytes still',
      'data-observed-at': new Date(clock).toISOString(),
      'data-observed-bytes': polled.byteLength,
    })
  })

  it('rejects a stat-reported oversized note before readBytes', async () => {
    const fake = fakeFiles()
    fake.stat.mockResolvedValue(ok({
      absolutePath: NOTE_PATH,
      version: 'opaque',
      bytes: DEVLEAD_NOTES_NOTE_MAX_BYTES + 1,
    }))
    const renderer = await mount(<Probe files={fake.files} metadata={METADATA} now={() => NOW} />)
    await flush()
    expect(noteState(renderer)).toMatchObject({
      'data-status': 'error',
      'data-error-kind': 'parse',
      'data-markdown': '',
    })
    expect(String(noteState(renderer)['data-error-message'])).toContain('exceeds')
    expect(fake.readBytes).not.toHaveBeenCalled()
  })

  it('degrades invalid UTF-8 to a note parse error', async () => {
    const fake = fakeFiles(new Uint8Array([0xff]))
    const renderer = await mount(<Probe files={fake.files} metadata={METADATA} now={() => NOW} />)
    await flush()
    expect(noteState(renderer)).toMatchObject({
      'data-status': 'error',
      'data-error-kind': 'parse',
      'data-markdown': '',
    })
    expect(String(noteState(renderer)['data-error-message'])).toContain('not valid UTF-8')
  })

  it('maps a missing live file to the note-empty state even when index metadata remains', async () => {
    const fake = fakeFiles()
    fake.stat.mockResolvedValue(failure('workspace-file/not-found'))
    const renderer = await mount(<Probe files={fake.files} metadata={METADATA} now={() => NOW} />)
    await flush()
    expect(noteState(renderer)).toMatchObject({
      'data-status': 'empty',
      'data-error-kind': '',
      'data-markdown': '',
    })
    expect(fake.readBytes).not.toHaveBeenCalled()
  })
})
