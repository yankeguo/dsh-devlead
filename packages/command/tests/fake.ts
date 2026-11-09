/**
 * Shared fake core service for the `/devlead` command tests.
 *
 * `FakeDevLead` implements the same public subset of `ctx.devLead` the command
 * drives (`DESIGN.md` §4), so the handler spec exercises grammar, resolution,
 * rendering, and error translation through the real registration path without
 * booting the harness.
 *
 * Signatures are derived from the real `DevLeadService` type, so a core
 * signature change fails this file instead of silently drifting.
 *
 * @module tests/fake
 */

import type { DevLeadService } from '@yankeguo/dsh-devlead'
import type {
  DevLeadNotification,
  DevLeadSessionView,
  DevLeadTransition,
  DevLeadWatchMutation,
} from '@yankeguo/dsh-devlead-protocol'

/** The exact live-Agent type the core service accepts. */
export type DevLeadCommandAgent = Parameters<DevLeadService['isEnabled']>[0]

/** Options accepted by the core Session listing, including its signal slot. */
export type DevLeadListSessionsOptions = NonNullable<Parameters<DevLeadService['listSessions']>[1]>

/**
 * Public core members the command drives. Declaring the fake against this slice
 * makes a core signature change fail to compile here instead of drifting
 * silently at runtime.
 */
type FakeDevLeadSurface = Pick<
  DevLeadService,
  | 'isEnabled'
  | 'setEnabled'
  | 'reset'
  | 'view'
  | 'listSessions'
  | 'getSession'
  | 'watchSession'
  | 'notifications'
  | 'worktreeIsolationAvailable'
>

/** Fixed epoch milliseconds used by every notification fixture. */
export const NOW = Date.UTC(2026, 10, 9, 2, 0, 0)

/** Stand-in for the core `DevLeadError`, matching its structural code shape. */
export class FakeDevLeadError extends Error {
  /** Stable domain error code. */
  readonly code: string

  /**
   * @param code - stable domain error code such as `DEVLEAD_SELF_WATCH`.
   * @param message - human-readable failure detail.
   */
  constructor(code: string, message = 'fake devlead failure') {
    super(message)
    this.name = 'FakeDevLeadError'
    this.code = code
  }
}

/**
 * Build one live-Agent stand-in carrying just the identity fields the command
 * reads. DSH agents share their Session id as the Agent id.
 */
export function fakeAgent(id = 'lead-agent', sessionId = id): DevLeadCommandAgent {
  return { id, session: { id: sessionId } } as unknown as DevLeadCommandAgent
}

/** Build one Session view fixture with deterministic inactive defaults. */
export function sessionView(
  sessionId: string,
  overrides: Partial<Omit<DevLeadSessionView, 'sessionId'>> = {},
): DevLeadSessionView {
  return {
    sessionId,
    live: false,
    running: false,
    watched: false,
    archived: false,
    ...overrides,
  } as DevLeadSessionView
}

/** Build one durable notification fixture with a deterministic identity. */
export function notification(
  input: {
    readonly sessionId?: string
    readonly title?: string
    readonly turn?: number
    readonly transition?: DevLeadTransition
    readonly at?: number
    readonly error?: string
  } = {},
): DevLeadNotification {
  const sessionId = input.sessionId ?? 'session-alpha'
  const turn = input.turn ?? 1
  const transition = input.transition ?? 'completed'
  return {
    id: `${sessionId}:${turn}:${transition}`,
    sessionId,
    turn,
    transition,
    at: input.at ?? NOW,
    ...(input.title === undefined ? {} : { sessionTitle: input.title }),
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

/**
 * In-memory `ctx.devLead` stand-in with the semantics the command relies on.
 * Every service call is appended to {@link calls} so specs can assert exact
 * forwarding (including that read-only paths do not write, and that a no-op
 * path does not call the service at all).
 */
export class FakeDevLead implements FakeDevLeadSurface {
  /** Current persistent mode switch. */
  enabled = false
  /** Whether the host reports the optional worktree-isolation capability. */
  worktreeIsolationAvailable = false
  /** Complete watch set, in add order. */
  watching: string[] = []
  /** Retained notification digest, oldest first. */
  feed: DevLeadNotification[] = []
  /** Every Session the host can list. */
  sessions: DevLeadSessionView[] = []
  /** Sessions the core can resolve but the bounded listing does not return. */
  extraSessions: DevLeadSessionView[] = []
  /**
   * Corrupt-replay failure text. While set, the fake behaves like a frozen
   * fold: reads reject with `DEVLEAD_PROJECTION_INVALID`, turning the mode on is
   * refused, and turning it off recovers by discarding the damaged state (the
   * fake's stand-in for the core's reset record).
   */
  frozenReason: string | null = null
  /** Ordered log of service calls made by the command. */
  readonly calls: string[] = []
  /** Options of every `listSessions` call, in call order. */
  readonly listSessionsOptions: DevLeadListSessionsOptions[] = []
  /** Signals of every `getSession` call, in call order. */
  readonly getSessionSignals: (AbortSignal | undefined)[] = []

  /**
   * Replace the retained feed with one fixture list.
   * @param notifications - notifications in oldest-first order.
   * @returns this fake, for chaining.
   */
  withNotifications(notifications: readonly DevLeadNotification[]): this {
    this.feed = [...notifications]
    return this
  }

  /**
   * Replace the listable Sessions.
   * @param sessions - Session views the host can describe.
   * @returns this fake, for chaining.
   */
  withSessions(sessions: readonly DevLeadSessionView[]): this {
    this.sessions = [...sessions]
    return this
  }

  /**
   * Replace the Sessions only the core resolver can see.
   * @param sessions - Session views excluded from the bounded listing.
   * @returns this fake, for chaining.
   */
  withExtraSessions(sessions: readonly DevLeadSessionView[]): this {
    this.extraSessions = [...sessions]
    return this
  }

  /**
   * Pre-seed this lead's watch set.
   * @param sessionIds - Session ids to watch.
   * @returns this fake, for chaining.
   */
  withWatching(sessionIds: readonly string[]): this {
    this.watching = [...sessionIds]
    return this
  }

  /** @inheritdoc */
  isEnabled(_agent: DevLeadCommandAgent): boolean {
    this.calls.push('isEnabled')
    return this.enabled
  }

  /** @inheritdoc */
  async setEnabled(_agent: DevLeadCommandAgent, enabled: boolean, _signal?: AbortSignal): Promise<void> {
    this.calls.push(`setEnabled:${enabled}`)
    if (this.frozenReason !== null) {
      // Mirrors the core recovery contract: dropping into disabled is the one
      // direction a frozen fold can keep honoring (it appends a reset record);
      // turning the mode on refuses instead of silently discarding the records.
      if (enabled) {
        throw new FakeDevLeadError(
          'DEVLEAD_PROJECTION_INVALID',
          `${this.frozenReason}; run /devlead reset first`,
        )
      }
      this.applyReset()
      return
    }
    this.enabled = enabled
  }

  /** @inheritdoc */
  async reset(_agent: DevLeadCommandAgent, _signal?: AbortSignal): Promise<void> {
    this.calls.push('reset')
    this.applyReset()
  }

  /** Drop every durable-looking fact exactly like a committed reset record. */
  private applyReset(): void {
    this.enabled = false
    this.watching = []
    this.feed = []
    this.frozenReason = null
  }

  /** @inheritdoc */
  view(_agent: DevLeadCommandAgent): {
    readonly enabled: boolean
    readonly sessions: readonly string[]
    readonly notifications: readonly DevLeadNotification[]
  } {
    this.calls.push('view')
    if (this.frozenReason !== null) {
      throw new FakeDevLeadError('DEVLEAD_PROJECTION_INVALID', this.frozenReason)
    }
    return {
      enabled: this.enabled,
      sessions: [...this.watching],
      notifications: [...this.feed],
    }
  }

  /** @inheritdoc */
  async listSessions(
    _agent: DevLeadCommandAgent,
    options: DevLeadListSessionsOptions = {},
  ): Promise<DevLeadSessionView[]> {
    this.calls.push(options.watchedOnly === true ? 'listSessions:watchedOnly' : 'listSessions')
    this.listSessionsOptions.push(options)
    const rows = options.watchedOnly === true
      ? [...this.sessions, ...this.extraSessions]
        .filter(session => this.watching.includes(session.sessionId))
      : [...this.sessions]
    return options.limit === undefined ? rows : rows.slice(0, options.limit)
  }

  /** @inheritdoc */
  async getSession(
    _agent: DevLeadCommandAgent,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DevLeadSessionView> {
    this.calls.push(`getSession:${sessionId}`)
    this.getSessionSignals.push(signal)
    const pool = [...this.sessions, ...this.extraSessions]
    const exact = pool.find(session => session.sessionId === sessionId)
    if (exact !== undefined) return exact
    const matches = pool.filter(session => session.sessionId.startsWith(sessionId))
    const first = matches[0]
    if (first === undefined) {
      throw new FakeDevLeadError('DEVLEAD_SESSION_NOT_FOUND', `no Session matches "${sessionId}"`)
    }
    if (matches.length > 1) {
      throw new FakeDevLeadError(
        'DEVLEAD_INVALID_INPUT',
        `Session prefix "${sessionId}" is ambiguous: ${matches.map(session => session.sessionId).join(', ')}`,
      )
    }
    return first
  }

  /** @inheritdoc */
  async watchSession(
    agent: DevLeadCommandAgent,
    sessionId: string,
    watching: boolean,
  ): Promise<DevLeadWatchMutation> {
    this.calls.push(`watchSession:${sessionId}:${watching}`)
    if (!this.enabled) throw new FakeDevLeadError('DEVLEAD_NOT_ENABLED', 'devlead mode is not enabled')
    // DSH mints one identity for the Session and its Agent; the core compares
    // the resolved Session id against `agent.id` for the self-watch guard.
    if (sessionId === agent.id) throw new FakeDevLeadError('DEVLEAD_SELF_WATCH', 'a DevLead Session cannot watch itself')
    // Adding needs an addressable Session; removing a stale watched id must
    // still work so the watch set can be cleaned up.
    if (watching && ![...this.sessions, ...this.extraSessions].some(session => session.sessionId === sessionId)) {
      throw new FakeDevLeadError('DEVLEAD_SESSION_NOT_FOUND', `no Session matches "${sessionId}"`)
    }
    this.watching = watching
      ? [...this.watching.filter(id => id !== sessionId), sessionId]
      : this.watching.filter(id => id !== sessionId)
    return { sessionId, watched: watching, sessions: [...this.watching] }
  }

  /** @inheritdoc */
  notifications(
    _agent: DevLeadCommandAgent,
    options: { readonly limit?: number } = {},
  ): DevLeadNotification[] {
    const limit = options.limit
    return limit === undefined ? [...this.feed] : this.feed.slice(-limit)
  }
}
