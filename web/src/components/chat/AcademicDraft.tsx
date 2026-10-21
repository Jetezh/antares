import DOMPurify from 'dompurify'
import { memo, useMemo } from 'react'
import { buildListTree, type MarkdownListItem } from './Markdown'

interface AcademicDraftProps {
  content: string
}

interface Block {
  type: 'heading' | 'paragraph' | 'table' | 'svg' | 'raw' | 'list'
  level?: number
  text?: string
  header?: string[]
  rows?: string[][]
  svg?: string
  ordered?: boolean
  start?: number
  items?: MarkdownListItem[]
}

function parseAcademicBlocks(src: string): Block[] {
  // Strip hidden wrapper divs and style tags completely so CSS can never leak into the DOM
  const sanitizedSrc = src
    .replace(/<div[^>]*style=[\"']?display:\s*none[\"']?[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')

  const lines = sanitizedSrc.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const rawLine = lines[i]
    const line = rawLine.trim()

    if (!line) {
      i++
      continue
    }

    // SVG Diagram Block
    if (/^\s*<svg[\s>]/.test(line)) {
      const svgLines: string[] = [line]
      if (!line.includes('</svg>')) {
        i++
        while (i < lines.length && !lines[i].includes('</svg>')) {
          svgLines.push(lines[i])
          i++
        }
        if (i < lines.length) {
          svgLines.push(lines[i])
        }
      }
      i++
      blocks.push({ type: 'svg', svg: svgLines.join('\n') })
      continue
    }

    // Headings
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      })
      i++
      continue
    }

    // Academic Table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const splitRow = (l: string) =>
        l
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim())

      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    // Lists
    const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(line)
    if (bullet) {
      const rawItems: { indent: number; ordered: boolean; start?: number; text: string }[] = []
      while (i < lines.length) {
        const curLine = lines[i]
        if (!curLine.trim()) {
          let lookahead = i + 1
          let hasIndentedNext = false
          while (lookahead < lines.length && !lines[lookahead].trim()) {
            lookahead++
          }
          if (lookahead < lines.length) {
            const nextMatch = /^(\s+)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[lookahead])
            if (nextMatch && nextMatch[1].replace(/\t/g, '  ').length >= 2) {
              hasIndentedNext = true
            }
          }
          if (hasIndentedNext) {
            i++
            continue
          }
          break
        }

        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(curLine)
        if (m) {
          const indent = m[1].replace(/\t/g, '  ').length
          const isNum = /\d/.test(m[2])
          const startNum = isNum ? parseInt(m[2], 10) : undefined
          rawItems.push({
            indent,
            ordered: isNum,
            start: startNum,
            text: m[3],
          })
          i++
        } else if (rawItems.length > 0 && (/^\s{2,}|\t+/.test(curLine) || rawItems[rawItems.length - 1].indent > 0)) {
          rawItems[rawItems.length - 1].text += ' ' + curLine.trim()
          i++
        } else {
          break
        }
      }

      const items = buildListTree(rawItems)
      const ordered = items.length > 0 ? items[0].ordered : false
      const start = items.length > 0 ? items[0].start : undefined
      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    // Regular paragraphs or captions
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|<svg|\||[-*+]\s|\d+[.)]\s)/.test(lines[i])
    ) {
      paraLines.push(lines[i].trim())
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') })
    }
  }

  return blocks
}

function renderAcademicInline(str: string): string {
  return str
    .replace(/\*\*([\s\S]*?)\*\*/g, '<b>$1</b>')
    .replace(/\*([\s\S]*?)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code style="font-family: monospace; font-size: 10pt; background: #f1f5f9; padding: 1px 4px; border-radius: 3px;">$1</code>')
}

const safeHtml = (html: string) =>
  DOMPurify.sanitize(html, { FORBID_TAGS: ['style'] })

const safeSvg = (svg: string) =>
  DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['style'] })

function RenderAcademicListItem({ item }: { item: MarkdownListItem }) {
  return (
    <li className="my-0.5 leading-[1.15]">
      <span dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(item.text)) }} />
      {item.children && item.children.length > 0 ? (
        <RenderAcademicList
          items={item.children}
          ordered={item.children[0].ordered}
          start={item.children[0].start}
        />
      ) : null}
    </li>
  )
}

function RenderAcademicList({
  items,
  ordered,
  start,
}: {
  items: MarkdownListItem[]
  ordered: boolean
  start?: number
}) {
  if (ordered) {
    return (
      <ol
        className="list-decimal pl-7 my-1 space-y-1 font-serif text-[12pt] leading-[1.15] text-[#111827]"
        {...(start && start !== 1 ? { start } : {})}
      >
        {items.map((it, idx) => (
          <RenderAcademicListItem key={idx} item={it} />
        ))}
      </ol>
    )
  }
  return (
    <ul className="list-disc pl-7 my-1 space-y-1 font-serif text-[12pt] leading-[1.15] text-[#111827]">
      {items.map((it, idx) => (
        <RenderAcademicListItem key={idx} item={it} />
      ))}
    </ul>
  )
}

export const AcademicDraft = memo(function AcademicDraft({ content }: AcademicDraftProps) {
  const blocks = useMemo(() => parseAcademicBlocks(content), [content])

  return (
    <div className="space-y-2 text-justify font-serif text-[12pt] leading-[1.15] text-[#111827]">
      {blocks.map((block, idx) => {
        if (block.type === 'heading') {
          if (block.level === 1) {
            return (
              <h1
                key={idx}
                className="mt-6 mb-3 text-center font-serif text-[12pt] font-bold uppercase tracking-wider text-[#0f172a]"
                dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(block.text || '')) }}
              />
            )
          }
          if (block.level === 2) {
            return (
              <h2
                key={idx}
                className="mt-4 mb-2 text-left font-serif text-[12pt] font-bold text-[#0f172a]"
                dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(block.text || '')) }}
              />
            )
          }
          if (block.level === 3) {
            return (
              <h3
                key={idx}
                className="mt-3.5 mb-1 text-left font-serif text-[12pt] font-bold italic text-[#0f172a]"
                dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(block.text || '')) }}
              />
            )
          }
          return (
            <h4
              key={idx}
              className="mt-2.5 mb-1 text-left font-serif text-[12pt] font-medium text-[#0f172a]"
              dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(block.text || '')) }}
            />
          )
        }

        if (block.type === 'svg') {
          return (
            <div
              key={idx}
              className="my-4 flex justify-center overflow-x-auto bg-transparent p-0"
              dangerouslySetInnerHTML={{ __html: safeSvg(block.svg || '') }}
            />
          )
        }

        if (block.type === 'table' && block.header) {
          const numCols = block.header.length
          const colLengths = new Array(numCols).fill(0)
          block.header.forEach((h, i) => {
            colLengths[i] = Math.max(colLengths[i], h.trim().length)
          })
          block.rows?.forEach((row) => {
            row.forEach((c, i) => {
              if (i < numCols) colLengths[i] = Math.max(colLengths[i], c.trim().length)
            })
          })
          const totalLen = colLengths.reduce((a, b) => a + b, 0) || 1
          const colWidths = colLengths.map((len, cIdx) => {
            const h = block.header![cIdx]?.toLowerCase()
            if (h === 'no' || h === 'no.' || h === '#') return '6%'
            return `${Math.max(12, Math.round((len / totalLen) * 100))}%`
          })

          return (
            <div key={idx} className="my-3 overflow-x-auto">
              <table className="w-full border-collapse border border-slate-700/60 bg-white font-serif text-[11pt] leading-[1.15] text-[#111827]">
                <thead>
                  <tr className="border-b border-slate-700/60 bg-slate-100">
                    {block.header.map((h, i) => (
                      <th
                        key={i}
                        style={{ width: colWidths[i] }}
                        className="border border-slate-700/60 px-3 py-2 text-center font-bold text-[#0f172a]"
                        dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(h)) }}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows?.map((row, r) => (
                    <tr key={r} className="border-b border-slate-700/40 hover:bg-slate-50">
                      {row.map((c, i) => {
                        const isCenter = i === 0 && (block.header![0]?.toLowerCase().includes('no') || c.length <= 4)
                        return (
                          <td
                            key={i}
                            style={{ width: colWidths[i] }}
                            className={`border border-slate-700/60 px-3 py-2 align-middle text-[#1e293b] ${
                              isCenter ? 'text-center' : 'text-left'
                            }`}
                            dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(c)) }}
                          />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

        if (block.type === 'list' && block.items) {
          return (
            <div key={idx} className="my-2">
              <RenderAcademicList
                items={block.items}
                ordered={block.ordered ?? false}
                start={block.start}
              />
            </div>
          )
        }

        if (block.type === 'paragraph' && block.text) {
          const trimmed = block.text.trim()
          const isFigure = /^\*?(Gambar|Figure)\s+\d+[\d.]*[:\s]/.test(trimmed)
          const isTable = /^\*?(Tabel|Table)\s+\d+[\d.]*[:\s]/.test(trimmed)

          if (isFigure) {
            return (
              <p
                key={idx}
                className="my-1.5 text-center font-serif text-[11pt] font-normal italic leading-snug text-slate-700"
                dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(trimmed)) }}
              />
            )
          }

          if (isTable) {
            return (
              <p
                key={idx}
                className="mt-4 mb-1 text-center font-serif text-[11pt] font-normal italic leading-snug text-slate-800"
                dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(trimmed)) }}
              />
            )
          }

          return (
            <p
              key={idx}
              className="my-1.5 text-justify indent-8 font-serif text-[12pt] leading-[1.15] text-[#111827]"
              dangerouslySetInnerHTML={{ __html: safeHtml(renderAcademicInline(block.text)) }}
            />
          )
        }

        return null
      })}
    </div>
  )
})
