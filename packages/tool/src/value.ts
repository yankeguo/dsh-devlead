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
import { DEVLEAD_REPORT_KINDS, DEVLEAD_TRANSITIONS } from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadAgentPresetCatalog,
  DevLeadArchivedSession,
  DevLeadCreatedSession,
  DevLeadIsolation,
  DevLeadIsolationMode,
  DevLeadIsolationStatus,
  DevLeadModelCatalog,
  DevLeadModelSelection,
  DevLeadNotification,
  DevLeadProjection,
  DevLeadPromptedSession,
  DevLeadQuestionAnswerView,
  DevLeadRemovedWorkspace,
  DevLeadReport,
  DevLeadSessionView,
  DevLeadUnarchivedSession,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'

/** Every checkout-isolation mode the tool surface exposes, in declaration order. */
export const DEVLEAD_ISOLATION_MODES: readonly DevLeadIsolationMode[] = ['none', 'worktree']

/** Every checkout-isolation outcome status, in declaration order. */
export const DEVLEAD_ISOLATION_STATUSES: readonly DevLeadIsolationStatus[] = [
  'none',
  'worktree',
  'unavailable',
  'failed',
]

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
    live: {
      type: 'boolean',
      required: true,
      description: 'Whether the Session is live in the Host store, with an Agent or an attached Session.',
    },
    running: { type: 'boolean', required: true, description: 'Whether the Session Agent is inside a turn.' },
    watched: { type: 'boolean', required: true, description: 'Whether this lead watches the Session.' },
    archived: { type: 'boolean', required: true, description: 'Whether the Workspace registry lists the Session as archived.' },
    lastTurn: { type: 'integer', description: 'Latest turn number observed on the Session, when known.' },
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

/** Enforced schema of one applied model selection. */
export const MODEL_SELECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true, description: 'Registered provider route.' },
    model: { type: 'string', required: true, description: 'Provider-owned model id.' },
    reasoningEffort: {
      type: 'string',
      description: 'Adapter-owned reasoning effort, present only when one was explicitly requested.',
    },
  },
} as const

/** Enforced schema of one checkout-isolation outcome. */
export const ISOLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requested: {
      type: 'string',
      required: true,
      enum: [...DEVLEAD_ISOLATION_MODES],
      description: 'Requested isolation mode after defaulting; omitted requests resolve to none.',
    },
    status: {
      type: 'string',
      required: true,
      enum: [...DEVLEAD_ISOLATION_STATUSES],
      description: 'What actually happened: none or worktree are requested outcomes; unavailable and failed left the Session in the Workspace checkout.',
    },
    path: { type: 'string', description: 'Canonical worktree checkout path, present only when status is worktree.' },
    branch: { type: 'string', description: 'Branch created for the worktree, present only when status is worktree.' },
    baseCommit: { type: 'string', description: 'Commit the worktree branch started from, present only when status is worktree.' },
    reason: { type: 'string', description: 'Diagnostic for an unavailable or failed outcome.' },
  },
} as const

/** Enforced schema of one pending inbox input. */
export const QUEUED_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Stable Host message identity of the queued input.' },
    boundary: {
      type: 'string',
      required: true,
      enum: ['next-turn', 'next-step'],
      description: 'Inbox boundary holding the message: its own turn, or the next step of a running turn.',
    },
    sourceKind: {
      type: 'string',
      required: true,
      description: 'Producer kind of the message source (user, devlead, schedule, …); an open Host vocabulary, not a closed enum.',
    },
    sourceForm: { type: 'string', description: 'Producer-declared context form (relay, notice, …), when the source carries one.' },
    senderSessionId: { type: 'string', description: 'Authoring Session identity, when the source records one (a devlead relay names its lead).' },
    excerpt: { type: 'string', description: 'Bounded single-line excerpt of the text content, when the message carries text.' },
    enqueuedAt: { type: 'integer', description: 'Epoch milliseconds of the durable splice that enqueued the message, when the log records one.' },
    intent: {
      type: 'string',
      enum: ['instruction', 'answer', 'correction', 'background'],
      description: 'DevLead prompt intent stamped on the source, when the producer recorded one.',
    },
    questionId: { type: 'string', description: 'Question report identity an answer message addresses, when it is one.' },
    wakeRequested: { type: 'boolean', description: 'Whether the admission requested a driver wake, when the source records it (false for background).' },
    deliveryState: {
      type: 'string',
      enum: ['admitted', 'claimed'],
      description: 'Observed inbox lifecycle of a tracked answer: admitted (waiting) or claimed (taken for a proposed step). Absent for untracked messages; only presented (not shown, because it left the inbox) is delivery completion.',
    },
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
    error: { type: 'string', description: 'Compact single-line failure excerpt when the settled turn failed.' },
    summary: { type: 'string', description: 'Compact excerpt of the latest assistant message before the turn settled.' },
  },
} as const

/** Enforced schema of one structured native question option. */
const QUESTION_OPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', required: true, description: 'Short option label.' },
    description: { type: 'string', description: 'Optional explanation of the option.' },
  },
} as const

/** Enforced schema of one structured native question. */
const QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Optional child-authored question identifier.' },
    header: { type: 'string', description: 'Optional short display heading.' },
    question: { type: 'string', required: true, description: 'Full question text.' },
    options: { type: 'array', items: QUESTION_OPTION_SCHEMA, description: 'Optional choices presented to the lead.' },
    multi_select: { type: 'boolean', description: 'Whether multiple options may be selected.' },
  },
} as const

/** Enforced schema of one mid-turn report from a watched Session. */
export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Deterministic report identity.' },
    kind: {
      type: 'string',
      required: true,
      enum: [...DEVLEAD_REPORT_KINDS],
      description: 'Why the reporter sent this update.',
    },
    message: { type: 'string', required: true, description: 'Full report text.' },
    summary: { type: 'string', description: 'Optional short title for digest rows.' },
    questions: {
      type: 'array',
      items: QUESTION_SCHEMA,
      description: 'Structured native question payload, present only on gate-created question reports.',
    },
    senderSessionId: { type: 'string', required: true, description: 'Reporting Session identity.' },
    senderSessionTitle: { type: 'string', description: 'Reporting Session title at report time.' },
    senderWorkspaceId: { type: 'string', description: 'Reporting Session Workspace identity.' },
    senderWorkspaceTitle: { type: 'string', description: 'Reporting Session Workspace title.' },
    leadSessionId: { type: 'string', required: true, description: 'Active DevLead Session receiving the report.' },
    turn: { type: 'integer', required: true, description: "Reporter's current turn (0 before its first turn)." },
    at: { type: 'integer', required: true, description: 'Epoch milliseconds recorded by the Host.' },
    questionStatus: {
      type: 'string',
      enum: ['open', 'answered', 'expired', 'cancelled'],
      description: 'Question lifecycle (question reports only): open accepts a new answer; answered has an active answer; expired/cancelled reject question_id. Filter open questions with questionStatus === "open".',
    },
    answerStatus: {
      type: 'string',
      enum: ['admitted', 'claimed', 'presented', 'discarded', 'failed'],
      description: 'Inbox lifecycle of the newest answer (question reports only). Separate from questionStatus: answered does not imply presented; only presented is delivery completion. discarded/failed reopen the question.',
    },
    answerMessageId: { type: 'string', description: 'Host message identity of the newest answer, when one exists.' },
    answeredAt: { type: 'integer', description: 'Epoch milliseconds of the first answer admission, when the question was ever answered (survives a reopen).' },
    presentedAt: { type: 'integer', description: 'Epoch milliseconds the newest answer entered an entered step, when observed.' },
    repairPending: { type: 'boolean', description: 'A durable-discard repair of this question is in flight, deferred, or unresolved (child state unreadable). The questionStatus/answerStatus are provisional until it settles; do not treat a stale open as finally answerable, and retry the answer later.' },
  },
} as const

/** Canonical value of one Workspace row. */
export type WorkspaceValue = InferValue<typeof WORKSPACE_VIEW_SCHEMA>

/** Canonical value of one Session row. */
export type SessionValue = InferValue<typeof SESSION_VIEW_SCHEMA>

/** Canonical value of one applied model selection. */
export type ModelSelectionValue = InferValue<typeof MODEL_SELECTION_SCHEMA>

/** Canonical value of the model catalog. */
export type ModelCatalogValue = InferValue<typeof MODEL_CATALOG_SCHEMA>

/** Canonical value of one checkout-isolation outcome. */
export type IsolationValue = InferValue<typeof ISOLATION_SCHEMA>

/** Canonical value of one notification. */
export type NotificationValue = InferValue<typeof NOTIFICATION_SCHEMA>

/** Canonical value of one pending inbox input. */
export type QueuedInputValue = InferValue<typeof QUEUED_INPUT_SCHEMA>

/** Canonical value of one mid-turn report. */
export type ReportValue = InferValue<typeof REPORT_SCHEMA>

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

/**
 * Project one checkout-isolation outcome onto the canonical value.
 *
 * Optional worktree facts are dropped when absent: they only exist for an
 * active outcome, and the lossless-JSON boundary rejects `undefined` members.
 * @param isolation - outcome assembled by the core service.
 * @returns the detached canonical value.
 */
export function isolationValue(isolation: DevLeadIsolation | undefined): IsolationValue {
  // A newer tool can run against a 0.1.1 core that predates the field. Default
  // the absent outcome instead of dereferencing undefined after the Session was
  // already created (which would look like a failed create to the model).
  if (isolation === undefined) return { requested: 'none', status: 'none' }
  return {
    requested: isolation.requested,
    status: isolation.status,
    ...isolation.path === undefined ? {} : { path: isolation.path },
    ...isolation.branch === undefined ? {} : { branch: isolation.branch },
    ...isolation.baseCommit === undefined ? {} : { baseCommit: isolation.baseCommit },
    ...isolation.reason === undefined ? {} : { reason: isolation.reason },
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
 * Project one report onto its canonical value, dropping absent optional fields.
 * @param report - report from the core service.
 * @param answerView - derived question/answer state for a question report, when
 *   the caller read it; omitted for non-question reports and the reporter's own
 *   receipt echo.
 * @returns the detached canonical value.
 */
export function reportValue(report: DevLeadReport, answerView?: DevLeadQuestionAnswerView): ReportValue {
  return {
    id: report.id,
    kind: report.kind,
    message: report.message,
    senderSessionId: report.senderSessionId,
    leadSessionId: report.leadSessionId,
    turn: report.turn,
    at: report.at,
    ...answerView === undefined ? {} : {
      questionStatus: answerView.questionStatus,
      ...answerView.answerStatus === undefined ? {} : { answerStatus: answerView.answerStatus },
      ...answerView.answerMessageId === undefined ? {} : { answerMessageId: answerView.answerMessageId },
      ...answerView.answeredAt === undefined ? {} : { answeredAt: answerView.answeredAt },
      ...answerView.presentedAt === undefined ? {} : { presentedAt: answerView.presentedAt },
      ...answerView.repairPending === undefined ? {} : { repairPending: answerView.repairPending },
    },
    ...report.summary === undefined ? {} : { summary: report.summary },
    ...report.questions === undefined ? {} : {
      questions: report.questions.map(question => ({
        ...question.id === undefined ? {} : { id: question.id },
        ...question.header === undefined ? {} : { header: question.header },
        question: question.question,
        ...question.options === undefined ? {} : {
          options: question.options.map(option => ({
            label: option.label,
            ...option.description === undefined ? {} : { description: option.description },
          })),
        },
        ...question.multi_select === undefined ? {} : { multi_select: question.multi_select },
      })),
    },
    ...report.senderSessionTitle === undefined ? {} : { senderSessionTitle: report.senderSessionTitle },
    ...report.senderWorkspaceId === undefined ? {} : { senderWorkspaceId: report.senderWorkspaceId },
    ...report.senderWorkspaceTitle === undefined ? {} : { senderWorkspaceTitle: report.senderWorkspaceTitle },
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
    isolation: required(ISOLATION_SCHEMA),
    model: MODEL_SELECTION_SCHEMA,
    agentTeams: {
      type: 'boolean',
      description: 'Agent Teams mode applied to the new Session, present only when explicitly requested.',
    },
  },
} as const)

/** Canonical value of `devlead_get_session`. */
export const GET_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    session: required(SESSION_VIEW_SCHEMA),
    reports: {
      type: 'array',
      items: REPORT_SCHEMA,
      description: 'When reading this lead Session itself, its newest retained mid-turn reports (up to five, oldest first).',
    },
    queuedInputs: {
      type: 'array',
      items: QUEUED_INPUT_SCHEMA,
      description: 'Pending inbox inputs of the target Session, present only while a live Agent owns it; queue order (next-turn rows, then next-step).',
    },
  },
} as const)

/** Enforced schema of one prompt admission receipt (no internal lane is exposed). */
export const DELIVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    primitive: {
      type: 'string',
      required: true,
      enum: ['followup', 'steer', 'inject'],
      description: 'DSH primitive the runtime actually used: followup (next-turn), steer (next-step), or inject (next-step, no wake).',
    },
    boundary: {
      type: 'string',
      required: true,
      enum: ['next-turn', 'next-step'],
      description: 'Inbox boundary that actually holds the admitted message (a waking steer on an aborted phase may be reclassified to next-turn).',
    },
    wakeRequested: {
      type: 'boolean',
      required: true,
      description: 'Whether the admission requested a driver wake; false for background context (queued, not presented).',
    },
    messageId: {
      type: 'string',
      required: true,
      description: 'Stable Host message identity of the admitted prompt, accepted by devlead_retract_input (answers excepted).',
    },
    questionId: { type: 'string', description: 'Question report identity echoed back for an answer, when one was given.' },
    idempotencyKey: { type: 'string', description: 'Lead-supplied idempotency key echoed back, when one was given.' },
  },
} as const

/** Canonical value of `devlead_prompt_session`. */
export const PROMPT_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true, description: 'Addressed Session identity.' },
    watched: { type: 'boolean', required: true, description: 'Whether the Session is watched after this call.' },
    resumed: { type: 'boolean', required: true, description: 'Whether the target had to be resumed because no live Agent owned the target when the prompt was admitted.' },
    interrupted: {
      type: 'boolean',
      required: true,
      description: 'Whether the Host was asked to stop running work before admitting the prompt; false for an idle or cold Session.',
    },
    retainedInputs: {
      type: 'integer',
      description: 'Pending inputs restored after the stop under interrupt_inbox keep/clear-own; absent for clear-all and every no-op interrupt.',
    },
    delivery: required(DELIVERY_SCHEMA),
    warning: {
      type: 'string',
      description: 'Present when an answer was delivered to the child inbox but its durable record could not be persisted/flushed; the question state may not survive a Host restart. The delivery itself still happened.',
    },
  },
} as const)

/** Canonical value of `devlead_retract_input`. */
export const RETRACT_INPUT_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true, description: 'Addressed Session identity.' },
    inputId: { type: 'string', required: true, description: 'Host message identity the call addressed.' },
    retracted: {
      type: 'boolean',
      required: true,
      description: 'Whether this call removed the input; false when it was already consumed or withdrawn.',
    },
  },
} as const)

/** Canonical value of `devlead_watch_session`. */
export const WATCH_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true, description: 'Addressed Session identity.' },
    watched: { type: 'boolean', required: true, description: 'Whether the Session is watched after this mutation.' },
    sessions: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'The complete watch set after this mutation, in add order (same ids as the watched array of the read tools).',
    },
  },
} as const)

/** Canonical value of `devlead_notifications`. */
export const NOTIFICATIONS_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    notifications: required({ type: 'array', items: NOTIFICATION_SCHEMA }),
    reports: required({ type: 'array', items: REPORT_SCHEMA }),
    watched: required({ type: 'array', items: { type: 'string' } }),
  },
} as const)

/** Canonical value of `devlead_report`. */
export const REPORT_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    report: required(REPORT_SCHEMA),
    durable: {
      type: 'boolean',
      required: true,
      description: 'Whether this attempt wrote the receipt to durable storage; false means no durable receipt exists (storage absent or the outbox write failed), so the warning is a possible-loss receipt.',
    },
    queued: {
      type: 'boolean',
      required: true,
      description: 'Whether the lead receipt is still waiting for delivery/wake-up rather than flushed.',
    },
    warning: {
      type: 'string',
      description: 'Human warning shown when no durable receipt was written on this attempt (storage unavailable or the outbox write failed) and the receipt is memory-only. For a question report it also asks the child to restate the question in its final assistant message.',
    },
    turnEndRequested: {
      type: 'boolean',
      description: 'Present and true only when a question report was durably forwarded: the tool requested the end of the current turn. The current tool batch still completes and already-queued next-step work still runs; the turn closes only after that. This is a request, not an immediate close, and it is absent for non-question kinds and for non-durable questions.',
    },
    questionId: {
      type: 'string',
      description: 'Report id of the durably forwarded question, present with turnEndRequested; the lead answers in a new turn or by steering this Session.',
    },
    guidance: {
      type: 'string',
      description: 'Model-facing delivery guidance, present when a question report was durably forwarded.',
    },
  },
} as const)

/** Enforced schema of one advertised reasoning effort. */
const MODEL_EFFORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Effort id accepted by reasoning_effort.' },
    name: { type: 'string', required: true, description: 'Human-readable effort name.' },
  },
} as const

/** Enforced schema of one advertised model. */
const MODEL_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Model id accepted by model.' },
    name: { type: 'string', required: true, description: 'Human-readable model name.' },
    reasoning: {
      type: 'object',
      additionalProperties: false,
      properties: {
        efforts: {
          type: 'array',
          required: true,
          items: MODEL_EFFORT_SCHEMA,
          description: 'Reasoning efforts the model accepts.',
        },
        defaultEffort: {
          type: 'string',
          description: 'Effort the adapter uses when the caller omits one.',
        },
      },
    },
  },
} as const

/** Enforced schema of one provider group in the model catalog. */
const MODEL_PROVIDER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Provider route accepted by provider.' },
    name: { type: 'string', required: true, description: 'Human-readable provider name.' },
    models: {
      type: 'array',
      required: true,
      items: MODEL_VIEW_SCHEMA,
      description: 'Models the provider currently advertises.',
    },
  },
} as const

/** Enforced schema of one provider catalog failure. */
const MODEL_CATALOG_FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Provider route whose lookup failed.' },
    name: { type: 'string', required: true, description: 'Human-readable provider name.' },
    message: { type: 'string', required: true, description: 'Failure detail.' },
  },
} as const

/** Enforced schema of the model catalog. */
export const MODEL_CATALOG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    default: required(MODEL_SELECTION_SCHEMA),
    routableProviders: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Provider routes with at least one available model.',
    },
    providers: {
      type: 'array',
      required: true,
      items: MODEL_PROVIDER_VIEW_SCHEMA,
      description: 'Provider groups and their models.',
    },
    failures: {
      type: 'array',
      required: true,
      items: MODEL_CATALOG_FAILURE_SCHEMA,
      description: 'Providers whose catalog lookup failed.',
    },
  },
} as const

/** Enforced schema of one Agent preset roster row. */
const AGENT_PRESET_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      required: true,
      description: 'Host-defined preset id accepted by devlead_create_session preset.',
    },
    name: { type: 'string', description: 'Display name the preset publishes.' },
    description: { type: 'string', description: 'One-sentence purpose the preset publishes.' },
    default: {
      type: 'boolean',
      required: true,
      description: 'Whether Sessions naming no preset use this one (selected default when configured).',
    },
    broken: { type: 'string', description: 'Why this preset cannot compose a Session; absent when usable.' },
  },
} as const

/** Enforced schema of the Agent preset roster. */
export const AGENT_PRESET_CATALOG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    available: {
      type: 'boolean',
      required: true,
      description: 'Whether the Host composes an Agent preset roster service.',
    },
    presets: {
      type: 'array',
      required: true,
      items: AGENT_PRESET_VIEW_SCHEMA,
      description: 'Declared presets in Host roster order; empty when unavailable or empty.',
    },
    reason: { type: 'string', description: 'Why the roster is unavailable; present only with available false.' },
  },
} as const

/** Canonical value of `devlead_list_models`. */
export const LIST_MODELS_OUTPUT = jsonOutput(MODEL_CATALOG_SCHEMA)

/** Canonical value of `devlead_list_agent_presets`. */
export const LIST_AGENT_PRESETS_OUTPUT = jsonOutput(AGENT_PRESET_CATALOG_SCHEMA)

/** Canonical value of `devlead_remove_workspace`. */
export const REMOVE_WORKSPACE_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    workspace: required(WORKSPACE_VIEW_SCHEMA),
    removed: {
      type: 'boolean',
      required: true,
      description: 'Whether a Workspace registration was removed.',
    },
  },
} as const)

/** Canonical value of `devlead_archive_session`. */
export const ARCHIVE_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true, description: 'Archived Session identity.' },
    archived: { type: 'boolean', required: true, const: true, description: 'Always true: the Session is archived.' },
    stopped: {
      type: 'boolean',
      required: true,
      description: 'Whether the Host was asked to stop the Session\'s running work.',
    },
  },
} as const)

/** Canonical value of `devlead_unarchive_session`. */
export const UNARCHIVE_SESSION_OUTPUT = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true, description: 'Restored Session identity.' },
    archived: {
      type: 'boolean',
      required: true,
      const: false,
      description: 'Always false: the Session is no longer archived.',
    },
  },
} as const)

/** Project one applied model selection onto the canonical value. */
export function modelSelectionValue(selection: DevLeadModelSelection): ModelSelectionValue {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/** Project one created-Session result onto the canonical value. */
export function createdSessionValue(created: DevLeadCreatedSession): InferValue<typeof CREATE_SESSION_OUTPUT.schema> {
  return {
    session: sessionValue(created.session),
    workspace: workspaceValue(created.workspace),
    prompted: created.prompted,
    isolation: isolationValue(created.isolation),
    ...created.model === undefined ? {} : { model: modelSelectionValue(created.model) },
    ...created.agentTeams === undefined ? {} : { agentTeams: created.agentTeams },
  }
}

/** Project one admitted-prompt result onto the canonical value. */
export function promptedSessionValue(prompted: DevLeadPromptedSession): InferValue<typeof PROMPT_SESSION_OUTPUT.schema> {
  const delivery = prompted.delivery
  return {
    sessionId: prompted.sessionId,
    watched: prompted.watched,
    resumed: prompted.resumed,
    interrupted: prompted.interrupted,
    ...prompted.retainedInputs === undefined ? {} : { retainedInputs: prompted.retainedInputs },
    delivery: {
      primitive: delivery.primitive,
      boundary: delivery.boundary,
      wakeRequested: delivery.wakeRequested,
      messageId: delivery.messageId,
      ...delivery.questionId === undefined ? {} : { questionId: delivery.questionId },
      ...delivery.idempotencyKey === undefined ? {} : { idempotencyKey: delivery.idempotencyKey },
    },
    ...prompted.warning === undefined ? {} : { warning: prompted.warning },
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

/** Canonical value of the Agent preset roster. */
export type AgentPresetCatalogValue = InferValue<typeof AGENT_PRESET_CATALOG_SCHEMA>

/** Project the Host Agent preset roster onto the canonical value. */
export function agentPresetCatalogValue(catalog: DevLeadAgentPresetCatalog): AgentPresetCatalogValue {
  return {
    available: catalog.available,
    presets: catalog.presets.map(preset => ({
      id: preset.id,
      default: preset.default,
      ...(preset.name === undefined ? {} : { name: preset.name }),
      ...(preset.description === undefined ? {} : { description: preset.description }),
      ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    })),
    ...(catalog.reason === undefined ? {} : { reason: catalog.reason }),
  }
}

/** Project one Host model catalog onto the canonical value. */
export function modelCatalogValue(catalog: DevLeadModelCatalog): ModelCatalogValue {
  return {
    default: modelSelectionValue(catalog.default),
    routableProviders: [...catalog.routableProviders],
    providers: catalog.providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map(model => ({
        id: model.id,
        name: model.name,
        ...model.reasoning === undefined
          ? {}
          : {
            reasoning: {
              efforts: model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })),
              ...model.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: model.reasoning.defaultEffort },
            },
          },
      })),
    })),
    failures: catalog.failures.map(failure => ({
      id: failure.id,
      name: failure.name,
      message: failure.message,
    })),
  }
}

/** Project one Workspace removal result onto the canonical value. */
export function removedWorkspaceValue(
  removed: DevLeadRemovedWorkspace,
): InferValue<typeof REMOVE_WORKSPACE_OUTPUT.schema> {
  return {
    workspace: workspaceValue(removed.workspace),
    removed: removed.removed,
  }
}

/** Project one Session archival result onto the canonical value. */
export function archivedSessionValue(
  archived: DevLeadArchivedSession,
): InferValue<typeof ARCHIVE_SESSION_OUTPUT.schema> {
  return {
    sessionId: archived.sessionId,
    archived: archived.archived,
    stopped: archived.stopped,
  }
}

/** Project one Session restoration result onto the canonical value. */
export function unarchivedSessionValue(
  unarchived: DevLeadUnarchivedSession,
): InferValue<typeof UNARCHIVE_SESSION_OUTPUT.schema> {
  return {
    sessionId: unarchived.sessionId,
    archived: unarchived.archived,
  }
}
