import DOMPurify from 'dompurify'
import { useMemo, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import {
  Columns,
  Image as ImageIcon,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Printer,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface LatexPreviewProps {
  texContent: string
  bibContent?: string
  className?: string
}

interface BibEntry {
  type: string
  key: string
  author?: string
  title?: string
  journal?: string
  booktitle?: string
  year?: string
  volume?: string
  number?: string
  pages?: string
  publisher?: string
}

function parseBibTeX(bibSrc: string): Record<string, BibEntry> {
  const entries: Record<string, BibEntry> = {}
  if (!bibSrc) return entries

  const entryRegex = /@(\w+)\s*\{\s*([^,]+),([\s\S]*?)(?=\n@|\s*$)/g
  let match: RegExpExecArray | null
  while ((match = entryRegex.exec(bibSrc)) !== null) {
    const type = match[1].toLowerCase()
    const key = match[2].trim()
    const fieldsText = match[3]
    const entry: BibEntry = { type, key }

    const fieldRegex = /(\w+)\s*=\s*[{"]([\s\S]*?)[}"]/g
    let fMatch: RegExpExecArray | null
    while ((fMatch = fieldRegex.exec(fieldsText)) !== null) {
      const field = fMatch[1].toLowerCase()
      const val = fMatch[2].replace(/\s+/g, ' ').trim()
      ;(entry as any)[field] = val
    }
    entries[key] = entry
  }
  return entries
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderMathHTML(tex: string, displayMode = false): string {
  try {
    const rendered = katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
    })
    return DOMPurify.sanitize(rendered, {
      ALLOWED_TAGS: [
        'span', 'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'annotation',
        'annotation-xml', 'mfrac', 'msup', 'msub', 'msubsup', 'msqrt', 'mroot',
        'table', 'tbody', 'tr', 'td', 'svg', 'path', 'line'
      ],
      ALLOWED_ATTR: ['class', 'style', 'aria-hidden', 'viewBox', 'd', 'width', 'height'],
    })
  } catch {
    return `<span class="text-destructive font-mono text-xs">${escapeHTML(tex)}</span>`
  }
}

function renderInlineMath(text: string): string {
  // Replace $...$ inline math
  const html = text.replace(/\$([^$]+)\$/g, (_, math) => {
    return renderMathHTML(math, false)
  })
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'span', 'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'annotation',
      'b', 'i', 'em', 'strong', 'sup', 'sub', 'code', 'br'
    ],
    ALLOWED_ATTR: ['class', 'style', 'aria-hidden'],
  })
}

export function LatexPreview({ texContent, bibContent = '', className }: LatexPreviewProps) {
  const [scale, setScale] = useState(100)
  const [isTwoColumn, setIsTwoColumn] = useState(() => {
    return texContent.includes('IEEEtran') || texContent.includes('twocolumn')
  })

  const bibMap = useMemo(() => parseBibTeX(bibContent), [bibContent])

  // Parse document metadata & body
  const parsed = useMemo(() => {
    let title = ''
    let author = ''
    let date = ''
    let abstract = ''
    let keywords = ''

    // Extract title
    const titleMatch = /\\title\{([\s\S]*?)\}/.exec(texContent)
    if (titleMatch) title = titleMatch[1].replace(/\\\\/g, ' ').trim()

    // Extract author
    const authorMatch = /\\author\{([\s\S]*?)\}/.exec(texContent)
    if (authorMatch) author = authorMatch[1].replace(/\\\\/g, '\n').trim()

    // Extract date
    const dateMatch = /\\date\{([\s\S]*?)\}/.exec(texContent)
    if (dateMatch) date = dateMatch[1].replace('\\today', new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })).trim()

    // Extract abstract
    const abstractMatch = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/.exec(texContent)
    if (abstractMatch) abstract = abstractMatch[1].trim()

    // Extract keywords
    const keywordsMatch = /\\begin\{(?:IEEEkeywords|keywords)\}([\s\S]*?)\\end\{(?:IEEEkeywords|keywords)\}/.exec(texContent)
    if (keywordsMatch) keywords = keywordsMatch[1].trim()

    // Extract document body (between \begin{document} and \end{document})
    let body = texContent
    const docStart = texContent.indexOf('\\begin{document}')
    const docEnd = texContent.indexOf('\\end{document}')
    if (docStart !== -1 && docEnd !== -1) {
      body = texContent.slice(docStart + '\\begin{document}'.length, docEnd)
    }

    // Strip maketitle, abstract, keywords, title, author, date from body
    body = body
      .replace(/\\maketitle/g, '')
      .replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g, '')
      .replace(/\\begin\{(?:IEEEkeywords|keywords)\}[\s\S]*?\\end\{(?:IEEEkeywords|keywords)\}/g, '')
      .replace(/\\title\{[\s\S]*?\}/g, '')
      .replace(/\\author\{[\s\S]*?\}/g, '')
      .replace(/\\date\{[\s\S]*?\}/g, '')
      .replace(/\\bibliographystyle\{[\s\S]*?\}/g, '')
      .replace(/\\bibliography\{[\s\S]*?\}/g, '')

    // Find and map all \cite{keys} to sequential numbers [1], [2], ...
    const citedKeys: string[] = []
    const citeMap: Record<string, number> = {}

    const citeRegex = /\\cite\{([^}]+)\}/g
    let cMatch: RegExpExecArray | null
    while ((cMatch = citeRegex.exec(body)) !== null) {
      const keys = cMatch[1].split(',').map((k) => k.trim())
      for (const k of keys) {
        if (!citeMap[k]) {
          citedKeys.push(k)
          citeMap[k] = citedKeys.length
        }
      }
    }

    return {
      title,
      author,
      date,
      abstract,
      keywords,
      rawBody: body,
      citedKeys,
      citeMap,
    }
  }, [texContent])

  // Parse structural elements of body
  const sections = useMemo(() => {
    const raw = parsed.rawBody
    // Tokenize into elements: headings, figures, tables, equations, paragraphs
    const tokens: Array<
      | { type: 'section'; title: string; num: string }
      | { type: 'subsection'; title: string; num: string }
      | { type: 'subsubsection'; title: string }
      | { type: 'figure'; caption: string; label: string; desc: string }
      | { type: 'table'; caption: string; label: string; headers: string[]; rows: string[][] }
      | { type: 'equation'; tex: string; num: number }
      | { type: 'paragraph'; text: string }
    > = []

    let eqCounter = 0
    let figCounter = 0
    let tableCounter = 0
    let secCounter = 0
    let subSecCounter = 0

    // Split by lines or environments
    const lines = raw.split('\n')
    let i = 0

    while (i < lines.length) {
      const line = lines[i].trim()

      if (!line || line.startsWith('%')) {
        i++
        continue
      }

      // 1. Equation \begin{equation}
      if (line.startsWith('\\begin{equation}')) {
        eqCounter++
        let eqLines = []
        i++
        while (i < lines.length && !lines[i].includes('\\end{equation}')) {
          if (!lines[i].trim().startsWith('\\label')) {
            eqLines.push(lines[i])
          }
          i++
        }
        tokens.push({
          type: 'equation',
          tex: eqLines.join('\n'),
          num: eqCounter,
        })
        i++
        continue
      }

      // 2. Figure \begin{figure}
      if (line.startsWith('\\begin{figure}')) {
        figCounter++
        let caption = ''
        let label = ''
        i++
        while (i < lines.length && !lines[i].includes('\\end{figure}')) {
          const l = lines[i].trim()
          const capMatch = /\\caption\{([\s\S]*?)\}/.exec(l)
          if (capMatch) caption = capMatch[1]
          const labMatch = /\\label\{([\s\S]*?)\}/.exec(l)
          if (labMatch) label = labMatch[1]
          i++
        }
        tokens.push({
          type: 'figure',
          caption: caption || `Gambar ${figCounter}`,
          label,
          desc: 'Kotak Placeholder Ilustrasi / Diagram Flowchart',
        })
        i++
        continue
      }

      // 3. Table \begin{table}
      if (line.startsWith('\\begin{table}')) {
        tableCounter++
        let caption = ''
        let label = ''
        let headers: string[] = []
        let rows: string[][] = []
        i++
        while (i < lines.length && !lines[i].includes('\\end{table}')) {
          const l = lines[i].trim()
          const capMatch = /\\caption\{([\s\S]*?)\}/.exec(l)
          if (capMatch) caption = capMatch[1]
          const labMatch = /\\label\{([\s\S]*?)\}/.exec(l)
          if (labMatch) label = labMatch[1]

          if (l.includes('&') && l.includes('\\\\')) {
            const cells = l
              .replace('\\\\', '')
              .split('&')
              .map((c) =>
                c
                  .replace(/\\textbf\{([\s\S]*?)\}/g, '$1')
                  .replace(/\\hline/g, '')
                  .trim(),
              )
            if (headers.length === 0) {
              headers = cells
            } else {
              rows.push(cells)
            }
          }
          i++
        }
        tokens.push({
          type: 'table',
          caption: caption || `Tabel ${tableCounter}`,
          label,
          headers,
          rows,
        })
        i++
        continue
      }

      // 4. Section
      const secMatch = /\\section\{([\s\S]*?)\}/.exec(line)
      if (secMatch) {
        secCounter++
        subSecCounter = 0
        const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][secCounter - 1] || `${secCounter}`
        tokens.push({
          type: 'section',
          title: secMatch[1],
          num: roman,
        })
        i++
        continue
      }

      // 5. Subsection
      const subSecMatch = /\\subsection\{([\s\S]*?)\}/.exec(line)
      if (subSecMatch) {
        subSecCounter++
        const alpha = String.fromCharCode(64 + subSecCounter) // A, B, C...
        tokens.push({
          type: 'subsection',
          title: subSecMatch[1],
          num: alpha,
        })
        i++
        continue
      }

      // 6. Subsubsection
      const subSubSecMatch = /\\subsubsection\{([\s\S]*?)\}/.exec(line)
      if (subSubSecMatch) {
        tokens.push({
          type: 'subsubsection',
          title: subSubSecMatch[1],
        })
        i++
        continue
      }

      // 7. Regular paragraph
      // Collect multi-line paragraphs until blank line
      let pLines = [line]
      i++
      while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('\\')) {
        pLines.push(lines[i].trim())
        i++
      }

      const pText = pLines.join(' ')
      tokens.push({
        type: 'paragraph',
        text: pText,
      })
    }

    return tokens
  }, [parsed.rawBody])

  const handlePrint = () => {
    window.print()
  }

  return (
    <div className={cn('flex h-full flex-col bg-muted/20', className)}>
      {/* Viewer Header Toolbar */}
      <div className="flex items-center justify-between border-b border-border bg-card/60 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setScale((s) => Math.max(70, s - 10))}
            title="Zoom Out"
            className="size-7"
          >
            <MagnifyingGlassMinus className="size-3.5" />
          </Button>
          <span className="w-10 text-center font-mono text-[11px] text-muted-foreground">{scale}%</span>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setScale((s) => Math.min(150, s + 10))}
            title="Zoom In"
            className="size-7"
          >
            <MagnifyingGlassPlus className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant={isTwoColumn ? 'default' : 'outline'}
            onClick={() => setIsTwoColumn((v) => !v)}
            className="ml-2 h-7 gap-1 text-[11px]"
            title="Toggle 2-Column Academic Layout"
          >
            <Columns className="size-3.5" />
            <span>{isTwoColumn ? '2-Kolom' : '1-Kolom'}</span>
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handlePrint}
            className="h-7 gap-1.5 text-[11px]"
            title="Print or Save as PDF"
          >
            <Printer className="size-3.5" />
            <span>Cetak / PDF</span>
          </Button>
        </div>
      </div>

      {/* Rendered Academic Sheet Container */}
      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div
          style={{ transform: `scale(${scale / 100})`, transformOrigin: 'top center' }}
          className="mx-auto min-h-[900px] max-w-[850px] rounded-sm bg-white p-8 md:p-12 text-[#111827] shadow-xl ring-1 ring-black/5 transition-transform"
        >
          {/* Article Header */}
          {parsed.title ? (
            <h1 className="mb-3 text-center font-serif text-2xl font-bold tracking-tight text-gray-950">
              <span dangerouslySetInnerHTML={{ __html: renderInlineMath(parsed.title) }} />
            </h1>
          ) : null}

          {parsed.author ? (
            <div className="mb-4 whitespace-pre-line text-center font-serif text-xs italic text-gray-700">
              {parsed.author}
            </div>
          ) : null}

          {parsed.date ? (
            <div className="mb-6 text-center font-serif text-[11px] text-gray-500">{parsed.date}</div>
          ) : null}

          {/* Abstract & Keywords Box */}
          {parsed.abstract ? (
            <div className="mx-auto mb-8 max-w-[90%] border-t border-b border-gray-300 py-3 font-serif text-xs leading-relaxed text-gray-800">
              <span className="font-bold italic">Abstract—</span>
              <span dangerouslySetInnerHTML={{ __html: renderInlineMath(parsed.abstract) }} />

              {parsed.keywords ? (
                <div className="mt-2 text-[11px]">
                  <span className="font-bold italic">Index Terms—</span>
                  <span className="text-gray-700">{parsed.keywords}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Body Content (1-Column or 2-Column Academic Layout) */}
          <div
            className={cn(
              'font-serif text-[12px] leading-relaxed text-gray-900',
              isTwoColumn && 'columns-1 sm:columns-2 gap-8 text-justify',
            )}
          >
            {sections.map((elem, idx) => {
              if (elem.type === 'section') {
                return (
                  <h2
                    key={idx}
                    className="mt-6 mb-2 text-center text-xs font-bold uppercase tracking-wider text-gray-950"
                  >
                    {elem.num}. {elem.title}
                  </h2>
                )
              }

              if (elem.type === 'subsection') {
                return (
                  <h3 key={idx} className="mt-4 mb-1 text-[11px] font-bold italic text-gray-900">
                    {elem.num}. {elem.title}
                  </h3>
                )
              }

              if (elem.type === 'subsubsection') {
                return (
                  <h4 key={idx} className="mt-3 mb-1 text-[11px] italic text-gray-800">
                    {elem.title}
                  </h4>
                )
              }

              if (elem.type === 'equation') {
                return (
                  <div key={idx} className="my-4 flex items-center justify-between break-inside-avoid px-2">
                    <div
                      className="flex-1 text-center"
                      dangerouslySetInnerHTML={{ __html: renderMathHTML(elem.tex, true) }}
                    />
                    <span className="ml-2 font-serif text-[11px] text-gray-600">({elem.num})</span>
                  </div>
                )
              }

              if (elem.type === 'figure') {
                return (
                  <div key={idx} className="my-5 flex flex-col items-center break-inside-avoid">
                    {/* Visual Illustration Placeholder Frame */}
                    <div className="flex h-36 w-full flex-col items-center justify-center rounded border border-dashed border-gray-400 bg-gray-50/80 p-4 text-center">
                      <ImageIcon className="mb-1.5 size-8 text-gray-400" />
                      <span className="font-sans text-[11px] font-semibold text-gray-700">{elem.desc}</span>
                      <span className="mt-0.5 font-sans text-[10px] text-gray-500">
                        {elem.label ? `\\label{${elem.label}}` : 'Resolusi: 300 DPI, Format: PNG/PDF'}
                      </span>
                    </div>
                    {/* Caption strictly BELOW Figure */}
                    <p className="mt-2 text-center font-serif text-[11px] italic text-gray-800">
                      {elem.caption}
                    </p>
                  </div>
                )
              }

              if (elem.type === 'table') {
                return (
                  <div key={idx} className="my-5 flex flex-col items-center break-inside-avoid">
                    {/* Caption strictly ABOVE Table */}
                    <p className="mb-2 text-center font-serif text-[11px] font-bold text-gray-900">
                      {elem.caption}
                    </p>
                    {/* Formal Academic Bordered Table */}
                    <div className="w-full overflow-x-auto">
                      <table className="w-full border-t-2 border-b-2 border-gray-900 text-[11px]">
                        {elem.headers.length > 0 ? (
                          <thead>
                            <tr className="border-b border-gray-900 bg-gray-50">
                              {elem.headers.map((h, i) => (
                                <th key={i} className="px-3 py-1.5 text-center font-bold text-gray-950">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                        ) : null}
                        <tbody>
                          {elem.rows.map((row, rIdx) => (
                            <tr key={rIdx} className="border-b border-gray-200">
                              {row.map((cell, cIdx) => (
                                <td key={cIdx} className="px-3 py-1.5 text-center text-gray-800">
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              }

              if (elem.type === 'paragraph') {
                // Replace \cite{key} with sequential [N]
                let formatted = elem.text.replace(/\\cite\{([^}]+)\}/g, (_, citeKey) => {
                  const keys = citeKey.split(',').map((k: string) => k.trim())
                  const numbers = keys.map((k: string) => parsed.citeMap[k] || '?').join(', ')
                  return `<span class="font-sans font-semibold text-blue-700">[${numbers}]</span>`
                })

                formatted = renderInlineMath(formatted)

                return (
                  <p
                    key={idx}
                    className="mb-3 text-justify indent-4 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: formatted }}
                  />
                )
              }

              return null
            })}

            {/* References / Bibliography Section */}
            {parsed.citedKeys.length > 0 || Object.keys(bibMap).length > 0 ? (
              <div className="mt-8 break-inside-avoid">
                <h2 className="mb-3 text-center text-xs font-bold uppercase tracking-wider text-gray-950">
                  Daftar Pustaka
                </h2>
                <div className="space-y-2 text-[11px] leading-relaxed">
                  {(parsed.citedKeys.length > 0 ? parsed.citedKeys : Object.keys(bibMap)).map((key, bIdx) => {
                    const bib = bibMap[key]
                    const num = parsed.citeMap[key] || bIdx + 1
                    return (
                      <div key={key} className="flex items-start gap-2 pl-6 -indent-6">
                        <span className="font-semibold text-gray-900">[{num}]</span>
                        <span className="text-gray-800">
                          {bib ? (
                            <>
                              {bib.author ? <span>{bib.author}. </span> : null}
                              {bib.title ? <span className="font-medium italic">"{bib.title}." </span> : null}
                              {bib.journal ? <span>{bib.journal}, </span> : null}
                              {bib.booktitle ? <span>{bib.booktitle}, </span> : null}
                              {bib.volume ? <span>vol. {bib.volume}, </span> : null}
                              {bib.number ? <span>no. {bib.number}, </span> : null}
                              {bib.pages ? <span>pp. {bib.pages}, </span> : null}
                              {bib.year ? <span>{bib.year}.</span> : null}
                            </>
                          ) : (
                            <span className="font-mono text-gray-500">Entry BibTeX untuk [{key}]</span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
