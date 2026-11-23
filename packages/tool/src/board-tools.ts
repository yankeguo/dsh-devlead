/** Lead-only AI tools for the user-visible, file-backed DevLead project board. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {
  DevLeadBoardNoteWrite,
  DevLeadBoardSetPatch,
  DevLeadBoardUpdate,
} from '@yankeguo/dsh-devlead'
import {
  TOOL_ARGUMENT_KEYS,
  assertKnownArguments,
  optionalNonNegativeInteger,
  optionalNoteRef,
  optionalPositiveInteger,
  optionalProjectRef,
  requireAgent,
  requireProjectRef,
} from './arguments.ts'
import type { BoardNoteReadArgs, BoardNoteWriteArgs, BoardReadArgs, BoardUpdateArgs } from './arguments.ts'
import { runTool } from './errors.ts'
import { TOOL_PARAMETERS } from './parameters.ts'
import { present } from './presentation.ts'
import { jsonOutput } from './value.ts'

const BOARD_READ_DESCRIPTION =
  'Read the user-visible DevLead project board: durable project status, priority, goal/focus/next, blockers, and '
  + 'optionally tasks. Omit project for a bounded all-project summary; select one by exact id, workspace title, or '
  + 'absolute workspace path for full detail. This board is read-only for the human and writable only by the lead AI '
  + 'through devlead_board_update. The board belongs to the active lead Session; its file location is derived from '
  + 'that Session workspace (or a deployment override) and is never a tool argument. Results are bounded and may be '
  + 'truncated:true; no active lead workspace (including a recorded workspace root that no longer exists) means '
  + 'BOARD_DISABLED.'

const BOARD_UPDATE_DESCRIPTION =
  'Update one project on the user-visible DevLead board; the human is read-only and only the enabled lead AI may '
  + 'write through this tool. Create requires create:true and set.workspace.path. Supports scalar status/priority/'
  + 'goal/focus/next updates, blocker clear/remove/add, and task remove/upsert. Use expected_revision from '
  + 'devlead_board_read for compare-and-swap when a lost update would matter. Returns only the changed project without '
  + 'task rows and the changed lanes, never the whole board. The file belongs to the active lead Session workspace and '
  + 'no argument can redirect it.'

const BOARD_NOTE_READ_DESCRIPTION =
  'Read Markdown notes attached to one existing DevLead board project. project is required and resolves exactly as '
  + 'in the other board tools. Omit note for the project\'s bounded metadata listing (id, title, summary, updatedAt, '
  + 'bytes, and root-relative path); provide its id for the full Markdown content plus metadata. A missing notes '
  + 'index reads as an empty revision-0 project listing. Only the active lead can use this tool, and no argument '
  + 'accepts or redirects a Host filesystem path.'

const BOARD_NOTE_WRITE_DESCRIPTION =
  'Create, update, append to, or delete one Markdown note on an existing project of the active lead\'s DevLead '
  + 'board. create requires title and may omit note to generate a UUID; update changes only supplied title/summary/'
  + 'content; append requires note and content and appends it exactly; delete requires note. Use expected_revision '
  + 'for notes-index CAS and expected_bytes for existing-note CAS when a lost update would matter. Returns the '
  + 'resulting metadata (or deleted metadata), revision, and changed state without returning the body. Note content '
  + 'stays out of the index. The Host owns all locations; write arguments contain no file path.'

const BLOCKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    text: { type: 'string', required: true },
    since: { type: 'string', required: true },
    sessionId: { type: 'string' },
  },
} as const

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['todo', 'doing', 'blocked', 'done'] },
    ownerSessionId: { type: 'string' },
    updatedAt: { type: 'string', required: true },
  },
} as const

const PROJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    workspace: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        title: { type: 'string', required: true },
      },
    },
    status: { type: 'string', required: true, enum: ['active', 'blocked', 'paused', 'done'] },
    priority: { type: 'string', required: true, enum: ['low', 'medium', 'high'] },
    goal: { type: 'string', required: true },
    focus: { type: 'string', required: true },
    next: { type: 'string', required: true },
    blockers: { type: 'array', required: true, items: BLOCKER_SCHEMA },
    updatedAt: { type: 'string', required: true },
  },
} as const

const READ_PROJECT_SCHEMA = {
  ...PROJECT_SCHEMA,
  properties: {
    ...PROJECT_SCHEMA.properties,
    tasks: { type: 'array', items: TASK_SCHEMA },
  },
} as const

/** Canonical output of `devlead_board_read`. */
export const BOARD_READ_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    updatedAt: { type: 'string', required: true },
    projects: { type: 'array', required: true, items: READ_PROJECT_SCHEMA },
    truncated: { type: 'boolean' },
  },
} as const)

/** Canonical output of `devlead_board_update`. */
export const BOARD_UPDATE_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    updatedAt: { type: 'string', required: true },
    project: { ...PROJECT_SCHEMA, required: true },
    changed: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const)

const NOTE_PROJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    directory: { type: 'string', required: true },
  },
} as const

const NOTE_METADATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    path: { type: 'string', required: true },
  },
} as const

const NOTE_DOCUMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...NOTE_METADATA_SCHEMA.properties,
    content: { type: 'string', required: true },
  },
} as const

/** Canonical metadata-listing or full-body output of `devlead_board_note_read`. */
export const BOARD_NOTE_READ_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    updatedAt: { type: 'string', required: true },
    project: { ...NOTE_PROJECT_SCHEMA, required: true },
    notes: { type: 'array', items: NOTE_METADATA_SCHEMA },
    note: NOTE_DOCUMENT_SCHEMA,
  },
} as const)

/** Canonical output of `devlead_board_note_write`. */
export const BOARD_NOTE_WRITE_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    updatedAt: { type: 'string', required: true },
    project: { ...NOTE_PROJECT_SCHEMA, required: true },
    note: { ...NOTE_METADATA_SCHEMA, required: true },
    operation: { type: 'string', required: true, enum: ['create', 'update', 'append', 'delete'] },
    changed: { type: 'boolean', required: true },
    deleted: { type: 'boolean' },
  },
} as const)

function setPatch(input: BoardUpdateArgs['set']): DevLeadBoardSetPatch | undefined {
  if (input === undefined) return undefined
  return {
    ...input.status === undefined ? {} : { status: input.status },
    ...input.priority === undefined ? {} : { priority: input.priority },
    ...input.goal === undefined ? {} : { goal: input.goal },
    ...input.focus === undefined ? {} : { focus: input.focus },
    ...input.next === undefined ? {} : { next: input.next },
    ...input.workspace === undefined ? {} : {
      workspace: {
        ...input.workspace.path === undefined ? {} : { path: input.workspace.path },
        ...input.workspace.title === undefined ? {} : { title: input.workspace.title },
      },
    },
  }
}

/** Translate the snake_case tool contract into the core's logical patch. */
export function boardUpdateRequest(args: BoardUpdateArgs): Omit<DevLeadBoardUpdate, 'updatedBy'> {
  const set = setPatch(args.set)
  return {
    project: requireProjectRef(args.project),
    ...args.create === undefined ? {} : { create: args.create },
    ...set === undefined ? {} : { set },
    ...args.blockers === undefined ? {} : {
      blockers: {
        ...args.blockers.clear === undefined ? {} : { clear: args.blockers.clear },
        ...args.blockers.remove === undefined ? {} : { remove: args.blockers.remove },
        ...args.blockers.add === undefined ? {} : {
          add: args.blockers.add.map(blocker => ({
            id: blocker.id,
            text: blocker.text,
            ...blocker.session_id === undefined ? {} : { sessionId: blocker.session_id },
          })),
        },
      },
    },
    ...args.tasks === undefined ? {} : {
      tasks: {
        ...args.tasks.remove === undefined ? {} : { remove: args.tasks.remove },
        ...args.tasks.upsert === undefined ? {} : {
          upsert: args.tasks.upsert.map(task => ({
            id: task.id,
            ...task.title === undefined ? {} : { title: task.title },
            ...task.status === undefined ? {} : { status: task.status },
            ...task.owner_session_id === undefined ? {} : { ownerSessionId: task.owner_session_id },
          })),
        },
      },
    },
  }
}

/** Translate one snake_case note write into the core's logical, path-free patch. */
export function boardNoteWriteRequest(args: BoardNoteWriteArgs): DevLeadBoardNoteWrite {
  const note = optionalNoteRef(args.note)
  const expectedRevision = optionalNonNegativeInteger(args.expected_revision, 'expected_revision')
  const expectedBytes = optionalNonNegativeInteger(args.expected_bytes, 'expected_bytes')
  return {
    project: requireProjectRef(args.project),
    operation: args.operation,
    ...note === undefined ? {} : { note },
    ...args.title === undefined ? {} : { title: args.title },
    ...args.summary === undefined ? {} : { summary: args.summary },
    ...args.content === undefined ? {} : { content: args.content },
    ...expectedRevision === undefined ? {} : { expectedRevision },
    ...expectedBytes === undefined ? {} : { expectedBytes },
  }
}

function resultRecord(result: ToolResult): Record<string, unknown> | undefined {
  if (result.isError) return undefined
  const text = result.content.find(block => block.type === 'text')?.text
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Completed cards stay summary-sized even when a project carries 200 tasks. */
export function presentBoardResult(_args: unknown, result: ToolResult): GenericResultView {
  const value = resultRecord(result)
  if (value === undefined) return { card: 'generic' }
  const revision = typeof value.revision === 'number' ? `r${value.revision}` : 'revision unknown'
  let text: string
  if (Array.isArray(value.projects)) {
    text = `DevLead board ${revision}: ${value.projects.length} project(s)`
      + `${value.truncated === true ? ' (truncated)' : ''}`
  } else {
    const project = typeof value.project === 'object' && value.project !== null
      ? value.project as Record<string, unknown>
      : undefined
    const id = typeof project?.id === 'string' ? project.id : 'project'
    const changed = Array.isArray(value.changed)
      ? value.changed.filter((entry): entry is string => typeof entry === 'string')
      : []
    text = `DevLead board ${revision}: ${id}; ${changed.length === 0 ? 'no changes' : `changed ${changed.join(', ')}`}`
  }
  return { card: 'generic', content: [{ type: 'text', text: text.slice(0, 500) }] }
}

/** Keep note cards summary-sized and never duplicate Markdown content into presentation. */
export function presentBoardNoteResult(_args: unknown, result: ToolResult): GenericResultView {
  const value = resultRecord(result)
  if (value === undefined) return { card: 'generic' }
  const revision = typeof value.revision === 'number' ? `r${value.revision}` : 'revision unknown'
  const project = typeof value.project === 'object' && value.project !== null
    ? value.project as Record<string, unknown>
    : undefined
  const projectId = typeof project?.id === 'string' ? project.id : 'project'
  let detail: string
  if (Array.isArray(value.notes)) detail = `${value.notes.length} note(s)`
  else if (typeof value.operation === 'string') {
    const note = typeof value.note === 'object' && value.note !== null
      ? value.note as Record<string, unknown>
      : undefined
    const noteId = typeof note?.id === 'string' ? note.id : 'note'
    detail = `${value.operation} ${noteId}${value.changed === false ? '; no changes' : ''}`
  } else {
    const note = typeof value.note === 'object' && value.note !== null
      ? value.note as Record<string, unknown>
      : undefined
    detail = typeof note?.title === 'string' ? note.title : 'note content'
  }
  return {
    card: 'generic',
    content: [{ type: 'text', text: `DevLead notes ${revision}: ${projectId}; ${detail}`.slice(0, 500) }],
  }
}

/** Register the board and note tools on the same lead-only condition as other lead tools. */
export function registerDevLeadBoardTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'devlead_board_read',
    description: BOARD_READ_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_board_read,
    output: BOARD_READ_OUTPUT,
    presentCall: (args: BoardReadArgs) => present('Read DevLead board', 'read', args.project?.trim()),
    presentResult: presentBoardResult,
    isConcurrencySafe: () => true,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_board_read)
        const agent = requireAgent(exec.agent, 'devlead_board_read')
        const project = optionalProjectRef(args.project)
        const limit = optionalPositiveInteger(args.limit, 'limit')
        return ctx.devLead.readBoard(agent, {
          ...project === undefined ? {} : { project },
          ...args.include_tasks === undefined ? {} : { includeTasks: args.include_tasks },
          ...limit === undefined ? {} : { limit },
        })
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_board_update',
    description: BOARD_UPDATE_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_board_update,
    output: BOARD_UPDATE_OUTPUT,
    presentCall: (args: BoardUpdateArgs) => present(
      args.create === true ? 'Create/update DevLead board project' : 'Update DevLead board project',
      'other',
      args.project.trim(),
    ),
    presentResult: presentBoardResult,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_board_update)
        const agent = requireAgent(exec.agent, 'devlead_board_update')
        const expectedRevision = optionalNonNegativeInteger(args.expected_revision, 'expected_revision')
        const result = await ctx.devLead.updateBoard(agent, boardUpdateRequest(args), expectedRevision, exec.signal)
        const { tasks: _tasks, ...project } = result.project
        return { ...result, project }
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_board_note_read',
    description: BOARD_NOTE_READ_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_board_note_read,
    output: BOARD_NOTE_READ_OUTPUT,
    presentCall: (args: BoardNoteReadArgs) => present('Read DevLead project notes', 'read', args.project.trim()),
    presentResult: presentBoardNoteResult,
    isConcurrencySafe: () => true,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_board_note_read)
        const agent = requireAgent(exec.agent, 'devlead_board_note_read')
        const note = optionalNoteRef(args.note)
        return ctx.devLead.readBoardNote(agent, {
          project: requireProjectRef(args.project),
          ...note === undefined ? {} : { note },
        })
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })

  ctx.tools.register(defineTool({
    name: 'devlead_board_note_write',
    description: BOARD_NOTE_WRITE_DESCRIPTION,
    parameters: TOOL_PARAMETERS.devlead_board_note_write,
    output: BOARD_NOTE_WRITE_OUTPUT,
    presentCall: (args: BoardNoteWriteArgs) => present(
      `${args.operation[0]?.toUpperCase() ?? ''}${args.operation.slice(1)} DevLead project note`,
      'other',
      args.project.trim(),
    ),
    presentResult: presentBoardNoteResult,
    execute(args, exec) {
      return runTool(async () => {
        assertKnownArguments(args, TOOL_ARGUMENT_KEYS.devlead_board_note_write)
        const agent = requireAgent(exec.agent, 'devlead_board_note_write')
        return ctx.devLead.writeBoardNote(agent, boardNoteWriteRequest(args), exec.signal)
      })
    },
  }), { when: ({ agent }) => ctx.devLead.isEnabled(agent) })
}
