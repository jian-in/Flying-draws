export type Inline = string | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

type Align = 'left' | 'center' | 'right'
export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }

// 输出仅含固定种类的节点和文本。URL 由 URL 解析器检查后才进入 link 节点。
function inline(text: string, depth = 0): Inline[] {
  if (depth >= 12) return [text]
  const parts: Inline[] = []
  const tokens = /(?<!`)(`+)(?!`)([^`\n]+?)\1(?!`)|\*\*(?!\s)(.+?)\*\*|\*(?![\s*])([^*\n]+?)\*|\[([^\[\]\n]+)\]\(([^\s()]*(?:\([^()\s]*\)[^\s()]*)*)\)/g
  let end = 0
  for (const m of text.matchAll(tokens)) {
    if (m.index > end) parts.push(text.slice(end, m.index))
    if (m[1]) parts.push({ kind: 'code', text: m[2] })
    else if (m[3] || m[4]) parts.push({ kind: m[3] ? 'strong' : 'em', children: inline(m[3] ?? m[4], depth + 1) })
    else {
      let href: string | undefined
      if (/^https?:\/\//i.test(m[6])) {
        try { href = new URL(m[6]).href } catch { /* 地址未输完，保留原文 */ }
      }
      parts.push(href ? { kind: 'link', href, children: inline(m[5], depth + 1) } : m[0])
    }
    end = m.index + m[0].length
  }
  if (end < text.length) parts.push(text.slice(end))
  return parts
}

// 代码跨度中的竖线和转义竖线都是单元格内容。
function cells(line: string): string[] {
  const result = ['']
  let fence = 0
  let boundary = false
  for (const [token] of line.trim().matchAll(/\\\||\x60+|[^\\|`]+|./g)) {
    boundary = token === '|' && !fence
    if (boundary) result.push('')
    else {
      if (token.startsWith('`') && (!fence || fence === token.length)) fence = fence ? 0 : token.length
      result[result.length - 1] += token === '\\|' && !fence ? '|' : token
    }
  }
  if (boundary) result.pop()
  if (line.trimStart().startsWith('|')) result.shift()
  return result.map(s => s.trim())
}

const marker = /^( *)([-+*]|\d+[.)])\s+(.*)$/
const fence = /^ {0,3}(`{3,})[^`]*$/
const heading = /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/
const rule = /^ {0,3}-{3,}\s*$/
const quote = /^ {0,3}> ?/

function tableAlign(header: string, divider = ''): Align[] | undefined {
  if (!header.includes('|') || !divider.includes('-') || !/^[\s|:-]+$/.test(divider)) return
  const columns = cells(divider)
  if (columns.length !== cells(header).length || !columns.length || !columns.every(c => /^:?-+:?$/.test(c))) return
  return columns.map(c => c.endsWith(':') ? c.startsWith(':') ? 'center' : 'right' : 'left')
}

function parseLines(lines: string[], depth: number): Block[] {
  if (depth >= 16) return [{ kind: 'paragraph', children: [lines.join('\n')] }]
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i++]
    if (!line.trim()) continue
    const opening = line.match(fence)
    const title = line.match(heading)
    const list = line.match(marker)
    const align = tableAlign(line, lines[i])
    if (opening) {
      const start = i
      const close = new RegExp('^ {0,3}`{' + opening[1].length + ',}\\s*$')
      while (i < lines.length && !close.test(lines[i])) i++
      blocks.push({ kind: 'code', text: lines.slice(start, i).join('\n') })
      if (i < lines.length) i++
    } else if (title) blocks.push({ kind: 'heading', level: title[1].length, children: inline(title[2]) })
    else if (rule.test(line)) blocks.push({ kind: 'rule' })
    else if (quote.test(line)) {
      const body = [line.replace(quote, '')]
      while (i < lines.length && quote.test(lines[i])) body.push(lines[i++].replace(quote, ''))
      blocks.push({ kind: 'quote', blocks: parseLines(body, depth + 1) })
    } else if (list) {
      const ordered = /^\d/.test(list[2])
      const items: Block[][] = []
      let item = list
      while (true) {
        const body = [item[3]]
        const indent = item[0].length - item[3].length
        while (i < lines.length && lines[i].startsWith(' '.repeat(indent))) body.push(lines[i++].slice(indent))
        items.push(parseLines(body, depth + 1))
        const next = lines[i]?.match(marker)
        if (!next || next[1] !== list[1] || /^\d/.test(next[2]) !== ordered) break
        item = next
        i++
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number.parseInt(list[2], 10) : 1, items })
    } else if (align) {
      i++ // 对齐行
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i].includes('|') && !heading.test(lines[i]) && !fence.test(lines[i]) && !quote.test(lines[i]) && !marker.test(lines[i])) {
        const row = cells(lines[i++])
        rows.push(align.map((_, col) => inline(row[col] ?? '')))
      }
      blocks.push({ kind: 'table', align, header: cells(line).map(s => inline(s)), rows })
    } else {
      const body = [line]
      while (i < lines.length && lines[i].trim() && !fence.test(lines[i]) && !heading.test(lines[i])
        && !marker.test(lines[i]) && !quote.test(lines[i]) && !rule.test(lines[i]) && !tableAlign(lines[i], lines[i + 1])) body.push(lines[i++])
      blocks.push({ kind: 'paragraph', children: inline(body.join('\n')) })
    }
  }
  return blocks
}

export function parseMarkdown(text: string): Block[] {
  return parseLines(text.replace(/\r\n?/g, '\n').split('\n'), 0)
}
