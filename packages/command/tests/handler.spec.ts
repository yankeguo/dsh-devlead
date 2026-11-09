import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { DevLeadErrorCode } from '@yankeguo/dsh-devlead'
import { apply, inject, name } from '../src/index.ts'
import { RECENT_NOTIFICATION_LIMIT } from '../src/render.ts'
import {
  NOW,
  FakeDevLead,
  FakeDevLeadError,
  fakeAgent,
  notification,
  sessionView,
} from './fake.ts'

/** One definition captured from the stubbed command runtime. */
interface CapturedCommand {
  readonly definitionId?: unknown
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint?: string; readonly attachments?: boolean }
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** Boot the command plugin against a stub registry and a fake service. */
function boot(): { readonly handler: CapturedCommand['handler']; readonly service: FakeDevLead } {
  const service = new FakeDevLead()
  let captured: CapturedCommand | undefined
  const ctx = {
    commands: {
      register: (definition: CapturedCommand) => {
        captured = definition
        return () => {}
      },
    },
    devLead: service,
  } as unknown as Context
  apply(ctx)
  if (captured === undefined) throw new Error('command was not registered')
  return { handler: captured.handler, service }
}

/**
 * Invoke the registered command with one raw input and one deterministic Agent.
 * Invocations carry no attachments: the CommandRuntime rejects them before a
 * handler runs because the definition does not declare `input.attachments`.
 */
function run(
  handler: CapturedCommand['handler'],
  rawInput: string,
  agent = fakeAgent(),
  signal: AbortSignal = new AbortController().signal,
): Promise<CommandResult> {
  return Promise.resolve(handler({
    commandId: 'command-1',
    agent,
    rawInput,
    attachments: [],
    signal,
  } as unknown as CommandInvocation))
}

/** Render one result's text for assertion. */
function text(result: CommandResult): string {
  return result.text ?? ''
}

describe('devlead command registration', () => {
  it('exports the plugin name and the services it injects', () => {
    expect(name).toBe('command-devlead')
    expect(inject).toEqual(['commands', 'devLead'])
  })

  it('registers the devlead command with a description and input hint', () => {
    const service = new FakeDevLead()
    let captured: CapturedCommand | undefined
    apply({
      commands: {
        register: (definition: CapturedCommand) => {
          captured = definition
          return () => {}
        },
      },
      devLead: service,
    } as unknown as Context)
    expect(captured?.name).toBe('devlead')
    expect(captured?.definitionId).toBe('@yankeguo/dsh-command-devlead')
    expect(captured?.description).toContain('DevLead mode')
    expect(captured?.input?.hint).toContain('watch <session>')
    expect(captured?.input?.hint).toContain('reset')
    // Attachments are rejected by the CommandRuntime before the handler runs
    // unless a definition advertises them; /devlead must never advertise them.
    expect(captured?.input?.attachments).toBeUndefined()
  })
})

describe('devlead command status', () => {
  it('renders the off state for a fresh Session', async () => {
    const { handler, service } = boot()
    const result = await run(handler, '')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode: off')
    expect(text(result)).toContain('Watched sessions: none')
    expect(text(result)).toContain('Recent notifications: none')
    expect(text(result)).toContain('Turn DevLead mode on with: /devlead on')
    // An empty watch set needs no listing: the status view is complete without it.
    expect(service.calls).not.toContain('listSessions')
    expect(service.listSessionsOptions).toEqual([])
  })

  it('renders the explicit status alias', async () => {
    const { handler, service } = boot()
    service.enabled = true
    const result = await run(handler, 'status')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode: on')
  })

  it('reports whether the Host composes the optional worktree service', async () => {
    const { handler, service } = boot()
    const withoutCapability = await run(handler, '')
    expect(text(withoutCapability)).toContain('Worktree isolation: unavailable')
    service.worktreeIsolationAvailable = true
    const withCapability = await run(handler, '')
    expect(text(withCapability)).toContain('Worktree isolation: available')
  })

  it('shows live and cold watched Sessions with their latest turn', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-alpha', 'session-beta']
    service.sessions = [
      sessionView('session-alpha', {
        title: 'webapp',
        live: true,
        running: true,
        watched: true,
        pendingInputs: 1,
        lastTurn: 3,
        lastTransition: 'completed',
      }),
      sessionView('session-beta', {
        title: 'api',
        live: false,
        watched: true,
        lastTurn: 1,
        lastTransition: 'error',
        lastError: 'provider quota exhausted',
      }),
    ]
    const controller = new AbortController()
    const result = await run(handler, '', fakeAgent(), controller.signal)
    expect(text(result)).toContain('Watched sessions: 2 (1 running)')
    expect(text(result)).toContain('  - webapp (session-alpha) — running · 1 queued · last turn 3 completed')
    expect(text(result)).toContain('  - api (session-beta) — cold · last turn 1 failed: provider quota exhausted')
    expect(service.calls).toContain('listSessions:watchedOnly')
    expect(service.listSessionsOptions).toEqual([{ watchedOnly: true, signal: controller.signal }])
  })

  it('renders an archived watched Session with its archive state', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-alpha']
    service.sessions = [sessionView('session-alpha', { title: 'webapp', archived: true, watched: true })]
    const result = await run(handler, '')
    expect(text(result)).toContain('  - webapp (session-alpha) — archived')
  })

  it('renders a corrupt DevLead projection as a friendly error instead of throwing', async () => {
    const { handler, service } = boot()
    service.view = () => {
      throw new FakeDevLeadError('DEVLEAD_PROJECTION_INVALID', 'record 4 is not valid JSON')
    }
    const result = await run(handler, '')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('records are damaged')
    expect(text(result)).toContain('record 4 is not valid JSON')
    expect(text(result)).toContain('/devlead reset')
    expect(text(result)).toContain('discards the watched-Session set and the notification digest')
  })

  it('renders a dead receiving Agent as a friendly error instead of throwing', async () => {
    const { handler, service } = boot()
    service.view = () => {
      throw new FakeDevLeadError('DEVLEAD_AGENT_NOT_LIVE', 'agent is not live')
    }
    const result = await run(handler, '')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('no longer live')
  })

  it('marks a watched id the listing cannot describe as not found', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-missing']
    const result = await run(handler, '')
    expect(text(result)).toContain('  - session-missing — not found')
  })

  it('renders a domain listing failure as a friendly error instead of throwing', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-alpha']
    service.listSessions = async () => {
      throw new FakeDevLeadError('DEVLEAD_PROJECTION_INVALID', 'fold failed on record 2')
    }
    const result = await run(handler, '')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('records are damaged')
    expect(text(result)).toContain('fold failed on record 2')
  })

  it('shows only the most recent notifications', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.feed = Array.from({ length: RECENT_NOTIFICATION_LIMIT + 2 }, (_, index) => notification({
      sessionId: `session-${index}`,
      turn: index + 1,
      at: NOW + index,
    }))
    const result = await run(handler, '')
    expect(text(result)).toContain('Recent notifications:')
    expect(text(result)).not.toContain('session-0')
    expect(text(result)).not.toContain('session-1')
    expect(text(result)).toContain(`session-${RECENT_NOTIFICATION_LIMIT + 1}`)
  })

  it('keeps showing the watch set after mode is turned off', async () => {
    const { handler, service } = boot()
    service.enabled = false
    service.watching = ['session-alpha']
    service.sessions = [sessionView('session-alpha', { title: 'webapp', watched: true })]
    const result = await run(handler, '')
    expect(text(result)).toContain('DevLead mode: off')
    expect(text(result)).toContain('  - webapp (session-alpha) — cold')
    expect(text(result)).toContain('DevLead mode is off: no notification wakes this Session')
  })
})

describe('devlead command reset', () => {
  it('discards the watch set and digest and renders the default disabled state', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-alpha']
    service.feed = [notification({ sessionId: 'session-alpha', title: 'webapp' })]
    const result = await run(handler, 'reset')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead state reset.')
    expect(text(result)).toContain('DevLead mode: off')
    expect(text(result)).toContain('Watched sessions: none')
    expect(text(result)).toContain('Recent notifications: none')
    expect(service.calls).toContain('reset')
    expect(service.enabled).toBe(false)
    expect(service.watching).toEqual([])
    expect(service.feed).toEqual([])
  })

  it('works whatever the current mode is and forwards the invocation signal', async () => {
    const { handler, service } = boot()
    const controller = new AbortController()
    const signals: (AbortSignal | undefined)[] = []
    service.reset = async (_agent, signal) => {
      signals.push(signal)
    }
    const result = await run(handler, 'reset', fakeAgent(), controller.signal)
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead state reset.')
    expect(signals).toEqual([controller.signal])
  })

  it('recovers a frozen fold and renders the reset state', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-alpha']
    service.frozenReason = 'record 4 is not valid JSON'
    const result = await run(handler, 'reset')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead state reset.')
    expect(text(result)).toContain('DevLead mode: off')
    expect(text(result)).toContain('Watched sessions: none')
    expect(service.frozenReason).toBeNull()
    expect(service.watching).toEqual([])
  })

  it('reports a dead receiving Agent as a friendly error instead of throwing', async () => {
    const { handler, service } = boot()
    service.reset = async () => {
      throw new FakeDevLeadError('DEVLEAD_AGENT_NOT_LIVE', 'agent is not live')
    }
    const result = await run(handler, 'reset')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('no longer live')
  })
})

describe('devlead command mode switch', () => {
  it('turns the mode on and renders the new status', async () => {
    const { handler, service } = boot()
    const result = await run(handler, 'on')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode enabled.')
    expect(service.enabled).toBe(true)
    expect(service.calls).toContain('setEnabled:true')
  })

  it('turns the mode off and renders the new status', async () => {
    const { handler, service } = boot()
    service.enabled = true
    const result = await run(handler, 'off')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode disabled.')
    expect(service.enabled).toBe(false)
    expect(service.calls).toContain('setEnabled:false')
  })

  it('does not rewrite the mode when it is already in the requested state', async () => {
    const { handler, service } = boot()
    service.enabled = true
    const on = await run(handler, 'on')
    expect(text(on)).toContain('DevLead mode is already on.')
    expect(service.calls).not.toContain('setEnabled:true')

    service.enabled = false
    const off = await run(handler, 'off')
    expect(text(off)).toContain('DevLead mode is already off.')
    expect(service.calls).not.toContain('setEnabled:false')
  })

  it('renders a friendly error when the Agent is no longer live', async () => {
    const { handler, service } = boot()
    service.setEnabled = async () => {
      throw new FakeDevLeadError('DEVLEAD_AGENT_NOT_LIVE', 'agent is not live')
    }
    const result = await run(handler, 'on')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('no longer live')
  })

  it('turns the mode off on a frozen fold by resetting the damaged records', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-alpha']
    service.frozenReason = 'record 4 is not valid JSON'
    const result = await run(handler, 'off')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode disabled; the damaged DevLead records were reset.')
    expect(text(result)).toContain('DevLead mode: off')
    expect(service.calls).toContain('setEnabled:false')
    expect(service.frozenReason).toBeNull()
    expect(service.watching).toEqual([])
  })

  it('refuses to turn the mode on from a frozen fold and names the reset command', async () => {
    const { handler, service } = boot()
    service.frozenReason = 'record 4 is not valid JSON'
    const result = await run(handler, 'on')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('records are damaged')
    expect(text(result)).toContain('/devlead reset')
    expect(text(result)).toContain('record 4 is not valid JSON')
    expect(service.calls).not.toContain('setEnabled:true')
    // The refusal must not recover behind the human's back.
    expect(service.frozenReason).toBe('record 4 is not valid JSON')
  })

  it('renders the state the post-mutation snapshot shows when another command flips the mode', async () => {
    const { handler, service } = boot()
    const setEnabled = service.setEnabled.bind(service)
    service.setEnabled = async (agent, enabled, signal) => {
      await setEnabled(agent, enabled, signal)
      // A concurrent command or UI toggle wins right after this mutation commits.
      service.enabled = !enabled
    }
    const result = await run(handler, 'on')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode is off (another command changed it).')
    expect(text(result)).toContain('DevLead mode: off')
    expect(text(result)).not.toContain('DevLead mode enabled.')
  })

  it('renders the state the post-mutation snapshot shows when another command flips the mode back on', async () => {
    const { handler, service } = boot()
    service.enabled = true
    const setEnabled = service.setEnabled.bind(service)
    service.setEnabled = async (agent, enabled, signal) => {
      await setEnabled(agent, enabled, signal)
      // A concurrent command turns the mode back on right after this mutation.
      service.enabled = !enabled
    }
    const result = await run(handler, 'off')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode is on (another command changed it).')
    expect(text(result)).toContain('DevLead mode: on')
    expect(text(result)).not.toContain('DevLead mode disabled.')
  })

  it('withdraws an already-on title the post snapshot no longer supports', async () => {
    const { handler, service } = boot()
    service.enabled = true
    const view = service.view.bind(service)
    let reads = 0
    service.view = (agent) => {
      reads += 1
      // The second read is the post-mutation snapshot: another command turned
      // the mode off between the decision read and the render.
      if (reads === 2) service.enabled = false
      return view(agent)
    }
    const result = await run(handler, 'on')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode is off (another command changed it).')
    expect(text(result)).toContain('DevLead mode: off')
    expect(text(result)).not.toContain('DevLead mode is already on.')
  })
})

describe('devlead command watch set', () => {
  /** Seed one enabled lead with two addressable Sessions. */
  function seeded(): { handler: CapturedCommand['handler']; service: FakeDevLead } {
    const booted = boot()
    booted.service.enabled = true
    booted.service.sessions = [
      sessionView('session-alpha', { title: 'webapp' }),
      sessionView('session-bravo', { title: 'api' }),
    ]
    return booted
  }

  it('watches a Session by unique id prefix and reports the new state', async () => {
    const { handler, service } = seeded()
    const result = await run(handler, 'watch session-a')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('Now watching webapp (session-alpha).')
    expect(service.watching).toEqual(['session-alpha'])
    expect(service.calls).toContain('getSession:session-a')
    expect(service.calls).toContain('watchSession:session-alpha:true')
  })

  it('confirms a prefix against the exhaustive resolver before mutating', async () => {
    const { handler, service } = seeded()
    // The bounded listing sees only one match; the core resolver also sees a
    // persisted Session the listing window omitted. The prefix is ambiguous and
    // must not silently resolve to the listed row.
    service.extraSessions = [sessionView('session-alpine', { title: 'docs' })]
    const result = await run(handler, 'watch session-a')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('ambiguous')
    expect(service.watching).toEqual([])
    expect(service.calls.filter(call => call.startsWith('watchSession:'))).toEqual([])
  })

  it('watches a Session by exact id', async () => {
    const { handler, service } = seeded()
    const result = await run(handler, 'watch session-bravo')
    expect(text(result)).toContain('Now watching api (session-bravo).')
    expect(service.watching).toEqual(['session-bravo'])
  })

  it('does not re-add a Session this lead already watches', async () => {
    const { handler, service } = seeded()
    service.watching = ['session-alpha']
    const result = await run(handler, 'watch session-alpha')
    expect(text(result)).toContain('Already watching webapp (session-alpha).')
    expect(service.calls.filter(call => call.startsWith('watchSession:'))).toEqual([])
  })

  it('unwatches a watched Session by id prefix', async () => {
    const { handler, service } = seeded()
    service.watching = ['session-alpha']
    const result = await run(handler, 'unwatch session-a')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('Stopped watching webapp (session-alpha).')
    expect(service.watching).toEqual([])
    expect(service.calls).toContain('watchSession:session-alpha:false')
  })

  it('does not call the service when the Session is not watched', async () => {
    const { handler, service } = seeded()
    const result = await run(handler, 'unwatch session-alpha')
    expect(text(result)).toContain('Not watching webapp (session-alpha).')
    expect(service.calls.filter(call => call.startsWith('watchSession:'))).toEqual([])
  })

  it('unwatches a stale watched id the listing no longer returns', async () => {
    const { handler, service } = seeded()
    service.watching = ['session-gone']
    service.sessions = []
    const result = await run(handler, 'unwatch session-gone')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('Stopped watching session-gone.')
    expect(service.watching).toEqual([])
  })

  it('lists candidate Sessions for an ambiguous prefix', async () => {
    const { handler, service } = seeded()
    service.sessions = [
      sessionView('session-alpha', { title: 'webapp' }),
      sessionView('session-alpine', { title: 'docs' }),
    ]
    const result = await run(handler, 'watch session-al')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('ambiguous')
    expect(text(result)).toContain('webapp (session-alpha)')
    expect(text(result)).toContain('docs (session-alpine)')
    expect(text(result)).toContain('Use a longer prefix or the full Session id.')
    expect(service.calls.filter(call => call.startsWith('watchSession:'))).toEqual([])
    expect(service.calls.some(call => call.startsWith('getSession:'))).toBe(false)
  })

  it('reports a reference that matches no Session', async () => {
    const { handler } = seeded()
    const result = await run(handler, 'watch session-zulu')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('No Session matches "session-zulu"')
  })

  it('resolves a full id beyond the bounded listing through the core resolver', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.sessions = []
    service.extraSessions = [sessionView('session-hidden', { title: 'hidden' })]
    const controller = new AbortController()
    const result = await run(handler, 'watch session-hidden', fakeAgent(), controller.signal)
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('Now watching hidden (session-hidden).')
    expect(service.watching).toEqual(['session-hidden'])
    expect(service.calls).toContain('getSession:session-hidden')
    expect(service.getSessionSignals).toEqual([controller.signal])
  })

  it('reports a Session that vanished between resolution and the watch mutation', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.sessions = [sessionView('session-alpha')]
    service.watchSession = async () => {
      throw new FakeDevLeadError('DEVLEAD_SESSION_NOT_FOUND', 'no Session matches "session-alpha"')
    }
    const result = await run(handler, 'watch session-alpha')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('could not find that Session')
  })

  it('reports mode switched off between the view and the watch mutation', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.sessions = [sessionView('session-alpha')]
    service.watchSession = async () => {
      throw new FakeDevLeadError('DEVLEAD_NOT_ENABLED', 'devlead mode is not enabled')
    }
    const result = await run(handler, 'watch session-alpha')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('DevLead mode is off for this Session')
  })

  it('rethrows a resolver transport failure unchanged', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.getSession = async () => {
      throw new Error('query engine offline')
    }
    await expect(run(handler, 'watch session-hidden')).rejects.toThrow('query engine offline')
  })

  it('rethrows a watch-set transport failure unchanged', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-alpha']
    service.listSessions = async () => {
      throw new Error('session store offline')
    }
    await expect(run(handler, 'watch session-alpha')).rejects.toThrow('session store offline')
  })

  it('reports the core ambiguity for a prefix beyond the listing', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.extraSessions = [
      sessionView('session-alpha', { title: 'webapp' }),
      sessionView('session-alpine', { title: 'docs' }),
    ]
    const result = await run(handler, 'watch session-al')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('ambiguous')
    expect(text(result)).toContain('session-alpha')
    expect(text(result)).toContain('session-alpine')
    expect(text(result)).toContain('Use a longer prefix or the full Session id.')
  })

  it('refuses to change the watch set while DevLead mode is off', async () => {
    const { handler, service } = boot()
    service.sessions = [sessionView('session-alpha')]
    const result = await run(handler, 'watch session-alpha')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('DevLead mode is off for this Session')
    expect(service.calls).not.toContain('listSessions')
  })

  it('renders a friendly error for the self-watch guard', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.sessions = [sessionView('lead-agent', { title: 'this lead' })]
    const result = await run(handler, 'watch lead-agent')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('cannot watch itself')
  })

  it('renders a friendly error for the watch limit', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.sessions = [sessionView('session-alpha')]
    service.watchSession = async () => {
      throw new FakeDevLeadError('DEVLEAD_WATCH_LIMIT', 'watch limit reached')
    }
    const result = await run(handler, 'watch session-alpha')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('maximum number of watched Sessions')
  })

  it('renders a friendly error for an archived Session', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.sessions = [sessionView('session-alpha')]
    service.watchSession = async () => {
      throw new FakeDevLeadError('DEVLEAD_SESSION_ARCHIVED', 'session is archived')
    }
    const result = await run(handler, 'watch session-alpha')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('archived')
  })

  it('renders the watch set the post-mutation snapshot shows when another command unwatches', async () => {
    const { handler, service } = seeded()
    const watchSession = service.watchSession.bind(service)
    service.watchSession = async (agent, sessionId, watching) => {
      const mutation = await watchSession(agent, sessionId, watching)
      // A concurrent command removes the watch right after this mutation.
      service.watching = service.watching.filter(id => id !== sessionId)
      return mutation
    }
    const result = await run(handler, 'watch session-alpha')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('Not watching webapp (session-alpha) (another command changed it).')
    expect(text(result)).toContain('Watched sessions: none')
    expect(text(result)).not.toContain('Now watching webapp (session-alpha).')
  })

  it('retracts a stopped-watching title the post snapshot no longer supports', async () => {
    const { handler, service } = seeded()
    service.watching = ['session-alpha']
    const watchSession = service.watchSession.bind(service)
    service.watchSession = async (agent, sessionId, watching) => {
      const mutation = await watchSession(agent, sessionId, watching)
      // A concurrent command re-adds the watch right after this mutation.
      service.watching = [...service.watching, sessionId]
      return mutation
    }
    const result = await run(handler, 'unwatch session-alpha')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('Still watching webapp (session-alpha) (another command changed it).')
    expect(text(result)).toContain('Watched sessions: 1')
    expect(text(result)).not.toContain('Stopped watching webapp (session-alpha).')
  })
})

describe('devlead command friendly error mapping', () => {
  /** Every stable code with the phrase the friendly command error must carry. */
  const MAPPING: readonly (readonly [DevLeadErrorCode, string])[] = [
    ['DEVLEAD_INVALID_INPUT', 'not usable'],
    ['DEVLEAD_NOT_ENABLED', 'DevLead mode is off for this Session'],
    ['DEVLEAD_AGENT_NOT_LIVE', 'no longer live'],
    ['DEVLEAD_WORKSPACE_NOT_FOUND', 'Workspace could not be resolved'],
    ['DEVLEAD_DIRECTORY_MISSING', 'target directory is missing'],
    ['DEVLEAD_SESSION_NOT_FOUND', 'could not find that Session'],
    ['DEVLEAD_SESSION_ARCHIVED', 'archived'],
    ['DEVLEAD_SESSION_UNAVAILABLE', 'cannot be resumed right now'],
    ['DEVLEAD_WATCH_LIMIT', 'maximum number of watched Sessions'],
    ['DEVLEAD_SELF_WATCH', 'cannot watch itself'],
    ['DEVLEAD_PROJECTION_INVALID', 'records are damaged'],
  ]

  /** Codes absent from {@link MAPPING}; the record fails to compile when non-never. */
  const UNMAPPED_CODES: Record<Exclude<DevLeadErrorCode, (typeof MAPPING)[number][0]>, true> = {}

  it('has a mapping fixture for every stable code', () => {
    expect(UNMAPPED_CODES).toEqual({})
  })

  it('covers every stable core error code with actionable text', async () => {
    for (const [code, phrase] of MAPPING) {
      const { handler, service } = boot()
      service.enabled = true
      service.sessions = [sessionView('session-alpha')]
      service.watchSession = async () => {
        throw new FakeDevLeadError(code, `injected ${code}`)
      }
      const result = await run(handler, 'watch session-alpha')
      expect(result.kind, code).toBe('error')
      expect(text(result), code).toContain(phrase)
    }
  })
})

describe('devlead command input and failure handling', () => {
  it('appends the usage line to malformed input', async () => {
    const { handler } = boot()
    const result = await run(handler, 'bogus subcommand')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('Unknown /devlead subcommand')
    expect(text(result)).toContain('Usage: /devlead')
  })

  it('does not convert unexpected implementation failures into command results', async () => {
    const { handler, service } = boot()
    service.listSessions = async () => {
      throw new Error('boom')
    }
    service.watching = ['session-alpha']
    await expect(run(handler, '')).rejects.toThrow('boom')
  })
})
