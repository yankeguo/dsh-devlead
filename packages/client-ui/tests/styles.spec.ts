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

  it('sizes the off-state toggle as the composer toolbar glyph seat', () => {
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*width: 28px;/u)
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*height: 28px;/u)
    expect(styles).toMatch(/\.devlead-toggle \{[^}]*border-radius: 999px;/u)
  })

  it('ships the sidebar Session-row mark and its hover-card explanation', () => {
    // The mark sits inline in the row's resting seat and must never grow the
    // row: no padding or fixed height, only the icon's own box.
    expect(styles).toContain('.devlead-row-mark {')
    expect(styles).toMatch(/\.devlead-row-mark \{[^}]*flex: none;/u)
    expect(styles).toContain('.devlead-row-hover {')
    expect(styles).toMatch(/\.devlead-row-hover \{[^}]*font-size: 12px;/u)
  })

  it('ships the notice live region and the visually-hidden failure seat', () => {
    expect(styles).toContain('.devlead-notice {')
    expect(styles).toContain('.devlead-notification-dot[data-transition="completed"]')
    expect(styles).toMatch(/\.devlead-sr-only \{[^}]*clip: rect\(0 0 0 0\);/u)
  })

  it('uses only harness theme custom properties for colors and geometry', () => {
    const properties = [...themeProperties()]
    expect(properties.length).toBeGreaterThan(10)
    for (const property of properties) {
      expect(property.startsWith('--dsw-') || property.startsWith('--dsh-'), property).toBe(true)
    }
  })

  it('pins the token set verified against the DSH 0.2.2-rc.1 theme', () => {
    // Every name here was found in the DSH reference theme sources or their
    // shipped consumers; a misspelled or renamed token fails this list.
    expect(themeProperties()).toEqual(new Set([
      '--dsw-alias-label-tertiary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-border-l1',
      '--dsw-elevation-stroke-color',
      '--dsw-radius-md',
      '--dsw-elevation-panel',
      '--dsw-specific-menu',
      '--dsw-menu-backdrop-filter',
      '--dsw-alias-label-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-alias-label-primary-dimmed',
      '--dsh-composer-side-clearance',
      '--dsh-composer-dock-inset',
      '--dsh-composer-card-max-width',
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
