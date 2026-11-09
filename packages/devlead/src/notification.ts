/**
 * Watched-session notification hub: keeps a reverse index from watched
 * Sessions to the DevLead Sessions that watch them, records one durable
 * notification per settled turn, and wakes each lead with a coalesced digest.
 *
 * Durable state lives in the lead's own Session log (`plugin:devlead/*`
 * records, folded by the `devLead` projection). This hub owns only the
 * process-local index, the batching window, and the wake-up transport: a lead
 * whose Agent is gone keeps its durable records and loses only the wake-up.
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
  DEVLEAD_ERROR_EXCERPT_MAX,
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_MODE_RECORD_TYPE,
  DEVLEAD_NOTIFICATION_RECORD_TYPE,
  DEVLEAD_WATCH_RECORD_TYPE,
  excerptLine,
  notificationLine,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadNotification, DevLeadProjectionState } from '@yankeguo/dsh-devlead-protocol'
import {
  createDevLeadNoticeMessage,
  devLeadNotification,
  failureExcerpt,
  notificationRecord,
} from './domain.ts'

/** Deployment policy the hub obeys. */
export interface DevLeadNotificationConfig {
  /** Coalescing window before one digest wake, in milliseconds (0 wakes on a microtask). */
  readonly batchMs: number
  /** Whether a cold lead Session is resumed to receive the digest. */
  readonly wakeColdSession: boolean
}

/** Process-local state of one live DevLead Session. */
interface LeadRuntime {
  readonly sessionId: string
  /** Watched Session ids in add order. */
  watched: Set<string>
  /** Notifications recorded but not yet delivered in a wake-up digest. */
  pending: DevLeadNotification[]
  /** Pending coalescing timer. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Whether one delivery is in flight. */
  flushing: boolean
}

/** Maximum digest lines a single wake-up message carries. */
const MAX_DIGEST_LINES = 12

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
  /** Live lead Sessions by identity. */
  private readonly leads = new Map<string, LeadRuntime>()
  /** Watched Session identity → lead Session identities watching it. */
  private readonly watchers = new Map<string, Set<string>>()
  /** Lead Sessions with an in-flight cold resume. */
  private readonly resuming = new Set<string>()
  /** Latest assistant excerpt observed per watched Session, bounded and pruned with the index. */
  private readonly lastAssistant = new Map<string, string>()
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

  /** Install the lifecycle listeners and index every currently live lead. */
  start(): void {
    this.bootstrap()
    this.ctx.effect(function* (this: DevLeadNotificationHub) {
      this.ctx.on('agent/created', ({ agent }): undefined => {
        this.syncLead(agent)
        return undefined
      })
      this.ctx.on('agent/disposed', ({ agent }) => { this.removeLead(String(agent.id)) })
      this.ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return
        const runtime = this.leads.get(String(agent.id))
        if (runtime === undefined || runtime.pending.length === 0) return
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
   * @param session - live Session.
   * @returns the fold state, or undefined when the projection is invalid.
   */
  private stateOf(session: Session): DevLeadProjectionState | undefined {
    const state = this.readState(session)
    if (state.failure !== null) {
      this.ctx.logger.warn(`devlead: ${state.failure}`)
      return undefined
    }
    return state
  }

  /**
   * Reconcile one live lead Agent with its durable state: register, update the
   * watch index, or drop the runtime when the mode is off.
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
    if (runtime.pending.length > 0) this.scheduleFlush(runtime)
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
      timer: undefined,
      flushing: false,
    }
    this.leads.set(sessionId, runtime)
    return runtime
  }

  /**
   * Replace one lead's watch set and update the reverse index.
   * @param runtime - lead runtime row.
   * @param sessions - complete durable watch set.
   */
  private setWatched(runtime: LeadRuntime, sessions: readonly string[]): void {
    const next = new Set(sessions)
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
    if (runtime.pending.length === 0) this.clearTimer(runtime)
  }

  /**
   * Drop one lead runtime and its reverse-index entries.
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
      this.leads.delete(leadId)
    }
    this.resuming.delete(leadId)
  }

  /** Clear one pending coalescing timer. */
  private clearTimer(runtime: LeadRuntime): void {
    if (runtime.timer === undefined) return
    clearTimeout(runtime.timer)
    runtime.timer = undefined
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
      && (record.type === DEVLEAD_MODE_RECORD_TYPE || record.type === DEVLEAD_WATCH_RECORD_TYPE)) {
      // A mode or watch record can be the first DevLead record of a Session
      // whose runtime row does not exist yet, so resolve the Agent instead of
      // only updating an already-registered lead.
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
    const text = blocks
      .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      .map(block => block.text)
      .join(' ')
    const excerpt = excerptLine(text, DEVLEAD_ERROR_EXCERPT_MAX)
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
    const reason = event.data.reason.kind
    const transition = reason === 'completed' || reason === 'aborted' || reason === 'blocked'
      || reason === 'error' || reason === 'max-tokens' || reason === 'interrupted' || reason === 'forked'
      ? reason
      : 'interrupted'
    const title = this.ctx.get('sessionTitle')?.get(session)?.title
    const error = reason === 'error' ? failureExcerpt(event.data.reason.error) : undefined
    const summary = this.lastAssistant.get(String(session.id))
    return devLeadNotification(
      String(session.id),
      title,
      transition,
      event.data.turn,
      event.time,
      error,
      summary,
    )
  }

  /**
   * Persist one notification into a lead Session and queue its wake-up.
   * @param leadId - lead Session identity.
   * @param notification - observed notification.
   */
  private record(leadId: string, notification: DevLeadNotification): void {
    const runtime = this.leads.get(leadId)
    const session = this.ctx.sessions.get(toSessionId(leadId))
    if (runtime === undefined || session === undefined) return
    try {
      appendPluginRecord(session, DEVLEAD_NOTIFICATION_RECORD_TYPE, notificationRecord(notification))
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not record a notification for lead "${leadId}": ${String(error)}`)
    }
    runtime.pending = [...runtime.pending, notification].slice(-DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    this.scheduleFlush(runtime)
  }

  /**
   * Arm the coalescing window for one lead.
   * @param runtime - lead runtime row.
   */
  private scheduleFlush(runtime: LeadRuntime): void {
    if (this.stopping || runtime.timer !== undefined || runtime.flushing) return
    if (this.config.batchMs <= 0) {
      queueMicrotask(() => { void this.flush(runtime) })
      return
    }
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      void this.flush(runtime)
    }, this.config.batchMs)
  }

  /**
   * Deliver one coalesced digest to a lead whose Agent is live.
   * @param runtime - lead runtime row.
   * @returns fulfillment after the delivery attempt settles.
   */
  private async flush(runtime: LeadRuntime): Promise<void> {
    if (this.stopping || runtime.flushing || runtime.pending.length === 0) return
    const agent = this.ctx.agents.get(toSessionId(runtime.sessionId))
    if (agent === undefined) {
      if (this.config.wakeColdSession) await this.resumeCold(runtime)
      return
    }
    // An archived lead cannot run a turn: the durable notifications stay in
    // the log and become visible again when the Session is restored.
    const archived = this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(toSessionId(runtime.sessionId)) ?? false
    if (archived) {
      runtime.pending = []
      return
    }
    const batch = runtime.pending
    runtime.pending = []
    runtime.flushing = true
    try {
      // A digest already waiting in the inbox already points the model at the
      // notification tool, so a second queued turn would only double the wake.
      if (!this.hasQueuedNotice(agent)) {
        agent.followup(createDevLeadNoticeMessage(renderDevLeadNotice(batch)))
        try {
          await this.ctx.sessions.flush(agent.session)
        } catch (error: unknown) {
          this.ctx.logger.warn(`devlead: notification digest was not flushed for lead "${runtime.sessionId}": ${String(error)}`)
        }
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not wake lead "${runtime.sessionId}": ${String(error)}`)
      runtime.pending = [...batch, ...runtime.pending].slice(-DEVLEAD_DEFAULT_NOTIFICATION_RETENTION)
    } finally {
      runtime.flushing = false
    }
    if (runtime.pending.length > 0) this.scheduleFlush(runtime)
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
    const leadId = runtime.sessionId
    if (this.resuming.has(leadId)) return
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) return
    this.resuming.add(leadId)
    try {
      const resolved = await controller.resolveAgent(toSessionId(leadId))
      if ('error' in resolved) {
        this.ctx.logger.warn(`devlead: could not resume lead "${leadId}": ${resolved.error.message}`)
        return
      }
      this.syncLead(resolved.agent)
    } catch (error: unknown) {
      this.ctx.logger.warn(`devlead: could not resume lead "${leadId}": ${String(error)}`)
    } finally {
      this.resuming.delete(leadId)
    }
  }
}
