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
import type { DevLeadAnswerStatus, DevLeadQuestionStatus } from '@yankeguo/dsh-devlead-protocol/client'
import { en, zh } from '../src/client/locales.ts'
import {
  answerStatusLabelKey,
  questionStatusLabelKey,
  reportLabelKey,
  transitionLabelKey,
} from '../src/client/format.ts'
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

  it('explains the mid-turn report/question channel in both watch hints', () => {
    // Both hints must still name turn ends and mid-turn reports (questions
    // included); a hint that only names turn ends misdescribes the mode. The
    // Phase-1e split between waking kinds and non-waking background is pinned
    // separately below.
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

  it('separates waking kinds from non-waking background in both watch hints', () => {
    // Phase-1e lane semantics: turn ends and blocked/decision/question reports
    // request a wake; progress/fyi are background context that never wakes.
    // A hint claiming every mid-turn report wakes the lead misdescribes the
    // mode, in either language.
    for (const message of [zh['hint.enabled'], zh['row.hover.watched']]) {
      expect(message).toContain('阻塞/待决策/提问')
      expect(message).toContain('请求唤醒')
      expect(message).toContain('进度/告知')
      expect(message).toContain('不唤醒')
      expect(message).not.toContain('会通知并唤醒')
    }
    for (const message of [en['hint.enabled'], en['row.hover.watched']]) {
      expect(message).toContain('blocked/decision reports and questions')
      expect(message).toContain('request a wake')
      expect(message).toContain('progress/fyi')
      expect(message).toContain('do not wake')
      expect(message).not.toContain('notify and wake')
    }
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

  it('localizes every question lifecycle status in both dictionaries', () => {
    // Runtime twin of the exhaustive status table: a status added to the
    // protocol without a localized label must fail here, not render a raw key.
    const statuses: readonly DevLeadQuestionStatus[] = ['open', 'answered', 'expired', 'cancelled']
    for (const status of statuses) {
      const key = questionStatusLabelKey(status)
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
    expect(zh['report.question.unknown'].length).toBeGreaterThan(0)
    expect(en['report.question.unknown'].length).toBeGreaterThan(0)
    // en renders the literal wire status for the four known literals.
    for (const status of statuses) expect(en[questionStatusLabelKey(status)]).toBe(status)
  })

  it('localizes every answer lifecycle status in both dictionaries', () => {
    const statuses: readonly DevLeadAnswerStatus[] = ['admitted', 'claimed', 'presented', 'discarded', 'failed']
    for (const status of statuses) {
      const key = answerStatusLabelKey(status)
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
      expect(en[key]).toBe(status)
    }
    expect(zh['report.answer.unknown'].length).toBeGreaterThan(0)
    expect(en['report.answer.unknown'].length).toBeGreaterThan(0)
  })

  it('explains the suppressed turn-end wake in both locales', () => {
    // The compact marker plus one explanation per merge rule (and the neutral
    // drift fallback); the copy must name the action-required wake, not blame
    // the transition itself.
    for (const key of [
      'notification.wake.suppressed',
      'notification.wake.merged',
      'notification.wake.included',
      'notification.wake.unknown',
    ] as const) {
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key]).toContain('唤醒')
      expect(en[key]).toContain('wake')
    }
    expect(zh['notification.wake.merged']).toContain('需处理')
    expect(zh['notification.wake.included']).toContain('需处理')
    expect(en['notification.wake.merged']).toContain('action-required')
    expect(en['notification.wake.included']).toContain('action-required')
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
