import { memo, useEffect, useMemo, useState } from 'react'
import {
  ArrowCounterClockwise,
  ArrowDown,
  ArrowSquareOut,
  ArrowUp,
  ArrowsClockwise,
  Article,
  BookOpen,
  Check,
  CheckCircle,
  CloudArrowUp,
  Copy,
  DownloadSimple,
  Eye,
  FileCode,
  FileText,
  FloppyDisk,
  Folders,
  Gear,
  Info,
  Key,
  MagnifyingGlass,
  PencilSimple,
  Spinner,
  TrashSimple,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input, Label, Switch } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { del, get, getToken, post } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { LatexPreview } from '@/components/chat/LatexPreview'
import { AcademicDraft } from '@/components/chat/AcademicDraft'
import { buildListTree, type MarkdownListItem } from './Markdown'

interface ResearchPanelProps {
  refreshKey?: number
  onClose: () => void
  onInsertToChat?: (text: string) => void
  sessionId?: string
}

interface ResearchSettings {
  zotero: {
    user_id: string
    api_key: string
  }
  gdocs: {
    method: string
    webhook_url: string
    document_url?: string
    document_id?: string
    oauth_client_id: string
    oauth_client_secret: string
  }
}

const APPS_SCRIPT_TEMPLATE = `function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var doc = DocumentApp.getActiveDocument();
    var body = doc.getBody();
    
    if (data.heading) {
      var h = body.appendParagraph(data.heading);
      if (data.heading === "HEADING_1") h.setHeading(DocumentApp.ParagraphHeading.HEADING1);
      else if (data.heading === "HEADING_2") h.setHeading(DocumentApp.ParagraphHeading.HEADING2);
      else if (data.heading === "HEADING_3") h.setHeading(DocumentApp.ParagraphHeading.HEADING3);
    }
    
    if (data.text) {
      body.appendParagraph(data.text);
    }
    
    if (data.bibliography && data.bibliography.length > 0) {
      body.appendParagraph("Daftar Pustaka").setHeading(DocumentApp.ParagraphHeading.HEADING2);
      for (var i = 0; i < data.bibliography.length; i++) {
        body.appendParagraph("[" + (i+1) + "] " + data.bibliography[i]);
      }
    }
    
    return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var doc = DocumentApp.getActiveDocument();
    var title = doc.getName();
    var content = doc.getBody().getText();
    return ContentService.createTextOutput(JSON.stringify({ status: "success", title: title, content: content }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}`

const IEEE_TEMPLATE = `\\documentclass[journal]{IEEEtran}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{algorithmic}
\\usepackage{graphicx}
\\usepackage{textcomp}
\\usepackage{cite}

\\begin{document}

\\title{Judul Artikel Ilmiah: Analisis Komparatif dan Evaluasi Sistem}
\\author{Penulis Pertama, Penulis Kedua}

\\maketitle

\\begin{abstract}
Ringkasan singkat memuat latar belakang, perumusan masalah, metodologi, dan hasil eksperimen.
\\end{abstract}

\\begin{IEEEkeywords}
Kecerdasan Buatan, Desain Sistem, Evaluasi Model.
\\end{IEEEkeywords}

\\section{Pendahuluan}
Perkembangan teknologi komputasi berkembang pesat dalam beberapa dekade terakhir \\cite{setiawan2024}.

\\section{Metodologi Penelitian}
Uraian sistematis metode yang diusulkan.

% --- PLACEHOLDER GAMBAR & FLOWCHART (CAPTION DI BAWAH) ---
\\begin{figure}[htbp]
  \\centering
  % \\includegraphics[width=0.85\\linewidth]{figures/flowchart.png}
  \\fbox{\\rule{0pt}{2in} \\rule{0.85\\linewidth}{0pt}} % Kotak placeholder gambar
  \\caption{Gambar 2.1: Flowchart Metodologi Penelitian dan Arsitektur Sistem}
  \\label{fig:flowchart}
\\end{figure}

% --- PERSAMAAN MATEMATIKA ---
Persamaan matematis sistem dirumuskan sebagai berikut:
\\begin{equation}
  f(x) = \\sum_{i=1}^{n} w_i \\cdot x_i + b
  \\label{eq:model}
\\end{equation}

\\section{Hasil dan Pembahasan}
Hasil pengujian performa sistem disajikan pada Tabel \\ref{tab:hasil}.

% --- TABEL FORMAL AKADEMIK (CAPTION DI ATAS) ---
\\begin{table}[htbp]
  \\caption{Tabel 2.1: Hasil Evaluasi Akurasi dan F1-Score Model}
  \\label{tab:hasil}
  \\centering
  \\begin{tabular}{|l|c|c|c|}
    \\hline
    \\textbf{Metode} & \\textbf{Presisi (\\%)} & \\textbf{Recall (\\%)} & \\textbf{F1-Score} \\\\
    \\hline
    Baseline & 84.5 & 82.1 & 0.832 \\\\
    Usulan Sistem & \\textbf{95.2} & \\textbf{94.8} & \\textbf{0.950} \\\\
    \\hline
  \\end{tabular}
\\end{table}

\\section{Kesimpulan}
Penelitian ini membuktikan peningkatan performa yang signifikan.

\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}
`

const STANDARD_TEMPLATE = `\\documentclass[12pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{mathptmx} % Times New Roman font
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage[numbers]{natbib}
\\usepackage{setspace}
\\onehalfspacing

\\title{\\textbf{Judul Naskah Publikasi Ilmiah}}
\\author{Nama Penulis\\\\\\small Afiliasi Penulis, Email}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
Abstrak naskah memuat tujuan, metode, hasil, dan simpulan penelitian.
\\end{abstract}

\\section{Pendahuluan}
Pendahuluan naskah dengan sitasi pustaka \\cite{setiawan2024}.

% --- PLACEHOLDER GAMBAR (CAPTION DI BAWAH) ---
\\begin{figure}[htbp]
  \\centering
  \\fbox{\\rule{0pt}{1.8in} \\rule{0.8\\linewidth}{0pt}}
  \\caption{Gambar 1.1: Diagram Alir Penelitian}
  \\label{fig:diagram}
\\end{figure}

\\section{Metodologi}
Rumus persamaan matematis:
\\begin{equation}
  E = mc^2
\\end{equation}

% --- TABEL (CAPTION DI ATAS) ---
\\begin{table}[htbp]
  \\caption{Tabel 1.1: Parameter Pengujian}
  \\label{tab:params}
  \\centering
  \\begin{tabular}{llr}
    \\toprule
    Parameter & Nilai & Keterangan \\\\
    \\midrule
    Learning Rate & 0.001 & Adam Optimizer \\\\
    Batch Size & 32 & GPU V100 \\\\
    \\bottomrule
  \\end{tabular}
\\end{table}

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`

const BIBTEX_TEMPLATE = `@article{setiawan2024,
  author = {Setiawan, Vega and Budiman, A.},
  title = {Arsitektur Agen Cerdas untuk Penulisan Ilmiah Terpadu},
  journal = {Jurnal Riset Ilmu Komputer dan Informatika},
  volume = {12},
  number = {2},
  pages = {145--158},
  year = {2024},
  publisher = {Academic Press}
}

@book{goodfellow2016deep,
  title = {Deep Learning},
  author = {Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron},
  year = {2016},
  publisher = {MIT Press}
}
`

const DEFAULT_DRAFT_MD = `# BAB 3: PERANCANGAN SISTEM (BILIK)

## 3.1 Gambaran Umum Sistem
Sistem Bilik adalah platform manajemen kamar sewa dan properti berbasis web yang menghubungkan pemilik properti dan penyewa. Sistem dirancang menggunakan arsitektur modular yang terdiri dari frontend berbasis React dan backend API.

## 3.2 Diagram Alir & Metodologi
Berikut adalah alur proses transaksi dan pemesanan kamar pada sistem Bilik:

\`\`\`
┌────────────────┐       ┌──────────────────────┐       ┌────────────────────────┐
│  Penyewa       │  ───> │  Sistem Bilik        │  ───> │  Pemilik Properti      │
│  Pilih Kamar   │       │  Verifikasi & Invoice│       │  Konfirmasi Booking    │
└────────────────┘       └──────────────────────┘       └────────────────────────┘
\`\`\`

*Gambar 3.1: Diagram Alir Pemesanan Kamar pada Sistem Bilik*

## 3.3 Spesifikasi Komponen & Perancangan Tabel
Spesifikasi modul sistem Bilik dirinci pada tabel berikut:

| No | Modul Sistem | Teknologi | Fungsi Utama |
| --- | --- | --- | --- |
| 1 | Frontend Dashboard | React, Vite, Tailwind | Antarmuka interaktif pengguna & manajemen properti |
| 2 | Backend Service | Go / Node.js REST API | Logika bisnis, otentikasi JWT, & manajemen data |
| 3 | Database Storage | PostgreSQL / SQLite | Penyimpanan data relasional kamar & transaksi |
| 4 | Payment Gateway | Midtrans / Xendit API | Pemrosesan pembayaran otomatis |

*Tabel 3.1: Matriks Arsitektur dan Komponen Sistem Bilik*

## 3.4 Analisis Kebutuhan Non-Fungsional
1. **Keamanan**: Data transaksi dilindungi dengan enkripsi SSL dan otentikasi berbasis token.
2. **Ketersediaan**: Sistem memiliki uptime target 99.9% dengan replikasi database berkala.
`

async function convertSvgToPngDataUrl(svgStr: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      // Sanitize unescaped ampersands in text nodes (e.g. "Owner & Staff" -> "Owner &amp; Staff")
      const sanitizedSvg = svgStr.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')

      const parser = new DOMParser()
      const doc = parser.parseFromString(sanitizedSvg, 'image/svg+xml')
      const parserError = doc.querySelector('parsererror')
      if (parserError) {
        console.warn('SVG parse error:', parserError.textContent)
        resolve('')
        return
      }

      const svgEl = doc.querySelector('svg')
      if (!svgEl) {
        resolve('')
        return
      }

      let width = 800
      let height = 500
      const viewBox = svgEl.getAttribute('viewBox')
      if (viewBox) {
        const parts = viewBox.split(/\s+/).map(Number)
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          width = parts[2]
          height = parts[3]
        }
      } else {
        width = parseFloat(svgEl.getAttribute('width') || '800') || 800
        height = parseFloat(svgEl.getAttribute('height') || '500') || 500
      }

      const canvas = document.createElement('canvas')
      canvas.width = width * 2
      canvas.height = height * 2
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve('')
        return
      }
      ctx.scale(2, 2)

      const img = new Image()
      const svgBlob = new Blob([sanitizedSvg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(svgBlob)

      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        resolve('')
      }
      img.src = url
    } catch {
      resolve('')
    }
  })
}

export async function convertMarkdownToAcademicHtml(draftTitle: string, draftContent: string): Promise<string> {
  let processedContent = draftContent
  const svgMatches = processedContent.match(/<svg[\s\S]*?<\/svg>/gi) || []
  for (const svgCode of svgMatches) {
    const pngDataUrl = await convertSvgToPngDataUrl(svgCode)
    if (pngDataUrl) {
      processedContent = processedContent.replace(
        svgCode,
        `<p style="text-align: center; margin-top: 10px; margin-bottom: 2px;"><img src="${pngDataUrl}" width="500" style="max-width: 500px; width: 500px; height: auto;" /></p>`,
      )
    } else {
      processedContent = processedContent.replace(
        svgCode,
        '<p style="text-align: center; margin: 12px 0; padding: 20px; border: 1px dashed #94a3b8; font-style: italic; color: #64748b;">[Diagram Alir / Gambar Arsitektur Sistem Bilik]</p>',
      )
    }
  }

  const lines = processedContent.split('\n')
  let bodyHtml = ''
  let inTable = false
  let tableRows: string[][] = []

  const flushTable = () => {
    if (!inTable || tableRows.length === 0) {
      inTable = false
      tableRows = []
      return
    }
    const numCols = tableRows[0].length
    const colLengths = new Array(numCols).fill(0)
    tableRows.forEach((row) => {
      row.forEach((cell, i) => {
        if (i < numCols) {
          colLengths[i] = Math.max(colLengths[i], cell.trim().length)
        }
      })
    })
    const totalLen = colLengths.reduce((a, b) => a + b, 0) || 1
    const colWidths = colLengths.map((len, idx) => {
      const hName = tableRows[0][idx]?.trim().toLowerCase()
      if (hName === 'no' || hName === 'no.' || hName === '#') return '6%'
      const pct = Math.max(12, Math.round((len / totalLen) * 100))
      return `${pct}%`
    })

    bodyHtml += '<table border="1" style="border-collapse: collapse; width: 100%; margin-top: 4px; margin-bottom: 12px; font-family: \'Times New Roman\', serif; font-size: 11pt; table-layout: auto;">\n'
    tableRows.forEach((row, rIdx) => {
      bodyHtml += '  <tr>\n'
      row.forEach((cell, cIdx) => {
        const tag = rIdx === 0 ? 'th' : 'td'
        const isCenter = rIdx === 0 || (cIdx === 0 && (tableRows[0][0]?.toLowerCase().includes('no') || cell.trim().length <= 4))
        const align = isCenter ? 'text-align: center;' : 'text-align: left;'
        const bg = rIdx === 0 ? 'background-color: #f1f5f9; font-weight: bold;' : ''
        const formattedCell = cell.trim()
          .replace(/\*\*([\s\S]*?)\*\*/g, '<b style="font-weight: 700; font-family: \'Times New Roman\', Times, serif;">$1</b>')
          .replace(/\*([\s\S]*?)\*/g, '<i style="font-family: \'Times New Roman\', Times, serif;">$1</i>')
        bodyHtml += `    <${tag} style="border: 1px solid #1e293b; padding: 5px 8px; font-size: 11pt; line-height: 1.15; width: ${colWidths[cIdx]}; ${align} ${bg}"><span style="font-family: 'Times New Roman', Times, serif;">${formattedCell}</span></${tag}>\n`
      })
      bodyHtml += '  </tr>\n'
    })
    bodyHtml += '</table>\n'
    inTable = false
    tableRows = []
  }

  const renderListToAcademicHtml = (items: MarkdownListItem[], isOrdered: boolean, level = 0): string => {
    const tag = isOrdered ? 'ol' : 'ul'
    const padLeft = level === 0 ? '1cm' : '0.8cm'
    let html = `<${tag} style="margin-top: 3pt; margin-bottom: 3pt; padding-left: ${padLeft}; font-family: 'Times New Roman', Times, serif; font-size: 12pt; line-height: 1.15;">\n`

    for (const item of items) {
      const formatted = item.text
        .replace(/\*\*([\s\S]*?)\*\*/g, '<b style="font-weight: 700; font-family: \'Times New Roman\', Times, serif;">$1</b>')
        .replace(/\*([\s\S]*?)\*/g, '<i style="font-family: \'Times New Roman\', Times, serif;">$1</i>')

      html += `  <li style="margin-top: 2pt; margin-bottom: 2pt; line-height: 1.15;"><span style="font-family: 'Times New Roman', Times, serif;">${formatted}</span>`
      if (item.children && item.children.length > 0) {
        html += '\n' + renderListToAcademicHtml(item.children, item.children[0].ordered, level + 1)
      }
      html += '</li>\n'
    }

    html += `</${tag}>\n`
    return html
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.trim()
    if (!line) {
      if (inTable) flushTable()
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      inTable = true
      const parseRow = (l: string) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
      tableRows.push(parseRow(line))
      i++
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
        i++
        tableRows.push(parseRow(lines[i]))
      }
      flushTable()
      continue
    }

    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(rawLine)
    if (listMatch) {
      if (inTable) flushTable()
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
      i-- // compensate for loop increment

      const items = buildListTree(rawItems)
      if (items.length > 0) {
        bodyHtml += renderListToAcademicHtml(items, items[0].ordered)
      }
      continue
    }

    if (line.startsWith('# ')) {
      bodyHtml += `<h1 style="font-family: 'Times New Roman', Times, serif; font-size: 12pt; font-weight: bold; text-align: center; text-transform: uppercase; margin-top: 14pt; margin-bottom: 6pt; line-height: 1.15;"><b style="font-weight: 700; font-family: 'Times New Roman', Times, serif;">${line.slice(2).trim()}</b></h1>\n`
    } else if (line.startsWith('## ')) {
      bodyHtml += `<h2 style="font-family: 'Times New Roman', Times, serif; font-size: 12pt; font-weight: bold; margin-top: 12pt; margin-bottom: 4pt; line-height: 1.15;"><b style="font-weight: 700; font-family: 'Times New Roman', Times, serif;">${line.slice(3).trim()}</b></h2>\n`
    } else if (line.startsWith('### ')) {
      bodyHtml += `<h3 style="font-family: 'Times New Roman', Times, serif; font-size: 12pt; font-weight: bold; font-style: italic; margin-top: 10pt; margin-bottom: 2pt; line-height: 1.15;"><b style="font-weight: 700; font-family: 'Times New Roman', Times, serif;"><i>${line.slice(4).trim()}</i></b></h3>\n`
    } else if (line.startsWith('<img') || line.startsWith('<div')) {
      bodyHtml += line + '\n'
    } else if (line.startsWith('<p')) {
      let pLine = line
      if (!pLine.includes('line-height')) {
        pLine = pLine.replace(/<p\s+style="([^"]*)"/i, '<p style="font-family: \'Times New Roman\', Times, serif; margin: 0; line-height: 1.15; $1"')
      }
      bodyHtml += pLine + '\n'
    } else {
      const isFigure = /^\*?(Gambar|Figure)\s+\d+[\d.]*[:\s]/.test(line)
      const isTable = /^\*?(Tabel|Table)\s+\d+[\d.]*[:\s]/.test(line)
      let formatted = line
        .replace(/\*\*([\s\S]*?)\*\*/g, '<b style="font-weight: 700; font-family: \'Times New Roman\', Times, serif;">$1</b>')
        .replace(/\*([\s\S]*?)\*/g, '<i style="font-family: \'Times New Roman\', Times, serif;">$1</i>')
      if (isFigure) {
        bodyHtml += `<p style="font-family: 'Times New Roman', Times, serif; text-align: center; font-size: 11pt; font-style: italic; font-weight: normal; margin-top: 4pt; margin-bottom: 8pt; line-height: 1.15; color: #1e293b;"><span style="font-family: 'Times New Roman', Times, serif;">${formatted}</span></p>\n`
      } else if (isTable) {
        bodyHtml += `<p style="font-family: 'Times New Roman', Times, serif; font-size: 11pt; font-style: italic; font-weight: normal; margin-top: 10pt; margin-bottom: 2pt; line-height: 1.15; color: #1e293b;"><span style="font-family: 'Times New Roman', Times, serif;">${formatted}</span></p>\n`
      } else {
        bodyHtml += `<p style="font-family: 'Times New Roman', Times, serif; font-size: 12pt; line-height: 1.15; text-align: justify; text-indent: 1cm; margin-top: 0pt; margin-bottom: 6pt;"><span style="font-family: 'Times New Roman', Times, serif;">${formatted}</span></p>\n`
      }
    }
  }

  if (inTable) flushTable()

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${draftTitle}</title>
<style>
@page { size: A4; margin: 3cm 3cm 3cm 4cm; }
body, p, div, span, table, th, td, h1, h2, h3, h4 { font-family: 'Times New Roman', Times, serif !important; color: #000; }
body, p, div { font-size: 12pt; line-height: 1.15; text-align: justify; margin-top: 0pt; margin-bottom: 0pt; }
h1 { font-size: 12pt; font-weight: bold; text-align: center; text-transform: uppercase; margin-top: 14pt; margin-bottom: 6pt; line-height: 1.15; }
h2 { font-size: 12pt; font-weight: bold; margin-top: 12pt; margin-bottom: 4pt; line-height: 1.15; }
h3 { font-size: 12pt; font-weight: bold; font-style: italic; margin-top: 10pt; margin-bottom: 2pt; line-height: 1.15; }
table { border-collapse: collapse; width: 100%; margin-top: 4pt; margin-bottom: 12pt; font-family: 'Times New Roman', serif; font-size: 11pt; }
th, td { border: 1px solid #1e293b; padding: 5px 8px; line-height: 1.15; font-size: 11pt; }
th { background-color: #f1f5f9; font-weight: bold; text-align: center; }
img { max-width: 500px; height: auto; display: block; margin: 0 auto; }
</style>
</head>
<body style="font-family: 'Times New Roman', Times, serif; margin: 40px;">
${bodyHtml}
</body>
</html>`
}

export const ResearchPanel = memo(function ResearchPanel({
  refreshKey,
  onClose,
  onInsertToChat,
  sessionId,
}: ResearchPanelProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'draft' | 'gdocs' | 'latex' | 'zotero'>('draft')
  const [docViewMode, setDocViewMode] = useState<'edit' | 'preview'>('edit')
  const [frameKey, setFrameKey] = useState(0)

  // Draft state (HTML / Markdown artifact)
  const [draftTitle, setDraftTitle] = useState(() => {
    try {
      const key = sessionId ? `antares:draft-title:${sessionId}` : 'antares:draft-title'
      return localStorage.getItem(key) || (sessionId ? '' : 'Bab 3 - Perancangan Sistem Bilik')
    } catch {
      return sessionId ? '' : 'Bab 3 - Perancangan Sistem Bilik'
    }
  })
  const [draftContent, setDraftContent] = useState(() => {
    try {
      const key = sessionId ? `antares:draft-md:${sessionId}` : 'antares:draft-md'
      return localStorage.getItem(key) || (sessionId ? '' : DEFAULT_DRAFT_MD)
    } catch {
      return sessionId ? '' : DEFAULT_DRAFT_MD
    }
  })
  const [draftViewMode, setDraftViewMode] = useState<'edit' | 'preview'>('preview')
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deletingDraft, setDeletingDraft] = useState(false)
  const [downloadingDocx, setDownloadingDocx] = useState(false)
  const [exportModalTab, setExportModalTab] = useState<'docx' | 'oauth'>('docx')
  const [exportingGdocs, setExportingGdocs] = useState(false)
  const [exportedDocUrl, setExportedDocUrl] = useState('')
  const [exportError, setExportError] = useState('')
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [autoShareWithLink, setAutoShareWithLink] = useState(true)
  const [draftSearchOpen, setDraftSearchOpen] = useState(false)
  const [draftSearchQuery, setDraftSearchQuery] = useState('')
  const [syncPushing, setSyncPushing] = useState(false)
  const [syncPushSuccess, setSyncPushSuccess] = useState(false)
  const [syncPulling, setSyncPulling] = useState(false)
  const [syncPullSuccess, setSyncPullSuccess] = useState(false)

  // Shortcut Ctrl+F in draft tab
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && tab === 'draft') {
        e.preventDefault()
        setDraftSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [tab])

  const highlightedDraftContent = useMemo(() => {
    const q = draftSearchQuery.trim()
    if (!q) return draftContent
    try {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?<!<[^>]*)(${escaped})(?![^<]*>)`, 'gi')
      return draftContent.replace(
        re,
        '<mark style="background-color: #fef08a; color: #854d0e; padding: 1px 3px; border-radius: 2px;">$1</mark>',
      )
    } catch {
      return draftContent
    }
  }, [draftContent, draftSearchQuery])

  const a4Pages = useMemo(() => {
    // Split content into simulated page sheets based on headings or length
    const rawSections = highlightedDraftContent.split(/(?=\n##?\s+)/g)
    const pages: string[] = []
    let currentPage = ''

    rawSections.forEach((sec) => {
      if (currentPage && (currentPage.length > 2200 || sec.trim().startsWith('# '))) {
        pages.push(currentPage)
        currentPage = sec.trim()
      } else {
        currentPage = (currentPage ? currentPage + '\n\n' : '') + sec.trim()
      }
    })
    if (currentPage) pages.push(currentPage)
    return pages
  }, [highlightedDraftContent])

  const handleDraftChange = (val: string) => {
    setDraftContent(val)
    const localKey = sessionId ? `antares:draft-md:${sessionId}` : 'antares:draft-md'
    try {
      localStorage.setItem(localKey, val)
      post('/research/draft', { title: draftTitle, content: val, session_id: sessionId }).catch(() => {})
    } catch {}
  }

  const handleTitleChange = (val: string) => {
    setDraftTitle(val)
    const localKey = sessionId ? `antares:draft-title:${sessionId}` : 'antares:draft-title'
    try {
      localStorage.setItem(localKey, val)
      post('/research/draft', { title: val, content: draftContent, session_id: sessionId }).catch(() => {})
    } catch {}
  }

  const handleDeleteDraft = async () => {
    setDeletingDraft(true)
    try {
      const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
      await del(`/research/draft${q}`)
      setDraftContent('')
      setDraftTitle('')
      const localKeyContent = sessionId ? `antares:draft-md:${sessionId}` : 'antares:draft-md'
      const localKeyTitle = sessionId ? `antares:draft-title:${sessionId}` : 'antares:draft-title'
      try {
        localStorage.removeItem(localKeyContent)
        localStorage.removeItem(localKeyTitle)
      } catch {}
      setConfirmDeleteOpen(false)
    } catch {
      // ignore
    } finally {
      setDeletingDraft(false)
    }
  }

  const handleDownloadDocx = async () => {
    setDownloadingDocx(true)
    try {
      let processedContent = draftContent
      const svgMatches = processedContent.match(/<svg[\s\S]*?<\/svg>/gi) || []
      for (const svgCode of svgMatches) {
        const pngDataUrl = await convertSvgToPngDataUrl(svgCode)
        if (pngDataUrl) {
          processedContent = processedContent.replace(svgCode, `\n\n<img src="${pngDataUrl}" alt="Figure" />\n\n`)
        }
      }

      const res = await fetch('/api/research/draft/export-docx', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: JSON.stringify({
          title: draftTitle,
          content: processedContent,
          session_id: sessionId,
        }),
      })

      if (!res.ok) {
        throw new Error('Gagal mengunduh berkas .docx')
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${draftTitle || 'Dokumen_Antares'}.docx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e: any) {
      alert(e?.message || 'Gagal mengunduh berkas .docx')
    } finally {
      setDownloadingDocx(false)
    }
  }

  const handleExportToGoogleDocs = async () => {
    setExportingGdocs(true)
    setExportError('')
    setExportedDocUrl('')
    try {
      const fullHtml = await convertMarkdownToAcademicHtml(draftTitle, draftContent)
      const res = await post<{ status: string; document_url: string; document_id: string }>(
        '/research/gdocs/export',
        {
          session_id: sessionId,
          title: draftTitle,
          html: fullHtml,
          auto_share: autoShareWithLink,
          share_role: 'writer',
        },
      )
      if (res.document_url) {
        setExportedDocUrl(res.document_url)
        setDocUrl(res.document_url)
        setPreviewActive(true)
        setExportModalOpen(false)
        const localGdocsKey = sessionId ? `antares:gdocs-active-url:${sessionId}` : 'antares:gdocs-active-url'
        try {
          localStorage.setItem(localGdocsKey, res.document_url)
        } catch {}
        // Automatically switch to Google Docs tab to view the document live
        setTab('gdocs')
      }
    } catch (err: any) {
      setExportError(err?.message || 'Gagal mengekspor dokumen ke Google Docs')
    } finally {
      setExportingGdocs(false)
    }
  }

  // Two-way synchronization handlers
  const handleSyncPush = async () => {
    if (!docUrl) return
    setSyncPushing(true)
    setSyncPushSuccess(false)
    try {
      const fullHtml = await convertMarkdownToAcademicHtml(draftTitle, draftContent)
      const res = await post<{ status: string; document_url: string }>(
        '/research/gdocs/sync',
        {
          session_id: sessionId,
          document_url: docUrl,
          html: fullHtml,
        },
      )
      if (res.status === 'success') {
        setSyncPushSuccess(true)
        setFrameKey((k) => k + 1)
        setTimeout(() => setSyncPushSuccess(false), 3000)
      }
    } catch {
      // ignore
    } finally {
      setSyncPushing(false)
    }
  }

  const handleSyncPull = async () => {
    if (!docUrl) return
    setSyncPulling(true)
    setSyncPullSuccess(false)
    try {
      const res = await post<{ status: string; content: string }>(
        '/research/gdocs/pull',
        { session_id: sessionId, document_url: docUrl },
      )
      if (res.content) {
        setDraftContent(res.content)
        const localKey = sessionId ? `antares:draft-md:${sessionId}` : 'antares:draft-md'
        try {
          localStorage.setItem(localKey, res.content)
        } catch {}
        setSyncPullSuccess(true)
        setTimeout(() => setSyncPullSuccess(false), 3000)
      }
    } catch {
      // ignore
    } finally {
      setSyncPulling(false)
    }
  }

  // LaTeX state
  const [latexFile, setLatexFile] = useState<'main' | 'bib'>('main')
  const [latexViewMode, setLatexViewMode] = useState<'editor' | 'preview'>('editor')
  const [latexTemplate, setLatexTemplate] = useState<'ieee' | 'standard'>('ieee')
  const [latexMainCode, setLatexMainCode] = useState(() => {
    try {
      return localStorage.getItem('antares:latex-main') || IEEE_TEMPLATE
    } catch {
      return IEEE_TEMPLATE
    }
  })
  const [latexBibCode, setLatexBibCode] = useState(() => {
    try {
      return localStorage.getItem('antares:latex-bib') || BIBTEX_TEMPLATE
    } catch {
      return BIBTEX_TEMPLATE
    }
  })
  const [latexCopied, setLatexCopied] = useState(false)

  const handleLatexChange = (val: string) => {
    if (latexFile === 'main') {
      setLatexMainCode(val)
      try {
        localStorage.setItem('antares:latex-main', val)
      } catch {}
    } else {
      setLatexBibCode(val)
      try {
        localStorage.setItem('antares:latex-bib', val)
      } catch {}
    }
  }

  const handleCopyLatex = async () => {
    const code = latexFile === 'main' ? latexMainCode : latexBibCode
    if (await copyText(code)) {
      setLatexCopied(true)
      setTimeout(() => setLatexCopied(false), 2000)
    }
  }

  const handleApplyTemplate = (tpl: 'ieee' | 'standard') => {
    setLatexTemplate(tpl)
    const code = tpl === 'ieee' ? IEEE_TEMPLATE : STANDARD_TEMPLATE
    setLatexMainCode(code)
    try {
      localStorage.setItem('antares:latex-main', code)
    } catch {}
  }

  const handleInsertSnippet = (snippet: string) => {
    if (latexFile === 'main') {
      const next = latexMainCode.trimEnd() + '\n\n' + snippet + '\n'
      setLatexMainCode(next)
      try {
        localStorage.setItem('antares:latex-main', next)
      } catch {}
    } else {
      const next = latexBibCode.trimEnd() + '\n\n' + snippet + '\n'
      setLatexBibCode(next)
      try {
        localStorage.setItem('antares:latex-bib', next)
      } catch {}
    }
  }

  // Auto-reload preview iframe when a chat turn completes
  useEffect(() => {
    if (refreshKey && refreshKey > 0) {
      setFrameKey((k) => k + 1)
    }
  }, [refreshKey])

  // Persistent docUrl across refresh via localStorage
  const [docUrl, setDocUrl] = useState(() => {
    try {
      return localStorage.getItem('antares:gdocs-active-url') || ''
    } catch {
      return ''
    }
  })
  const [previewActive, setPreviewActive] = useState(() => {
    try {
      return !!localStorage.getItem('antares:gdocs-active-url')
    } catch {
      return false
    }
  })

  const [searchQuery, setSearchQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'zotero' | 'gdocs'>('zotero')
  const [oauthGuideOpen, setOauthGuideOpen] = useState(false)
  const [copiedUri, setCopiedUri] = useState<string | null>(null)
  const [googleConnected, setGoogleConnected] = useState(false)
  const [connectingGoogle, setConnectingGoogle] = useState(false)
  const [authUrl, setAuthUrl] = useState('')
  const [authUrlCopied, setAuthUrlCopied] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const [rollbackSuccess, setRollbackSuccess] = useState(false)

  const handleRollback = async () => {
    setRollingBack(true)
    setRollbackSuccess(false)
    try {
      await post('/research/gdocs/rollback', { document_url: docUrl })
      setRollbackSuccess(true)
      setFrameKey((k) => k + 1)
      setTimeout(() => setRollbackSuccess(false), 3000)
    } catch {
      // ignore
    } finally {
      setRollingBack(false)
    }
  }

  // Listen for Google OAuth completion and load connection status
  useEffect(() => {
    get<{ connected: boolean; has_client: boolean }>('/auth/google/status')
      .then((res) => {
        setGoogleConnected(!!res.connected)
      })
      .catch(() => {})

    const handleMsg = (event: MessageEvent) => {
      if (event.data?.type === 'gdocs:connected') {
        setGoogleConnected(true)
        setConnectingGoogle(false)
      }
    }
    window.addEventListener('message', handleMsg)
    return () => window.removeEventListener('message', handleMsg)
  }, [])

  // Settings State
  const [zoteroUserId, setZoteroUserId] = useState('')
  const [zoteroApiKey, setZoteroApiKey] = useState('')
  const [gdocsMethod, setGdocsMethod] = useState<'webhook' | 'oauth'>('webhook')
  const [gdocsWebhookUrl, setGdocsWebhookUrl] = useState('')
  const [gdocsClientId, setGdocsClientId] = useState('')
  const [gdocsClientSecret, setGdocsClientSecret] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Load settings on mount or session change
  useEffect(() => {
    const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
    get<ResearchSettings>(`/research/settings${q}`)
      .then((data) => {
        if (data.zotero) {
          setZoteroUserId(data.zotero.user_id || '')
          setZoteroApiKey(data.zotero.api_key || '')
        }
        if (data.gdocs) {
          setGdocsMethod(data.gdocs.method === 'oauth' ? 'oauth' : 'webhook')
          setGdocsWebhookUrl(data.gdocs.webhook_url || '')
          setGdocsClientId(data.gdocs.oauth_client_id || '')
          setGdocsClientSecret(data.gdocs.oauth_client_secret || '')
          const doc = data.gdocs.document_url || ''
          setDocUrl(doc)
          setPreviewActive(Boolean(doc))
          const localGdocsKey = sessionId ? `antares:gdocs-active-url:${sessionId}` : 'antares:gdocs-active-url'
          try {
            if (doc) localStorage.setItem(localGdocsKey, doc)
            else localStorage.removeItem(localGdocsKey)
          } catch {}
        }
      })
      .catch(() => {})
  }, [sessionId])

  const handleLoadDoc = (urlVal?: string) => {
    const val = (urlVal !== undefined ? urlVal : docUrl).trim()
    if (!val) return
    setPreviewActive(true)
    const localGdocsKey = sessionId ? `antares:gdocs-active-url:${sessionId}` : 'antares:gdocs-active-url'
    try {
      localStorage.setItem(localGdocsKey, val)
      post('/research/settings', {
        session_id: sessionId,
        gdocs: {
          document_url: val,
        },
      }).catch(() => {})
    } catch {
      // ignore
    }
  }

  const handleClearDoc = async () => {
    setDocUrl('')
    setPreviewActive(false)
    const localGdocsKey = sessionId ? `antares:gdocs-active-url:${sessionId}` : 'antares:gdocs-active-url'
    try {
      localStorage.removeItem(localGdocsKey)
      await post('/research/settings', {
        session_id: sessionId,
        gdocs: {
          document_url: '',
          document_id: '',
        },
      })
    } catch {
      // ignore
    }
  }

  // Sync live draft from backend on mount, turn completions, or session change
  useEffect(() => {
    const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
    get<{ title: string; content: string }>(`/research/draft${q}`)
      .then((res) => {
        setDraftContent(res.content || '')
        setDraftTitle(res.title || '')
        const localKeyContent = sessionId ? `antares:draft-md:${sessionId}` : 'antares:draft-md'
        const localKeyTitle = sessionId ? `antares:draft-title:${sessionId}` : 'antares:draft-title'
        try {
          if (res.content) localStorage.setItem(localKeyContent, res.content)
          else localStorage.removeItem(localKeyContent)
          if (res.title) localStorage.setItem(localKeyTitle, res.title)
          else localStorage.removeItem(localKeyTitle)
        } catch {}
      })
      .catch(() => {})
  }, [refreshKey, sessionId])

  const handleSaveSettings = async (closeModal = true) => {
    setSavingSettings(true)
    setSaveSuccess(false)
    try {
      await post('/research/settings', {
        session_id: sessionId,
        zotero: {
          user_id: zoteroUserId,
          api_key: zoteroApiKey,
        },
        gdocs: {
          method: gdocsMethod,
          webhook_url: gdocsWebhookUrl,
          document_url: docUrl,
          oauth_client_id: gdocsClientId,
          oauth_client_secret: gdocsClientSecret,
        },
      })
      setSaveSuccess(true)
      if (closeModal) {
        setTimeout(() => {
          setSaveSuccess(false)
          setSettingsOpen(false)
        }, 1000)
      } else {
        setTimeout(() => {
          setSaveSuccess(false)
        }, 2000)
      }
    } catch {
      // Error handled
    } finally {
      setSavingSettings(false)
    }
  }

  const handleCopyScript = async () => {
    if (await copyText(APPS_SCRIPT_TEMPLATE)) {
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 2000)
    }
  }

  const isSafeGoogleDocUrl = (url: string) => {
    return /^https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]{20,}/i.test(url.trim())
  }

  const getCleanDocUrl = (url: string) => {
    const match = url.trim().match(/\/document\/d\/([a-zA-Z0-9_-]{20,})/)
    if (match && match[1]) {
      return `https://docs.google.com/document/d/${match[1]}/edit`
    }
    return ''
  }

  // Convert standard edit Google Doc URL to full web /edit (with File, Edit, Format menus) or /preview
  const getEmbedUrl = (url: string, key: number, mode: 'edit' | 'preview' = 'edit') => {
    if (!url) return ''
    const match = url.trim().match(/\/document\/d\/([a-zA-Z0-9_-]{20,})/)
    if (match && match[1]) {
      if (mode === 'edit') {
        return `https://docs.google.com/document/d/${match[1]}/edit?cb=${key}`
      }
      return `https://docs.google.com/document/d/${match[1]}/preview?cb=${key}`
    }
    return ''
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      {/* Panel Header */}
      <div className="flex h-13 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Button
            variant={tab === 'draft' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('draft')}
            className="gap-1.5 text-xs"
          >
            <Article className="size-3.5" />
            <span>{t('research.draft')}</span>
          </Button>
          <Button
            variant={tab === 'gdocs' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('gdocs')}
            className="gap-1.5 text-xs"
          >
            <FileText className="size-3.5" />
            <span>{t('research.gdocs')}</span>
          </Button>
          <Button
            variant={tab === 'latex' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('latex')}
            className="gap-1.5 text-xs"
          >
            <FileCode className="size-3.5" />
            <span>{t('research.latex')}</span>
          </Button>
          <Button
            variant={tab === 'zotero' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('zotero')}
            className="gap-1.5 text-xs"
          >
            <BookOpen className="size-3.5" />
            <span>{t('research.zotero')}</span>
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSettingsOpen(true)}
            title={t('research.settingsTitle')}
          >
            <Gear className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} title={t('research.closeSplitView')}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Tab 0: Document Draft (Artifact) */}
      {tab === 'draft' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Sub-bar: Title, Mode toggle, and Export button */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/50 p-2.5">
            <div className="flex flex-1 items-center gap-2 min-w-[200px]">
              <Input
                type="text"
                placeholder={t('research.draftTitlePlaceholder')}
                value={draftTitle}
                onChange={(e) => handleTitleChange(e.target.value)}
                className="h-8 flex-1 text-xs font-medium"
              />
            </div>

            <div className="flex items-center gap-1.5">
              {/* Mode Toggle: Edit vs Preview (Consistent Pill Icon Buttons) */}
              <div className="flex items-center rounded-[var(--radius-md)] border border-border bg-card/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setDraftViewMode('edit')}
                  className={cn(
                    'p-1.5 rounded-[var(--radius-sm)] transition-colors',
                    draftViewMode === 'edit'
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  title={t('research.modeEdit')}
                  aria-label={t('research.modeEdit')}
                >
                  <PencilSimple className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setDraftViewMode('preview')}
                  className={cn(
                    'p-1.5 rounded-[var(--radius-sm)] transition-colors',
                    draftViewMode === 'preview'
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  title={t('research.modePreview')}
                  aria-label={t('research.modePreview')}
                >
                  <Eye className="size-3.5" />
                </button>
              </div>

              {/* Action: Export to Google Docs (Icon-only with clear tooltip) */}
              <Button
                size="icon-sm"
                onClick={() => setExportModalOpen(true)}
                className="h-8 w-8 bg-emerald-600 text-white hover:bg-emerald-700 shrink-0"
                title={t('research.exportGdocs')}
                aria-label={t('research.exportGdocs')}
              >
                <CloudArrowUp className="size-4" />
              </Button>

              {/* Two-Way Sync Buttons (When linked to a Google Doc - Icon-only with tooltip) */}
              {docUrl ? (
                <div className="flex items-center gap-0.5 rounded-[var(--radius-md)] border border-border bg-card/60 p-0.5">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={handleSyncPush}
                    disabled={syncPushing}
                    className={cn(
                      'h-7 w-7 transition-colors',
                      syncPushSuccess ? 'text-emerald-500 font-semibold' : 'text-muted-foreground hover:text-foreground',
                    )}
                    title={syncPushing ? t('research.syncPushing') : t('research.syncPushTooltip')}
                    aria-label={t('research.syncPush')}
                  >
                    {syncPushing ? (
                      <Spinner className="size-3.5 animate-spin" />
                    ) : syncPushSuccess ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      <ArrowUp className="size-3.5" />
                    )}
                  </Button>

                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={handleSyncPull}
                    disabled={syncPulling}
                    className={cn(
                      'h-7 w-7 transition-colors',
                      syncPullSuccess ? 'text-emerald-500 font-semibold' : 'text-muted-foreground hover:text-foreground',
                    )}
                    title={syncPulling ? t('research.syncPulling') : t('research.syncPullTooltip')}
                    aria-label={t('research.syncPull')}
                  >
                    {syncPulling ? (
                      <Spinner className="size-3.5 animate-spin" />
                    ) : syncPullSuccess ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      <ArrowDown className="size-3.5" />
                    )}
                  </Button>
                </div>
              ) : null}

              {onInsertToChat ? (
                <Button
                  size="icon-sm"
                  variant="outline"
                  className="h-8 w-8 text-primary shrink-0"
                  onClick={() => {
                    onInsertToChat(
                      `Berikut adalah draf ${draftTitle}:\n\n\`\`\`markdown\n${draftContent}\n\`\`\`\n\nMohon bantu revisi/lengkapi naskah ini (tambahkan diagram/flowchart atau tabel jika relevan).`,
                    )
                  }}
                  title={t('research.askAgentWriteTitle')}
                  aria-label={t('research.askAgentWriteTitle')}
                >
                  <Article className="size-3.5" />
                </Button>
              ) : null}

              <Button
                size="icon-sm"
                variant={draftSearchOpen ? 'default' : 'outline'}
                className="h-8 w-8 shrink-0"
                onClick={() => setDraftSearchOpen(!draftSearchOpen)}
                title={t('research.searchDraftTitle')}
                aria-label={t('research.searchDraftTitle')}
              >
                <MagnifyingGlass className="size-3.5" />
              </Button>

              <Button
                size="icon-sm"
                variant="outline"
                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:border-destructive/40 shrink-0"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={!draftContent && !draftTitle}
                title={t('research.deleteDraftTooltip')}
                aria-label={t('research.deleteDraft')}
              >
                <TrashSimple className="size-3.5" />
              </Button>
            </div>
          </div>

          {/* Search Sub-Bar */}
          {draftSearchOpen ? (
            <div className="flex items-center gap-2 border-b border-border bg-card/60 px-3 py-1.5 text-xs">
              <MagnifyingGlass className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Cari kata di draf naskah..."
                value={draftSearchQuery}
                onChange={(e) => setDraftSearchQuery(e.target.value)}
                className="h-7 flex-1 text-xs"
                autoFocus
              />
              {draftSearchQuery ? (
                <span className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                  {(() => {
                    try {
                      const escaped = draftSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                      const matches = draftContent.match(new RegExp(escaped, 'gi'))
                      const count = matches ? matches.length : 0
                      return t('research.searchMatchesCount', { count: String(count) })
                    } catch {
                      return t('research.searchMatchesCount', { count: '0' })
                    }
                  })()}
                </span>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  setDraftSearchQuery('')
                  setDraftSearchOpen(false)
                }}
                className="size-7"
                title={t('research.searchCloseTitle')}
                aria-label={t('research.searchCloseTitle')}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : null}

          {/* Export Success Banner */}
          {exportedDocUrl ? (
            <div className="flex items-center justify-between border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-500">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle className="size-4 shrink-0" />
                <span>{t('research.exportedGdocsSuccess')}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    post('/research/open-browser', { url: exportedDocUrl }).catch(() => {
                      window.open(exportedDocUrl, '_blank')
                    })
                  }}
                  className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 cursor-pointer"
                >
                  <span>{t('research.openExportedDoc')}</span>
                  <ArrowSquareOut className="size-3" />
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] text-muted-foreground"
                  onClick={() => setTab('gdocs')}
                >
                  Lihat di Tab GDocs
                </Button>
              </div>
            </div>
          ) : null}

          {/* Export Error Banner */}
          {exportError ? (
            <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
              <WarningCircle className="size-4 shrink-0" />
              <span>{exportError}</span>
            </div>
          ) : null}

          {/* Main Content Area */}
          <div className="flex-1 overflow-auto bg-muted/20 p-4">
            {draftViewMode === 'edit' ? (
              <textarea
                value={draftContent}
                onChange={(e) => handleDraftChange(e.target.value)}
                className="size-full resize-none rounded-[var(--radius-md)] border border-border bg-background/80 p-4 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                spellCheck={false}
                placeholder="Tuliskan draf dokumen dalam format Markdown..."
              />
            ) : (
              <div className="mx-auto flex flex-col items-center gap-6 pb-12">
                {/* Visual A4 Page Sheets with Margins and Pagination (Memoized) */}
                {a4Pages.map((pageText, pIdx) => (
                  <div
                    key={pIdx}
                    style={{ width: '794px', minHeight: '1123px' }}
                    className="relative flex flex-col justify-between rounded-sm bg-white px-12 pt-12 pb-10 text-[#111827] shadow-xl ring-1 ring-black/10 font-serif text-[12pt] leading-[1.15] text-justify"
                  >
                    {/* Page Body Content */}
                    <div className="flex-1">
                      <AcademicDraft content={pageText} />
                    </div>

                    {/* Official Academic Page Footer (Nomor Halaman Rata Tengah Bawah) */}
                    <div className="mt-8 border-t border-gray-200/60 pt-3 text-center font-serif text-[10pt] text-gray-500 select-none">
                      — {pIdx + 1} —
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 1: Google Docs Preview */}
      {tab === 'gdocs' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border bg-background/50 p-3">
            <div className="relative flex flex-1 items-center">
              <Input
                type="text"
                placeholder={t('research.docPlaceholder')}
                value={docUrl}
                onChange={(e) => {
                  setDocUrl(e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleLoadDoc()
                  }
                }}
                className="h-8 flex-1 pr-7 text-xs"
              />
              {docUrl ? (
                <button
                  type="button"
                  onClick={handleClearDoc}
                  className="absolute right-2 p-0.5 text-muted-foreground hover:text-foreground"
                  title={t('research.clearDocUrlTitle')}
                  aria-label={t('research.clearDocUrlTitle')}
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleLoadDoc()}
              disabled={!docUrl}
              className="h-8 text-xs"
            >
              {t('research.loadDoc')}
            </Button>
            {docUrl ? (
              <>
                {/* Mode Toggle: Edit vs Preview (Identical Consistent Pill Icon Style) */}
                <div className="flex items-center rounded-[var(--radius-md)] border border-border bg-card/60 p-0.5">
                  <button
                    type="button"
                    onClick={() => setDocViewMode('edit')}
                    className={cn(
                      'p-1.5 rounded-[var(--radius-sm)] transition-colors',
                      docViewMode === 'edit'
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    title={t('research.modeEdit')}
                    aria-label={t('research.modeEdit')}
                  >
                    <PencilSimple className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocViewMode('preview')}
                    className={cn(
                      'p-1.5 rounded-[var(--radius-sm)] transition-colors',
                      docViewMode === 'preview'
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    title={t('research.modePreview')}
                    aria-label={t('research.modePreview')}
                  >
                    <Eye className="size-3.5" />
                  </button>
                </div>
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() => setFrameKey((k) => k + 1)}
                  className="h-8 w-8 shrink-0"
                  title={t('research.reloadPreviewTitle')}
                  aria-label={t('research.reloadPreviewTitle')}
                >
                  <ArrowsClockwise className="size-4" />
                </Button>
                {googleConnected ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRollback}
                    disabled={rollingBack}
                    className={cn(
                      'h-8 gap-1 px-2 text-xs transition-colors',
                      rollbackSuccess ? 'border-emerald-500 text-emerald-500' : 'text-muted-foreground hover:text-foreground',
                    )}
                    title={t('research.undoRollbackTitle')}
                    aria-label={t('research.undoRollbackTitle')}
                  >
                    {rollingBack ? (
                      <Spinner className="size-3.5 animate-spin" />
                    ) : rollbackSuccess ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      <ArrowCounterClockwise className="size-3.5" />
                    )}
                    <span className="hidden sm:inline">
                      {rollbackSuccess ? 'Berhasil Undo' : 'Undo'}
                    </span>
                  </Button>
                ) : null}
                {isSafeGoogleDocUrl(docUrl) ? (
                  <a
                    href={getCleanDocUrl(docUrl)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex size-8 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card text-muted-foreground hover:text-foreground"
                    title={t('research.openDoc')}
                  >
                    <ArrowSquareOut className="size-4" />
                  </a>
                ) : null}
              </>
            ) : null}
          </div>

          {/* Sub-bar: OAuth Agent indicator & Iframe browser session notice */}
          <div className="flex items-center justify-between border-b border-border bg-card/40 px-3 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              {googleConnected ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500"
                  title={t('research.agentConnectedBadge')}
                >
                  <CheckCircle className="size-3.5 shrink-0" />
                  <span>{t('research.agentConnectedBadge')}</span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSettingsTab('gdocs')
                    setSettingsOpen(true)
                  }}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500 hover:bg-amber-500/20"
                  title={t('research.agentNotConnectedBadge')}
                >
                  <WarningCircle className="size-3.5 shrink-0" />
                  <span>{t('research.agentNotConnectedBadge')}</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 text-muted-foreground">
              <div
                className="flex cursor-help items-center gap-1 text-[11px] hover:text-foreground"
                title={t('research.iframeLoginNotice')}
              >
                <Info className="size-3.5 shrink-0" />
                <span className="hidden sm:inline text-[10px]">{t('research.docTipTitle')}</span>
              </div>
              {docUrl && isSafeGoogleDocUrl(docUrl) ? (
                <button
                  type="button"
                  onClick={() => {
                    const u = getCleanDocUrl(docUrl)
                    if (u) {
                      post('/research/open-browser', { url: u }).catch(() => {
                        window.open(u, '_blank')
                      })
                    }
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <span>{t('research.openDoc')}</span>
                  <ArrowSquareOut className="size-3" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="relative flex-1 bg-background/30">
            {docUrl && previewActive && getEmbedUrl(docUrl, frameKey, docViewMode) ? (
              <iframe
                key={`${frameKey}-${docViewMode}`}
                src={getEmbedUrl(docUrl, frameKey, docViewMode)}
                title="Google Docs Canvas"
                className="size-full border-0 bg-white"
                allow="clipboard-read; clipboard-write; autoplay; fullscreen"
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center p-6 text-center text-muted-foreground">
                <FileText className="mb-2 size-10 opacity-30" />
                <p className="text-sm font-medium">{t('research.splitView')}</p>
                <p className="mt-1 max-w-xs text-xs text-dim">
                  {t('research.docHint')}
                </p>
                <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-md)] border border-border bg-card/60 p-3 text-left text-xs">
                  <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="font-semibold text-foreground">{t('research.docTipTitle')}</p>
                    <p className="mt-1 text-dim">
                      {t('research.docTipDesc')}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: LaTeX & BibTeX Academic Editor */}
      {tab === 'latex' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Sub-bar: File selector & Template switcher & Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/50 p-2.5">
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant={latexFile === 'main' ? 'default' : 'outline'}
                className="h-7 gap-1 text-[11px]"
                onClick={() => setLatexFile('main')}
              >
                <FileCode className="size-3.5" />
                <span>{t('research.latexMainTex')}</span>
              </Button>
              <Button
                size="sm"
                variant={latexFile === 'bib' ? 'default' : 'outline'}
                className="h-7 gap-1 text-[11px]"
                onClick={() => setLatexFile('bib')}
              >
                <BookOpen className="size-3.5" />
                <span>{t('research.latexRefBib')}</span>
              </Button>
            </div>

            <div className="flex items-center gap-1.5">
              {/* Toggle Editor vs Live Academic Preview */}
              <div className="flex items-center rounded-[var(--radius-md)] border border-border bg-card/60 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setLatexViewMode('editor')}
                  className={cn(
                    'px-2 py-0.5 rounded-[var(--radius-sm)] transition-colors',
                    latexViewMode === 'editor'
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('research.modeEdit')}
                </button>
                <button
                  type="button"
                  onClick={() => setLatexViewMode('preview')}
                  className={cn(
                    'px-2 py-0.5 rounded-[var(--radius-sm)] transition-colors',
                    latexViewMode === 'preview'
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('research.modePreview')}
                </button>
              </div>

              {latexViewMode === 'editor' && latexFile === 'main' ? (
                <div className="flex items-center rounded-[var(--radius-md)] border border-border bg-card/60 p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => handleApplyTemplate('ieee')}
                    className={cn(
                      'px-2 py-0.5 rounded-[var(--radius-sm)] transition-colors',
                      latexTemplate === 'ieee' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    IEEE
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyTemplate('standard')}
                    className={cn(
                      'px-2 py-0.5 rounded-[var(--radius-sm)] transition-colors',
                      latexTemplate === 'standard' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Article
                  </button>
                </div>
              ) : null}

              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[11px]"
                onClick={handleCopyLatex}
                title={t('research.latexCopyOverleaf')}
              >
                {latexCopied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                <span>{latexCopied ? t('research.latexCopied') : t('research.latexCopyOverleaf')}</span>
              </Button>

              {onInsertToChat ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px] text-primary"
                  onClick={() => {
                    const code = latexFile === 'main' ? latexMainCode : latexBibCode
                    const filename = latexFile === 'main' ? 'paper.tex' : 'references.bib'
                    onInsertToChat(
                      `Berikut adalah file ${filename} saya:\n\n\`\`\`latex\n${code}\n\`\`\`\n\nMohon bantu lengkapi / perbaiki naskah ini sesuai kaidah jurnal ilmiah.`,
                    )
                  }}
                  title={t('research.latexInsertChat')}
                >
                  <PencilSimple className="size-3" />
                  <span>{t('research.latexInsertChat')}</span>
                </Button>
              ) : null}

              <a
                href="https://www.overleaf.com/project"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-7 items-center justify-center gap-1 rounded-[var(--radius-md)] border border-border bg-card px-2 text-[11px] text-muted-foreground hover:text-foreground"
                title="Open Overleaf"
              >
                <span>Overleaf</span>
                <ArrowSquareOut className="size-3" />
              </a>
            </div>
          </div>

          {/* Main Content: Live Academic Preview OR Editor */}
          {latexViewMode === 'preview' ? (
            <LatexPreview
              texContent={latexMainCode}
              bibContent={latexBibCode}
              className="flex-1 overflow-hidden"
            />
          ) : (
            <>
              {/* Snippet Toolbar (Quick Insert for Journal Items) */}
              {latexFile === 'main' ? (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-card/40 px-3 py-1.5 text-[11px]">
                  <span className="text-[10px] font-medium text-muted-foreground">Sisipkan:</span>
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertSnippet(
                        `% --- PLACEHOLDER GAMBAR (CAPTION DI BAWAH) ---\n\\begin{figure}[htbp]\n  \\centering\n  % \\includegraphics[width=0.85\\linewidth]{figures/flowchart.png}\n  \\fbox{\\rule{0pt}{2in} \\rule{0.85\\linewidth}{0pt}} % Kotak placeholder ilustrasi\n  \\caption{Gambar 2.1: Flowchart Metodologi Penelitian}\n  \\label{fig:flowchart}\n\\end{figure}`,
                      )
                    }
                    className="rounded-[var(--radius-sm)] border border-border bg-card px-2 py-0.5 hover:bg-accent hover:text-accent-foreground"
                  >
                    {t('research.latexInsertFigure')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertSnippet(
                        `% --- TABEL FORMAL AKADEMIK (CAPTION DI ATAS) ---\n\\begin{table}[htbp]\n  \\caption{Tabel 2.1: Hasil Evaluasi Akurasi dan Metrik Model}\n  \\label{tab:hasil}\n  \\centering\n  \\begin{tabular}{|l|c|c|c|}\n    \\hline\n    \\textbf{Metode} & \\textbf{Presisi (\\%)} & \\textbf{Recall (\\%)} & \\textbf{F1-Score} \\\\\n    \\hline\n    Baseline & 84.5 & 82.1 & 0.832 \\\\\n    Usulan Sistem & \\textbf{95.2} & \\textbf{94.8} & \\textbf{0.950} \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}`,
                      )
                    }
                    className="rounded-[var(--radius-sm)] border border-border bg-card px-2 py-0.5 hover:bg-accent hover:text-accent-foreground"
                  >
                    {t('research.latexInsertTable')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertSnippet(
                        `% --- PERSAMAAN MATEMATIKA BERSIFAT NUMBERED ---\n\\begin{equation}\n  f(x) = \\sum_{i=1}^{n} w_i \\cdot x_i + b\n  \\label{eq:rumus}\n\\end{equation}`,
                      )
                    }
                    className="rounded-[var(--radius-sm)] border border-border bg-card px-2 py-0.5 hover:bg-accent hover:text-accent-foreground"
                  >
                    {t('research.latexInsertEquation')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInsertSnippet(`\\cite{setiawan2024}`)}
                    className="rounded-[var(--radius-sm)] border border-border bg-card px-2 py-0.5 hover:bg-accent hover:text-accent-foreground"
                  >
                    {t('research.latexInsertCitation')}
                  </button>
                </div>
              ) : null}

              {/* Code Textarea Editor */}
              <div className="relative flex-1 p-2">
                <textarea
                  value={latexFile === 'main' ? latexMainCode : latexBibCode}
                  onChange={(e) => handleLatexChange(e.target.value)}
                  className="size-full resize-none rounded-[var(--radius-md)] border border-border bg-background/80 p-3 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  spellCheck={false}
                  placeholder={
                    latexFile === 'main'
                      ? 'Masukkan kode LaTeX (\\documentclass{...})...'
                      : 'Masukkan entri BibTeX (@article{...})...'
                  }
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Tab 3: Zotero Collections & Library */}
      {tab === 'zotero' && (
        <div className="flex flex-1 flex-col overflow-y-auto p-4">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Folders className="size-4 text-[var(--accent)]" />
              <span className="text-sm font-semibold">{t('research.zotero')}</span>
            </div>
            {zoteroApiKey ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
                <CheckCircle className="size-3" /> {t('research.zoteroConnected')}
              </span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 text-[11px]"
                onClick={() => {
                  setSettingsTab('zotero')
                  setSettingsOpen(true)
                }}
              >
                <Key className="size-3" /> {t('research.zoteroSetup')}
              </Button>
            )}
          </div>

          <div className="mb-3 flex gap-2">
            <Input
              type="text"
              placeholder={t('research.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 flex-1 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={() => {
                if (searchQuery && onInsertToChat) {
                  onInsertToChat(`Search for papers about "${searchQuery}" in my Zotero library`)
                }
              }}
            >
              <MagnifyingGlass className="size-3.5" />
              {t('research.search')}
            </Button>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <p className="font-medium text-muted-foreground">{t('research.detectedCollections')}</p>
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 text-[11px]"
                onClick={() => {
                  if (onInsertToChat) {
                    onInsertToChat('Please list all collections in my Zotero library')
                  }
                }}
              >
                <Folders className="size-3" />
                <span>{t('research.zotero')}</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gear className="size-5" />
              <span>{t('research.settingsTitle')}</span>
            </DialogTitle>
            <DialogDescription>
              {t('research.settingsDesc')}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {/* Nav Tabs */}
            <div className="flex border-b border-border">
              <button
                type="button"
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition ${
                  settingsTab === 'zotero'
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setSettingsTab('zotero')}
              >
                <BookOpen className="size-3.5" />
                <span>{t('research.tabZotero')}</span>
              </button>
              <button
                type="button"
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition ${
                  settingsTab === 'gdocs'
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setSettingsTab('gdocs')}
              >
                <FileText className="size-3.5" />
                <span>{t('research.tabGdocs')}</span>
              </button>
            </div>

            {/* Zotero Tab Content */}
            {settingsTab === 'zotero' && (
              <div className="space-y-3 pt-1">
                <div className="space-y-1">
                  <Label className="text-xs">{t('research.zoteroUserId')}</Label>
                  <Input
                    type="text"
                    placeholder="e.g. 15851659"
                    value={zoteroUserId}
                    onChange={(e) => setZoteroUserId(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('research.zoteroApiKey')}</Label>
                  <Input
                    type="password"
                    placeholder="Enter Zotero API Key"
                    value={zoteroApiKey}
                    onChange={(e) => setZoteroApiKey(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">{t('research.zoteroGuideTitle')}</p>
                    <p>{t('research.zoteroGuideDesc')}</p>
                    <a
                      href="https://www.zotero.org/settings/keys/new"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-muted-foreground hover:decoration-foreground"
                    >
                      <span>{t('research.zoteroGuideLink')}</span>
                      <ArrowSquareOut className="size-3" />
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* Google Docs Tab Content */}
            {settingsTab === 'gdocs' && (
              <div className="space-y-3 pt-1">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={gdocsMethod === 'webhook' ? 'default' : 'outline'}
                    onClick={() => setGdocsMethod('webhook')}
                    className="h-7 flex-1 text-xs"
                  >
                    {t('research.gdocsMethodWebhook')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={gdocsMethod === 'oauth' ? 'default' : 'outline'}
                    onClick={() => setGdocsMethod('oauth')}
                    className="h-7 flex-1 text-xs"
                  >
                    {t('research.gdocsMethodOauth')}
                  </Button>
                </div>

                {/* Conditional Fields: Webhook vs OAuth */}
                {gdocsMethod === 'webhook' ? (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('research.webhookUrl')}</Label>
                      <Input
                        type="text"
                        placeholder="https://script.google.com/macros/s/.../exec"
                        value={gdocsWebhookUrl}
                        onChange={(e) => setGdocsWebhookUrl(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="rounded-[var(--radius-md)] border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between pb-1">
                        <span className="font-semibold text-foreground">{t('research.scriptCodeTitle')}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleCopyScript}
                          className="h-6 gap-1 text-[11px]"
                        >
                          {codeCopied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                          <span>{codeCopied ? t('research.copied') : t('research.copyCode')}</span>
                        </Button>
                      </div>
                      <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed">
                        {t('research.scriptSteps')}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setOauthGuideOpen(true)}
                      className="w-full gap-1.5 border-dashed text-xs text-foreground"
                    >
                      <BookOpen className="size-3.5 text-muted-foreground" />
                      <span>{t('research.openOauthGuide')}</span>
                    </Button>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('research.oauthClientId')}</Label>
                      <Input
                        type="text"
                        placeholder="xxxxx.apps.googleusercontent.com"
                        value={gdocsClientId}
                        onChange={(e) => setGdocsClientId(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('research.oauthClientSecret')}</Label>
                      <Input
                        type="password"
                        placeholder="GOCSPX-xxxxxx"
                        value={gdocsClientSecret}
                        onChange={(e) => setGdocsClientSecret(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>

                    {googleConnected ? (
                      <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-xs text-emerald-500">
                        <div className="flex items-center gap-1.5 font-medium">
                          <CheckCircle className="size-4 shrink-0" />
                          <span>{t('research.gdocsConnectedOauth')}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[11px] text-muted-foreground hover:text-destructive"
                          onClick={async () => {
                            await post('/auth/google/disconnect', {})
                            setGoogleConnected(false)
                          }}
                        >
                          {t('research.disconnectGoogle')}
                        </Button>
                      </div>
                    ) : connectingGoogle ? (
                      <div className="space-y-2.5 rounded-[var(--radius-md)] border border-blue-500/20 bg-blue-500/10 p-3 text-xs">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 font-medium text-blue-400">
                            <Spinner className="size-4 animate-spin shrink-0 text-blue-400" />
                            <span>{t('research.authorizingGoogle')}</span>
                          </div>
                          <span className="text-[11px] text-muted-foreground">{t('research.checkPopupWindow')}</span>
                        </div>
                        {authUrl ? (
                          <div className="space-y-2 border-t border-blue-500/20 pt-2">
                            <p className="text-[11px] text-muted-foreground leading-relaxed">
                              Jika jendela login tidak terbuka otomatis di aplikasi desktop, buka melalui browser sistem:
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <a
                                href={authUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] bg-primary px-3 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
                              >
                                <span>Buka di Browser Eksternal</span>
                                <ArrowSquareOut className="size-3" />
                              </a>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1 text-[11px]"
                                onClick={async () => {
                                  await copyText(authUrl)
                                  setAuthUrlCopied(true)
                                  setTimeout(() => setAuthUrlCopied(false), 2000)
                                }}
                              >
                                {authUrlCopied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                                <span>{authUrlCopied ? t('research.copied') : 'Salin Link Login'}</span>
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={!gdocsClientId || !gdocsClientSecret || connectingGoogle}
                          className="w-full gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                          onClick={async () => {
                            setConnectingGoogle(true)
                            try {
                              await handleSaveSettings(false)
                              const callbackUri = `${window.location.origin}/api/auth/google/callback`
                              const res = await get<{ url: string }>(`/auth/google/url?redirect_uri=${encodeURIComponent(callbackUri)}`)
                              if (res.url) {
                                setAuthUrl(res.url)
                                post('/research/open-browser', { url: res.url }).catch(() => {})
                                try {
                                  window.open(res.url, 'google_oauth', 'width=600,height=700')
                                } catch {}
                                const timer = setInterval(async () => {
                                  try {
                                    const statusRes = await get<{ connected: boolean }>('/auth/google/status')
                                    if (statusRes.connected) {
                                      clearInterval(timer)
                                      setGoogleConnected(true)
                                      setConnectingGoogle(false)
                                    }
                                  } catch {}
                                }, 1500)
                              } else {
                                setConnectingGoogle(false)
                              }
                            } catch {
                              setConnectingGoogle(false)
                            }
                          }}
                        >
                          <Key className="size-3.5" />
                          <span>{t('research.connectGoogle')}</span>
                        </Button>
                        {authUrl && connectingGoogle ? (
                          <div className="rounded border border-amber-500/20 bg-amber-500/5 p-2 text-center text-xs">
                            <p className="mb-1.5 text-muted-foreground text-[11px]">
                              {t('research.oauthBrowserWaiting')}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 w-full gap-1 text-[11px]"
                              onClick={() => {
                                post('/research/open-browser', { url: authUrl }).catch(() => {})
                                try {
                                  window.open(authUrl, '_blank')
                                } catch {}
                              }}
                            >
                              <ArrowSquareOut className="size-3" />
                              <span>{t('research.openInBrowser')}</span>
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </DialogBody>

          <DialogFooter className="flex items-center justify-between">
            <span className="text-xs text-emerald-500">
              {saveSuccess ? t('research.saved') : ''}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setSettingsOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => handleSaveSettings(true)}
                loading={savingSettings}
                className="gap-1.5"
              >
                <FloppyDisk className="size-3.5" />
                <span>{t('common.save')}</span>
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Google OAuth Setup Guide Modal */}
      <Dialog open={oauthGuideOpen} onOpenChange={setOauthGuideOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="size-5" />
              <span>{t('research.oauthGuideTitle')}</span>
            </DialogTitle>
            <DialogDescription>{t('research.oauthGuideDesc')}</DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-3 text-xs">
            <div className="space-y-1 rounded-[var(--radius-md)] border border-border bg-card p-3">
              <p className="font-semibold text-foreground">{t('research.oauthStep1Title')}</p>
              <p className="text-muted-foreground">{t('research.oauthStep1Desc')}</p>
            </div>

            <div className="space-y-1 rounded-[var(--radius-md)] border border-border bg-card p-3">
              <p className="font-semibold text-foreground">{t('research.oauthStep2Title')}</p>
              <p className="text-muted-foreground">{t('research.oauthStep2Desc')}</p>
            </div>

            <div className="space-y-1 rounded-[var(--radius-md)] border border-border bg-card p-3">
              <p className="font-semibold text-foreground">{t('research.oauthStep3Title')}</p>
              <p className="text-muted-foreground">{t('research.oauthStep3Desc')}</p>
            </div>

            <div className="space-y-2 rounded-[var(--radius-md)] border border-border bg-card p-3">
              <p className="font-semibold text-foreground">{t('research.oauthStep4Title')}</p>
              <p className="text-muted-foreground leading-relaxed">{t('research.oauthStep4Desc')}</p>
              <div className="space-y-1.5 pt-1">
                {[
                  'http://localhost:8787/api/auth/google/callback',
                  'http://127.0.0.1:8787/api/auth/google/callback',
                  'http://localhost:5174/api/auth/google/callback',
                ].map((uri) => (
                  <div
                    key={uri}
                    className="flex items-center justify-between rounded-[var(--radius-sm)] border border-border bg-background p-1.5 font-mono text-[11px]"
                  >
                    <span className="truncate">{uri}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 gap-1 text-[10px]"
                      onClick={async () => {
                        await copyText(uri)
                        setCopiedUri(uri)
                        setTimeout(() => setCopiedUri(null), 2000)
                      }}
                    >
                      {copiedUri === uri ? (
                        <Check className="size-3 text-emerald-500" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                      <span>{copiedUri === uri ? t('research.copied') : 'Salin'}</span>
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1 rounded-[var(--radius-md)] border border-border bg-card p-3">
              <p className="font-semibold text-foreground">{t('research.oauthStep5Title')}</p>
              <p className="text-muted-foreground">{t('research.oauthStep5Desc')}</p>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button size="sm" onClick={() => setOauthGuideOpen(false)}>
              {t('research.closeGuide')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Export to Word / Google Docs Modal */}
      <Dialog open={exportModalOpen} onOpenChange={setExportModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CloudArrowUp className="size-5 text-emerald-500" />
              <span>{t('research.exportModalTitle')}</span>
            </DialogTitle>
            <DialogDescription>{t('research.exportModalDesc')}</DialogDescription>
          </DialogHeader>

          {/* Modal Tab Selector */}
          <div className="flex rounded-[var(--radius-md)] border border-border bg-card/60 p-1">
            <button
              type="button"
              onClick={() => setExportModalTab('docx')}
              className={cn(
                'flex-1 rounded-[var(--radius-sm)] py-1.5 text-xs font-medium transition-colors text-center',
                exportModalTab === 'docx'
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              📄 {t('research.tabDocxDownload')}
            </button>
            <button
              type="button"
              onClick={() => setExportModalTab('oauth')}
              className={cn(
                'flex-1 rounded-[var(--radius-sm)] py-1.5 text-xs font-medium transition-colors text-center',
                exportModalTab === 'oauth'
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              ☁️ {t('research.tabAutoSync')}
            </button>
          </div>

          <DialogBody className="space-y-3.5 text-xs">
            {exportModalTab === 'docx' ? (
              <div className="space-y-3">
                {/* Document Title Input */}
                <div className="space-y-1.5 rounded-[var(--radius-md)] border border-border bg-card p-3">
                  <label className="font-semibold text-foreground text-xs">
                    {t('research.step2Title')}
                  </label>
                  <Input
                    type="text"
                    placeholder={t('research.draftTitlePlaceholder')}
                    value={draftTitle}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    className="h-8 text-xs font-medium"
                  />
                  <p className="text-[11px] text-muted-foreground pt-1">
                    {t('research.tabDocxDesc')}
                  </p>
                </div>

                {/* Primary Download Button */}
                <Button
                  type="button"
                  size="default"
                  disabled={downloadingDocx}
                  loading={downloadingDocx}
                  onClick={handleDownloadDocx}
                  className="w-full gap-2 bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 h-9"
                >
                  <DownloadSimple className="size-4" />
                  <span>{downloadingDocx ? t('research.downloadingDocx') : t('research.downloadDocxBtn')}</span>
                </Button>

                {/* 3-Step Google Docs Guide */}
                <div className="space-y-2 rounded-[var(--radius-md)] border border-emerald-500/20 bg-emerald-500/5 p-3 text-foreground">
                  <p className="font-semibold text-emerald-600 dark:text-emerald-400">
                    {t('research.docxHelpTitle')}
                  </p>
                  <div className="space-y-1 text-[11.5px] text-muted-foreground leading-relaxed">
                    <p>{t('research.docxStep1')}</p>
                    <p>{t('research.docxStep2')}</p>
                    <p>{t('research.docxStep3')}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Step 1: Google Account Checklist */}
                <div className="space-y-2 rounded-[var(--radius-md)] border border-border bg-card p-3">
                  <p className="font-semibold text-foreground">{t('research.step1Title')}</p>
                  {googleConnected ? (
                    <div className="flex items-center gap-2 font-medium text-emerald-500">
                      <CheckCircle className="size-4 shrink-0" />
                      <span>Akun Google Terhubung (OAuth)</span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 font-medium text-amber-500">
                        <WarningCircle className="size-4 shrink-0" />
                        <span>Akun Google Belum Terhubung</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Diperlukan koneksi Google Drive untuk membuat file dokumen secara otomatis.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 gap-1.5 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700"
                        onClick={() => {
                          setExportModalOpen(false)
                          setSettingsTab('gdocs')
                          setSettingsOpen(true)
                        }}
                      >
                        <Key className="size-3.5" />
                        <span>Hubungkan Akun Google di Pengaturan</span>
                      </Button>
                    </div>
                  )}
                </div>

                {/* Step 2: Document Title */}
                <div className="space-y-2 rounded-[var(--radius-md)] border border-border bg-card p-3">
                  <p className="font-semibold text-foreground">{t('research.step2Title')}</p>
                  <Input
                    type="text"
                    placeholder={t('research.draftTitlePlaceholder')}
                    value={draftTitle}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    className="h-8 text-xs font-medium"
                  />
                </div>

                {/* Step 3: Sharing Access & Permissions */}
                <div className="space-y-2 rounded-[var(--radius-md)] border border-border bg-card p-3">
                  <p className="font-semibold text-foreground">{t('research.step3Title')}</p>
                  <div className="flex items-start justify-between gap-3 pt-1">
                    <div className="space-y-1">
                      <label htmlFor="auto-share" className="font-medium text-foreground cursor-pointer text-xs">
                        {t('research.autoShareOption')}
                      </label>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {t('research.autoShareHint')}
                      </p>
                    </div>
                    <Switch
                      id="auto-share"
                      checked={autoShareWithLink}
                      onCheckedChange={setAutoShareWithLink}
                      className="shrink-0"
                    />
                  </div>
                </div>

                <Button
                  size="default"
                  disabled={!googleConnected || exportingGdocs}
                  loading={exportingGdocs}
                  onClick={handleExportToGoogleDocs}
                  className="w-full gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 h-9"
                >
                  <CloudArrowUp className="size-4" />
                  <span>{exportingGdocs ? t('research.exportingGdocs') : t('research.confirmExport')}</span>
                </Button>
              </div>
            )}
          </DialogBody>

          <DialogFooter className="flex items-center justify-end">
            <Button variant="outline" size="sm" onClick={() => setExportModalOpen(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Delete Draft Dialog */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={t('research.deleteDraftConfirmTitle')}
        description={t('research.deleteDraftConfirmDesc')}
        confirmLabel={t('research.deleteDraftConfirmBtn')}
        destructive={true}
        loading={deletingDraft}
        onConfirm={handleDeleteDraft}
      />
    </div>
  )
})
