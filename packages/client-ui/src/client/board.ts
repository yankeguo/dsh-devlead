/**
 * Browser-owned, read-only projection of the DevLead board schema v1.
 *
 * The Host package deliberately stays out of the browser bundle: it imports
 * Node filesystem modules. The durable wire schema, its limits, and its strict
 * duplicate/absolute-path rules live in the shared protocol package, so the
 * browser decoder and the Host validator cannot drift. This module adds only
 * the browser-owned pieces: the platform-specific absolute-path predicate
 * (chosen from the Host-published `pathPlatform`), the global-config reader,
 * the per-Session path resolver (a board follows the on-screen lead's original
 * workspace root), the UTF-8/size pre-checks, and the pure
 * grouping/sorting/formatting helpers.
 */
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
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
} from '@yankeguo/dsh-devlead-protocol/client'
import type { ZodType } from 'zod'
import { devLeadRowEnabled, type DevLeadRowSummary } from './sessionMark.ts'

// The wire contract and its default-location segments are re-exported so
// existing browser modules and tests keep one import site for board constants,
// types, and decoders.
export {
  DEVLEAD_BOARD_DIR_SEGMENTS,
  DEVLEAD_BOARD_FILE_NAME,
  DEVLEAD_BOARD_ID_MAX,
  DEVLEAD_BOARD_MAX_BLOCKERS,
  DEVLEAD_BOARD_MAX_BYTES,
  DEVLEAD_BOARD_MAX_PROJECTS,
  DEVLEAD_BOARD_MAX_TASKS,
  DEVLEAD_BOARD_PATH_MAX,
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

/** Host global present only while a lead Session owns a board path. */
export const DEVLEAD_BOARD_GLOBAL = '__DSH_DEVLEAD_BOARD__'
/** Right-Sidebar page discriminator passed to `sidebarRight.openTab`. */
export const DEVLEAD_BOARD_TAB_KIND = 'devlead-board'
/** Registration id; keyed Sidebar body slots use this id, not the kind. */
export const DEVLEAD_BOARD_TAB_ID = '@yankeguo/dsh-client-ui-devlead/board'

/** Host path implementation, published explicitly by the Host global. */
export type DevLeadBoardPathPlatform = 'posix' | 'win32'

/** Match exactly the absolute forms accepted by the Host's node:path API. */
function isAbsoluteWorkspacePath(value: string, platform: DevLeadBoardPathPlatform): boolean {
  if (platform === 'win32') {
    // node:path.win32.isAbsolute accepts rooted slash/backslash paths, drive
    // paths with a separator, and UNC paths; drive-relative C:foo stays invalid.
    return /^(?:[\\/]|[A-Za-z]:[\\/])/u.test(value)
  }
  return value.startsWith('/')
}

/** One strict decoder per Host path implementation, built once per realm. */
const schemas = new Map<DevLeadBoardPathPlatform, ZodType<DevLeadBoard>>()

/**
 * The strict schema-v1 decoder for one Host path implementation.
 *
 * The shared protocol schema owns every structural rule; only the absolute-path
 * predicate differs, and it comes from the Host-published `pathPlatform` rather
 * than from the path string or the browser's own operating system.
 * @param platform - the Host's path implementation.
 * @returns the cached strict complete-board decoder.
 */
export function devLeadBoardSchemaFor(
  platform: DevLeadBoardPathPlatform = 'posix',
): ZodType<DevLeadBoard> {
  const cached = schemas.get(platform)
  if (cached !== undefined) return cached
  const schema = createDevLeadBoardSchema(value => isAbsoluteWorkspacePath(value, platform))
  schemas.set(platform, schema)
  return schema
}

/** Strict schema v1 decoder using POSIX semantics by default. */
export const devLeadBoardSchema = devLeadBoardSchemaFor()

/** Host-published browser configuration. */
export interface DevLeadBoardConfig {
  readonly boardFilePath: string
  readonly schemaVersion: typeof DEVLEAD_BOARD_SCHEMA_VERSION
  readonly pathPlatform: DevLeadBoardPathPlatform
}

/**
 * Host-published browser configuration, extended by Hosts whose board follows
 * one lead Session.
 *
 * `leadSessionId` and `override` are optional within the current `boardFilePath`
 * contract for a deployment-wide path without lead attribution. When present
 * they let the browser tell "this global is mine" from "this global belongs to
 * another lead", which matters after a lead switch without a page reload.
 */
export interface DevLeadBoardGlobal extends DevLeadBoardConfig {
  /** Lead Session whose original workspace root owns the published board. */
  readonly leadSessionId?: string
  /** Whether `boardFilePath` came from the deployment Config override. */
  readonly override?: boolean
}

/** A malformed JSON/schema/UTF-8/size failure safe to show as a board error. */
export class DevLeadBoardParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DevLeadBoardParseError'
  }
}

/**
 * Read and validate the Host global. Anything absent or not exactly the current
 * contract disables the feature; no partial config is ever used for a read.
 *
 * The current `boardFilePath` base fields are required; the two optional lead
 * fields are validated strictly when present (a non-string/empty
 * `leadSessionId` or a non-boolean `override` rejects the whole global instead
 * of silently falling back to the deployment-wide meaning).
 */
export function readDevLeadBoardConfig(value: unknown): DevLeadBoardGlobal | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== DEVLEAD_BOARD_SCHEMA_VERSION) return undefined
  if (record.pathPlatform !== 'posix' && record.pathPlatform !== 'win32') return undefined
  if (typeof record.boardFilePath !== 'string' || record.boardFilePath.trim().length === 0) return undefined
  if (record.boardFilePath.length > DEVLEAD_BOARD_PATH_MAX
    || !isAbsoluteWorkspacePath(record.boardFilePath, record.pathPlatform)) return undefined
  if (record.leadSessionId !== undefined) {
    if (typeof record.leadSessionId !== 'string' || record.leadSessionId.length === 0) return undefined
  }
  if (record.override !== undefined && typeof record.override !== 'boolean') return undefined
  return {
    boardFilePath: record.boardFilePath,
    schemaVersion: DEVLEAD_BOARD_SCHEMA_VERSION,
    pathPlatform: record.pathPlatform,
    ...record.leadSessionId === undefined ? {} : { leadSessionId: record.leadSessionId },
    ...record.override === undefined ? {} : { override: record.override },
  }
}

/** Read this realm's optional Host global. */
export function currentDevLeadBoardConfig(): DevLeadBoardGlobal | undefined {
  return readDevLeadBoardConfig((globalThis as Record<string, unknown>)[DEVLEAD_BOARD_GLOBAL])
}

/**
 * Detect a Host path implementation from the syntax of one Session workspace
 * root, for Hosts that publish no global (the board default path needs no
 * configuration, so a page loaded before any lead existed still has to derive
 * it).
 *
 * `/`-rooted values are POSIX; drive-letter and backslash-rooted values
 * (including UNC) are Windows. The result only names the path syntax: the
 * caller still has to check the value is absolute for that platform.
 * @param cwd - one Session summary workspace root.
 * @returns the syntactic platform, or undefined for a rootless/relative value.
 */
export function detectDevLeadBoardPathPlatform(cwd: string): DevLeadBoardPathPlatform | undefined {
  if (cwd.startsWith('/')) return 'posix'
  if (cwd.startsWith('\\') || /^[A-Za-z]:/u.test(cwd)) return 'win32'
  return undefined
}

/**
 * Join the default board location under one lead Session's original workspace
 * root with the Host's path implementation.
 *
 * The relative part comes from the shared protocol segments, so the Host and
 * the browser cannot disagree about `.dsh/devlead/board.json`. The join mirrors
 * `node:path.join` for the two supported platforms (separator normalization,
 * `.`/`..` folding, drive/UNC/rooted prefixes) because the browser cannot
 * import `node:path` and the derived path must equal the Host's own default.
 * @param cwd - absolute original workspace root of the lead Session.
 * @param platform - the Host's path implementation.
 * @returns the platform-joined absolute board path.
 */
export function joinDevLeadBoardPath(cwd: string, platform: DevLeadBoardPathPlatform): string {
  const segments = [...DEVLEAD_BOARD_DIR_SEGMENTS, DEVLEAD_BOARD_FILE_NAME]
  return platform === 'win32' ? joinWin32Path(cwd, segments) : joinPosixPath(cwd, segments)
}

/** POSIX join with `node:path.posix` normalization. */
function joinPosixPath(cwd: string, segments: readonly string[]): string {
  const parts: string[] = []
  for (const part of `${cwd}/${segments.join('/')}`.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Windows join with `node:path.win32` normalization (drive, UNC, or rooted). */
function joinWin32Path(cwd: string, segments: readonly string[]): string {
  const path = `${cwd.replaceAll('/', '\\')}\\${segments.join('\\')}`
  let prefix: string
  let rest: string
  const drive = /^[A-Za-z]:\\/u.exec(path)
  if (drive !== null) {
    prefix = drive[0]
    rest = path.slice(3)
  } else if (path.startsWith('\\\\')) {
    // UNC/device root: the server and share segments stay part of the prefix.
    prefix = '\\\\'
    rest = path.slice(2)
  } else {
    prefix = '\\'
    rest = path.slice(1)
  }
  const parts: string[] = []
  for (const part of rest.split('\\')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `${prefix}${parts.join('\\')}`
}

/** Everything {@link resolveDevLeadBoardConfig} needs to place one board. */
export interface DevLeadBoardResolveInput {
  /** Session the board surfaces are being evaluated for. */
  readonly sessionId: string
  /** That Session's original workspace root (`SessionSummary.cwd`). */
  readonly cwd?: string | undefined
  /** The validated Host global, when one was published. */
  readonly global?: DevLeadBoardGlobal | undefined
}

/** One validated global's path-only configuration. */
function boardConfigOf(global: DevLeadBoardGlobal): DevLeadBoardConfig {
  return {
    boardFilePath: global.boardFilePath,
    schemaVersion: DEVLEAD_BOARD_SCHEMA_VERSION,
    pathPlatform: global.pathPlatform,
  }
}

/**
 * Resolve which board file one Session should read, or undefined when no path
 * can be attributed to it.
 *
 * Priority, highest first:
 * 1. A deployment Config override published by the Host (`override: true`)
 *    wins for every lead, because the deployment named one host-wide file.
 * 2. A global whose `leadSessionId` is this Session wins.
 * 3. A current global without either optional lead field keeps its
 *    deployment-wide meaning.
 * 4. Otherwise the default path is derived from this Session's own workspace
 *    root, using the Host-published `pathPlatform` when one is known and the
 *    syntactic detection otherwise. The root must be absolute for that
 *    platform; a relative or missing value yields no board.
 * @param input - Session identity, workspace root, and validated global.
 * @returns the board configuration for this Session, or undefined.
 */
export function resolveDevLeadBoardConfig(
  { sessionId, cwd, global }: DevLeadBoardResolveInput,
): DevLeadBoardConfig | undefined {
  if (global !== undefined) {
    if (global.override === true) return boardConfigOf(global)
    if (global.leadSessionId !== undefined) {
      if (global.leadSessionId === sessionId) return boardConfigOf(global)
    } else if (global.override === undefined) {
      return boardConfigOf(global)
    }
  }
  // The Host trims the workspace root before deriving its own default, so the
  // browser does the same; otherwise a padded summary value would resolve to a
  // different file than the Host writes.
  const root = cwd?.trim() ?? ''
  if (root.length === 0) return undefined
  const platform = global?.pathPlatform ?? detectDevLeadBoardPathPlatform(root)
  if (platform === undefined || !isAbsoluteWorkspacePath(root, platform)) return undefined
  return {
    boardFilePath: joinDevLeadBoardPath(root, platform),
    schemaVersion: DEVLEAD_BOARD_SCHEMA_VERSION,
    pathPlatform: platform,
  }
}

/**
 * Structural view of the Session-list row the board surfaces read.
 *
 * A board belongs to a top-level Session whose own summary says DevLead mode is
 * on; the route comes from the summary-sized `devLeadMode` projection, never
 * from the digest-bearing projection. Subagent Sessions can never become a
 * lead, so they are excluded even if a stale row claims the mode.
 */
export interface DevLeadBoardSessionRow extends DevLeadRowSummary {
  /** Original workspace root of the Session, the default board owner. */
  readonly cwd?: string
  /** Host navigation classification; `'subagent'` never owns a board. */
  readonly origin?: 'subagent'
}

/**
 * Resolve the board surfaces' configuration for one listed Session.
 * @param sessionId - Session row identity.
 * @param row - that Session's summary, or undefined before the list lands.
 * @param global - the validated Host global, when one was published.
 * @returns the board configuration for an eligible lead, or undefined when the
 *   Session must show no board surface at all.
 */
export function resolveDevLeadBoardSessionConfig(
  sessionId: string,
  row: DevLeadBoardSessionRow | undefined,
  global: DevLeadBoardGlobal | undefined,
): DevLeadBoardConfig | undefined {
  if (row === undefined || row.origin === 'subagent' || !devLeadRowEnabled(row)) return undefined
  return resolveDevLeadBoardConfig({ sessionId, cwd: row.cwd, global })
}

/** Decode a complete board file without accepting truncation or invalid UTF-8. */
export function parseDevLeadBoardBytes(
  bytes: Uint8Array,
  pathPlatform: DevLeadBoardPathPlatform = 'posix',
): DevLeadBoard {
  if (bytes.byteLength > DEVLEAD_BOARD_MAX_BYTES) {
    throw new DevLeadBoardParseError(`board file exceeds ${DEVLEAD_BOARD_MAX_BYTES} bytes`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new DevLeadBoardParseError('board file is not valid UTF-8', { cause: error })
  }
  return parseDevLeadBoard(text, pathPlatform)
}

/** Parse and strictly validate board JSON for the Host's path platform. */
export function parseDevLeadBoard(
  text: string,
  pathPlatform: DevLeadBoardPathPlatform = 'posix',
): DevLeadBoard {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new DevLeadBoardParseError('board file is not valid JSON', { cause: error })
  }
  const parsed = devLeadBoardSchemaFor(pathPlatform).safeParse(value)
  if (!parsed.success) {
    const first = devLeadBoardIssueViews(parsed.error.issues)[0]
    const pointer = first === undefined || first.pointer.length === 0 ? '/' : first.pointer
    throw new DevLeadBoardParseError(
      `board schema v1 validation failed at ${pointer}: ${first?.message ?? 'unknown issue'}`,
      { cause: parsed.error },
    )
  }
  return parsed.data
}

/** One non-empty status section in display order. */
export interface DevLeadBoardGroup {
  readonly status: DevLeadBoardProjectStatus
  readonly projects: readonly DevLeadBoardProject[]
}

const STATUS_ORDER: readonly DevLeadBoardProjectStatus[] = ['blocked', 'active', 'paused', 'done']
const PRIORITY_RANK: Readonly<Record<DevLeadBoardPriority, number>> = { high: 0, medium: 1, low: 2 }

/** High priority first, then recently updated, then stable id order. */
export function compareDevLeadBoardProjects(left: DevLeadBoardProject, right: DevLeadBoardProject): number {
  return PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || left.id.localeCompare(right.id)
}

/** Group by status with blocked first; never mutate the parsed board. */
export function groupDevLeadBoardProjects(board: DevLeadBoard): DevLeadBoardGroup[] {
  return STATUS_ORDER.flatMap(status => {
    const projects = board.projects.filter(project => project.status === status).sort(compareDevLeadBoardProjects)
    return projects.length === 0 ? [] : [{ status, projects }]
  })
}

export type DevLeadBoardStatusCounts = Readonly<Record<DevLeadBoardProjectStatus, number>>

/** The grouped cards and every status KPI derived from one board revision. */
export interface DevLeadBoardSummary {
  readonly groups: readonly DevLeadBoardGroup[]
  readonly counts: DevLeadBoardStatusCounts
}

/**
 * Derive the complete status overview once. KPI counts deliberately read the
 * same non-empty groups rendered below them, so a blocked project can never be
 * present in the list while its own KPI/banner uses a different predicate or
 * board snapshot.
 */
export function summarizeDevLeadBoardProjects(board: DevLeadBoard): DevLeadBoardSummary {
  const groups = groupDevLeadBoardProjects(board)
  const counts: Record<DevLeadBoardProjectStatus, number> = { active: 0, blocked: 0, paused: 0, done: 0 }
  for (const group of groups) counts[group.status] = group.projects.length
  return { groups, counts }
}

/** Tag palette for one project status. */
export function projectStatusTone(status: DevLeadBoardProjectStatus): TagTone {
  switch (status) {
    case 'blocked': return 'warning'
    case 'active': return 'info'
    case 'done': return 'success'
    case 'paused': return 'neutral'
  }
}

/** Tag palette for one task status. */
export function taskStatusTone(status: DevLeadBoardTaskStatus): TagTone {
  switch (status) {
    case 'blocked': return 'warning'
    case 'doing': return 'info'
    case 'done': return 'success'
    case 'todo': return 'quiet'
  }
}

/** Done/total task summary shown on a closed disclosure row. */
export function taskProgress(project: DevLeadBoardProject): { readonly done: number; readonly total: number } {
  return { done: project.tasks.filter(task => task.status === 'done').length, total: project.tasks.length }
}

/** Compact owner label; the complete id remains available in a title attribute. */
export function truncateSessionId(value: string): string {
  const characters = Array.from(value)
  return characters.length <= 18 ? value : `${characters.slice(0, 10).join('')}…${characters.slice(-5).join('')}`
}

/** Minimal Host Workspace shape used by the unlisted-project projection. */
export interface DevLeadBoardWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

/** One registered Workspace absent from the board by normalized path. */
export interface DevLeadUnlistedWorkspace extends DevLeadBoardWorkspace {
  readonly sessionCount: number
  readonly lastActivityAt?: string
}

/** Normalize syntax only; filesystem realpath/symlink resolution stays with the Host. */
function normalizedWorkspacePath(value: string, platform: DevLeadBoardPathPlatform): string {
  let normalized = platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value
  const root = platform === 'win32'
    ? /^(?:[a-z]:\/|\/+)$/u.test(normalized)
    : normalized === '/'
  if (!root) normalized = normalized.replace(/\/+$/u, '')
  return normalized
}

/**
 * Join only authoritative Workspace/Session projections. A Workspace with no
 * listed Session activity carries no synthetic timestamp. Path comparison is
 * syntactic; symlink aliases still need Host canonicalization (Step C).
 */
export function unlistedDevLeadWorkspaces(
  board: DevLeadBoard,
  workspaces: readonly DevLeadBoardWorkspace[],
  sessions: Readonly<Record<string, { readonly updatedAt: number } | undefined>>,
  pathPlatform: DevLeadBoardPathPlatform = 'posix',
): DevLeadUnlistedWorkspace[] {
  const listedPaths = new Set(board.projects.map(project => normalizedWorkspacePath(project.workspace.path, pathPlatform)))
  return workspaces.filter(workspace => !listedPaths.has(normalizedWorkspacePath(workspace.path, pathPlatform))).map(workspace => {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const updatedAt = sessions[sessionId]?.updatedAt
      if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) latest = Math.max(latest, updatedAt)
    }
    return {
      ...workspace,
      sessionCount: workspace.sessionIds.length,
      ...Number.isFinite(latest) ? { lastActivityAt: new Date(latest).toISOString() } : {},
    }
  }).sort((left, right) => {
    const leftTime = left.lastActivityAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(left.lastActivityAt)
    const rightTime = right.lastActivityAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(right.lastActivityAt)
    return rightTime - leftTime || left.title.localeCompare(right.title) || left.workspaceId.localeCompare(right.workspaceId)
  })
}

/** Locale-independent relative-time bucket, localized by the view. */
export type DevLeadRelativeTime =
  | { readonly unit: 'now'; readonly n: 0 }
  | { readonly unit: 'minutes' | 'hours' | 'days'; readonly n: number }

/** Bucket an ISO timestamp for the panel's compact relative labels. */
export function boardRelativeTime(iso: string, now: number): DevLeadRelativeTime {
  const elapsed = Math.max(0, now - Date.parse(iso))
  if (elapsed < 60_000) return { unit: 'now', n: 0 }
  if (elapsed < 3_600_000) return { unit: 'minutes', n: Math.floor(elapsed / 60_000) }
  if (elapsed < 86_400_000) return { unit: 'hours', n: Math.floor(elapsed / 3_600_000) }
  return { unit: 'days', n: Math.floor(elapsed / 86_400_000) }
}
