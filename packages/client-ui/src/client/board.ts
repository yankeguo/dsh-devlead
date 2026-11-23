/**
 * Browser-owned, read-only projection of the DevLead board schema v1.
 *
 * The Host package deliberately stays out of the browser bundle: it imports
 * Node filesystem modules. The durable wire schema, its limits, and its strict
 * duplicate/absolute-path rules live in the shared protocol package, so the
 * browser decoder and the Host validator cannot drift. This module adds only
 * the browser-owned pieces: the platform-specific absolute-path predicate
 * (chosen from the Host-published `pathPlatform`), the global-config reader,
 * the UTF-8/size pre-checks, and the pure grouping/sorting/formatting helpers.
 */
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createDevLeadBoardSchema,
  devLeadBoardIssueViews,
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

// The wire contract is re-exported so existing browser modules and tests keep
// one import site for board constants, types, and decoders.
export {
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

/** Host global present only when boardPath is configured. */
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
  readonly boardPath: string
  readonly schemaVersion: typeof DEVLEAD_BOARD_SCHEMA_VERSION
  readonly pathPlatform: DevLeadBoardPathPlatform
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
 */
export function readDevLeadBoardConfig(value: unknown): DevLeadBoardConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== DEVLEAD_BOARD_SCHEMA_VERSION) return undefined
  if (record.pathPlatform !== 'posix' && record.pathPlatform !== 'win32') return undefined
  if (typeof record.boardPath !== 'string' || record.boardPath.trim().length === 0) return undefined
  if (record.boardPath.length > DEVLEAD_BOARD_PATH_MAX
    || !isAbsoluteWorkspacePath(record.boardPath, record.pathPlatform)) return undefined
  return {
    boardPath: record.boardPath,
    schemaVersion: DEVLEAD_BOARD_SCHEMA_VERSION,
    pathPlatform: record.pathPlatform,
  }
}

/** Read this realm's optional Host global. */
export function currentDevLeadBoardConfig(): DevLeadBoardConfig | undefined {
  return readDevLeadBoardConfig((globalThis as Record<string, unknown>)[DEVLEAD_BOARD_GLOBAL])
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
