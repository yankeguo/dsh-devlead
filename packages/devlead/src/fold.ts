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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import {
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_MODE_PROJECTION_KEY,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_PROJECTION_KEY,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import type {
  DevLeadModeProjection,
  DevLeadNotification,
  DevLeadProjection,
  DevLeadProjectionState,
} from '@yankeguo/dsh-devlead-protocol'
import { decodeModeRecord, decodeNotificationRecord, decodeWatchRecord } from './domain.ts'

/** Empty projection state: disabled, watching nothing, no notifications. */
export function emptyDevLeadProjectionState(): DevLeadProjectionState {
  return { enabled: false, sessions: [], notifications: [], failure: null }
}

/** Wire schema validating one retained notification before it leaves the Host. */
const notificationSchema: ZodType<DevLeadNotification> = zod.object({
  id: zod.string().min(1),
  sessionId: zod.string().min(1),
  sessionTitle: zod.string().min(1).optional(),
  transition: zod.enum([
    'completed',
    'aborted',
    'blocked',
    'error',
    'max-tokens',
    'interrupted',
    'forked',
  ]),
  turn: zod.number().int().positive(),
  at: zod.number().int().nonnegative(),
  error: zod.string().min(1).optional(),
  summary: zod.string().min(1).optional(),
}).strict() as ZodType<DevLeadNotification>

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
  sessions: zod.array(zod.string().min(1)),
  notifications: zod.array(notificationSchema),
  failure: zod.string().min(1).nullable(),
}).strict() as ZodType<DevLeadProjectionState>

/** Client wire schema of the `devLead` projection value. */
export const devLeadProjectionSchema: ZodType<DevLeadProjection> = zod.object({
  enabled: zod.boolean(),
  sessions: zod.array(zod.string().min(1)),
  notifications: zod.array(notificationSchema),
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
 * @param state - the projection covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next projection state.
 */
export function applyDevLeadProjection(
  state: DevLeadProjectionState,
  event: SessionEvent,
): DevLeadProjectionState {
  if (state.failure !== null) return state
  const record = pluginRecordOf(event)
  if (record === undefined) return state
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
      default:
        return state
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const failure = {
      ...state,
      failure: `devlead replay failed at session event ${event.seq} (${record.type}): ${message}`,
    }
    wireViews.set(failure, devLeadProjectionView(state))
    return failure
  }
}

/** Registered projection unit serving `devLead` from the Session log. */
export const devLeadProjectionDefinition = {
  key: DEVLEAD_PROJECTION_KEY,
  stateSchema: devLeadProjectionStateSchema,
  // The unit owns no Session-metadata-derived state, so it ignores the header
  // and inherited-prefix arguments the registry passes.
  init: emptyDevLeadProjectionState,
  apply: applyDevLeadProjection,
  wire: {
    viewSchema: devLeadProjectionSchema,
    view: devLeadProjectionView,
    // The retained digest makes this value large, and only the open
    // conversation reads it: keep it out of every Session summary/list row.
    summary: false,
  },
  // 1: the initial durable representation of the mode, watch set, and keyed
  // notification records.
  stateVersion: 1,
} satisfies ProjectionDefinition<'devLead', DevLeadProjectionState>

/**
 * Host-only fold state of the summary-sized `devLeadMode` projection. The
 * selection is the only client fact; `failure` mirrors the digest unit's
 * freezing rule so a corrupt log cannot paint a stale "enabled" mark either.
 */
export interface DevLeadModeProjectionState {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
  /** First rejected persisted record, or null while the state is valid. */
  readonly failure: string | null
}

/** Empty mode-projection state: disabled, no failure. */
export function emptyDevLeadModeProjectionState(): DevLeadModeProjectionState {
  return { enabled: false, failure: null }
}

/** Persisted mode-projection state schema; seeds a fold and validates cached rows. */
export const devLeadModeProjectionStateSchema: ZodType<DevLeadModeProjectionState> = zod.object({
  enabled: zod.boolean(),
  failure: zod.string().min(1).nullable(),
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
 * first invalid one freezes the last valid selection.
 * @param state - the projection covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next mode projection state.
 */
export function applyDevLeadModeProjection(
  state: DevLeadModeProjectionState,
  event: SessionEvent,
): DevLeadModeProjectionState {
  if (state.failure !== null) return state
  const record = pluginRecordOf(event)
  if (record === undefined) return state
  try {
    switch (record.type) {
      case DEVLEAD_MODE_RECORD_TYPE: {
        const mode = decodeModeRecord(record.data)
        return mode.enabled === state.enabled ? state : { enabled: mode.enabled, failure: null }
      }
      case DEVLEAD_WATCH_RECORD_TYPE:
        // Watch and notification records do not contribute to this projection;
        // they are decoded only to mirror the digest unit's freeze semantics.
        decodeWatchRecord(record.data)
        return state
      case DEVLEAD_NOTIFICATION_RECORD_TYPE:
        decodeNotificationRecord(record.data)
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
  // The unit owns no Session-metadata-derived state, so it ignores the header
  // and inherited-prefix arguments the registry passes.
  init: emptyDevLeadModeProjectionState,
  apply: applyDevLeadModeProjection,
  wire: {
    viewSchema: devLeadModeProjectionSchema,
    view: devLeadModeProjectionView,
  },
  // 1: the initial durable representation of the compact mode selection.
  stateVersion: 1,
} satisfies ProjectionDefinition<'devLeadMode', DevLeadModeProjectionState>
