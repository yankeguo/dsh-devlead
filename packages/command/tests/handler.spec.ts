import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
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
  readonly input?: { readonly hint?: string }
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

/** Invoke the registered command with one raw input and one deterministic Agent. */
function run(
  handler: CapturedCommand['handler'],
  rawInput: string,
  attachments: readonly unknown[] = [],
  agent = fakeAgent(),
): Promise<CommandResult> {
  return Promise.resolve(handler({
    commandId: 'command-1',
    agent,
    rawInput,
    attachments,
    signal: new AbortController().signal,
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
    expect(service.calls).not.toContain('listSessions')
  })

  it('renders the explicit status alias', async () => {
    const { handler, service } = boot()
    service.enabled = true
    const result = await run(handler, 'status')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('DevLead mode: on')
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
    const result = await run(handler, '')
    expect(text(result)).toContain('Watched sessions: 2 (1 running)')
    expect(text(result)).toContain('  - webapp (session-alpha) — running · 1 queued · last turn 3 completed')
    expect(text(result)).toContain('  - api (session-beta) — cold · last turn 1 failed: provider quota exhausted')
    expect(service.calls).toContain('listSessions:watchedOnly')
  })

  it('marks a watched id the listing cannot describe as not found', async () => {
    const { handler, service } = boot()
    service.enabled = true
    service.watching = ['session-missing']
    const result = await run(handler, '')
    expect(text(result)).toContain('  - session-missing — not found')
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
    expect(service.calls).toContain('watchSession:session-alpha:true')
    expect(service.calls.some(call => call.startsWith('getSession:'))).toBe(false)
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
    const result = await run(handler, 'watch session-hidden')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('Now watching hidden (session-hidden).')
    expect(service.watching).toEqual(['session-hidden'])
    expect(service.calls).toContain('getSession:session-hidden')
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
})

describe('devlead command input and failure handling', () => {
  it('appends the usage line to malformed input', async () => {
    const { handler } = boot()
    const result = await run(handler, 'bogus subcommand')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('Unknown /devlead subcommand')
    expect(text(result)).toContain('Usage: /devlead')
  })

  it('rejects composer attachments', async () => {
    const { handler } = boot()
    const result = await run(handler, 'on', [{ type: 'text', text: 'attachment' }])
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('does not accept attachments')
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
