/**
 * Read-only board file loader: stat + complete bytes, strict parse, and a
 * debounced `workspaceFiles.changes` subscription. Every Remote operation is
 * scoped to the tab's Session and the deployment-published absolute path.
 *
 * The watch is the primary update source. A visible, focused panel also polls
 * every state (including ready and error), so missed/unsupported watch events,
 * a missing file, and malformed content all recover without manual intervention.
 * Background reads share one in-flight request; only an explicit manual refresh
 * may supersede it and reconnect an ended watch.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type {
  WorkspaceFileBytes,
  WorkspaceFileStat,
  WorkspaceFileWatchFrame,
} from '@deepseek-ai/dsh-api-workspace-files/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEVLEAD_BOARD_MAX_BYTES,
  DevLeadBoardParseError,
  parseDevLeadBoardBytes,
  type DevLeadBoard,
  type DevLeadBoardConfig,
} from './board.ts'

/** Direct Remote stream; disposal is required even when iteration never starts. */
export interface DevLeadBoardChangeStream extends AsyncIterable<WorkspaceFileWatchFrame> {
  dispose(): void
}

/** The only Workspace Files methods the read-only panel may call. */
export interface DevLeadBoardFiles {
  stat(sessionId: SessionId, path: string, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileStat>>
  readBytes(
    sessionId: SessionId,
    path: string,
    options: Record<string, never>,
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceFileBytes<Uint8Array<ArrayBuffer>>>>
  changes(sessionId: SessionId, path: string, signal?: AbortSignal): DevLeadBoardChangeStream
}

/** Why the current file cannot be displayed. */
export interface DevLeadBoardFileError {
  readonly kind: 'read' | 'parse'
  readonly message: string
}

/** Complete render state; disabled never performs I/O. */
export interface DevLeadBoardFileState {
  readonly status: 'disabled' | 'loading' | 'empty' | 'ready' | 'error'
  readonly board?: DevLeadBoard
  readonly error?: DevLeadBoardFileError
  /** Last successful valid board read, retained across a later failure. */
  readonly lastSuccessAt?: string
  /** A refresh is in flight; ready content may remain visible meanwhile. */
  readonly refreshing: boolean
}

/** Live-update health, independent from file parse/read health. */
export type DevLeadBoardWatchStatus = 'disabled' | 'connecting' | 'live' | 'ended'

/** Whether the visibility/focus-gated polling fallback is currently running. */
export type DevLeadBoardAutoRefreshStatus = 'disabled' | 'active' | 'paused'

/** Hook result plus the manual, read-only retry/reconnect operation. */
export interface DevLeadBoardFileResult extends DevLeadBoardFileState {
  readonly watch: DevLeadBoardWatchStatus
  readonly autoRefresh: DevLeadBoardAutoRefreshStatus
  readonly refresh: () => void
}

const DISABLED: DevLeadBoardFileState = { status: 'disabled', refreshing: false }

function initialState(config: DevLeadBoardConfig | undefined): DevLeadBoardFileState {
  return config === undefined ? DISABLED : { status: 'loading', refreshing: false }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(result: RemoteResult<unknown>): boolean {
  return !result.ok && result.error.code === 'workspace-file/not-found'
}

/** Server/test renderers without a DOM behave as a visible, focused panel. */
function panelPageActive(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
    && (typeof document.hasFocus !== 'function' || document.hasFocus())
}

/**
 * Load and follow one configured board file.
 *
 * A missing file is the empty state, never a parse failure. Read/schema errors
 * retain only the last successful timestamp, not stale project cards. Polling
 * covers every file state: ready polls at the base cadence, while empty/error
 * back off exponentially. Timers run only while the document is visible and
 * focused; either resume event triggers one immediate coalesced read. A dead
 * change stream still leaves both polling and manual reconnect usable.
 */
export function useBoardFile({
  sessionId,
  config,
  files,
  visible = true,
  debounceMs = 120,
  pollMs = 5_000,
  pollMaxMs = 30_000,
  now = Date.now,
}: {
  readonly sessionId: SessionId
  readonly config: DevLeadBoardConfig | undefined
  readonly files: DevLeadBoardFiles
  /** Right-Sidebar tab visibility from DSH's `useTabInfo` projection. */
  readonly visible?: boolean
  readonly debounceMs?: number
  /** Base polling cadence; empty/error states double it after every tick. */
  readonly pollMs?: number
  /** Upper bound for empty/error retry backoff. */
  readonly pollMaxMs?: number
  readonly now?: () => number
}): DevLeadBoardFileResult {
  const [state, setState] = useState<DevLeadBoardFileState>(() => initialState(config))
  const [watch, setWatch] = useState<DevLeadBoardWatchStatus>(config === undefined ? 'disabled' : 'connecting')
  const [autoRefresh, setAutoRefresh] = useState<DevLeadBoardAutoRefreshStatus>(() =>
    config === undefined ? 'disabled' : visible && panelPageActive() ? 'active' : 'paused')
  const [watchGeneration, setWatchGeneration] = useState(0)
  const generation = useRef(0)
  const readAbort = useRef<AbortController | undefined>(undefined)
  const trailingRead = useRef(false)

  const refreshRead = useCallback((force = false, queueTrailing = false): void => {
    if (config === undefined) {
      generation.current += 1
      readAbort.current?.abort()
      readAbort.current = undefined
      setState(DISABLED)
      return
    }
    // Watch readiness/change, polling, focus, and visibility resume can arrive
    // together. They share the current read; a watch event during it adds one
    // trailing refresh. Only a human retry supersedes the active request.
    if (!force && readAbort.current !== undefined && !readAbort.current.signal.aborted) {
      // Poll/focus duplicates simply share this request. A watch event that
      // arrives during it also schedules one trailing read, because the file
      // may have changed after the current stat/read snapshot began.
      if (queueTrailing) trailingRead.current = true
      return
    }
    const request = ++generation.current
    trailingRead.current = false
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    setState(previous => ({
      ...previous,
      status: previous.status === 'disabled' ? 'loading' : previous.status,
      refreshing: true,
    }))

    const settle = (next: DevLeadBoardFileState): void => {
      if (generation.current !== request || controller.signal.aborted) return
      setState(next)
    }
    const fail = (kind: DevLeadBoardFileError['kind'], error: unknown): void => {
      if (generation.current !== request || controller.signal.aborted) return
      setState(previous => ({
        status: 'error',
        error: { kind, message: errorMessage(error) },
        ...previous.lastSuccessAt === undefined ? {} : { lastSuccessAt: previous.lastSuccessAt },
        refreshing: false,
      }))
    }

    void (async () => {
      try {
        const metadata = await files.stat(sessionId, config.boardPath, controller.signal)
        if (generation.current !== request || controller.signal.aborted) return
        if (!metadata.ok) {
          if (isNotFound(metadata)) {
            settle({ status: 'empty', refreshing: false })
          } else {
            fail('read', metadata.error)
          }
          return
        }
        if (metadata.value.bytes !== undefined && metadata.value.bytes > DEVLEAD_BOARD_MAX_BYTES) {
          fail('parse', new DevLeadBoardParseError(`board file exceeds ${DEVLEAD_BOARD_MAX_BYTES} bytes`))
          return
        }
        const content = await files.readBytes(sessionId, config.boardPath, {}, controller.signal)
        if (generation.current !== request || controller.signal.aborted) return
        if (!content.ok) {
          if (isNotFound(content)) {
            settle({ status: 'empty', refreshing: false })
          } else {
            fail('read', content.error)
          }
          return
        }
        if (!content.value.eof || content.value.data.byteLength > DEVLEAD_BOARD_MAX_BYTES) {
          fail('parse', new DevLeadBoardParseError('board file is truncated or too large'))
          return
        }
        let board: DevLeadBoard
        try {
          board = parseDevLeadBoardBytes(content.value.data, config.pathPlatform)
        } catch (error) {
          fail('parse', error)
          return
        }
        settle({
          status: 'ready',
          board,
          lastSuccessAt: new Date(now()).toISOString(),
          refreshing: false,
        })
      } catch (error) {
        if (generation.current !== request || controller.signal.aborted) return
        fail('read', error)
      } finally {
        if (readAbort.current === controller) {
          readAbort.current = undefined
          if (trailingRead.current && generation.current === request && !controller.signal.aborted) {
            trailingRead.current = false
            queueMicrotask(() => {
              if (generation.current === request && !controller.signal.aborted) refreshRead()
            })
          }
        }
      }
    })()
  }, [config, files, now, sessionId])

  useEffect(() => {
    if (config === undefined) {
      setState(DISABLED)
      setWatch('disabled')
      return
    }
    setWatch('connecting')
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const watcher = new AbortController()
    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        refreshRead(false, true)
      }, debounceMs)
    }
    const pump = async (): Promise<void> => {
      try {
        const stream = files.changes(sessionId, config.boardPath, watcher.signal)
        try {
          for await (const frame of stream) {
            if (disposed) return
            if (frame.kind === 'ready') {
              setWatch('live')
              refreshRead(false, true)
            } else if (frame.kind === 'change') schedule()
          }
        } finally {
          stream.dispose()
        }
      } catch {
        // Unsupported/ended watches degrade to the polling fallback. They do
        // not invalidate a good board or masquerade as malformed board content.
      } finally {
        if (!disposed) setWatch('ended')
      }
    }
    void pump()
    refreshRead()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      generation.current += 1
      watcher.abort()
      readAbort.current?.abort()
    }
  }, [config, debounceMs, files, refreshRead, sessionId, watchGeneration])

  // Poll only a visible, focused page. A focus/visibility resume immediately
  // refreshes once; refreshRead coalesces the common case where both events
  // arrive together. Blur/hidden transitions synchronously clear the timer via
  // the state-driven polling effect below.
  useEffect(() => {
    if (config === undefined) {
      setAutoRefresh('disabled')
      return
    }
    if (!visible) {
      setAutoRefresh('paused')
      return
    }
    if (typeof document === 'undefined') {
      setAutoRefresh('active')
      refreshRead()
      return
    }
    const sync = (resume: boolean): void => {
      const active = resume && panelPageActive()
      setAutoRefresh(active ? 'active' : 'paused')
      if (active) refreshRead()
    }
    const onVisibility = (): void => { sync(document.visibilityState !== 'hidden') }
    const onFocus = (): void => { sync(true) }
    const onBlur = (): void => { setAutoRefresh('paused') }
    sync(panelPageActive())
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [config, refreshRead, visible])

  // Watch events can be lost or unsupported, so every state gets a polling
  // fallback. Healthy/loading reads retain the base cadence; empty/error reads
  // use bounded exponential backoff. Depending on status (not refreshing)
  // keeps an in-flight read from resetting the delay. Changing config, hiding,
  // blurring, or unmounting clears the old timer synchronously through cleanup.
  useEffect(() => {
    if (config === undefined || autoRefresh !== 'active') return
    let delay = pollMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      timer = setTimeout(() => {
        timer = undefined
        refreshRead()
        if (state.status === 'empty' || state.status === 'error') {
          delay = Math.min(delay * 2, pollMaxMs)
        }
        schedule()
      }, delay)
    }
    schedule()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [autoRefresh, config, pollMs, pollMaxMs, refreshRead, state.status])

  /** Manual retry also supersedes an in-flight read and reopens a dead watch. */
  const refresh = useCallback((): void => {
    refreshRead(true)
    if (config !== undefined) setWatchGeneration(current => current + 1)
  }, [config, refreshRead])

  return { ...state, watch, autoRefresh, refresh }
}
