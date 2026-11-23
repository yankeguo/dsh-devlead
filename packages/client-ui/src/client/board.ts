/**
 * Browser-owned, read-only projection of the DevLead board schema v1.
 *
 * The Host package deliberately stays out of the browser bundle: it imports
 * Node filesystem modules. This module mirrors only the durable wire schema and
 * contains pure parsing, grouping, sorting, and formatting helpers.
 */
import { z as zod } from 'zod'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'

/** Current board wire version published by the Host. */
export const DEVLEAD_BOARD_SCHEMA_VERSION = 1
/** The Host's maximum board file size; larger input is never decoded. */
export const DEVLEAD_BOARD_MAX_BYTES = 256 * 1024
/** Host global present only when boardPath is configured. */
export const DEVLEAD_BOARD_GLOBAL = '__DSH_DEVLEAD_BOARD__'
/** Right-Sidebar page discriminator passed to `sidebarRight.openTab`. */
export const DEVLEAD_BOARD_TAB_KIND = 'devlead-board'
/** Registration id; keyed Sidebar body slots use this id, not the kind. */
export const DEVLEAD_BOARD_TAB_ID = '@yankeguo/dsh-client-ui-devlead/board'

const MAX_PROJECTS = 50
const MAX_TASKS = 200
const MAX_BLOCKERS = 50
const MAX_TEXT = 4_000
const MAX_ID = 128
const MAX_TITLE = 200
const MAX_PATH = 4_096

/** Durable project status. */
export type DevLeadBoardProjectStatus = 'active' | 'blocked' | 'paused' | 'done'
/** Durable priority. */
export type DevLeadBoardPriority = 'low' | 'medium' | 'high'
/** Durable task status. */
export type DevLeadBoardTaskStatus = 'todo' | 'doing' | 'blocked' | 'done'

const idSchema = zod.string().min(1).max(MAX_ID)
const titleSchema = zod.string().min(1).max(MAX_TITLE)
const textSchema = zod.string().max(MAX_TEXT)
const timestampSchema = zod.string().max(64).pipe(zod.iso.datetime())
// Absolute-path semantics are checked against the Host-published pathPlatform:
// POSIX and Windows Hosts do not accept the same path forms.
const pathSchema = zod.string().min(1).max(MAX_PATH)

const blockerSchema = zod.object({
  id: idSchema,
  text: zod.string().min(1).max(MAX_TEXT),
  since: timestampSchema,
  sessionId: idSchema.optional(),
}).strict()

const taskSchema = zod.object({
  id: idSchema,
  title: zod.string().min(1).max(MAX_TEXT),
  status: zod.enum(['todo', 'doing', 'blocked', 'done']),
  ownerSessionId: idSchema.optional(),
  updatedAt: timestampSchema,
}).strict()

const projectSchema = zod.object({
  id: idSchema,
  workspace: zod.object({ path: pathSchema, title: titleSchema }).strict(),
  status: zod.enum(['active', 'blocked', 'paused', 'done']),
  priority: zod.enum(['low', 'medium', 'high']),
  goal: textSchema,
  focus: textSchema,
  next: textSchema,
  blockers: zod.array(blockerSchema).max(MAX_BLOCKERS),
  tasks: zod.array(taskSchema).max(MAX_TASKS),
  updatedAt: timestampSchema,
}).strict()

/** Strict fields and duplicate-id checks, before platform-specific paths. */
const baseDevLeadBoardSchema = zod.object({
  schemaVersion: zod.literal(DEVLEAD_BOARD_SCHEMA_VERSION),
  revision: zod.number().int().nonnegative().safe(),
  updatedAt: timestampSchema,
  updatedBy: zod.object({ sessionId: idSchema, title: titleSchema }).strict(),
  projects: zod.array(projectSchema).max(MAX_PROJECTS),
}).strict().superRefine((board, context) => {
  const projectIds = new Set<string>()
  board.projects.forEach((project, projectIndex) => {
    if (projectIds.has(project.id)) {
      context.addIssue({
        code: 'custom',
        path: ['projects', projectIndex, 'id'],
        message: `duplicate project id "${project.id}"`,
      })
    }
    projectIds.add(project.id)
    for (const [field, entries] of [['blockers', project.blockers], ['tasks', project.tasks]] as const) {
      const ids = new Set<string>()
      entries.forEach((entry, entryIndex) => {
        if (ids.has(entry.id)) {
          context.addIssue({
            code: 'custom',
            path: ['projects', projectIndex, field, entryIndex, 'id'],
            message: `duplicate ${field} id "${entry.id}"`,
          })
        }
        ids.add(entry.id)
      })
    }
  })
})

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

/** Build the v1 decoder for the Host's actual path implementation. */
export function devLeadBoardSchemaFor(platform: DevLeadBoardPathPlatform = 'posix') {
  return baseDevLeadBoardSchema.superRefine((board, context) => {
    board.projects.forEach((project, index) => {
      if (isAbsoluteWorkspacePath(project.workspace.path, platform)) return
      context.addIssue({
        code: 'custom',
        path: ['projects', index, 'workspace', 'path'],
        message: 'workspace path must be absolute',
      })
    })
  })
}

/** Strict schema v1 decoder using POSIX semantics by default. */
export const devLeadBoardSchema = devLeadBoardSchemaFor()

/** One durable blocker. */
export type DevLeadBoardBlocker = zod.infer<typeof blockerSchema>
/** One durable task. */
export type DevLeadBoardTask = zod.infer<typeof taskSchema>
/** One durable project. */
export type DevLeadBoardProject = zod.infer<typeof projectSchema>
/** Complete durable board. */
export type DevLeadBoard = zod.infer<typeof devLeadBoardSchema>

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
  if (!pathSchema.safeParse(record.boardPath).success
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
    const first = parsed.error.issues[0]
    const pointer = first === undefined || first.path.length === 0 ? '/' : `/${first.path.join('/')}`
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
