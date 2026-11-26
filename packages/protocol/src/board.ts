/**
 * Shared durable project-board wire schema (schema v1).
 *
 * The Host owns the only writable copy of this JSON file; the browser renders a
 * read-only projection. Both sides must reject exactly the same bytes, so the
 * limits, the strict object shapes, the duplicate-id/duplicate-path rules, and
 * the timestamp form live here instead of being mirrored per package. Only the
 * absolute-path predicate stays caller-supplied: the Host uses `node:path` for
 * the platform it runs on, while the browser uses the Host-published
 * `pathPlatform` (it cannot import Node builtins).
 *
 * The module is pure data validation: no Node builtins, no DSH runtime imports,
 * no I/O. It does use zod at runtime, which is why zod is a peer dependency of
 * this package on both sides of the wire.
 *
 * @module @yankeguo/dsh-devlead-protocol
 */

import { z as zod } from 'zod'
import type { ZodIssue, ZodType } from 'zod'

/** Current on-disk schema version. */
export const DEVLEAD_BOARD_SCHEMA_VERSION = 1
/**
 * Directory segments, relative to the lead Session's original workspace root
 * (`SessionHeader.cwd`), that hold the default project board.
 *
 * The Host derives the default path from its own lead identity; the browser
 * derives the same path from the Session summary's `cwd` when the Host global
 * is absent. Both sides build it from these shared segments so they cannot
 * drift, while each side keeps its own path implementation (POSIX/Windows).
 */
export const DEVLEAD_BOARD_DIR_SEGMENTS = ['.dsh', 'devlead'] as const
/** Default board file name inside {@link DEVLEAD_BOARD_DIR_SEGMENTS}. */
export const DEVLEAD_BOARD_FILE_NAME = 'board.json'
/** Maximum serialized board size (256 KiB); larger files are never decoded. */
export const DEVLEAD_BOARD_MAX_BYTES = 256 * 1024
/**
 * Maximum serialized size of one `devlead_board_read` result (64 KiB).
 *
 * The durable file is bounded by {@link DEVLEAD_BOARD_MAX_BYTES}, but a single
 * project may still carry dozens of 4000-unit tasks and blockers. Tool reads
 * therefore trim task rows, then blockers, then project rows from the tail
 * until the JSON result fits; a trimmed result reports `truncated: true`.
 */
export const DEVLEAD_BOARD_READ_MAX_BYTES = 64 * 1024
/** Maximum number of projects in one board. */
export const DEVLEAD_BOARD_MAX_PROJECTS = 50
/** Maximum tasks in one project. */
export const DEVLEAD_BOARD_MAX_TASKS = 200
/** Maximum blockers in one project (bounds tool and prompt projections). */
export const DEVLEAD_BOARD_MAX_BLOCKERS = 50
/** Maximum UTF-16 code units in a long free-text field. */
export const DEVLEAD_BOARD_TEXT_MAX = 4_000
/** Maximum UTF-16 code units in an id. */
export const DEVLEAD_BOARD_ID_MAX = 128
/** Maximum UTF-16 code units in a display title. */
export const DEVLEAD_BOARD_TITLE_MAX = 200
/** Maximum UTF-16 code units in a filesystem path. */
export const DEVLEAD_BOARD_PATH_MAX = 4_096
/** Maximum UTF-16 code units in a timestamp string before ISO parsing. */
export const DEVLEAD_BOARD_TIMESTAMP_MAX = 64

/** Durable project status. */
export type DevLeadBoardProjectStatus = 'active' | 'blocked' | 'paused' | 'done'
/** Durable project priority. */
export type DevLeadBoardPriority = 'low' | 'medium' | 'high'
/** Durable task status. */
export type DevLeadBoardTaskStatus = 'todo' | 'doing' | 'blocked' | 'done'

/** One durable blocker. */
export interface DevLeadBoardBlocker {
  id: string
  text: string
  since: string
  sessionId?: string
}

/** One durable task. */
export interface DevLeadBoardTask {
  id: string
  title: string
  status: DevLeadBoardTaskStatus
  ownerSessionId?: string
  updatedAt: string
}

/** One durable project. */
export interface DevLeadBoardProject {
  id: string
  /** Project-local CAS revision; legacy files are backfilled from the file revision on read. */
  revision: number
  workspace: { path: string; title: string }
  status: DevLeadBoardProjectStatus
  priority: DevLeadBoardPriority
  goal: string
  focus: string
  next: string
  blockers: DevLeadBoardBlocker[]
  tasks: DevLeadBoardTask[]
  updatedAt: string
}

/** Lead identity stamped on each committed revision. */
export interface DevLeadBoardUpdatedBy {
  sessionId: string
  title: string
}

/** Complete durable board. */
export interface DevLeadBoard {
  schemaVersion: 1
  revision: number
  updatedAt: string
  updatedBy: DevLeadBoardUpdatedBy
  projects: DevLeadBoardProject[]
}

/** One path-qualified validation failure. */
export interface DevLeadBoardIssue {
  /** RFC 6901 JSON pointer into the board; the empty string identifies the root. */
  readonly pointer: string
  readonly message: string
}

/** Escape one RFC 6901 reference-token segment. */
function pointerSegment(value: string | number | symbol): string {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * Render one zod issue path as an RFC 6901 JSON pointer.
 * @param path - zod issue path segments.
 * @returns the pointer; the empty string identifies the root.
 */
export function devLeadBoardIssuePointer(path: readonly (string | number | symbol)[]): string {
  return path.length === 0 ? '' : `/${path.map(pointerSegment).join('/')}`
}

/**
 * Map zod issues to path-qualified board issues.
 * @param issues - validation issues from the shared schema.
 * @returns the same issues with JSON-pointer identities.
 */
export function devLeadBoardIssueViews(issues: readonly ZodIssue[]): DevLeadBoardIssue[] {
  return issues.map(issue => ({
    pointer: devLeadBoardIssuePointer(issue.path),
    message: issue.message,
  }))
}

const idSchema = zod.string().min(1).max(DEVLEAD_BOARD_ID_MAX)
const titleSchema = zod.string().min(1).max(DEVLEAD_BOARD_TITLE_MAX)
const textSchema = zod.string().max(DEVLEAD_BOARD_TEXT_MAX)
const timestampSchema = zod.string().max(DEVLEAD_BOARD_TIMESTAMP_MAX).pipe(zod.iso.datetime())

const blockerSchema = zod.object({
  id: idSchema,
  text: zod.string().min(1).max(DEVLEAD_BOARD_TEXT_MAX),
  since: timestampSchema,
  sessionId: idSchema.optional(),
}).strict()

const taskSchema = zod.object({
  id: idSchema,
  title: zod.string().min(1).max(DEVLEAD_BOARD_TEXT_MAX),
  status: zod.enum(['todo', 'doing', 'blocked', 'done']),
  ownerSessionId: idSchema.optional(),
  updatedAt: timestampSchema,
}).strict()

/**
 * Build the strict schema-v1 decoder for one Host path implementation.
 *
 * Absolute-path syntax is the only platform-dependent rule: POSIX hosts accept
 * only leading-slash paths, Windows hosts also accept drive and UNC forms. The
 * caller passes the exact predicate its `node:path` flavor uses, so the Host
 * and the browser cannot drift onto different acceptance sets.
 *
 * Duplicate project ids, duplicate workspace paths, and duplicate blocker/task
 * ids are rejected by a `superRefine` pass after the structural checks.
 * @param isAbsolutePath - whether one workspace path string is absolute for the
 *   publishing Host's path implementation.
 * @returns the strict complete-board schema. Unknown fields, wrong enums, bad
 *   UTC timestamps, and any size/count over the exported limits all fail.
 */
export function createDevLeadBoardSchema(
  isAbsolutePath: (value: string) => boolean,
): ZodType<DevLeadBoard> {
  const projectSchema = zod.object({
    id: idSchema,
    // Optional only at the durable decode boundary so schema-v1 files written
    // before project-local CAS remain readable; the Host backfills and persists it.
    revision: zod.number().int().nonnegative().safe().optional(),
    workspace: zod.object({
      path: zod.string().min(1).max(DEVLEAD_BOARD_PATH_MAX).refine(isAbsolutePath, {
        message: 'workspace path must be absolute',
      }),
      title: titleSchema,
    }).strict(),
    status: zod.enum(['active', 'blocked', 'paused', 'done']),
    priority: zod.enum(['low', 'medium', 'high']),
    goal: textSchema,
    focus: textSchema,
    next: textSchema,
    blockers: zod.array(blockerSchema).max(DEVLEAD_BOARD_MAX_BLOCKERS),
    tasks: zod.array(taskSchema).max(DEVLEAD_BOARD_MAX_TASKS),
    updatedAt: timestampSchema,
  }).strict()

  const boardSchema = zod.object({
    schemaVersion: zod.literal(DEVLEAD_BOARD_SCHEMA_VERSION),
    revision: zod.number().int().nonnegative().safe(),
    updatedAt: timestampSchema,
    updatedBy: zod.object({ sessionId: idSchema, title: titleSchema }).strict(),
    projects: zod.array(projectSchema).max(DEVLEAD_BOARD_MAX_PROJECTS),
  }).strict().superRefine((board, context) => {
    const projectIds = new Set<string>()
    const workspacePaths = new Set<string>()
    board.projects.forEach((project, projectIndex) => {
      if (projectIds.has(project.id)) {
        context.addIssue({
          code: 'custom',
          path: ['projects', projectIndex, 'id'],
          message: `duplicate project id "${project.id}"`,
        })
      }
      projectIds.add(project.id)
      if (workspacePaths.has(project.workspace.path)) {
        context.addIssue({
          code: 'custom',
          path: ['projects', projectIndex, 'workspace', 'path'],
          message: `duplicate workspace path "${project.workspace.path}"`,
        })
      }
      workspacePaths.add(project.workspace.path)
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
  }).transform(board => ({
    ...board,
    projects: board.projects.map(project => ({ ...project, revision: project.revision ?? board.revision })),
  }))
  // The zod-inferred output spells optional keys as `T | undefined`, which is
  // not assignable to the documented interfaces under `exactOptionalPropertyTypes`;
  // the runtime shape is identical, so the public schema type is asserted once
  // here instead of loosening every consumer interface.
  return boardSchema as unknown as ZodType<DevLeadBoard>
}
