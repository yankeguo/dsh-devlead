/**
 * Shared read-only Workspace Files state machine used by the board and notes.
 * Watches are primary; visible/focused polling is the recovery path for missed
 * events, unsupported streams, missing files, and transient malformed writes.
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
export interface DevLeadWorkspaceFileState<T> {
  readonly status: 'disabled' | 'loading' | 'empty' | 'ready' | 'error'
  readonly value?: T
  /** Fixed path that produced `value`; prevents cross-note stale-content display. */
  readonly valuePath?: string
  readonly error?: DevLeadBoardFileError
  /** Last successful valid read, retained across a later failure. */
  readonly lastSuccessAt?: string
  /** Client observation time of the stat paired with this ready value; not a filesystem mtime. */
  readonly observedAt?: string
  /** Live byte count reported by that stat, never metadata from another file or index. */
  readonly observedBytes?: number
  /** A refresh is in flight; ready content may remain visible meanwhile. */
  readonly refreshing: boolean
}

/** Live-update health, independent from file parse/read health. */
export type DevLeadBoardWatchStatus = 'disabled' | 'connecting' | 'live' | 'ended'

/** Whether the visibility/focus-gated polling fallback is currently running. */
export type DevLeadBoardAutoRefreshStatus = 'disabled' | 'active' | 'paused'

/** Hook result plus the manual, read-only retry/reconnect operation. */
export interface DevLeadWorkspaceFileResult<T> extends DevLeadWorkspaceFileState<T> {
  readonly watch: DevLeadBoardWatchStatus
  readonly autoRefresh: DevLeadBoardAutoRefreshStatus
  readonly refresh: () => void
}

/** Decoder and fixed path for one authoritative file. */
export interface DevLeadWorkspaceFileConfig<T> {
  readonly path: string
  readonly maxBytes: number
  readonly fileLabel: string
  parse(bytes: Uint8Array): T
  parseError(message: string, options?: { cause?: unknown }): Error
}

const DISABLED = { status: 'disabled', refreshing: false } as const

function initialState<T>(config: DevLeadWorkspaceFileConfig<T> | undefined): DevLeadWorkspaceFileState<T> {
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
 * Load and follow one configured file without write APIs or caller-provided
 * navigation. Only a manual refresh supersedes an in-flight request; all other
 * triggers share it, with one trailing read for a concurrent watch event.
 */
export function useWorkspaceFile<T>({
  sessionId,
  config,
  files,
  visible = true,
  debounceMs = 120,
  pollMs = 5_000,
  pollMaxMs = 30_000,
  readTimeoutMs = 10_000,
  now = Date.now,
}: {
  readonly sessionId: SessionId
  readonly config: DevLeadWorkspaceFileConfig<T> | undefined
  readonly files: DevLeadBoardFiles
  readonly visible?: boolean
  readonly debounceMs?: number
  readonly pollMs?: number
  readonly pollMaxMs?: number
  /** Bound one stat/readBytes pair so a hung Remote cannot wedge later polls. */
  readonly readTimeoutMs?: number
  readonly now?: () => number
}): DevLeadWorkspaceFileResult<T> {
  const [state, setState] = useState<DevLeadWorkspaceFileState<T>>(() => initialState(config))
  const [watch, setWatch] = useState<DevLeadBoardWatchStatus>(config === undefined ? 'disabled' : 'connecting')
  const [autoRefresh, setAutoRefresh] = useState<DevLeadBoardAutoRefreshStatus>(() =>
    config === undefined ? 'disabled' : visible && panelPageActive() ? 'active' : 'paused')
  const [watchGeneration, setWatchGeneration] = useState(0)
  const generation = useRef(0)
  const readAbort = useRef<AbortController | undefined>(undefined)
  const readTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const trailingRead = useRef(false)

  const refreshRead = useCallback((force = false, queueTrailing = false): void => {
    if (config === undefined) {
      if (readTimeout.current !== undefined) {
        clearTimeout(readTimeout.current)
        readTimeout.current = undefined
      }
      generation.current += 1
      readAbort.current?.abort()
      readAbort.current = undefined
      setState(DISABLED)
      return
    }
    if (!force && readAbort.current !== undefined && !readAbort.current.signal.aborted) {
      if (queueTrailing) trailingRead.current = true
      return
    }
    if (readTimeout.current !== undefined) {
      clearTimeout(readTimeout.current)
      readTimeout.current = undefined
    }
    const request = ++generation.current
    trailingRead.current = false
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    const timeout = setTimeout(() => {
      if (readTimeout.current === timeout) readTimeout.current = undefined
      if (generation.current !== request || controller.signal.aborted) return
      fail('read', new Error(`${config.fileLabel} read timed out after ${readTimeoutMs} ms`))
      // An aborted single-flight no longer blocks the next watch/poll trigger,
      // even when the underlying Remote never settles its returned Promise.
      controller.abort()
    }, readTimeoutMs)
    readTimeout.current = timeout
    setState(previous => ({
      ...previous,
      status: previous.status === 'disabled' ? 'loading' : previous.status,
      refreshing: true,
    }))

    const settle = (next: DevLeadWorkspaceFileState<T>): void => {
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
        const metadata = await files.stat(sessionId, config.path, controller.signal)
        if (generation.current !== request || controller.signal.aborted) return
        if (!metadata.ok) {
          if (isNotFound(metadata)) settle({ status: 'empty', refreshing: false })
          else fail('read', metadata.error)
          return
        }
        // WorkspaceFileStat.version is an opaque freshness token, not a timestamp.
        // Record our own observation time without inferring filesystem mtimes.
        const observedAt = new Date(now()).toISOString()
        if (metadata.value.bytes !== undefined && metadata.value.bytes > config.maxBytes) {
          fail('parse', config.parseError(`${config.fileLabel} exceeds ${config.maxBytes} bytes`))
          return
        }
        const content = await files.readBytes(sessionId, config.path, {}, controller.signal)
        if (generation.current !== request || controller.signal.aborted) return
        if (!content.ok) {
          if (isNotFound(content)) settle({ status: 'empty', refreshing: false })
          else fail('read', content.error)
          return
        }
        if (!content.value.eof || content.value.data.byteLength > config.maxBytes) {
          fail('parse', config.parseError(`${config.fileLabel} is truncated or too large`))
          return
        }
        let value: T
        try {
          value = config.parse(content.value.data)
        } catch (error) {
          fail('parse', error)
          return
        }
        settle({
          status: 'ready',
          value,
          valuePath: config.path,
          lastSuccessAt: new Date(now()).toISOString(),
          observedAt,
          ...metadata.value.bytes === undefined ? {} : { observedBytes: metadata.value.bytes },
          refreshing: false,
        })
      } catch (error) {
        if (generation.current !== request || controller.signal.aborted) return
        fail('read', error)
      } finally {
        clearTimeout(timeout)
        if (readTimeout.current === timeout) readTimeout.current = undefined
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
  }, [config, files, now, readTimeoutMs, sessionId])

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
        const stream = files.changes(sessionId, config.path, watcher.signal)
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
        // Polling remains authoritative when a Remote watch is unsupported.
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
      if (readTimeout.current !== undefined) {
        clearTimeout(readTimeout.current)
        readTimeout.current = undefined
      }
      readAbort.current?.abort()
    }
  }, [config, debounceMs, files, refreshRead, sessionId, watchGeneration])

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

  useEffect(() => {
    if (config === undefined || autoRefresh !== 'active') return
    let delay = pollMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      timer = setTimeout(() => {
        timer = undefined
        refreshRead()
        if (state.status === 'empty' || state.status === 'error') delay = Math.min(delay * 2, pollMaxMs)
        schedule()
      }, delay)
    }
    schedule()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [autoRefresh, config, pollMs, pollMaxMs, refreshRead, state.status])

  const refresh = useCallback((): void => {
    refreshRead(true)
    if (config !== undefined) setWatchGeneration(current => current + 1)
  }, [config, refreshRead])

  // A config path changes during render, before the old watch effect cleans up
  // and the first replacement read settles. Never expose the previous path's
  // retained value as the new workspace's board/index/note in that interval.
  const staleValue = config !== undefined && state.valuePath !== undefined && state.valuePath !== config.path
  const currentState: DevLeadWorkspaceFileState<T> = staleValue
    ? { status: 'loading', refreshing: true }
    : state
  return { ...currentState, watch, autoRefresh, refresh }
}
