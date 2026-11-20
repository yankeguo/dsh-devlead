/**
 * Behavior of the fifteen `devlead_*` tools: registration and gating, per-tool
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
  DevLeadInterruptInboxPolicy,
  DevLeadModelCatalog,
  DevLeadNotification,
  DevLeadPromptedSession,
  DevLeadQueuedInput,
  DevLeadRemovedWorkspace,
  DevLeadReport,
  DevLeadReportKind,
  DevLeadRetractedInput,
  DevLeadSessionView,
  DevLeadUnarchivedSession,
  DevLeadWatchMutation,
  DevLeadWorkspaceView,
} from '@yankeguo/dsh-devlead-protocol'
import { DEVLEAD_REPORT_KINDS } from '@yankeguo/dsh-devlead-protocol'
import { TOOL_ARGUMENT_KEYS, createSessionRequest, DevLeadToolInputError } from '../src/arguments.ts'
import {
  SESSION_ARGUMENT_DESCRIPTION,
  TOOL_PARAMETERS,
  WORKSPACE_ARGUMENT_DESCRIPTION,
} from '../src/parameters.ts'
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
  QUEUED_INPUT_SCHEMA,
  REMOVE_WORKSPACE_OUTPUT,
  REPORT_SCHEMA,
  RETRACT_INPUT_OUTPUT,
  UNARCHIVE_SESSION_OUTPUT,
  WATCH_SESSION_OUTPUT,
  reportValue,
  type IsolationValue,
  type ModelCatalogValue,
  type NotificationValue,
  type QueuedInputValue,
  type ReportValue,
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
type SchemaReportConforms = Assert<ReportValue extends DevLeadReport ? true : false>
type SchemaIsolationConforms = Assert<IsolationValue extends DevLeadIsolation ? true : false>
type SchemaCreatedConforms = Assert<
  InferValue<typeof CREATE_SESSION_OUTPUT.schema> extends DevLeadCreatedSession ? true : false
>
type SchemaPromptedConforms = Assert<
  InferValue<typeof PROMPT_SESSION_OUTPUT.schema> extends DevLeadPromptedSession ? true : false
>
type SchemaQueuedInputConforms = Assert<QueuedInputValue extends DevLeadQueuedInput ? true : false>
type SchemaRetractedConforms = Assert<
  InferValue<typeof RETRACT_INPUT_OUTPUT.schema> extends DevLeadRetractedInput ? true : false
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
  'devlead_retract_input',
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
  devlead_retract_input: { session: 'session-1', input_id: 'msg-1' },
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
  'devlead_retract_input',
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
  it('registers exactly the fifteen documented tools', () => {
    const harness = boot()
    expect([...harness.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort())
    for (const name of TOOL_NAMES) {
      expect(harness.tool(name).definition.description.length).toBeGreaterThan(0)
    }
  })

  it('derives TOOL_ARGUMENT_KEYS from the parameter schemas defineTool receives', () => {
    const harness = boot()
    const names = Object.keys(TOOL_PARAMETERS)
    expect([...harness.tools.keys()].sort()).toEqual(names.sort())
    expect(Object.keys(TOOL_ARGUMENT_KEYS).sort()).toEqual(names)
    for (const name of names) {
      const key = name as keyof typeof TOOL_PARAMETERS
      const parameters = harness.tool(name).definition.parameters as { properties: Record<string, unknown> }
      const registered = Object.keys(parameters.properties)
      expect(registered, name).toEqual(Object.keys(TOOL_PARAMETERS[key]))
      expect([...TOOL_ARGUMENT_KEYS[key]], name).toEqual(registered)
    }
  })

  it('documents truncated uuid Session references on every session argument', () => {
    const harness = boot()
    const expected = 'the full id, a unique id prefix, or the uuid prefix without the "session-" prefix '
      + '(for example e59ab350)'
    for (const name of [
      'devlead_get_session',
      'devlead_prompt_session',
      'devlead_retract_input',
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

  it('converges every session and workspace argument on the shared descriptions', () => {
    const harness = boot()
    const expectShared = (
      toolNames: readonly string[],
      parameter: string,
      shared: string,
      exact: boolean,
    ): void => {
      for (const name of toolNames) {
        const parameters = harness.tool(name).definition.parameters as {
          properties: Record<string, { description: string }>
        }
        const description = parameters.properties[parameter]?.description
        expect(description, `${name}.${parameter}`).toBeDefined()
        if (exact) expect(description, `${name}.${parameter}`).toBe(shared)
        else expect(description, `${name}.${parameter}`).toContain(shared)
      }
    }
    expectShared(
      [
        'devlead_get_session',
        'devlead_prompt_session',
        'devlead_retract_input',
        'devlead_watch_session',
        'devlead_archive_session',
        'devlead_unarchive_session',
      ],
      'session',
      SESSION_ARGUMENT_DESCRIPTION,
      true,
    )
    expectShared(
      ['devlead_list_sessions', 'devlead_create_session', 'devlead_remove_workspace'],
      'workspace',
      WORKSPACE_ARGUMENT_DESCRIPTION,
      false,
    )
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
    // Reports are long-task mid-turn milestones, not a re-broadcast of what the
    // settled-turn notification already carries.
    expect(text).toContain('Your settled turn already notifies the lead')
    expect(text).toContain('do not use devlead_report to re-broadcast routine progress or your final summary')
    expect(text).toContain("a long-running task's mid-turn milestones")
    expect(text).toContain('a short or linear task should not call it')
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
    // The invitation is narrowed to long-running work with scheduling-relevant
    // mid-turn milestones; short linear work is explicitly excluded.
    expect(text).toContain('a long-running watched Session whose mid-turn milestones matter')
    expect(text).toContain('blockers, decision forks, or scheduling-critical progress')
    expect(text).toContain('for short linear work')
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

describe('undeclared arguments', () => {
  it('guards every tool with the same keys its registered schema declares', async () => {
    for (const name of TOOL_NAMES) {
      const harness = boot()
      const parameters = harness.tool(name).definition.parameters as { properties: Record<string, unknown> }
      const registered = Object.keys(parameters.properties)
      const error = await failureOf(harness.call(name, { ...MINIMAL_ARGS[name], typo_probe: true }))
      expect(error.code, name).toBe('DEVLEAD_INVALID_INPUT')
      expect(error.message, name).toContain('unknown argument "typo_probe"')
      // The guard's accepted list is the registered schema itself, in schema
      // order, so a parameter cannot be visible to the model but unknown to the
      // guard (or vice versa).
      expect(error.message, name).toBe(
        `unknown argument "typo_probe"; accepted arguments: `
        + `${registered.length === 0 ? '(none)' : registered.join(', ')}`,
      )
      expect(harness.devLead.calls, name).toHaveLength(0)
    }
  })

  it('rejects misspelled create/archive/prompt arguments with the accepted list', async () => {
    const harness = boot()
    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ['devlead_create_session', { workspace: 'ws-1', promt: 'do the thing' }, 'promt'],
      ['devlead_archive_session', { session: 'session-1', stopRunning: true }, 'stopRunning'],
      ['devlead_prompt_session', {
        session: 'session-1',
        prompt: 'go',
        interrupt: true,
        interruptInbox: 'keep',
      }, 'interruptInbox'],
    ]
    for (const [tool, args, key] of cases) {
      const error = await failureOf(harness.call(tool, args))
      expect(error.code, tool).toBe('DEVLEAD_INVALID_INPUT')
      expect(error.message, tool).toContain(`unknown argument "${key}"`)
      expect(error.message, tool).toContain('accepted arguments:')
    }
    expect(harness.devLead.calls).toHaveLength(0)
  })

  it('still forwards every declared argument unchanged', async () => {
    const harness = boot()
    await harness.call('devlead_create_session', {
      workspace: 'ws-1',
      prompt: 'do the thing',
      watch: false,
      isolation: 'worktree',
    })
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({
      workspace: 'ws-1',
      prompt: 'do the thing',
      watch: false,
      isolation: 'worktree',
    })
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

  it('projects a detached optional questions payload through the additive report schema', () => {
    const base: DevLeadReport = {
      id: 'report-question',
      kind: 'question',
      message: 'Which target?',
      senderSessionId: 'child-1',
      leadSessionId: 'lead-1',
      turn: 1,
      at: 1_700_000_000_000,
    }
    const questions = [{
      id: 'target',
      header: 'Deploy',
      question: 'Which target?',
      options: [{ label: 'Staging', description: 'safe' }],
      multi_select: false,
    }]
    const value = reportValue({ ...base, questions })
    expect(value.questions).toEqual(questions)
    expect(value.questions).not.toBe(questions)
    expect(value.questions?.[0]?.options).not.toBe(questions[0]!.options)
    const harness = boot()
    expectValidOutput(harness, 'devlead_report', { report: value, durable: true, queued: false })
    questions[0]!.options[0]!.description = 'changed'
    expect(value.questions?.[0]?.options?.[0]?.description).toBe('safe')
    expect(reportValue(base)).not.toHaveProperty('questions')
  })

  it('passes repairPending through the additive report schema and reportValue', () => {
    expect(REPORT_SCHEMA.properties.repairPending).toMatchObject({ type: 'boolean' })
    const base: DevLeadReport = {
      id: 'report-question',
      kind: 'question',
      message: 'Which target?',
      senderSessionId: 'child-1',
      leadSessionId: 'lead-1',
      turn: 1,
      at: 1_700_000_000_000,
    }
    const provisional = reportValue(base, { questionStatus: 'open', answerStatus: 'discarded', answerMessageId: 'm1', repairPending: true })
    expect(provisional).toMatchObject({ questionStatus: 'open', answerStatus: 'discarded', repairPending: true })
    // Absent repairPending is omitted (not emitted as false).
    expect(reportValue(base, { questionStatus: 'answered', answerStatus: 'admitted' })).not.toHaveProperty('repairPending')
    const harness = boot()
    expectValidOutput(harness, 'devlead_report', { report: provisional, durable: true, queued: false })
  })
})

describe('interrupt inbox vocabulary', () => {
  it('keeps the policy enum exhaustive against the protocol union', () => {
    const policies: Record<DevLeadInterruptInboxPolicy, true> = {
      'clear-all': true,
      keep: true,
      'clear-own': true,
    }
    const harness = boot()
    const parameters = harness.tool('devlead_prompt_session').definition.parameters as {
      properties: { interrupt_inbox: { enum: readonly string[]; default?: unknown } }
    }
    expect([...parameters.properties.interrupt_inbox.enum].sort()).toEqual(Object.keys(policies).sort())
    expect(parameters.properties.interrupt_inbox.default).toBe('clear-all')
    expect(QUEUED_INPUT_SCHEMA.properties.boundary.enum).toEqual(['next-turn', 'next-step'])
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
      ['devlead_prompt_session', 'intent', 'instruction'],
      ['devlead_prompt_session', 'interrupt', false],
      ['devlead_prompt_session', 'interrupt_inbox', 'clear-all'],
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
      SchemaReportConforms,
      SchemaIsolationConforms,
      SchemaCreatedConforms,
      SchemaPromptedConforms,
      SchemaQueuedInputConforms,
      SchemaRetractedConforms,
      SchemaWatchedConforms,
      SchemaRemovedConforms,
      SchemaArchivedConforms,
      SchemaUnarchivedConforms,
      SchemaModelCatalogConforms,
      SchemaAgentPresetCatalogConforms,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]
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

  it('projects the queued inbox inputs of a live target and omits them for a cold one', async () => {
    const harness = boot()
    const queued = [{
      id: 'msg-1',
      boundary: 'next-turn' as const,
      sourceKind: 'devlead',
      sourceForm: 'relay',
      senderSessionId: 'agent-lead',
      excerpt: 'stale instruction',
      enqueuedAt: 1_700_000_000_000,
    }, {
      id: 'msg-2',
      boundary: 'next-step' as const,
      sourceKind: 'user',
    }]
    harness.devLead.queuedInputs = queued
    const value = await harness.call('devlead_get_session', { session: 'session-1' })
    expect(value).toEqual({ session: SESSION, queuedInputs: queued })
    expectValidOutput(harness, 'devlead_get_session', value)
    const [agent, sessionId, signal] = harness.devLead.callsOf('sessionQueuedInputs')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(sessionId).toBe('session-1')
    expect(signal).toBe(harness.exec.signal)
    // A cold target reports undefined: the field is omitted, not an empty list.
    harness.devLead.queuedInputs = undefined
    const cold = await harness.call('devlead_get_session', { session: 'session-1' })
    expect(cold).toEqual({ session: SESSION })
  })

  it('advertises queued-input visibility for stale-instruction triage', () => {
    const harness = boot()
    const definition = harness.tool('devlead_get_session').definition
    expect(definition.description).toContain('While a live Agent owns the target')
    expect(definition.description)
      .toContain('lists its queued inbox inputs (id, boundary, source, text excerpt, enqueue time')
    expect(definition.description).toContain('intent/questionId/wakeRequested')
    const schema = definition.output.schema as {
      properties: { queuedInputs: { description: string } }
    }
    expect(schema.properties.queuedInputs.description).toContain('present only while a live Agent owns it')
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
    expect(value).toEqual({
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: false,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: 'msg-prompt-1' },
    })
  })

  it('honors an explicit watch=false', async () => {
    const harness = boot()
    await harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'go', watch: false })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: false, interrupt: false, signal: harness.exec.signal })
  })

  it('forwards an explicit interrupt and reports the outcome', async () => {
    const harness = boot()
    harness.devLead.prompted = {
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: true,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: 'msg-prompt-1' },
    }
    const value = await harness.call('devlead_prompt_session', {
      session: 'session-1',
      prompt: 'replace the current work',
      interrupt: true,
    })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: true, interrupt: true, signal: harness.exec.signal })
    expect(value).toEqual({
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: true,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: 'msg-prompt-1' },
    })
  })

  it('forwards an explicit interrupt inbox policy and reports retained inputs', async () => {
    const harness = boot()
    harness.devLead.prompted = {
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: true,
      retainedInputs: 2,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: 'msg-prompt-1' },
    }
    const value = await harness.call('devlead_prompt_session', {
      session: 'session-1',
      prompt: 'replace',
      interrupt: true,
      interrupt_inbox: 'clear-own',
    })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: true, interrupt: true, interruptInbox: 'clear-own', signal: harness.exec.signal })
    expect(value).toEqual({
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: true,
      retainedInputs: 2,
      delivery: { primitive: 'followup', boundary: 'next-turn', wakeRequested: true, messageId: 'msg-prompt-1' },
    })
    expectValidOutput(harness, 'devlead_prompt_session', value)
  })

  it('omits the inbox policy when the model does not set it and rejects an unknown one', async () => {
    const harness = boot()
    await harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'go', interrupt: true })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: true, interrupt: true, signal: harness.exec.signal })
    const error = await failureOf(harness.call('devlead_prompt_session', {
      session: 'session-1',
      prompt: 'go',
      interrupt_inbox: 'keep-mine',
    }))
    expect(error.code).toBe('INVALID_ARGS')
    expect(harness.devLead.callsOf('promptSession')).toHaveLength(1)
  })

  it('advertises the inbox policy on the parameter, default-off and interrupt-scoped', () => {
    const harness = boot()
    const definition = harness.tool('devlead_prompt_session').definition
    expect(definition.description).toContain('with inbox retention on interrupt_inbox')
    expect(definition.description).toContain('With watch=false this call only skips adding a watch')
    expect(definition.description).toContain('an already-watched Session stays watched')
    expect(definition.description).toContain('devlead_watch_session with watching:false')
    const parameters = definition.parameters as {
      properties: { interrupt_inbox: { type: string; description: string } }
    }
    expect(parameters.properties.interrupt_inbox.type).toBe('string')
    expect(parameters.properties.interrupt_inbox.description).toContain('defaults to "clear-all"')
    expect(parameters.properties.interrupt_inbox.description).toContain('the historical behavior')
    expect(parameters.properties.interrupt_inbox.description)
      .toContain('except the instruction/correction relay prompts and background notices this lead Session authored')
    expect(parameters.properties.interrupt_inbox.description).toContain('Pending answer messages are always kept by "clear-own"')
    expect(parameters.properties.interrupt_inbox.description).toContain('keep their id and queue order ahead of the replacement prompt')
    expect(parameters.properties.interrupt_inbox.description).toContain('Ignored without interrupt:true')
    expect(parameters.properties.interrupt_inbox.description).toContain('retainedInputs')
  })

  it('advertises interrupt as explicit, scoped, and default-off', () => {
    const harness = boot()
    const definition = harness.tool('devlead_prompt_session').definition
    expect(definition.description).toContain('instruction (default) queues a new next-turn boundary behind the current turn')
    expect(definition.description).toContain('Set interrupt true only to replace the current work')
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
    const schema = definition.output.schema as {
      properties: { resumed: { description: string } }
    }
    expect(schema.properties.resumed.description).toContain('because no live Agent owned the target')
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

describe('devlead_retract_input', () => {
  it('forwards the caller, trimmed reference and id, and signal, and returns the outcome', async () => {
    const harness = boot()
    const value = await harness.call('devlead_retract_input', { session: ' session-1 ', input_id: ' msg-1 ' })
    const [agent, sessionId, inputId, signal] = harness.devLead.callsOf('retractQueuedInput')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(sessionId).toBe('session-1')
    expect(inputId).toBe('msg-1')
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual({ sessionId: 'session-1', inputId: 'msg-1', retracted: true })
    expectValidOutput(harness, 'devlead_retract_input', value)
  })

  it('projects the idempotent not-pending outcome', async () => {
    const harness = boot()
    harness.devLead.retracted = { sessionId: 'session-1', inputId: 'msg-gone', retracted: false }
    const value = await harness.call('devlead_retract_input', { session: 'session-1', input_id: 'msg-gone' })
    expect(value).toEqual({ sessionId: 'session-1', inputId: 'msg-gone', retracted: false })
    expectValidOutput(harness, 'devlead_retract_input', value)
  })

  it('rejects a blank or omitted reference and id before calling the core', async () => {
    const harness = boot()
    const blank = await failureOf(harness.call('devlead_retract_input', { session: ' ', input_id: 'msg-1' }))
    expect(blank.code).toBe('DEVLEAD_INVALID_INPUT')
    const blankId = await failureOf(harness.call('devlead_retract_input', { session: 'session-1', input_id: ' ' }))
    expect(blankId.code).toBe('DEVLEAD_INVALID_INPUT')
    expect(blankId.message).toContain('input_id')
    const missing = await failureOf(harness.call('devlead_retract_input', { session: 'session-1' }))
    expect(missing.code).toBe('INVALID_ARGS')
    expect(harness.devLead.callsOf('retractQueuedInput')).toHaveLength(0)
  })

  it('translates the not-own refusal and the cold-target failure', async () => {
    const harness = boot()
    harness.devLead.failures.set('retractQueuedInput', devLeadFailure('DEVLEAD_INVALID_INPUT'))
    const notOwn = await failureOf(harness.call('devlead_retract_input', { session: 'session-1', input_id: 'msg-human' }))
    expect(notOwn.code).toBe('DEVLEAD_INVALID_INPUT')
    harness.devLead.failures.set('retractQueuedInput', devLeadFailure('DEVLEAD_SESSION_UNAVAILABLE'))
    const cold = await failureOf(harness.call('devlead_retract_input', { session: 'session-1', input_id: 'msg-1' }))
    expect(cold.code).toBe('DEVLEAD_SESSION_UNAVAILABLE')
  })

  it('advertises own-only, idempotent retraction of queued inputs', () => {
    const harness = boot()
    const definition = harness.tool('devlead_retract_input').definition
    expect(definition.description).toContain('the id devlead_get_session reports in queuedInputs')
    expect(definition.description)
      .toContain('Your own instruction/correction relay prompts and background notices can be withdrawn')
    expect(definition.description).toContain('an answer is refused')
    expect(definition.description).toContain('Human, scheduled, and other producers')
    expect(definition.description).toContain('already consumed or withdrawn reports retracted false')
    expect(definition.description).toContain('cannot be this lead Session itself')
    expect(definition.description).toContain('instead of layering another prompt on top of it')
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
    expect(request).not.toHaveProperty('questions')
    const definition = harness.tool('devlead_report').definition
    const parameters = definition.parameters as {
      properties: { kind: { enum: readonly string[]; description: string } }
    }
    expect(parameters.properties.kind.enum).toContain('question')
    expect(definition.description).toContain('question reports are exempt')
    expect(definition.description).toContain('end your turn')
  })

  /** One question receipt fixture plus an exec that records concludeTurn calls. */
  function questionHarness(durable: boolean) {
    const harness = boot()
    harness.devLead.report = {
      ...harness.devLead.report,
      id: 'session-1:1:question:which-target',
      kind: 'question',
      message: 'Which target?',
      summary: 'target',
    }
    harness.devLead.reportDurable = durable
    harness.devLead.reportQueued = !durable
    let concluded = 0
    const exec = { ...makeExec(harness.agent), concludeTurn: () => { concluded += 1 } }
    return { harness, exec, concluded: () => concluded }
  }

  it('requests the turn end for a durably forwarded question (case 8)', async () => {
    const { harness, exec, concluded } = questionHarness(true)
    const value = await harness.call('devlead_report', {
      message: 'Which target?', kind: 'question', summary: 'target',
    }, exec as never) as Record<string, unknown>
    expect(concluded()).toBe(1)
    expect(value).toMatchObject({
      durable: true,
      queued: false,
      turnEndRequested: true,
      questionId: 'session-1:1:question:which-target',
    })
    expect(value.report).toMatchObject({ kind: 'question', id: 'session-1:1:question:which-target' })
    // The result must state the request semantics, not an immediate close.
    expect(String(value.guidance)).toContain('not an immediate close')
    expect(String(value.guidance)).toContain('the turn ends after the current tool batch and any committed next-step work')
    expect(String(value.guidance)).toContain('cannot veto')
    expect(String(value.guidance)).toContain('do not poll or resend')
    expect(value).not.toHaveProperty('warning')
    expectValidOutput(harness, 'devlead_report', value)
  })

  it('requests the turn end for a durable question whose receipt is still queued (cold lead)', async () => {
    const { harness, exec, concluded } = questionHarness(true)
    // durable:true + queued:true models a cold lead: the outbox row is safe,
    // the lead receipt has not flushed yet. Durability, not delivery, gates
    // the turn-end request.
    harness.devLead.reportQueued = true
    const value = await harness.call('devlead_report', {
      message: 'Which target?', kind: 'question',
    }, exec as never) as Record<string, unknown>
    expect(concluded()).toBe(1)
    expect(value).toMatchObject({
      durable: true,
      queued: true,
      turnEndRequested: true,
      questionId: 'session-1:1:question:which-target',
    })
    expect(value).not.toHaveProperty('warning')
    expectValidOutput(harness, 'devlead_report', value)
  })

  it('never requests a turn end for non-question kinds', async () => {
    for (const kind of ['progress', 'blocked', 'decision', 'fyi'] as const) {
      const { harness, exec, concluded } = questionHarness(true)
      harness.devLead.report = { ...harness.devLead.report, kind }
      const value = await harness.call('devlead_report', { message: 'update', kind }, exec as never) as Record<string, unknown>
      expect(concluded(), kind).toBe(0)
      expect(value, kind).not.toHaveProperty('turnEndRequested')
      expect(value, kind).not.toHaveProperty('questionId')
      expect(value, kind).not.toHaveProperty('guidance')
      expectValidOutput(harness, 'devlead_report', value)
    }
  })

  it('keeps a memory-only question open and asks for a restatement (case 9)', async () => {
    const { harness, exec, concluded } = questionHarness(false)
    harness.devLead.reportWarning = 'durable report storage is unavailable on this Host'
    const value = await harness.call('devlead_report', {
      message: 'Which target?', kind: 'question',
    }, exec as never) as Record<string, unknown>
    expect(concluded()).toBe(0)
    expect(value).toMatchObject({ durable: false, queued: true })
    expect(value).not.toHaveProperty('turnEndRequested')
    expect(value).not.toHaveProperty('questionId')
    expect(value).not.toHaveProperty('guidance')
    expect(String(value.warning)).toContain('durable report storage is unavailable')
    expect(String(value.warning)).toContain('restate the question in your final assistant message')
    expect(String(value.warning)).toContain('end your turn naturally')
    expectValidOutput(harness, 'devlead_report', value)
  })

  it('synthesizes the restatement warning when the core carries none', async () => {
    const { harness, exec, concluded } = questionHarness(false)
    const value = await harness.call('devlead_report', {
      message: 'Which target?', kind: 'question',
    }, exec as never) as Record<string, unknown>
    expect(concluded()).toBe(0)
    expect(value).not.toHaveProperty('turnEndRequested')
    expect(String(value.warning)).toContain('restate the question in your final assistant message')
    expectValidOutput(harness, 'devlead_report', value)
  })

  it('advertises the question turn-end request and the memory-only restatement', () => {
    const harness = boot()
    const description = harness.tool('devlead_report').definition.description
    expect(description).toContain('turnEndRequested:true')
    expect(description).toContain('current tool batch still completes')
    expect(description).toContain('next-step work still runs')
    expect(description).toContain('restate the question in your final assistant message')
    const reportSchema = harness.tool('devlead_report').definition.output.schema as {
      properties: { turnEndRequested: { description: string }; questionId: { description: string } }
    }
    expect(reportSchema.properties.turnEndRequested.description).toContain('request')
    expect(reportSchema.properties.turnEndRequested.description).toContain('not an immediate close')
    expect(reportSchema.properties.questionId.description).toContain('turnEndRequested')
    const policy = harness.reportSectionText()
    expect(policy).toContain('turnEndRequested:true')
    expect(policy).toContain('restate the question in your final assistant message')
  })

  it('positions reports as long-task mid-turn milestones, not turn-end re-broadcasts', () => {
    const harness = boot()
    const description = harness.tool('devlead_report').definition.description
    expect(description).toContain('The lead is already notified when your turn settles')
    expect(description).toContain('do not report routine progress or a final summary here')
    expect(description).toContain('only mid-turn, on a long-running task')
    expect(description).toContain('a fork that needs the lead\'s decision')
    expect(description).toContain('change scheduling correctness if it waited')
    expect(description).toContain('a short or linear task should not call it')
    expect(description).toContain('durable` false means no durable receipt was written on this attempt')
    expect(description).toContain('the outbox write failed')
    const reportSchema = harness.tool('devlead_report').definition.output.schema as {
      properties: { durable: { description: string }; warning: { description: string } }
    }
    expect(reportSchema.properties.durable.description).toContain('storage absent or the outbox write failed')
    expect(reportSchema.properties.warning.description).toContain('no durable receipt was written')
    // The brief-writing guidance on create/prompt matches the narrowed scope.
    expect(harness.tool('devlead_create_session').definition.description)
      .toContain('invite it only in a long-running brief')
    expect(harness.tool('devlead_create_session').definition.description)
      .toContain('devlead_report for mid-turn milestones')
    expect(harness.tool('devlead_prompt_session').definition.description)
      .toContain('mention it only in a long-running continuation')
    expect(harness.tool('devlead_prompt_session').definition.description)
      .toContain('devlead_report for mid-turn milestones')
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
  /** One logged user-message source fixture: a bare kind or a kind plus context form. */
  type SourceFixture = string | { readonly kind: string; readonly form?: string }

  /** Build one Agent whose current turn has the given user-message sources. */
  function childAgent(id: string, sources: readonly SourceFixture[]): ReturnType<typeof makeAgent> {
    const events: unknown[] = [{ type: 'turn/start', data: { turn: 1 } }]
    for (const source of sources) {
      events.push({
        type: 'user/message',
        data: { source: typeof source === 'string' ? { kind: source } : source },
      })
    }
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
      message: 'The watched Session asked a question; an answer is requested. Reply with devlead_prompt_session:\n'
        + '- [target] Deploy: Which target?\n'
        + '  - Staging — safe\n'
        + '  - Prod\n'
        + '  (multi-select)',
      summary: 'Question: Deploy',
      questions: [{
        id: 'target',
        header: 'Deploy',
        question: 'Which target?',
        options: [{ label: 'Staging', description: 'safe' }, { label: 'Prod' }],
        multi_select: true,
      }],
    })
    expect(formatQuestionReport({})).toBeUndefined()
  })

  it('bounds and detaches the structured payload while retaining the formatted text path', () => {
    const first = {
      id: 'i'.repeat(2_001),
      header: 'Deploy',
      question: 'q'.repeat(2_001),
      options: Array.from({ length: 17 }, (_, index) => ({ label: `option ${index}` })),
      multi_select: false,
    }
    const args = {
      questions: [
        first,
        ...Array.from({ length: 32 }, (_, index) => ({ question: `question ${index + 1}` })),
      ],
    }
    const report = formatQuestionReport(args)
    expect(report?.questions).toHaveLength(32)
    expect(report?.questions[0]?.id).toHaveLength(2_000)
    expect(report?.questions[0]?.question).toHaveLength(2_000)
    expect(report?.questions[0]?.options).toHaveLength(16)
    expect(report?.questions[0]?.multi_select).toBe(false)
    expect(Array.from(report?.message ?? '')).toHaveLength(4_000)
    expect(report?.message.endsWith('…')).toBe(true)
    expect(report?.message).toContain('asked a question; an answer is requested')
    expect(report?.message).not.toContain('is waiting for your answer')

    first.question = 'changed'
    first.options[0]!.label = 'changed'
    expect(report?.questions[0]?.question).toBe(`${'q'.repeat(1_999)}…`)
    expect(report?.questions[0]?.options?.[0]?.label).toBe('option 0')
  })

  it('recognizes a human-directed turn and ignores injected context', () => {
    expect(isHumanDirectedTurn(childAgent('child-human', ['user']))).toBe(true)
    expect(isHumanDirectedTurn(childAgent('child-lead', ['devlead']))).toBe(false)
    expect(isHumanDirectedTurn(childAgent('child-steered', ['user', 'runtime-context']))).toBe(true)
    // A context injection after the human prompt must not erase the human.
    for (const context of [
      'time-context',
      'agent-instructions',
      'working-directory',
      'tool-registry',
      'ptc-mode',
      'plan-mode',
      'session-reference',
      'action-cards',
      'webhook',
      'hooks-claude-code',
    ]) {
      expect(isHumanDirectedTurn(childAgent(`child-${context}`, ['user', context])), context).toBe(true)
    }
    // Human-origin replies are still the human, even though their kinds are not `user`.
    expect(isHumanDirectedTurn(childAgent('child-question-reply', ['user', 'user-question-reply']))).toBe(true)
    expect(isHumanDirectedTurn(childAgent('child-approval', ['user', 'user-approval']))).toBe(true)
    // An unknown producer kind fails closed instead of guessing a human is present.
    expect(isHumanDirectedTurn(childAgent('child-unknown', ['user', 'some-future-source']))).toBe(false)
    expect(isHumanDirectedTurn(childAgent('child-unknown-only', ['some-future-source']))).toBe(false)
    // An unknown kind carrying a context form is still recognizable as injected.
    expect(isHumanDirectedTurn(childAgent('child-form', ['user', { kind: 'future-context', form: 'snapshot' }])))
      .toBe(true)
    // A lead relay remains actionable, even when a human message precedes it.
    expect(isHumanDirectedTurn(childAgent('child-lead-steered', ['user', 'devlead']))).toBe(false)
    // A human steering after the lead relay is present in the child.
    expect(isHumanDirectedTurn(childAgent('child-human-steered', ['devlead', 'user']))).toBe(true)
  })

  it('skips a lead background notice so it does not mask the human who opened the turn', () => {
    const background = { kind: 'devlead', form: 'notice', wakeRequested: false, lane: 'background' }
    // A background injection after the human prompt must not erase the human.
    expect(isHumanDirectedTurn(childAgent('child-bg-after-human', ['user', background]))).toBe(true)
    // Background alone is non-actionable context: no human is present.
    expect(isHumanDirectedTurn(childAgent('child-bg-only', [background]))).toBe(false)
    // An action-required devlead notice is lead-directed, not skipped context.
    const action = { kind: 'devlead', form: 'notice', wakeRequested: true, lane: 'action-required' }
    expect(isHumanDirectedTurn(childAgent('child-action-after-human', ['user', action]))).toBe(false)
    // An answer relay is lead-directed too.
    const answer = { kind: 'devlead', form: 'relay', intent: 'answer', questionId: 'q', wakeRequested: true }
    expect(isHumanDirectedTurn(childAgent('child-answer-after-human', ['user', answer]))).toBe(false)
    // A devlead notice without the background markers is treated as lead-directed.
    const plainNotice = { kind: 'devlead', form: 'notice' }
    expect(isHumanDirectedTurn(childAgent('child-plain-notice', ['user', plainNotice]))).toBe(false)
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
    expect(request).toMatchObject({
      kind: 'question',
      summary: 'Question: Deploy',
      questions: [{ id: 'target', header: 'Deploy', question: 'Which target?' }],
    })
    expect((request as { message: string }).message).toContain('[target] Deploy: Which target?')
  })

  it('denies and forwards each of two gate calls exactly once without opening the child UI', async () => {
    const harness = boot()
    const child = childAgent('child-two-questions', ['devlead'])
    harness.devLead.supervised.add(child.id)
    const request = {
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [{ id: 'q', header: 'Deploy', question: 'Which target?' }] },
      agent: child,
      signal: new AbortController().signal,
    }
    const first = await harness.preExecute(request)
    const second = await harness.preExecute(request)
    for (const result of [first, second]) {
      expect(result.nextCalls).toBe(0)
      expect(result.decision).toMatchObject({ kind: 'deny' })
    }
    const calls = harness.devLead.callsOf('reportProgress')
    expect(calls).toHaveLength(2)
    for (const [, forwarded] of calls) {
      expect(forwarded).toMatchObject({
        kind: 'question',
        questions: [{ id: 'q', header: 'Deploy', question: 'Which target?' }],
      })
    }
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

  it('appends the restatement hint when the forwarded receipt is memory-only (F7)', async () => {
    const harness = boot()
    const child = childAgent('child-memory-only', ['devlead'])
    harness.devLead.supervised.add(child.id)
    harness.devLead.reportDurable = false
    harness.devLead.reportQueued = true
    harness.devLead.report = { ...harness.devLead.report, kind: 'question' }
    const result = await harness.preExecute({
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [{ id: 'q', question: 'Which?' }] },
      agent: child,
      signal: new AbortController().signal,
    })
    expect(result.nextCalls).toBe(0)
    expect(result.decision).toMatchObject({ kind: 'deny' })
    const reason = (result.decision as { reason: string }).reason
    expect(reason).toContain('forwarded to the DevLead')
    expect(reason).toContain('memory-only')
    expect(reason).toContain('restate the question in your final assistant message')
    // The durable path keeps the original reason without the memory-only hint.
    const durableHarness = boot()
    const durableChild = childAgent('child-durable', ['devlead'])
    durableHarness.devLead.supervised.add(durableChild.id)
    const durableResult = await durableHarness.preExecute({
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [{ id: 'q', question: 'Which?' }] },
      agent: durableChild,
      signal: new AbortController().signal,
    })
    expect((durableResult.decision as { reason: string }).reason).not.toContain('memory-only')
  })

  it('names the full question queue when forwarding hits the delivery cap (F7)', async () => {
    const harness = boot()
    const child = childAgent('child-capacity', ['devlead'])
    harness.devLead.supervised.add(child.id)
    harness.devLead.failures.set('reportProgress', devLeadFailure('DEVLEAD_DELIVERY_RATE_LIMITED'))
    const result = await harness.preExecute({
      name: ASK_USER_QUESTION_TOOL,
      arguments: { questions: [{ id: 'q', question: 'Which?' }] },
      agent: child,
      signal: new AbortController().signal,
    })
    expect(result.nextCalls).toBe(0)
    const reason = (result.decision as { reason: string }).reason
    expect(reason).toContain('DEVLEAD_DELIVERY_RATE_LIMITED')
    expect(reason).toContain('queue is full')
    expect(reason).toContain('state the question in your final assistant message')
    expect(reason).toContain('Do not call ask_user_question again')
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

describe('devlead_prompt_session intent surface (Phase 1d)', () => {
  it('forwards a trimmed intent, question_id, and idempotency_key', async () => {
    const harness = boot()
    await harness.call('devlead_prompt_session', {
      session: 'session-1',
      prompt: 'use staging',
      intent: 'answer',
      question_id: '  report-q  ',
      idempotency_key: '  k1  ',
    })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({
      watch: true,
      interrupt: false,
      intent: 'answer',
      questionId: 'report-q',
      idempotencyKey: 'k1',
      signal: harness.exec.signal,
    })
  })

  it('omits intent/question/idempotency when absent and treats blank as omitted', async () => {
    const harness = boot()
    await harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'go', question_id: '  ', idempotency_key: '  ' })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: true, interrupt: false, signal: harness.exec.signal })
  })

  it('rejects an unknown intent through the schema enum', async () => {
    const harness = boot()
    const error = await failureOf(harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'go', intent: 'steer' }))
    expect(error.code).toBe('INVALID_ARGS')
    expect(harness.devLead.callsOf('promptSession')).toHaveLength(0)
  })

  it('projects the delivery receipt without exposing an internal lane', async () => {
    const harness = boot()
    harness.devLead.prompted = {
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: false,
      delivery: {
        primitive: 'steer',
        boundary: 'next-step',
        wakeRequested: true,
        messageId: 'msg-answer',
        questionId: 'report-q',
        idempotencyKey: 'k1',
      },
    }
    const value = await harness.call('devlead_prompt_session', {
      session: 'session-1',
      prompt: 'use staging',
      intent: 'answer',
      question_id: 'report-q',
      idempotency_key: 'k1',
    })
    expect(value).toEqual({
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: false,
      delivery: {
        primitive: 'steer',
        boundary: 'next-step',
        wakeRequested: true,
        messageId: 'msg-answer',
        questionId: 'report-q',
        idempotencyKey: 'k1',
      },
    })
    expect(value).not.toHaveProperty('lane')
    expect((value as { delivery: Record<string, unknown> }).delivery).not.toHaveProperty('lane')
    expectValidOutput(harness, 'devlead_prompt_session', value)
  })

  it('projects a background delivery with wakeRequested false', async () => {
    const harness = boot()
    harness.devLead.prompted = {
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: false,
      delivery: { primitive: 'inject', boundary: 'next-step', wakeRequested: false, messageId: 'msg-bg' },
    }
    const value = await harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'fyi', intent: 'background' })
    expect((value as { delivery: { primitive: string; wakeRequested: boolean } }).delivery)
      .toMatchObject({ primitive: 'inject', wakeRequested: false })
    expectValidOutput(harness, 'devlead_prompt_session', value)
  })

  it('projects a durable-write warning when the core reports one', async () => {
    const harness = boot()
    harness.devLead.prompted = {
      sessionId: 'session-1',
      watched: true,
      resumed: false,
      interrupted: false,
      delivery: { primitive: 'steer', boundary: 'next-step', wakeRequested: true, messageId: 'msg-answer', questionId: 'report-q' },
      warning: 'the answer record could not be persisted',
    }
    const value = await harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'use staging', intent: 'answer', question_id: 'report-q' })
    expect((value as { warning: string }).warning).toBe('the answer record could not be persisted')
    expectValidOutput(harness, 'devlead_prompt_session', value)
  })

  it('translates the question error codes from the core', async () => {
    const harness = boot()
    harness.devLead.failures.set('promptSession', devLeadFailure('DEVLEAD_QUESTION_NOT_FOUND'))
    const notFound = await failureOf(harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'x', intent: 'answer', question_id: 'q' }))
    expect(notFound.code).toBe('DEVLEAD_QUESTION_NOT_FOUND')
    harness.devLead.failures.set('promptSession', devLeadFailure('DEVLEAD_QUESTION_ALREADY_ANSWERED'))
    const answered = await failureOf(harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'x', intent: 'answer', question_id: 'q' }))
    expect(answered.code).toBe('DEVLEAD_QUESTION_ALREADY_ANSWERED')
  })
})

describe('question/answer state exposure (Phase 1d)', () => {
  /** One question report fixture for the digest. */
  const questionReport = {
    id: 'report-q',
    kind: 'question' as const,
    message: 'Which target?',
    senderSessionId: 'session-1',
    leadSessionId: 'lead-1',
    turn: 1,
    at: 1_700_000_000_000,
  }

  it('enriches question reports in devlead_notifications with questionStatus/answerStatus', async () => {
    const harness = boot()
    harness.devLead.reportDigest = [questionReport]
    harness.devLead.questionAnswer = {
      questionStatus: 'answered',
      answerStatus: 'presented',
      answerMessageId: 'msg-answer',
      answeredAt: 1_700_000_000_001,
      presentedAt: 1_700_000_000_002,
    }
    const value = await harness.call('devlead_notifications')
    expect((value as { reports: unknown[] }).reports).toEqual([{
      ...questionReport,
      questionStatus: 'answered',
      answerStatus: 'presented',
      answerMessageId: 'msg-answer',
      answeredAt: 1_700_000_000_001,
      presentedAt: 1_700_000_000_002,
    }])
    expect(harness.devLead.callsOf('questionAnswerView')[0]).toEqual([harness.agent, 'report-q'])
    expectValidOutput(harness, 'devlead_notifications', value)
  })

  it('reports an open question without answer fields', async () => {
    const harness = boot()
    harness.devLead.reportDigest = [questionReport]
    harness.devLead.questionAnswer = { questionStatus: 'open' }
    const value = await harness.call('devlead_notifications')
    expect((value as { reports: Array<Record<string, unknown>> }).reports[0])
      .toEqual({ ...questionReport, questionStatus: 'open' })
    expectValidOutput(harness, 'devlead_notifications', value)
  })

  it('surfaces repairPending to devlead_notifications and devlead_get_session consumers', async () => {
    const harness = boot()
    harness.devLead.reportDigest = [questionReport]
    harness.devLead.questionAnswer = { questionStatus: 'open', answerStatus: 'discarded', answerMessageId: 'm1', repairPending: true }
    const notifications = await harness.call('devlead_notifications')
    expect((notifications as { reports: Array<Record<string, unknown>> }).reports[0])
      .toEqual({ ...questionReport, questionStatus: 'open', answerStatus: 'discarded', answerMessageId: 'm1', repairPending: true })
    expectValidOutput(harness, 'devlead_notifications', notifications)
    // get_session adds reports only when reading the lead itself: point the
    // session fixture at the agent's own id so the question report is present.
    harness.devLead.session = { ...SESSION, sessionId: harness.agent.id }
    const session = await harness.call('devlead_get_session', { session: harness.agent.id })
    const reports = (session as { reports?: Array<Record<string, unknown>> }).reports
    // Assert explicitly the report is present and carries the provisional flag —
    // never silently skip.
    expect(reports).toBeDefined()
    expect(reports!.length).toBeGreaterThan(0)
    expect(reports![0]).toMatchObject({ repairPending: true })
    expectValidOutput(harness, 'devlead_get_session', session)
  })

  it('passes queuedInput intent/questionId/wakeRequested/deliveryState through devlead_get_session', async () => {
    const harness = boot()
    harness.devLead.queuedInputs = [{
      id: 'msg-answer',
      boundary: 'next-step',
      sourceKind: 'devlead',
      sourceForm: 'relay',
      senderSessionId: 'lead-1',
      intent: 'answer',
      questionId: 'report-q',
      wakeRequested: true,
      deliveryState: 'admitted',
    }]
    const value = await harness.call('devlead_get_session', { session: 'session-1' })
    expect((value as { queuedInputs: unknown[] }).queuedInputs).toEqual(harness.devLead.queuedInputs)
    expectValidOutput(harness, 'devlead_get_session', value)
  })
})
