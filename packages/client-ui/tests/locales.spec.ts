/**
 * Locale coherence tests for the `devlead` namespace.
 *
 * The typed dictionaries make a missing English key a compile error; these
 * tests pin the runtime facts the type system cannot see: placeholder parity
 * between languages (a `{message}` added to zh but not en renders the raw
 * token), transition-label coverage of the shared protocol vocabulary, and the
 * plugin-manager display metadata in `locale/*.json` matching the dictionaries.
 */

import { describe, expect, it } from 'vitest'
import { DEVLEAD_REPORT_KINDS, DEVLEAD_TRANSITIONS } from '@yankeguo/dsh-devlead-protocol/client'
import { en, zh } from '../src/client/locales.ts'
import { reportLabelKey, transitionLabelKey } from '../src/client/format.ts'
import enMeta from '../locale/en.json'
import zhMeta from '../locale/zh.json'

/**
 * Extract the `{name}` template placeholders of one message.
 * @param message - dictionary value.
 * @returns sorted placeholder names.
 */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/gu)].map(match => match[1] ?? '').sort()
}

describe('dictionaries', () => {
  it('defines the same non-empty key set in both locales', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const message of [...Object.values(zh), ...Object.values(en)]) {
      expect(message.trim().length).toBeGreaterThan(0)
    }
  })

  it('uses the same template placeholders in both locales', () => {
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]))
    }
  })

  it('uses watch/已关注 consistently in the strip copy', () => {
    expect(zh['count.watched']).toBe('已关注 {count} 个会话')
    expect(zh['hint.enabled']).toContain('已关注会话')
    expect(zh['row.hover.enabled']).toContain('关注')
    expect(zh['row.watched.aria']).toBe('被当前 DevLead 关注')
    expect(zh['row.hover.watched']).toContain('关注')
    for (const message of Object.values(zh)) expect(message).not.toContain('监督')
    expect(en['row.watched.aria']).toContain('Watched')
    expect(en['row.hover.watched']).toContain('Watched')
  })

  it('explains the mid-turn report/question wake channel in both watch hints', () => {
    // Reports (including routed questions) wake the lead through the same
    // coalesced notice path as turn ends; a hint that only names turn ends
    // misdescribes the mode.
    expect(zh['hint.enabled']).toContain('轮次结束')
    expect(zh['hint.enabled']).toContain('中途汇报')
    expect(zh['hint.enabled']).toContain('提问')
    expect(zh['row.hover.watched']).toContain('中途汇报')
    expect(zh['row.hover.watched']).toContain('提问')
    expect(en['hint.enabled']).toContain('turn ends')
    expect(en['hint.enabled']).toContain('mid-turn reports')
    expect(en['hint.enabled']).toContain('questions')
    expect(en['row.hover.watched']).toContain('mid-turn reports')
    expect(en['row.hover.watched']).toContain('questions')
  })

  it('labels the toolbar toggle with the brand name in both locales', () => {
    expect(zh['toggle.label']).toBe('DevLead')
    expect(en['toggle.label']).toBe(zh['toggle.label'])
  })

  it('offers both toggle directions and retires the old strip-switch keys', () => {
    expect(zh['toggle.enable'].length).toBeGreaterThan(0)
    expect(zh['toggle.disable'].length).toBeGreaterThan(0)
    expect(zh['toggle.pending'].length).toBeGreaterThan(0)
    expect(zh['toggle.failed.disable'].length).toBeGreaterThan(0)
    expect(zh['toggle.failed.status.disable'].length).toBeGreaterThan(0)
    expect(en['toggle.disable'].length).toBeGreaterThan(0)
    expect(Object.keys(zh).filter(key => key.startsWith('switch.'))).toEqual([])
    expect(Object.keys(en).filter(key => key.startsWith('switch.'))).toEqual([])
  })

  it('localizes every shared protocol transition', () => {
    for (const transition of DEVLEAD_TRANSITIONS) {
      const key = transitionLabelKey(transition)
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
  })

  it('localizes every shared protocol report kind', () => {
    // The runtime twin of the exhaustive label table: a kind added to the
    // protocol without a localized label must fail here, not render a raw key.
    for (const kind of DEVLEAD_REPORT_KINDS) {
      const key = reportLabelKey(kind)
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
    expect(zh['report.kind.unknown'].length).toBeGreaterThan(0)
    expect(en['report.kind.unknown'].length).toBeGreaterThan(0)
  })

  it('retires the archived single-active refusal copy', () => {
    // Archived occupants no longer block admission, so the core never emits
    // an archived refusal; the dictionaries must not carry a dead variant.
    expect(Object.keys(zh).filter(key => key.includes('archived'))).toEqual([])
    expect(Object.keys(en).filter(key => key.includes('archived'))).toEqual([])
  })
})

describe('plugin-manager metadata', () => {
  it('matches the dictionaries in both locales', () => {
    expect(zhMeta.meta.title).toBe(zh['meta.title'])
    expect(zhMeta.meta.description).toBe(zh['meta.description'])
    expect(enMeta.meta.title).toBe(en['meta.title'])
    expect(enMeta.meta.description).toBe(en['meta.description'])
  })
})
