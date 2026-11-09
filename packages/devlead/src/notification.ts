/**
 * Watched-session notification hub: keeps a reverse index from watched
 * Sessions to the DevLead Sessions that watch them, records one durable
 * notification per settled turn, and wakes each lead with a coalesced digest.
 *
 * Durable state lives in the lead's own Session log (`plugin:devlead/*`
 * records, folded by the `devLead` projection). This hub owns only the
 * process-local index, the batching window, and the wake-up transport. The index
 * is rebuilt from durable state at plugin load (`rehydrate`, fed by the
 * service's persisted-lead scan) and whenever a lead Session becomes live
 * (`agent/created`), so a Host restart or an `agent/disposed` does not stop a
 * watched Session from producing notifications:
 *
 * - a lead Session that is live can always append the durable record, which
 *   this hub then checkpoints fire-and-forget and queues for delivery;
 * - a cold lead (persisted but not attached, including one whose Agent was just
 *   disposed while the plugin keeps running) cannot append, so its
 *   notifications wait in `unsaved` and are written the moment the lead becomes
 *   live again (a resume, a human opening the Session, or a later cold wake).
 *
 * `pending` therefore means "already durable, waiting for its wake digest", and
 * `unsaved` means "observed, durable record not written yet".
 *
 * @module @yankeguo/dsh-devlead
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEVLEAD_DEFAULT_NOTIFICATION_RETENTION,
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  isDevLeadTransition,
  notificationLine,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadProjectionState } from '@yankeguo/dsh-devlead-protocol'
import {
  assistantExcerpt,
  createDevLeadNoticeMessage,
  DEVLEAD_RESET_RECORD_TYPE,
  devLeadNotification,
  failureExcerpt,
  notificationRecord,
  representableInstant,
} from './domain.ts'
import { thrownMessage } from './error.ts'

/** Deployment policy the hub obeys. */
export interface DevLeadNotificationConfig {
  /** Coalescing window before one digest wake, in milliseconds (0 wakes on a microtask). */
  readonly batchMs: number
  /** Whether a cold lead Session is resumed to receive its queued notifications. */
  readonly wakeColdSession: boolean
}

/** One persisted lead Session as the Host's durable scan reports it. */
export interface DevLeadPersistedLead {
  /** Lead Session identity. */
  readonly sessionId: string
  /** Complete durable watch set of that lead. */
  readonly watched: readonly string[]
}

/** Process-local state of one indexed DevLead Session. */
interface LeadRuntime {
  readonly sessionId: string
  /** Watched Session ids in add order. */
  watched: Set<string>
  /** Notifications already written to the lead's durable log, waiting for their wake digest. */
  pending: DevLeadNotification[]
  /**
   * Notifications observed while the lead Session was cold, so the durable
   * record could not be appended yet. Bounded like the durable digest; the
   * oldest entry is discarded first.
   */
  unsaved: DevLeadNotification[]
  /** Pending coalescing/retry timer. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Whether a zero-delay microtask flush is queued (the `batchMs: 0` path). */
  scheduled: boolean
  /** Whether one delivery is in flight. */
  flushing: boolean
}

/** Maximum digest lines a single wake-up message carries. */
const MAX_DIGEST_LINES = 12

/**
 * Retry delay after a failed wake-up delivery, or before re-checking a lead
 * whose inbox already carries an undelivered notice. A failed `followup` is
 * retried on this bounded timer instead of the coalescing window: with
 * `batchMs: 0` a zero-delay reschedule would spin a microtask loop for as long
 * as the Agent keeps rejecting messages. The same timer powers the D5 recheck:
 * a batch is kept pending instead of being dropped while a notice is queued.
 */
const DELIVERY_RETRY_MS = 1_000

/**
 * Maximum distinct Session ids whose corrupt replay warning is remembered for
 * the lifetime of one Host process. The set is bounded so a deployment that
 * opens many damaged Sessions cannot grow it without limit; FIFO eviction keeps
 * the most recently seen ids.
 */
export const DEVLEAD_MAX_WARNED_FAILURES = 256

/**
 * Render the wake-up digest text.
 * @param notifications - notifications delivered in this batch, oldest first.
 * @param total - total undelivered notifications at batch time.
 * @returns the model-facing notice text.
 */
export function renderDevLeadNotice(
  notifications: readonly DevLeadNotification[],
  total: number = notifications.length,
): string {
  const shown = notifications.slice(-MAX_DIGEST_LINES)
  const omitted = total - shown.length
  const lines = shown.map(notification => `- ${notificationLine(notification)}`)
  if (omitted > 0) lines.unshift(`- (${omitted} earlier notification(s) omitted; call devlead_notifications for the digest)`)
  return [
    '[DEV LEAD NOTIFICATION]',
    'Watched session activity changed outside this conversation. This is a runtime notice, not a human instruction.',
    ...lines,
    'Call devlead_notifications for the retained digest, or devlead_get_session for one session in detail. '
    + 'Decide what the Dev Lead should do next: continue an existing conversation, dispatch new work, or report to the human.',
  ].join('\n')
}

/**
 * Keep the reverse index and delivery queues for watched Sessions.
 *
 * One hub instance is owned by the core service and disposed with it.
 */
export class DevLeadNotificationHub {
  /** Indexed lead Sessions by identity. */
  private readonly leads = new Map<string, LeadRuntime>()
  /** Watched Session identity → lead Session identities watching it. */
  private readonly watchers = new Map<string, Set<string>>()
  /** Lead Sessions with an in-flight cold resume. */
  private readonly resuming = new Set<string>()
  /** Latest assistant excerpt observed per watched Session, bounded and pruned with the index. */
  private readonly lastAssistant = new Map<string, string>()
  /** Sessions whose replay failure has already been reported, so a corrupt log warns once per Host process. */
  private readonly warnedFailures = new Set<string>()
  /** Leads whose persisted watch set named themselves; warn once per live indexing. */
  private readonly warnedSelfWatch = new Set<string>()
  private started = false
  private stopping = false

  /**
   * @param ctx - host context providing the Agent registry and Session store.
   * @param readState - synchronous fold-state reader for one live Session.
   * @param config - batching and cold-wake policy.
   */
  constructor(
    private readonly ctx: Context,
    private readonly readState: (session: Session) => DevLeadProjectionState,
    private readonly config: DevLeadNotificationConfig,
  ) {}

  /**
   * Install the lifecycle listeners and index every currently live lead.
   * Calling this twice is a no-op: the hub owns exactly one listener set.
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.bootstrap()
    this.ctx.effect(function* (this: DevLeadNotificationHub) {
      this.ctx.on('agent/created', ({ agent }): undefined => {
        this.syncLead(agent)
        return undefined
      })
      // Deliberately no `agent/disposed` teardown: the watch set is durable, so
      // a disposed (cold) lead keeps observing the Sessions it watches. Its
      // runtime becomes a pending/unsaved queue that a resume (wakeColdSession)
      // or a human opening the Session drains; only a durable mode/reset change,
      // an unwatch, or hub disposal itself removes the index.
      this.ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return
        const runtime = this.leads.get(String(agent.id))
        if (runtime === undefined) return
        if (runtime.pending.length === 0 && runtime.unsaved.length === 0) return
        void this.flush(runtime)
      })
      this.ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
      yield () => {
        this.stopping = true
        for (const leadId of [...this.leads.keys()]) this.removeLead(leadId)
        this.resuming.clear()
      }
    }.bind(this), 'devlead: notification hub')
  }

  /**
   * Rebuild the watch index from durable state without requiring a live Agent
   * or Session (cold rehydration after a Host restart).
   *
   * Idempotent and safe before {@link start}: it only creates runtime rows and
   * replaces their watched sets, so calling it again with the same records is a
   * no-op.
   * @param leads - persisted lead records reported by the Host's durable scan.
   */
  rehydrate(leads: readonly DevLeadPersistedLead[]): void {
    if (this.stopping) return
    for (const lead of leads) {
      if (typeof lead.sessionId !== 'string' || lead.sessionId.length === 0) continue
      if (!Array.isArray(lead.watched)) continue
      const watched = lead.watched.filter((id): id is string => typeof id === 'string' && id.length > 0)
      const runtime = this.ensureLead(lead.sessionId)
      this.setWatched(runtime, watched)
    }
  }

  /**
   * Deliver any queued digest for one lead right now.
   * @param leadSessionId - lead Session identity.
   * @returns fulfillment after one delivery attempt settles.
   */
  async deliverNow(leadSessionId: string): Promise<void> {
    const runtime = this.leads.get(leadSessionId)
    if (runtime === undefined) return
    await this.flush(runtime)
  }

  /** Index every live lead Session at plugin load. */
  private bootstrap(): void {
    for (const agent of this.ctx.agents.list()) this.syncLead(agent)
  }

  /**
   * Read one Session's fold state, treating a replay failure as unavailable.
   *
   * A corrupt log is reported once per Session per Host process: the id stays in
   * the bounded warned set across disposal/reopen, and is only forgotten when a
   * later read returns a valid state (for example after a `/devlead reset`).
   * @param session - live Session.
   * @returns the fold state, or undefined when the projection is invalid.
   */
  private stateOf(session: Session): DevLeadProjectionState | undefined {
    const state = this.readState(session)
    const sessionId = String(session.id)
    if (state.failure !== null) {
      if (!this.warnedFailures.has(sessionId)) {
        this.warnedFailures.add(sessionId)
        this.trimWarnedFailures()
        this.ctx.logger.warn(`devlead: ${state.failure}`)
      }
      return undefined
    }
    this.warnedFailures.delete(sessionId)
    return state
  }

  /** Keep {@link warnedFailures} bounded, evicting the oldest ids first. */
  private trimWarnedFailures(): void {
    while (this.warnedFailures.size > DEVLEAD_MAX_WARNED_FAILURES) {
      const oldest = this.warnedFailures.values().next().value
      if (oldest === undefined) return
      this.warnedFailures.delete(oldest)
    }
  }

  /**
   * Reconcile one live lead Agent with its durable state: register, update the
   * watch index, or drop the runtime when the mode is off. A lead that becomes
   * live with queued work (notifications observed while it was cold) arms its
   * flush, so opening or resuming the Session writes the records and delivers
   * the digest.
   * @param agent - live Agent that may lead.
   */
  private syncLead(agent: Agent): void {
    if (this.stopping) return
    const sessionId = String(agent.id)
    const state = this.stateOf(agent.session)
    if (state === undefined || !state.enabled) {
      this.removeLead(sessionId)
      return
    }
    const runtime = this.ensureLead(sessionId)
    this.setWatched(runtime, state.sessions)
    if (runtime.pending.length > 0 || runtime.unsaved.length > 0) this.scheduleFlush(runtime)
  }

  /**
   * Create the runtime row for one lead Session.
   * @param sessionId - lead Session identity.
   * @returns the existing or new runtime row.
   */
  private ensureLead(sessionId: string): LeadRuntime {
    const existing = this.leads.get(sessionId)
    if (existing !== undefined) return existing
    const runtime: LeadRuntime = {
      sessionId,
      watched: new Set(),
      pending: [],
      unsaved: [],
      timer: undefined,
      scheduled: false,
      flushing: false,
    }
    this.leads.set(sessionId, runtime)
    return runtime
  }

  /**
   * Replace one lead's watch set and update the reverse index.
   *
   * The most recently observed durable set is authoritative: a notification of
   * a Session that is no longer watched is dropped from both queues. A watch set
   * that names its own lead (only possible through a hand-edited or migrated
   * log) is filtered here, with one warning per live indexing, because accepting
   * it would make each turn/end append to the event currently being published.
   * @param runtime - lead runtime row.
   * @param sessions - complete durable watch set.
   */
  private setWatched(runtime: LeadRuntime, sessions: readonly string[]): void {
    const selfWatched = sessions.includes(runtime.sessionId)
    if (selfWatched && !this.warnedSelfWatch.has(runtime.sessionId)) {
      this.warnedSelfWatch.add(runtime.sessionId)
      this.ctx.logger.warn(`devlead: lead "${runtime.sessionId}" lists itself in its persisted watch set; ignoring it`)
    }
    if (!selfWatched) this.warnedSelfWatch.delete(runtime.sessionId)
    const next = new Set(selfWatched ? sessions.filter(id => id !== runtime.sessionId) : sessions)
    for (const watched of runtime.watched) {
      if (next.has(watched)) continue
      const set = this.watchers.get(watched)
      if (set === undefined) continue
      set.delete(runtime.sessionId)
      if (set.size === 0) {
        this.watchers.delete(watched)
        this.lastAssistant.delete(watched)
      }
    }
    for (const watched of next) {
      if (runtime.watched.has(watched)) continue
      let set = this.watchers.get(watched)
      if (set === undefined) {
        set = new Set()
        this.watchers.set(watched, set)
      }
      set.add(runtime.sessionId)
    }
    runtime.watched = next
    // A Session that is no longer watched must not be named by a later digest
    // built from notifications observed before the change.
    runtime.pending = runtime.pending.filter(notification => next.has(notification.sessionId))
    runtime.unsaved = runtime.unsaved.filter(notification => next.has(notification.sessionId))
    if (runtime.pending.length === 0 && runtime.unsaved.length === 0) this.clearTimer(runtime)
  }

  /**
   * Drop one lead runtime and its reverse-index entries.
   *
   * The remembered corrupt-replay warnings deliberately survive this call: the
   * same damaged Session must not warn again just because its Agent was
   * disposed and reopened (only a valid state clears the marker).
   * @param leadId - lead Session identity.
   */
  private removeLead(leadId: string): void {
    const runtime = this.leads.get(leadId)
    if (runtime !== undefined) {
      this.clearTimer(runtime)
      for (const watched of runtime.watched) {
        const set = this.watchers.get(watched)
        if (set === undefined) continue
        set.delete(leadId)
        if (set.size === 0) {
          this.watchers.delete(watched)
          this.lastAssistant.delete(watched)
        }
      }
      runtime.pending = []
      runtime.unsaved = []
      this.leads.delete(leadId)
    }
    this.resuming.delete(leadId)
    this.warnedSelfWatch.delete(leadId)
  }

  /** Clear one pending coalescing/retry timer or queued zero-delay flush. */
  private clearTimer(runtime: LeadRuntime): void {
    if (runtime.timer !== undefined) {
      clearTimeout(runtime.timer)
      runtime.timer = undefined
    }
    runtime.scheduled = false
  }

  /**
   * Observe one committed Session event for lead-state changes and watched
   * turns.
   * @param session - Session whose log grew.
   * @param event - appended event.
   */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopping) return
    const sessionId = String(session.id)
    const record = pluginRecordOf(event)
    if (record !== undefined
      && (record.type === DEVLEAD_MODE_RECORD_TYPE
        || record.type === DEVLEAD_WATCH_RECORD_TYPE
        || record.type === DEVLEAD_RESET_RECORD_TYPE)) {
      // A mode/watch/reset record can be the first DevLead record of a Session
      // whose runtime row does not exist yet, so resolve the Agent instead of
      // only updating an already-registered lead. A reset record disables the
      // Session, so this resync drops its stale watch index.
      const agent = this.ctx.agents.get(session.id)
      if (agent !== undefined) this.syncLead(agent)
    }
    if (event.type === 'assistant/message') {
      if (this.watchers.has(sessionId)) this.rememberAssistant(sessionId, event.data.message.content)
      return
    }
    if (event.type !== 'turn/end') return
    const watchers = this.watchers.get(sessionId)
    if (watchers === undefined || watchers.size === 0) return
    const notification = this.notificationOf(session, event)
    if (notification === undefined) return
    for (const leadId of watchers) this.record(leadId, notification)
  }

  /**
   * Remember the latest assistant text of one watched Session.
   * @param sessionId - watched Session identity.
   * @param blocks - assistant message content blocks.
   */
  private rememberAssistant(sessionId: string, blocks: readonly unknown[]): void {
    const excerpt = assistantExcerpt(blocks)
    if (excerpt !== undefined) this.lastAssistant.set(sessionId, excerpt)
  }

  /**
   * Build one notification from a settled turn.
   * @param session - watched Session.
   * @param event - committed `turn/end` event.
   * @returns the notification, or undefined when the reason is not reportable.
   */
  private notificationOf(session: Session, event: SessionEvent): DevLeadNotification | undefined {
    if (event.type !== 'turn/end') return undefined
    const turn = event.data.turn
    // A settled-turn number is the notification identity: an unusable value
    // cannot be written into a record the fold would accept, so skip it.
    if (!Number.isSafeInteger(turn) || turn < 1) return undefined
    const reason = event.data.reason.kind
    // TurnEndReasonMap is merge-extensible: an unknown future kind degrades to
    // `interrupted` instead of dropping the transition notification.
    const transition = isDevLeadTransition(reason) ? reason : 'interrupted'
    const title = this.ctx.get('sessionTitle')?.get(session)?.title
    const error = reason === 'error' ? failureExcerpt(event.data.reason.error) : undefined
    const summary = this.lastAssistant.get(String(session.id))
    return devLeadNotification(
      String(session.id),
      title,
      transition,
      turn,
      representableInstant(event.time, Date.now()),
      error,
      summary,
    )
  }

  /**
   * Persist one notification into a lead Session and queue its wake-up.
   *
   * The durable row is written first whenever the lead Session's log is
   * attached (the digest stays the audit authority; the fold dedupes a replayed
   * identity). A cold lead Session (persisted but not attached) cannot append,
   * so the notification waits in `unsaved` until it becomes live. An identity
   * already queued in either queue is not queued twice, so a replayed
   * `turn/end` cannot double a digest line.
   * @param leadId - lead Session identity.
   * @param notification - observed notification.
   */
  private record(leadId: string, notification: DevLeadNotification): void {
    // Defensive: even if a runtime index were corrupted, never append to the
    // Session currently publishing the event (rc.1 rejects reentrant appends).
    if (notification.sessionId === leadId) return
    const runtime = this.leads.get(leadId)
    if (runtime === undefined) return
    const session = this.ctx.sessions.get(toSessionId(leadId))
    // Record first, then queue: a replayed turn/end keeps its durable audit row
    // (both rows stay in the log; the fold retains one) while the digest queues
    // the deterministic identity only once.
    if (session !== undefined) this.appendNotificationRecord(session, notification, leadId)
    if (runtime.pending.some(existing => existing.id === notification.id)) return
    if (runtime.unsaved.some(existing => existing.id === notification.id)) return
    if (session === undefined) {
      runtime.unsaved = [...runtime.unsaved, notification].slice(-DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
      this.scheduleFlush(runtime)
      return
    }
    runtime.pending = [...runtime.pending, notification].slice(-DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    this.scheduleFlush(runtime)
  }

  /**
   * Append one durable notification record and fire-and-forget its durability
   * checkpoint, shortening the crash window between the append and the digest
   * delivery. A failed append is a warning: the wake-up still happens (the
   * record may be lost, but the lead is not left unnotified).
   * @param session - lead Session receiving the record.
   * @param notification - notification to persist.
   * @param leadId - lead Session identity used in warnings.
   */
  private appendNotificationRecord(session: Session, notification: DevLeadNotification, leadId: string): void {
    try {
      appendPluginRecord(session, DEVLEAD_NOTIFICATION_RECORD_TYPE, notificationRecord(notification))
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not record a notification for lead "${leadId}": ${thrownMessage(error)}`)
      return
    }
    void this.checkpoint(session, leadId)
  }

  /**
   * Fire-and-forget one Session durability checkpoint.
   * @param session - Session whose buffered events should be persisted.
   * @param leadId - lead Session identity used in warnings.
   */
  private async checkpoint(session: Session, leadId: string): Promise<void> {
    try {
      await this.ctx.sessions.flush(session)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `devlead: recorded notification for lead "${leadId}" could not be flushed to persistence: ${thrownMessage(error)}`,
      )
    }
  }

  /**
   * Append the notifications that could not be persisted while the lead Session
   * was cold, moving each durable success into `pending`. A failed append keeps
   * the notification in `unsaved` and arms the bounded retry.
   * @param session - attached lead Session log receiving the records.
   * @param runtime - lead runtime row.
   */
  private persistUnsaved(session: Session, runtime: LeadRuntime): void {
    if (runtime.unsaved.length === 0) return
    const remaining: DevLeadNotification[] = []
    let appended = false
    for (const notification of runtime.unsaved) {
      try {
        appendPluginRecord(session, DEVLEAD_NOTIFICATION_RECORD_TYPE, notificationRecord(notification))
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `devlead: could not record a notification for lead "${runtime.sessionId}": ${thrownMessage(error)}`,
        )
        remaining.push(notification)
        continue
      }
      appended = true
      runtime.pending = [...runtime.pending, notification].slice(-DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    }
    runtime.unsaved = remaining
    if (appended) void this.checkpoint(session, runtime.sessionId)
    if (remaining.length > 0) this.scheduleRetry(runtime)
  }

  /**
   * Arm the coalescing window for one lead.
   * @param runtime - lead runtime row.
   */
  private scheduleFlush(runtime: LeadRuntime): void {
    if (this.stopping || runtime.timer !== undefined || runtime.scheduled || runtime.flushing) return
    if (this.config.batchMs <= 0) {
      runtime.scheduled = true
      queueMicrotask(() => {
        runtime.scheduled = false
        void this.flush(runtime)
      })
      return
    }
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      void this.flush(runtime)
    }, this.config.batchMs)
  }

  /**
   * Deliver one coalesced digest to a live lead, or resume an indexed-but-cold
   * lead when `wakeColdSession` is enabled.
   *
   * An archived lead is checked first and pauses delivery unconditionally: it is
   * never resumed, even when `wakeColdSession` is enabled. An archived lead whose
   * Session log is attached persists its cold observations (an archived Session
   * can still append) and then drops the in-memory queues; one that is fully
   * cold keeps them until it is unarchived and opened.
   *
   * A live lead first persists any notification observed while it was cold. The
   * digest is only taken when the lead's inbox holds no undelivered DevLead
   * notice: otherwise the batch stays pending and a bounded recheck timer is
   * armed, so a second batch can never be silently dropped while the first wake
   * is still queued (D5). The durable digest stays visible once the Session is
   * restored.
   * @param runtime - lead runtime row.
   * @returns fulfillment after the delivery attempt settles.
   */
  private async flush(runtime: LeadRuntime): Promise<void> {
    if (this.stopping) return
    // A queued zero-delay flush can outlive its runtime: a mode toggle or Agent
    // disposal drops the runtime but cannot cancel the microtask.
    if (this.leads.get(runtime.sessionId) !== runtime) return
    if (runtime.flushing) return
    if (runtime.pending.length === 0 && runtime.unsaved.length === 0) return
    const leadSessionId = toSessionId(runtime.sessionId)
    // An archived lead is paused, and that must win over the cold-wake policy: a
    // cold archived lead is never auto-resumed just to receive a digest. When
    // its Session log is attached it can still append what it observed while
    // cold (durable digest stays complete), then the in-memory wake queues are
    // dropped. A cold archived lead keeps its queues in memory until it is
    // unarchived and opened (a restart loses only that in-memory portion).
    const archived = this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(leadSessionId) ?? false
    if (archived) {
      const session = this.ctx.sessions.get(leadSessionId) ?? this.ctx.agents.get(leadSessionId)?.session
      if (session !== undefined) {
        this.persistUnsaved(session, runtime)
        runtime.pending = []
        runtime.unsaved = []
      }
      this.clearTimer(runtime)
      return
    }
    const agent = this.ctx.agents.get(leadSessionId)
    if (agent === undefined) {
      if (this.config.wakeColdSession) await this.resumeCold(runtime)
      return
    }
    this.persistUnsaved(agent.session, runtime)
    if (runtime.pending.length === 0) return
    if (this.hasQueuedNotice(agent)) {
      // The batch stays pending: a notice already in the inbox will point the
      // model at the durable digest. Re-check on the bounded retry timer, and
      // let the idle-status hook deliver immediately if the notice is consumed
      // or cancelled first.
      this.scheduleRetry(runtime)
      return
    }
    const batch = runtime.pending
    runtime.pending = []
    this.clearTimer(runtime)
    runtime.flushing = true
    let failed = false
    try {
      agent.followup(createDevLeadNoticeMessage(renderDevLeadNotice(batch)))
      try {
        // False means no durability participant is composed (headless/SDK),
        // not a persistence failure; only a composed participant's rejection
        // is worth reporting.
        await this.ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        this.ctx.logger.warn(`devlead: notification digest could not be flushed for lead "${runtime.sessionId}": ${thrownMessage(error)}`)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not wake lead "${runtime.sessionId}": ${thrownMessage(error)}`)
      runtime.pending = [...batch, ...runtime.pending].slice(-DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
      failed = true
    } finally {
      runtime.flushing = false
    }
    if ((runtime.pending.length > 0 || runtime.unsaved.length > 0)
      && this.leads.get(runtime.sessionId) === runtime) {
      if (failed || runtime.unsaved.length > 0) {
        this.scheduleRetry(runtime)
      } else {
        this.scheduleFlush(runtime)
      }
    }
  }

  /**
   * Arm one bounded retry: a failed wake-up delivery, or a recheck of a batch
   * kept pending behind an undelivered inbox notice.
   * @param runtime - lead runtime row.
   */
  private scheduleRetry(runtime: LeadRuntime): void {
    if (this.stopping || runtime.timer !== undefined || runtime.scheduled || runtime.flushing) return
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      void this.flush(runtime)
    }, DELIVERY_RETRY_MS)
  }

  /**
   * Whether one lead Agent already holds an undelivered digest notice.
   * @param agent - live lead Agent.
   * @returns whether either inbox boundary carries a DevLead notice.
   */
  private hasQueuedNotice(agent: Agent): boolean {
    return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => {
      const source = message.source as { kind?: unknown; form?: unknown }
      return source.kind === DEVLEAD_MESSAGE_KIND && source.form === 'notice'
    })
  }

  /**
   * Resume one cold lead Session so it can receive its queued digest.
   * @param runtime - lead runtime row.
   * @returns fulfillment after the resume attempt settles.
   */
  private async resumeCold(runtime: LeadRuntime): Promise<void> {
    if (this.stopping) return
    const leadId = runtime.sessionId
    if (this.resuming.has(leadId)) return
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) return
    this.resuming.add(leadId)
    try {
      const resolved = await controller.resolveAgent(toSessionId(leadId))
      if (this.stopping) return
      if ('error' in resolved) {
        this.ctx.logger.warn(`devlead: could not resume lead "${leadId}": ${resolved.error.message}`)
        return
      }
      // The queued digest stays pending: syncLead re-arms the flush once the
      // resumed Agent is indexed, and `flush` persists any unsaved record then.
      this.syncLead(resolved.agent)
    } catch (error: unknown) {
      if (!this.stopping) {
        this.ctx.logger.warn(`devlead: could not resume lead "${leadId}": ${thrownMessage(error)}`)
      }
    } finally {
      this.resuming.delete(leadId)
    }
  }
}
