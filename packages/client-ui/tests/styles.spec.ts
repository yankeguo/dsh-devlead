/**
 * Unit tests for the plugin-owned stylesheet injection (`styles.ts`).
 *
 * The module only touches `document.head`, `document.createElement`, and the
 * created `<style>` element, so a tiny fake DOM is enough to test injection,
 * reuse, content refresh, disposal, and the realm-wide reference count across
 * module instances (a hot update or `vi.resetModules()`) without adding a jsdom
 * dependency.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureStyleTag, styles } from '../src/client/styles.ts'

/** Attribute key/value the injected tag must carry. */
const STYLE_ATTRIBUTE = 'data-plugin-css'
const STYLE_KEY = 'devlead'

/** Minimal `<style>` element surface used by `ensureStyleTag`. */
interface FakeStyleElement {
  readonly attributes: Map<string, string>
  textContent: string
  isConnected: boolean
  setAttribute(name: string, value: string): void
  remove(): void
}

/** Minimal document surface used by `ensureStyleTag`. */
interface FakeDocument {
  readonly head: {
    readonly children: FakeStyleElement[]
    querySelector(selector: string): FakeStyleElement | null
    appendChild(element: FakeStyleElement): FakeStyleElement
  }
  createElement(tagName: string): FakeStyleElement
}

/**
 * Build a fake document whose `head` holds style elements in insertion order.
 * @returns the fake document.
 */
function createFakeDocument(): FakeDocument {
  const children: FakeStyleElement[] = []
  const removeChild = (element: FakeStyleElement): void => {
    const index = children.indexOf(element)
    if (index >= 0) children.splice(index, 1)
    element.isConnected = false
  }
  return {
    head: {
      children,
      querySelector(selector) {
        const match = /style\[data-plugin-css="([^"]+)"\]/u.exec(selector)
        if (match === null) return null
        return children.find(child => child.attributes.get(STYLE_ATTRIBUTE) === match[1]) ?? null
      },
      appendChild(element) {
        element.isConnected = true
        children.push(element)
        return element
      },
    },
    createElement() {
      const element: FakeStyleElement = {
        attributes: new Map<string, string>(),
        textContent: '',
        isConnected: false,
        setAttribute(name, value) {
          element.attributes.set(name, value)
        },
        remove() {
          removeChild(element)
        },
      }
      return element
    },
  }
}

/**
 * Install a fake DOM as the global `document` for one test.
 * @param document - fake document instance.
 */
function installDocument(document: FakeDocument): void {
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true })
}

/**
 * `Symbol.for` key under which `styles.ts` keeps its realm-wide refcount.
 *
 * Each case starts from a clean counter (a tag left installed by one case must
 * not leak a reference into the next one), so this must stay equal to the
 * literal in the module under test.
 */
const STYLE_TAG_STATE_KEY = Symbol.for('@yankeguo/dsh-client-ui-devlead.style-tag')

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, STYLE_TAG_STATE_KEY)
})

describe('ensureStyleTag', () => {
  it('is a no-op without a DOM', () => {
    const dispose = ensureStyleTag()
    expect(typeof dispose).toBe('function')
    expect(() => {
      dispose()
      dispose()
    }).not.toThrow()
    // The no-DOM path must not even arm the shared refcount.
    expect((globalThis as unknown as Record<symbol, unknown>)[STYLE_TAG_STATE_KEY]).toBeUndefined()
  })

  it('injects the stylesheet once with the plugin-owned attribute and reuses the tag', () => {
    const document = createFakeDocument()
    installDocument(document)

    const first = ensureStyleTag()
    const second = ensureStyleTag()
    expect(document.head.children).toHaveLength(1)
    const tag = document.head.children[0]
    expect(tag?.attributes.get(STYLE_ATTRIBUTE)).toBe(STYLE_KEY)
    expect(tag?.textContent).toBe(styles)

    first()
    // The second reference still holds the tag: only the last dispose removes it.
    expect(document.head.children).toHaveLength(1)
    second()
    expect(document.head.children).toHaveLength(0)
  })

  it('is idempotent: a disposer released twice counts once', () => {
    const document = createFakeDocument()
    installDocument(document)

    const first = ensureStyleTag()
    const second = ensureStyleTag()
    first()
    first()
    expect(document.head.children).toHaveLength(1)

    second()
    expect(document.head.children).toHaveLength(0)
    // A late second call after the tag is gone is harmless too.
    expect(() => {
      second()
    }).not.toThrow()
  })

  it('refreshes the text of a reused tag after a stylesheet change', () => {
    const document = createFakeDocument()
    installDocument(document)

    const first = ensureStyleTag()
    expect(document.head.children[0]?.textContent).toBe(styles)
    document.head.children[0]!.textContent = '/* stale */'

    const second = ensureStyleTag()
    expect(document.head.children[0]?.textContent).toBe(styles)
    first()
    second()
  })

  it('adopts a matching tag already in the document instead of stacking a second one', () => {
    // Written by an older module instance that predates the shared refcount.
    const document = createFakeDocument()
    installDocument(document)
    const orphan = document.createElement('style')
    orphan.setAttribute(STYLE_ATTRIBUTE, STYLE_KEY)
    orphan.textContent = '/* older sheet */'
    document.head.appendChild(orphan)

    const dispose = ensureStyleTag()
    expect(document.head.children).toHaveLength(1)
    expect(document.head.children[0]).toBe(orphan)
    expect(orphan.textContent).toBe(styles)

    dispose()
    expect(document.head.children).toHaveLength(0)
  })

  it('replaces a known tag that was detached from the document', () => {
    const document = createFakeDocument()
    installDocument(document)

    const first = ensureStyleTag()
    const detached = document.head.children[0]!
    detached.remove()
    expect(document.head.children).toHaveLength(0)

    const second = ensureStyleTag()
    expect(document.head.children).toHaveLength(1)
    expect(document.head.children[0]).not.toBe(detached)

    first()
    expect(document.head.children).toHaveLength(1)
    second()
    expect(document.head.children).toHaveLength(0)
  })

  it('re-injects after the tag was removed and disposes the new tag', () => {
    const document = createFakeDocument()
    installDocument(document)

    const first = ensureStyleTag()
    first()
    expect(document.head.children).toHaveLength(0)

    const second = ensureStyleTag()
    expect(document.head.children).toHaveLength(1)
    second()
    expect(document.head.children).toHaveLength(0)
  })

  it('shares the refcount across module instances so an old dispose cannot remove a live tag', async () => {
    const document = createFakeDocument()
    installDocument(document)

    const disposeOld = ensureStyleTag()
    const tag = document.head.children[0]
    // A hot update changed the stylesheet while the old tag was installed.
    tag!.textContent = '/* stale from the replaced instance */'

    // A second module instance, as a client-plugin hot update (or a reloaded
    // test module) would evaluate.
    vi.resetModules()
    const fresh = await import('../src/client/styles.ts')
    // Guard the premise: the reload really evaluated a second module instance.
    expect(fresh.ensureStyleTag).not.toBe(ensureStyleTag)
    const disposeFresh = fresh.ensureStyleTag()

    // The new instance adopted the existing tag and refreshed its text.
    expect(document.head.children).toHaveLength(1)
    expect(document.head.children[0]).toBe(tag)
    expect(tag?.textContent).toBe(styles)

    // Disposing the old instance must release only its own reference: the tag
    // is still in use by the new instance.
    disposeOld()
    expect(tag?.isConnected).toBe(true)
    expect(document.head.children).toHaveLength(1)

    // The last reference removes it.
    disposeFresh()
    expect(document.head.children).toHaveLength(0)
  })

  it('re-creates the tag after every module instance released it', async () => {
    const document = createFakeDocument()
    installDocument(document)

    const disposeOld = ensureStyleTag()
    vi.resetModules()
    const fresh = await import('../src/client/styles.ts')
    const disposeFresh = fresh.ensureStyleTag()
    disposeOld()
    disposeFresh()
    expect(document.head.children).toHaveLength(0)

    // A fresh reference after the refcount hit zero installs a new tag.
    const disposeAgain = fresh.ensureStyleTag()
    expect(document.head.children).toHaveLength(1)
    disposeAgain()
    expect(document.head.children).toHaveLength(0)
  })
})

describe('styles', () => {
  it('styles the dock root with theme tokens and neutral fallbacks', () => {
    expect(styles).toContain('.devlead-toggle {')
    expect(styles).toContain('.devlead-dock {')
    expect(styles).toContain('.devlead-bar {')
    expect(styles).toContain('--dsw-alias-border-l1')
    // Neutral fallbacks keep the strip readable if a harness token is missing.
    expect(styles).toContain('CanvasText')
  })

  it('lines the dock up with the composer card geometry', () => {
    // The composer context-stack contract: 100% minus two side clearances and
    // four dock insets, capped by the card max width minus the same insets.
    expect(styles).toContain('--dsh-composer-side-clearance')
    expect(styles).toContain('--dsh-composer-dock-inset')
    expect(styles).toContain('--dsh-composer-card-max-width')
  })

  it('draws the menu-surface card with the elevation triple and a backdrop layer', () => {
    // Matches the shipped composer cards: the hairline lives inside the
    // elevation shadow (`--dsw-elevation-stroke-color`), so there is no CSS
    // border and the translucent menu fill gets its blur from a painted layer.
    expect(styles).toContain('--dsw-elevation-stroke-color: var(--dsw-alias-border-l1')
    expect(styles).toContain('box-shadow: var(--dsw-elevation-panel')
    expect(styles).toContain('backdrop-filter: var(--dsw-menu-backdrop-filter')
    expect(styles).toContain('.devlead-bar::before')
  })

  it('lays the labelled toggle out as an auto-width composer-tool control', () => {
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*width: auto;/u)
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*height: 28px;/u)
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*padding: 0 9px;/u)
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*border: 1px solid transparent;/u)
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*gap: 6px;/u)
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*border-radius: 999px;/u)
    expect(styles).toMatch(/\.devlead-toggle-label \{[^}]*white-space: nowrap;/u)
    // The visible label replaced the fixed 28px square; the strip stays read-only.
    expect(styles).not.toMatch(/\.devlead-toggle \{[^}]*width: 28px;/u)
    expect(styles).not.toContain('.devlead-switch')
    expect(styles).toContain('.devlead-toggle[data-devlead-enabled="true"]')
  })

  it('ships active and watched sidebar Session-row marks plus the hover line', () => {
    // The mark sits inline in the row's resting seat and must never grow the
    // row: no padding or fixed height, only the icon's own box.
    expect(styles).toContain('.devlead-row-mark {')
    expect(styles).toMatch(/\.devlead-row-mark \{[^}]*flex: none;/u)
    expect(styles).toContain('.devlead-row-mark-watched {')
    expect(styles).toContain('.devlead-row-hover-active-dot {')
    expect(styles).toContain('.devlead-row-hover {')
    expect(styles).toMatch(/\.devlead-row-hover \{[^}]*font-size: 12px;/u)
  })

  it('rings the active lead row symmetrically with a non-layout overlay', () => {
    expect(styles).toContain('[data-row-key^="session:"]:has([data-devlead-active-mark="true"])::after')
    expect(styles).toContain('border: 1px solid var(--dsw-alias-state-business-primary')
    expect(styles).toContain('border-radius: inherit')
    // The paint-inset read carries the shell's 3px value as a fallback so a
    // renamed token degrades to a slightly inset ring, not a broken `inset`.
    expect(styles).toContain('inset: 0 calc(-1 * var(--dsh-sidebar-paint-inset, 3px))')
    expect(styles).toContain('box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary')
    // The shell row has a 3px transparent border-inline but no top/bottom
    // border. Colouring or resizing it would be asymmetric; the ring must be an
    // absolutely positioned overlay covering all four sides instead.
    const activeRule = /\[data-row-key\^="session:"\]:has\(\[data-devlead-active-mark="true"\]\)::after \{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(activeRule).toContain('position: absolute')
    expect(activeRule).toContain('pointer-events: none')
    expect(activeRule).not.toContain('border-color')
    expect(activeRule).not.toContain('padding')
    expect(activeRule).not.toContain('margin')
    expect(activeRule).not.toContain('height')
  })

  it('ships the notice live region and the visually-hidden failure seat', () => {
    expect(styles).toContain('.devlead-notice {')
    expect(styles).toContain('.devlead-notification-dot[data-transition="completed"]')
    expect(styles).toMatch(/\.devlead-sr-only \{[^}]*clip: rect\(0 0 0 0\);/u)
    // Inline command errors moved to the toolbar toggle's tooltip/live region.
    expect(styles).not.toContain('.devlead-error')
  })

  it('renders report detail in neutral copy ink, reserving error red for failures', () => {
    // A report's summary/message is copy, not a failure: the kind dot and
    // localized label carry the semantics, so progress/fyi/question text must
    // not read as an error. Only a turn failure excerpt keeps the error ink.
    expect(styles).toContain('.devlead-notification-detail {')
    // Anchor to the color-first standalone rules: the shared layout rule
    // lists both selectors and must not be mistaken for a color rule.
    const detail = /\.devlead-notification-detail \{\s*(color:[^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(detail).toContain('var(--dsw-alias-label-secondary')
    expect(detail).not.toContain('--dsw-alias-label-error')
    const error = /\.devlead-notification-error \{\s*(color:[^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(error).toContain('var(--dsw-alias-label-error')
  })

  it('colors every action-required report kind with the warning ink, not error red', () => {
    // blocked/decision/question share the warning dot: a blocked report is a
    // scheduling fact, not a Host failure (error red stays with transitions).
    const warnDot = /\.devlead-notification-dot\[data-report-kind="blocked"\],\s*\.devlead-notification-dot\[data-report-kind="decision"\],\s*\.devlead-notification-dot\[data-report-kind="question"\] \{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(warnDot).toContain('var(--dsw-alias-state-warn-primary')
    expect(styles).not.toMatch(/\[data-report-kind="blocked"\][^{]*\{[^}]*--dsw-alias-state-error-primary/u)
    // The kind label of an action-required chip wears the same warning ink.
    const label = /\.devlead-notification\[data-lane="action-required"\] \.devlead-notification-label \{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(label).toContain('color: var(--dsw-alias-state-warn-primary')
    expect(label).not.toMatch(/(?:^|;)\s*(?:width|height|padding|border|margin|font-size)\s*:/u)
  })

  it('weakens background report chips with opacity only, never layout', () => {
    const background = /\.devlead-notification\[data-lane="background"\] \{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(background).toContain('opacity:')
    expect(background).not.toMatch(/(?:^|;)\s*(?:width|height|padding|border|margin|font-size|display)\s*:/u)
    // progress/fyi keep the default tertiary dot: no per-kind color rule may
    // promote a non-urgent background update above a settled outcome.
    expect(styles).not.toContain('[data-report-kind="progress"]')
    expect(styles).not.toContain('[data-report-kind="fyi"]')
  })

  it('styles the lifecycle suffix and suppressed-wake marker as compact neutral copy', () => {
    const status = /\.devlead-notification-status \{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(status).toContain('flex: none;')
    expect(status).toContain('color: var(--dsw-alias-label-secondary')
    const wake = /\.devlead-notification-wake \{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(wake).toContain('color: var(--dsw-alias-label-tertiary')
    expect(wake).toContain('font-size: 12px;')
    // Both are inline annotations: no box changes, and neither may wear the
    // error or warning ink (the transition/kind labels carry the outcome).
    for (const rule of [status, wake]) {
      expect(rule).not.toMatch(/(?:^|;)\s*(?:width|height|padding|border|margin)\s*:/u)
      expect(rule).not.toContain('--dsw-alias-label-error')
      expect(rule).not.toContain('--dsw-alias-state-warn-primary')
    }
  })

  it('keeps the Phase-1e chip attributes away from Session-row layout', () => {
    // The new lane/status/wake selectors must only scope strip chips; the
    // Session-row ring stays the sole row decoration, unchanged.
    const rowRules = [...styles.matchAll(/\[data-row-key[^\{]*\{/gu)]
    expect(rowRules).toHaveLength(2)
    for (const attribute of ['data-lane', 'data-wake-suppressed', 'data-question-status', 'data-answer-status']) {
      expect(styles).not.toMatch(new RegExp(`\\[data-row-key[^{]*\\[${attribute}`, 'u'))
    }
  })

  it('marks the enabled toggle with the business accent border, not extra layout', () => {
    const enabled = /\.devlead-toggle\[data-devlead-enabled="true"\] \{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(enabled).toContain('border-color: var(--dsw-alias-state-business-primary')
    expect(enabled).toContain('box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary')
    // Border and halo must not change the box the toolbar lays out: the width,
    // height, padding, and font size stay in the shared base rule only.
    expect(enabled).not.toMatch(/(?:^|;)\s*(?:width|height|padding|font-size|margin)\s*:/u)
    // Off state keeps the transparent base border: no accent without mode.
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*border: 1px solid transparent;/u)
    expect(styles).not.toMatch(/\.devlead-toggle \{[^}]*border-color: var\(--dsw-alias-state-business-primary/u)
  })

  it('lets an error replace the enabled accent instead of outlining it in blue', () => {
    const failed = /\.devlead-toggle\[data-devlead-failed="true"\] \{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(failed).toContain('border-color: var(--dsw-alias-label-error')
    expect(failed).toContain('box-shadow: none;')
  })

  it('collapses the visible labels on a narrow composer without hiding the control', () => {
    expect(styles).toContain('@media (max-width: 480px)')
    expect(styles).toMatch(/@media \(max-width: 480px\)[\s\S]*\.devlead-toggle-label,[\s\S]*\.devlead-label,[\s\S]*\.devlead-missing \{[\s\S]*display: none;/u)
    // The border is already in the base box; the narrow rule compensates the
    // extra 1px per side to keep the old 8px outer inset.
    expect(styles).toMatch(/@media \(max-width: 480px\)[\s\S]*\.devlead-toggle \{[^}]*padding: 0 7px;/u)
    // The icon (and its aria-label) stays: only redundant visible text is
    // removed, so the single mode switch remains reachable on a phone.
    expect(styles).not.toMatch(/@media \(max-width: 480px\)[\s\S]*\.devlead-toggle \{[^}]*display: none/u)
  })

  it('keeps the failed state readable on hover and exposes a pressed-state fill', () => {
    expect(styles).toContain('.devlead-toggle:hover:not(:disabled):not([data-devlead-failed="true"])')
    expect(styles).toContain('[aria-pressed="true"]')
    expect(styles).toContain('--dsw-alias-label-error')
  })

  it('keeps the read-only board inside the right Sidebar without horizontal overflow', () => {
    expect(styles).toContain('.devlead-board {')
    expect(styles).toMatch(/\.devlead-board \{[^}]*min-width: 0;/u)
    expect(styles).toMatch(/\.devlead-board \{[^}]*overflow: hidden;/u)
    expect(styles).toMatch(/\.devlead-board-content \{[^}]*overflow-x: hidden;/u)
    expect(styles).toMatch(/\.devlead-board-content \{[^}]*overflow-y: auto;/u)
    expect(styles).toContain('.devlead-board-unlisted-list')
    expect(styles).toMatch(/\.devlead-board-card-badges \{[^}]*min-width: 0;/u)
    expect(styles).toMatch(/\.devlead-board-card-badges \{[^}]*max-width: 100%;/u)
    expect(styles).toContain('@media (max-width: 480px)')
    // Board styling uses the same public token/refcount path, never CSS Modules.
    expect(styles).toContain('.devlead-board-card {')
    // One root container observes both header KPIs and content cards. Placing
    // it on content would make the narrow-KPI rule permanently inert.
    expect(styles).toMatch(/\.devlead-board \{[^}]*container: devlead-board \/ inline-size;/u)
    expect(styles).not.toMatch(/\.devlead-board-content \{[^}]*container:/u)
    expect(styles).toMatch(/@container devlead-board \(min-width: 620px\)[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u)
    expect(styles).toMatch(/@container devlead-board \(max-width: 340px\)[\s\S]*\.devlead-board-kpis \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u)
    expect(styles).toContain('.devlead-board-card:focus-visible')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).not.toMatch(/\.devlead-board[^{]*module/u)
  })

  it('uses only harness theme custom properties for colors and geometry', () => {
    const properties = [...themeProperties()]
    expect(properties.length).toBeGreaterThan(10)
    for (const property of properties) {
      expect(property.startsWith('--dsw-') || property.startsWith('--dsh-'), property).toBe(true)
    }
    // color-mix needs the same neutral fallback as a plain var() read; a token
    // miss must not invalidate the whole background/border declaration.
    expect(styles).not.toMatch(/color-mix\(in srgb, var\(--[a-z0-9-]+\)/u)
  })

  it('pins the token set verified against the DSH 0.2.2-rc.1 through rc.5 themes', () => {
    // Every name here was found in the DSH reference theme sources or their
    // shipped consumers; a misspelled or renamed token fails this list.
    expect(themeProperties()).toEqual(new Set([
      '--dsw-alias-label-tertiary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-error',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-border-l1',
      '--dsw-elevation-stroke-color',
      '--dsw-radius-lg',
      '--dsw-radius-md',
      '--dsw-radius-sm',
      '--dsw-elevation-panel',
      '--dsw-specific-menu',
      '--dsw-menu-backdrop-filter',
      '--dsw-alias-label-primary',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-alias-label-primary-dimmed',
      '--dsw-alias-state-business-primary',
      '--dsw-alias-state-business-tertiary',
      '--dsh-composer-side-clearance',
      '--dsh-composer-dock-inset',
      '--dsh-composer-card-max-width',
      '--dsh-sidebar-paint-inset',
    ]))
  })
})

/**
 * Every custom property the stylesheet declares or reads.
 * @returns declared names and `var()` reads, deduplicated.
 */
function themeProperties(): Set<string> {
  const declared = [...styles.matchAll(/(--[a-z0-9-]+)\s*:/gu)].map(match => match[1] ?? '')
  const read = [...styles.matchAll(/var\((--[a-z0-9-]+)/gu)].map(match => match[1] ?? '')
  return new Set([...declared, ...read])
}
