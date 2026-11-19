import { createElement, memo, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from '../../shared/markdown'

function spans(parts: Inline[]): ReactNode[] {
  return parts.map((part, i) => {
    if (typeof part === 'string') return part
    switch (part.kind) {
      case 'code': return <code key={i}>{part.text}</code>
      case 'strong': return <strong key={i}>{spans(part.children)}</strong>
      case 'em': return <em key={i}>{spans(part.children)}</em>
      case 'link': return <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{spans(part.children)}</a>
    }
  })
}

function blocks(nodes: Block[], caret?: ReactNode): ReactNode[] {
  if (!nodes.length) return caret ? [caret] : []
  return nodes.map((node, i) => {
    const tail = i === nodes.length - 1 ? caret : null
    switch (node.kind) {
      case 'paragraph': return <p key={i}>{spans(node.children)}{tail}</p>
      case 'heading': return createElement('h' + node.level, { key: i }, spans(node.children), tail)
      case 'code': return <pre key={i}><code>{node.text}{tail}</code></pre>
      case 'quote': return <blockquote key={i}>{blocks(node.blocks, tail)}</blockquote>
      case 'list': {
        const Tag = node.ordered ? 'ol' : 'ul'
        return <Tag key={i} start={node.ordered ? node.start : undefined}>{node.items.map((item, j) =>
          <li key={j}>{blocks(item, j === node.items.length - 1 ? tail : null)}</li>)}</Tag>
      }
      case 'rule': return <div key={i}><hr />{tail}</div>
      case 'table': return <div key={i} className="fd-md-table"><table>
        <thead><tr>{node.header.map((cell, j) => <th scope="col" key={j} style={{ textAlign: node.align[j] }}>{spans(cell)}</th>)}</tr></thead>
        <tbody>{node.rows.map((row, k) => <tr key={k}>{row.map((cell, j) =>
          <td key={j} style={{ textAlign: node.align[j] }}>{spans(cell)}</td>)}</tr>)}</tbody>
      </table>{tail}</div>
    }
  })
}

export const AgentMarkdown = memo(function AgentMarkdown({ text, draft = false }: { text: string; draft?: boolean }) {
  const nodes = parseMarkdown(text)
  const caret = draft ? <span key="cursor" className="fd-agent-caret" aria-hidden="true" /> : null
  return <div className="fd-markdown">{blocks(nodes, caret)}</div>
})
