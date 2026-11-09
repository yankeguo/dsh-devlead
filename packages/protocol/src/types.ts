/**
 * Host-and-browser shared vocabulary of the DevLead plugin suite: the durable
 * plugin-record payloads, the `devLead` Session projection values, the
 * model-facing tool views, and the formatting rules both the Host prompt
 * builder and the browser status strip use.
 *
 * No DSH package is imported at runtime: the browser bundle resolves this
 * module too, so it stays pure types plus pure functions. The single DSH
 * `import type` below is erased at compile time and exists only for the
 * projection-map augmentation.
 *
 * @module @yankeguo/dsh-devlead-protocol
 */

// Type-only: erased before any bundler sees it, so the browser half stays free
// of DSH runtime imports.
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/** Persistent `plugin:` record carrying the current DevLead selection. */
export const DEVLEAD_MODE_RECORD_TYPE = 'plugin:devlead/mode'

/** Persistent `plugin:` record carrying the complete watched-session set. */
export const DEVLEAD_WATCH_RECORD_TYPE = 'plugin:devlead/watch'

/** Persistent `plugin:` record carrying one watched-session notification. */
export const DEVLEAD_NOTIFICATION_RECORD_TYPE = 'plugin:devlead/notification'

/** Version stamped on every durable DevLead record. */
export const DEVLEAD_RECORD_VERSION = 1

/** Session projection key serving the DevLead view to the browser. */
export const DEVLEAD_PROJECTION_KEY = 'devLead'

/**
 * Session projection key carrying only the mode selection. It is small enough
 * for every Session summary, so the sidebar's per-row DevLead mark can read it
 * for cold Sessions too; the retained digest stays behind the excluded
 * {@link DEVLEAD_PROJECTION_KEY} view.
 */
export const DEVLEAD_MODE_PROJECTION_KEY = 'devLeadMode'

/** Human command that toggles and inspects DevLead mode. */
export const DEVLEAD_COMMAND_NAME = 'devlead'

/** Message source kind attributed to every DevLead-authored user message. */
export const DEVLEAD_MESSAGE_KIND = 'devlead'

/** Prefix shared by every model tool this plugin exposes. */
export const DEVLEAD_TOOL_PREFIX = 'devlead_'

/** Deployment default of the maximum watched sessions per lead. */
export const DEVLEAD_DEFAULT_MAX_WATCHED = 64

/** Deployment default of the retained notification digest length. */
export const DEVLEAD_DEFAULT_NOTIFICATION_RETENTION = 64

/** Longest single-line error excerpt stored on one notification. */
export const DEVLEAD_ERROR_EXCERPT_MAX = 240

/**
 * How one watched Session transition ended. Mirrors the durable
 * `TurnEndReason` union without importing the Session types.
 *
 * The Host maps a future `TurnEndReason` kind it cannot name to `interrupted`
 * before writing a notification; the browser instead renders an unrecognized
 * literal with the neutral `transition.unknown` label, so wire drift never
 * breaks the strip.
 */
export type DevLeadTransition =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'
  | 'forked'

/** One transition of a watched Session that the lead is notified about. */
export interface DevLeadNotification {
  /** Deterministic identity: `<sessionId>:<turn>:<transition>`. */
  readonly id: string
  /** Session whose turn settled. */
  readonly sessionId: string
  /** Session title at notification time, when the Host could fold one. */
  readonly sessionTitle?: string
  /** How the turn ended. */
  readonly transition: DevLeadTransition
  /** 1-based turn number that settled. */
  readonly turn: number
  /** Epoch milliseconds recorded on the settling `turn/end` event. */
  readonly at: number
  /** Compact single-line failure excerpt, recorded by the Host for `error` transitions. */
  readonly error?: string
  /** Compact single-line excerpt of the latest assistant message before the turn settled. */
  readonly summary?: string
}

/** Durable record payload selecting DevLead mode for one Session. */
export interface DevLeadModeRecord {
  /** Record discriminator. */
  readonly kind: 'devlead/mode'
  /** Durable payload version; the fold rejects any other value. */
  readonly version: typeof DEVLEAD_RECORD_VERSION
  /** Whether DevLead mode was selected. */
  readonly enabled: boolean
  /** Epoch milliseconds of the recorded change. */
  readonly at: number
}

/** Durable record payload replacing the complete watched-session set. */
export interface DevLeadWatchRecord {
  /** Record discriminator. */
  readonly kind: 'devlead/watch'
  /** Durable payload version; the fold rejects any other value. */
  readonly version: typeof DEVLEAD_RECORD_VERSION
  /** Complete watch set after the mutation, in add order. */
  readonly sessions: readonly string[]
  /** Epoch milliseconds of the recorded change. */
  readonly at: number
}

/** Durable record payload appending one watched-session notification. */
export interface DevLeadNotificationRecord {
  /** Record discriminator. */
  readonly kind: 'devlead/notification'
  /** Durable payload version; the fold rejects any other value. */
  readonly version: typeof DEVLEAD_RECORD_VERSION
  /** Notification appended to the lead's retained digest. */
  readonly notification: DevLeadNotification
}

/** Union of every durable payload written under `plugin:devlead/*` records. */
export type DevLeadRecord = DevLeadModeRecord | DevLeadWatchRecord | DevLeadNotificationRecord

/** Strict Host fold state of one Session's DevLead records. */
export interface DevLeadProjectionState {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
  /** Watched Session ids in add order. */
  readonly sessions: readonly string[]
  /** Retained notifications, oldest first. */
  readonly notifications: readonly DevLeadNotification[]
  /** First rejected persisted record, or null while the state is valid. */
  readonly failure: string | null
}

/** Client view published through the `devLead` Session projection. */
export interface DevLeadProjection {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
  /** Watched Session ids in add order. */
  readonly sessions: readonly string[]
  /** Retained notifications, oldest first. */
  readonly notifications: readonly DevLeadNotification[]
}

/**
 * Client view published through the summary-sized `devLeadMode` Session
 * projection: exactly the fact a Session-list row may render.
 */
export interface DevLeadModeProjection {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
}

/** One registered DSH Workspace as the model tool reports it. */
export interface DevLeadWorkspaceView {
  /** Stable Workspace record id. */
  readonly workspaceId: string
  /** Display title. */
  readonly title: string
  /** Canonical directory path. */
  readonly path: string
  /** Live directory check result. */
  readonly status: 'ok' | 'missing-dir'
  /** Sessions the registry currently accounts to this Workspace. */
  readonly sessionIds: readonly string[]
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant of the last durable mutation. */
  readonly updatedAt: string
}

/**
 * One Session as the model tool reports it. Optional facts are omitted when
 * the Host could not fold them without activating the Session.
 */
export interface DevLeadSessionView {
  /** Session identity. */
  readonly sessionId: string
  /** Latest folded title, when one exists. */
  readonly title?: string
  /** Accounting Workspace id, when the Session belongs to one. */
  readonly workspaceId?: string
  /** Accounting Workspace title, when the Session belongs to one. */
  readonly workspaceTitle?: string
  /** Recorded working directory, when the header carries one. */
  readonly cwd?: string
  /** Whether the Session is currently live in the Host store (an Agent or an attached Session). */
  readonly live: boolean
  /** Whether the Session's Agent is inside a turn (always false without a live Agent). */
  readonly running: boolean
  /** Whether this lead watches the Session. */
  readonly watched: boolean
  /** Whether the Workspace registry lists the Session as archived. */
  readonly archived: boolean
  /** Latest recorded turn number, when the log was observed. */
  readonly lastTurn?: number
  /** Pending inbox messages, when the Agent is live. */
  readonly pendingInputs?: number
  /** How the latest recorded turn ended, when the log was observed. */
  readonly lastTransition?: DevLeadTransition
  /** Compact error excerpt of the latest failed turn, when one was recorded. */
  readonly lastError?: string
  /** Compact excerpt of the latest assistant message, when the log was observed. */
  readonly lastAssistant?: string
  /** Epoch milliseconds of the latest durable activity, when known. */
  readonly updatedAt?: number
  /** Epoch milliseconds of Session creation, when known. */
  readonly createdAt?: number
}

/** Request shape of one token-less Session creation inside a Workspace. */
export interface DevLeadCreateSessionRequest {
  /** Target Workspace id or registered path. Omitted uses the lead's own directory. */
  readonly workspace?: string
  /** Optional initial prompt the new Session runs immediately. */
  readonly prompt?: string
  /** Optional display title recorded through the Session title service. */
  readonly title?: string
  /** Whether the lead watches the new Session. Defaults to true. */
  readonly watch?: boolean
  /** Optional Agent preset id. */
  readonly preset?: string
}

/** Result of one DevLead session creation. */
export interface DevLeadCreatedSession {
  /** Created or reused Session identity. */
  readonly session: DevLeadSessionView
  /** Workspace the Session was placed in. */
  readonly workspace: DevLeadWorkspaceView
  /** Whether an initial prompt was admitted. */
  readonly prompted: boolean
}

/** One watch-set mutation result. */
export interface DevLeadWatchMutation {
  /** Session identity the call addressed. */
  readonly sessionId: string
  /** Whether the Session is watched after the mutation. */
  readonly watched: boolean
  /** Complete watch set after the mutation. */
  readonly sessions: readonly string[]
}

/** One admitted prompt into an existing Session. */
export interface DevLeadPromptedSession {
  /** Addressed Session identity. */
  readonly sessionId: string
  /** Whether the Session is watched after the mutation. */
  readonly watched: boolean
  /** Whether the Host had to resume a cold Session to admit the prompt. */
  readonly resumed: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The Session's durable DevLead selection, watched-session set, and
     * retained notification digest. Always present (defaults to disabled) and
     * folded from `plugin:devlead/*` records.
     *
     * Excluded from Session summaries: the retained digest is what makes this
     * value large (up to 64 notifications) and only the open conversation reads
     * it, so Session list rows and summary payloads do not carry it. The unit
     * declares the matching `wire.summary: false`.
     */
    devLead: SessionProjectionSummaryExcluded<DevLeadProjection>
    /**
     * The Session's durable DevLead selection alone. Deliberately summary-sized:
     * the sidebar renders one mark per listed Session row, and a row must not
     * carry the retained notification digest. The unit declares no
     * `wire.summary: false`, so every Session summary carries this key.
     */
    devLeadMode: DevLeadModeProjection
  }
}
