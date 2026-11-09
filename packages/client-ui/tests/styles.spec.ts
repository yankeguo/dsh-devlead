/**
 * Unit tests for the plugin-owned stylesheet injection (`styles.ts`).
 *
 * The module only touches `document.head`, `document.createElement`, and the
 * created `<style>` element, so a tiny fake DOM is enough to test injection,
 * reuse, content refresh, and disposal without adding a jsdom dependency.
 */

import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
})

describe('ensureStyleTag', () => {
  it('is a no-op without a DOM', () => {
    const dispose = ensureStyleTag()
    expect(typeof dispose).toBe('function')
    expect(() => {
      dispose()
    }).not.toThrow()
  })

  it('injects the stylesheet once with the plugin-owned attribute', () => {
    const document = createFakeDocument()
    installDocument(document)

    const dispose = ensureStyleTag()
    expect(document.head.children).toHaveLength(1)
    const tag = document.head.children[0]
    expect(tag?.attributes.get(STYLE_ATTRIBUTE)).toBe(STYLE_KEY)
    expect(tag?.textContent).toBe(styles)

    // A second instance (or a hot reload) reuses the tag instead of stacking one.
    ensureStyleTag()
    expect(document.head.children).toHaveLength(1)

    dispose()
    expect(document.head.children).toHaveLength(0)
  })

  it('refreshes the text of a reused tag after a stylesheet change', () => {
    const document = createFakeDocument()
    installDocument(document)

    const dispose = ensureStyleTag()
    expect(document.head.children[0]?.textContent).toBe(styles)
    document.head.children[0]!.textContent = '/* stale */'

    ensureStyleTag()
    expect(document.head.children[0]?.textContent).toBe(styles)
    dispose()
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
})
