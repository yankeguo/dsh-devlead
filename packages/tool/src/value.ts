/**
 * Canonical model-facing values and enforced JSON schemas of the `devlead_*`
 * tools.
 *
 * Every tool returns plain JSON built from the shared protocol vocabulary, so a
 * PTC program can call a tool and use its resolved value directly while the
 * model still receives one compact JSON text block. The schemas are the single
 * source of truth for the value types: projections are checked against the
 * schema-derived type instead of duplicating the shape by hand, and `execute`
 * is compile-checked against the same type.
 *
 * @module @yankeguo/dsh-tool-devlead/value
 */

import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { DEVLEAD_TRANSITIONS } from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadCreatedSession,
  DevLeadNotification,
  DevLeadProjection,
  DevLeadPromptedSession,
  DevLeadSessionView,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'

/**
 * Wrap one canonical value schema into the `output` declaration of
 * {@link defineTool}: model-facing content is always one JSON text block.
 * @param schema - enforced schema of the canonical value.
 * @returns the output declaration.
 */
export function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (_args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

/**
 * Mark one nested output schema node as a required object property. The author
 * DSL keeps requiredness on the property node itself, which a plain object
 * literal cannot express without widening the literal type.
 * @param schema - nested value schema node.
 * @returns the same node declared required.
 */
function required<S extends ValueSchemaSpec>(schema: S): S & { readonly required: true } {
  return { ...schema, required: true }
}

/** Enforced schema of one Workspace row. */
export const WORKSPACE_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', required: true, description: 'Stable Workspace record id.' },
    title: { type: 'string', required: true, description: 'Display title.' },
    path: { type: 'string', required: true, description: 'Canonical directory path.' },
    status: { type: 'string', required: true, enum: ['ok', 'missing-dir'], description: 'Live directory check result.' },
    sessionIds: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Sessions the registry accounts to this Workspace.',
    },
    createdAt: { type: 'string', required: true, description: 'ISO-8601 creation instant.' },
    updatedAt: { type: 'string', required: true, description: 'ISO-8601 instant of the last durable mutation.' },
  },
} as const

/** Enforced schema of one Session row. */
export const SESSION_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true, description: 'Session identity.' },
    title: { type: 'string', description: 'Latest folded title, when one exists.' },
    workspaceId: { type: 'string', description: 'Accounting Workspace id, when the Session belongs to one.' },
    workspaceTitle: { type: 'string', description: 'Accounting Workspace title, when the Session belongs to one.' },
    cwd: { type: 'string', description: 'Recorded working directory, when the header carries one.' },
    live: { type: 'boolean', required: true, description: 'Whether the Session currently has a live Agent.' },
    running: { type: 'boolean', required: true, description: 'Whether the Session Agent is inside a turn.' },
    watched: { type: 'boolean', required: true, description: 'Whether this lead watches the Session.' },
    archived: { type: 'boolean', required: true, description: 'Whether the Workspace registry lists the Session as archived.' },
    lastTurn: { type: 'integer', description: 'Latest recorded turn number, when the log was observed.' },
    pendingInputs: { type: 'integer', description: 'Pending inbox messages, when the Agent is live.' },
    lastTransition: {
      type: 'string',
      enum: [...DEVLEAD_TRANSITIONS],
      description: 'How the latest recorded turn ended, when the log was observed.',
    },
    lastError: { type: 'string', description: 'Compact error excerpt of the latest failed turn, when recorded.' },
    lastAssistant: { type: 'string', description: 'Compact excerpt of the latest assistant message, when observed.' },
    updatedAt: { type: 'integer', description: 'Epoch milliseconds of the latest durable activity, when known.' },
    createdAt: { type: 'integer', description: 'Epoch milliseconds of Session creation, when known.' },
  },
} as const

/** Enforced schema of one notification. */
export const NOTIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Deterministic notification identity.' },
    sessionId: { type: 'string', required: true, description: 'Session whose turn settled.' },
    sessionTitle: { type: 'string', description: 'Session title at notification time, when one was folded.' },
    transition: {
      type: 'string',
      required: true,
      enum: [...DEVLEAD_TRANSITIONS],
      description: 'How the watched turn ended.',
    },
    turn: { type: 'integer', required: true, description: '1-based turn number that settled.' },
    at: { type: 'integer', required: true, description: 'Epoch milliseconds when the Host observed the transition.' },
    error: { type: 'string', description: 'Compact single-line failure excerpt for error or blocked transitions.' },
    summary: { type: 'string', description: 'Compact excerpt of the latest assistant message before the turn settled.' },
  },
} as const

/** Canonical value of one Workspace row. */
export type WorkspaceValue = InferValue<typeof WORKSPACE_VIEW_SCHEMA>

/** Canonical value of one Session row. */
export type SessionValue = InferValue<typeof SESSION_VIEW_SCHEMA>

/** Canonical value of one notification. */
export type NotificationValue = InferValue<typeof NOTIFICATION_SCHEMA>

/** Project one Workspace view onto the canonical value. */
export function workspaceValue(workspace: DevLeadWorkspaceView): WorkspaceValue {
  return {
    workspaceId: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
    status: workspace.status,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/**
 * Project one Session view onto the canonical value.
 *
 * Optional facts are dropped when absent: the lossless-JSON boundary rejects
 * `undefined` members, and the schema declares them optional anyway.
 * @param view - view assembled by the core service.
 * @returns the detached canonical value.
 */
export function sessionValue(view: DevLeadSessionView): SessionValue {
  return {
    sessionId: view.sessionId,
    live: view.live,
    running: view.running,
    watched: view.watched,
    archived: view.archived,
    ...view.title === undefined ? {} : { title: view.title },
    ...view.workspaceId === undefined ? {} : { workspaceId: view.workspaceId },
    ...view.workspaceTitle === undefined ? {} : { workspaceTitle: view.workspaceTitle },
    ...view.cwd === undefined ? {} : { cwd: view.cwd },
    ...view.lastTurn === undefined ? {} : { lastTurn: view.lastTurn },
    ...view.pendingInputs === undefined ? {} : { pendingInputs: view.pendingInputs },
    ...view.lastTransition === undefined ? {} : { lastTransition: view.lastTransition },
    ...view.lastError === undefined ? {} : { lastError: view.lastError },
    ...view.lastAssistant === undefined ? {} : { lastAssistant: view.lastAssistant },
    ...view.updatedAt === undefined ? {} : { updatedAt: view.updatedAt },
    ...view.createdAt === undefined ? {} : { createdAt: view.createdAt },
  }
}

/** Project one notification onto the canonical value. */
export function notificationValue(notification: DevLeadNotification): NotificationValue {
  return {
    id: notification.id,
    sessionId: notification.sessionId,
    transition: notification.transition,
    turn: notification.turn,
    at: notification.at,
    ...notification.sessionTitle === undefined ? {} : { sessionTitle: notification.sessionTitle },
    ...notification.error === undefined ? {} : { error: notification.error },
    ...notification.summary === undefined ? {} : { summary: notification.summary },
  }
}

/**
 * Copy the watched-Session set out of one projection.
 * @param projection - current wire projection of the lead Session.
 * @returns watched Session ids in add order.
 */
export function watchedIds(projection: DevLeadProjection): string[] {
  return [...projection.sessions]
}

/** Canonical value of `devlead_list_workspaces`. */
export const LIST_WORKSPACES_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaces: required({ type: 'array', items: WORKSPACE_VIEW_SCHEMA }),
  },
} as const)

/** Canonical value of `devlead_use_workspace`. */
export const USE_WORKSPACE_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    workspace: required(WORKSPACE_VIEW_SCHEMA),
  },
} as const)

/** Canonical value of `devlead_list_sessions`. */
export const LIST_SESSIONS_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    sessions: required({ type: 'array', items: SESSION_VIEW_SCHEMA }),
    watched: required({ type: 'array', items: { type: 'string' } }),
  },
} as const)

/** Canonical value of `devlead_create_session`. */
export const CREATE_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    session: required(SESSION_VIEW_SCHEMA),
    workspace: required(WORKSPACE_VIEW_SCHEMA),
    prompted: { type: 'boolean', required: true },
  },
} as const)

/** Canonical value of `devlead_get_session`. */
export const GET_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    session: required(SESSION_VIEW_SCHEMA),
  },
} as const)

/** Canonical value of `devlead_prompt_session`. */
export const PROMPT_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    watched: { type: 'boolean', required: true },
    resumed: { type: 'boolean', required: true },
  },
} as const)

/** Canonical value of `devlead_watch_session`. */
export const WATCH_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    watched: { type: 'boolean', required: true },
    sessions: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const)

/** Canonical value of `devlead_notifications`. */
export const NOTIFICATIONS_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    notifications: required({ type: 'array', items: NOTIFICATION_SCHEMA }),
    watched: required({ type: 'array', items: { type: 'string' } }),
  },
} as const)

/** Project one created-Session result onto the canonical value. */
export function createdSessionValue(created: DevLeadCreatedSession): InferValue<typeof CREATE_SESSION_OUTPUT.schema> {
  return {
    session: sessionValue(created.session),
    workspace: workspaceValue(created.workspace),
    prompted: created.prompted,
  }
}

/** Project one admitted-prompt result onto the canonical value. */
export function promptedSessionValue(prompted: DevLeadPromptedSession): InferValue<typeof PROMPT_SESSION_OUTPUT.schema> {
  return {
    sessionId: prompted.sessionId,
    watched: prompted.watched,
    resumed: prompted.resumed,
  }
}

/** Project one watch-set mutation onto the canonical value. */
export function watchMutationValue(mutation: DevLeadWatchMutation): InferValue<typeof WATCH_SESSION_OUTPUT.schema> {
  return {
    sessionId: mutation.sessionId,
    watched: mutation.watched,
    sessions: [...mutation.sessions],
  }
}
