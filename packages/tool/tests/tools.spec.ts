/**
 * Behavior of the eight `devlead_*` tools: registration and gating, per-tool
 * forwarding into `ctx.devLead`, input validation, canonical value projection,
 * error translation, and pure presentation.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { GenericCallView, InferValue } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type {
  DevLeadCreatedSession,
  DevLeadIsolation,
  DevLeadIsolationMode,
  DevLeadIsolationStatus,
  DevLeadNotification,
  DevLeadPromptedSession,
  DevLeadSessionView,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import { createSessionRequest, DevLeadToolInputError } from '../src/arguments.ts'
import {
  CREATE_SESSION_OUTPUT,
  DEVLEAD_ISOLATION_MODES,
  DEVLEAD_ISOLATION_STATUSES,
  PROMPT_SESSION_OUTPUT,
  WATCH_SESSION_OUTPUT,
  type IsolationValue,
  type NotificationValue,
  type SessionValue,
  type WorkspaceValue,
} from '../src/value.ts'
import { boot, devLeadFailure, makeAgent, makeExec, NOTIFICATION, SESSION, WORKSPACE } from './harness.ts'
import type { Harness } from './harness.ts'

/**
 * Compile-time conformance assertions: each schema-derived canonical value must
 * stay assignable to the protocol view it projects, and each output value must
 * stay assignable to the protocol result type. A drift fails `tsc` here instead
 * of surfacing as a runtime `ToolOutputError` in a real host.
 */
type Assert<T extends true> = T
type SchemaWorkspaceConforms = Assert<WorkspaceValue extends DevLeadWorkspaceView ? true : false>
type SchemaSessionConforms = Assert<SessionValue extends DevLeadSessionView ? true : false>
type SchemaNotificationConforms = Assert<NotificationValue extends DevLeadNotification ? true : false>
type SchemaIsolationConforms = Assert<IsolationValue extends DevLeadIsolation ? true : false>
type SchemaCreatedConforms = Assert<
  InferValue<typeof CREATE_SESSION_OUTPUT.schema> extends DevLeadCreatedSession ? true : false
>
type SchemaPromptedConforms = Assert<
  InferValue<typeof PROMPT_SESSION_OUTPUT.schema> extends DevLeadPromptedSession ? true : false
>
type SchemaWatchedConforms = Assert<
  InferValue<typeof WATCH_SESSION_OUTPUT.schema> extends DevLeadWatchMutation ? true : false
>


/** Exact registered surface promised by DESIGN §5. */
const TOOL_NAMES = [
  'devlead_list_workspaces',
  'devlead_use_workspace',
  'devlead_list_sessions',
  'devlead_create_session',
  'devlead_get_session',
  'devlead_prompt_session',
  'devlead_watch_session',
  'devlead_notifications',
] as const

/** Smallest argument object each tool's schema accepts. */
const MINIMAL_ARGS: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
  devlead_list_workspaces: {},
  devlead_use_workspace: { path: '/tmp/webapp' },
  devlead_list_sessions: {},
  devlead_create_session: {},
  devlead_get_session: { session: 'session-1' },
  devlead_prompt_session: { session: 'session-1', prompt: 'continue' },
  devlead_watch_session: { session: 'session-1', watching: true },
  devlead_notifications: {},
}

/** Tools whose body requires the calling Agent carried by the Step. */
const CALLER_TOOLS = [
  'devlead_use_workspace',
  'devlead_list_sessions',
  'devlead_create_session',
  'devlead_get_session',
  'devlead_prompt_session',
  'devlead_watch_session',
  'devlead_notifications',
] as const

/**
 * Wait for a tool call to fail and return the structured failure.
 * @param promise - pending tool call.
 * @returns the thrown `HarnessError`.
 */
async function failureOf(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected the tool call to reject')
}

/** Resolve the single text block a tool's renderer produced. */
function renderedText(harness: Harness, toolName: string, value: unknown): string {
  const blocks = harness.tool(toolName).definition.output.render({}, value as never)
  expect(blocks).toHaveLength(1)
  const block = blocks[0] as ContentBlock
  expect(block.type).toBe('text')
  if (block.type !== 'text') throw new Error('unreachable')
  return block.text
}

/** Assert one canonical value satisfies the tool's compiled output schema. */
function expectValidOutput(harness: Harness, toolName: string, value: unknown): void {
  const schema = harness.tool(toolName).definition.output.schema
  expect(validateJsonSchemaValue(schema, value)).toEqual([])
}

describe('registration', () => {
  it('registers exactly the eight documented tools', () => {
    const harness = boot()
    expect([...harness.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort())
    for (const name of TOOL_NAMES) {
      expect(harness.tool(name).definition.description.length).toBeGreaterThan(0)
    }
  })

  it('documents truncated uuid Session references on every session argument', () => {
    const harness = boot()
    const expected = 'the full id, a unique id prefix, or the uuid prefix without the "session-" prefix '
      + '(for example e59ab350)'
    for (const name of ['devlead_get_session', 'devlead_prompt_session', 'devlead_watch_session'] as const) {
      const parameters = harness.tool(name).definition.parameters as {
        properties: { session: { description: string } }
      }
      expect(parameters.properties.session.description).toContain(expected)
    }
    expect(harness.tool('devlead_get_session').definition.description)
      .toContain('or the uuid prefix without the "session-" prefix')
  })

  it('gates every tool on the caller having DevLead mode enabled', async () => {
    const harness = boot()
    const enabledAgent = makeAgent('agent-enabled')
    const disabledAgent = makeAgent('agent-disabled')
    harness.devLead.enabled.add(enabledAgent.id)
    for (const name of TOOL_NAMES) {
      await expect(harness.visible(enabledAgent, name)).resolves.toBe(true)
      await expect(harness.visible(disabledAgent, name)).resolves.toBe(false)
    }
  })

  it('registers one devlead:policy section in the subagent tool ordering', () => {
    const harness = boot()
    expect(harness.section.name).toBe('devlead:policy')
    expect(harness.section.order).toBe(2800)
  })

  it('toggles the policy text with the mode and stays empty without an Agent', () => {
    const harness = boot()
    const agent = makeAgent('agent-policy')
    expect(harness.sectionText(agent)).toBe('')
    harness.devLead.enabled.add(agent.id)
    const text = harness.sectionText(agent)
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('runtime notice')
    expect(text).toContain('/devlead on')
    for (const name of TOOL_NAMES) expect(text).toContain(name)
    // The provider re-resolves on every assembly, so disabling the mode drops
    // the section on the next step without a re-registration.
    harness.devLead.enabled.delete(agent.id)
    expect(harness.sectionText(agent)).toBe('')
    const provider = harness.section.text
    if (typeof provider !== 'function') throw new Error('policy section must resolve its text per assembly')
    expect(provider({})).toBe('')
  })
})

describe('policy', () => {
  /** Boot one harness whose default Agent has DevLead mode enabled. */
  function bootEnabled(): Harness {
    const harness = boot()
    harness.devLead.enabled.add(harness.agent.id)
    return harness
  }

  it('states the dispatch-first role and the write boundary', () => {
    const harness = bootEnabled()
    const text = harness.sectionText()
    expect(text).toContain('your job is to orchestrate, not to implement')
    expect(text).toContain('first decide which Workspace owns it')
    expect(text).toContain('dispatch file edits, builds, commits, pushes, and deploys to that Session')
    expect(text).toContain('unless the human explicitly authorizes direct work in this conversation')
    expect(text).toContain("This default includes implementation work in this session's own workspace")
    expect(text).toContain('Subagents, Agent Teams, and background helpers are not a substitute for dispatching')
    // Narrow record-file upkeep is allowed, but it never authorizes implementation.
    expect(text).toContain("Direct upkeep of this repository's own record files")
    expect(text).toContain('that is not implementation work, and it never authorizes implementation')
    const createSession = harness.tool('devlead_create_session').definition
    expect(createSession.description)
      .toContain('dispatch the owning Workspace\'s work to that Session instead of doing the work yourself')
    const parameters = createSession.parameters as {
      properties: { workspace: { description: string } }
    }
    expect(parameters.properties.workspace.description)
      .toContain("omit only when the work truly belongs to this lead's directory")
  })

  it('bounds reconnaissance, ownership, and session discipline', () => {
    const harness = bootEnabled()
    const text = harness.sectionText()
    expect(text).toContain('long-running goal or autonomous plan to carry out the request')
    expect(text).toContain('that work belongs to the owning Session')
    expect(text).toContain('decide the owning Workspace from devlead_list_workspaces metadata')
    expect(text).toContain('If none matches, or more than one could own it, ask and stop')
    expect(text).toContain("Never use this session's directory as a fallback")
    expect(text).toContain('A missing directory is never created by default')
    expect(text).toContain('set create true only when the human explicitly asked to create that directory')
    expect(text).toContain('Once the brief is writable, stop reading and dispatch')
    expect(text).toContain('deeper investigation belongs to the dispatched Session')
    expect(text).toContain('continue that Session with devlead_prompt_session instead of opening a duplicate')
    expect(text).toContain('batch small related changes into one')
    expect(text).toContain('sustained investigation is dispatched too')
    expect(text).toContain('Never create a blank Session without a concrete, self-contained brief')
    expect(text).toContain('reading the actual diff or commits and the verification output')
    expect(text).toContain('ask the Session to run it and report the output')
  })

  it('tells the model to end the turn instead of waiting after a dispatch', () => {
    const harness = bootEnabled()
    const text = harness.sectionText()
    // Dispatch is asynchronous: sleeping, polling the read tools, or waiting
    // through another mechanism all burn the turn without observing the child.
    expect(text).toContain('Waiting after dispatch')
    expect(text).toContain('dispatch is asynchronous, so never wait for a child Session inside the same turn')
    expect(text).toContain('Do not sleep in a shell command')
    expect(text).toContain('do not poll devlead_list_sessions, devlead_get_session, or devlead_notifications')
    expect(text).toContain('do not call wait_agent to wait for a dispatched Session')
    // Ending the turn is the mechanism: the settled turn wakes a new turn.
    expect(text).toContain('End the turn instead')
    expect(text).toContain('once this turn has ended, a watched Session\'s settled turn is delivered as a new turn of this session')
    expect(text).toContain('resuming a cold lead Session by default')
    // Read tools are inspection, never a waiting mechanism; a same-turn human
    // request gets an explicit "dispatched, will report on wake-up" answer.
    expect(text).toContain('never a waiting mechanism')
    expect(text).toContain('say that the work is dispatched and that you will report the outcome when the wake-up brings it')
  })

  it('answers "should I wait?" in the dispatch and status tool descriptions', () => {
    const harness = bootEnabled()
    const createSession = harness.tool('devlead_create_session').definition.description
    expect(createSession).toContain('after this call end the turn instead of waiting')
    expect(createSession).toContain('never call wait_agent to wait for it')
    expect(createSession).toContain('starts a new turn of this lead session with the wake-up message')
    expect(harness.tool('devlead_prompt_session').definition.description)
      .toContain('after this call end the turn instead of waiting')
    for (const name of ['devlead_list_sessions', 'devlead_get_session', 'devlead_notifications']) {
      expect(harness.tool(name).definition.description)
        .toMatch(/not (to poll|as a polling loop) while waiting for a dispatched Session/)
    }
  })

  it('advertises worktree isolation only when the Host composes the capability', () => {
    const harness = bootEnabled()
    const serialText = harness.sectionText()
    // Capability off: the fallback paragraph must not promise a worktree.
    expect(serialText).toContain('no Git worktree isolation is available in this Host composition')
    expect(serialText).toContain('never let two write Sessions run in the same checkout concurrently')
    expect(serialText).toContain('Dispatch write Sessions serially')
    expect(serialText).not.toContain('.agents/worktrees')
    expect(serialText).not.toContain("isolation:'worktree'")
    // Capability on: the same section re-resolves per assembly with the full guidance.
    harness.devLead.worktreeIsolationAvailable = true
    const worktreeText = harness.sectionText()
    expect(worktreeText).toContain("devlead_create_session accepts isolation:'worktree'")
    expect(worktreeText).toContain('run concurrently with another live Session in the same checkout')
    expect(worktreeText).toContain('interleave their hunks and corrupt each other')
    expect(worktreeText).toContain('keeps its Workspace membership and header cwd')
    expect(worktreeText).toContain('<checkout root>/.agents/worktrees/<name>')
    expect(worktreeText).toContain('Uncommitted files in the checkout are NOT copied into the worktree')
    expect(worktreeText).toContain('commit or stash them, or verify the checkout is clean')
    expect(worktreeText).toContain('merge or cherry-pick that branch')
    expect(worktreeText).toContain('status unavailable or failed')
    expect(worktreeText).not.toContain('no Git worktree isolation is available')
    // Flipping the capability back removes the claim again: the text is per-assembly.
    harness.devLead.worktreeIsolationAvailable = false
    expect(harness.sectionText()).toBe(serialText)
  })

  it('stays hidden without DevLead mode even when the capability exists', () => {
    const harness = boot()
    const agent = makeAgent('agent-capability-only')
    harness.devLead.worktreeIsolationAvailable = true
    harness.devLead.enabled.delete(agent.id)
    expect(harness.sectionText(agent)).toBe('')
  })
})

describe('caller invariant', () => {
  it('rejects every caller-dependent tool with one structured agent-not-live error', async () => {
    const harness = boot()
    const agentless = makeExec(undefined)
    for (const name of CALLER_TOOLS) {
      const error = await failureOf(harness.call(name, MINIMAL_ARGS[name], agentless))
      expect(error.code).toBe('DEVLEAD_AGENT_NOT_LIVE')
      expect(error.message).toContain(name)
    }
    expect(harness.devLead.calls).toHaveLength(0)
  })

  it('keeps the read-only Workspace listing working for a Step without an Agent', async () => {
    const harness = boot()
    const agentless = makeExec(undefined)
    await expect(harness.call('devlead_list_workspaces', {}, agentless)).resolves.toEqual({ workspaces: [WORKSPACE] })
  })
})

describe('isolation vocabulary', () => {
  it('keeps the declared mode and status arrays exhaustive against the protocol unions', () => {
    const modes: Record<DevLeadIsolationMode, true> = { none: true, worktree: true }
    const statuses: Record<DevLeadIsolationStatus, true> = {
      none: true,
      worktree: true,
      unavailable: true,
      failed: true,
    }
    expect([...DEVLEAD_ISOLATION_MODES].sort()).toEqual(Object.keys(modes).sort())
    expect([...DEVLEAD_ISOLATION_STATUSES].sort()).toEqual(Object.keys(statuses).sort())
  })
})

describe('canonical values', () => {
  it('keeps every schema-derived value assignable to its protocol view', () => {
    // The element types are the compile-time proof; this test keeps them in the
    // file's normal import/type-checking path. A failing assertion breaks `tsc`
    // before this test can run.
    const conformance: readonly [
      SchemaWorkspaceConforms,
      SchemaSessionConforms,
      SchemaNotificationConforms,
      SchemaIsolationConforms,
      SchemaCreatedConforms,
      SchemaPromptedConforms,
      SchemaWatchedConforms,
    ] = [true, true, true, true, true, true, true]
    expect(conformance.every(value => value)).toBe(true)
  })

  it('projects every tool result onto its declared output schema', async () => {
    const harness = boot()
    for (const name of TOOL_NAMES) {
      const value = await harness.call(name, MINIMAL_ARGS[name])
      expectValidOutput(harness, name, value)
    }
  })

  it('omits optional Session facts the host cannot observe', async () => {
    const harness = boot()
    const minimal = { sessionId: 'session-min', live: false, running: false, watched: false, archived: false }
    harness.devLead.session = minimal
    harness.devLead.sessions = [minimal]
    const detail = await harness.call('devlead_get_session', { session: 'session-min' })
    expect(detail).toEqual({ session: minimal })
    expectValidOutput(harness, 'devlead_get_session', detail)
    const listing = await harness.call('devlead_list_sessions')
    expectValidOutput(harness, 'devlead_list_sessions', listing)
    expect(listing).toEqual({ sessions: [minimal], watched: ['session-1'] })
  })
})

describe('devlead_list_workspaces', () => {
  it('forwards the cancellation signal and returns the canonical projection', async () => {
    const harness = boot()
    const value = await harness.call('devlead_list_workspaces')
    const [signal] = harness.devLead.callsOf('listWorkspaces')[0] ?? []
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual({ workspaces: [WORKSPACE] })
  })

  it('renders the canonical value as one JSON text block', async () => {
    const harness = boot()
    const value = await harness.call('devlead_list_workspaces')
    expect(JSON.parse(renderedText(harness, 'devlead_list_workspaces', value))).toEqual(value)
  })

  it('translates a DevLead domain failure into a structured tool error', async () => {
    const harness = boot()
    harness.devLead.failures.set('listWorkspaces', devLeadFailure('DEVLEAD_WORKSPACE_NOT_FOUND'))
    const error = await failureOf(harness.call('devlead_list_workspaces'))
    expect(error.code).toBe('DEVLEAD_WORKSPACE_NOT_FOUND')
    expect(error.message).toContain('DEVLEAD_WORKSPACE_NOT_FOUND')
  })

  it('rethrows an infrastructure failure unchanged', async () => {
    const harness = boot()
    const internal = new Error('workspace registry exploded')
    harness.devLead.failures.set('listWorkspaces', internal)
    await expect(harness.call('devlead_list_workspaces')).rejects.toBe(internal)
  })
})

describe('devlead_use_workspace', () => {
  it('requires a live caller, defaults create to false, and omits an absent title', async () => {
    const harness = boot()
    const value = await harness.call('devlead_use_workspace', { path: '/tmp/webapp' })
    const [agent, request, signal] = harness.devLead.callsOf('useWorkspace')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(request).toEqual({ path: '/tmp/webapp', create: false })
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual({ workspace: WORKSPACE })
  })

  it('trims the path and title and forwards the explicit create opt-in', async () => {
    const harness = boot()
    await harness.call('devlead_use_workspace', { path: '  /tmp/webapp  ', title: '  webapp  ', create: true })
    const [agent, request, signal] = harness.devLead.callsOf('useWorkspace')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(request).toEqual({ path: '/tmp/webapp', title: 'webapp', create: true })
    expect(signal).toBe(harness.exec.signal)
  })

  it('advertises the non-creating default and the explicit human opt-in', () => {
    const harness = boot()
    const definition = harness.tool('devlead_use_workspace').definition
    expect(definition.description).toContain('only when the human explicitly asked to create that directory')
    const parameters = definition.parameters as {
      properties: { create: { type: string; description: string } }
    }
    expect(parameters.properties.create.description)
      .toBe('Defaults to false. Set true only when the human asked to create the directory.')
  })

  it('rejects a relative path before calling the core service', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_use_workspace', { path: 'relative/repo' }))
    expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
    expect(error.message).toContain('absolute')
    expect(harness.devLead.callsOf('useWorkspace')).toHaveLength(0)
  })

  it('rejects a blank path', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_use_workspace', { path: '   ' }))
    expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
  })

  it('rejects a call that omits the required path', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_use_workspace'))
    expect(error.code).toBe('INVALID_ARGS')
  })
})

describe('devlead_list_sessions', () => {
  it('forwards the caller, mapped options, and the cancellation signal inside the options', async () => {
    const harness = boot()
    const value = await harness.call('devlead_list_sessions', {
      workspace: '  ws-1  ',
      watched_only: true,
      limit: 5,
    })
    const [agent, options] = harness.devLead.callsOf('listSessions')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(options).toEqual({
      workspace: 'ws-1',
      watchedOnly: true,
      limit: 5,
      signal: harness.exec.signal,
    })
    expect(value).toEqual({ sessions: [SESSION], watched: ['session-1'] })
  })

  it('omits every option the model did not set but still forwards the signal', async () => {
    const harness = boot()
    await harness.call('devlead_list_sessions')
    const [, options] = harness.devLead.callsOf('listSessions')[0] ?? []
    expect(options).toEqual({ signal: harness.exec.signal })
  })

  it('reads the watch set from the projection, not from the listing', async () => {
    const harness = boot()
    harness.devLead.watched = ['session-9']
    const value = await harness.call('devlead_list_sessions')
    expect(value).toEqual({ sessions: [SESSION], watched: ['session-9'] })
    expect(harness.devLead.callsOf('view')).toHaveLength(1)
  })

  it('rejects a non-positive limit', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_list_sessions', { limit: 0 }))
    expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
    expect(error.message).toContain('limit')
    expect(harness.devLead.callsOf('listSessions')).toHaveLength(0)
  })

  it('rejects a fractional limit through the schema layer', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_list_sessions', { limit: 1.5 }))
    expect(error.code).toBe('INVALID_ARGS')
  })

  it('rejects a blank workspace filter', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_list_sessions', { workspace: ' ' }))
    expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
  })
})

describe('devlead_create_session', () => {
  it('watches by default and forwards a complete request', async () => {
    const harness = boot()
    const value = await harness.call('devlead_create_session', {
      workspace: 'ws-1',
      prompt: 'refactor the parser',
      title: 'Parser task',
      preset: 'coder',
    })
    const [agent, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(request).toEqual({
      workspace: 'ws-1',
      prompt: 'refactor the parser',
      title: 'Parser task',
      preset: 'coder',
      watch: true,
    })
    expect(value).toEqual({
      session: SESSION,
      workspace: WORKSPACE,
      prompted: true,
      isolation: { requested: 'none', status: 'none' },
    })
  })

  it('sends only the watch policy when the model passes no destination', async () => {
    const harness = boot()
    await harness.call('devlead_create_session')
    const [, request, signal] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ watch: true })
    expect(signal).toBe(harness.exec.signal)
  })

  it('forwards the caller and the cancellation signal to the core mutation', async () => {
    const harness = boot()
    await harness.call('devlead_create_session', { prompt: 'go' })
    const [agent, request, signal] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(request).toEqual({ prompt: 'go', watch: true })
    expect(signal).toBe(harness.exec.signal)
  })

  it('honors an explicit watch=false and preserves prompt formatting', async () => {
    const harness = boot()
    const prompt = '  keep\n  the formatting  '
    await harness.call('devlead_create_session', { prompt, watch: false })
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ prompt, watch: false })
  })

  it('treats a blank title as omitted', async () => {
    const harness = boot()
    await harness.call('devlead_create_session', { title: '   ' })
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ watch: true })
  })

  it('treats a blank preset as omitted', async () => {
    const harness = boot()
    await harness.call('devlead_create_session', { preset: '   ' })
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ watch: true })
  })

  it('rejects a blank prompt before creating anything', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_create_session', { prompt: '  ' }))
    expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
    expect(harness.devLead.callsOf('createSession')).toHaveLength(0)
  })

  it('rejects a blank workspace reference', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_create_session', { workspace: '  ' }))
    expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
  })

  it('translates a missing session controller failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('createSession', devLeadFailure('DEVLEAD_SESSION_UNAVAILABLE'))
    const error = await failureOf(harness.call('devlead_create_session', { prompt: 'go' }))
    expect(error.code).toBe('DEVLEAD_SESSION_UNAVAILABLE')
  })

  it('offers isolation as a none/worktree enum with best-effort wording', () => {
    const harness = boot()
    const parameters = harness.tool('devlead_create_session').definition.parameters as {
      properties: { isolation: { type: string; enum: readonly string[]; description: string } }
    }
    const isolation = parameters.properties.isolation
    expect(isolation.type).toBe('string')
    expect(isolation.enum).toEqual(['none', 'worktree'])
    expect(isolation.description).toContain('defaults to "none"')
    expect(isolation.description).toContain('best-effort isolated Git checkout of the owning Workspace')
    expect(isolation.description).toContain('only when the Host composes the experimental Git worktree service')
    expect(isolation.description).toContain('never as an error')
  })

  it('omits isolation from the request when the model does not set it', async () => {
    const harness = boot()
    await harness.call('devlead_create_session', { prompt: 'go' })
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ prompt: 'go', watch: true })
    expect(request).not.toHaveProperty('isolation')
  })

  it('passes an explicit worktree isolation request through', async () => {
    const harness = boot()
    await harness.call('devlead_create_session', { prompt: 'go', isolation: 'worktree' })
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ prompt: 'go', watch: true, isolation: 'worktree' })
  })

  it('passes an explicit none isolation request through', async () => {
    const harness = boot()
    await harness.call('devlead_create_session', { isolation: 'none' })
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ watch: true, isolation: 'none' })
  })

  it('rejects an unknown isolation mode through the schema layer', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_create_session', { prompt: 'go', isolation: 'branch' }))
    expect(error.code).toBe('INVALID_ARGS')
    expect(harness.devLead.callsOf('createSession')).toHaveLength(0)
  })

  it('returns the default none isolation outcome when none was requested', async () => {
    const harness = boot()
    const value = await harness.call('devlead_create_session', { prompt: 'go' })
    expect(value).toEqual({
      session: SESSION,
      workspace: WORKSPACE,
      prompted: true,
      isolation: { requested: 'none', status: 'none' },
    })
    expectValidOutput(harness, 'devlead_create_session', value)
  })

  it('defaults a missing isolation outcome from a pre-0.2 core instead of throwing', async () => {
    const harness = boot()
    // A 0.1.1 core returns no `isolation` field; the tool must still project a
    // valid canonical value for a Session it already created.
    harness.devLead.created = {
      session: SESSION,
      workspace: WORKSPACE,
      prompted: true,
    } as unknown as DevLeadCreatedSession
    const value = await harness.call('devlead_create_session', { prompt: 'go' }) as {
      readonly isolation: IsolationValue
    }
    expect(value.isolation).toEqual({ requested: 'none', status: 'none' })
    expectValidOutput(harness, 'devlead_create_session', value)
  })

  it('carries the active worktree outcome with its branch facts', async () => {
    const harness = boot()
    harness.devLead.created = {
      ...harness.devLead.created,
      isolation: {
        requested: 'worktree',
        status: 'worktree',
        path: '/tmp/webapp/.agents/worktrees/parser',
        branch: 'agents/parser-refactor',
        baseCommit: 'abc1234',
      },
    }
    const value = await harness.call('devlead_create_session', { prompt: 'go', isolation: 'worktree' })
    expect(value).toEqual({
      session: SESSION,
      workspace: WORKSPACE,
      prompted: true,
      isolation: {
        requested: 'worktree',
        status: 'worktree',
        path: '/tmp/webapp/.agents/worktrees/parser',
        branch: 'agents/parser-refactor',
        baseCommit: 'abc1234',
      },
    })
    expectValidOutput(harness, 'devlead_create_session', value)
  })

  it('projects unavailable and failed outcomes with their reason and no worktree facts', async () => {
    const harness = boot()
    for (const status of ['unavailable', 'failed'] as const) {
      harness.devLead.created = {
        ...harness.devLead.created,
        isolation: { requested: 'worktree', status, reason: `worktree ${status}` },
      }
      const value = await harness.call('devlead_create_session', { prompt: 'go', isolation: 'worktree' }) as {
        isolation: IsolationValue
      }
      expect(value.isolation).toEqual({ requested: 'worktree', status, reason: `worktree ${status}` })
      expect(value.isolation).not.toHaveProperty('path')
      expectValidOutput(harness, 'devlead_create_session', value)
    }
  })

  it('drops absent optional worktree facts instead of serializing undefined', async () => {
    const harness = boot()
    harness.devLead.created = {
      ...harness.devLead.created,
      isolation: { requested: 'worktree', status: 'worktree' },
    }
    const value = await harness.call('devlead_create_session', { isolation: 'worktree' }) as {
      isolation: IsolationValue
    }
    expect(value.isolation).toEqual({ requested: 'worktree', status: 'worktree' })
    expect(Object.keys(value.isolation).sort()).toEqual(['requested', 'status'])
    expectValidOutput(harness, 'devlead_create_session', value)
  })
})

describe('createSessionRequest isolation validation', () => {
  it('keeps the existing request shape when isolation is absent', () => {
    expect(createSessionRequest({ prompt: 'go' })).toEqual({ prompt: 'go', watch: true })
  })

  it('accepts exactly the two modeled isolation modes', () => {
    expect(createSessionRequest({ isolation: 'none' })).toEqual({ watch: true, isolation: 'none' })
    expect(createSessionRequest({ isolation: 'worktree' })).toEqual({ watch: true, isolation: 'worktree' })
  })

  it('rejects any other isolation value with the invalid-input code', () => {
    for (const isolation of ['branch', '', 'Worktree', ' worktree ', 'none ']) {
      let thrown: unknown
      try {
        createSessionRequest({ isolation })
      } catch (error: unknown) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(DevLeadToolInputError)
      expect((thrown as DevLeadToolInputError).code).toBe('DEVLEAD_INVALID_INPUT')
      expect((thrown as Error).message).toContain('isolation must be "none" or "worktree"')
    }
  })
})

describe('devlead_get_session', () => {
  it('forwards the caller, reference, and signal and returns the detailed view', async () => {
    const harness = boot()
    const value = await harness.call('devlead_get_session', { session: '  sess  ' })
    const [agent, sessionId, signal] = harness.devLead.callsOf('getSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(sessionId).toBe('sess')
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual({ session: SESSION })
  })

  it('leaves prefix resolution to the core service', async () => {
    const harness = boot()
    await harness.call('devlead_get_session', { session: 'session-1' })
    const [, sessionId] = harness.devLead.callsOf('getSession')[0] ?? []
    expect(sessionId).toBe('session-1')
  })

  it('rejects a blank session reference', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_get_session', { session: ' ' }))
    expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
  })

  it('translates a missing session failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('getSession', devLeadFailure('DEVLEAD_SESSION_NOT_FOUND'))
    const error = await failureOf(harness.call('devlead_get_session', { session: 'nope' }))
    expect(error.code).toBe('DEVLEAD_SESSION_NOT_FOUND')
  })
})

describe('devlead_prompt_session', () => {
  it('watches by default and forwards the raw prompt', async () => {
    const harness = boot()
    const value = await harness.call('devlead_prompt_session', { session: ' session-1 ', prompt: 'continue with tests' })
    const [agent, sessionId, prompt, options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(sessionId).toBe('session-1')
    expect(prompt).toBe('continue with tests')
    expect(options).toEqual({ watch: true, signal: harness.exec.signal })
    expect(value).toEqual({ sessionId: 'session-1', watched: true, resumed: false })
  })

  it('honors an explicit watch=false', async () => {
    const harness = boot()
    await harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'go', watch: false })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: false, signal: harness.exec.signal })
  })

  it('rejects a blank session or prompt before calling the core', async () => {
    const harness = boot()
    const blankSession = await failureOf(harness.call('devlead_prompt_session', { session: ' ', prompt: 'go' }))
    expect(blankSession.code).toBe('DEVLEAD_INVALID_INPUT')
    const blankPrompt = await failureOf(harness.call('devlead_prompt_session', { session: 'session-1', prompt: ' \n ' }))
    expect(blankPrompt.code).toBe('DEVLEAD_INVALID_INPUT')
    expect(harness.devLead.callsOf('promptSession')).toHaveLength(0)
  })

  it('translates an archived-session failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('promptSession', devLeadFailure('DEVLEAD_SESSION_ARCHIVED'))
    const error = await failureOf(harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'go' }))
    expect(error.code).toBe('DEVLEAD_SESSION_ARCHIVED')
  })
})

describe('devlead_watch_session', () => {
  it('forwards the mutation and returns the resulting watch set', async () => {
    const harness = boot()
    harness.devLead.mutation = { sessionId: 'session-2', watched: false, sessions: ['session-1'] }
    const value = await harness.call('devlead_watch_session', { session: ' session-2 ', watching: false })
    const [agent, sessionId, watching, signal] = harness.devLead.callsOf('watchSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(sessionId).toBe('session-2')
    expect(watching).toBe(false)
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual({ sessionId: 'session-2', watched: false, sessions: ['session-1'] })
  })

  it('rejects a call missing the required watching flag', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_watch_session', { session: 'session-1' }))
    expect(error.code).toBe('INVALID_ARGS')
  })

  it('translates a self-watch failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('watchSession', devLeadFailure('DEVLEAD_SELF_WATCH'))
    const error = await failureOf(harness.call('devlead_watch_session', { session: 'session-1', watching: true }))
    expect(error.code).toBe('DEVLEAD_SELF_WATCH')
  })
})

describe('devlead_notifications', () => {
  it('defaults the digest limit to 20 and returns the watch set', async () => {
    const harness = boot()
    const value = await harness.call('devlead_notifications')
    const [agent, options] = harness.devLead.callsOf('notifications')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(options).toEqual({ limit: 20 })
    expect(value).toEqual({ notifications: [NOTIFICATION], watched: ['session-1'] })
  })

  it('forwards an explicit limit', async () => {
    const harness = boot()
    await harness.call('devlead_notifications', { limit: 5 })
    const [, options] = harness.devLead.callsOf('notifications')[0] ?? []
    expect(options).toEqual({ limit: 5 })
  })

  it('rejects a non-positive limit', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_notifications', { limit: -3 }))
    expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
    expect(harness.devLead.callsOf('notifications')).toHaveLength(0)
  })

  it('translates a corrupt-projection failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('notifications', devLeadFailure('DEVLEAD_PROJECTION_INVALID'))
    const error = await failureOf(harness.call('devlead_notifications'))
    expect(error.code).toBe('DEVLEAD_PROJECTION_INVALID')
  })
})

describe('presentation', () => {
  it('gives every tool a pure generic pending card', () => {
    const harness = boot()
    const callsBefore = harness.devLead.calls.length
    for (const name of TOOL_NAMES) {
      const presentCall = harness.tool(name).definition.presentCall
      expect(presentCall).toBeTypeOf('function')
      const args = MINIMAL_ARGS[name]
      const view = presentCall?.(args) as GenericCallView | undefined
      expect(view).toBeDefined()
      expect(view?.card).toBe('generic')
      expect(typeof view?.title).toBe('string')
      expect((view?.title ?? '').length).toBeGreaterThan(0)
      expect(view?.kind).toBeDefined()
      expect(presentCall?.(args)).toEqual(view)
    }
    expect(harness.devLead.calls).toHaveLength(callsBefore)
  })

  it('labels the watch toggle by direction', () => {
    const harness = boot()
    const presentCall = harness.tool('devlead_watch_session').definition.presentCall
    const watching = presentCall?.({ session: 'session-1', watching: true }) as GenericCallView
    const unwatching = presentCall?.({ session: 'session-1', watching: false }) as GenericCallView
    expect(watching.title).toBe('Watch DevLead session')
    expect(unwatching.title).toBe('Unwatch DevLead session')
  })

  it('shows trimmed salient text and omits blank filler arguments', () => {
    const harness = boot()
    const workspaces = harness.tool('devlead_use_workspace').definition.presentCall
    expect((workspaces?.({ path: '  /tmp/webapp  ' }) as GenericCallView).rawInput).toBe('/tmp/webapp')
    expect((workspaces?.({ path: '   ' }) as GenericCallView).rawInput).toBeUndefined()
    const listSessions = harness.tool('devlead_list_sessions').definition.presentCall
    expect((listSessions?.({}) as GenericCallView).rawInput).toBeUndefined()
    expect((listSessions?.({ workspace: '  ' }) as GenericCallView).rawInput).toBeUndefined()
    const getSession = harness.tool('devlead_get_session').definition.presentCall
    expect((getSession?.({ session: '  session-1  ' }) as GenericCallView).rawInput).toBe('session-1')
  })

  it('prefers a usable Create title over a blank one and falls back to the Workspace', () => {
    const harness = boot()
    const presentCall = harness.tool('devlead_create_session').definition.presentCall
    expect((presentCall?.({ title: '  Parser  ', workspace: 'ws-1' }) as GenericCallView).rawInput).toBe('Parser')
    expect((presentCall?.({ title: '   ', workspace: 'ws-1' }) as GenericCallView).rawInput).toBe('ws-1')
    expect((presentCall?.({ isolation: 'worktree' }) as GenericCallView).title)
      .toBe('Create DevLead session (worktree)')
    expect((presentCall?.({}) as GenericCallView).rawInput).toBeUndefined()
  })

  it('falls back to the generic card for logged arguments the current schema rejects', () => {
    const harness = boot()
    expect(harness.tool('devlead_get_session').definition.presentCall?.({})).toBeUndefined()
    expect(harness.tool('devlead_watch_session').definition.presentCall?.({ session: 's' })).toBeUndefined()
  })

  it('renders a Session value as lossless JSON', async () => {
    const harness = boot()
    const value = await harness.call('devlead_get_session', { session: 'session-1' })
    const text = renderedText(harness, 'devlead_get_session', value)
    expect(JSON.parse(text)).toEqual({ session: SESSION })
    expect(text).toBe(JSON.stringify(value))
  })
})
