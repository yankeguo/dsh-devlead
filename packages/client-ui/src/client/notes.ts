/** Read-only project notes derived from the board's authoritative location. */
import { useMemo } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEVLEAD_NOTES_DIR_NAME,
  DEVLEAD_NOTES_INDEX_FILE_NAME,
  DEVLEAD_NOTES_INDEX_MAX_BYTES,
  DEVLEAD_NOTES_NOTE_MAX_BYTES,
  parseDevLeadNotesIndex,
  type DevLeadNoteMetadata,
  type DevLeadNotesIndex,
  type DevLeadNotesProject,
} from '@yankeguo/dsh-devlead-protocol/client'
import type { DevLeadBoardConfig, DevLeadBoardPathPlatform, DevLeadBoardProject } from './board.ts'
import {
  useWorkspaceFile,
  type DevLeadBoardFiles,
  type DevLeadWorkspaceFileConfig,
  type DevLeadWorkspaceFileResult,
} from './useWorkspaceFile.ts'

export {
  DEVLEAD_NOTES_DIR_NAME,
  DEVLEAD_NOTES_INDEX_FILE_NAME,
  DEVLEAD_NOTES_INDEX_MAX_BYTES,
  DEVLEAD_NOTES_NOTE_MAX_BYTES,
} from '@yankeguo/dsh-devlead-protocol/client'
export type {
  DevLeadNoteMetadata,
  DevLeadNotesIndex,
  DevLeadNotesProject,
} from '@yankeguo/dsh-devlead-protocol/client'

export interface DevLeadNoteDocument {
  readonly markdown: string
}

export class DevLeadNotesParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DevLeadNotesParseError'
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new DevLeadNotesParseError(`${label} is not valid UTF-8`, { cause: error })
  }
}

/** Decode complete bytes, then apply the shared strict protocol schema. */
export function parseDevLeadNotesIndexBytes(bytes: Uint8Array): DevLeadNotesIndex {
  if (bytes.byteLength > DEVLEAD_NOTES_INDEX_MAX_BYTES) {
    throw new DevLeadNotesParseError(`notes index exceeds ${DEVLEAD_NOTES_INDEX_MAX_BYTES} bytes`)
  }
  let value: unknown
  try {
    value = JSON.parse(decodeUtf8(bytes, 'notes index')) as unknown
  } catch (error) {
    if (error instanceof DevLeadNotesParseError) throw error
    throw new DevLeadNotesParseError('notes index is not valid JSON', { cause: error })
  }
  try {
    return parseDevLeadNotesIndex(value)
  } catch (error) {
    throw new DevLeadNotesParseError('notes schema v1 validation failed', { cause: error })
  }
}

export function parseDevLeadNoteBytes(bytes: Uint8Array): DevLeadNoteDocument {
  if (bytes.byteLength > DEVLEAD_NOTES_NOTE_MAX_BYTES) {
    throw new DevLeadNotesParseError(`note file exceeds ${DEVLEAD_NOTES_NOTE_MAX_BYTES} bytes`)
  }
  return { markdown: decodeUtf8(bytes, 'note file') }
}

export interface DevLeadNotesPaths {
  readonly root: string
  readonly indexPath: string
  readonly pathPlatform: DevLeadBoardPathPlatform
}

/** Derive only `notes/index.json` next to the already-resolved board file. */
export function deriveDevLeadNotesPaths(config: DevLeadBoardConfig): DevLeadNotesPaths {
  const separator = config.pathPlatform === 'win32' ? '\\' : '/'
  const alternate = config.pathPlatform === 'win32' ? '/' : '\\'
  const cut = Math.max(config.boardFilePath.lastIndexOf(separator), config.boardFilePath.lastIndexOf(alternate))
  let directory = config.boardFilePath.slice(0, Math.max(0, cut))
  if (directory.length === 0 && config.pathPlatform === 'posix') directory = '/'
  const root = `${directory}${directory.endsWith(separator) ? '' : separator}${DEVLEAD_NOTES_DIR_NAME}`
  return { root, indexPath: `${root}${separator}${DEVLEAD_NOTES_INDEX_FILE_NAME}`, pathPlatform: config.pathPlatform }
}

/** Join protocol-validated metadata to the fixed root; no user path is accepted. */
export function resolveDevLeadNotePath(paths: DevLeadNotesPaths, metadata: DevLeadNoteMetadata): string {
  if (metadata.path.length === 0 || metadata.path.includes('\0') || metadata.path.includes('\\')
    || metadata.path.startsWith('/') || metadata.path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new DevLeadNotesParseError('note metadata path escapes the notes root')
  }
  const separator = paths.pathPlatform === 'win32' ? '\\' : '/'
  return `${paths.root}${metadata.path.split('/').map(segment => `${separator}${segment}`).join('')}`
}

/** The protocol project id is authoritative; directory is a sanitized storage segment. */
export function devLeadNotesForProject(index: DevLeadNotesIndex, project: DevLeadBoardProject): DevLeadNotesProject | undefined {
  return index.projects.find(candidate => candidate.id === project.id)
}

/** Recent-first display order without mutating parsed index arrays. */
export function sortDevLeadNotes(notes: readonly DevLeadNoteMetadata[]): DevLeadNoteMetadata[] {
  return [...notes].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))
}

export type DevLeadNotesIndexResult = DevLeadWorkspaceFileResult<DevLeadNotesIndex>
export type DevLeadNoteResult = DevLeadWorkspaceFileResult<DevLeadNoteDocument>

/** Follow the notes index even while the board itself is empty or malformed. */
export function useDevLeadNotesIndex({ sessionId, config, files, visible = true, debounceMs = 120, pollMs = 5_000, pollMaxMs = 30_000, now = Date.now }: {
  readonly sessionId: SessionId
  readonly config: DevLeadBoardConfig | undefined
  readonly files: DevLeadBoardFiles
  readonly visible?: boolean
  readonly debounceMs?: number
  readonly pollMs?: number
  readonly pollMaxMs?: number
  readonly now?: () => number
}): DevLeadNotesIndexResult {
  const paths = useMemo(() => config === undefined ? undefined : deriveDevLeadNotesPaths(config), [config])
  const fileConfig = useMemo<DevLeadWorkspaceFileConfig<DevLeadNotesIndex> | undefined>(() => paths === undefined ? undefined : {
    path: paths.indexPath,
    maxBytes: DEVLEAD_NOTES_INDEX_MAX_BYTES,
    fileLabel: 'notes index',
    parse: parseDevLeadNotesIndexBytes,
    parseError: (message, options) => new DevLeadNotesParseError(message, options),
  }, [paths])
  return useWorkspaceFile({ sessionId, config: fileConfig, files, visible, debounceMs, pollMs, pollMaxMs, now })
}

/** Follow only the currently open note; closing the reader disables all note I/O. */
export function useDevLeadNote({ sessionId, paths, metadata, files, visible = true, debounceMs = 120, pollMs = 5_000, pollMaxMs = 30_000, now = Date.now }: {
  readonly sessionId: SessionId
  readonly paths: DevLeadNotesPaths | undefined
  readonly metadata: DevLeadNoteMetadata | undefined
  readonly files: DevLeadBoardFiles
  readonly visible?: boolean
  readonly debounceMs?: number
  readonly pollMs?: number
  readonly pollMaxMs?: number
  readonly now?: () => number
}): DevLeadNoteResult {
  const fileConfig = useMemo<DevLeadWorkspaceFileConfig<DevLeadNoteDocument> | undefined>(() => {
    if (paths === undefined || metadata === undefined) return undefined
    return {
      path: resolveDevLeadNotePath(paths, metadata),
      maxBytes: DEVLEAD_NOTES_NOTE_MAX_BYTES,
      fileLabel: 'note file',
      parse: parseDevLeadNoteBytes,
      parseError: (message, options) => new DevLeadNotesParseError(message, options),
    }
  // Index polling creates fresh metadata objects and native file edits can leave
  // its byte count stale. Only identity/path select the file; stat/readBytes own
  // the live body generation, so metadata-only refreshes never reopen its watch.
  }, [metadata?.id, metadata?.path, paths?.root, paths?.pathPlatform])
  return useWorkspaceFile({ sessionId, config: fileConfig, files, visible: visible && metadata !== undefined, debounceMs, pollMs, pollMaxMs, now })
}
