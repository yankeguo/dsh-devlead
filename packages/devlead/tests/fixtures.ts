/**
 * Deterministic fixtures for the DevLead fold tests.
 *
 * Every timestamp is explicit and every event is built in memory: the fold is
 * pure, so no Session, service, timer, or wall clock is involved.
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadTransition } from '@yankeguo/dsh-devlead-protocol'
import {
  devLeadNotification,
  modeRecord,
  notificationRecord,
  watchRecord,
} from '../src/domain.ts'

/** Fixed epoch base for every fixture timestamp. */
export const T0 = 1_700_000_000_000

/**
 * Build one plugin-record session event with an arbitrary payload.
 *
 * The record representation is what a real Session stores; `ignorable: true`
 * is the persistence-compat invariant that keeps the log reloadable.
 * @param seq - log position.
 * @param type - record type name, `plugin:` prefixed for plugin records.
 * @param data - committed payload.
 * @param time - event timestamp in epoch milliseconds.
 * @returns the hand-built committed event.
 */
export function pluginRecordEvent(seq: number, type: string, data: unknown, time: number = T0): SessionEvent {
  return {
    type,
    seq: SessionSeq(seq),
    time,
    data,
    ignorable: true,
  } as unknown as SessionEvent
}

/**
 * Build one known-type committed event with an arbitrary payload.
 * @param seq - log position.
 * @param type - known Session event type name.
 * @param data - committed payload.
 * @param time - event timestamp in epoch milliseconds.
 * @returns the hand-built committed event.
 */
export function sessionEvent(seq: number, type: string, data: unknown, time: number = T0): SessionEvent {
  return { type, seq: SessionSeq(seq), time, data } as unknown as SessionEvent
}

/**
 * Build one durable mode record event from its typed payload.
 * @param seq - log position.
 * @param enabled - selected mode.
 * @param time - event timestamp in epoch milliseconds.
 * @returns the committed event.
 */
export function modeEvent(seq: number, enabled: boolean, time: number = T0): SessionEvent {
  return pluginRecordEvent(seq, DEVLEAD_MODE_RECORD_TYPE, modeRecord(enabled, time), time)
}

/**
 * Build one durable whole-value watch record event.
 * @param seq - log position.
 * @param sessions - complete watch set after the mutation.
 * @param time - event timestamp in epoch milliseconds.
 * @returns the committed event.
 */
export function watchEvent(seq: number, sessions: readonly string[], time: number = T0): SessionEvent {
  return pluginRecordEvent(seq, DEVLEAD_WATCH_RECORD_TYPE, watchRecord(sessions, time), time)
}

/**
 * Build one durable notification record event.
 * @param seq - log position.
 * @param notification - observed notification.
 * @param time - event timestamp in epoch milliseconds.
 * @returns the committed event.
 */
export function notificationEvent(
  seq: number,
  notification: DevLeadNotification,
  time: number = T0,
): SessionEvent {
  return pluginRecordEvent(seq, DEVLEAD_NOTIFICATION_RECORD_TYPE, notificationRecord(notification), time)
}

/** Explicit overrides accepted by {@link notification}. */
export interface NotificationOverrides {
  sessionId?: string
  sessionTitle?: string
  turn?: number
  transition?: DevLeadTransition
  at?: number
  error?: string
  summary?: string
}

/**
 * Build one notification fixture with a deterministic identity.
 * @param overrides - explicit field overrides.
 * @returns the notification.
 */
export function notification(overrides: NotificationOverrides = {}): DevLeadNotification {
  return devLeadNotification(
    overrides.sessionId ?? 'session-alpha',
    overrides.sessionTitle,
    overrides.transition ?? 'completed',
    overrides.turn ?? 1,
    overrides.at ?? T0,
    overrides.error,
    overrides.summary,
  )
}

/**
 * Build one unrelated committed event the fold must ignore by reference.
 * @param seq - log position.
 * @param time - event timestamp in epoch milliseconds.
 * @returns the committed event.
 */
export function turnStartEvent(seq: number, time: number = T0): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time, data: { turn: 1 } } as unknown as SessionEvent
}

/**
 * Build one valid plugin record owned by another plugin, which the fold must
 * ignore by reference.
 * @param seq - log position.
 * @param time - event timestamp in epoch milliseconds.
 * @returns the committed event.
 */
export function foreignPluginEvent(seq: number, time: number = T0): SessionEvent {
  return pluginRecordEvent(seq, 'plugin:other-plugin/state', { kind: 'other-plugin/state' }, time)
}

/**
 * Build one unmarked unknown event: no `ignorable` marker, so it is not a
 * plugin record and the fold must ignore it by reference.
 * @param seq - log position.
 * @param time - event timestamp in epoch milliseconds.
 * @returns the committed event.
 */
export function unmarkedEvent(seq: number, time: number = T0): SessionEvent {
  return {
    type: 'plugin:devlead/mode',
    seq: SessionSeq(seq),
    time,
    data: modeRecord(true, time),
  } as unknown as SessionEvent
}
