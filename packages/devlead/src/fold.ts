/**
 * Pure fold of the `devLead` Session projection: durable mode selection,
 * whole-value watched-session set, and the bounded notification digest.
 *
 * The fold never throws to the projection registry: the first invalid owned
 * record is retained in `failure`, the last valid state stays served, and the
 * Host service rejects reads while the failure is present.
 *
 * @module @yankeguo/dsh-devlead
 */

import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import {
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_MAX_INSTANT,
  DEVLEAD_MODE_PROJECTION_KEY,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_PROJECTION_KEY,
  DEVLEAD_REPORT_KINDS,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_RECORD_TYPE,
  DEVLEAD_REPORT_RETENTION,
  DEVLEAD_REPORT_SUMMARY_MAX,
  DEVLEAD_RESET_RECORD_TYPE,
  DEVLEAD_TRANSITIONS,
  DEVLEAD_WATCH_PROJECTION_KEY,
  DEVLEAD_WATCH_RECORD_TYPE,
  devLeadReportId,
  notificationId,
} from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadModeProjection,
  DevLeadNotification,
  DevLeadProjection,
  DevLeadProjectionState,
  DevLeadReport,
  DevLeadReportKind,
  DevLeadTransition,
  DevLeadWatchProjection,
} from '@yankeguo/dsh-devlead-protocol'
import {
  decodeModeRecord,
  decodeNotificationRecord,
  decodeReportRecord,
  decodeResetRecord,
  decodeWatchRecord,
} from './domain.ts'

/**
 * Empty projection state: disabled, watching nothing, no notifications or
 * reports.
 * @param inheritedEventCount - exact fork-inherited prefix length to ignore.
 * @returns the empty state for one Session.
 */
export function emptyDevLeadProjectionState(inheritedEventCount = 0): DevLeadProjectionState {
  return {
    enabled: false,
    sessions: [],
    notifications: [],
    reports: [],
    failure: null,
    inheritedEventCount,
  }
}

/** One bounded, non-empty excerpt as persisted by the notification writer. */
const excerptSchema = zod.string().min(1).refine(
  value => value.length <= DEVLEAD_ERROR_EXCERPT_MAX * 2
    && Array.from(value).length <= DEVLEAD_ERROR_EXCERPT_MAX,
  { message: `excerpt must be at most ${DEVLEAD_ERROR_EXCERPT_MAX} code points` },
)

/** Wire schema validating one retained notification before it leaves the Host. */
const notificationSchema: ZodType<DevLeadNotification> = zod.object({
  id: zod.string().min(1),
  sessionId: zod.string().min(1),
  sessionTitle: excerptSchema.optional(),
  // Derived from the shared vocabulary: a protocol transition added and written
  // by the core can never become a record that this fold rejects.
  transition: zod.enum([...DEVLEAD_TRANSITIONS] as [DevLeadTransition, ...DevLeadTransition[]]),
  turn: zod.number().int().positive(),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
  error: excerptSchema.optional(),
  summary: excerptSchema.optional(),
}).strict().refine(
  notification => notification.id === notificationId(
    notification.sessionId,
    notification.turn,
    notification.transition,
  ),
  { message: 'notification id must match sessionId, turn, and transition' },
) as ZodType<DevLeadNotification>

/** Bounded non-empty report text, checked in Unicode code points. */
const reportMessageSchema = zod.string().min(1).refine(
  value => Array.from(value).length <= DEVLEAD_REPORT_MESSAGE_MAX,
  { message: `report message must be at most ${DEVLEAD_REPORT_MESSAGE_MAX} code points` },
)

/** Wire schema validating one retained report before it leaves the Host. */
const reportSchema: ZodType<DevLeadReport> = zod.object({
  id: zod.string().min(1),
  kind: zod.enum([...DEVLEAD_REPORT_KINDS] as [DevLeadReportKind, ...DevLeadReportKind[]]),
  message: reportMessageSchema,
  summary: zod.string().min(1).refine(
    value => Array.from(value).length <= DEVLEAD_REPORT_SUMMARY_MAX,
    { message: `report summary must be at most ${DEVLEAD_REPORT_SUMMARY_MAX} code points` },
  ).optional(),
  senderSessionId: zod.string().min(1),
  senderSessionTitle: excerptSchema.optional(),
  senderWorkspaceId: zod.string().min(1).optional(),
  senderWorkspaceTitle: excerptSchema.optional(),
  leadSessionId: zod.string().min(1),
  turn: zod.number().int().nonnegative(),
  at: zod.number().int().nonnegative().max(DEVLEAD_MAX_INSTANT),
}).strict().refine(
  report => report.id === devLeadReportId(report.senderSessionId, report.turn, report.kind, report.message),
  { message: 'report id must match senderSessionId, turn, kind, and message' },
) as ZodType<DevLeadReport>

/**
 * Append one notification to a bounded digest, dropping an already-retained
 * identity so a replayed log converges on the same state.
 * @param notifications - retained notifications, oldest first.
 * @param notification - observed notification.
 * @returns the next retained digest.
 */
function retainNotification(
  notifications: readonly DevLeadNotification[],
  notification: DevLeadNotification,
): readonly DevLeadNotification[] {
  if (notifications.some(existing => existing.id === notification.id)) return notifications
  const next = [...notifications, notification]
  return next.length <= DEVLEAD_DEFAULT_NOTIFICATION_RETENTION
    ? next
    : next.slice(next.length - DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
}

/**
 * Append one report to a bounded digest, dropping an already-retained identity.
 * @param reports - retained reports, oldest first.
 * @param report - report to retain.
 * @returns the retained list, or the same reference when unchanged.
 */
function retainReport(
  reports: readonly DevLeadReport[],
  report: DevLeadReport,
): readonly DevLeadReport[] {
  if (reports.some(existing => existing.id === report.id)) return reports
  const next = [...reports, report]
  return next.length <= DEVLEAD_REPORT_RETENTION
    ? next
    : next.slice(next.length - DEVLEAD_REPORT_RETENTION)
}

/**
 * Whether two session-id lists carry the same ids in the same order.
 * @param left - first list.
 * @param right - second list.
 * @returns whether the lists are equal as values.
 */
function sameSessionIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Persisted projection state schema; seeds a fold and validates cached rows. */
export const devLeadProjectionStateSchema: ZodType<DevLeadProjectionState> = zod.object({
  enabled: zod.boolean(),
  sessions: zod.array(zod.string().min(1)).refine(
    sessions => new Set(sessions).size === sessions.length,
    { message: 'sessions must be unique' },
  ),
  notifications: zod.array(notificationSchema)
    .max(DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    .refine(
      notifications => new Set(notifications.map(notification => notification.id)).size === notifications.length,
      { message: 'notification ids must be unique' },
    ),
  reports: zod.array(reportSchema)
    .max(DEVLEAD_REPORT_RETENTION)
    .refine(
      reports => new Set(reports.map(report => report.id)).size === reports.length,
      { message: 'report ids must be unique' },
    ),
  failure: zod.string().min(1).nullable(),
  inheritedEventCount: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict() as ZodType<DevLeadProjectionState>

/** Client wire schema of the `devLead` projection value. */
export const devLeadProjectionSchema: ZodType<DevLeadProjection> = zod.object({
  enabled: zod.boolean(),
  sessions: zod.array(zod.string().min(1)),
  notifications: zod.array(notificationSchema)
    .max(DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    .refine(
      notifications => new Set(notifications.map(notification => notification.id)).size === notifications.length,
      { message: 'notification ids must be unique' },
    ),
  reports: zod.array(reportSchema)
    .max(DEVLEAD_REPORT_RETENTION)
    .refine(
      reports => new Set(reports.map(report => report.id)).size === reports.length,
      { message: 'report ids must be unique' },
    ),
}).strict() as ZodType<DevLeadProjection>

/**
 * Memoized wire views keyed by their exact immutable fold state. The registry
 * compares the previous and the current `wire.view` result with `Object.is`, so
 * a view must be reused across a state change that alters only host-only data
 * (the `failure` field); otherwise every such change would publish a new,
 * deep-equal client value and redraw the browser.
 */
const wireViews = new WeakMap<DevLeadProjectionState, DevLeadProjection>()

/**
 * Project one wire view from fold state. The result is memoized per state
 * object and reuses the retained state arrays, so the projection registry's
 * identity comparison suppresses unchanged pushes.
 * @param state - current fold state.
 * @returns the client view value.
 */
export function devLeadProjectionView(state: DevLeadProjectionState): DevLeadProjection {
  const cached = wireViews.get(state)
  if (cached !== undefined) return cached
  const view: DevLeadProjection = {
    enabled: state.enabled,
    sessions: state.sessions,
    notifications: state.notifications,
    reports: state.reports,
  }
  wireViews.set(state, view)
  return view
}

/**
 * Fold one committed Session event.
 *
 * Unrelated events return the same state reference. An invalid owned record
 * freezes the fold at the last valid state and records the failure once; the
 * frozen state reuses the previous wire view because `failure` is host-only.
 *
 * A valid `plugin:devlead/reset` record is the one owned record applied BEFORE
 * the freeze check: it discards every earlier DevLead record of the Session and
 * restarts the fold from `init`. That is the human recovery path for a
 * hand-edited or migrated log, so it must be foldable even when an earlier
 * record already froze the state. A malformed reset cannot unfreeze anything
 * (it would otherwise let a corrupt marker discard a damaged but recoverable
 * state) and leaves a frozen state frozen.
 * @param state - the projection covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next projection state.
 */
export function applyDevLeadProjection(
  state: DevLeadProjectionState,
  event: SessionEvent,
): DevLeadProjectionState {
  // Fork-inherited events are the parent's history, not this Session's state.
  // A forked subagent must never inherit DevLead mode or its watch set.
  if (event.seq < state.inheritedEventCount) return state
  const record = pluginRecordOf(event)
  if (record === undefined) return state
  if (record.type === DEVLEAD_RESET_RECORD_TYPE) {
    try {
      decodeResetRecord(record.data)
      return emptyDevLeadProjectionState(state.inheritedEventCount)
    } catch (error: unknown) {
      if (state.failure !== null) return state
      return freezeProjection(state, event, record.type, error)
    }
  }
  if (state.failure !== null) return state
  try {
    switch (record.type) {
      case DEVLEAD_MODE_RECORD_TYPE: {
        const mode = decodeModeRecord(record.data)
        return mode.enabled === state.enabled ? state : { ...state, enabled: mode.enabled }
      }
      case DEVLEAD_WATCH_RECORD_TYPE: {
        const watch = decodeWatchRecord(record.data)
        // A whole-value record may repeat the current set (a retried write or a
        // replayed log); keeping the state reference avoids a needless publish.
        return sameSessionIds(state.sessions, watch.sessions) ? state : { ...state, sessions: watch.sessions }
      }
      case DEVLEAD_NOTIFICATION_RECORD_TYPE: {
        const notification = decodeNotificationRecord(record.data)
        const notifications = retainNotification(state.notifications, notification)
        return notifications === state.notifications ? state : { ...state, notifications }
      }
      case DEVLEAD_REPORT_RECORD_TYPE: {
        const report = decodeReportRecord(record.data)
        const reports = retainReport(state.reports, report)
        return reports === state.reports ? state : { ...state, reports }
      }
      default:
        return state
    }
  } catch (error: unknown) {
    return freezeProjection(state, event, record.type, error)
  }
}

/**
 * Freeze a projection state on its first invalid owned record, retaining the
 * replay position and message that make the failure actionable.
 * @param state - last valid projection state.
 * @param event - event that failed to decode.
 * @param type - owned record type that failed.
 * @param error - thrown decoder failure.
 * @returns the frozen state.
 */
function freezeProjection(
  state: DevLeadProjectionState,
  event: SessionEvent,
  type: string,
  error: unknown,
): DevLeadProjectionState {
  const message = error instanceof Error ? error.message : String(error)
  const failure = {
    ...state,
    failure: `devlead replay failed at session event ${event.seq} (${type}): ${message}`,
  }
  // Host-only failure change: reuse the previous wire view so the registry's
  // Object.is comparison does not publish an unchanged client value.
  wireViews.set(failure, devLeadProjectionView(state))
  return failure
}

/** Registered projection unit serving `devLead` from the Session log. */
export const devLeadProjectionDefinition = {
  key: DEVLEAD_PROJECTION_KEY,
  stateSchema: devLeadProjectionStateSchema,
  // The unit owns no Session-metadata-derived state (the header is unused), but
  // it must remember the fork-inherited prefix length so inherited mode/watch
  // records never describe the forked Session.
  init: (_header?: SessionHeader, inheritedEventCount = 0) => emptyDevLeadProjectionState(inheritedEventCount),
  apply: applyDevLeadProjection,
  wire: {
    viewSchema: devLeadProjectionSchema,
    view: devLeadProjectionView,
    // The retained digest makes this value large, and only the open
    // conversation reads it: keep it out of every Session summary/list row.
    summary: false,
  },
  // 3: adds the fork-inherited prefix length (version 2 added reports); older
  // cache rows are discarded and refolded from the durable log.
  stateVersion: 3,
} satisfies ProjectionDefinition<'devLead', DevLeadProjectionState>

/**
 * Host-only fold state of the summary-sized `devLeadWatch` projection: the
 * lead's current watch set. It mirrors the digest unit's freeze semantics for
 * owned records, so a corrupt watch/mode log never paints watched rows from a
 * stale set.
 */
export interface DevLeadWatchProjectionState {
  /** Sessions this lead watches, in add order. */
  readonly sessions: readonly string[]
  /** First rejected persisted record, or null while the state is valid. */
  readonly failure: string | null
  /** Fork-inherited prefix length; inherited events never change the watch set. */
  readonly inheritedEventCount: number
}

/**
 * Empty watch-projection state: no watched Sessions, no failure.
 * @param inheritedEventCount - exact fork-inherited prefix length to ignore.
 * @returns the empty watch state for one Session.
 */
export function emptyDevLeadWatchProjectionState(inheritedEventCount = 0): DevLeadWatchProjectionState {
  return { sessions: [], failure: null, inheritedEventCount }
}

/** Persisted watch-projection state schema; seeds a fold and validates cached rows. */
export const devLeadWatchProjectionStateSchema: ZodType<DevLeadWatchProjectionState> = zod.object({
  sessions: zod.array(zod.string().min(1)).refine(
    sessions => new Set(sessions).size === sessions.length,
    { message: 'watch sessions must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
  inheritedEventCount: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict() as ZodType<DevLeadWatchProjectionState>

/** Client wire schema of the `devLeadWatch` projection value. */
export const devLeadWatchProjectionSchema: ZodType<DevLeadWatchProjection> = zod.object({
  sessions: zod.array(zod.string().min(1)).refine(
    sessions => new Set(sessions).size === sessions.length,
    { message: 'watch sessions must be unique' },
  ),
}).strict() as ZodType<DevLeadWatchProjection>

/**
 * Project one client view from watch fold state. Returning the state's own
 * immutable array keeps the registry's Object.is suppression effective for
 * records that do not change the watch set.
 * @param state - current watch fold state.
 * @returns the watch-set wire view.
 */
export function devLeadWatchProjectionView(state: DevLeadWatchProjectionState): DevLeadWatchProjection {
  return { sessions: state.sessions }
}

/**
 * Fold one committed Session event into the summary-sized watch projection.
 *
 * The fold follows the digest/mode units' freeze policy: a legal reset restarts
 * it, and every owned record is decoded strictly so a corrupt log freezes the
 * last valid watch set. Mode/notification/report records do not change this
 * unit's value, but decoding them keeps the units' failure boundaries aligned.
 * @param state - the projection covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next watch projection state.
 */
export function applyDevLeadWatchProjection(
  state: DevLeadWatchProjectionState,
  event: SessionEvent,
): DevLeadWatchProjectionState {
  if (event.seq < state.inheritedEventCount) return state
  const record = pluginRecordOf(event)
  if (record === undefined) return state
  if (record.type === DEVLEAD_RESET_RECORD_TYPE) {
    try {
      decodeResetRecord(record.data)
      return emptyDevLeadWatchProjectionState(state.inheritedEventCount)
    } catch (error: unknown) {
      if (state.failure !== null) return state
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...state,
        failure: `devlead watch replay failed at session event ${event.seq} (${record.type}): ${message}`,
      }
    }
  }
  if (state.failure !== null) return state
  try {
    switch (record.type) {
      case DEVLEAD_WATCH_RECORD_TYPE: {
        const watch = decodeWatchRecord(record.data)
        return sameSessionIds(state.sessions, watch.sessions)
          ? state
          : { sessions: watch.sessions, failure: null, inheritedEventCount: state.inheritedEventCount }
      }
      case DEVLEAD_MODE_RECORD_TYPE:
        decodeModeRecord(record.data)
        return state
      case DEVLEAD_NOTIFICATION_RECORD_TYPE:
        decodeNotificationRecord(record.data)
        return state
      case DEVLEAD_REPORT_RECORD_TYPE:
        decodeReportRecord(record.data)
        return state
      default:
        return state
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...state,
      failure: `devlead watch replay failed at session event ${event.seq} (${record.type}): ${message}`,
    }
  }
}

/** Registered projection unit serving the summary-sized `devLeadWatch` value. */
export const devLeadWatchProjectionDefinition = {
  key: DEVLEAD_WATCH_PROJECTION_KEY,
  stateSchema: devLeadWatchProjectionStateSchema,
  init: (_header?: SessionHeader, inheritedEventCount = 0) => emptyDevLeadWatchProjectionState(inheritedEventCount),
  apply: applyDevLeadWatchProjection,
  wire: {
    viewSchema: devLeadWatchProjectionSchema,
    view: devLeadWatchProjectionView,
  },
  // 2: adds the fork-inherited prefix length; version 1 was the initial
  // summary representation.
  stateVersion: 2,
} satisfies ProjectionDefinition<'devLeadWatch', DevLeadWatchProjectionState>

/**
 * Host-only fold state of the summary-sized `devLeadMode` projection. The
 * selection is the only client fact; `failure` mirrors the digest unit's
 * freezing rule, so both units freeze on the same corrupt log (the service
 * rejects reads while the failure is present; the frozen view keeps the last
 * valid selection, exactly like the digest unit).
 */
export interface DevLeadModeProjectionState {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
  /** First rejected persisted record, or null while the state is valid. */
  readonly failure: string | null
  /** Fork-inherited prefix length; inherited mode records never select this Session. */
  readonly inheritedEventCount: number
}

/**
 * Empty mode-projection state: disabled, no failure.
 * @param inheritedEventCount - exact fork-inherited prefix length to ignore.
 * @returns the empty mode state for one Session.
 */
export function emptyDevLeadModeProjectionState(inheritedEventCount = 0): DevLeadModeProjectionState {
  return { enabled: false, failure: null, inheritedEventCount }
}

/** Persisted mode-projection state schema; seeds a fold and validates cached rows. */
export const devLeadModeProjectionStateSchema: ZodType<DevLeadModeProjectionState> = zod.object({
  enabled: zod.boolean(),
  failure: zod.string().min(1).nullable(),
  inheritedEventCount: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict() as ZodType<DevLeadModeProjectionState>

/** Client wire schema of the `devLeadMode` projection value. */
export const devLeadModeProjectionSchema: ZodType<DevLeadModeProjection> = zod.object({
  enabled: zod.boolean(),
}).strict() as ZodType<DevLeadModeProjection>

/**
 * The two client views are shared constants: the registry suppresses a push
 * when the previous and current `wire.view` results are `Object.is`-equal, so a
 * mode-only unit must never mint a fresh object for an unchanged selection.
 */
const MODE_ENABLED_VIEW: DevLeadModeProjection = { enabled: true }
const MODE_DISABLED_VIEW: DevLeadModeProjection = { enabled: false }

/**
 * Project one client view from mode fold state.
 * @param state - current mode fold state.
 * @returns the shared enabled/disabled view.
 */
export function devLeadModeProjectionView(state: DevLeadModeProjectionState): DevLeadModeProjection {
  return state.enabled ? MODE_ENABLED_VIEW : MODE_DISABLED_VIEW
}

/**
 * Fold one committed Session event into the summary-sized mode projection.
 *
 * The fold follows the digest unit's failure policy: every owned record type is
 * decoded strictly (so the two units freeze on the same corrupt log), and the
 * first invalid one freezes the last valid selection. A valid reset record is
 * applied before that check and restarts the unit from its empty state, exactly
 * like the digest unit, so a recovered Session loses its damaged mark too.
 * @param state - the projection covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next mode projection state.
 */
export function applyDevLeadModeProjection(
  state: DevLeadModeProjectionState,
  event: SessionEvent,
): DevLeadModeProjectionState {
  if (event.seq < state.inheritedEventCount) return state
  const record = pluginRecordOf(event)
  if (record === undefined) return state
  if (record.type === DEVLEAD_RESET_RECORD_TYPE) {
    try {
      decodeResetRecord(record.data)
      return emptyDevLeadModeProjectionState(state.inheritedEventCount)
    } catch (error: unknown) {
      if (state.failure !== null) return state
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...state,
        failure: `devlead mode replay failed at session event ${event.seq} (${record.type}): ${message}`,
      }
    }
  }
  if (state.failure !== null) return state
  try {
    switch (record.type) {
      case DEVLEAD_MODE_RECORD_TYPE: {
        const mode = decodeModeRecord(record.data)
        return mode.enabled === state.enabled ? state : { enabled: mode.enabled, failure: null, inheritedEventCount: state.inheritedEventCount }
      }
      case DEVLEAD_WATCH_RECORD_TYPE:
        // Watch and notification records do not contribute to this projection;
        // they are decoded only to mirror the digest unit's freeze semantics.
        decodeWatchRecord(record.data)
        return state
      case DEVLEAD_NOTIFICATION_RECORD_TYPE:
        decodeNotificationRecord(record.data)
        return state
      case DEVLEAD_REPORT_RECORD_TYPE:
        decodeReportRecord(record.data)
        return state
      default:
        return state
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...state,
      failure: `devlead mode replay failed at session event ${event.seq} (${record.type}): ${message}`,
    }
  }
}

/**
 * Registered projection unit serving the summary-sized `devLeadMode` value.
 *
 * This unit exists because the digest unit is excluded from Session summaries
 * (the sidebar cannot carry up to 64 notifications per row), while the mode
 * selection itself is exactly the fact a Session-list row renders. The unit
 * declares no `wire.summary: false`, so every Session summary carries it.
 */
export const devLeadModeProjectionDefinition = {
  key: DEVLEAD_MODE_PROJECTION_KEY,
  stateSchema: devLeadModeProjectionStateSchema,
  init: (_header?: SessionHeader, inheritedEventCount = 0) => emptyDevLeadModeProjectionState(inheritedEventCount),
  apply: applyDevLeadModeProjection,
  wire: {
    viewSchema: devLeadModeProjectionSchema,
    view: devLeadModeProjectionView,
  },
  // 2: adds the fork-inherited prefix length; version 1 was the initial durable
  // representation of the compact mode selection.
  stateVersion: 2,
} satisfies ProjectionDefinition<'devLeadMode', DevLeadModeProjectionState>
