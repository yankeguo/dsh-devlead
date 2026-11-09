import { describe, expect, it } from 'vitest'
import {
  candidateLabel,
  candidateOf,
  formatCandidates,
  mergeCandidates,
  resolveSessionReference,
} from '../src/resolve.ts'
import type { SessionCandidate } from '../src/resolve.ts'
import { sessionView } from './fake.ts'

/** Build a candidate without a title. */
function bare(sessionId: string): SessionCandidate {
  return { sessionId }
}

/** Build a candidate with a folded title. */
function titled(sessionId: string, title: string): SessionCandidate {
  return { sessionId, title }
}

describe('resolveSessionReference', () => {
  it('resolves an exact id even when other ids share it as a prefix', () => {
    const candidates = [bare('session-alpha'), bare('session-alpha-2')]
    expect(resolveSessionReference('session-alpha', candidates))
      .toEqual({ kind: 'resolved', sessionId: 'session-alpha' })
  })

  it('resolves a unique id prefix and carries the folded title', () => {
    const candidates = [titled('session-alpha', 'webapp'), bare('session-beta')]
    expect(resolveSessionReference('session-a', candidates))
      .toEqual({ kind: 'resolved', sessionId: 'session-alpha', title: 'webapp' })
  })

  it('reports every prefix match as ambiguous, in candidate order', () => {
    const candidates = [titled('session-alpha', 'webapp'), titled('session-alpine', 'docs')]
    const resolution = resolveSessionReference('session-al', candidates)
    expect(resolution.kind).toBe('ambiguous')
    expect(resolution.kind === 'ambiguous' ? resolution.candidates.map(candidate => candidate.sessionId) : [])
      .toEqual(['session-alpha', 'session-alpine'])
  })

  it('treats one id that prefixes the other as ambiguous for the short prefix', () => {
    const resolution = resolveSessionReference('session-a', [bare('session-alpha'), bare('session-alpha-2')])
    expect(resolution.kind).toBe('ambiguous')
  })

  it('reports a missing reference when nothing matches', () => {
    expect(resolveSessionReference('session-z', [bare('session-alpha')])).toEqual({ kind: 'missing' })
    expect(resolveSessionReference('', [bare('session-alpha')])).toEqual({ kind: 'missing' })
    expect(resolveSessionReference('   ', [bare('session-alpha')])).toEqual({ kind: 'missing' })
  })

  it('trims the human-supplied reference before matching', () => {
    expect(resolveSessionReference('  session-alpha  ', [bare('session-alpha')]))
      .toEqual({ kind: 'resolved', sessionId: 'session-alpha' })
  })
})

describe('candidateOf', () => {
  it('omits an absent title and keeps a folded one', () => {
    expect(candidateOf(sessionView('session-alpha'))).toEqual({ sessionId: 'session-alpha' })
    expect(candidateOf(sessionView('session-alpha', { title: 'webapp' })))
      .toEqual({ sessionId: 'session-alpha', title: 'webapp' })
  })
})

describe('mergeCandidates', () => {
  it('keeps listing order, appends watch-only ids, and never duplicates', () => {
    const merged = mergeCandidates(
      [sessionView('session-alpha', { title: 'webapp' }), sessionView('session-beta')],
      ['session-beta', 'session-watched-only'],
    )
    expect(merged).toEqual([
      { sessionId: 'session-alpha', title: 'webapp' },
      { sessionId: 'session-beta' },
      { sessionId: 'session-watched-only' },
    ])
  })

  it('is empty when both sources are empty', () => {
    expect(mergeCandidates([], [])).toEqual([])
  })
})

describe('candidateLabel', () => {
  it('renders title and id when known, the bare id otherwise', () => {
    expect(candidateLabel(titled('session-alpha', 'webapp'))).toBe('webapp (session-alpha)')
    expect(candidateLabel(bare('session-alpha'))).toBe('session-alpha')
  })
})

describe('formatCandidates', () => {
  it('renders one indented line per candidate', () => {
    expect(formatCandidates([titled('session-alpha', 'webapp'), bare('session-beta')])).toEqual([
      '  - webapp (session-alpha)',
      '  - session-beta',
    ])
  })

  it('bounds a long candidate list and reports the remainder', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => bare(`session-${index}`))
    const lines = formatCandidates(candidates)
    expect(lines).toHaveLength(11)
    expect(lines[9]).toBe('  - session-9')
    expect(lines[10]).toBe('  … and 2 more')
  })

  it('does not add a remainder line for exactly the bounded count', () => {
    const candidates = Array.from({ length: 10 }, (_, index) => bare(`session-${index}`))
    expect(formatCandidates(candidates)).toHaveLength(10)
  })
})
