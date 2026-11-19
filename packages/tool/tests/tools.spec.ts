/**
 * Behavior of the fourteen `devlead_*` tools: registration and gating, per-tool
 * forwarding into `ctx.devLead`, input validation, canonical value projection,
 * error translation, and pure presentation.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { GenericCallView, InferValue } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type {
  DevLeadAgentPresetCatalog,
  DevLeadArchivedSession,
  DevLeadCreatedSession,
  DevLeadIsolation,
  DevLeadIsolationMode,
  DevLeadIsolationStatus,
  DevLeadModelCatalog,
  DevLeadNotification,
  DevLeadPromptedSession,
  DevLeadRemovedWorkspace,
  DevLeadReportKind,
  DevLeadSessionView,
  DevLeadUnarchivedSession,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import { DEVLEAD_REPORT_KINDS } from '@yankeguo/dsh-devlead-protocol'
import { createSessionRequest, DevLeadToolInputError } from '../src/arguments.ts'
import { DEVLEAD_POLICY_BASE } from '../src/policy.ts'
import {
  ASK_USER_QUESTION_TOOL,
  formatQuestionReport,
  isHumanDirectedTurn,
} from '../src/question-routing.ts'
import {
  ARCHIVE_SESSION_OUTPUT,
  CREATE_SESSION_OUTPUT,
  DEVLEAD_ISOLATION_MODES,
  DEVLEAD_ISOLATION_STATUSES,
  LIST_AGENT_PRESETS_OUTPUT,
  LIST_MODELS_OUTPUT,
  PROMPT_SESSION_OUTPUT,
  REMOVE_WORKSPACE_OUTPUT,
  REPORT_SCHEMA,
  UNARCHIVE_SESSION_OUTPUT,
  WATCH_SESSION_OUTPUT,
  type IsolationValue,
  type ModelCatalogValue,
  type NotificationValue,
  type SessionValue,
  type WorkspaceValue,
} from '../src/value.ts'
import {
  boot,
  devLeadFailure,
  makeAgent,
  makeExec,
  AGENT_PRESET_CATALOG,
  MODEL_CATALOG,
  NOTIFICATION,
  SESSION,
  WORKSPACE,
} from './harness.ts'
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
type SchemaRemovedConforms = Assert<
  InferValue<typeof REMOVE_WORKSPACE_OUTPUT.schema> extends DevLeadRemovedWorkspace ? true : false
>
type SchemaArchivedConforms = Assert<
  InferValue<typeof ARCHIVE_SESSION_OUTPUT.schema> extends DevLeadArchivedSession ? true : false
>
type SchemaUnarchivedConforms = Assert<
  InferValue<typeof UNARCHIVE_SESSION_OUTPUT.schema> extends DevLeadUnarchivedSession ? true : false
>
type SchemaModelCatalogConforms = Assert<
  InferValue<typeof LIST_MODELS_OUTPUT.schema> extends DevLeadModelCatalog ? true : false
>
type SchemaAgentPresetCatalogConforms = Assert<
  InferValue<typeof LIST_AGENT_PRESETS_OUTPUT.schema> extends DevLeadAgentPresetCatalog ? true : false
>


/** Exact registered surface promised by DESIGN §5. */
const TOOL_NAMES = [
  'devlead_list_workspaces',
  'devlead_list_models',
  'devlead_list_agent_presets',
  'devlead_use_workspace',
  'devlead_list_sessions',
  'devlead_create_session',
  'devlead_get_session',
  'devlead_prompt_session',
  'devlead_watch_session',
  'devlead_notifications',
  'devlead_report',
  'devlead_remove_workspace',
  'devlead_archive_session',
  'devlead_unarchive_session',
] as const

/** Smallest argument object each tool's schema accepts. */
const MINIMAL_ARGS: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
  devlead_list_workspaces: {},
  devlead_list_models: {},
  devlead_list_agent_presets: {},
  devlead_use_workspace: { path: '/tmp/webapp' },
  devlead_list_sessions: {},
  devlead_create_session: {},
  devlead_get_session: { session: 'session-1' },
  devlead_prompt_session: { session: 'session-1', prompt: 'continue' },
  devlead_watch_session: { session: 'session-1', watching: true },
  devlead_notifications: {},
  devlead_report: { message: 'progress update' },
  devlead_remove_workspace: { workspace: 'ws-1' },
  devlead_archive_session: { session: 'session-1' },
  devlead_unarchive_session: { session: 'session-1' },
}

/** Tools whose body requires the calling Agent carried by the Step. */
const CALLER_TOOLS = [
  'devlead_use_workspace',
  'devlead_list_models',
  'devlead_list_agent_presets',
  'devlead_list_sessions',
  'devlead_create_session',
  'devlead_get_session',
  'devlead_prompt_session',
  'devlead_watch_session',
  'devlead_notifications',
  'devlead_report',
  'devlead_remove_workspace',
  'devlead_archive_session',
  'devlead_unarchive_session',
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
  it('registers exactly the fourteen documented tools', () => {
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
    for (const name of [
      'devlead_get_session',
      'devlead_prompt_session',
      'devlead_watch_session',
      'devlead_archive_session',
      'devlead_unarchive_session',
    ] as const) {
      const parameters = harness.tool(name).definition.parameters as {
        properties: { session: { description: string } }
      }
      expect(parameters.properties.session.description).toContain(expected)
    }
  })

  it('gates lead tools on DevLead mode and the report tool on the watch relationship', async () => {
    const harness = boot()
    const enabledAgent = makeAgent('agent-enabled')
    const disabledAgent = makeAgent('agent-disabled')
    harness.devLead.enabled.add(enabledAgent.id)
    const leadTools = TOOL_NAMES.filter(name => name !== 'devlead_report')
    for (const name of leadTools) {
      await expect(harness.visible(enabledAgent, name)).resolves.toBe(true)
      await expect(harness.visible(disabledAgent, name)).resolves.toBe(false)
    }
    // The report tool is the inverse surface: a watched non-enabled Session.
    harness.devLead.supervised.add(disabledAgent.id)
    await expect(harness.visible(disabledAgent, 'devlead_report')).resolves.toBe(true)
    await expect(harness.visible(enabledAgent, 'devlead_report')).resolves.toBe(false)
  })

  it('registers the lead and child report policy sections in the subagent ordering', () => {
    const harness = boot()
    expect(harness.section.name).toBe('devlead:policy')
    expect(harness.section.order).toBe(2800)
    expect(harness.reportSection.name).toBe('devlead:report-policy')
    expect(harness.reportSection.order).toBe(2800)
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
    for (const name of TOOL_NAMES.filter(candidate => candidate !== 'devlead_report')) {
      expect(text).toContain(name)
    }
    // The provider re-resolves on every assembly, so disabling the mode drops
    // the section on the next step without a re-registration.
    harness.devLead.enabled.delete(agent.id)
    expect(harness.sectionText(agent)).toBe('')
    const provider = harness.section.text
    if (typeof provider !== 'function') throw new Error('policy section must resolve its text per assembly')
    expect(provider({})).toBe('')
  })

  it('shows the one-way report policy only to a watched non-lead Session', () => {
    const harness = boot()
    const reporter = makeAgent('agent-reporter')
    expect(harness.reportSectionText(reporter)).toBe('')
    harness.devLead.supervised.add(reporter.id)
    const text = harness.reportSectionText(reporter)
    expect(text).toContain('devlead_report')
    expect(text).toContain('one-way')
    expect(text).toContain('four')
    expect(text).toContain('DEVLEAD_REPORT_RATE_LIMITED')
    expect(text).toContain('kind question')
    expect(text).toContain('ask_user_question call is intercepted')
    expect(text).toContain('end your turn')
    // A DevLead-enabled Session must not see the child reporting guidance.
    harness.devLead.enabled.add(reporter.id)
    expect(harness.reportSectionText(reporter)).toBe('')
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
      .toContain("Omit only when the work truly belongs to this lead's directory")
    expect(parameters.properties.workspace.description)
      .toContain('id, registered directory path, or exact display title')
    expect(parameters.properties.workspace.description)
      .toContain('DEVLEAD_WORKSPACE_AMBIGUOUS')
  })

  it('bounds reconnaissance to feasibility triage and hands deep research to the Session', () => {
    const harness = bootEnabled()
    const text = harness.sectionText()
    expect(text).toContain('long-running goal or autonomous plan to carry out the request')
    expect(text).toContain('that work belongs to the owning Session')
    expect(text).toContain('decide the owning Workspace from devlead_list_workspaces metadata')
    expect(text).toContain('If none matches, or more than one could own it, ask and stop')
    expect(text).toContain("Never use this session's directory as a fallback")
    expect(text).toContain('A missing directory is never created by default')
    expect(text).toContain('set create true only when the human explicitly asked to create that directory')
    // Triage is bounded: ownership, current behavior, target result, verification.
    expect(text).toContain('Feasibility triage, not research')
    expect(text).toContain('then stop and dispatch')
    expect(text).toContain('Do not read whole modules, reproduce the issue, find the root cause, or design the implementation yourself')
    expect(text).toContain('Put what you could not confirm into the brief as open questions')
    expect(text).toContain('Read further only when ownership, safety, a human request, or a review of a specific claim requires it')
    // The brief hands the deeper investigation to the Session instead of pre-solving it.
    expect(text).toContain('the open questions the Session must confirm or refine')
    expect(text).toContain('A brief with open questions is expected: the Session owns the deeper investigation, not only the edits')
    const createSession = harness.tool('devlead_create_session').definition
    expect(createSession.description).toContain('the brief may carry open questions')
    expect(createSession.description).toContain('the Session owns the deeper investigation and the implementation')
    const parameters = createSession.parameters as {
      properties: { prompt: { description: string } }
    }
    expect(parameters.properties.prompt.description).toContain('open questions to confirm')
    expect(text).toContain('continue that Session with devlead_prompt_session instead of opening a duplicate')
    expect(text).toContain('batch small related changes into one')
    expect(text).toContain('sustained investigation is dispatched too')
    expect(text).toContain('Never create a blank Session without a concrete, self-contained brief')
    expect(text).toContain('reading the actual diff or commits and the verification output')
    expect(text).toContain('ask the Session to run it and report the output')
  })

  it('inherits model defaults and leaves Agent Teams to the lead’s judgment', () => {
    const harness = bootEnabled()
    const text = harness.sectionText()
    expect(text).toContain('Models inherit the Host default')
    expect(text).toContain('call devlead_list_models first')
    expect(text).toContain('Agent Teams is your judgment')
    expect(text).toContain('complex, multi-step, or parallel work that benefits from subagents may set agent_teams true')
    expect(text).toContain('simple linear work omits it')
    expect(text).toContain('obey an explicit human on/off')
    expect(text).toContain('report the choice and why')
    expect(text).toContain('never change the profile default')
    expect(text).toContain('Team availability depends on the Host composition and DSH version')
    expect(text).toContain('continue without Team instead of retrying or blocking')
    const createSession = harness.tool('devlead_create_session').definition
    expect(createSession.description).toContain('inherits the Host default model')
    // The pinning rules live on the parameters, not repeated in the description.
    const parameters = createSession.parameters as {
      properties: {
        provider: { description: string }
        model: { description: string }
        agent_teams: { description: string }
      }
    }
    expect(parameters.properties['provider']?.description).toContain('Omit to inherit the Host default')
    expect(parameters.properties['model']?.description).toContain('call devlead_list_models first')
    expect(parameters.properties['agent_teams']?.description).toContain('Agent Teams is your judgment')
    expect(parameters.properties['agent_teams']?.description).toContain('Obey an explicit human on/off')
    expect(createSession.description).not.toContain('Agent Teams is your judgment')
  })

  it('teaches Host-defined preset discovery, fallback, and rejection', () => {
    const harness = bootEnabled()
    const text = harness.sectionText()
    expect(text).toContain('devlead_list_agent_presets')
    expect(text).toContain('Host-defined Agent preset id')
    expect(text).toContain('plugin defaultAgentPreset')
    expect(text).toContain('Host default/selectedDefault')
    expect(text).toContain('never guess an id')
    // The fallback and rejection rules live on the preset parameter; the tool
    // description only carries the inherit-by-default stance.
    const createSession = harness.tool('devlead_create_session').definition
    const parameters = createSession.parameters as {
      properties: { preset: { description: string } }
    }
    expect(parameters.properties.preset.description).toContain('Host-defined Agent preset id')
    expect(parameters.properties.preset.description).toContain('devlead_list_agent_presets')
    expect(parameters.properties.preset.description).toContain('standard and ptc are examples')
    expect(parameters.properties.preset.description).toContain('plugin defaultAgentPreset')
    expect(parameters.properties.preset.description).toContain('Host default/selectedDefault')
    expect(parameters.properties.preset.description).toContain('structured error')
    expect(parameters.properties.preset.description).toContain('never silently ignored')
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

  it('documents judgment-based closing, its safety boundaries, and the reporting duty', () => {
    const harness = bootEnabled()
    const text = harness.sectionText()
    // Judgment-based autonomy: reasonable wrap-up closes do not need item-by-item instructions.
    expect(text).toContain('Closing Workspaces and Sessions is judgment-based')
    expect(text).toContain('close when it genuinely serves the task and is a reasonable wrap-up, not only when told item by item')
    expect(text).toContain('archive temporary or wrap-up Sessions you created or dispatched for this task once they are done')
    expect(text).toContain('remove Workspace registrations that are clearly stale, duplicate, or empty, or that you created')
    expect(text).toContain('tidy up, wrap up, or clean up, decide the scope yourself')
    // The DSH semantics stay non-destructive and reversible.
    expect(text).toContain('Closing never deletes work')
    expect(text).toContain('devlead_remove_workspace performs the DSH remove action')
    expect(text).toContain('its directory, files, and every Session log stay untouched')
    expect(text).toContain('become ungrouped')
    expect(text).toContain('devlead_archive_session performs the DSH archive action')
    expect(text).toContain('devlead_unarchive_session restores it')
    expect(text).toContain('When tidying up, archive finished Sessions and keep the Workspace registration')
    // The conservative boundaries survive autonomy.
    expect(text).toContain('never close a Session or Workspace the human is using or talking to now')
    expect(text).toContain('never use closing to hide a failure or skip reporting')
    expect(text).toContain('never start an unrelated large cleanup')
    expect(text).toContain('removal has the wider blast radius')
    expect(text).toContain("Pass stop_running true only when you mean to cancel that Session's running work")
    expect(text).toContain('refused as DEVLEAD_SESSION_ACTIVE')
    expect(text).toContain('You can never archive the Session you are running in')
    // Every autonomous close is reported so the human can review or undo it.
    expect(text).toContain('Report every autonomous close: what you closed, why')
    expect(text).toContain('an archived Session can be unarchived')
    expect(text).toContain('created, changed, or closed')
    // The old hard-line authorization wording is gone.
    expect(text).not.toContain('only when the human explicitly asked, in this conversation, to close')
    expect(text).not.toContain('never clean up, archive, or remove anything on your own initiative')
  })

  it('invites mid-turn reports only for long watched briefs', () => {
    const harness = bootEnabled()
    const text = harness.sectionText(harness.agent)
    expect(text).toContain('you may invite devlead_report')
    expect(text).toContain('watch=false')
    expect(text).toContain('never replace the final turn notice')
  })

  it('defines watch as a follow relationship, not a permission grant', () => {
    const harness = bootEnabled()
    const text = harness.sectionText(harness.agent)
    expect(text).toContain('A watch is a follow relationship, not a permission grant')
  })

  it('tells the lead how to handle incoming reports', () => {
    const harness = bootEnabled()
    const text = harness.sectionText(harness.agent)
    expect(text).toContain('[DEV LEAD REPORT]')
    expect(text).toContain('devlead_prompt_session')
    expect(text).toContain('the child cannot receive a reply through the report itself')
    expect(text).toContain('kind question report')
    expect(text).toContain('ask_user_question call is intercepted')
  })

  it('teaches explicit prompt interruption without making it the default', () => {
    const harness = bootEnabled()
    const text = harness.sectionText(harness.agent)
    expect(text).toContain('By default a running Session queues the prompt behind its current turn')
    expect(text).toContain('set interrupt true only to replace that work')
    expect(text).toContain('subagents, owned jobs, active schedules')
    expect(text).toContain('an idle Session is a no-op')
    expect(text).toContain('notifies you as cancelled')
  })

  it('keeps the resident base policy within its +10% budget', () => {
    // The policy is a resident system-prompt section. The 0.2.7 text
    // (10,839 characters) is the baseline for the prompt-interrupt contract;
    // a revision may add at most 10% (floor(10,839 x 1.1) = 11,922). Earlier
    // baselines were retired when their text stopped being the shipped voice.
    // Measuring the exported base keeps the guard independent of the
    // capability-conditional checkout paragraphs.
    expect(DEVLEAD_POLICY_BASE.length).toBeLessThanOrEqual(11_900)
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

describe('report kind vocabulary', () => {
  it('keeps the tool enum and output schema exhaustive against the protocol kinds', () => {
    const kinds: Record<DevLeadReportKind, true> = {
      progress: true,
      blocked: true,
      decision: true,
      question: true,
      fyi: true,
    }
    expect([...DEVLEAD_REPORT_KINDS].sort()).toEqual(Object.keys(kinds).sort())
    const harness = boot()
    const parameters = harness.tool('devlead_report').definition.parameters as {
      properties: { kind: { enum: readonly string[] } }
    }
    expect(parameters.properties.kind.enum).toEqual([...DEVLEAD_REPORT_KINDS])
    expect(REPORT_SCHEMA.properties.kind.enum).toEqual([...DEVLEAD_REPORT_KINDS])
  })
})

describe('schema semantics', () => {
  it('annotates every documented parameter default in the schema itself', () => {
    const harness = boot()
    const defaults: readonly (readonly [string, string, unknown])[] = [
      ['devlead_use_workspace', 'create', false],
      ['devlead_create_session', 'watch', true],
      ['devlead_create_session', 'isolation', 'none'],
      ['devlead_prompt_session', 'watch', true],
      ['devlead_prompt_session', 'interrupt', false],
      ['devlead_notifications', 'limit', 20],
      ['devlead_report', 'kind', 'progress'],
      ['devlead_archive_session', 'stop_running', false],
    ]
    for (const [tool, parameter, expected] of defaults) {
      const parameters = harness.tool(tool).definition.parameters as {
        properties: Record<string, { default?: unknown }>
      }
      expect(parameters.properties[parameter]?.default, `${tool}.${parameter}`).toEqual(expected)
    }
  })

  it('classifies the read-only tools as concurrency-safe and keeps mutations exclusive', () => {
    const harness = boot()
    const readers = [
      'devlead_list_workspaces',
      'devlead_list_models',
      'devlead_list_agent_presets',
      'devlead_list_sessions',
      'devlead_get_session',
      'devlead_notifications',
    ] as const
    for (const name of readers) {
      // defineTool wraps the classifier with argument validation, so the probe
      // must carry the tool's minimal valid arguments.
      expect(harness.tool(name).definition.isConcurrencySafe?.(MINIMAL_ARGS[name]), name).toBe(true)
    }
    for (const name of TOOL_NAMES.filter(name => !(readers as readonly string[]).includes(name))) {
      expect(harness.tool(name).definition.isConcurrencySafe, name).toBeUndefined()
    }
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
      SchemaRemovedConforms,
      SchemaArchivedConforms,
      SchemaUnarchivedConforms,
      SchemaModelCatalogConforms,
      SchemaAgentPresetCatalogConforms,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true]
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

describe('devlead_list_models', () => {
  it('forwards the caller and signal and returns the canonical catalog projection', async () => {
    const harness = boot()
    const value = await harness.call('devlead_list_models')
    const [agent, signal] = harness.devLead.callsOf('listModels')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual(MODEL_CATALOG)
    expectValidOutput(harness, 'devlead_list_models', value)
  })

  it('keeps only the compact model-facing catalog fields', async () => {
    const harness = boot()
    const value = await harness.call('devlead_list_models') as ModelCatalogValue
    const provider = value.providers[0]
    expect(provider?.models[0]).toEqual({
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
    })
    // Display-only fields are not part of the payload.
    expect(JSON.stringify(value)).not.toContain('description')
    expect(JSON.stringify(value)).not.toContain('badge')
  })

  it('renders the catalog as one JSON text block and reports failures', async () => {
    const harness = boot()
    const value = await harness.call('devlead_list_models') as ModelCatalogValue
    const text = renderedText(harness, 'devlead_list_models', value)
    expect(JSON.parse(text)).toEqual(MODEL_CATALOG)
    expect(value.failures).toEqual([{ id: 'provider-b', name: 'Provider B', message: 'catalog lookup failed' }])
  })

  it('advertises the read-only catalog lookup and the default-inheritance guidance', () => {
    const harness = boot()
    const definition = harness.tool('devlead_list_models').definition
    expect(definition.description).toContain('Host default selection')
    expect(definition.description).toContain('routable providers')
    expect(definition.description).toContain('reasoning efforts')
    expect(definition.description).toContain('devlead_create_session')
    expect((definition.parameters as { properties: Record<string, unknown> }).properties).toEqual({})
    // The omit-by-default dispatch guidance lives on the create parameters.
    const createParameters = harness.tool('devlead_create_session').definition.parameters as {
      properties: { provider: { description: string } }
    }
    expect(createParameters.properties.provider.description).toContain('Omit to inherit the Host default')
  })

  it('translates a missing-controller failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('listModels', devLeadFailure('DEVLEAD_SESSION_UNAVAILABLE'))
    const error = await failureOf(harness.call('devlead_list_models'))
    expect(error.code).toBe('DEVLEAD_SESSION_UNAVAILABLE')
  })
})

describe('devlead_list_agent_presets', () => {
  it('forwards the caller and signal and returns the canonical roster projection', async () => {
    const harness = boot()
    const value = await harness.call('devlead_list_agent_presets')
    const [agent, signal] = harness.devLead.callsOf('listAgentPresets')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual(AGENT_PRESET_CATALOG)
    expectValidOutput(harness, 'devlead_list_agent_presets', value)
  })

  it('reports an unavailable roster explicitly without inventing presets', async () => {
    const harness = boot()
    harness.devLead.agentPresets = {
      available: false,
      presets: [],
      reason: 'this Host composes no Agent preset roster',
    }
    const value = await harness.call('devlead_list_agent_presets')
    expect(value).toEqual({
      available: false,
      presets: [],
      reason: 'this Host composes no Agent preset roster',
    })
    expectValidOutput(harness, 'devlead_list_agent_presets', value)
  })

  it('renders the roster as one JSON text block and advertises the guidance', () => {
    const harness = boot()
    const definition = harness.tool('devlead_list_agent_presets').definition
    expect(definition.description).toContain('Host currently defines')
    expect(definition.description).toContain('never assume a fixed list')
    expect(definition.description).toContain('standard and ptc are examples')
    expect(definition.description).toContain('available false with a reason')
    expect((definition.parameters as { properties: Record<string, unknown> }).properties).toEqual({})
    const value = AGENT_PRESET_CATALOG
    const text = renderedText(harness, 'devlead_list_agent_presets', value)
    expect(JSON.parse(text)).toEqual(AGENT_PRESET_CATALOG)
  })

  it('translates a roster read failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('listAgentPresets', devLeadFailure('DEVLEAD_SESSION_UNAVAILABLE'))
    const error = await failureOf(harness.call('devlead_list_agent_presets'))
    expect(error.code).toBe('DEVLEAD_SESSION_UNAVAILABLE')
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

  it('advertises title addressing on the workspace filter', () => {
    const harness = boot()
    const parameters = harness.tool('devlead_list_sessions').definition.parameters as {
      properties: { workspace: { description: string } }
    }
    const description = parameters.properties.workspace.description
    expect(description).toContain('Optional Workspace filter')
    expect(description).toContain('id, registered directory path, or exact display title')
    expect(description).toContain('trimmed, case-sensitive')
    expect(description).toContain('DEVLEAD_WORKSPACE_AMBIGUOUS')
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

describe('devlead_create_session dispatch settings', () => {
  it('forwards a model selection and Agent Teams mode in the canonical request', async () => {
    const harness = boot()
    harness.devLead.created = {
      ...harness.devLead.created,
      model: { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' },
      agentTeams: true,
    }
    const value = await harness.call('devlead_create_session', {
      workspace: 'ws-1',
      provider: '  provider-x  ',
      model: '  model-y  ',
      reasoning_effort: '  high  ',
      agent_teams: true,
    })
    const [agent, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(request).toEqual({
      workspace: 'ws-1',
      model: { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' },
      agentTeams: true,
      watch: true,
    })
    expect(value).toEqual({
      session: SESSION,
      workspace: WORKSPACE,
      prompted: true,
      isolation: { requested: 'none', status: 'none' },
      model: { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' },
      agentTeams: true,
    })
    expectValidOutput(harness, 'devlead_create_session', value)
  })

  it('forwards an explicit Agent Teams disable', async () => {
    const harness = boot()
    await harness.call('devlead_create_session', { agent_teams: false })
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ agentTeams: false, watch: true })
  })

  it('omits both settings when the model passes neither', async () => {
    const harness = boot()
    await harness.call('devlead_create_session')
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ watch: true })
  })

  it('rejects a partial model pair or a lone reasoning effort before calling the core', async () => {
    const harness = boot()
    const cases = [
      { provider: 'p' },
      { model: 'm' },
      { reasoning_effort: 'high' },
      { provider: 'p', reasoning_effort: 'high' },
      { model: 'm', reasoning_effort: 'high' },
    ]
    for (const args of cases) {
      const error = await failureOf(harness.call('devlead_create_session', args))
      expect(error.code).toBe('DEVLEAD_INVALID_INPUT')
    }
    expect(harness.devLead.callsOf('createSession')).toHaveLength(0)
  })

  it('advertises the model/Team parameters and the creation-time/no-default contract', () => {
    const harness = boot()
    const definition = harness.tool('devlead_create_session').definition
    expect(definition.description).toContain('provider/model')
    expect(definition.description).toContain('reasoning_effort')
    expect(definition.description).toContain('agent_teams')
    expect(definition.description).toContain('creation-time only')
    expect(definition.description).toContain('inherits the Host default model')
    expect(definition.description).toContain('Never change the Host/profile default')
    const parameters = definition.parameters as {
      properties: Record<string, { type: string; description: string }>
    }
    expect(Object.keys(parameters.properties)).toEqual(expect.arrayContaining([
      'provider',
      'model',
      'reasoning_effort',
      'agent_teams',
    ]))
    expect(parameters.properties['provider']?.type).toBe('string')
    expect(parameters.properties['model']?.description).toContain('call devlead_list_models first')
    expect(parameters.properties['agent_teams']?.type).toBe('boolean')
    expect(parameters.properties['agent_teams']?.description).toContain('Agent Teams is your judgment')
    expect(parameters.properties['agent_teams']?.description).toContain('Creation-time only')
    expect(parameters.properties['agent_teams']?.description).toContain('DSH 0.2.2-rc.2')
  })
})

describe('createSessionRequest dispatch validation', () => {
  it('builds a trimmed model selection and forwards Agent Teams', () => {
    expect(createSessionRequest({
      provider: '  provider-x ',
      model: ' model-y ',
      reasoning_effort: ' high ',
      agent_teams: true,
    })).toEqual({
      model: { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' },
      agentTeams: true,
      watch: true,
    })
  })

  it('omits a blank reasoning effort but keeps the pair', () => {
    expect(createSessionRequest({ provider: 'p', model: 'm', reasoning_effort: '   ' })).toEqual({
      model: { provider: 'p', model: 'm' },
      watch: true,
    })
  })

  it('rejects incomplete model requests with the invalid-input code', () => {
    for (const args of [
      { provider: 'p' },
      { model: 'm' },
      { provider: 'p', model: '   ' },
      { reasoning_effort: 'high' },
      { provider: '', model: '', reasoning_effort: 'high' },
    ]) {
      expect(() => createSessionRequest(args)).toThrow(DevLeadToolInputError)
      expect(() => createSessionRequest(args)).toThrow(/provider and model|reasoning_effort/)
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

  it('includes the lead report digest when reading the lead itself', async () => {
    const harness = boot()
    const self = makeAgent('session-1')
    const value = await harness.call(
      'devlead_get_session',
      { session: 'session-1' },
      makeExec(self),
    )
    expect(value).toEqual({ session: SESSION, reports: harness.devLead.reportDigest })
    const [, reportOptions] = harness.devLead.callsOf('reports')[0] ?? []
    expect(reportOptions).toEqual({ limit: 5 })
    const definition = harness.tool('devlead_get_session').definition
    expect(definition.description).toContain('its 5 newest retained mid-turn reports')
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
    expect(options).toEqual({ watch: true, interrupt: false, signal: harness.exec.signal })
    expect(value).toEqual({ sessionId: 'session-1', watched: true, resumed: false, interrupted: false })
  })

  it('honors an explicit watch=false', async () => {
    const harness = boot()
    await harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'go', watch: false })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: false, interrupt: false, signal: harness.exec.signal })
  })

  it('forwards an explicit interrupt and reports the outcome', async () => {
    const harness = boot()
    harness.devLead.prompted = { sessionId: 'session-1', watched: true, resumed: false, interrupted: true }
    const value = await harness.call('devlead_prompt_session', {
      session: 'session-1',
      prompt: 'replace the current work',
      interrupt: true,
    })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: true, interrupt: true, signal: harness.exec.signal })
    expect(value).toEqual({ sessionId: 'session-1', watched: true, resumed: false, interrupted: true })
  })

  it('advertises interrupt as explicit, scoped, and default-off', () => {
    const harness = boot()
    const definition = harness.tool('devlead_prompt_session').definition
    expect(definition.description).toContain('Default delivery queues the prompt behind')
    expect(definition.description).toContain('set interrupt true only to replace that work')
    // The stop-and-replace mechanics live on the interrupt parameter, stated once.
    const parameters = definition.parameters as {
      properties: { interrupt: { type: string; description: string } }
    }
    expect(parameters.properties.interrupt.type).toBe('boolean')
    expect(parameters.properties.interrupt.description).toContain('Defaults to false')
    expect(parameters.properties.interrupt.description).toContain('running subagents, owned jobs, active schedules')
    expect(parameters.properties.interrupt.description).toContain('discards queued inbox input')
    expect(parameters.properties.interrupt.description).toContain('An idle or cold Session is a no-op')
    expect(parameters.properties.interrupt.description).toContain('watched-turn notification as cancelled')
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
  it('mentions devlead_report availability in create and prompt descriptions', () => {
    const harness = boot()
    expect(harness.tool('devlead_create_session').definition.description).toContain('devlead_report')
    expect(harness.tool('devlead_create_session').definition.description).toContain('watch=false')
    expect(harness.tool('devlead_prompt_session').definition.description).toContain('devlead_report')
    expect(harness.tool('devlead_prompt_session').definition.description).toContain('watch=false')
  })

  it('documents the watch relationship as one-way and non-permission', () => {
    const harness = boot()
    expect(harness.tool('devlead_watch_session').definition.description)
      .toContain('A watch is a one-way follow relationship, not a permission grant')
  })

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
    expect(value).toEqual({
      notifications: [NOTIFICATION],
      reports: harness.devLead.reportDigest,
      watched: ['session-1'],
    })
  })

  it('forwards an explicit limit to both digests', async () => {
    const harness = boot()
    await harness.call('devlead_notifications', { limit: 5 })
    const [, options] = harness.devLead.callsOf('notifications')[0] ?? []
    expect(options).toEqual({ limit: 5 })
    const [, reportOptions] = harness.devLead.callsOf('reports')[0] ?? []
    expect(reportOptions).toEqual({ limit: 5 })
  })

  it('describes both digests and the per-digest limit without a broken sentence', () => {
    const harness = boot()
    const definition = harness.tool('devlead_notifications').definition
    expect(definition.description).toContain('the reports array carries mid-turn reports from watched Sessions')
    expect(definition.description).toContain('Both digests are newest last')
    expect(definition.description).not.toContain('from watched read it')
    const parameters = definition.parameters as {
      properties: { limit: { type: string; description: string } }
    }
    expect(parameters.properties.limit.type).toBe('integer')
    expect(parameters.properties.limit.description).toContain('notifications and reports are limited separately')
    expect(parameters.properties.limit.description).toContain('Defaults to 20')
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

describe('devlead_report', () => {
  it('forwards the caller, trimmed request, and signal and returns the receipt', async () => {
    const harness = boot()
    const value = await harness.call('devlead_report', {
      message: '  need credentials  ',
      kind: 'blocked',
      summary: ' credential blocker ',
    })
    const [agent, request, signal] = harness.devLead.callsOf('reportProgress')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(request).toEqual({
      message: '  need credentials  ',
      kind: 'blocked',
      summary: ' credential blocker ',
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(value).toEqual({ report: harness.devLead.report, durable: true, queued: false })
  })

  it('defaults kind and summary when omitted', async () => {
    const harness = boot()
    await harness.call('devlead_report', { message: 'progress' })
    const [, request] = harness.devLead.callsOf('reportProgress')[0] ?? []
    expect(request).toEqual({ message: 'progress' })
  })

  it('exposes a degraded non-durable receipt with its warning', async () => {
    const harness = boot()
    harness.devLead.reportDurable = false
    harness.devLead.reportQueued = true
    harness.devLead.reportWarning = 'durable report storage is unavailable'
    const value = await harness.call('devlead_report', { message: 'progress' })
    expect(value).toEqual({
      report: harness.devLead.report,
      durable: false,
      queued: true,
      warning: 'durable report storage is unavailable',
    })
    expectValidOutput(harness, 'devlead_report', value)
  })

  it('forwards a question report and advertises the kind', async () => {
    const harness = boot()
    await harness.call('devlead_report', { message: 'Which target?', kind: 'question', summary: 'target' })
    const [, request] = harness.devLead.callsOf('reportProgress')[0] ?? []
    expect(request).toMatchObject({ kind: 'question', message: 'Which target?', summary: 'target' })
    const definition = harness.tool('devlead_report').definition
    const parameters = definition.parameters as {
      properties: { kind: { enum: readonly string[]; description: string } }
    }
    expect(parameters.properties.kind.enum).toContain('question')
    expect(definition.description).toContain('question reports are exempt')
    expect(definition.description).toContain('end your turn')
  })

  it('translates a not-watched refusal', async () => {
    const harness = boot()
    harness.devLead.failures.set('reportProgress', devLeadFailure('DEVLEAD_NOT_SUPERVISED'))
    const error = await failureOf(harness.call('devlead_report', { message: 'progress' }))
    expect(error.code).toBe('DEVLEAD_NOT_SUPERVISED')
  })

  it('keeps the caller required', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_report', { message: 'progress' }, makeExec(undefined)))
    expect(error.code).toBe('DEVLEAD_AGENT_NOT_LIVE')
  })
})

describe('watched Session question routing', () => {
  /** Build one Agent whose current turn has the given user-message sources. */
  function childAgent(id: string, sources: readonly string[]): ReturnType<typeof makeAgent> {
    const events: unknown[] = [{ type: 'turn/start', data: { turn: 1 } }]
    for (const kind of sources) events.push({ type: 'user/message', data: { source: { kind } } })
    return {
      id,
      session: { header: { cwd: '/tmp' }, snapshotEvents: () => events },
    } as unknown as ReturnType<typeof makeAgent>
  }

  it('formats a question batch for the lead', () => {
    const report = formatQuestionReport({
      questions: [
        {
          id: 'target',
          question: 'Which target?',
          header: 'Deploy',
          options: [{ label: 'Staging', description: 'safe' }, { label: 'Prod' }],
          multi_select: true,
        },
      ],
    })
    expect(report).toEqual({
      message: 'The watched Session is waiting for your answer; reply with devlead_prompt_session:\n'
        + '- [target] Deploy: Which target?\n'
        + '  - Staging — safe\n'
        + '  - Prod\n'
        + '  (multi-select)',
      summary: 'Question: Deploy',
    })
    expect(formatQuestionReport({})).toBeUndefined()
  })

  it('recognizes a human-directed turn and ignores injected context', () => {
    expect(isHumanDirectedTurn(childAgent('child-human', ['user']))).toBe(true)
    expect(isHumanDirectedTurn(childAgent('child-lead', ['devlead']))).toBe(false)
    expect(isHumanDirectedTurn(childAgent('child-steered', ['user', 'runtime-context']))).toBe(true)
  })

  it('forwards a watched child question and denies the direct UI call', async () => {
    const harness = boot()
    const child = childAgent('child-question', ['devlead'])
    harness.devLead.supervised.add(child.id)
    const result = await harness.preExecute({
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [{ id: 'target', question: 'Which target?', header: 'Deploy' }] },
      agent: child,
      signal: new AbortController().signal,
    })
    expect(result.nextCalls).toBe(0)
    expect(result.decision).toMatchObject({ kind: 'deny' })
    expect((result.decision as { reason: string }).reason).toContain('forwarded to the DevLead')
    const [agent, request] = harness.devLead.callsOf('reportProgress')[0] ?? []
    expect(agent).toBe(child)
    expect(request).toMatchObject({ kind: 'question', summary: 'Question: Deploy' })
    expect((request as { message: string }).message).toContain('[target] Deploy: Which target?')
  })

  it('allows an unwatched or human-directed child to ask directly', async () => {
    const harness = boot()
    const unwatched = childAgent('child-unwatched', ['devlead'])
    const human = childAgent('child-human', ['user'])
    harness.devLead.supervised.add(human.id)
    const request = {
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [{ id: 'q', question: 'ok?' }] },
      signal: new AbortController().signal,
    }
    await expect(harness.preExecute({ ...request, agent: unwatched }))
      .resolves.toEqual({ decision: { kind: 'allow' }, nextCalls: 1 })
    await expect(harness.preExecute({ ...request, agent: human }))
      .resolves.toEqual({ decision: { kind: 'allow' }, nextCalls: 1 })
    expect(harness.devLead.callsOf('reportProgress')).toHaveLength(0)
  })

  it('denies with fallback guidance when forwarding fails', async () => {
    const harness = boot()
    const child = childAgent('child-failure', ['devlead'])
    harness.devLead.supervised.add(child.id)
    harness.devLead.failures.set('reportProgress', devLeadFailure('DEVLEAD_REPORT_RATE_LIMITED'))
    const result = await harness.preExecute({
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [{ id: 'q', question: 'Which?' }] },
      agent: child,
      signal: new AbortController().signal,
    })
    expect(result.nextCalls).toBe(0)
    expect((result.decision as { reason: string }).reason).toContain('forwarding the question failed')
    expect(harness.warnings.some(warning => warning.includes('could not forward'))).toBe(true)
  })

  it('does not intercept other tools or calls without an Agent', async () => {
    const harness = boot()
    await expect(harness.preExecute({
      name: 'bash',
      arguments: {},
      agent: undefined,
      signal: new AbortController().signal,
    })).resolves.toEqual({ decision: { kind: 'allow' }, nextCalls: 1 })
    await expect(harness.preExecute({
      name: ASK_USER_QUESTION_TOOL,
      arguments: {},
      agent: undefined,
      signal: new AbortController().signal,
    })).resolves.toEqual({ decision: { kind: 'allow' }, nextCalls: 1 })
  })
})

describe('devlead_remove_workspace', () => {
  it('forwards the caller, trimmed reference, and signal and returns the pre-removal snapshot', async () => {
    const harness = boot()
    const value = await harness.call('devlead_remove_workspace', { workspace: '  ws-1  ' })
    const [agent, workspace, signal] = harness.devLead.callsOf('removeWorkspace')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(workspace).toBe('ws-1')
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual({ workspace: WORKSPACE, removed: true })
    expectValidOutput(harness, 'devlead_remove_workspace', value)
  })

  it('advertises the non-destructive remove semantics and judgment-based autonomy', () => {
    const harness = boot()
    const definition = harness.tool('devlead_remove_workspace').definition
    expect(definition.description).toContain('not a deletion')
    expect(definition.description).toContain('become ungrouped')
    expect(definition.description).toContain('Use your judgment to remove')
    expect(definition.description).toContain('clearly stale, duplicate, or empty')
    expect(definition.description).toContain('do not remove a Workspace the human is using')
    expect(definition.description).toContain('report what you closed and why')
    expect(definition.description).toContain('prefer archiving finished Sessions over unregistering their Workspace')
    expect(definition.description).toContain('the pre-removal snapshot, including the Session ids')
    const parameters = definition.parameters as {
      properties: { workspace: { description: string } }
    }
    const description = parameters.properties.workspace.description
    expect(description).toContain('id, registered directory path, or exact display title')
    expect(description).toContain('DEVLEAD_WORKSPACE_AMBIGUOUS')
  })

  it('rejects a blank or omitted reference before calling the core service', async () => {
    const harness = boot()
    const blank = await failureOf(harness.call('devlead_remove_workspace', { workspace: '   ' }))
    expect(blank.code).toBe('DEVLEAD_INVALID_INPUT')
    expect(blank.message).toContain('workspace')
    const missing = await failureOf(harness.call('devlead_remove_workspace'))
    expect(missing.code).toBe('INVALID_ARGS')
    expect(harness.devLead.callsOf('removeWorkspace')).toHaveLength(0)
  })

  it('translates an unresolved Workspace', async () => {
    const harness = boot()
    harness.devLead.failures.set('removeWorkspace', devLeadFailure('DEVLEAD_WORKSPACE_NOT_FOUND'))
    const error = await failureOf(harness.call('devlead_remove_workspace', { workspace: 'unknown' }))
    expect(error.code).toBe('DEVLEAD_WORKSPACE_NOT_FOUND')
  })

  it('translates an ambiguous Workspace title', async () => {
    const harness = boot()
    harness.devLead.failures.set('removeWorkspace', devLeadFailure('DEVLEAD_WORKSPACE_AMBIGUOUS'))
    const error = await failureOf(harness.call('devlead_remove_workspace', { workspace: 'deepcal' }))
    expect(error.code).toBe('DEVLEAD_WORKSPACE_AMBIGUOUS')
  })
})

describe('devlead_archive_session', () => {
  it('archives without stopping by default and returns the canonical value', async () => {
    const harness = boot()
    const value = await harness.call('devlead_archive_session', { session: ' session-1 ' })
    const [agent, sessionId, options] = harness.devLead.callsOf('archiveSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(sessionId).toBe('session-1')
    expect(options).toEqual({ stopRunning: false, signal: harness.exec.signal })
    expect(value).toEqual({ sessionId: 'session-1', archived: true, stopped: false })
    expectValidOutput(harness, 'devlead_archive_session', value)
  })

  it('forwards stop_running true and reports a requested stop', async () => {
    const harness = boot()
    harness.devLead.archived = { sessionId: 'session-1', archived: true, stopped: true }
    const value = await harness.call('devlead_archive_session', { session: 'session-1', stop_running: true })
    const [, , options] = harness.devLead.callsOf('archiveSession')[0] ?? []
    expect(options).toEqual({ stopRunning: true, signal: harness.exec.signal })
    expect(value).toEqual({ sessionId: 'session-1', archived: true, stopped: true })
    expectValidOutput(harness, 'devlead_archive_session', value)
  })

  it('advertises the archive semantics, autonomy, and the safety boundaries', () => {
    const harness = boot()
    const definition = harness.tool('devlead_archive_session').definition
    expect(definition.description).toContain('archive')
    expect(definition.description).toContain('restores it')
    expect(definition.description).toContain('idempotent and reversible')
    expect(definition.description).toContain('Use your judgment to archive')
    expect(definition.description).toContain('an already archived Session is a no-op and reports stopped false')
    expect(definition.description).toContain('archive finished Sessions and keep the Workspace registration')
    expect(definition.description).toContain('Do not archive a Session the human is using or talking to now')
    expect(definition.description).toContain('never use closing to hide a failure')
    expect(definition.description).toContain('DEVLEAD_SESSION_ACTIVE')
    expect(definition.description).toContain('cannot archive itself')
    expect(definition.description).toContain('Report what you archived and why')
    const parameters = definition.parameters as {
      properties: { stop_running: { type: string; description: string } }
    }
    expect(parameters.properties.stop_running.type).toBe('boolean')
    expect(parameters.properties.stop_running.description).toContain('Defaults to false')
  })

  it('rejects a blank or omitted Session reference before calling the core', async () => {
    const harness = boot()
    const blank = await failureOf(harness.call('devlead_archive_session', { session: '  ' }))
    expect(blank.code).toBe('DEVLEAD_INVALID_INPUT')
    const missing = await failureOf(harness.call('devlead_archive_session'))
    expect(missing.code).toBe('INVALID_ARGS')
    expect(harness.devLead.callsOf('archiveSession')).toHaveLength(0)
  })

  it('translates the active-session refusal and the unknown-session failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('archiveSession', devLeadFailure('DEVLEAD_SESSION_ACTIVE'))
    const active = await failureOf(harness.call('devlead_archive_session', { session: 'session-1' }))
    expect(active.code).toBe('DEVLEAD_SESSION_ACTIVE')
    harness.devLead.failures.set('archiveSession', devLeadFailure('DEVLEAD_SESSION_NOT_FOUND'))
    const missing = await failureOf(harness.call('devlead_archive_session', { session: 'session-1' }))
    expect(missing.code).toBe('DEVLEAD_SESSION_NOT_FOUND')
  })
})

describe('devlead_unarchive_session', () => {
  it('restores one Session and returns the canonical value', async () => {
    const harness = boot()
    const value = await harness.call('devlead_unarchive_session', { session: '  session-1  ' })
    const [agent, sessionId, signal] = harness.devLead.callsOf('unarchiveSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(sessionId).toBe('session-1')
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual({ sessionId: 'session-1', archived: false })
    expectValidOutput(harness, 'devlead_unarchive_session', value)
  })

  it('advertises the restore semantics and autonomous reversal', () => {
    const harness = boot()
    const description = harness.tool('devlead_unarchive_session').definition.description
    expect(description).toContain('idempotent')
    expect(description).toContain('reverse an archive you made while wrapping up')
    expect(description).toContain('report the restored Session')
  })

  it('rejects a blank or omitted Session reference before calling the core', async () => {
    const harness = boot()
    const blank = await failureOf(harness.call('devlead_unarchive_session', { session: '  ' }))
    expect(blank.code).toBe('DEVLEAD_INVALID_INPUT')
    const missing = await failureOf(harness.call('devlead_unarchive_session'))
    expect(missing.code).toBe('INVALID_ARGS')
    expect(harness.devLead.callsOf('unarchiveSession')).toHaveLength(0)
  })

  it('translates an unknown-session failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('unarchiveSession', devLeadFailure('DEVLEAD_SESSION_NOT_FOUND'))
    const error = await failureOf(harness.call('devlead_unarchive_session', { session: 'session-1' }))
    expect(error.code).toBe('DEVLEAD_SESSION_NOT_FOUND')
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

  it('labels prompt delivery and interruption by intent', () => {
    const harness = boot()
    const presentCall = harness.tool('devlead_prompt_session').definition.presentCall
    expect((presentCall?.({ session: 'session-1', prompt: 'go' }) as GenericCallView).title)
      .toBe('Prompt DevLead session')
    expect((presentCall?.({ session: 'session-1', prompt: 'go', interrupt: true }) as GenericCallView).title)
      .toBe('Interrupt DevLead session')
  })

  it('labels workspace removal and Session archival by direction and stop policy', () => {
    const harness = boot()
    const remove = harness.tool('devlead_remove_workspace').definition.presentCall
    expect(remove?.({ workspace: '  ws-1  ' })).toMatchObject({
      title: 'Remove DevLead workspace',
      rawInput: 'ws-1',
    })
    const archive = harness.tool('devlead_archive_session').definition.presentCall
    expect((archive?.({ session: 'session-1' }) as GenericCallView).title).toBe('Archive DevLead session')
    expect((archive?.({ session: 'session-1', stop_running: true }) as GenericCallView).title)
      .toBe('Archive DevLead session (stop running work)')
    const unarchive = harness.tool('devlead_unarchive_session').definition.presentCall
    expect(unarchive?.({ session: ' session-1 ' })).toMatchObject({
      title: 'Restore DevLead session',
      rawInput: 'session-1',
    })
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
    expect(harness.tool('devlead_remove_workspace').definition.presentCall?.({})).toBeUndefined()
    expect(harness.tool('devlead_archive_session').definition.presentCall?.({ session: 's', stop_running: 'yes' }))
      .toBeUndefined()
    expect(harness.tool('devlead_unarchive_session').definition.presentCall?.({})).toBeUndefined()
  })

  it('renders a Session value as lossless JSON', async () => {
    const harness = boot()
    const value = await harness.call('devlead_get_session', { session: 'session-1' })
    const text = renderedText(harness, 'devlead_get_session', value)
    expect(JSON.parse(text)).toEqual({ session: SESSION })
    expect(text).toBe(JSON.stringify(value))
  })
})
