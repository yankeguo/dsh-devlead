/** Safe Markdown subset: structure, safe links, and literal hostile source. */
import { afterEach, describe, expect, it } from 'vitest'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { DevLeadMarkdown, safeDevLeadMarkdownHref } from '../src/client/Markdown.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mounted: ReactTestRenderer[] = []

async function render(markdown: string): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined
  await act(async () => { renderer = create(<DevLeadMarkdown markdown={markdown} />) })
  if (renderer === undefined) throw new Error('no renderer')
  mounted.push(renderer)
  return renderer
}

function textOf(instance: ReactTestInstance): string {
  return instance.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
}

afterEach(async () => {
  await act(async () => { for (const renderer of mounted.splice(0)) renderer.unmount() })
})

describe('DevLeadMarkdown', () => {
  it('renders headings, paragraphs, lists, quotes, code, and inline emphasis as React elements', async () => {
    const renderer = await render([
      '# Heading',
      '',
      'Paragraph with **bold**, *italic*, ~~gone~~, and `code`.',
      '',
      '- one',
      '- two',
      '',
      '3. third',
      '4. fourth',
      '',
      '> quoted **text**',
      '',
      '```ts',
      'const safe = "<img>"',
      '```',
    ].join('\n'))
    expect(renderer.root.findByType('h1')).toBeDefined()
    expect(renderer.root.findAllByType('strong').length).toBeGreaterThanOrEqual(2)
    expect(renderer.root.findByType('em')).toBeDefined()
    expect(renderer.root.findByType('del')).toBeDefined()
    expect(renderer.root.findByType('ul').findAllByType('li')).toHaveLength(2)
    expect(renderer.root.findByType('ol').props.start).toBe(3)
    expect(renderer.root.findByType('blockquote')).toBeDefined()
    expect(renderer.root.findByType('pre').props['data-language']).toBe('ts')
    expect(textOf(renderer.root.findByType('pre'))).toContain('const safe = "<img>"')
  })

  it('creates anchors only for safe HTTP(S) links and keeps dangerous schemes as text', async () => {
    const renderer = await render('[safe](https://example.com/docs) [bad](javascript:alert(1)) [data](data:text/html,x)')
    const anchors = renderer.root.findAllByType('a')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.props.href).toBe('https://example.com/docs')
    expect(anchors[0]?.props.rel).toBe('noreferrer noopener')
    expect(textOf(renderer.root)).toContain('[bad](javascript:alert(1))')
    expect(textOf(renderer.root)).toContain('[data](data:text/html,x)')
    expect(safeDevLeadMarkdownHref('http://example.com')).toBe('http://example.com/')
    expect(safeDevLeadMarkdownHref('file:///etc/passwd')).toBeUndefined()
  })

  it('treats HTML/event-handler strings as text and never installs an HTML sink', async () => {
    const hostile = '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n`[x](javascript:alert(3))`'
    const renderer = await render(hostile)
    expect(textOf(renderer.root)).toContain('<img src=x onerror="alert(1)">')
    expect(textOf(renderer.root)).toContain('<script>alert(2)</script>')
    expect(renderer.root.findAllByType('img')).toHaveLength(0)
    expect(renderer.root.findAllByType('script')).toHaveLength(0)
    expect(renderer.root.findAllByType('a')).toHaveLength(0)
    expect(renderer.root.findAll(instance => Object.hasOwn(instance.props, 'dangerouslySetInnerHTML')
      || Object.hasOwn(instance.props, 'onerror') || Object.hasOwn(instance.props, 'onload'))).toHaveLength(0)
  })
})
