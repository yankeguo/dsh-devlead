/**
 * Read-only board file loader: stat + complete bytes, strict parse, and a
 * debounced `workspaceFiles.changes` subscription. Every Remote operation is
 * scoped to the tab's Session and the deployment-published absolute path.
 *
 * The watch is the primary update source. Because a watch may be unavailable,
 * a missing file is also covered by bounded polling; an ended watch keeps the
 * explicit manual-refresh status and never silently reconnects.
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

/** Hook result plus the manual, read-only retry/reconnect operation. */
export interface DevLeadBoardFileResult extends DevLeadBoardFileState {
  readonly watch: DevLeadBoardWatchStatus
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

/**
 * Load and follow one configured board file.
 *
 * A missing file is the empty state, never a parse failure; while empty,
 * bounded polling retries until the file appears. Read/schema errors retain
 * only the last successful timestamp, not stale project cards. A dead change
 * stream leaves manual refresh usable and never throws through React.
 */
export function useBoardFile({
  sessionId,
  config,
  files,
  debounceMs = 120,
  pollMs = 4_000,
  pollMaxMs = 30_000,
  now = Date.now,
}: {
  readonly sessionId: SessionId
  readonly config: DevLeadBoardConfig | undefined
  readonly files: DevLeadBoardFiles
  readonly debounceMs?: number
  /** Initial delay before retrying a missing board; doubles after every tick. */
  readonly pollMs?: number
  /** Upper bound for the empty-state retry delay. */
  readonly pollMaxMs?: number
  readonly now?: () => number
}): DevLeadBoardFileResult {
  const [state, setState] = useState<DevLeadBoardFileState>(() => initialState(config))
  const [watch, setWatch] = useState<DevLeadBoardWatchStatus>(config === undefined ? 'disabled' : 'connecting')
  const [watchGeneration, setWatchGeneration] = useState(0)
  const generation = useRef(0)
  const readAbort = useRef<AbortController | undefined>(undefined)

  const refreshRead = useCallback((): void => {
    if (config === undefined) {
      generation.current += 1
      readAbort.current?.abort()
      setState(DISABLED)
      return
    }
    const request = ++generation.current
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
        refreshRead()
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
              refreshRead()
            } else if (frame.kind === 'change') schedule()
          }
        } finally {
          stream.dispose()
        }
      } catch {
        // Unsupported/ended watches degrade to manual refresh. They do not
        // invalidate a good board or masquerade as malformed board content.
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

  // A missing file may never emit a watch frame (unsupported watch, missing
  // parent directory, or an older Host), so retry it with bounded exponential
  // backoff. Keying only on the status keeps an in-flight poll from resetting
  // the delay: `refreshing` toggles while the status stays empty.
  useEffect(() => {
    if (config === undefined || state.status !== 'empty') return
    let delay = pollMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      timer = setTimeout(() => {
        timer = undefined
        refreshRead()
        delay = Math.min(delay * 2, pollMaxMs)
        schedule()
      }, delay)
    }
    schedule()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [config, pollMs, pollMaxMs, refreshRead, state.status])

  /** Manual retry also reopens a dead watch; background reads only refresh bytes. */
  const refresh = useCallback((): void => {
    refreshRead()
    if (config !== undefined) setWatchGeneration(current => current + 1)
  }, [config, refreshRead])

  return { ...state, watch, refresh }
}
