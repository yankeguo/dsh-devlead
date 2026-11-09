/**
 * Behavior of the eight `devlead_*` tools: registration and gating, per-tool
 * forwarding into `ctx.devLead`, input validation, canonical value projection,
 * error translation, and pure presentation.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { boot, devLeadFailure, makeAgent, NOTIFICATION, SESSION, WORKSPACE } from './harness.ts'
import type { Harness } from './harness.ts'

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

describe('registration', () => {
  it('registers exactly the eight documented tools', () => {
    const harness = boot()
    expect([...harness.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort())
    for (const name of TOOL_NAMES) {
      expect(harness.tool(name).definition.description.length).toBeGreaterThan(0)
    }
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
    expect(text).toContain('devlead_create_session')
    expect(text).toContain('devlead_notifications')
    expect(text).toContain('runtime notice')
    expect(text).toContain('/devlead on')
    const provider = harness.section.text
    if (typeof provider !== 'function') throw new Error('policy section must resolve its text per assembly')
    expect(provider({})).toBe('')
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
  it('defaults to creating a missing directory and omits an absent title', async () => {
    const harness = boot()
    const value = await harness.call('devlead_use_workspace', { path: '/tmp/webapp' })
    const [path, options] = harness.devLead.callsOf('useWorkspace')[0] ?? []
    expect(path).toBe('/tmp/webapp')
    expect(options).toEqual({ create: true, signal: harness.exec.signal })
    expect(value).toEqual({ workspace: WORKSPACE })
  })

  it('trims the path and title and forwards an explicit create flag', async () => {
    const harness = boot()
    await harness.call('devlead_use_workspace', { path: '  /tmp/webapp  ', title: '  webapp  ', create: false })
    const [path, options] = harness.devLead.callsOf('useWorkspace')[0] ?? []
    expect(path).toBe('/tmp/webapp')
    expect(options).toEqual({ create: false, title: 'webapp', signal: harness.exec.signal })
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
  it('forwards the caller, mapped options, and the signal', async () => {
    const harness = boot()
    const value = await harness.call('devlead_list_sessions', {
      workspace: '  ws-1  ',
      watched_only: true,
      limit: 5,
    })
    const [agent, options, signal] = harness.devLead.callsOf('listSessions')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(options).toEqual({ workspace: 'ws-1', watchedOnly: true, limit: 5 })
    expect(signal).toBe(harness.exec.signal)
    expect(value).toEqual({ sessions: [SESSION], watched: ['session-1'] })
  })

  it('omits every option the model did not set', async () => {
    const harness = boot()
    await harness.call('devlead_list_sessions')
    const [, options] = harness.devLead.callsOf('listSessions')[0] ?? []
    expect(options).toEqual({})
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
    expect(value).toEqual({ session: SESSION, workspace: WORKSPACE, prompted: true })
  })

  it('sends only the watch policy when the model passes no destination', async () => {
    const harness = boot()
    await harness.call('devlead_create_session')
    const [, request] = harness.devLead.callsOf('createSession')[0] ?? []
    expect(request).toEqual({ watch: true })
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
    expect(options).toEqual({ watch: true })
    expect(value).toEqual({ sessionId: 'session-1', watched: true, resumed: false })
  })

  it('honors an explicit watch=false', async () => {
    const harness = boot()
    await harness.call('devlead_prompt_session', { session: 'session-1', prompt: 'go', watch: false })
    const [, , , options] = harness.devLead.callsOf('promptSession')[0] ?? []
    expect(options).toEqual({ watch: false })
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
    const [agent, sessionId, watching] = harness.devLead.callsOf('watchSession')[0] ?? []
    expect(agent).toBe(harness.agent)
    expect(sessionId).toBe('session-2')
    expect(watching).toBe(false)
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
