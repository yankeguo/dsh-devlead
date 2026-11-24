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

function statOk() {
  return ok({ absolutePath: CONFIG.boardPath, version: 'v1', bytes: 100 })
}

/** Single-consumer stream with explicit frames, a failure path, and idempotent disposal. */
class FakeStream implements DevLeadBoardChangeStream {
  readonly dispose = vi.fn(() => {
    this.ended = true
    this.wake?.()
  })
  private readonly frames: WorkspaceFileWatchFrame[] = []
  private failure: unknown
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

  /** Terminate iteration with an error, mimicking a dropped Remote stream. */
  fail(error: unknown): void {
    this.failure = error
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WorkspaceFileWatchFrame> {
    while (true) {
      if (this.ended) {
        if (this.failure !== undefined) throw this.failure
        return
      }
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

type StatResult = Awaited<ReturnType<DevLeadBoardFiles['stat']>>
type ReadBytesResult = Awaited<ReturnType<DevLeadBoardFiles['readBytes']>>

function fakeFiles(): FakeFiles {
  const streams: FakeStream[] = []
  const signals: AbortSignal[] = []
  const stat = vi.fn<DevLeadBoardFiles['stat']>(async () => statOk())
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
  readonly visible?: boolean
  readonly debounceMs?: number
  readonly pollMs?: number
  readonly pollMaxMs?: number
  readonly readTimeoutMs?: number
}

function Probe({ config, files, visible = true, debounceMs = 20, pollMs = 5_000, pollMaxMs = 30_000, readTimeoutMs = 10_000 }: ProbeProps) {
  const state = useBoardFile({ sessionId: SESSION, config, files, visible, debounceMs, now: NOW_FN, pollMs, pollMaxMs, readTimeoutMs })
  return (
    <>
      <span
        data-probe="state"
        data-status={state.status}
        data-revision={state.board?.revision ?? ''}
        data-error={state.error?.kind ?? ''}
        data-error-message={state.error?.message ?? ''}
        data-last-success={state.lastSuccessAt ?? ''}
        data-refreshing={state.refreshing ? 'true' : 'false'}
        data-watch={state.watch}
        data-auto-refresh={state.autoRefresh}
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

/** Minimal browser visibility/focus event target; no jsdom dependency. */
function fakeBrowserPage() {
  let visible = true
  let focused = true
  const documentListeners = new Set<() => void>()
  const windowListeners = new Map<string, Set<() => void>>()
  vi.stubGlobal('document', {
    get visibilityState() { return visible ? 'visible' : 'hidden' },
    hasFocus: () => focused,
    addEventListener: (_name: string, listener: () => void) => { documentListeners.add(listener) },
    removeEventListener: (_name: string, listener: () => void) => { documentListeners.delete(listener) },
  })
  vi.stubGlobal('window', {
    addEventListener: (name: string, listener: () => void) => {
      const listeners = windowListeners.get(name) ?? new Set<() => void>()
      listeners.add(listener)
      windowListeners.set(name, listeners)
    },
    removeEventListener: (name: string, listener: () => void) => { windowListeners.get(name)?.delete(listener) },
  })
  const emitWindow = (name: string): void => {
    for (const listener of windowListeners.get(name) ?? []) listener()
  }
  return {
    hide(): void {
      visible = false
      focused = false
      for (const listener of documentListeners) listener()
    },
    show(): void {
      visible = true
      focused = true
      for (const listener of documentListeners) listener()
    },
    blur(): void {
      focused = false
      emitWindow('blur')
    },
    focus(): void {
      focused = true
      emitWindow('focus')
    },
  }
}

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

  it('degrades to an ended watch when the change stream cannot start', async () => {
    const fake = fakeFiles()
    fake.changes.mockImplementationOnce(() => {
      throw new Error('watch unsupported')
    })
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-revision': 1,
      'data-error': '',
      'data-watch': 'ended',
    })
    expect(fake.changes).toHaveBeenCalledTimes(1)
    await act(async () => {
      renderer.root.findByProps({ 'data-probe': 'refresh' }).props.onClick()
    })
    await flush()
    expect(fake.changes).toHaveBeenCalledTimes(2)
    expect(stateOf(renderer)['data-watch']).toBe('connecting')
    await act(async () => {
      fake.streams[0]!.push({ kind: 'ready' })
      await Promise.resolve()
    })
    await flush()
    expect(stateOf(renderer)['data-watch']).toBe('live')
  })

  it('keeps polling after a rejected stream but reconnects only on manual refresh', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await act(async () => {
      fake.streams[0]!.push({ kind: 'ready' })
      await Promise.resolve()
    })
    await flush()
    expect(stateOf(renderer)['data-watch']).toBe('live')
    await act(async () => {
      fake.streams[0]!.fail(new Error('watch transport failed'))
      await Promise.resolve()
    })
    await flush()
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-revision': 1,
      'data-error': '',
      'data-watch': 'ended',
    })
    const reads = fake.readBytes.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(300_000)
    })
    await flush()
    expect(fake.changes).toHaveBeenCalledTimes(1)
    expect(fake.readBytes.mock.calls.length).toBeGreaterThan(reads)
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

  it('polls a missing board with bounded backoff until it appears', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    fake.stat.mockResolvedValue(failure('workspace-file/not-found'))
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} pollMs={4_000} pollMaxMs={30_000} />)
    await flush()
    expect(stateOf(renderer)['data-status']).toBe('empty')
    const initial = fake.stat.mock.calls.length
    expect(initial).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(4_000)
    })
    await flush()
    expect(fake.stat.mock.calls.length).toBe(initial + 1)
    expect(stateOf(renderer)['data-status']).toBe('empty')
    // The retry delay doubles after each tick: no retry on the next 4s.
    await act(async () => {
      vi.advanceTimersByTime(4_000)
    })
    await flush()
    expect(fake.stat.mock.calls.length).toBe(initial + 1)
    // ...but the following 4s completes the doubled (8s) delay.
    await act(async () => {
      vi.advanceTimersByTime(4_000)
    })
    await flush()
    expect(fake.stat.mock.calls.length).toBe(initial + 2)
    // Publish the file; the next tick, 16s out, loads it.
    fake.stat.mockResolvedValue(statOk())
    await act(async () => {
      vi.advanceTimersByTime(16_000)
    })
    await flush()
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-revision': 1,
      'data-error': '',
    })
    const settled = fake.stat.mock.calls.length
    // Recovery does not disable the fallback: a healthy board now polls at the
    // base cadence so later external edits do not depend on the ended watch.
    await act(async () => {
      vi.advanceTimersByTime(4_000)
    })
    await flush()
    expect(fake.stat.mock.calls.length).toBe(settled + 1)
  })

  it('polls a healthy board at the base cadence without exponential drift', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} pollMs={5_000} />)
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-auto-refresh': 'active' })
    expect(fake.stat).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(4_999) })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(2)
    // The second healthy interval is still 5s, not the empty/error 10s step.
    await act(async () => { vi.advanceTimersByTime(5_000) })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(3)
  })

  it('automatically recovers an initial read error through polling', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    fake.stat.mockResolvedValueOnce(failure('gateway/lookup-not-found'))
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} pollMs={5_000} />)
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'error', 'data-error': 'read' })
    await act(async () => { vi.advanceTimersByTime(5_000) })
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-revision': 1, 'data-error': '' })
  })

  it('pauses while hidden or blurred and refreshes immediately on resume', async () => {
    vi.useFakeTimers()
    const page = fakeBrowserPage()
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} pollMs={5_000} />)
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(1)
    await act(async () => { page.hide() })
    expect(stateOf(renderer)['data-auto-refresh']).toBe('paused')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(1)
    await act(async () => { page.show() })
    await flush()
    expect(stateOf(renderer)['data-auto-refresh']).toBe('active')
    expect(fake.stat).toHaveBeenCalledTimes(2)
    await act(async () => { page.blur() })
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(2)
    await act(async () => { page.focus() })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(3)
  })

  it('pauses while the Sidebar tab is hidden and resumes on its first visible render', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} visible={false} pollMs={5_000} />)
    await flush()
    expect(stateOf(renderer)['data-auto-refresh']).toBe('paused')
    const initial = fake.stat.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(fake.stat.mock.calls.length).toBe(initial)
    await act(async () => { renderer.update(<Probe config={CONFIG} files={fake.files} visible pollMs={5_000} />) })
    await flush()
    expect(stateOf(renderer)['data-auto-refresh']).toBe('active')
    expect(fake.stat.mock.calls.length).toBe(initial + 1)
  })

  it('coalesces simultaneous triggers into one in-flight read and one trailing refresh', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} debounceMs={5_000} pollMs={5_000} />)
    await flush()
    let resolveStat!: (value: StatResult) => void
    fake.stat.mockImplementationOnce(() => new Promise<StatResult>(resolve => { resolveStat = resolve }))
    await act(async () => {
      fake.streams[0]!.push({ kind: 'change', change: { absolutePath: CONFIG.boardPath, version: 'v2' } })
      await Promise.resolve()
      vi.advanceTimersByTime(5_000)
    })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(2)
    // A newer change arrives while that read is pending. It shares the current
    // request but must leave exactly one trailing read behind.
    await act(async () => {
      fake.streams[0]!.push({ kind: 'change', change: { absolutePath: CONFIG.boardPath, version: 'v4' } })
      await Promise.resolve()
      vi.advanceTimersByTime(5_000)
    })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(2)
    resolveStat(statOk())
    await flush()
    // No additional timer advance: the triggers received during the pending
    // stat produce exactly one immediate trailing read, never a dropped change.
    expect(fake.stat).toHaveBeenCalledTimes(3)
    expect(stateOf(renderer)['data-status']).toBe('ready')
    await act(async () => { vi.advanceTimersByTime(1_000) })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(3)
  })

  it('publishes a timeout error before aborting a hung stat and recovering a newer board', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} debounceMs={5} pollMs={10} readTimeoutMs={15} />)
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-revision': 1 })

    fake.stat.mockImplementationOnce(() => new Promise<StatResult>(() => {}))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(2)
    const hungSignal = fake.stat.mock.calls[1]?.[2]
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-revision': 1, 'data-refreshing': 'true' })

    // The intervening poll shares the hung request. At the watchdog deadline,
    // the public error is fully settled and the aborted Remote is still hung.
    await act(async () => { vi.advanceTimersByTime(14) })
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-error': '', 'data-refreshing': 'true' })
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'error',
      'data-error': 'read',
      'data-error-message': 'board file read timed out after 15 ms',
      'data-refreshing': 'false',
    })
    expect(hungSignal?.aborted).toBe(true)

    fake.readBytes.mockResolvedValue(ok(readValue(board(2))))
    await act(async () => {
      fake.streams[0]!.push({ kind: 'change', change: { absolutePath: CONFIG.boardPath, version: 'v2' } })
      await vi.advanceTimersByTimeAsync(20)
    })
    await flush()

    // The next automatic trigger is no longer blocked by the never-settling
    // Promise; it reads the newer revision without a manual refresh.
    expect(fake.stat.mock.calls.length).toBeGreaterThan(2)
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-revision': 2,
      'data-error': '',
      'data-refreshing': 'false',
    })
  })

  it.each([
    { recovery: 'automatic', pollMs: 10 },
    { recovery: 'manual', pollMs: 60_000 },
  ] as const)('times out hung readBytes and recovers a newer revision through $recovery refresh', async ({ recovery, pollMs }) => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    fake.readBytes
      .mockImplementationOnce(() => new Promise<ReadBytesResult>(() => {}))
      .mockResolvedValueOnce(ok(readValue(board(2))))
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} pollMs={pollMs} readTimeoutMs={15} />)
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(1)
    expect(fake.readBytes).toHaveBeenCalledTimes(1)
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'loading', 'data-refreshing': 'true' })
    const hungSignal = fake.readBytes.mock.calls[0]?.[3]

    // stat succeeded, so this deadline specifically exercises a readBytes
    // Promise that ignores AbortSignal and never settles.
    await act(async () => { vi.advanceTimersByTime(15) })
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'error',
      'data-error': 'read',
      'data-error-message': 'board file read timed out after 15 ms',
      'data-refreshing': 'false',
    })
    expect(hungSignal?.aborted).toBe(true)

    if (recovery === 'automatic') {
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    } else {
      await act(async () => {
        renderer.root.findByProps({ 'data-probe': 'refresh' }).props.onClick()
      })
    }
    await flush()
    expect(fake.stat.mock.calls.length).toBeGreaterThan(1)
    expect(fake.readBytes.mock.calls.length).toBeGreaterThan(1)
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-revision': 2,
      'data-error': '',
      'data-refreshing': 'false',
    })
  })

  it('stops empty-state polling on unmount', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    fake.stat.mockResolvedValue(failure('workspace-file/not-found'))
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} pollMs={4_000} />)
    await flush()
    expect(stateOf(renderer)['data-status']).toBe('empty')
    const before = fake.stat.mock.calls.length
    await act(async () => {
      renderer.unmount()
    })
    mounted.splice(mounted.indexOf(renderer), 1)
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    await flush()
    expect(fake.stat.mock.calls.length).toBe(before)
  })

  it('keeps polling a missing board after the watch ends', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    fake.stat.mockResolvedValue(failure('workspace-file/not-found'))
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} pollMs={4_000} />)
    await flush()
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'empty', 'data-watch': 'connecting' })
    await act(async () => {
      fake.streams[0]!.finish()
      await Promise.resolve()
    })
    await flush()
    expect(stateOf(renderer)['data-watch']).toBe('ended')
    fake.stat.mockResolvedValue(statOk())
    await act(async () => {
      vi.advanceTimersByTime(4_000)
    })
    await flush()
    expect(stateOf(renderer)).toMatchObject({
      'data-status': 'ready',
      'data-revision': 1,
      'data-watch': 'ended',
    })
  })

  it('aborts an in-flight stat on unmount and ignores its late result', async () => {
    const fake = fakeFiles()
    let resolveStat!: (value: StatResult) => void
    const pending = new Promise<StatResult>(resolve => { resolveStat = resolve })
    fake.stat.mockImplementationOnce(() => pending)
    const consoleError = vi.spyOn(console, 'error')
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    expect(fake.stat).toHaveBeenCalledTimes(1)
    const signal = fake.stat.mock.calls[0]?.[2]
    expect(signal?.aborted).toBe(false)
    await act(async () => {
      renderer.unmount()
    })
    mounted.splice(mounted.indexOf(renderer), 1)
    expect(signal?.aborted).toBe(true)
    resolveStat(statOk())
    await Promise.resolve()
    await flush()
    expect(fake.readBytes).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('aborts an in-flight readBytes on unmount and ignores its late result', async () => {
    const fake = fakeFiles()
    let resolveRead!: (value: ReadBytesResult) => void
    const pending = new Promise<ReadBytesResult>(resolve => { resolveRead = resolve })
    fake.readBytes.mockImplementationOnce(() => pending)
    const consoleError = vi.spyOn(console, 'error')
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    expect(fake.readBytes).toHaveBeenCalledTimes(1)
    const signal = fake.readBytes.mock.calls[0]?.[3]
    expect(signal?.aborted).toBe(false)
    await act(async () => {
      renderer.unmount()
    })
    mounted.splice(mounted.indexOf(renderer), 1)
    expect(signal?.aborted).toBe(true)
    resolveRead(ok(readValue('{late bad json')))
    await Promise.resolve()
    await flush()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('re-reads the new path and drops the old watch when the config changes', async () => {
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} />)
    await flush()
    expect(fake.stat.mock.calls.map(call => call[1])).toEqual([CONFIG.boardPath])
    const staleStream = fake.streams[0]!
    const next: DevLeadBoardConfig = { ...CONFIG, boardPath: '/work/next/.dsh/devlead/board.json' }
    await act(async () => {
      renderer.update(<Probe config={next} files={fake.files} />)
    })
    await flush()
    // The first file stops being read: its signal aborts, its stream disposes,
    // and the next stat/read pair targets only the new path.
    expect(fake.signals[0]?.aborted).toBe(true)
    expect(staleStream.dispose).toHaveBeenCalled()
    expect(fake.stat.mock.calls.map(call => call[1])).toEqual([CONFIG.boardPath, next.boardPath])
    expect(fake.readBytes.mock.calls.map(call => call[1])).toEqual([CONFIG.boardPath, next.boardPath])
    expect(fake.changes.mock.calls.map(call => call[1])).toEqual([CONFIG.boardPath, next.boardPath])
    expect(stateOf(renderer)).toMatchObject({ 'data-status': 'ready', 'data-revision': 1 })
  })

  it('clears the old path timer and polls only the replacement config', async () => {
    vi.useFakeTimers()
    const fake = fakeFiles()
    const renderer = await mount(<Probe config={CONFIG} files={fake.files} pollMs={5_000} />)
    await flush()
    const next: DevLeadBoardConfig = { ...CONFIG, boardPath: '/work/next/.dsh/devlead/board.json' }
    await act(async () => { renderer.update(<Probe config={next} files={fake.files} pollMs={5_000} />) })
    await flush()
    const callsAfterSwitch = fake.stat.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(5_000) })
    await flush()
    expect(fake.stat.mock.calls.length).toBe(callsAfterSwitch + 1)
    expect(fake.stat).toHaveBeenLastCalledWith(SESSION, next.boardPath, expect.any(AbortSignal))
    expect(fake.stat.mock.calls.filter(call => call[1] === CONFIG.boardPath)).toHaveLength(1)
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
