/**
 * Host-owned Markdown notes beside the project board.
 *
 * The notes root is always `dirname(boardPath)/notes`; callers resolve a board
 * project but never supply a filesystem path. The tool owns index metadata and
 * lifecycle only: create makes an empty body, while every Markdown read/edit
 * uses DSH's native file tools directly. Reads reconcile file size/mtime back
 * into the index under its cross-process writer lock without reading the body.
 *
 * @module @yankeguo/dsh-devlead
 */

import { createHash, randomUUID as cryptoRandomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  createDevLeadNotesIndexSchema,
  devLeadBoardIssueViews,
  DEVLEAD_NOTES_DIR_NAME,
  DEVLEAD_NOTES_DIRECTORY_MAX,
  DEVLEAD_NOTES_ID_MAX,
  DEVLEAD_NOTES_INDEX_FILE_NAME,
  DEVLEAD_NOTES_INDEX_MAX_BYTES,
  DEVLEAD_NOTES_MAX_PER_PROJECT,
  DEVLEAD_NOTES_MAX_PROJECTS,
  DEVLEAD_NOTES_NOTE_MAX_BYTES,
  DEVLEAD_NOTES_PATH_MAX,
  DEVLEAD_NOTES_READ_MAX_BYTES,
  DEVLEAD_NOTES_SCHEMA_VERSION,
  DEVLEAD_NOTES_SUMMARY_MAX,
  DEVLEAD_NOTES_TIMESTAMP_MAX,
  DEVLEAD_NOTES_TITLE_MAX,
  type DevLeadNoteMetadata,
  type DevLeadNotesIndex,
  type DevLeadNotesProject,
} from '@yankeguo/dsh-devlead-protocol'
import type { ZodIssue } from 'zod'

export {
  DEVLEAD_NOTES_DIR_NAME,
  DEVLEAD_NOTES_DIRECTORY_MAX,
  DEVLEAD_NOTES_ID_MAX,
  DEVLEAD_NOTES_INDEX_FILE_NAME,
  DEVLEAD_NOTES_INDEX_MAX_BYTES,
  DEVLEAD_NOTES_MAX_PER_PROJECT,
  DEVLEAD_NOTES_MAX_PROJECTS,
  DEVLEAD_NOTES_NOTE_MAX_BYTES,
  DEVLEAD_NOTES_PATH_MAX,
  DEVLEAD_NOTES_READ_MAX_BYTES,
  DEVLEAD_NOTES_SCHEMA_VERSION,
  DEVLEAD_NOTES_SUMMARY_MAX,
  DEVLEAD_NOTES_TIMESTAMP_MAX,
  DEVLEAD_NOTES_TITLE_MAX,
}
export type { DevLeadNoteMetadata, DevLeadNotesIndex, DevLeadNotesProject }

import {
  DevLeadBoardError,
  isDevLeadBoardError,
  type DevLeadBoardIssue,
  type DevLeadBoardStore,
} from './board.ts'

const notesIndexSchema = createDevLeadNotesIndexSchema()
const EMPTY_TIMESTAMP = new Date(0).toISOString()
const READ_ATTEMPTS = 4

/** One project-note metadata read. Omit `note` for the complete metadata listing. */
export interface DevLeadBoardNoteReadFilter {
  readonly project: string
  readonly note?: string
}

/** Public project identity returned by note operations; never a host filesystem path. */
export interface DevLeadBoardNoteProjectView {
  readonly id: string
  readonly directory: string
}

/** Tool-facing metadata; the absolute path is derived by Host and never persisted in the index. */
export interface DevLeadBoardNoteMetadata extends DevLeadNoteMetadata {
  readonly absolutePath: string
}

/** Metadata listing or one selected metadata row; Markdown bodies never enter this result. */
export interface DevLeadBoardNoteReadResult {
  readonly revision: number
  readonly updatedAt: string
  readonly project: DevLeadBoardNoteProjectView
  readonly notes?: DevLeadBoardNoteMetadata[]
  readonly note?: DevLeadBoardNoteMetadata
}

/** Logical note mutation. No field can redirect the notes root or a note path. */
export interface DevLeadBoardNoteWrite {
  readonly project: string
  readonly operation: 'create' | 'update-metadata' | 'delete'
  readonly note?: string
  readonly title?: string
  readonly summary?: string
  readonly expectedRevision?: number
}

/** Result of one committed or no-op logical note mutation. */
export interface DevLeadBoardNoteWriteResult {
  readonly revision: number
  readonly updatedAt: string
  readonly project: DevLeadBoardNoteProjectView
  readonly note: DevLeadBoardNoteMetadata
  readonly operation: DevLeadBoardNoteWrite['operation']
  readonly changed: boolean
  readonly deleted?: boolean
}

interface NotesLogger {
  warn(message: string): void
}

interface FileFingerprint {
  readonly mtimeMs: number
  readonly size: number
  readonly ino: number
}

interface ExistingNoteSnapshot {
  readonly size: number
  readonly updatedAt: string
}

function emptyIndex(): DevLeadNotesIndex {
  return {
    schemaVersion: DEVLEAD_NOTES_SCHEMA_VERSION,
    revision: 0,
    updatedAt: EMPTY_TIMESTAMP,
    projects: [],
  }
}

function sameFingerprint(left: FileFingerprint | undefined, right: FileFingerprint): boolean {
  return left !== undefined && left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

const FILESYSTEM_ERROR_CODES = new Set([
  'EACCES', 'EAGAIN', 'EBUSY', 'EDQUOT', 'EEXIST', 'EFBIG', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE',
  'ENAMETOOLONG', 'ENFILE', 'ENOMEM', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EROFS',
  'ETXTBSY',
])

function isWriterLockTimeout(error: unknown): boolean {
  const message = errorMessage(error)
  const code = errorCode(error)
  return code === 'FILE_LOCK_TIMEOUT'
    || code === 'ATOMIC_WRITE_LOCK_TIMEOUT'
    || /timed out waiting for the writer lock|writer lock timed out/iu.test(message)
}

function isWriteIoError(error: unknown): boolean {
  const code = errorCode(error)
  return (code !== undefined && FILESYSTEM_ERROR_CODES.has(code))
    || (error instanceof Error && error.name === 'FileLockError')
    || isWriterLockTimeout(error)
}

function ioError(action: string, path: string, error: unknown): DevLeadBoardError {
  const retry = isWriterLockTimeout(error)
  return new DevLeadBoardError(
    `could not ${action} ${path}: ${errorMessage(error)}${retry ? '; retry after the current writer finishes' : ''}`,
    'BOARD_IO_ERROR',
  )
}

function invalid(message: string, pointer: string): DevLeadBoardError {
  return new DevLeadBoardError(message, 'BOARD_INVALID', [{ pointer, message }])
}

function limit(message: string, pointer: string): DevLeadBoardError {
  return new DevLeadBoardError(message, 'BOARD_LIMIT_EXCEEDED', [{ pointer, message }])
}

function validationError(error: { issues: readonly ZodIssue[] }): DevLeadBoardError {
  const issues: readonly DevLeadBoardIssue[] = devLeadBoardIssueViews(error.issues)
  const limited = error.issues.some(issue => issue.code === 'too_big')
  const first = issues[0]
  return new DevLeadBoardError(
    `notes index validation failed${first === undefined ? '' : ` at ${first.pointer || '/'}: ${first.message}`}`,
    limited ? 'BOARD_LIMIT_EXCEEDED' : 'BOARD_INVALID',
    issues,
  )
}

function parseIndex(value: unknown): DevLeadNotesIndex {
  const parsed = notesIndexSchema.safeParse(value)
  if (!parsed.success) throw validationError(parsed.error)
  return parsed.data
}

function validateNonNegativeInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw invalid(`${field} must be a non-negative safe integer`, `/${field}`)
  }
}

/** Match the browser's fail-closed UTF-8 contract for the index. */
function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw invalid(`${label} is not valid UTF-8: ${errorMessage(error)}`, '')
  }
}

/** Validate fields that do not depend on the locked current index/body. */
function validateWriteShape(patch: DevLeadBoardNoteWrite): void {
  validateNonNegativeInteger(patch.expectedRevision, 'expectedRevision')
  if (!['create', 'update-metadata', 'delete'].includes(patch.operation)) {
    throw invalid('operation must be create, update-metadata, or delete', '/operation')
  }
  if (patch.operation !== 'create' && patch.note === undefined) {
    throw invalid(`note is required for ${patch.operation}`, '/note')
  }
  if ('content' in patch) {
    throw invalid('content is not accepted; use native read/write/edit on the returned absolutePath', '/content')
  }
  if (patch.operation === 'create') {
    if (patch.title === undefined || patch.title.trim().length === 0) {
      throw invalid('create requires a non-empty title', '/title')
    }
  }
  if (patch.operation === 'delete' && (patch.title !== undefined || patch.summary !== undefined)) {
    throw invalid('delete does not accept title or summary', '/operation')
  }
  const id = patch.note ?? '00000000-0000-4000-8000-000000000000'
  const directory = 'project-0123456789ab'
  parseIndex({
    ...emptyIndex(),
    projects: [{
      id: 'validation',
      directory,
      notes: [{
        id,
        title: patch.title?.trim() ?? 'DevLead validation',
        summary: patch.summary ?? '',
        updatedAt: EMPTY_TIMESTAMP,
        bytes: 0,
        path: `${directory}/${id}.md`,
      }],
    }],
  })
}

/**
 * Generate a readable lowercase directory plus a stable project-id digest.
 * The digest makes ids that sanitize to the same text collision-safe; an
 * extraordinarily unlikely short-digest collision falls back to the full hash.
 */
function projectDirectory(projectId: string, index: DevLeadNotesIndex): string {
  const existing = index.projects.find(project => project.id === projectId)
  if (existing !== undefined) return existing.directory
  const hash = createHash('sha256').update(projectId, 'utf8').digest('hex')
  const normalized = projectId.normalize('NFKD').toLowerCase()
  let base = normalized.replaceAll(/[^a-z0-9._-]+/gu, '-').replaceAll(/^[._-]+|[._-]+$/gu, '')
  base = base.slice(0, 48).replaceAll(/[._-]+$/gu, '')
  if (base.length === 0) base = 'project'
  const short = `${base}-${hash.slice(0, 12)}`
  const collision = index.projects.some(project => project.directory === short && project.id !== projectId)
  return collision ? `${base}-${hash}` : short
}

function noteFilePath(root: string, project: DevLeadNotesProject, note: DevLeadNoteMetadata): string {
  // The shared schema has already proved exactly `<directory>/<id>.md` with two
  // safe POSIX segments. Resolve each segment explicitly; never consume a path
  // argument from a tool caller.
  return join(root, project.directory, `${note.id}.md`)
}

/**
 * File-backed notes store paired with one board store/path lifecycle.
 * Construction fixes the root; `start`, `close`, and all writes are serialized
 * just like the owning board, while `summaryIndex` is synchronous cache-only.
 */
export class DevLeadBoardNotesStore {
  private readonly rootPath: string | undefined
  private readonly filePath: string | undefined
  private cache: DevLeadNotesIndex | undefined
  private lastError: DevLeadBoardError | undefined
  private writeTail: Promise<unknown> = Promise.resolve()

  constructor(
    boardPath: string | undefined,
    private readonly board: DevLeadBoardStore,
    private readonly logger: NotesLogger = { warn: () => undefined },
    private readonly now: () => number = Date.now,
    private readonly randomUUID: () => string = cryptoRandomUUID,
  ) {
    const trimmed = boardPath?.trim() ?? ''
    if (trimmed.length > 0 && !isAbsolute(trimmed)) {
      throw invalid('boardPath must be an absolute path', '/boardPath')
    }
    this.rootPath = trimmed.length === 0 ? undefined : join(dirname(trimmed), DEVLEAD_NOTES_DIR_NAME)
    this.filePath = this.rootPath === undefined ? undefined : join(this.rootPath, DEVLEAD_NOTES_INDEX_FILE_NAME)
  }

  /** Absolute notes root, or undefined while the owning board is disabled. */
  get path(): string | undefined {
    return this.rootPath
  }

  /** Absolute notes-index path, exposed for diagnostics/tests, never accepted as input. */
  get indexPath(): string | undefined {
    return this.filePath
  }

  get enabled(): boolean {
    return this.rootPath !== undefined
  }

  /** Prepare the root and populate the cache; a malformed index degrades reads, not service activation. */
  async start(): Promise<void> {
    if (this.rootPath === undefined) return
    const root = this.rootPath
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw ioError('prepare notes root', root, error)
    }
    await this.refresh()
  }

  /** Settle queued writes. No watcher or timer remains owned by this store. */
  async close(): Promise<void> {
    await this.writeTail
  }

  /** Last valid cached index for the synchronous board-summary renderer. */
  summaryIndex(): DevLeadNotesIndex | undefined {
    return this.cache
  }

  private requireRoot(): string {
    if (this.rootPath === undefined) {
      throw new DevLeadBoardError('DevLead board notes are disabled; activate a lead board first', 'BOARD_DISABLED')
    }
    return this.rootPath
  }

  private requireIndexPath(): string {
    this.requireRoot()
    if (this.filePath === undefined) throw new DevLeadBoardError('DevLead board notes are disabled', 'BOARD_DISABLED')
    return this.filePath
  }

  private async refresh(): Promise<void> {
    const filePath = this.requireIndexPath()
    try {
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
        const before = await stat(filePath)
        if (before.size > DEVLEAD_NOTES_INDEX_MAX_BYTES) {
          this.lastError = limit(
            `notes index exceeds ${DEVLEAD_NOTES_INDEX_MAX_BYTES} bytes (${before.size})`,
            '',
          )
          return
        }
        const bytes = await readFile(filePath)
        const after = await stat(filePath)
        if (!sameFingerprint({ mtimeMs: before.mtimeMs, size: before.size, ino: before.ino }, {
          mtimeMs: after.mtimeMs, size: after.size, ino: after.ino,
        }) || bytes.length !== after.size) continue
        let value: unknown
        try {
          value = JSON.parse(decodeUtf8(bytes, 'notes index'))
        } catch (error) {
          this.lastError = isDevLeadBoardError(error)
            ? error
            : new DevLeadBoardError(
              `notes index is not valid JSON: ${errorMessage(error)}`,
              'BOARD_INVALID',
              [{ pointer: '', message: errorMessage(error) }],
            )
          return
        }
        try {
          this.cache = parseIndex(value)
        } catch (error) {
          this.lastError = isDevLeadBoardError(error)
            ? error
            : new DevLeadBoardError(errorMessage(error), 'BOARD_INVALID')
          return
        }
        this.lastError = undefined
        return
      }
      this.lastError = ioError('read stable notes index', filePath, new Error('file changed repeatedly; retry'))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.cache = emptyIndex()
        this.lastError = undefined
        return
      }
      if (isDevLeadBoardError(error)) {
        this.lastError = error
        return
      }
      this.lastError = ioError('read notes index', filePath, error)
    }
  }

  private async current(): Promise<DevLeadNotesIndex> {
    await this.refresh()
    if (this.lastError !== undefined) throw this.lastError
    return this.cache ?? emptyIndex()
  }

  /** Read one project's metadata list or one selected metadata row, never its body. */
  async read(filter: DevLeadBoardNoteReadFilter): Promise<DevLeadBoardNoteReadResult> {
    this.requireRoot()
    const operation = this.writeTail.then(() => this.readReconciled(filter))
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  /**
   * Native Markdown edits bypass this store, so every model read/list lazily
   * reconciles the selected file snapshots. One locked transaction validates
   * all selected bodies before committing any metadata repair; an invalid or
   * missing body therefore leaves the previous index untouched.
   */
  private async readReconciled(filter: DevLeadBoardNoteReadFilter): Promise<DevLeadBoardNoteReadResult> {
    const root = this.requireRoot()
    const filePath = this.requireIndexPath()
    try {
      const boardProject = await this.board.resolveProject(filter.project)
      return await withFileLock(filePath, async () => {
        const current = await this.current()
        const currentProject = current.projects.find(candidate => candidate.id === boardProject.id)
        let selected: readonly DevLeadNoteMetadata[] = currentProject?.notes ?? []
        if (filter.note !== undefined) {
          const metadata = currentProject?.notes.find(note => note.id === filter.note)
          if (currentProject === undefined || metadata === undefined) {
            throw new DevLeadBoardError(`note "${filter.note}" was not found`, 'BOARD_NOTE_NOT_FOUND')
          }
          selected = [metadata]
        }
        const snapshots = new Map<string, ExistingNoteSnapshot>()
        if (currentProject !== undefined) {
          for (const metadata of selected) snapshots.set(metadata.id, await this.statBody(currentProject, metadata))
        }
        let index = current
        if (currentProject !== undefined && selected.some(metadata => {
          const snapshot = snapshots.get(metadata.id)!
          return metadata.bytes !== snapshot.size || metadata.updatedAt !== snapshot.updatedAt
        })) {
          const next = structuredClone(current)
          const project = next.projects.find(candidate => candidate.id === boardProject.id)!
          for (const metadata of project.notes) {
            const snapshot = snapshots.get(metadata.id)
            if (snapshot === undefined) continue
            metadata.bytes = snapshot.size
            metadata.updatedAt = snapshot.updatedAt
          }
          next.revision = current.revision + 1
          next.updatedAt = new Date(this.now()).toISOString()
          index = this.validateNext(next)
          await this.commitIndex(filePath, index)
        }
        const project = index.projects.find(candidate => candidate.id === boardProject.id)
        const view = { id: boardProject.id, directory: projectDirectory(boardProject.id, index) }
        if (filter.note === undefined) {
          return {
            revision: index.revision,
            updatedAt: index.updatedAt,
            project: view,
            notes: (project?.notes ?? []).map(metadata => this.publicMetadata(root, project!, metadata)),
          }
        }
        const metadata = project!.notes.find(note => note.id === filter.note)!
        return {
          revision: index.revision,
          updatedAt: index.updatedAt,
          project: view,
          note: this.publicMetadata(root, project!, metadata),
        }
      })
    } catch (error) {
      if (isDevLeadBoardError(error)) throw error
      if (isWriteIoError(error)) throw ioError('read notes', filePath, error)
      throw error
    }
  }

  private publicMetadata(
    root: string,
    project: DevLeadNotesProject,
    metadata: DevLeadNoteMetadata,
  ): DevLeadBoardNoteMetadata {
    return { ...structuredClone(metadata), absolutePath: noteFilePath(root, project, metadata) }
  }

  /** Serialize Host calls, then use the index file's cross-process writer lock for each mutation. */
  async write(patch: DevLeadBoardNoteWrite, signal?: AbortSignal): Promise<DevLeadBoardNoteWriteResult> {
    this.requireRoot()
    validateWriteShape(patch)
    signal?.throwIfAborted()
    const operation = this.writeTail.then(() => this.writeLocked(patch, signal))
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  private async writeLocked(
    patch: DevLeadBoardNoteWrite,
    signal: AbortSignal | undefined,
  ): Promise<DevLeadBoardNoteWriteResult> {
    const root = this.requireRoot()
    const filePath = this.requireIndexPath()
    try {
      const boardProject = await this.board.resolveProject(patch.project)
      await mkdir(root, { recursive: true, mode: 0o700 })
      return await withFileLock(filePath, async () => {
        signal?.throwIfAborted()
        const current = await this.current()
        if (patch.expectedRevision !== undefined && current.revision !== patch.expectedRevision) {
          throw new DevLeadBoardError(
            `notes index revision conflict: expected r${patch.expectedRevision}, current r${current.revision}`,
            'BOARD_REVISION_CONFLICT',
            [{ pointer: '/revision', message: `expected ${patch.expectedRevision}, current ${current.revision}` }],
          )
        }
        const timestamp = new Date(this.now()).toISOString()
        const next = structuredClone(current)
        let project = next.projects.find(candidate => candidate.id === boardProject.id)
        if (patch.operation === 'create') {
          if (project === undefined) {
            project = { id: boardProject.id, directory: projectDirectory(boardProject.id, next), notes: [] }
            next.projects.push(project)
          }
          return await this.createNote(root, filePath, current, next, project, patch, timestamp)
        }
        if (project === undefined) throw new DevLeadBoardError(`note "${patch.note ?? ''}" was not found`, 'BOARD_NOTE_NOT_FOUND')
        const metadata = project.notes.find(note => note.id === patch.note)
        if (metadata === undefined) {
          throw new DevLeadBoardError(`note "${patch.note ?? ''}" was not found`, 'BOARD_NOTE_NOT_FOUND')
        }
        // Index lifecycle and metadata are independent from the body. Deletion
        // can repair a missing body, and native Markdown edits never enter CAS.
        if (patch.operation === 'delete') {
          return await this.deleteNote(root, filePath, current, next, project, metadata, timestamp)
        }
        return await this.changeMetadata(root, filePath, current, next, project, metadata, patch)
      }, signal === undefined ? {} : { signal })
    } catch (error) {
      if (isDevLeadBoardError(error)) throw error
      if (isWriteIoError(error)) throw ioError('write notes', filePath, error)
      throw error
    }
  }

  private async createNote(
    root: string,
    filePath: string,
    current: DevLeadNotesIndex,
    next: DevLeadNotesIndex,
    project: DevLeadNotesProject,
    patch: DevLeadBoardNoteWrite,
    timestamp: string,
  ): Promise<DevLeadBoardNoteWriteResult> {
    let id = patch.note
    if (id === undefined) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const candidate = this.randomUUID()
        if (!project.notes.some(note => note.id === candidate)) {
          id = candidate
          break
        }
      }
      if (id === undefined) throw invalid('could not allocate a unique note id', '/note')
      // A custom UUID source still has to satisfy the same safe-id contract.
      parseIndex({
        ...emptyIndex(),
        projects: [{ id: 'validation', directory: project.directory, notes: [{
          id, title: 'validation', summary: '', updatedAt: EMPTY_TIMESTAMP, bytes: 0,
          path: `${project.directory}/${id}.md`,
        }] }],
      })
    }
    if (project.notes.some(note => note.id === id)) {
      throw invalid(`note "${id}" already exists in project "${project.id}"`, '/note')
    }
    if (project.notes.length >= DEVLEAD_NOTES_MAX_PER_PROJECT) {
      throw limit(`project "${project.id}" already has ${DEVLEAD_NOTES_MAX_PER_PROJECT} notes`, '/notes')
    }
    const content = ''
    const metadata: DevLeadNoteMetadata = {
      id,
      title: patch.title!.trim(),
      summary: patch.summary ?? '',
      updatedAt: timestamp,
      bytes: 0,
      path: `${project.directory}/${id}.md`,
    }
    project.notes.push(metadata)
    next.revision = current.revision + 1
    next.updatedAt = timestamp
    const validated = this.validateNext(next)
    const validatedProject = validated.projects.find(candidate => candidate.id === project.id)!
    const validatedNote = validatedProject.notes.find(note => note.id === id)!
    await this.writeBodyAndCommit(root, filePath, validatedProject, validatedNote, content, undefined, validated)
    return {
      revision: validated.revision,
      updatedAt: validated.updatedAt,
      project: { id: project.id, directory: project.directory },
      note: this.publicMetadata(root, validatedProject, validatedNote),
      operation: 'create',
      changed: true,
    }
  }

  private async changeMetadata(
    root: string,
    filePath: string,
    current: DevLeadNotesIndex,
    next: DevLeadNotesIndex,
    project: DevLeadNotesProject,
    metadata: DevLeadNoteMetadata,
    patch: DevLeadBoardNoteWrite,
  ): Promise<DevLeadBoardNoteWriteResult> {
    const title = patch.title === undefined ? metadata.title : patch.title.trim()
    if (title.length === 0) throw invalid('title must not be empty', '/title')
    const summary = patch.summary ?? metadata.summary
    const changed = title !== metadata.title || summary !== metadata.summary
    if (!changed) {
      return {
        revision: current.revision,
        updatedAt: current.updatedAt,
        project: { id: project.id, directory: project.directory },
        note: this.publicMetadata(root, project, metadata),
        operation: patch.operation,
        changed: false,
      }
    }
    Object.assign(metadata, { title, summary })
    next.revision = current.revision + 1
    next.updatedAt = new Date(this.now()).toISOString()
    const validated = this.validateNext(next)
    const validatedProject = validated.projects.find(candidate => candidate.id === project.id)!
    const validatedNote = validatedProject.notes.find(note => note.id === metadata.id)!
    await this.commitIndex(filePath, validated)
    return {
      revision: validated.revision,
      updatedAt: validated.updatedAt,
      project: { id: project.id, directory: project.directory },
      note: this.publicMetadata(root, validatedProject, validatedNote),
      operation: patch.operation,
      changed: true,
    }
  }

  private async deleteNote(
    root: string,
    filePath: string,
    current: DevLeadNotesIndex,
    next: DevLeadNotesIndex,
    project: DevLeadNotesProject,
    metadata: DevLeadNoteMetadata,
    timestamp: string,
  ): Promise<DevLeadBoardNoteWriteResult> {
    project.notes = project.notes.filter(note => note.id !== metadata.id)
    if (project.notes.length === 0) next.projects = next.projects.filter(candidate => candidate.id !== project.id)
    next.revision = current.revision + 1
    next.updatedAt = timestamp
    const validated = this.validateNext(next)
    await this.commitIndex(filePath, validated)
    // The committed index no longer references the body. Cleanup is deliberately
    // best effort: an undeletable leftover is an ignored orphan, never a reason
    // to roll back a durable deletion or leave index metadata behind.
    try {
      await rm(noteFilePath(root, project, metadata), { force: true })
    } catch (error) {
      this.logger.warn(`devlead: deleted note ${metadata.id} from the index but could not remove its orphan body: ${errorMessage(error)}`)
    }
    return {
      revision: validated.revision,
      updatedAt: validated.updatedAt,
      project: { id: project.id, directory: project.directory },
      note: this.publicMetadata(root, project, metadata),
      operation: 'delete',
      changed: true,
      deleted: true,
    }
  }

  private validateNext(next: DevLeadNotesIndex): DevLeadNotesIndex {
    const validated = parseIndex(next)
    const content = `${JSON.stringify(validated, null, 2)}\n`
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > DEVLEAD_NOTES_INDEX_MAX_BYTES) {
      throw limit(`notes index update would exceed ${DEVLEAD_NOTES_INDEX_MAX_BYTES} bytes (${bytes})`, '')
    }
    return validated
  }

  private async writeBodyAndCommit(
    root: string,
    filePath: string,
    project: DevLeadNotesProject,
    metadata: DevLeadNoteMetadata,
    content: string,
    previous: Buffer | undefined,
    validated: DevLeadNotesIndex,
  ): Promise<void> {
    const bodyPath = noteFilePath(root, project, metadata)
    await mkdir(dirname(bodyPath), { recursive: true, mode: 0o700 })
    await writeFileAtomic(bodyPath, content, { mode: 0o600, dirMode: 0o700 })
    try {
      await this.commitIndex(filePath, validated)
    } catch (error) {
      try {
        if (previous === undefined) await rm(bodyPath, { force: true })
        else await writeFileAtomic(bodyPath, previous, { mode: 0o600, dirMode: 0o700 })
      } catch (rollbackError) {
        this.logger.warn(
          `devlead: notes index commit failed and body rollback also failed for ${metadata.id}: ${errorMessage(rollbackError)}`,
        )
      }
      throw error
    }
  }

  private async commitIndex(filePath: string, validated: DevLeadNotesIndex): Promise<void> {
    await writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    // Once the atomic index replacement returns, the new index is the commit
    // fact. Do not perform a fallible stat here: a later error must never make
    // the caller roll a new body back underneath an already-committed index.
    this.cache = validated
    this.lastError = undefined
  }

  /** Stat a stable native-edited body without reading or decoding its Markdown. */
  private async statBody(project: DevLeadNotesProject, metadata: DevLeadNoteMetadata): Promise<ExistingNoteSnapshot> {
    const root = this.requireRoot()
    const path = noteFilePath(root, project, metadata)
    try {
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
        const before = await stat(path)
        if (before.size > DEVLEAD_NOTES_NOTE_MAX_BYTES) {
          throw limit(`note "${metadata.id}" exceeds ${DEVLEAD_NOTES_NOTE_MAX_BYTES} bytes (${before.size})`, '/note')
        }
        const after = await stat(path)
        if (!sameFingerprint(before, after)) continue
        return { size: after.size, updatedAt: after.mtime.toISOString() }
      }
      throw ioError('stat stable note', path, new Error('file changed repeatedly; retry'))
    } catch (error) {
      if (isDevLeadBoardError(error)) throw error
      if (errorCode(error) === 'ENOENT') {
        throw new DevLeadBoardError(
          `note "${metadata.id}" is indexed but its Markdown body is missing`,
          'BOARD_NOTE_NOT_FOUND',
        )
      }
      if (isWriteIoError(error)) throw ioError('stat note', path, error)
      throw error
    }
  }
}
