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
import { DEVLEAD_TRANSITIONS } from '@yankeguo/dsh-devlead-protocol/client'
import { en, zh } from '../src/client/locales.ts'
import { transitionLabelKey } from '../src/client/format.ts'
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

  it('localizes every shared protocol transition', () => {
    for (const transition of DEVLEAD_TRANSITIONS) {
      const key = transitionLabelKey(transition)
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
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
