/** Safe, dependency-free Markdown subset rendered exclusively as React elements. */
import { createElement, Fragment, type ReactNode } from 'react'

/** Only explicit HTTP(S) destinations become anchors; everything else is text. */
export function safeDevLeadMarkdownHref(destination: string): string | undefined {
  try {
    const url = new URL(destination)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

interface InlineContext {
  readonly depth: number
  readonly prefix: string
}

/** Parse inline code, emphasis, strikethrough, and links without an HTML sink. */
function inline(text: string, context: InlineContext): ReactNode[] {
  if (context.depth > 12) return [text]
  const nodes: ReactNode[] = []
  let plain = ''
  let position = 0
  let sequence = 0
  const flush = (): void => {
    if (plain.length === 0) return
    nodes.push(plain)
    plain = ''
  }
  const key = (kind: string): string => `${context.prefix}-${kind}-${sequence++}`
  const nested = (value: string, kind: string): ReactNode[] => inline(value, {
    depth: context.depth + 1,
    prefix: key(kind),
  })

  while (position < text.length) {
    const rest = text.slice(position)
    if (rest.startsWith('`')) {
      const end = text.indexOf('`', position + 1)
      if (end > position + 1) {
        flush()
        nodes.push(<code key={key('code')}>{text.slice(position + 1, end)}</code>)
        position = end + 1
        continue
      }
    }
    if (rest.startsWith('[')) {
      const match = /^\[([^\]\n]+)\]\(([^)\n]+)\)/u.exec(rest)
      if (match !== null) {
        flush()
        const label = match[1] ?? ''
        const destination = (match[2] ?? '').trim()
        const href = safeDevLeadMarkdownHref(destination)
        if (href === undefined) {
          // Keep hostile schemes visible as inert source text, never as href.
          nodes.push(match[0])
        } else {
          nodes.push(
            <a key={key('link')} href={href} target="_blank" rel="noreferrer noopener">
              {nested(label, 'link')}
            </a>,
          )
        }
        position += match[0].length
        continue
      }
    }
    const delimiter = rest.startsWith('**') || rest.startsWith('__')
      ? rest.slice(0, 2)
      : rest.startsWith('~~')
        ? '~~'
        : rest.startsWith('*') || rest.startsWith('_')
          ? rest[0] ?? ''
          : ''
    if (delimiter.length > 0) {
      const end = text.indexOf(delimiter, position + delimiter.length)
      if (end > position + delimiter.length) {
        const content = text.slice(position + delimiter.length, end)
        flush()
        if (delimiter === '**' || delimiter === '__') nodes.push(<strong key={key('strong')}>{nested(content, 'strong')}</strong>)
        else if (delimiter === '~~') nodes.push(<del key={key('del')}>{nested(content, 'del')}</del>)
        else nodes.push(<em key={key('em')}>{nested(content, 'em')}</em>)
        position = end + delimiter.length
        continue
      }
    }
    plain += text[position] ?? ''
    position += 1
  }
  flush()
  return nodes
}

const LIST_PATTERN = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/u
const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.+)$/u
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u

function blockStart(line: string): boolean {
  return HEADING_PATTERN.test(line) || FENCE_PATTERN.test(line) || LIST_PATTERN.test(line) || /^ {0,3}>/u.test(line)
}

function blocks(source: string, depth: number, prefix: string): ReactNode[] {
  if (depth > 8) return [<p key={`${prefix}-deep`}>{source}</p>]
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const output: ReactNode[] = []
  let index = 0
  let sequence = 0
  const key = (kind: string): string => `${prefix}-${kind}-${sequence++}`

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    const fence = FENCE_PATTERN.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      const info = (fence[2] ?? '').trim()
      const content: string[] = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index] ?? ''
        const closing = FENCE_PATTERN.exec(candidate)
        if (closing !== null && (closing[1] ?? '')[0] === marker[0] && (closing[1] ?? '').length >= marker.length) {
          index += 1
          break
        }
        content.push(candidate)
        index += 1
      }
      output.push(
        <pre key={key('pre')} data-language={info.length > 0 ? info : undefined}>
          <code>{content.join('\n')}{content.length > 0 ? '\n' : ''}</code>
        </pre>,
      )
      continue
    }
    const heading = HEADING_PATTERN.exec(line)
    if (heading !== null) {
      const level = Math.min(6, (heading[1] ?? '#').length)
      output.push(createElement(`h${level}`, { key: key('heading') }, ...inline(heading[2] ?? '', {
        depth: 0,
        prefix: key('inline'),
      })))
      index += 1
      continue
    }
    if (/^ {0,3}>/u.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^ {0,3}>/u.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^ {0,3}> ?/u, ''))
        index += 1
      }
      output.push(<blockquote key={key('quote')}>{blocks(quoted.join('\n'), depth + 1, key('quoted'))}</blockquote>)
      continue
    }
    const list = LIST_PATTERN.exec(line)
    if (list !== null) {
      const ordered = /^\d/u.test(list[1] ?? '')
      const items: ReactNode[] = []
      let start = ordered ? Number.parseInt(list[1] ?? '1', 10) : 1
      while (index < lines.length) {
        const item = LIST_PATTERN.exec(lines[index] ?? '')
        if (item === null || /^\d/u.test(item[1] ?? '') !== ordered) break
        items.push(<li key={key('item')}>{inline(item[2] ?? '', { depth: 0, prefix: key('item-inline') })}</li>)
        index += 1
      }
      output.push(createElement(ordered ? 'ol' : 'ul', {
        key: key('list'),
        ...ordered && start !== 1 ? { start } : {},
      }, ...items))
      continue
    }
    const paragraph = [line]
    index += 1
    while (index < lines.length) {
      const candidate = lines[index] ?? ''
      if (candidate.trim().length === 0 || blockStart(candidate)) break
      paragraph.push(candidate)
      index += 1
    }
    output.push(
      <p key={key('paragraph')}>
        {paragraph.map((part, partIndex) => (
          <Fragment key={key('line')}>
            {partIndex > 0 && '\n'}
            {inline(part, { depth: 0, prefix: key('inline') })}
          </Fragment>
        ))}
      </p>,
    )
  }
  return output
}

/** Render the supported block/inline subset. Raw HTML is always literal text. */
export function DevLeadMarkdown({ markdown, className = 'devlead-markdown' }: {
  readonly markdown: string
  readonly className?: string
}): ReactNode {
  return <div className={className}>{blocks(markdown, 0, 'md')}</div>
}
