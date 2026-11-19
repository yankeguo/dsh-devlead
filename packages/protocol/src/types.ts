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

/** Persistent `plugin:` record carrying one watched Session's report to its lead. */
export const DEVLEAD_REPORT_RECORD_TYPE = 'plugin:devlead/report'

/**
 * Persistent `plugin:` record that discards every earlier DevLead record of the
 * Session and resets the projections to their empty state.
 *
 * It exists so one corrupt DevLead record cannot lock a Session out forever:
 * replay folds this marker even when an earlier owned record froze the fold,
 * and both the digest and the mode projection restart from `init`. The reset is
 * human-only (`/devlead reset`, or `/devlead off` on a frozen folder); the model
 * tools never write it.
 */
export const DEVLEAD_RESET_RECORD_TYPE = 'plugin:devlead/reset'

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

/**
 * Session projection key carrying a Session's watch set. Summary-sized so every
 * list row can resolve which rows the current lead watches without loading the
 * digest-bearing `devLead` value.
 */
export const DEVLEAD_WATCH_PROJECTION_KEY = 'devLeadWatch'

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

/** Longest single-line error/excerpt field stored on one notification. */
export const DEVLEAD_ERROR_EXCERPT_MAX = 240

/** Longest report message accepted from a watched Session, in Unicode code points. */
export const DEVLEAD_REPORT_MESSAGE_MAX = 4_000

/** Longest optional report summary accepted from a watched Session, in code points. */
export const DEVLEAD_REPORT_SUMMARY_MAX = 200

/** Most structured questions one native question report may retain. */
export const DEVLEAD_QUESTIONS_MAX = 32

/** Most options one structured question may retain. */
export const DEVLEAD_QUESTION_OPTIONS_MAX = 16

/** Longest structured question/option string field, in Unicode code points. */
export const DEVLEAD_QUESTION_FIELD_MAX = 2_000

/** Most reports one watched Session may send during one turn. */
export const DEVLEAD_REPORT_MAX_PER_TURN = 4

/** Retained report count per lead, matching the notification digest retention. */
export const DEVLEAD_REPORT_RETENTION = 64

/**
 * Largest epoch-millisecond instant a JavaScript `Date` can represent. Persisted
 * instants are validated against it so renderers cannot throw `RangeError`.
 */
export const DEVLEAD_MAX_INSTANT = 8_640_000_000_000_000

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

/** Why a separate turn-notification wake was not sent. */
export type DevLeadWakeSuppressionReason = 'merged-into-pending-wake' | 'included-in-sent-wake'

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
  /** Action-required report whose wake made a separate turn-notification wake unnecessary. */
  readonly wakeSuppressedByReportId?: string
  /** Whether that report was still pending or had already included this transition in its sent wake. */
  readonly wakeSuppressionReason?: DevLeadWakeSuppressionReason
}

/** Semantic kind of one mid-turn report from a watched Session. */
export type DevLeadReportKind = 'progress' | 'blocked' | 'decision' | 'question' | 'fyi'

/** Every accepted report kind, in reporting order. */
export const DEVLEAD_REPORT_KINDS: readonly DevLeadReportKind[] = [
  'progress',
  'blocked',
  'decision',
  'question',
  'fyi',
]

/** One structured option captured from a native user question. */
export interface DevLeadQuestionOption {
  /** Short option label. */
  readonly label: string
  /** Optional explanation of the option. */
  readonly description?: string
}

/** One structured question captured from the native `ask_user_question` gate. */
export interface DevLeadQuestion {
  /** Optional child-authored question identifier. */
  readonly id?: string
  /** Optional short display heading. */
  readonly header?: string
  /** Full question text. */
  readonly question: string
  /** Optional choices presented to the lead. */
  readonly options?: readonly DevLeadQuestionOption[]
  /** Whether the child allows selecting more than one option. */
  readonly multi_select?: boolean
}

/** One mid-turn report a watched Session sends to its active DevLead. */
export interface DevLeadReport {
  /** Deterministic identity derived from sender, turn, kind, and message. */
  readonly id: string
  /** Why the reporter sent this update. */
  readonly kind: DevLeadReportKind
  /** Full plain-text report, bounded by {@link DEVLEAD_REPORT_MESSAGE_MAX}. */
  readonly message: string
  /** Optional short title for notification rows. */
  readonly summary?: string
  /** Structured native question payload; present only on gate-created question reports. */
  readonly questions?: readonly DevLeadQuestion[]
  /** Reporting Session identity. */
  readonly senderSessionId: string
  /** Reporting Session title at report time, when available. */
  readonly senderSessionTitle?: string
  /** Reporting Session's Workspace identity, when grouped. */
  readonly senderWorkspaceId?: string
  /** Reporting Session's Workspace title, when grouped. */
  readonly senderWorkspaceTitle?: string
  /** The unique active DevLead Session this report was addressed to. */
  readonly leadSessionId: string
  /** Reporter's current 1-based turn, or 0 before its first turn. */
  readonly turn: number
  /** Epoch milliseconds recorded by the Host. */
  readonly at: number
}

/** Durable payload appending one report to a lead's retained report digest. */
export interface DevLeadReportRecord {
  /** Record discriminator. */
  readonly kind: 'devlead/report'
  /** Durable payload version; the fold rejects any other value. */
  readonly version: typeof DEVLEAD_RECORD_VERSION
  /** Report appended to the lead's retained report digest. */
  readonly report: DevLeadReport
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

/**
 * Durable record payload resetting a Session's DevLead state.
 *
 * Replay applies it before the freeze check, so a Session whose earlier owned
 * record is corrupt becomes usable again. The reset itself carries no state:
 * both projections restart from their empty initial state (mode off, empty
 * watch set, empty digest, no recorded failure).
 */
export interface DevLeadResetRecord {
  /** Record discriminator. */
  readonly kind: 'devlead/reset'
  /** Durable payload version; the fold rejects any other value. */
  readonly version: typeof DEVLEAD_RECORD_VERSION
  /** Epoch milliseconds of the recorded reset. */
  readonly at: number
}

/** Union of every durable payload written under `plugin:devlead/*` records. */
export type DevLeadRecord =
  | DevLeadModeRecord
  | DevLeadWatchRecord
  | DevLeadNotificationRecord
  | DevLeadReportRecord
  | DevLeadResetRecord

/** Strict Host fold state of one Session's DevLead records. */
export interface DevLeadProjectionState {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
  /** Watched Session ids in add order. */
  readonly sessions: readonly string[]
  /** Retained notifications, oldest first. */
  readonly notifications: readonly DevLeadNotification[]
  /** Retained mid-turn reports, oldest first. */
  readonly reports: readonly DevLeadReport[]
  /** First rejected persisted record, or null while the state is valid. */
  readonly failure: string | null
  /**
   * Exact fork-inherited prefix length of the Session log. Events below this
   * offset were copied from the parent Session by a fork and never describe
   * this Session's own DevLead state; the fold ignores them. Host-only: never
   * published on the client wire view.
   */
  readonly inheritedEventCount: number
}

/** Client view published through the `devLead` Session projection. */
export interface DevLeadProjection {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
  /** Watched Session ids in add order. */
  readonly sessions: readonly string[]
  /** Retained notifications, oldest first. */
  readonly notifications: readonly DevLeadNotification[]
  /** Retained mid-turn reports, oldest first. */
  readonly reports: readonly DevLeadReport[]
}

/**
 * Client view published through the summary-sized `devLeadMode` Session
 * projection: exactly the fact a Session-list row may render.
 */
export interface DevLeadModeProjection {
  /** Whether DevLead mode is selected for this Session. */
  readonly enabled: boolean
}

/** Client view published through the summary-sized `devLeadWatch` projection. */
export interface DevLeadWatchProjection {
  /** Sessions the lead currently watches, in add order. */
  readonly sessions: readonly string[]
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

/**
 * Checkout isolation requested for one created Session.
 *
 * `worktree` is a best-effort request: the Host uses the experimental Git
 * worktree service when it is composed, and reports a non-active outcome
 * instead of failing when it is not. `none` (the default) keeps the existing
 * behavior, where the Session works directly in the Workspace checkout.
 */
export type DevLeadIsolationMode = 'none' | 'worktree'

/**
 * What actually happened to a requested checkout isolation.
 *
 * `none` — no isolation was requested; `worktree` — a worktree was created and
 * the new Session's working directory was entered into it; `unavailable` — the
 * Host composes no compatible worktree service (or the new Session was not
 * live), so the Session works in the Workspace checkout; `failed` — the
 * service exists but creation failed, again leaving the Session in the
 * Workspace checkout. Only the first two are requested outcomes; `unavailable`
 * and `failed` are never errors.
 */
export type DevLeadIsolationStatus = 'none' | 'worktree' | 'unavailable' | 'failed'

/** Outcome of the checkout-isolation attempt for one created Session. */
export interface DevLeadIsolation {
  /** Requested mode after defaulting (omitted requests resolve to `none`). */
  readonly requested: DevLeadIsolationMode
  /** What actually happened. */
  readonly status: DevLeadIsolationStatus
  /** Canonical worktree checkout path; present only when `status` is `worktree`. */
  readonly path?: string
  /** Branch created for the worktree; present only when `status` is `worktree`. */
  readonly branch?: string
  /** Commit the worktree branch started from; present only when `status` is `worktree`. */
  readonly baseCommit?: string
  /** Diagnostic for an `unavailable` or `failed` outcome. */
  readonly reason?: string
}

/** Request shape of one Workspace registration through the core service. */
export interface DevLeadUseWorkspaceRequest {
  /** Fully qualified directory path to register. */
  readonly path: string
  /**
   * Optional display title for a newly registered Workspace. An
   * already-registered canonical path keeps its recorded title.
   */
  readonly title?: string
  /**
   * Whether a missing directory may be created (`mkdir -p`) before the retry.
   * Defaults to `false`: registering a path never creates directories unless
   * the caller explicitly asks for it.
   */
  readonly create?: boolean
}

/** One explicit model selection requested for a dispatched Session. */
export interface DevLeadModelSelection {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /**
   * Adapter-owned reasoning effort. Only meaningful together with the
   * provider/model pair; omitted follows the adapter default.
   */
  readonly reasoningEffort?: string
}

/** One reasoning effort a provider advertises for a model. */
export interface DevLeadModelEffortView {
  /** Adapter-owned effort id accepted by `reasoning_effort`. */
  readonly id: string
  /** Human-readable effort name. */
  readonly name: string
}

/** One model a provider advertises in the Host model catalog. */
export interface DevLeadModelView {
  /** Provider-owned model id accepted by `model`. */
  readonly id: string
  /** Human-readable model name. */
  readonly name: string
  /** Reasoning support, present only when the model advertises efforts. */
  readonly reasoning?: {
    /** Efforts the model accepts, in provider order. */
    readonly efforts: readonly DevLeadModelEffortView[]
    /** Effort the adapter uses when the caller omits one. */
    readonly defaultEffort?: string
  }
}

/** One provider group in the Host model catalog. */
export interface DevLeadModelProviderView {
  /** Registered provider route accepted by `provider`. */
  readonly id: string
  /** Human-readable provider name. */
  readonly name: string
  /** Models the provider currently advertises. */
  readonly models: readonly DevLeadModelView[]
}

/** One provider whose model catalog could not be loaded. */
export interface DevLeadModelCatalogFailure {
  /** Registered provider route that failed. */
  readonly id: string
  /** Human-readable provider name. */
  readonly name: string
  /** Failure detail, for the lead to report instead of guessing. */
  readonly message: string
}

/**
 * Host model catalog as the read-only `devlead_list_models` tool reports it.
 *
 * Display-only fields (model description, badge) are intentionally dropped to
 * keep the tool payload small.
 */
export interface DevLeadModelCatalog {
  /** Selection the Host uses when a Session does not pin a model. */
  readonly default: DevLeadModelSelection
  /** Provider routes with at least one currently available model. */
  readonly routableProviders: readonly string[]
  /** Provider groups and their models. */
  readonly providers: readonly DevLeadModelProviderView[]
  /** Providers whose catalog lookup failed. */
  readonly failures: readonly DevLeadModelCatalogFailure[]
}

/** One Agent preset the Host advertises for Session creation. */
export interface DevLeadAgentPresetView {
  /** Host-defined preset id accepted by `devlead_create_session`'s `preset`. */
  readonly id: string
  /** Display name the preset publishes, when the Host supplies one. */
  readonly name?: string
  /** One-sentence purpose the preset publishes, when the Host supplies one. */
  readonly description?: string
  /**
   * Whether Sessions that name no preset use this one. The Host's effective
   * default is `selectedDefault` when configured, otherwise its base default.
   */
  readonly default: boolean
  /** Host activation failure detail; present only when this preset cannot compose a Session. */
  readonly broken?: string
}

/**
 * Host Agent preset roster as the read-only `devlead_list_agent_presets` tool
 * reports it. `available: false` means the Host composes no roster service;
 * an empty roster is `available: true` with no entries.
 */
export interface DevLeadAgentPresetCatalog {
  /** Whether the Host composes an Agent preset roster service. */
  readonly available: boolean
  /** Declared presets in Host roster order; empty when unavailable or empty. */
  readonly presets: readonly DevLeadAgentPresetView[]
  /** Why the roster is unavailable; present only with `available: false`. */
  readonly reason?: string
}

/**
 * Request shape of one token-less Session creation inside a Workspace.
 *
 * `model` and `agentTeams` are creation-time settings: they configure the new
 * Session only, never the Host/profile default, and are not re-appliable
 * through a later prompt.
 */
export interface DevLeadCreateSessionRequest {
  /** Target Workspace id, registered path, or exact display title. Omitted uses the lead's own directory. */
  readonly workspace?: string
  /** Optional initial prompt the new Session runs immediately. */
  readonly prompt?: string
  /** Optional display title recorded through the Session title service. */
  readonly title?: string
  /** Whether the lead watches the new Session. Defaults to true. */
  readonly watch?: boolean
  /** Optional Agent preset id. */
  readonly preset?: string
  /**
   * Optional checkout isolation for the new Session. Defaults to `none`.
   * `worktree` is applied before the initial prompt is admitted, only when the
   * Host composes a compatible experimental Git worktree service; a missing
   * capability or a creation failure is reported in the result, never thrown.
   */
  readonly isolation?: DevLeadIsolationMode
  /**
   * Optional model selection recorded on the new Session itself. Validated
   * before the Session is created; the Host/profile default model is never
   * changed.
   */
  readonly model?: DevLeadModelSelection
  /**
   * Optional Agent Teams mode recorded on the new Session. `true` requires the
   * Host to compose the Agent Teams service; `false` explicitly disables it;
   * omitted leaves the Host default untouched.
   */
  readonly agentTeams?: boolean
}

/** Result of one DevLead session creation. */
export interface DevLeadCreatedSession {
  /** Created or reused Session identity. */
  readonly session: DevLeadSessionView
  /** Workspace the Session was placed in. */
  readonly workspace: DevLeadWorkspaceView
  /** Whether an initial prompt was admitted. */
  readonly prompted: boolean
  /** Checkout-isolation outcome; always present, `none` unless requested. */
  readonly isolation: DevLeadIsolation
  /** Model selection applied to the new Session, when one was requested. */
  readonly model?: DevLeadModelSelection
  /**
   * Agent Teams mode applied to the new Session, when one was requested. An
   * explicit `false` is also reported on a Host without the Team service,
   * where no Team mode exists to enable.
   */
  readonly agentTeams?: boolean
}

/**
 * One pending inbox input of a live Session, as the detail tool reports it.
 *
 * The identity is the Host message id, stable across restarts because the
 * inbox is folded from durable splices. The source vocabulary is the Host's
 * merge-extensible message-source kinds, so `sourceKind` stays a plain string
 * rather than a closed enum.
 */
export interface DevLeadQueuedInput {
  /** Stable Host message identity, accepted by retraction. */
  readonly id: string
  /** Inbox boundary holding the message: its own turn, or the next step. */
  readonly boundary: 'next-turn' | 'next-step'
  /** Producer kind of the message source (user, devlead, schedule, …). */
  readonly sourceKind: string
  /** Producer-declared context form, when the source carries one. */
  readonly sourceForm?: string
  /** Authoring Session identity, when the source records one. */
  readonly senderSessionId?: string
  /** Bounded single-line excerpt of the text content, when any exists. */
  readonly excerpt?: string
  /** Epoch milliseconds of the durable splice that enqueued the message, when the log records one. */
  readonly enqueuedAt?: number
}

/**
 * Result of withdrawing one queued inbox input.
 *
 * Retraction is idempotent: an input already consumed or withdrawn reports
 * `retracted: false` rather than an error. Only relay prompts the calling
 * lead Session authored are retractable; other producers' inputs are refused.
 */
export interface DevLeadRetractedInput {
  /** Addressed Session identity. */
  readonly sessionId: string
  /** Host message identity the call addressed. */
  readonly inputId: string
  /** Whether this call removed the input from the pending inbox. */
  readonly retracted: boolean
}

/**
 * Inbox policy applied when an interrupt stops a running turn.
 *
 * `clear-all` (the default) keeps the historical behavior: the Host stop
 * discards every pending input. `keep` restores every pending message after
 * the stop; `clear-own` restores everything except the relay prompts this
 * lead Session authored. Restored messages keep their identity and queue
 * order ahead of the replacement prompt.
 */
export type DevLeadInterruptInboxPolicy = 'clear-all' | 'keep' | 'clear-own'

/** One watch-set mutation result. */
export interface DevLeadWatchMutation {
  /** Session identity the call addressed. */
  readonly sessionId: string
  /** Whether the Session is watched after the mutation. */
  readonly watched: boolean
  /** Complete watch set after the mutation. */
  readonly sessions: readonly string[]
}

/**
 * Result of one Workspace registration removal (the DSH `remove` action).
 *
 * The Workspace view is the pre-removal snapshot, so the caller can report what
 * was closed and which Sessions it accounted to. Removal is not a deletion: the
 * directory, its files, and every Session log stay untouched, and the Sessions
 * become ungrouped (still openable and continuable).
 */
export interface DevLeadRemovedWorkspace {
  /** Workspace exactly as it looked immediately before the removal. */
  readonly workspace: DevLeadWorkspaceView
  /**
   * Whether this call removed a registration. `false` means another actor had
   * already removed it between reference resolution and the registry write.
   */
  readonly removed: boolean
}

/** Options of one Session archival through the core service. */
export interface DevLeadArchiveSessionOptions {
  /**
   * Ask the Host to stop the Session's running work instead of refusing the
   * archive. The archive is written first; the stop is then requested through
   * the same providers the human's own stop action uses, and running work is
   * never awaited to settlement. Defaults to `false`.
   */
  readonly stopRunning?: boolean
  /** Cancellation checked before the archive write. */
  readonly signal?: AbortSignal
}

/**
 * Result of one Session archival (the DSH `archive` action).
 *
 * Archiving is reversible and idempotent; it hides the Session from grouping
 * surfaces without touching its log.
 */
export interface DevLeadArchivedSession {
  /** Archived Session identity. */
  readonly sessionId: string
  /** Always `true`: the Session is archived after this call. */
  readonly archived: true
  /**
   * Whether the Host was asked to stop the Session's running work. Always
   * `false` when the Session was already archived: that is a Host no-op, so no
   * activity check runs and no stop request is issued.
   */
  readonly stopped: boolean
}

/** Result of one Session restoration. */
export interface DevLeadUnarchivedSession {
  /** Restored Session identity. */
  readonly sessionId: string
  /** Always `false`: the Session is no longer archived after this call. */
  readonly archived: false
}

/**
 * Options of one prompt admission through the core service.
 *
 * `interrupt` is an explicit replacement of the Session's current work: the
 * Host stops the running turn (and the other work its stop providers report)
 * before the prompt is admitted. Omitted or `false` keeps the non-destructive
 * queue-until-the-turn-settles behavior.
 */
export interface DevLeadPromptSessionOptions {
  /** Watch the Session after prompting. Defaults to true. */
  readonly watch?: boolean
  /** Stop the Session's running work before admitting the prompt. Defaults to false. */
  readonly interrupt?: boolean
  /**
   * Inbox policy applied when the interrupt stops a running turn. Defaults to
   * `clear-all` (the historical behavior). Ignored without `interrupt` and for
   * an idle or cold target, where no stop runs.
   */
  readonly interruptInbox?: DevLeadInterruptInboxPolicy
  /** Cancellation checked before each stage. */
  readonly signal?: AbortSignal
}

/** One admitted prompt into an existing Session. */
export interface DevLeadPromptedSession {
  /** Addressed Session identity. */
  readonly sessionId: string
  /** Whether the Session is watched after the mutation. */
  readonly watched: boolean
  /** Whether the Host had to resume a cold Session to admit the prompt. */
  readonly resumed: boolean
  /**
   * Whether this call asked the Host's stop providers to interrupt a running
   * turn before admitting the prompt. Always `false` when `interrupt` was
   * omitted, and also `false` for an idle or cold Session where there was no
   * active turn to stop.
   */
  readonly interrupted: boolean
  /**
   * Pending inputs restored after the stop under a `keep`/`clear-own` inbox
   * policy. Present only when such a policy actually ran against a running
   * turn; absent for the default `clear-all` and for every no-op interrupt.
   */
  readonly retainedInputs?: number
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
    /**
     * The Session's watch set. Summary-sized and carried by every Session
     * summary so the sidebar can mark watched rows without the excluded digest.
     */
    devLeadWatch: DevLeadWatchProjection
  }
}
