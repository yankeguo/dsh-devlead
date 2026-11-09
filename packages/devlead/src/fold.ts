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
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_PROJECTION_KEY,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import type {
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
}) as ZodType<DevLeadNotification>

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
 * Project one wire view from fold state; reuses the retained arrays so the
 * projection registry's identity comparison suppresses unchanged pushes.
 * @param state - current fold state.
 * @returns the client view value.
 */
export function devLeadProjectionView(state: DevLeadProjectionState): DevLeadProjection {
  return { enabled: state.enabled, sessions: state.sessions, notifications: state.notifications }
}

/**
 * Fold one committed Session event.
 *
 * Unrelated events return the same state reference. An invalid owned record
 * freezes the fold at the last valid state and records the failure once.
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
        return { ...state, sessions: watch.sessions }
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
    return {
      ...state,
      failure: `devlead replay failed at session event ${event.seq} (${record.type}): ${message}`,
    }
  }
}

/** Registered projection unit serving `devLead` from the Session log. */
export const devLeadProjectionDefinition = {
  key: DEVLEAD_PROJECTION_KEY,
  stateSchema: devLeadProjectionStateSchema,
  init: emptyDevLeadProjectionState,
  apply: applyDevLeadProjection,
  wire: {
    viewSchema: devLeadProjectionSchema,
    view: devLeadProjectionView,
  },
  // 1: the initial durable representation of the mode, watch set, and keyed
  // notification records.
  stateVersion: 1,
} satisfies ProjectionDefinition<'devLead', DevLeadProjectionState>
