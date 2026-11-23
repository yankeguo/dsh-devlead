/** Hook tests with scripted unary Remote calls and direct change-stream handles. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DevLeadBoard, DevLeadBoardConfig } from '../src/client/board.ts'
import {
  useBoardFile,
  type DevLeadBoardChangeStream,
  type DevLeadBoardFiles,
} from '../src/client/useBoardFile.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const SESSION = 'session-1' as SessionId
const CONFIG: DevLeadBoardConfig = {
  boardPath: '/work/.dsh/devlead/board.json',
  schemaVersion: 1,
  pathPlatform: 'posix',
}
const NOW = Date.UTC(2026, 10, 23, 8, 0, 0)
const NOW_FN = () => NOW
const ISO = '2026-11-23T08:00:00.000Z'

function board(revision = 1): DevLeadBoard {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: ISO,
    updatedBy: { sessionId: 'session-lead', title: 'Lead' },
    projects: [],
  }
}

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

function failure(
  code: 'workspace-file/not-found' | 'gateway/lookup-not-found',
  message = code,
): RemoteResult<never> {
  return {
    ok: false,
    error: {
      name: 'RemoteError',
      isDSHRemoteError: true,
      code,
      message,
      details: undefined as never,
    },
  }
}

function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
  return encoded as Uint8Array<ArrayBuffer>
}

function readValue(value: unknown, eof = true) {
  const data = bytes(value)
  return {
    absolutePath: CONFIG.boardPath,
    version: 'v1',
    bytes: data.byteLength,
    offset: 0,
    data,
    eof,
  }
}

/** Single-consumer stream with explicit frames and idempotent disposal. */
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

  finish(): void {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WorkspaceFileWatchFrame> {
    while (!this.ended) {
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

interface FakeFiles {
  readonly files: DevLeadBoardFiles
  readonly stat: ReturnType<typeof vi.fn<DevLeadBoardFiles['stat']>>
  readonly readBytes: ReturnType<typeof vi.fn<DevLeadBoardFiles['readBytes']>>
  readonly changes: ReturnType<typeof vi.fn<DevLeadBoardFiles['changes']>>
  readonly streams: FakeStream[]
  readonly signals: AbortSignal[]
}

function fakeFiles(): FakeFiles {
  const streams: FakeStream[] = []
  const signals: AbortSignal[] = []
  const stat = vi.fn<DevLeadBoardFiles['stat']>(async () => ok({
    absolutePath: CONFIG.boardPath,
    version: 'v1',
    bytes: 100,
  }))
  const readBytes = vi.fn<DevLeadBoardFiles['readBytes']>(async () => ok(readValue(board())))
  const changes = vi.fn<DevLeadBoardFiles['changes']>((_sessionId, _path, signal) => {
    if (signal !== undefined) signals.push(signal)
    const stream = new FakeStream()
    signal?.addEventListener('abort', () => { stream.dispose() }, { once: true })
    streams.push(stream)
    return stream
  })
  return { files: { stat, readBytes, changes }, stat, readBytes, changes, streams, signals }
}

interface ProbeProps {
  readonly config?: DevLeadBoardConfig | undefined
  readonly files: DevLeadBoardFiles
  readonly debounceMs?: number
}

function Probe({ config, files, debounceMs = 20 }: ProbeProps) {
  const state = useBoardFile({ sessionId: SESSION, config, files, debounceMs, now: NOW_FN })
  return (
    <>
      <span
        data-probe="state"
        data-status={state.status}
        data-revision={state.board?.revision ?? ''}
        data-error={state.error?.kind ?? ''}
        data-last-success={state.lastSuccessAt ?? ''}
        data-refreshing={state.refreshing ? 'true' : 'false'}
        data-watch={state.watch}
      />
      <button data-probe="refresh" onClick={state.refresh} />
    </>
  )
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
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function stateOf(renderer: ReactTestRenderer): Record<string, unknown> {
  return renderer.root.findByProps({ 'data-probe': 'state' }).props as Record<string, unknown>
}

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useBoardFile', () => {
  it('is disabled without a global and performs no I/O', async () => {
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={undefined} files={fake.files} />)
    expect(stateOf(renderer)['data-status']).toBe('disabled')
    expect(fake.stat).not.toHaveBeenCalled()
    expect(fake.readBytes).not.toHaveBeenCalled()
    expect(fake.changes).not.toHaveBeenCalled()
  })

  it('stats then reads the absolute board path and returns a valid board', async () => {
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    expect(fake.stat).toHaveBeenCalledWith(SESSION, CONFIG.boardPath, expect.any(AbortSignal))
    expect(fake.readBytes).toHaveBeenCalledWith(SESSION, CONFIG.boardPath, {}, expect.any(AbortSignal))
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-revision': 1,
      'data-last-success': ISO,
      'data-refreshing': 'false',
    })
  })

  it.each(['stat', 'readBytes'] as const)('maps %s not-found to empty, not an error', async method => {
    const fake = fakeFiles()
    fake[method].mockResolvedValue(failure('workspace-file/not-found'))
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'empty', 'data-error': '' })
    if (method === 'stat') expect(fake.readBytes).not.toHaveBeenCalled()
  })

  it('distinguishes a Remote read failure from malformed content', async () => {
    const fake = fakeFiles()
    fake.stat.mockResolvedValue(failure('gateway/lookup-not-found'))
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'error', 'data-error': 'read' })
  })

  it('retains only last-success metadata when a later refresh has bad JSON', async () => {
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    fake.readBytes.mockResolvedValue(ok(readValue('{bad json')))
    await act(async () => {
      renderer.root.findByProps({ 'data-probe': 'refresh' }).props.onClick()
    })
    await flush()
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'error',
      'data-error': 'parse',
      'data-revision': '',
      'data-last-success': ISO,
    })
  })

  it('treats schema drift and truncated reads as parse errors', async () => {
    const fake = fakeFiles()
    fake.readBytes.mockResolvedValue(ok(readValue({ schemaVersion: 2 })))
    const drift = await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    expect(stateOf(drift)).toMatchObject({ 'data-status': 'error', 'data-error': 'parse' })
    fake.readBytes.mockResolvedValue(ok(readValue(board(), false)))
    await act(async () => {
      drift.root.findByProps({ 'data-probe': 'refresh' }).props.onClick()
    })
    await flush()
    expect(stateOf(drift)).toMatchObject({ 'data-status': 'error', 'data-error': 'parse' })
  })

  it('debounces bursts of change frames before rereading', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} debounceMs={20} />)
    await flush()
    expect(fake.readBytes).toHaveBeenCalledTimes(1)
    fake.readBytes.mockResolvedValue(ok(readValue(board(2))))
    const stream = fake.streams[0]!
    await act(async () => {
      stream.push({ kind: 'change', change: { absolutePath: CONFIG.boardPath, version: 'v2' } })
      stream.push({ kind: 'change', change: { absolutePath: CONFIG.boardPath, version: 'v3' } })
      await Promise.resolve()
    })
    expect(fake.readBytes).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(19)
    })
    expect(fake.readBytes).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
    })
    await flush()
    expect(fake.readBytes).toHaveBeenCalledTimes(2)
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-revision': 2 })
  })

  it('refreshes after watch readiness to close the initial subscription race', async () => {
    const fake = fakeFiles()
    await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    expect(fake.readBytes).toHaveBeenCalledTimes(1)
    await act(async () => {
      fake.streams[0]!.push({ kind: 'ready' })
      await Promise.resolve()
    })
    await flush()
    expect(fake.readBytes).toHaveBeenCalledTimes(2)
  })

  it('does not let a stale failed request replace a newer successful revision', async () => {
    const fake = fakeFiles()
    let resolveFirst!: (value: ReturnType<typeof readValue>) => void
    const first = new Promise<ReturnType<typeof readValue>>(resolve => { resolveFirst = resolve })
    fake.readBytes
      .mockImplementationOnce(() => first.then(value => ok(value)))
      .mockResolvedValueOnce(ok(readValue(board(2))))
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await act(async () => {
      renderer.root.findByProps({ 'data-probe': 'refresh' }).props.onClick()
    })
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-revision': 2 })
    resolveFirst(readValue('{stale bad json'))
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-revision': 2, 'data-error': '' })
  })

  it('marks an ended stream stale and reconnects it on manual refresh', async () => {
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await act(async () => {
      fake.streams[0]!.push({ kind: 'ready' })
      await Promise.resolve()
    })
    await flush()
    expect(stateOf(renderer)['data-watch']).toBe('live')
    await act(async () => {
      fake.streams[0]!.finish()
      await Promise.resolve()
    })
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-watch': 'ended' })
    await act(async () => {
      renderer.root.findByProps({ 'data-probe': 'refresh' }).props.onClick()
    })
    await flush()
    expect(fake.changes).toHaveBeenCalledTimes(2)
    expect(stateOf(renderer)['data-watch']).toBe('connecting')
    await act(async () => {
      fake.streams[1]!.push({ kind: 'ready' })
      await Promise.resolve()
    })
    await flush()
    expect(stateOf(renderer)['data-watch']).toBe('live')
  })

  it('aborts the watch and disposes its direct handle on unmount', async () => {
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    const stream = fake.streams[0]!
    await act(async () => {
      renderer.unmount()
    })
    mounted.splice(mounted.indexOf(renderer), 1)
    await flush()
    expect(fake.signals[0]?.aborted).toBe(true)
    expect(stream.dispose).toHaveBeenCalled()
  })
})
