import { memo, useEffect, useMemo, useState } from 'react'
import {
  ArrowSquareOut,
  Check,
  Copy,
  DownloadSimple,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FilePdf,
  FileText,
  FileVideo,
  MagnifyingGlass,
  Spinner,
  Table,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { authedUrl, downloadFile, get } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { formatBytes } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { Markdown } from '@/components/chat/Markdown'

export interface SelectedFile {
  name: string
  path: string
  is_dir: boolean
  size?: number
}

type FileKind =
  | 'markdown'
  | 'pdf'
  | 'sheet'
  | 'code'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'binary'

const EXT_MAP: Record<string, FileKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  pdf: 'pdf',
  csv: 'sheet',
  tsv: 'sheet',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  rar: 'archive',
  '7z': 'archive',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  go: 'code',
  py: 'code',
  rs: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',
  json: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  sql: 'code',
  sh: 'code',
  bash: 'code',
  txt: 'text',
  log: 'text',
  ini: 'text',
  conf: 'text',
  env: 'text',
}

export function detectFileKind(fileName: string): FileKind {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MAP[ext] ?? 'binary'
}

export function getFileIcon(kind: FileKind, className = 'size-4') {
  switch (kind) {
    case 'markdown':
      return <FileText className={cn(className, 'text-emerald-500')} />
    case 'pdf':
      return <FilePdf className={cn(className, 'text-rose-500')} />
    case 'sheet':
      return <Table className={cn(className, 'text-emerald-600')} />
    case 'code':
      return <FileCode className={cn(className, 'text-blue-500')} />
    case 'text':
      return <FileText className={cn(className, 'text-muted-foreground')} />
    case 'image':
      return <FileImage className={cn(className, 'text-amber-500')} />
    case 'video':
      return <FileVideo className={cn(className, 'text-purple-500')} />
    case 'audio':
      return <FileAudio className={cn(className, 'text-indigo-500')} />
    case 'archive':
      return <FileArchive className={cn(className, 'text-yellow-600')} />
    default:
      return <FileIcon className={cn(className, 'text-muted-foreground')} />
  }
}

// Simple CSV/TSV parser supporting quotes
function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentCell = ''
  let insideQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const nextChar = text[i + 1]

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentCell += '"'
        i++
      } else {
        insideQuotes = !insideQuotes
      }
    } else if (char === delimiter && !insideQuotes) {
      currentRow.push(currentCell.trim())
      currentCell = ''
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++
      }
      currentRow.push(currentCell.trim())
      if (currentRow.some((c) => c !== '')) {
        rows.push(currentRow)
      }
      currentRow = []
      currentCell = ''
    } else {
      currentCell += char
    }
  }

  if (currentCell !== '' || currentRow.length > 0) {
    currentRow.push(currentCell.trim())
    if (currentRow.some((c) => c !== '')) {
      rows.push(currentRow)
    }
  }

  return rows
}

interface FileViewerPanelProps {
  file: SelectedFile
  baseDir?: string
  onClose: () => void
}

export const FileViewerPanel = memo(function FileViewerPanel({
  file,
  baseDir,
  onClose,
}: FileViewerPanelProps) {
  const kind = useMemo(() => detectFileKind(file.name), [file.name])
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [fileSize, setFileSize] = useState<number | undefined>(file.size)

  // Markdown view mode: rendered vs raw
  const [mdViewMode, setMdViewMode] = useState<'rendered' | 'raw'>('rendered')
  const [copied, setCopied] = useState(false)
  const [sheetFilter, setSheetFilter] = useState('')

  // Construct raw and read URLs
  const dirParam = baseDir ? `&dir=${encodeURIComponent(baseDir)}` : ''
  const rawUrl = authedUrl(`/files/raw?path=${encodeURIComponent(file.path)}${dirParam}`)

  // Fetch text content for markdown, sheet, code, text
  useEffect(() => {
    setContent(null)
    setError(null)
    setIsBinary(false)
    setSheetFilter('')
    setMdViewMode('rendered')

    // Media and PDF can render directly via rawUrl without fetching text JSON
    if (kind === 'pdf' || kind === 'image' || kind === 'video' || kind === 'audio') {
      return
    }

    setLoading(true)
    get<{ content?: string; binary?: boolean; size?: number }>(
      `/files/read?path=${encodeURIComponent(file.path)}${dirParam}`,
    )
      .then((res) => {
        if (res.size !== undefined) setFileSize(res.size)
        if (res.binary) {
          setIsBinary(true)
        } else {
          setContent(res.content ?? '')
        }
      })
      .catch((err) => {
        setError(err?.message || 'Gagal membaca isi file')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [file.path, baseDir, kind, dirParam])

  const handleCopy = async () => {
    if (content) {
      const ok = await copyText(content)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }
  }

  const handleDownload = () => {
    void downloadFile(`/files/raw?path=${encodeURIComponent(file.path)}${dirParam}&download=1`, file.name)
  }

  // Parse sheet rows for CSV/TSV
  const sheetData = useMemo(() => {
    if (kind !== 'sheet' || !content) return null
    const delimiter = file.name.endsWith('.tsv') ? '\t' : ','
    const parsed = parseDelimitedText(content, delimiter)
    if (!parsed.length) return null
    const header = parsed[0]
    const rows = parsed.slice(1)
    return { header, rows }
  }, [kind, content, file.name])

  const filteredSheetRows = useMemo(() => {
    if (!sheetData) return []
    const q = sheetFilter.trim().toLowerCase()
    if (!q) return sheetData.rows
    return sheetData.rows.filter((row) =>
      row.some((cell) => cell.toLowerCase().includes(q)),
    )
  }, [sheetData, sheetFilter])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-card">
      {/* Top Header Toolbar */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-background/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {getFileIcon(kind, 'size-4 shrink-0')}
          <span className="truncate font-mono text-xs font-semibold text-foreground" title={file.name}>
            {file.name}
          </span>
          {fileSize !== undefined ? (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              ({formatBytes(fileSize)})
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Markdown view mode pill */}
          {kind === 'markdown' && content && !isBinary ? (
            <div className="flex items-center rounded-[var(--radius-md)] border border-border bg-card/60 p-0.5">
              <button
                type="button"
                onClick={() => setMdViewMode('rendered')}
                className={cn(
                  'rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium transition-colors',
                  mdViewMode === 'rendered'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                title="Tampilan Terformat (Rendered)"
              >
                Render
              </button>
              <button
                type="button"
                onClick={() => setMdViewMode('raw')}
                className={cn(
                  'rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium transition-colors',
                  mdViewMode === 'raw'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                title="Tampilan Sumber Asli (Raw Markdown)"
              >
                Raw
              </button>
            </div>
          ) : null}

          {/* Copy content button */}
          {content && !isBinary ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="h-7 w-7"
              onClick={handleCopy}
              title={copied ? 'Tersalin!' : 'Salin isi file'}
            >
              {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
            </Button>
          ) : null}

          {/* Download button */}
          <Button
            size="icon-sm"
            variant="outline"
            className="h-7 w-7"
            onClick={handleDownload}
            title="Unduh File"
            aria-label="Unduh File"
          >
            <DownloadSimple className="size-3.5" />
          </Button>

          {/* Open Raw in New Tab */}
          <Button
            size="icon-sm"
            variant="outline"
            className="h-7 w-7"
            onClick={() => window.open(rawUrl, '_blank')}
            title="Buka File di Tab Baru"
            aria-label="Buka di Tab Baru"
          >
            <ArrowSquareOut className="size-3.5" />
          </Button>

          {/* Close File Viewer button */}
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            title="Tutup Tampilan File"
            aria-label="Tutup"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Main Content Pane */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-5 animate-spin text-primary" />
            <span>Memuat file...</span>
          </div>
        ) : error ? (
          <div className="m-4 flex items-center gap-2 rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <WarningCircle className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : kind === 'pdf' ? (
          <div className="h-full w-full bg-slate-900/10">
            <iframe
              src={rawUrl}
              title={file.name}
              className="h-full w-full border-0"
            />
          </div>
        ) : kind === 'sheet' && sheetData ? (
          <div className="flex h-full flex-col">
            {/* Sheet Sub-Bar: Filter & Row Count */}
            <div className="flex items-center justify-between gap-2 border-b border-border bg-card/40 px-3 py-1.5 text-xs">
              <div className="relative flex-1 max-w-xs">
                <MagnifyingGlass className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Cari dalam tabel..."
                  value={sheetFilter}
                  onChange={(e) => setSheetFilter(e.target.value)}
                  className="h-7.5 pl-8 text-xs font-mono"
                />
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {filteredSheetRows.length} dari {sheetData.rows.length} baris · {sheetData.header.length} kolom
              </div>
            </div>

            {/* Scrollable Data Table */}
            <div className="flex-1 overflow-auto p-2">
              <div className="overflow-x-auto rounded-[var(--radius-md)] border border-border">
                <table className="w-full border-collapse font-mono text-[11.5px] leading-tight">
                  <thead className="bg-raised/80 sticky top-0 z-10 backdrop-blur-xs">
                    <tr>
                      <th className="border-b border-r border-border px-2.5 py-1.5 text-center text-[10px] font-semibold text-muted-foreground w-12">
                        #
                      </th>
                      {sheetData.header.map((col, idx) => (
                        <th
                          key={idx}
                          className="border-b border-r border-border px-3 py-1.5 text-left font-semibold text-foreground whitespace-nowrap"
                        >
                          {col || `Col ${idx + 1}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSheetRows.map((row, rIdx) => (
                      <tr
                        key={rIdx}
                        className={cn(
                          'transition-colors hover:bg-raised/40',
                          rIdx % 2 === 1 && 'bg-raised/15',
                        )}
                      >
                        <td className="border-b border-r border-border/60 px-2 py-1 text-center text-[10px] text-dim select-none">
                          {rIdx + 1}
                        </td>
                        {sheetData.header.map((_, cIdx) => (
                          <td
                            key={cIdx}
                            className="border-b border-r border-border/60 px-3 py-1 text-foreground/90 whitespace-nowrap overflow-hidden text-ellipsis max-w-xs"
                            title={row[cIdx] ?? ''}
                          >
                            {row[cIdx] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : kind === 'markdown' && content ? (
          <div className="h-full overflow-auto p-4">
            {mdViewMode === 'rendered' ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <Markdown content={content} />
              </div>
            ) : (
              <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-border bg-background/80 p-3 font-mono text-xs leading-relaxed text-foreground">
                {content}
              </pre>
            )}
          </div>
        ) : kind === 'image' ? (
          <div className="flex h-full items-center justify-center bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4">
            <img
              src={rawUrl}
              alt={file.name}
              className="max-h-full max-w-full rounded-[var(--radius-md)] object-contain shadow-sm"
            />
          </div>
        ) : kind === 'video' ? (
          <div className="flex h-full items-center justify-center p-4">
            <video src={rawUrl} controls className="max-h-full max-w-full rounded-[var(--radius-md)] bg-black" />
          </div>
        ) : kind === 'audio' ? (
          <div className="flex h-full flex-col items-center justify-center p-8">
            <FileAudio className="mb-4 size-16 text-primary/60" />
            <audio src={rawUrl} controls className="w-full max-w-md" />
          </div>
        ) : isBinary ? (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center">
            {getFileIcon(kind, 'size-12 mb-3 text-muted-foreground/60')}
            <h4 className="text-sm font-semibold text-foreground">{file.name}</h4>
            <p className="mt-1 text-xs text-muted-foreground max-w-sm">
              File ini berformat biner atau dokumen yang tidak dapat ditampilkan langsung sebagai teks biasa.
            </p>
            <Button size="sm" onClick={handleDownload} className="mt-4 gap-1.5">
              <DownloadSimple className="size-4" />
              <span>Unduh File ({formatBytes(fileSize ?? 0)})</span>
            </Button>
          </div>
        ) : content !== null ? (
          // Text / Code with line numbers
          <div className="h-full overflow-auto p-2">
            <div className="flex rounded-[var(--radius-md)] border border-border bg-background/70 font-mono text-xs leading-relaxed">
              {/* Line numbers gutter */}
              <div className="select-none border-r border-border/60 bg-card/40 py-3 px-2 text-right text-[11px] text-dim">
                {content.split('\n').map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              {/* Code content */}
              <pre className="flex-1 overflow-x-auto p-3 text-foreground whitespace-pre">
                {content}
              </pre>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
})
