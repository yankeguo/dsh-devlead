/**
 * File-backed, lead-writable project board.
 *
 * The configured file is the only durable authority. Every mutation re-reads
 * it under the cross-process writer lock, validates the complete next value,
 * and atomically replaces it. A malformed external edit never replaces the
 * last valid in-memory snapshot and is never overwritten by a mutation.
 *
 * @module @yankeguo/dsh-devlead
 */

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  createDevLeadBoardSchema,
  devLeadBoardIssueViews,
  DEVLEAD_BOARD_DIR_SEGMENTS,
  DEVLEAD_BOARD_FILE_NAME,
  DEVLEAD_BOARD_ID_MAX,
  DEVLEAD_BOARD_MAX_BLOCKERS,
  DEVLEAD_BOARD_MAX_BYTES,
  DEVLEAD_BOARD_MAX_PROJECTS,
  DEVLEAD_BOARD_MAX_TASKS,
  DEVLEAD_BOARD_PATH_MAX,
  DEVLEAD_BOARD_READ_MAX_BYTES,
  DEVLEAD_BOARD_SCHEMA_VERSION,
  DEVLEAD_BOARD_TEXT_MAX,
  DEVLEAD_BOARD_TITLE_MAX,
  type DevLeadBoard,
  type DevLeadBoardBlocker,
  type DevLeadBoardIssue,
  type DevLeadBoardPriority,
  type DevLeadBoardProject,
  type DevLeadBoardProjectStatus,
  type DevLeadBoardTask,
  type DevLeadBoardTaskStatus,
  type DevLeadBoardUpdatedBy,
  type DevLeadNotesIndex,
} from '@yankeguo/dsh-devlead-protocol'
import type { ZodIssue } from 'zod'

// The durable schema, its limits, and its duplicate/absolute-path rules are
// shared with the browser decoder through the protocol package. Re-export them
// so this package's existing surface (and its tests) stay in one place.
export {
  DEVLEAD_BOARD_DIR_SEGMENTS,
  DEVLEAD_BOARD_FILE_NAME,
  DEVLEAD_BOARD_ID_MAX,
  DEVLEAD_BOARD_MAX_BLOCKERS,
  DEVLEAD_BOARD_MAX_BYTES,
  DEVLEAD_BOARD_MAX_PROJECTS,
  DEVLEAD_BOARD_MAX_TASKS,
  DEVLEAD_BOARD_PATH_MAX,
  DEVLEAD_BOARD_READ_MAX_BYTES,
  DEVLEAD_BOARD_SCHEMA_VERSION,
  DEVLEAD_BOARD_TEXT_MAX,
  DEVLEAD_BOARD_TITLE_MAX,
}
export type {
  DevLeadBoard,
  DevLeadBoardBlocker,
  DevLeadBoardIssue,
  DevLeadBoardPriority,
  DevLeadBoardProject,
  DevLeadBoardProjectStatus,
  DevLeadBoardTask,
  DevLeadBoardTaskStatus,
  DevLeadBoardUpdatedBy,
}

/** Maximum UTF-8 bytes in the dynamic board summary. */
export const DEVLEAD_BOARD_SUMMARY_MAX_BYTES = 1_536
/** Maximum task rows returned by one selected-project read. */
export const DEVLEAD_BOARD_READ_MAX_TASKS = 50
/** Maximum attempts to obtain a stable file snapshot during concurrent edits. */
const DEVLEAD_BOARD_READ_ATTEMPTS = 4

/** Stable board failure codes exposed through the AI tools. */
export type DevLeadBoardErrorCode =
  | 'BOARD_DISABLED'
  | 'BOARD_NOT_FOUND'
  | 'BOARD_INVALID'
  | 'BOARD_PROJECT_NOT_FOUND'
  | 'BOARD_PROJECT_AMBIGUOUS'
  | 'BOARD_REVISION_CONFLICT'
  | 'BOARD_NOTE_NOT_FOUND'
  | 'BOARD_LIMIT_EXCEEDED'
  | 'BOARD_IO_ERROR'

/** Structured board failure, including validation pointers where available. */
export class DevLeadBoardError extends Error {
  /**
   * @param message - human-readable failure.
   * @param code - stable tool-facing code.
   * @param issues - path-qualified validation details.
   */
  constructor(
    message: string,
    readonly code: DevLeadBoardErrorCode,
    readonly issues: readonly DevLeadBoardIssue[] = [],
  ) {
    super(message)
    this.name = 'DevLeadBoardError'
  }
}

/** Structural duplicate-module-safe board error check. */
export function isDevLeadBoardError(error: unknown): error is DevLeadBoardError {
  if (error instanceof DevLeadBoardError) return true
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('BOARD_')
}

/**
 * Strict schema of the complete board file, built with this Host's own
 * `node:path.isAbsolute` so the acceptance set matches every writer/reader on
 * this platform. Unknown fields, duplicate ids/paths, bad enums, non-UTC
 * timestamps, and size/count overflows are rejected.
 */
export const devLeadBoardSchema = createDevLeadBoardSchema(isAbsolute)

/** Project fields accepted by one update. */
export interface DevLeadBoardSetPatch {
  readonly status?: DevLeadBoardProjectStatus
  readonly priority?: DevLeadBoardPriority
  readonly goal?: string
  readonly focus?: string
  readonly next?: string
  readonly workspace?: {
    readonly path?: string
    readonly title?: string
  }
}

/** Blocker insertion accepted by one update; `since` is assigned by the Host. */
export interface DevLeadBoardBlockerAdd {
  readonly id: string
  readonly text: string
  readonly sessionId?: string
}

/** Task upsert accepted by one update; timestamps are assigned by the Host. */
export interface DevLeadBoardTaskUpsert {
  readonly id: string
  readonly title?: string
  readonly status?: DevLeadBoardTaskStatus
  readonly ownerSessionId?: string
}

/** One logical project mutation. No field accepts a board file path. */
export interface DevLeadBoardUpdate {
  readonly project: string
  readonly updatedBy: DevLeadBoardUpdatedBy
  readonly create?: boolean
  readonly set?: DevLeadBoardSetPatch
  readonly blockers?: {
    readonly add?: readonly DevLeadBoardBlockerAdd[]
    readonly remove?: readonly string[]
    readonly clear?: boolean
  }
  readonly tasks?: {
    readonly upsert?: readonly DevLeadBoardTaskUpsert[]
    readonly remove?: readonly string[]
  }
}

/** Read filtering shared by the service and read tool. */
export interface DevLeadBoardReadFilter {
  /** Exact project id, exact workspace title, or exact absolute workspace path. */
  readonly project?: string
  /** Include tasks; defaults to true only when `project` selects one project. */
  readonly includeTasks?: boolean
  /** Maximum project rows for an unfiltered listing (capped at 50). */
  readonly limit?: number
}

/** Project read shape; tasks are omitted unless requested. */
export type DevLeadBoardProjectView = Omit<DevLeadBoardProject, 'tasks'> & {
  tasks?: DevLeadBoardTask[]
}

/** Bounded board read result. */
export interface DevLeadBoardReadResult {
  readonly revision: number
  readonly updatedAt: string
  readonly projects: DevLeadBoardProjectView[]
  readonly truncated?: boolean
}

/** Result of one committed or no-op project update. */
export interface DevLeadBoardUpdateResult {
  readonly revision: number
  readonly updatedAt: string
  readonly project: DevLeadBoardProjectView
  readonly changed: string[]
}

interface BoardLogger {
  warn(message: string): void
}

interface FileFingerprint {
  readonly mtimeMs: number
  readonly size: number
  readonly ino: number
}

function sameFingerprint(left: FileFingerprint | undefined, right: FileFingerprint): boolean {
  return left !== undefined && left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino
}

function validationError(error: { issues: readonly ZodIssue[] }): DevLeadBoardError {
  const issues = devLeadBoardIssueViews(error.issues)
  const limited = error.issues.some(issue => issue.code === 'too_big')
  const code: DevLeadBoardErrorCode = limited ? 'BOARD_LIMIT_EXCEEDED' : 'BOARD_INVALID'
  const first = issues[0]
  return new DevLeadBoardError(
    `board validation failed${first === undefined ? '' : ` at ${first.pointer || '/'}: ${first.message}`}`,
    code,
    issues,
  )
}

interface BoardMigration {
  readonly value: unknown
  readonly migrated: boolean
}

/** Backfill additive project revisions without changing the file-level revision. */
function migrateProjectRevisions(value: unknown): BoardMigration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value, migrated: false }
  const record = value as { revision?: unknown; projects?: unknown }
  if (typeof record.revision !== 'number' || !Array.isArray(record.projects)) return { value, migrated: false }
  let migrated = false
  const projects = record.projects.map(project => {
    if (typeof project !== 'object' || project === null || Array.isArray(project)) return project
    if ('revision' in project) return project
    migrated = true
    return { ...project, revision: record.revision }
  })
  return { value: migrated ? { ...record, projects } : value, migrated }
}

function parseBoard(value: unknown): DevLeadBoard {
  const parsed = devLeadBoardSchema.safeParse(migrateProjectRevisions(value).value)
  if (!parsed.success) throw validationError(parsed.error)
  return parsed.data
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const FILESYSTEM_ERROR_CODES = new Set([
  'EACCES', 'EAGAIN', 'EBUSY', 'EDQUOT', 'EEXIST', 'EFBIG', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE',
  'ENAMETOOLONG', 'ENFILE', 'ENOMEM', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EROFS',
  'ETXTBSY',
])

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

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

function writeIoError(filePath: string, error: unknown): DevLeadBoardError {
  const retry = isWriterLockTimeout(error)
  return new DevLeadBoardError(
    `could not write board ${filePath}: ${errorMessage(error)}${retry ? '; retry after the current writer finishes' : ''}`,
    'BOARD_IO_ERROR',
  )
}

function normalizeUpdatedBy(updatedBy: DevLeadBoardUpdatedBy): DevLeadBoardUpdatedBy {
  const title = updatedBy.title.trim().slice(0, DEVLEAD_BOARD_TITLE_MAX)
  return { sessionId: updatedBy.sessionId, title: title.length === 0 ? 'DevLead' : title }
}

/** Default directory containing the board file and notes root. */
export const DEVLEAD_DEFAULT_STATE_PATH = DEVLEAD_BOARD_DIR_SEGMENTS.join('/')

/** Where one resolved state directory came from. */
export type DevLeadStatePathSource = 'override' | 'workspace'

/** Why automatic state-directory resolution disabled the board. */
export type DevLeadStatePathDisabledReason = 'no-workspace' | 'relative-workspace' | 'invalid-override'

/**
 * Why the Host currently exposes no board store.
 *
 * `missing-workspace` is decided by the service, not by
 * {@link resolveDevLeadStateDir}: the state directory is only used while the
 * lead's recorded original workspace root still exists as a directory. The
 * store then stays disabled without creating anything, so a cold lead whose
 * workspace was deleted or moved cannot make the Host recreate it.
 */
export type DevLeadBoardDisabledReason = DevLeadStatePathDisabledReason | 'missing-workspace'

/** One automatic state-directory resolution outcome. */
export type DevLeadStateDirResolution =
  | { readonly kind: 'resolved'; readonly path: string; readonly source: DevLeadStatePathSource }
  | { readonly kind: 'disabled'; readonly reason: DevLeadStatePathDisabledReason }

/** A lexical absolute root used only to prove that statePath cannot escape its future workspace. */
const STATE_PATH_VALIDATION_ROOT = '/__devlead_lead_workspace__'

/**
 * Return the actionable configuration error for one state directory.
 *
 * The grammar is platform-independent: forward slashes are mandatory, POSIX
 * and Windows absolute forms are forbidden, and lexical `..` escapes fail even
 * though no lead workspace is available at Loader-validation time.
 */
export function devLeadStatePathError(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return 'statePath must be a non-empty relative directory; omit it to use the default ".dsh/devlead"'
  }
  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed) || /^[A-Za-z]:/u.test(trimmed)) {
    return 'statePath must be a relative directory in the lead workspace; absolute POSIX paths, Windows drive paths, '
      + 'and UNC paths are not supported. Use a relative directory such as ".dsh/devlead"'
  }
  if (trimmed.includes('\\')) {
    return 'statePath must be a relative directory using forward slashes; backslashes are not supported'
  }
  if (trimmed.split('/').some(segment => segment.length === 0)) {
    return 'statePath must be a relative directory and must not contain empty path segments'
  }
  const escaped = posix.relative(
    STATE_PATH_VALIDATION_ROOT,
    posix.resolve(STATE_PATH_VALIDATION_ROOT, trimmed),
  )
  if (escaped === '..' || escaped.startsWith('../') || posix.isAbsolute(escaped)) {
    return 'statePath must stay within the lead workspace; ".." path escapes are not supported'
  }
  return undefined
}

/** Fail fast with the established structured board-validation error. */
export function assertValidDevLeadStatePath(value: string): void {
  const message = devLeadStatePathError(value)
  if (message === undefined) return
  throw new DevLeadBoardError(message, 'BOARD_INVALID', [{ pointer: '/statePath', message }])
}

/**
 * Resolve the shared board/notes state directory for one active lead.
 *
 * Deployment `statePath` is resolved against the lead Session's **original**
 * workspace root (`SessionHeader.cwd`), never against the effective/worktree
 * cwd. The default is `<cwd>/.dsh/devlead`. The result is absolute, normalized,
 * and proven to remain beneath the original root. Invalid values throw a
 * structured error rather than silently falling back to the default. A caller
 * with no absolute workspace root gets the disabled outcome instead of a
 * fabricated path. This pure resolver never touches the filesystem; the
 * service additionally verifies that the workspace root still exists as a
 * directory before using it (a missing root yields
 * {@link DevLeadBoardDisabledReason} `missing-workspace` rather than a
 * recreated workspace). The board file is `<path>/board.json`; notes live at
 * `<path>/notes`.
 * @param input - optional deployment state directory and original workspace root.
 * @returns a normalized absolute state directory, or the disabled reason.
 */
export function resolveDevLeadStateDir(
  input: { readonly statePath?: string; readonly cwd?: string } = {},
): DevLeadStateDirResolution {
  const statePath = input.statePath === undefined ? DEVLEAD_DEFAULT_STATE_PATH : input.statePath.trim()
  assertValidDevLeadStatePath(statePath)
  const cwd = input.cwd?.trim() ?? ''
  if (cwd.length === 0) return { kind: 'disabled', reason: 'no-workspace' }
  if (!isAbsolute(cwd)) return { kind: 'disabled', reason: 'relative-workspace' }
  const workspaceRoot = resolve(cwd)
  const path = resolve(workspaceRoot, statePath)
  const within = relative(workspaceRoot, path)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    const message = 'statePath must resolve within the lead workspace; ".." path escapes are not supported'
    throw new DevLeadBoardError(message, 'BOARD_INVALID', [{ pointer: '/statePath', message }])
  }
  return {
    kind: 'resolved',
    path,
    source: statePath === DEVLEAD_DEFAULT_STATE_PATH ? 'workspace' : 'override',
  }
}

/**
 * Keep one bounded read result under {@link DEVLEAD_BOARD_READ_MAX_BYTES}.
 *
 * The durable file is already capped, but one project can carry dozens of long
 * tasks/blockers. Trimming happens from the tail in a fixed order — task rows,
 * then blocker rows, then whole project rows — so a caller always keeps the
 * leading (most relevant) content and the revision metadata. Any trim reports
 * `truncated: true`; only whole rows are removed, so the result stays schema
 * valid. A single project's scalar fields are far below the cap once rows are
 * gone, which guarantees termination.
 */
function boundReadResult(result: DevLeadBoardReadResult): DevLeadBoardReadResult {
  const serializedBytes = (projects: readonly DevLeadBoardProjectView[], truncated: boolean): number =>
    Buffer.byteLength(JSON.stringify({
      revision: result.revision,
      updatedAt: result.updatedAt,
      projects,
      ...truncated ? { truncated: true } : {},
    }), 'utf8')
  if (serializedBytes(result.projects, result.truncated === true) <= DEVLEAD_BOARD_READ_MAX_BYTES) return result

  const projects = result.projects.map(project => structuredClone(project))
  let truncated = true
  for (;;) {
    if (serializedBytes(projects, truncated) <= DEVLEAD_BOARD_READ_MAX_BYTES) break
    let trimmed = false
    for (let index = projects.length - 1; index >= 0 && !trimmed; index -= 1) {
      const tasks = projects[index]?.tasks
      if (tasks !== undefined && tasks.length > 0) {
        projects[index] = { ...projects[index]!, tasks: tasks.slice(0, -1) }
        trimmed = true
      }
    }
    if (trimmed) continue
    for (let index = projects.length - 1; index >= 0 && !trimmed; index -= 1) {
      const project = projects[index]!
      if (project.blockers.length > 0) {
        projects[index] = { ...project, blockers: project.blockers.slice(0, -1) }
        trimmed = true
      }
    }
    if (trimmed) continue
    if (projects.length > 1) {
      projects.pop()
      continue
    }
    // One project with no task/blocker rows left is far below the cap; this is
    // unreachable unless the limits shrink below their current values.
    break
  }
  return {
    revision: result.revision,
    updatedAt: result.updatedAt,
    projects,
    ...truncated ? { truncated: true } : {},
  }
}

/**
 * Synthetic project id used by write preflight.
 *
 * A caller's project reference may be an id, a workspace title, or an absolute
 * workspace path — the latter two are far longer than the 128-unit id limit.
 * Preflight therefore validates the patch's field shapes against this fixed
 * synthetic project instead of feeding the caller's reference to the id schema;
 * existence and ambiguity are decided by the locked apply against the real
 * board.
 */
const DEVLEAD_BOARD_PREFLIGHT_PROJECT_ID = 'devlead-validation'

function singleLine(value: string): string {
  return value.replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ').replaceAll(/\s+/gu, ' ').trim()
}

/** Resolve a board project by exact id, exact workspace path, or unique title. */
export function resolveDevLeadBoardProject(board: DevLeadBoard, reference: string): DevLeadBoardProject {
  const trimmed = reference.trim()
  if (trimmed.length === 0) {
    throw new DevLeadBoardError('project must not be empty', 'BOARD_INVALID', [
      { pointer: '/project', message: 'project must not be empty' },
    ])
  }
  const byId = board.projects.find(project => project.id === trimmed)
  if (byId !== undefined) return byId
  const byPath = board.projects.find(project => project.workspace.path === trimmed)
  if (byPath !== undefined) return byPath
  const titled = board.projects.filter(project => project.workspace.title === trimmed)
  if (titled.length === 1 && titled[0] !== undefined) return titled[0]
  if (titled.length > 1) {
    throw new DevLeadBoardError(
      `project title "${trimmed}" is ambiguous; use its id or workspace path`,
      'BOARD_PROJECT_AMBIGUOUS',
    )
  }
  throw new DevLeadBoardError(`no board project matches "${trimmed}"`, 'BOARD_PROJECT_NOT_FOUND')
}

function emptyBoard(updatedBy: DevLeadBoardUpdatedBy, updatedAt: string): DevLeadBoard {
  return {
    schemaVersion: DEVLEAD_BOARD_SCHEMA_VERSION,
    revision: 0,
    updatedAt,
    updatedBy: structuredClone(updatedBy),
    projects: [],
  }
}

function validateUpdateInput(patch: DevLeadBoardUpdate): DevLeadBoardUpdate {
  const normalized = { ...patch, updatedBy: normalizeUpdatedBy(patch.updatedBy) }
  const timestamp = new Date(0).toISOString()
  const candidate = emptyBoard(normalized.updatedBy, timestamp)
  if (patch.create !== true) {
    const reference = patch.project.trim()
    if (reference.length === 0) resolveDevLeadBoardProject(candidate, reference)
    // Only the locked disk snapshot knows whether an upsert id is new, so seed
    // each id as an existing synthetic row: a status-only upsert of an existing
    // task passes preflight, while the real apply still enforces new-task titles.
    const validationTasks = new Map<string, DevLeadBoardTask>()
    for (const upsert of patch.tasks?.upsert ?? []) {
      if (!validationTasks.has(upsert.id)) {
        validationTasks.set(upsert.id, {
          id: upsert.id,
          title: upsert.title ?? 'DevLead validation',
          status: 'todo',
          updatedAt: timestamp,
        })
      }
    }
    // The reference (id/title/path) is validated against the real board by the
    // locked apply, never here: using it as the synthetic project id would
    // reject a valid long workspace path/title with BOARD_LIMIT_EXCEEDED.
    candidate.projects.push({
      id: DEVLEAD_BOARD_PREFLIGHT_PROJECT_ID,
      revision: 0,
      workspace: { path: '/devlead-validation', title: 'DevLead validation' },
      status: 'active',
      priority: 'medium',
      goal: '',
      focus: '',
      next: '',
      blockers: [],
      tasks: [...validationTasks.values()],
      updatedAt: timestamp,
    })
  }
  applyProjectPatch(
    candidate,
    patch.create === true ? normalized : { ...normalized, project: DEVLEAD_BOARD_PREFLIGHT_PROJECT_ID },
    timestamp,
  )
  parseBoard(candidate)
  return normalized
}

function validateMissingFileUpdate(patch: DevLeadBoardUpdate, expectedRevision: number | undefined): void {
  const timestamp = new Date(0).toISOString()
  const current = emptyBoard(patch.updatedBy, timestamp)
  if (expectedRevision !== undefined && expectedRevision !== 0) {
    throw new DevLeadBoardError(
      `board revision conflict: expected r${expectedRevision}, current r0`,
      'BOARD_REVISION_CONFLICT',
      [{ pointer: '/revision', message: `expected ${expectedRevision}, current 0` }],
    )
  }
  const next = structuredClone(current)
  applyProjectPatch(next, patch, timestamp)
  next.revision = 1
  next.updatedAt = timestamp
  next.updatedBy = structuredClone(patch.updatedBy)
  parseBoard(next)
}

function projectView(project: DevLeadBoardProject, includeTasks: boolean): DevLeadBoardProjectView {
  const view = structuredClone(project) as DevLeadBoardProjectView
  if (includeTasks) view.tasks = (view.tasks ?? []).slice(0, DEVLEAD_BOARD_READ_MAX_TASKS)
  else delete view.tasks
  return view
}

function appendUtf8(target: { text: string; bytes: number }, addition: string, maximum: number): boolean {
  const bytes = Buffer.byteLength(addition, 'utf8')
  if (target.bytes + bytes > maximum) return false
  target.text += addition
  target.bytes += bytes
  return true
}

/** Render a valid cached board and notes cache into the bounded dynamic-context summary. */
export function renderDevLeadBoardSummary(
  board: DevLeadBoard | undefined,
  notes?: DevLeadNotesIndex,
): string {
  if (board === undefined || board.projects.length === 0) return ''
  const counts: Record<DevLeadBoardProjectStatus, number> = { active: 0, blocked: 0, paused: 0, done: 0 }
  for (const project of board.projects) counts[project.status] += 1
  const lines = [
    `DevLead board r${board.revision} ${board.updatedAt}; projects ${board.projects.length}: `
    + `active ${counts.active}, blocked ${counts.blocked}, paused ${counts.paused}, done ${counts.done}`,
  ]
  for (const project of board.projects) {
    const focus = Array.from(singleLine(project.focus)).slice(0, 120).join('')
    const projectNotes = project.status === 'active'
      ? notes?.projects.find(candidate => candidate.id === project.id)?.notes
      : undefined
    const latest = projectNotes?.reduce<DevLeadNotesIndex['projects'][number]['notes'][number] | undefined>(
      (current, note) => current === undefined || note.updatedAt > current.updatedAt ? note : current,
      undefined,
    )
    const latestTitle = latest === undefined
      ? ''
      : Array.from(singleLine(latest.title)).slice(0, 80).join('')
    lines.push(
      `- ${singleLine(project.id)}/${singleLine(project.workspace.title)} [${project.status}/${project.priority}]`
      + `${focus.length === 0 ? '' : ` focus: ${focus}`}`
      + `${project.blockers.length === 0 ? '' : ` !blockers:${project.blockers.length}`}`
      + `${projectNotes === undefined || projectNotes.length === 0 ? '' : ` notes:${projectNotes.length}`}`
      + `${latestTitle.length === 0 ? '' : ` latest:"${latestTitle}"`}`,
    )
  }
  const output = { text: '', bytes: 0 }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!appendUtf8(output, `${index === 0 ? '' : '\n'}${line}`, DEVLEAD_BOARD_SUMMARY_MAX_BYTES)) {
      appendUtf8(output, '\n…', DEVLEAD_BOARD_SUMMARY_MAX_BYTES)
      break
    }
  }
  return output.text
}

/** Refuse a symlinked final component; an atomic rename would replace the link rather than its target. */
async function assertFinalComponentNotSymlink(filePath: string): Promise<void> {
  try {
    const entry = await lstat(filePath)
    if (!entry.isSymbolicLink()) return
    const message = `board final path component must not be a symlink: ${filePath}`
    throw new DevLeadBoardError(message, 'BOARD_INVALID', [{ pointer: '/statePath', message }])
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
}

/**
 * Host-owned board store. Construction validates the configured absolute path
 * once; callers can never redirect an individual operation to another file.
 */
export class DevLeadBoardStore {
  private readonly filePath: string | undefined
  private cache: DevLeadBoard | undefined
  private fingerprint: FileFingerprint | undefined
  private lastError: DevLeadBoardError | undefined
  private dirty = true
  private loading: Promise<void> | undefined
  private writeTail: Promise<unknown> = Promise.resolve()
  private watcher: FSWatcher | undefined
  private closed = false
  /** Non-zero only inside this store's board writer lock; legacy migration must not reacquire it. */
  private lockDepth = 0
  /** Whether the latest unlocked snapshot still needs its additive revision migration persisted. */
  private legacyMigrationPending = false

  /**
   * @param filePath - absolute board file derived from the state directory; blank/undefined disables the board.
   * @param logger - Host logger for best-effort watcher failures.
   * @param now - injectable clock used by tests.
   */
  constructor(
    filePath: string | undefined,
    private readonly logger: BoardLogger = { warn: () => undefined },
    private readonly now: () => number = Date.now,
  ) {
    const trimmed = filePath?.trim() ?? ''
    if (trimmed.length > 0 && !isAbsolute(trimmed)) {
      const message = 'board file path must be absolute after statePath resolution'
      throw new DevLeadBoardError(message, 'BOARD_INVALID', [{ pointer: '/statePath', message }])
    }
    this.filePath = trimmed.length === 0 ? undefined : trimmed
  }

  /** Absolute configured file path, or undefined when disabled. */
  get path(): string | undefined {
    return this.filePath
  }

  /** Whether board reads/writes are configured. */
  get enabled(): boolean {
    return this.filePath !== undefined
  }

  /**
   * Prepare the watchable parent, then load without rejecting for a malformed
   * file.
   *
   * The service only calls this for a state-derived path whose original
   * workspace root already exists as a directory; a missing workspace root
   * disables the board instead of being recreated here.
   */
  async start(): Promise<void> {
    if (this.filePath === undefined) return
    try {
      // Browser watchers subscribe to the parent before the first Host write.
      // Create it up front so their ready -> add transition is observable.
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      await assertFinalComponentNotSymlink(this.filePath)
    } catch (error) {
      if (isDevLeadBoardError(error)) throw error
      if (isWriteIoError(error)) throw writeIoError(this.filePath, error)
      throw error
    }
    await this.refresh(true)
    this.startWatcher()
  }

  /** Stop watching and settle already-queued work. */
  async close(): Promise<void> {
    this.closed = true
    this.watcher?.close()
    this.watcher = undefined
    await this.loading
    await this.writeTail
  }

  private requirePath(): string {
    if (this.filePath === undefined) {
      throw new DevLeadBoardError('DevLead board is disabled; activate a lead with an original workspace root', 'BOARD_DISABLED')
    }
    return this.filePath
  }

  private startWatcher(): void {
    const filePath = this.filePath
    if (filePath === undefined || this.watcher !== undefined || this.closed) return
    try {
      this.watcher = watch(dirname(filePath), { persistent: false }, (_event, filename) => {
        if (filename !== null && filename.toString() !== basename(filePath)) return
        this.dirty = true
        void this.refresh()
      })
      this.watcher.on('error', error => {
        this.logger.warn(`devlead: board watcher failed for ${filePath}: ${errorMessage(error)}`)
        this.watcher?.close()
        this.watcher = undefined
      })
    } catch (error) {
      // start() normally prepares the parent; a direct update can also create
      // it. Stat freshness protects reads until a watcher can be installed.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`devlead: could not watch board ${filePath}: ${errorMessage(error)}`)
      }
    }
  }

  private async refresh(force = false): Promise<void> {
    if (this.filePath === undefined) return
    if (this.dirty) force = true
    for (;;) {
      const pending = this.loading
      if (pending !== undefined) {
        await pending
        // A forced caller (notably the locked writer) must own a subsequent
        // fresh read; another caller's in-flight snapshot is never sufficient.
        if (!force) return
        // Another forced waiter may have started first. Await that load rather
        // than overwriting the shared loading handle with a concurrent read.
        continue
      }
      const operation = this.load(force)
      this.loading = operation
      try {
        await operation
        return
      } finally {
        if (this.loading === operation) this.loading = undefined
      }
    }
  }

  private async load(force: boolean): Promise<void> {
    await this.loadSnapshot(force)
    if (!this.legacyMigrationPending || this.lockDepth > 0) return
    const filePath = this.requirePath()
    // A read-side migration is a write too: take the same cross-process lock
    // and re-read beneath it instead of overwriting a concurrent board update.
    await withFileLock(filePath, async () => {
      this.lockDepth += 1
      try {
        await this.loadSnapshot(true)
      } finally {
        this.lockDepth -= 1
      }
    })
  }

  private async loadSnapshot(force: boolean): Promise<void> {
    const filePath = this.requirePath()
    this.dirty = false
    this.legacyMigrationPending = false
    try {
      await assertFinalComponentNotSymlink(filePath)
      for (let attempt = 0; attempt < DEVLEAD_BOARD_READ_ATTEMPTS; attempt += 1) {
        const before = await stat(filePath)
        if (!force && this.cache !== undefined && this.lastError === undefined && sameFingerprint(this.fingerprint, before)) {
          this.startWatcher()
          return
        }
        if (before.size > DEVLEAD_BOARD_MAX_BYTES) {
          this.lastError = new DevLeadBoardError(
            `board file exceeds ${DEVLEAD_BOARD_MAX_BYTES} bytes`,
            'BOARD_LIMIT_EXCEEDED',
            [{ pointer: '', message: `file size ${before.size} exceeds ${DEVLEAD_BOARD_MAX_BYTES} bytes` }],
          )
          return
        }
        const content = await readFile(filePath, 'utf8')
        const after = await stat(filePath)
        if (!sameFingerprint(before, after) || Buffer.byteLength(content, 'utf8') !== after.size) continue
        let value: unknown
        try {
          value = JSON.parse(content)
        } catch (error) {
          this.lastError = new DevLeadBoardError(
            `board file is not valid JSON: ${errorMessage(error)}`,
            'BOARD_INVALID',
            [{ pointer: '', message: errorMessage(error) }],
          )
          return
        }
        let board: DevLeadBoard
        const migration = migrateProjectRevisions(value)
        try {
          board = parseBoard(migration.value)
        } catch (error) {
          this.lastError = error instanceof DevLeadBoardError
            ? error
            : new DevLeadBoardError(errorMessage(error), 'BOARD_INVALID')
          return
        }
        let fingerprint = { mtimeMs: after.mtimeMs, size: after.size, ino: after.ino }
        if (migration.migrated) {
          if (this.lockDepth === 0) {
            // The outer load() will re-read and persist beneath the writer lock.
            this.legacyMigrationPending = true
            return
          }
          const content = `${JSON.stringify(board, null, 2)}\n`
          const bytes = Buffer.byteLength(content, 'utf8')
          if (bytes > DEVLEAD_BOARD_MAX_BYTES) {
            throw new DevLeadBoardError(
              `legacy project-revision migration would exceed ${DEVLEAD_BOARD_MAX_BYTES} bytes (${bytes})`,
              'BOARD_LIMIT_EXCEEDED',
              [{ pointer: '', message: `serialized size ${bytes} exceeds ${DEVLEAD_BOARD_MAX_BYTES} bytes` }],
            )
          }
          await writeFileAtomic(filePath, content, { mode: 0o600, dirMode: 0o700 })
          const written = await stat(filePath)
          fingerprint = { mtimeMs: written.mtimeMs, size: written.size, ino: written.ino }
        }
        this.cache = board
        this.fingerprint = fingerprint
        this.lastError = undefined
        this.startWatcher()
        return
      }
      this.lastError = new DevLeadBoardError(
        `board file changed repeatedly while reading ${filePath}; retry`,
        'BOARD_IO_ERROR',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = undefined
        this.fingerprint = undefined
        this.lastError = new DevLeadBoardError(`board file does not exist: ${filePath}`, 'BOARD_NOT_FOUND')
        return
      }
      if (error instanceof DevLeadBoardError) {
        this.lastError = error
        return
      }
      this.lastError = new DevLeadBoardError(
        `could not read board ${filePath}: ${errorMessage(error)}`,
        'BOARD_IO_ERROR',
      )
    }
  }

  private async current(): Promise<DevLeadBoard> {
    this.requirePath()
    await this.refresh()
    if (this.lastError !== undefined) throw this.lastError
    if (this.cache === undefined) {
      throw new DevLeadBoardError('board has no valid snapshot', 'BOARD_NOT_FOUND')
    }
    return this.cache
  }

  /** Read a detached, optionally filtered board projection. */
  async read(filter: DevLeadBoardReadFilter = {}): Promise<DevLeadBoardReadResult> {
    const board = await this.current()
    const includeTasks = filter.includeTasks ?? filter.project !== undefined
    if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 1)) {
      throw new DevLeadBoardError('limit must be a positive safe integer', 'BOARD_INVALID', [
        { pointer: '/limit', message: 'limit must be a positive safe integer' },
      ])
    }
    let projects: readonly DevLeadBoardProject[]
    let truncated = false
    if (filter.project !== undefined) {
      projects = [resolveDevLeadBoardProject(board, filter.project)]
    } else {
      const limit = Math.min(filter.limit ?? DEVLEAD_BOARD_MAX_PROJECTS, DEVLEAD_BOARD_MAX_PROJECTS)
      projects = board.projects.slice(0, limit)
      truncated = board.projects.length > projects.length
    }
    return boundReadResult({
      revision: board.revision,
      updatedAt: board.updatedAt,
      projects: projects.map(project => {
        if (includeTasks && project.tasks.length > DEVLEAD_BOARD_READ_MAX_TASKS) truncated = true
        return projectView(project, includeTasks)
      }),
      ...truncated ? { truncated: true } : {},
    })
  }

  /** Resolve one id/title/path against the latest valid board snapshot. */
  async resolveProject(reference: string): Promise<DevLeadBoardProject> {
    return structuredClone(resolveDevLeadBoardProject(await this.current(), reference))
  }

  /**
   * Apply one project mutation. Host calls share one promise chain; every call
   * then performs its own locked disk read-modify-write cycle.
   */
  async update(patch: DevLeadBoardUpdate, expectedRevision?: number, signal?: AbortSignal): Promise<DevLeadBoardUpdateResult> {
    this.requirePath()
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new DevLeadBoardError('expectedRevision must be a non-negative safe integer', 'BOARD_INVALID', [
        { pointer: '/expectedRevision', message: 'expectedRevision must be a non-negative safe integer' },
      ])
    }
    signal?.throwIfAborted()
    const operation = this.writeTail.then(() => this.updateLocked(patch, expectedRevision, signal))
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  private async updateLocked(
    input: DevLeadBoardUpdate,
    expectedRevision: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DevLeadBoardUpdateResult> {
    const filePath = this.requirePath()
    try {
      const patch = validateUpdateInput(input)
      try {
        await stat(dirname(filePath))
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
        // The lock needs a parent directory. Validate against the real empty
        // state before creating it so a failed first update leaves no tree.
        validateMissingFileUpdate(patch, expectedRevision)
      }
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      this.startWatcher()
      return await withFileLock(filePath, async () => {
        this.lockDepth += 1
        try {
          signal?.throwIfAborted()
          await this.refresh(true)
          if (this.lastError !== undefined && this.lastError.code !== 'BOARD_NOT_FOUND') throw this.lastError
          const timestamp = new Date(this.now()).toISOString()
          const current = this.cache ?? emptyBoard(patch.updatedBy, timestamp)
          let currentProjectRevision = 0
          try {
            currentProjectRevision = resolveDevLeadBoardProject(current, patch.project).revision
          } catch (error) {
            if (!(error instanceof DevLeadBoardError) || error.code !== 'BOARD_PROJECT_NOT_FOUND' || patch.create !== true) {
              throw error
            }
          }
          if (expectedRevision !== undefined && currentProjectRevision !== expectedRevision) {
            throw new DevLeadBoardError(
              `project revision conflict: expected r${expectedRevision}, current r${currentProjectRevision}`,
              'BOARD_REVISION_CONFLICT',
              [{ pointer: '/revision', message: `expected ${expectedRevision}, current ${currentProjectRevision}` }],
            )
          }
          const next = structuredClone(current)
          const changed = applyProjectPatch(next, patch, timestamp)
          const project = resolveDevLeadBoardProject(next, patch.project)
          if (changed.length === 0) {
            return {
              revision: current.revision,
              updatedAt: current.updatedAt,
              project: projectView(project, false),
              changed,
            }
          }
          next.revision = current.revision + 1
          project.revision = next.revision
          next.updatedAt = timestamp
          next.updatedBy = structuredClone(patch.updatedBy)
          const validated = parseBoard(next)
          const content = `${JSON.stringify(validated, null, 2)}\n`
          const bytes = Buffer.byteLength(content, 'utf8')
          if (bytes > DEVLEAD_BOARD_MAX_BYTES) {
            throw new DevLeadBoardError(
              `board update would exceed ${DEVLEAD_BOARD_MAX_BYTES} bytes (${bytes})`,
              'BOARD_LIMIT_EXCEEDED',
              [{ pointer: '', message: `serialized size ${bytes} exceeds ${DEVLEAD_BOARD_MAX_BYTES} bytes` }],
            )
          }
          await writeFileAtomic(filePath, content, { mode: 0o600, dirMode: 0o700 })
          const written = await stat(filePath)
          this.cache = validated
          this.lastError = undefined
          this.dirty = false
          this.fingerprint = { mtimeMs: written.mtimeMs, size: written.size, ino: written.ino }
          this.startWatcher()
          return {
            revision: validated.revision,
            updatedAt: validated.updatedAt,
            project: projectView(resolveDevLeadBoardProject(validated, project.id), false),
            changed,
          }
        } finally {
          this.lockDepth -= 1
        }
      }, signal === undefined ? {} : { signal })
    } catch (error) {
      if (isDevLeadBoardError(error)) throw error
      if (isWriteIoError(error)) throw writeIoError(filePath, error)
      throw error
    }
  }

  /** Synchronous cache-only text for `systemPrompt.context()`. */
  summary(notes?: DevLeadNotesIndex): string {
    if (this.filePath === undefined) return ''
    return renderDevLeadBoardSummary(this.cache, notes)
  }
}

/** Apply the logical patch to a cloned board, returning precise changed lanes. */
function applyProjectPatch(board: DevLeadBoard, patch: DevLeadBoardUpdate, timestamp: string): string[] {
  const changed: string[] = []
  let project: DevLeadBoardProject
  try {
    project = resolveDevLeadBoardProject(board, patch.project)
  } catch (error) {
    if (!(error instanceof DevLeadBoardError) || error.code !== 'BOARD_PROJECT_NOT_FOUND' || patch.create !== true) throw error
    const workspacePatch = patch.set?.workspace
    const workspacePath = workspacePatch?.path
    if (workspacePath === undefined || workspacePath.trim().length === 0) {
      throw new DevLeadBoardError('creating a project requires set.workspace.path', 'BOARD_INVALID', [
        { pointer: '/set/workspace/path', message: 'required when create is true' },
      ])
    }
    const id = patch.project.trim()
    project = {
      id,
      revision: 0,
      workspace: {
        path: workspacePath,
        title: workspacePatch?.title ?? (basename(workspacePath) || id),
      },
      status: 'active',
      priority: 'medium',
      goal: '',
      focus: '',
      next: '',
      blockers: [],
      tasks: [],
      updatedAt: timestamp,
    }
    board.projects.push(project)
    changed.push('project.create')
  }
  let projectChanged = changed.length > 0
  const set = patch.set
  if (set !== undefined) {
    for (const field of ['status', 'priority', 'goal', 'focus', 'next'] as const) {
      const value = set[field]
      if (value !== undefined && project[field] !== value) {
        Object.assign(project, { [field]: value })
        changed.push(`set.${field}`)
        projectChanged = true
      }
    }
    if (set.workspace !== undefined) {
      for (const field of ['path', 'title'] as const) {
        const value = set.workspace[field]
        if (value !== undefined && project.workspace[field] !== value) {
          project.workspace[field] = value
          changed.push(`set.workspace.${field}`)
          projectChanged = true
        }
      }
    }
  }
  const blockers = patch.blockers
  if (blockers?.clear === true && project.blockers.length > 0) {
    project.blockers = []
    changed.push('blockers.clear')
    projectChanged = true
  }
  if (blockers?.remove !== undefined) {
    const remove = new Set(blockers.remove)
    const retained = project.blockers.filter(blocker => !remove.has(blocker.id))
    if (retained.length !== project.blockers.length) {
      project.blockers = retained
      changed.push('blockers.remove')
      projectChanged = true
    }
  }
  for (const addition of blockers?.add ?? []) {
    const existing = project.blockers.find(blocker => blocker.id === addition.id)
    const sessionId = addition.sessionId ?? existing?.sessionId
    const blocker: DevLeadBoardBlocker = {
      id: addition.id,
      text: addition.text,
      since: existing?.since ?? timestamp,
      ...sessionId === undefined ? {} : { sessionId },
    }
    if (existing === undefined) {
      project.blockers.push(blocker)
      changed.push(`blockers.add:${addition.id}`)
      projectChanged = true
    } else if (existing.text !== blocker.text || existing.sessionId !== blocker.sessionId) {
      Object.assign(existing, blocker)
      changed.push(`blockers.add:${addition.id}`)
      projectChanged = true
    }
  }
  if (patch.tasks?.remove !== undefined) {
    const remove = new Set(patch.tasks.remove)
    const retained = project.tasks.filter(task => !remove.has(task.id))
    if (retained.length !== project.tasks.length) {
      project.tasks = retained
      changed.push('tasks.remove')
      projectChanged = true
    }
  }
  for (const upsert of patch.tasks?.upsert ?? []) {
    const existing = project.tasks.find(task => task.id === upsert.id)
    if (existing === undefined) {
      if (upsert.title === undefined || upsert.title.trim().length === 0) {
        throw new DevLeadBoardError(`new task "${upsert.id}" requires a non-empty title`, 'BOARD_INVALID', [
          { pointer: '/tasks/upsert', message: `new task "${upsert.id}" requires title` },
        ])
      }
      project.tasks.push({
        id: upsert.id,
        title: upsert.title,
        status: upsert.status ?? 'todo',
        ...upsert.ownerSessionId === undefined ? {} : { ownerSessionId: upsert.ownerSessionId },
        updatedAt: timestamp,
      })
      changed.push(`tasks.upsert:${upsert.id}`)
      projectChanged = true
      continue
    }
    let taskChanged = false
    if (upsert.title !== undefined && existing.title !== upsert.title) {
      existing.title = upsert.title
      taskChanged = true
    }
    if (upsert.status !== undefined && existing.status !== upsert.status) {
      existing.status = upsert.status
      taskChanged = true
    }
    if (upsert.ownerSessionId !== undefined && existing.ownerSessionId !== upsert.ownerSessionId) {
      existing.ownerSessionId = upsert.ownerSessionId
      taskChanged = true
    }
    if (taskChanged) {
      existing.updatedAt = timestamp
      changed.push(`tasks.upsert:${upsert.id}`)
      projectChanged = true
    }
  }
  if (projectChanged) project.updatedAt = timestamp
  return changed
}
