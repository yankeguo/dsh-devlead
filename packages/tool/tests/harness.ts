/**
 * Boot harness for the `devlead_*` tool plugin tests.
 *
 * The harness substitutes the three services `apply` touches — `devLead`,
 * `tools`, and `systemPrompt` — with recording fakes. It never boots a DSH
 * runtime: the tools are pure forwarding plus projection, so the core service's
 * behavior is out of scope here and is covered by the core package tests.
 *
 * @module @yankeguo/dsh-tool-devlead/tests/harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptContext, PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type {
  ToolActivationContext,
  ToolDefinition,
  ToolRegistrationOptions,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { DevLeadError, isHumanDirectedTurn } from '@yankeguo/dsh-devlead'
import type {
  DevLeadBoardNoteReadResult,
  DevLeadBoardNoteWrite,
  DevLeadBoardNoteWriteResult,
  DevLeadBoardReadResult,
  DevLeadBoardUpdate,
  DevLeadBoardUpdateResult,
  DevLeadReportDeliveryState,
} from '@yankeguo/dsh-devlead'
import type {
  DevLeadAgentPresetCatalog,
  DevLeadArchivedSession,
  DevLeadArchiveSessionOptions,
  DevLeadCreatedSession,
  DevLeadModelCatalog,
  DevLeadNotification,
  DevLeadPromptedSession,
  DevLeadProjection,
  DevLeadQuestion,
  DevLeadQuestionAnswerView,
  DevLeadQueuedInput,
  DevLeadRemovedWorkspace,
  DevLeadReport,
  DevLeadRetractedInput,
  DevLeadSessionView,
  DevLeadUnarchivedSession,
  DevLeadUseWorkspaceRequest,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import { apply } from '../src/index.ts'

/** One captured call made by the tools into the fake core service. */
export interface RecordedCall {
  readonly method: string
  readonly args: readonly unknown[]
}

/** One Workspace fixture with every field the canonical projection keeps. */
export const WORKSPACE: DevLeadWorkspaceView = {
  workspaceId: 'ws-1',
  title: 'webapp',
  path: '/tmp/webapp',
  status: 'ok',
  sessionIds: ['session-1', 'session-2'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
}

/** One detailed Session fixture. */
export const SESSION: DevLeadSessionView = {
  sessionId: 'session-1',
  title: 'webapp task',
  workspaceId: 'ws-1',
  workspaceTitle: 'webapp',
  cwd: '/tmp/webapp',
  live: true,
  running: true,
  watched: true,
  archived: false,
  lastTurn: 3,
  pendingInputs: 0,
  lastTransition: 'completed',
  lastAssistant: 'refactored the parser',
  updatedAt: 1_700_000_000_000,
  createdAt: 1_699_000_000_000,
}

/** One notification fixture. */
export const NOTIFICATION: DevLeadNotification = {
  id: 'session-1:3:completed',
  sessionId: 'session-1',
  sessionTitle: 'webapp task',
  transition: 'completed',
  turn: 3,
  at: 1_700_000_000_000,
}

/** One Agent preset roster fixture with a default, metadata, and a broken preset. */
export const AGENT_PRESET_CATALOG: DevLeadAgentPresetCatalog = {
  available: true,
  presets: [
    { id: 'standard', name: 'Standard', description: 'General-purpose preset', default: false },
    { id: 'ptc', name: 'PTC', default: true },
    { id: 'broken', default: false, broken: 'missing service' },
  ],
}

/** One model catalog fixture with a default, reasoning efforts, and a failure. */
export const MODEL_CATALOG: DevLeadModelCatalog = {
  default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' },
  routableProviders: ['provider-a'],
  providers: [
    {
      id: 'provider-a',
      name: 'Provider A',
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'medium',
          },
        },
        { id: 'model-b', name: 'Model B' },
      ],
    },
  ],
  failures: [{ id: 'provider-b', name: 'Provider B', message: 'catalog lookup failed' }],
}

/** One board project fixture shared by read/update results. */
export const BOARD_PROJECT = {
  id: 'webapp',
  workspace: { path: '/tmp/webapp', title: 'webapp' },
  status: 'active' as const,
  priority: 'high' as const,
  goal: 'ship',
  focus: 'tests',
  next: 'verify',
  blockers: [],
  tasks: [],
  updatedAt: '2026-01-02T00:00:00.000Z',
}

/** Create one live-looking Agent identity. */
export function makeAgent(id = 'agent-lead'): Agent {
  return { id, session: { header: { cwd: '/tmp' } } } as unknown as Agent
}

/**
 * In-memory stand-in for `ctx.devLead`.
 *
 * Records every call and returns fixtures. A per-method failure map injects a
 * domain error without a real service, which is how the translation tests
 * exercise real `DevLeadError` instances.
 */
export class FakeDevLead {
  /** Agents whose DevLead mode the fake reports enabled. */
  readonly enabled = new Set<string>()

  /** Every recorded service call, in order. */
  readonly calls: RecordedCall[] = []

  /** Per-method thrown value, when a test injects one. */
  readonly failures = new Map<string, unknown>()

  /** Backing value of {@link worktreeIsolationAvailable}. */
  private worktreeCapability = false

  /** Workspaces returned by {@link listWorkspaces}. */
  workspaces: DevLeadWorkspaceView[] = [WORKSPACE]

  /** Session rows returned by {@link listSessions}. */
  sessions: DevLeadSessionView[] = [SESSION]

  /** Session row returned by {@link getSession}. */
  session: DevLeadSessionView = SESSION

  /** Catalog returned by {@link listModels}. */
  models: DevLeadModelCatalog = MODEL_CATALOG

  /** Roster returned by {@link listAgentPresets}. */
  agentPresets: DevLeadAgentPresetCatalog = AGENT_PRESET_CATALOG

  /** Result returned by {@link createSession}. */
  created: DevLeadCreatedSession = {
    session: SESSION,
    workspace: WORKSPACE,
    prompted: true,
    isolation: { requested: 'none', status: 'none' },
  }

  /** Result returned by {@link promptSession}. */
  prompted: DevLeadPromptedSession = {
    sessionId: 'session-1',
    watched: true,
    resumed: false,
    interrupted: false,
    delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: 'msg-prompt-1' },
  }

  /** Derived question/answer state returned by {@link questionAnswerView}. */
  questionAnswer: DevLeadQuestionAnswerView | undefined

  /**
   * In-memory delivery observations returned by {@link reportDeliveryState},
   * keyed by report id. An absent key models an old record or a Host restart:
   * the hub no longer remembers a delivery state for that report.
   */
  readonly deliveryStates = new Map<string, DevLeadReportDeliveryState>()

  /** Queued inputs returned by {@link sessionQueuedInputs}; undefined models a cold target. */
  queuedInputs: DevLeadQueuedInput[] | undefined

  /** Result returned by {@link retractQueuedInput}. */
  retracted: DevLeadRetractedInput = { sessionId: 'session-1', inputId: 'msg-1', retracted: true }

  /** Result returned by {@link watchSession}. */
  mutation: DevLeadWatchMutation = { sessionId: 'session-1', watched: true, sessions: ['session-1'] }

  /** Retained notifications returned by {@link notifications}. */
  digest: DevLeadNotification[] = [NOTIFICATION]

  /** Watch set reported through {@link view}. */
  watched: string[] = ['session-1']

  /** Session ids the fake Host currently treats as watched by an active lead. */
  readonly supervised = new Set<string>(['agent-lead'])

  /** Report digest reported through {@link reports} and {@link view}. */
  reportDigest: DevLeadReport[] = [
    {
      id: 'report-1',
      kind: 'progress',
      message: 'halfway through the migration',
      summary: 'migration progress',
      senderSessionId: 'session-1',
      leadSessionId: 'lead-1',
      turn: 1,
      at: 1_700_000_000_000,
    },
  ]

  /** Durability flag returned by {@link reportProgress}. */
  reportDurable = true
  /** Queued flag returned by {@link reportProgress}. */
  reportQueued = false
  /** Warning returned by {@link reportProgress}, when set. */
  reportWarning: string | undefined

  /** Result returned by {@link reportProgress}. */
  report: DevLeadReport = {
    id: 'report-2',
    kind: 'blocked',
    message: 'waiting on credentials',
    summary: 'credential blocker',
    senderSessionId: 'session-1',
    leadSessionId: 'lead-1',
    turn: 1,
    at: 1_700_000_000_001,
  }

  /** Result returned by {@link removeWorkspace}. */
  removed: DevLeadRemovedWorkspace = { workspace: WORKSPACE, removed: true }

  /** Result returned by {@link archiveSession}. */
  archived: DevLeadArchivedSession = { sessionId: 'session-1', archived: true, stopped: false }

  /** Result returned by {@link unarchiveSession}. */
  unarchived: DevLeadUnarchivedSession = { sessionId: 'session-1', archived: false }

  /** Read result returned by the board facade. */
  boardRead: DevLeadBoardReadResult = {
    revision: 7,
    updatedAt: '2026-01-02T00:00:00.000Z',
    projects: [BOARD_PROJECT],
  }

  /** Update result returned by the board facade. */
  boardUpdated: DevLeadBoardUpdateResult = {
    revision: 8,
    updatedAt: '2026-01-02T00:00:00.000Z',
    project: BOARD_PROJECT,
    changed: ['set.focus'],
  }

  /** Note read result returned by the board-notes facade. */
  boardNoteRead: DevLeadBoardNoteReadResult = {
    revision: 3,
    updatedAt: '2026-01-02T00:00:00.000Z',
    project: { id: 'webapp', directory: 'webapp-0123456789ab' },
    notes: [{
      id: 'note-1', title: 'Release plan', summary: 'checklist', updatedAt: '2026-01-02T00:00:00.000Z',
      bytes: 7, path: 'webapp-0123456789ab/note-1.md',
    }],
  }

  /** Note mutation result returned by the board-notes facade. */
  boardNoteWritten: DevLeadBoardNoteWriteResult = {
    revision: 4,
    updatedAt: '2026-01-02T00:00:00.000Z',
    project: { id: 'webapp', directory: 'webapp-0123456789ab' },
    note: {
      id: 'note-1', title: 'Release plan', summary: 'checklist', updatedAt: '2026-01-02T00:00:00.000Z',
      bytes: 7, path: 'webapp-0123456789ab/note-1.md',
    },
    operation: 'update',
    changed: true,
  }

  /** Dynamic summary returned by the cache-only board facade. */
  boardSummary = 'DevLead board r7 2026-01-02T00:00:00.000Z; projects 1: active 1, blocked 0, paused 0, done 0'

  /** Board service exposed on the core facade, matching ctx.devLead.board. */
  readonly board = {
    summary: (): string => this.boardSummary,
  }

  /** Cache-only board summary for the assembling Agent (disabled leads get ''). */
  boardSummaryFor(agent: Agent): string {
    return this.enabled.has(String(agent.id)) ? this.boardSummary : ''
  }

  /** Record one lead-scoped board read. */
  async readBoard(
    agent: Agent,
    filter: { project?: string; includeTasks?: boolean; limit?: number },
  ): Promise<DevLeadBoardReadResult> {
    this.enter('readBoard', agent, filter)
    return this.boardRead
  }

  /** Record one lead-stamped board update. */
  async updateBoard(
    agent: Agent,
    request: Omit<DevLeadBoardUpdate, 'updatedBy'>,
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<DevLeadBoardUpdateResult> {
    this.enter('updateBoard', agent, request, expectedRevision, signal)
    return this.boardUpdated
  }

  /** Record one active-lead note metadata/body read. */
  async readBoardNote(
    agent: Agent,
    filter: { project: string; note?: string },
  ): Promise<DevLeadBoardNoteReadResult> {
    this.enter('readBoardNote', agent, filter)
    return this.boardNoteRead
  }

  /** Record one active-lead logical note mutation. */
  async writeBoardNote(
    agent: Agent,
    patch: DevLeadBoardNoteWrite,
    signal?: AbortSignal,
  ): Promise<DevLeadBoardNoteWriteResult> {
    this.enter('writeBoardNote', agent, patch, signal)
    return this.boardNoteWritten
  }

  /** Record one call and throw the injected failure, when any. */
  private enter(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
    const failure = this.failures.get(method)
    if (failure !== undefined) throw failure
  }

  /** Arguments of every recorded call to one method, in call order. */
  callsOf(method: string): readonly (readonly unknown[])[] {
    return this.calls.filter(call => call.method === method).map(call => call.args)
  }

  /**
   * Whether the fake Host composes a capability-compatible Git worktree
   * service. Mirrors the real `DevLeadService` getter shape; mutable so a test
   * can configure the capability-conditional policy and result expectations.
   */
  get worktreeIsolationAvailable(): boolean {
    return this.worktreeCapability
  }

  /** Configure {@link worktreeIsolationAvailable}. */
  set worktreeIsolationAvailable(value: boolean) {
    this.worktreeCapability = value
  }

  isEnabled(agent: Agent): boolean {
    return this.enabled.has(agent.id)
  }

  isSupervised(agent: Agent): boolean {
    return this.supervised.has(agent.id) && !this.enabled.has(agent.id)
  }

  isHumanDirectedTurn(agent: Agent): boolean {
    // Test-only fixture reader; production uses the Host-driven projection.
    return isHumanDirectedTurn(agent.session.snapshotEvents())
  }

  view(agent: Agent): DevLeadProjection {
    this.enter('view', agent)
    return {
      enabled: true,
      sessions: [...this.watched],
      notifications: this.digest,
      reports: this.reportDigest,
    }
  }

  reports(agent: Agent, options: { limit?: number } = {}): DevLeadReport[] {
    this.enter('reports', agent, options)
    const limit = options.limit ?? 20
    return this.reportDigest.slice(-limit)
  }

  async reportProgress(
    agent: Agent,
    request: { message: string; kind?: string; summary?: string; questions?: readonly DevLeadQuestion[] },
    signal?: AbortSignal,
  ): Promise<{ report: DevLeadReport; durable: boolean; queued: boolean; warning?: string }> {
    this.enter('reportProgress', agent, request, signal)
    return {
      report: this.report,
      durable: this.reportDurable,
      queued: this.reportQueued,
      ...(this.reportWarning === undefined ? {} : { warning: this.reportWarning }),
    }
  }

  async listWorkspaces(signal?: AbortSignal): Promise<DevLeadWorkspaceView[]> {
    this.enter('listWorkspaces', signal)
    return this.workspaces
  }

  async useWorkspace(
    agent: Agent,
    request: DevLeadUseWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<DevLeadWorkspaceView> {
    this.enter('useWorkspace', agent, request, signal)
    return this.workspaces[0] ?? WORKSPACE
  }

  async listSessions(
    agent: Agent,
    options: { workspace?: string; watchedOnly?: boolean; limit?: number; signal?: AbortSignal } = {},
  ): Promise<DevLeadSessionView[]> {
    this.enter('listSessions', agent, options)
    return this.sessions
  }

  async getSession(agent: Agent, sessionId: string, signal?: AbortSignal): Promise<DevLeadSessionView> {
    this.enter('getSession', agent, sessionId, signal)
    return this.session
  }

  sessionQueuedInputs(agent: Agent, sessionId: string, signal?: AbortSignal): DevLeadQueuedInput[] | undefined {
    this.enter('sessionQueuedInputs', agent, sessionId, signal)
    return this.queuedInputs
  }

  async retractQueuedInput(
    agent: Agent,
    sessionId: string,
    inputId: string,
    signal?: AbortSignal,
  ): Promise<DevLeadRetractedInput> {
    this.enter('retractQueuedInput', agent, sessionId, inputId, signal)
    return this.retracted
  }

  async createSession(
    agent: Agent,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<DevLeadCreatedSession> {
    this.enter('createSession', agent, request, signal)
    return this.created
  }

  async promptSession(
    agent: Agent,
    sessionId: string,
    prompt: string,
    options?: {
      watch?: boolean
      interrupt?: boolean
      interruptInbox?: string
      intent?: string
      questionId?: string
      idempotencyKey?: string
      signal?: AbortSignal
    },
  ): Promise<DevLeadPromptedSession> {
    this.enter('promptSession', agent, sessionId, prompt, options)
    return this.prompted
  }

  questionAnswerView(agent: Agent, reportId: string): DevLeadQuestionAnswerView | undefined {
    this.enter('questionAnswerView', agent, reportId)
    return this.questionAnswer
  }

  reportDeliveryState(agent: Agent, reportId: string): DevLeadReportDeliveryState | undefined {
    this.enter('reportDeliveryState', agent, reportId)
    return this.deliveryStates.get(reportId)
  }

  async watchSession(
    agent: Agent,
    sessionId: string,
    watching: boolean,
    signal?: AbortSignal,
  ): Promise<DevLeadWatchMutation> {
    this.enter('watchSession', agent, sessionId, watching, signal)
    return this.mutation
  }

  notifications(agent: Agent, options?: { limit?: number }): DevLeadNotification[] {
    this.enter('notifications', agent, options)
    return this.digest
  }

  async listModels(agent: Agent, signal?: AbortSignal): Promise<DevLeadModelCatalog> {
    this.enter('listModels', agent, signal)
    return this.models
  }

  async listAgentPresets(agent: Agent, signal?: AbortSignal): Promise<DevLeadAgentPresetCatalog> {
    this.enter('listAgentPresets', agent, signal)
    return this.agentPresets
  }

  async removeWorkspace(agent: Agent, workspace: string, signal?: AbortSignal): Promise<DevLeadRemovedWorkspace> {
    this.enter('removeWorkspace', agent, workspace, signal)
    return this.removed
  }

  async archiveSession(
    agent: Agent,
    sessionId: string,
    options: DevLeadArchiveSessionOptions = {},
  ): Promise<DevLeadArchivedSession> {
    this.enter('archiveSession', agent, sessionId, options)
    return this.archived
  }

  async unarchiveSession(agent: Agent, sessionId: string, signal?: AbortSignal): Promise<DevLeadUnarchivedSession> {
    this.enter('unarchiveSession', agent, sessionId, signal)
    return this.unarchived
  }
}

/** One captured `tools/pre-execute` listener. */
type PreExecuteListener = (exec: unknown, next: () => Promise<unknown>) => unknown

/** One registered tool definition with the registration options `apply` passed. */
export interface CapturedTool {
  readonly definition: ToolDefinition
  readonly options: ToolRegistrationOptions
}

/** Captured registration surface of the plugin under test. */
export interface Harness {
  /** Fake core service the tools forward to. */
  readonly devLead: FakeDevLead
  /** Registered tools keyed by exact tool name. */
  readonly tools: ReadonlyMap<string, CapturedTool>
  /** Captured `devlead:policy` prompt section. */
  readonly section: PromptSection
  /** Captured `devlead:board-policy` prompt section. */
  readonly boardPolicySection: PromptSection
  /** Captured `devlead:report-policy` prompt section. */
  readonly reportSection: PromptSection
  /** Captured cache-safe board context. */
  readonly boardContext: PromptContext
  /** Default calling Agent. */
  readonly agent: Agent
  /** Default run context of one tool call. */
  readonly exec: ToolRunContext
  /** Warnings logged by the plugin. */
  readonly warnings: readonly string[]
  /** Captured tool definition by name, or a descriptive failure. */
  tool(name: string): CapturedTool
  /** Execute one tool through its registered definition. */
  call(name: string, args?: unknown, exec?: ToolRunContext): Promise<unknown>
  /** Evaluate one registration's `when` condition; defaults to the first tool's. */
  visible(agent?: Agent, toolName?: string): Promise<boolean>
  /** Resolve the policy section text for one assembling Agent. */
  sectionText(agent?: Agent): string
  /** Resolve the board workflow policy text for one assembling Agent. */
  boardPolicySectionText(agent?: Agent): string
  /** Resolve the child report-policy text for one assembling Agent. */
  reportSectionText(agent?: Agent): string
  /** Resolve the board summary for one assembling Agent. */
  boardSummaryText(agent?: Agent): string
  /** Run the registered `tools/pre-execute` waterfall for one pending call. */
  preExecute(exec: unknown): Promise<{ decision: unknown; nextCalls: number }>
}

/**
 * Build one run context carrying the given caller and a fresh signal.
 * @param agent - calling Agent, or undefined to model a Step that carried none.
 * @param signal - cancellation signal; defaults to a fresh un-aborted signal.
 * @returns the run context one tool call receives from the executor.
 */
export function makeExec(agent: Agent | undefined, signal: AbortSignal = new AbortController().signal): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'devlead_test',
    arguments: {},
    agent,
    signal,
    token: Symbol('execution'),
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

/**
 * Boot the tool plugin against recording fakes.
 * @returns the harness used by every tool test.
 */
export function boot(): Harness {
  const devLead = new FakeDevLead()
  const registered = new Map<string, CapturedTool>()
  const sections = new Map<string, PromptSection>()
  const contexts = new Map<string, PromptContext>()
  const listeners = new Map<string, PreExecuteListener[]>()
  const warnings: string[] = []
  const agent = makeAgent()
  const exec = makeExec(agent)

  const ctx = {
    devLead,
    tools: {
      register: (definition: ToolDefinition, options: ToolRegistrationOptions = {}) => {
        registered.set(definition.name, { definition, options })
        return () => {}
      },
    },
    systemPrompt: {
      section: (value: PromptSection) => {
        sections.set(value.name, value)
        return () => {}
      },
      getSectionOrder: () => 2800,
      getContextOrder: () => 210,
      context: (value: PromptContext) => {
        contexts.set(value.name, value)
        return () => {}
      },
    },
    logger: {
      warn: (message: unknown) => { warnings.push(String(message)) },
    },
    on: (name: string, listener: PreExecuteListener) => {
      const current = listeners.get(name) ?? []
      current.push(listener)
      listeners.set(name, current)
      return () => {
        const entries = listeners.get(name) ?? []
        listeners.set(name, entries.filter(entry => entry !== listener))
      }
    },
  } as unknown as Context
  apply(ctx)
  const policySection = sections.get('devlead:policy')
  if (policySection === undefined) throw new Error('apply() did not register the devlead:policy section')
  const boardPolicySection = sections.get('devlead:board-policy')
  if (boardPolicySection === undefined) throw new Error('apply() did not register the devlead:board-policy section')
  const reportPolicySection = sections.get('devlead:report-policy')
  if (reportPolicySection === undefined) throw new Error('apply() did not register the devlead:report-policy section')
  const boardContext = contexts.get('devlead:board-summary')
  if (boardContext === undefined) throw new Error('apply() did not register the devlead:board-summary context')
  const sectionTextOf = (section: PromptSection | PromptContext, value: Agent | undefined): string => {
    const provider = section.text
    if (typeof provider !== 'function') throw new Error('prompt section must resolve its text per assembly')
    return provider({ agent: value } as never)
  }

  const tool = (name: string): CapturedTool => {
    const captured = registered.get(name)
    if (captured === undefined) throw new Error(`tool ${name} was not registered`)
    return captured
  }

  return {
    devLead,
    tools: registered,
    section: policySection,
    boardPolicySection,
    reportSection: reportPolicySection,
    boardContext,
    agent,
    exec,
    warnings,
    tool,
    call(name, args = {}, execOverride = exec) {
      return tool(name).definition.execute(args, execOverride)
    },
    async visible(candidate = agent, toolName) {
      const target = toolName ?? [...registered.keys()][0]
      const when = target === undefined ? undefined : registered.get(target)?.options.when
      const activation = {
        agent: candidate,
        modelSelection: {},
        signal: new AbortController().signal,
      } as unknown as ToolActivationContext
      return when === undefined ? true : await when(activation)
    },
    sectionText(candidate = agent) {
      return sectionTextOf(policySection, candidate)
    },
    boardPolicySectionText(candidate = agent) {
      return sectionTextOf(boardPolicySection, candidate)
    },
    reportSectionText(candidate = agent) {
      return sectionTextOf(reportPolicySection, candidate)
    },
    boardSummaryText(candidate = agent) {
      return sectionTextOf(boardContext, candidate)
    },
    async preExecute(pending) {
      const registeredListeners = listeners.get('tools/pre-execute') ?? []
      if (registeredListeners.length === 0) {
        throw new Error('apply() did not register a tools/pre-execute listener')
      }
      let nextCalls = 0
      let decision: unknown
      for (const listener of registeredListeners) {
        decision = await listener(pending, async () => {
          nextCalls += 1
          return { kind: 'allow' }
        })
      }
      return { decision, nextCalls }
    },
  }
}

/** Build one domain failure of the real core error class. */
export function devLeadFailure(code: ConstructorParameters<typeof DevLeadError>[1]): DevLeadError {
  return new DevLeadError(`injected ${code}`, code)
}
