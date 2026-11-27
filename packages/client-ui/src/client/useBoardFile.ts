/**
 * Read-only board loader. The watch/poll/race machinery is shared with notes;
 * this adapter preserves the original board-specific state and public contract.
 */
import { useMemo } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEVLEAD_BOARD_MAX_BYTES,
  DevLeadBoardParseError,
  parseDevLeadBoardBytes,
  type DevLeadBoard,
  type DevLeadBoardConfig,
} from './board.ts'
import {
  useWorkspaceFile,
  type DevLeadBoardAutoRefreshStatus,
  type DevLeadBoardFileError,
  type DevLeadBoardFiles,
  type DevLeadBoardWatchStatus,
  type DevLeadWorkspaceFileConfig,
} from './useWorkspaceFile.ts'

export type {
  DevLeadBoardAutoRefreshStatus,
  DevLeadBoardChangeStream,
  DevLeadBoardFileError,
  DevLeadBoardFiles,
  DevLeadBoardWatchStatus,
} from './useWorkspaceFile.ts'

/** Complete board render state, retaining the original `board` field name. */
export interface DevLeadBoardFileState {
  readonly status: 'disabled' | 'loading' | 'empty' | 'ready' | 'error'
  readonly board?: DevLeadBoard
  readonly error?: DevLeadBoardFileError
  readonly lastSuccessAt?: string
  readonly refreshing: boolean
}

/** Hook result plus the manual, read-only retry/reconnect operation. */
export interface DevLeadBoardFileResult extends DevLeadBoardFileState {
  readonly watch: DevLeadBoardWatchStatus
  readonly autoRefresh: DevLeadBoardAutoRefreshStatus
  readonly refresh: () => void
}

/** Load and follow one configured board file with the shared robust state machine. */
export function useBoardFile({
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
  readonly config: DevLeadBoardConfig | undefined
  readonly files: DevLeadBoardFiles
  readonly visible?: boolean
  readonly debounceMs?: number
  readonly pollMs?: number
  readonly pollMaxMs?: number
  readonly readTimeoutMs?: number
  readonly now?: () => number
}): DevLeadBoardFileResult {
  const fileConfig = useMemo<DevLeadWorkspaceFileConfig<DevLeadBoard> | undefined>(() => config === undefined ? undefined : {
    path: config.boardFilePath,
    maxBytes: DEVLEAD_BOARD_MAX_BYTES,
    fileLabel: 'board file',
    parse: bytes => parseDevLeadBoardBytes(bytes, config.pathPlatform),
    parseError: (message, options) => new DevLeadBoardParseError(message, options),
  }, [config])
  const { value, watch, autoRefresh, refresh, ...state } = useWorkspaceFile({
    sessionId, config: fileConfig, files, visible, debounceMs, pollMs, pollMaxMs, readTimeoutMs, now,
  })
  return {
    ...state,
    ...value === undefined ? {} : { board: value },
    watch,
    autoRefresh,
    refresh,
  }
}
