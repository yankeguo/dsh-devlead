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
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type {
  ToolActivationContext,
  ToolDefinition,
  ToolRegistrationOptions,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { DevLeadError } from '@yankeguo/dsh-devlead'
import type {
  DevLeadCreatedSession,
  DevLeadNotification,
  DevLeadPromptedSession,
  DevLeadProjection,
  DevLeadSessionView,
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

  /** Workspaces returned by {@link listWorkspaces}. */
  workspaces: DevLeadWorkspaceView[] = [WORKSPACE]

  /** Session rows returned by {@link listSessions}. */
  sessions: DevLeadSessionView[] = [SESSION]

  /** Session row returned by {@link getSession}. */
  session: DevLeadSessionView = SESSION

  /** Result returned by {@link createSession}. */
  created: DevLeadCreatedSession = { session: SESSION, workspace: WORKSPACE, prompted: true }

  /** Result returned by {@link promptSession}. */
  prompted: DevLeadPromptedSession = { sessionId: 'session-1', watched: true, resumed: false }

  /** Result returned by {@link watchSession}. */
  mutation: DevLeadWatchMutation = { sessionId: 'session-1', watched: true, sessions: ['session-1'] }

  /** Retained notifications returned by {@link notifications}. */
  digest: DevLeadNotification[] = [NOTIFICATION]

  /** Watch set reported through {@link view}. */
  watched: string[] = ['session-1']

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

  isEnabled(agent: Agent): boolean {
    return this.enabled.has(agent.id)
  }

  view(agent: Agent): DevLeadProjection {
    this.enter('view', agent)
    return { enabled: true, sessions: [...this.watched], notifications: this.digest }
  }

  async listWorkspaces(signal?: AbortSignal): Promise<DevLeadWorkspaceView[]> {
    this.enter('listWorkspaces', signal)
    return this.workspaces
  }

  async useWorkspace(
    path: string,
    options?: { title?: string; create?: boolean; signal?: AbortSignal },
  ): Promise<DevLeadWorkspaceView> {
    this.enter('useWorkspace', path, options)
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
    options?: { watch?: boolean; signal?: AbortSignal },
  ): Promise<DevLeadPromptedSession> {
    this.enter('promptSession', agent, sessionId, prompt, options)
    return this.prompted
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
}

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
  /** Default calling Agent. */
  readonly agent: Agent
  /** Default run context of one tool call. */
  readonly exec: ToolRunContext
  /** Captured tool definition by name, or a descriptive failure. */
  tool(name: string): CapturedTool
  /** Execute one tool through its registered definition. */
  call(name: string, args?: unknown, exec?: ToolRunContext): Promise<unknown>
  /** Evaluate one registration's `when` condition; defaults to the first tool's. */
  visible(agent?: Agent, toolName?: string): Promise<boolean>
  /** Resolve the policy section text for one assembling Agent. */
  sectionText(agent?: Agent): string
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
  let section: PromptSection | undefined
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
        section = value
        return () => {}
      },
      getSectionOrder: () => 2800,
    },
  } as unknown as Context
  apply(ctx)
  if (section === undefined) throw new Error('apply() did not register the devlead:policy section')
  const policySection = section

  const tool = (name: string): CapturedTool => {
    const captured = registered.get(name)
    if (captured === undefined) throw new Error(`tool ${name} was not registered`)
    return captured
  }

  return {
    devLead,
    tools: registered,
    section: policySection,
    agent,
    exec,
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
      const text = policySection.text
      if (typeof text === 'string') return text
      return text({ agent: candidate } as unknown as Parameters<typeof text>[0])
    },
  }
}

/** Build one domain failure of the real core error class. */
export function devLeadFailure(code: ConstructorParameters<typeof DevLeadError>[1]): DevLeadError {
  return new DevLeadError(`injected ${code}`, code)
}
