import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Copy,
  Image as ImageIcon,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { useI18n } from '@/lib/i18n'
import { getToken } from '@/lib/api'

/**
 * A small, dependency-free Markdown renderer covering what agent replies
 * actually use: fenced code, headings, lists, tables, quotes, images, and inline marks.
 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(content), [content])
  return (
    <div className={cn('space-y-2.5', className)}>
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <CodeBlock key={i} code={block.code} lang={block.lang} />
        ) : (
          <RichBlock key={i} block={block} />
        ),
      )}
    </div>
  )
}

type Block =
  | { type: 'code'; code: string; lang: string }
  | { type: 'svg'; svg: string }
  | { type: 'html'; html: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' }
  | { type: 'image'; alt: string; url: string }
  | { type: 'paragraph'; text: string }

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code
    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // closing fence
      blocks.push({ type: 'code', code: body.join('\n'), lang })
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    // Standalone SVG block: <svg ...> ... </svg>
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

    // Standalone HTML block: <p ...> ... </p>, <div ...> ... </div>, etc.
    if (/^\s*<(p|div|center|table|span|b|i|strong|em)[\s>]/.test(line)) {
      const htmlLines: string[] = [line]
      const tagMatch = /^\s*<(\w+)/.exec(line)
      const tagName = tagMatch ? tagMatch[1] : ''
      const closeTag = `</${tagName}>`
      if (!line.includes(closeTag)) {
        i++
        while (
          i < lines.length &&
          lines[i].trim() &&
          !lines[i].includes(closeTag) &&
          !/^\s*(```|#{1,6}\s|\||!\[|<svg)/.test(lines[i])
        ) {
          htmlLines.push(lines[i])
          i++
        }
        if (i < lines.length && lines[i].includes(closeTag)) {
          htmlLines.push(lines[i])
          i++
        }
      } else {
        i++
      }
      let htmlStr = htmlLines.join('\n')
      if (closeTag && !htmlStr.includes(closeTag)) {
        htmlStr += closeTag
      }
      blocks.push({ type: 'html', html: htmlStr })
      continue
    }

    // Standalone image: ![alt](url)
    const imgBlock = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line)
    if (imgBlock) {
      blocks.push({ type: 'image', alt: imgBlock[1], url: imgBlock[2] })
      i++
      continue
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    // Table: header row followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
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

    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', text: body.join('\n') })
      continue
    }

    const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(line)
    if (bullet) {
      const ordered = /\d/.test(bullet[1])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!m) break
        items.push(m[2])
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|!\[|<svg|<(p|div|center|table|span|b|i|strong|em)|\|)/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    if (para.length > 0) {
      blocks.push({ type: 'paragraph', text: para.join('\n') })
    }
  }

  return blocks
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

function resolveImageUrl(url: string): string {
  // Relative paths like /api/files/raw?path=... are already correct.
  // Data URIs are already valid.
  // Absolute URLs are already correct.
  // Bare file paths get prefixed with /api/.
  if (url.startsWith('http') || url.startsWith('data:') || url.startsWith('blob:')) {
    return url
  }
  if (url.startsWith('/api/')) {
    // Append auth token for API image endpoints (files/raw, social/image).
    const token = getToken()
    if (token) {
      const sep = url.includes('?') ? '&' : '?'
      return url + sep + 'token=' + encodeURIComponent(token)
    }
    return url
  }
  if (url.startsWith('/')) return url
  return '/api/files/raw?path=' + encodeURIComponent(url)
}

function EmbeddedImage({ alt, url }: { alt: string; url: string }) {
  const [expanded, setExpanded] = useState(false)
  const [failed, setFailed] = useState(false)
  const src = resolveImageUrl(url)

  if (failed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
        <ImageIcon className="size-3" /> {alt || 'image'}
      </span>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onClick={() => setExpanded(!expanded)}
      onError={() => setFailed(true)}
      className={cn(
        'cursor-zoom-in object-contain transition-all',
        expanded ? 'max-w-full' : 'max-h-64 max-w-lg mx-auto block',
      )}
    />
  )
}

function RichBlock({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': {
      const sizes = ['text-lg', 'text-base', 'text-sm', 'text-sm', 'text-sm', 'text-sm']
      return (
        <p className={cn('font-medium tracking-tight', sizes[block.level - 1])}>
          <Inline text={block.text} />
        </p>
      )
    }
    case 'list':
      return block.ordered ? (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>
              <Inline text={it} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>
              <Inline text={it} />
            </li>
          ))}
        </ul>
      )
    case 'svg':
      return (
        <div
          className="my-3 flex justify-center overflow-x-auto bg-transparent p-0"
          dangerouslySetInnerHTML={{ __html: block.svg }}
        />
      )
    case 'html':
      return (
        <div
          className="my-2"
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      )
    case 'quote':
      return (
        <blockquote className="border-l-2 border-foreground/40 pl-3 text-muted-foreground">
          <Inline text={block.text} />
        </blockquote>
      )
    case 'rule':
      return <hr className="border-line" />
    case 'image':
      return (
        <div className="py-1">
          <EmbeddedImage alt={block.alt} url={block.url} />
        </div>
      )
    case 'table': {
      // Calculate proportional column weights based on content lengths
      const numCols = block.header.length
      const colLengths = new Array(numCols).fill(0)
      block.header.forEach((h, i) => {
        colLengths[i] = Math.max(colLengths[i], h.trim().length)
      })
      block.rows.forEach((row) => {
        row.forEach((c, i) => {
          if (i < numCols) {
            colLengths[i] = Math.max(colLengths[i], c.trim().length)
          }
        })
      })

      // Normalize weights
      const totalLen = colLengths.reduce((a, b) => a + b, 0) || 1
      const colWidths = colLengths.map((len, idx) => {
        // Narrow columns for "No" or short identifiers
        const hName = block.header[idx]?.trim().toLowerCase()
        if (hName === 'no' || hName === 'no.' || hName === '#') {
          return '6%'
        }
        const pct = Math.max(12, Math.round((len / totalLen) * 100))
        return `${pct}%`
      })

      return (
        <div className="my-3 overflow-x-auto">
          <table className="w-full border-collapse border border-slate-700/60 text-xs text-foreground bg-background table-auto">
            <thead>
              <tr className="border-b border-slate-700/60 bg-muted/50">
                {block.header.map((h, i) => (
                  <th
                    key={i}
                    style={{ width: colWidths[i] }}
                    className="border border-slate-700/60 px-3 py-2 text-center font-bold text-foreground"
                  >
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-slate-700/40 hover:bg-muted/10">
                  {row.map((c, i) => {
                    const isCenter = i === 0 && (block.header[0]?.toLowerCase().includes('no') || c.length <= 4)
                    return (
                      <td
                        key={i}
                        style={{ width: colWidths[i] }}
                        className={cn(
                          'border border-slate-700/60 px-3 py-2 align-middle text-foreground leading-relaxed',
                          isCenter ? 'text-center' : 'text-left',
                        )}
                      >
                        <Inline text={c} />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'paragraph': {
      const trimmed = block.text.trim()
      const isFigure = /^\*?(Gambar|Figure)\s+\d+[\d.]*[:\s]/.test(trimmed)
      const isTable = /^\*?(Tabel|Table)\s+\d+[\d.]*[:\s]/.test(trimmed)
      if (isFigure) {
        return (
          <p className="my-1.5 text-center font-serif text-[11pt] font-normal italic leading-snug text-gray-700">
            <Inline text={block.text} />
          </p>
        )
      }
      if (isTable) {
        return (
          <p className="mt-3 mb-1 text-center font-serif text-[11pt] font-normal italic leading-snug text-gray-800">
            <Inline text={block.text} />
          </p>
        )
      }
      return (
        <p className="my-1 whitespace-pre-wrap break-words font-serif text-[12pt] leading-[1.15] text-gray-950">
          <Inline text={block.text} />
        </p>
      )
    }
    default:
      return null
  }
}

const ARROW_PATTERN =
  /(?::arrow_right:|:arrowright:|<arrowright\s*\/?>|\barrowright\b|\barroright\b|\barrow_right\b|-->|->|→)|(?::arrow_left:|:arrowleft:|<arrowleft\s*\/?>|\barrowleft\b|\barrorleft\b|\barrow_left\b|<--|<-|←)|(?::arrow_up:|:arrowup:|<arrowup\s*\/?>|\barrowup\b|\barrow_up\b|↑)|(?::arrow_down:|:arrowdown:|<arrowdown\s*\/?>|\barrowdown\b|\barrow_down\b|↓)/gi

function renderPlainTextWithArrows(str: string, baseKey: number): React.ReactNode[] {
  const result: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0

  while ((m = ARROW_PATTERN.exec(str)) !== null) {
    if (m.index > last) {
      result.push(str.slice(last, m.index))
    }
    const match = m[0].toLowerCase()
    if (match.includes('left') || match.includes('<-') || match === '←') {
      result.push(
        <ArrowLeft
          key={`arr-l-${baseKey}-${k++}`}
          className="inline mx-1 size-3.5 align-middle text-muted-foreground"
          weight="bold"
        />,
      )
    } else if (match.includes('up') || match === '↑') {
      result.push(
        <ArrowUp
          key={`arr-u-${baseKey}-${k++}`}
          className="inline mx-1 size-3.5 align-middle text-muted-foreground"
          weight="bold"
        />,
      )
    } else if (match.includes('down') || match === '↓') {
      result.push(
        <ArrowDown
          key={`arr-d-${baseKey}-${k++}`}
          className="inline mx-1 size-3.5 align-middle text-muted-foreground"
          weight="bold"
        />,
      )
    } else {
      result.push(
        <ArrowRight
          key={`arr-r-${baseKey}-${k++}`}
          className="inline mx-1 size-3.5 align-middle text-muted-foreground"
          weight="bold"
        />,
      )
    }
    last = m.index + m[0].length
  }

  if (last < str.length) {
    result.push(str.slice(last))
  }
  return result.length > 0 ? result : [str]
}

/** Renders inline code, bold, italics, links, and inline images. */
function Inline({ text }: { text: string }) {
  const nodes: React.ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(https?:\/\/\S+)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(...renderPlainTextWithArrows(text.slice(last, m.index), key++))
    const token = m[0]
    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key++}
          className="rounded-[var(--radius-xs)] bg-raised px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('![')) {
      // Inline image: ![alt](url)
      const imgMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token)!
      nodes.push(
        <EmbeddedImage key={key++} alt={imgMatch[1]} url={imgMatch[2]} />,
      )
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('[')) {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)!
      nodes.push(
        <a
          key={key++}
          href={link[2]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground underline decoration-line underline-offset-4 transition-colors hover:decoration-foreground"
        >
          <Inline text={link[1]} />
        </a>,
      )
    } else if (token.startsWith('http')) {
      // Bare URL — check if it looks like an image URL
      if (/\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i.test(token)) {
        nodes.push(<EmbeddedImage key={key++} alt="" url={token} />)
      } else {
        nodes.push(
          <a
            key={key++}
            href={token}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all text-foreground underline decoration-line underline-offset-4 transition-colors hover:decoration-foreground"
          >
            {token}
          </a>,
        )
      }
    } else {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    }
    last = m.index + token.length
  }
  if (last < text.length) nodes.push(...renderPlainTextWithArrows(text.slice(last), key++))
  return <>{nodes}</>
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const isSvg = lang === 'svg' || (code.trim().startsWith('<svg') && code.includes('</svg>'))
  const [showPreview, setShowPreview] = useState(isSvg)

  const copy = async () => {
    if (await copyText(code)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <div className="group relative overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] lowercase tracking-[0.04em] text-dim">
            {lang || t('chat.codeText')}
          </span>
          {isSvg ? (
            <button
              type="button"
              onClick={() => setShowPreview(!showPreview)}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted/80"
            >
              {showPreview ? 'Lihat Kode' : 'Lihat Diagram'}
            </button>
          ) : null}
        </div>
        <button
          onClick={copy}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label={t('chat.copyCode')}
        >
          {copied ? <Check className="size-3.5 text-[var(--success)]" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      {isSvg && showPreview ? (
        <div
          className="flex justify-center overflow-x-auto p-4"
          dangerouslySetInnerHTML={{ __html: code }}
        />
      ) : (
        <pre className="overflow-x-auto p-3">
          <code className="font-mono text-xs leading-relaxed">{code}</code>
        </pre>
      )}
    </div>
  )
}
