import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import {
  CaretDown,
  CaretUp,
  FloppyDisk,
  Spinner,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { ApiError, get, post } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/chat/Markdown'
import { CodeEditor } from '@/components/chat/CodeEditor'
import { TerminalPanel } from '@/components/chat/TerminalPanel'
import { isMarkdownFile } from '@/lib/editor/languages'
import {
  detectFileKind,
  FileViewerPanel,
  getFileIcon,
  type SelectedFile,
} from '@/components/chat/FileViewerPanel'

export interface CodeWorkspaceHandle {
  /** Persists the editor. `force` overwrites a file that changed on disk. */
  save: (force?: boolean) => Promise<boolean>
  /** Discards local edits and re-reads the file from disk. */
  reload: () => void
}

interface CodeWorkspaceProps {
  /** `null` renders the terminal on its own, with no file tab behind it. */
  file: SelectedFile | null
  /** Hides (but keeps) the editor so the terminal can take the full panel. */
  showEditor?: boolean
  baseDir?: string
  /** Bumped by the parent when the agent may have written to the project. */
  refreshKey?: number
  onSaved?: () => void
  onDirtyChange?: (dirty: boolean) => void
  onClose: () => void
}

const TERM_HEIGHT_KEY = 'antares:code-terminal-height'
const TERM_COLLAPSED_KEY = 'antares:code-terminal-collapsed'

function readTermHeight(): number {
  try {
    const saved = localStorage.getItem(TERM_HEIGHT_KEY)
    if (saved) {
      const parsed = parseInt(saved, 10)
      if (parsed >= 100 && parsed <= 700) return parsed
    }
  } catch {
    /* ignore */
  }
  return 230
}

/**
 * The right-hand IDE surface: an editable file on top and a real shell below,
 * with the terminal kept mounted so its session survives tab switches.
 */
export const CodeWorkspace = memo(
  forwardRef<CodeWorkspaceHandle, CodeWorkspaceProps>(function CodeWorkspace(
    { file, showEditor = true, baseDir, refreshKey, onSaved, onDirtyChange, onClose },
    ref,
  ) {
    const { t } = useI18n()
    const kind = file ? detectFileKind(file.name) : null
    const editable = kind === 'code' || kind === 'text' || kind === 'markdown'
    const filePath = file?.path ?? ''
    const fileName = file?.name ?? ''
    const editorVisible = showEditor && file !== null

    const [content, setContent] = useState('')
    const [savedContent, setSavedContent] = useState('')
    const [mtime, setMtime] = useState<number | null>(null)
    const [docVersion, setDocVersion] = useState(0)
    const [loading, setLoading] = useState(editable)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [conflict, setConflict] = useState(false)
    const [diskChanged, setDiskChanged] = useState(false)
    const [mdPreview, setMdPreview] = useState(false)

    const [termHeight, setTermHeight] = useState(readTermHeight)
    const [termCollapsed, setTermCollapsed] = useState(() => {
      try {
        return localStorage.getItem(TERM_COLLAPSED_KEY) === 'true'
      } catch {
        return false
      }
    })
    const [draggingTerm, setDraggingTerm] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    const dirParam = baseDir ? `&dir=${encodeURIComponent(baseDir)}` : ''
    const dirty = editable && content !== savedContent

    const load = useCallback(async () => {
      if (!editable || !filePath) return
      setLoading(true)
      setLoadError(null)
      try {
        const res = await get<{ content?: string; binary?: boolean; mtime?: number }>(
          `/files/read?path=${encodeURIComponent(filePath)}${dirParam}`,
        )
        if (res.binary) {
          setLoadError(t('editor.binary'))
          return
        }
        const text = res.content ?? ''
        setContent(text)
        setSavedContent(text)
        setMtime(res.mtime ?? null)
        setDocVersion((v) => v + 1)
        setConflict(false)
        setDiskChanged(false)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    }, [editable, filePath, dirParam, t])

    // Load when the file changes.
    useEffect(() => {
      setMdPreview(false)
      setSaveError(null)
      setConflict(false)
      setDiskChanged(false)
      setContent('')
      setSavedContent('')
      setMtime(null)
      if (editable) void load()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, baseDir, editable])

    // The agent finished a turn: re-read unless the buffer has local edits, in
    // which case flag the divergence and let the user choose.
    const firstRefresh = useRef(true)
    useEffect(() => {
      if (firstRefresh.current) {
        firstRefresh.current = false
        return
      }
      if (!editable) return
      if (dirty) setDiskChanged(true)
      else void load()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshKey])

    const save = useCallback(
      async (force = false, overrideContent?: string) => {
        if (!editable || !filePath || saving) return true
        const text = overrideContent ?? content
        setSaving(true)
        setSaveError(null)
        try {
          const body: Record<string, unknown> = { path: filePath, content: text }
          if (!force && mtime !== null) body.expected_mtime = mtime
          const res = await post<{ mtime: number }>(`/files/write${dirParam ? `?${dirParam.slice(1)}` : ''}`, body)
          setSavedContent(text)
          setMtime(res.mtime)
          setConflict(false)
          setDiskChanged(false)
          onSaved?.()
          return true
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            setConflict(true)
          } else {
            setSaveError(err instanceof Error ? err.message : String(err))
          }
          return false
        } finally {
          setSaving(false)
        }
      },
      [editable, saving, filePath, content, mtime, dirParam, onSaved],
    )

    useImperativeHandle(ref, () => ({ save, reload: () => void load() }), [save, load])

    // Report the buffer's dirty state so the parent can guard file switches.
    useEffect(() => {
      onDirtyChange?.(dirty)
      return () => onDirtyChange?.(false)
    }, [dirty, onDirtyChange])

    // Terminal drag-to-resize.
    useEffect(() => {
      if (!draggingTerm) return
      const onMove = (e: MouseEvent) => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const next = Math.max(100, Math.min(700, rect.bottom - e.clientY))
        setTermHeight(next)
        try {
          localStorage.setItem(TERM_HEIGHT_KEY, String(next))
        } catch {
          /* ignore */
        }
      }
      const onUp = () => setDraggingTerm(false)
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
    }, [draggingTerm])

    const toggleTerminal = useCallback(() => {
      setTermCollapsed((prev) => {
        const next = !prev
        try {
          localStorage.setItem(TERM_COLLAPSED_KEY, String(next))
        } catch {
          /* ignore */
        }
        return next
      })
    }, [])

    const terminalLabels = {
      connecting: t('editor.terminalConnecting'),
      exited: t('editor.terminalExited'),
      error: t('editor.terminalError'),
      clear: t('editor.terminalClear'),
      restart: t('editor.terminalRestart'),
      hint: t('editor.terminalHint'),
    }

    return (
      <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden bg-card">
        {/*
          The editor stays mounted (just hidden) when the terminal tab is active,
          so switching tabs never drops the buffer or the shell session.
        */}
        <div key="editor" className={cn('flex min-h-0 flex-col', editorVisible ? 'flex-1' : 'hidden')}>
          {/* Editor toolbar (files the viewer cannot edit bring their own) */}
          {editable && file ? (
            <div className="flex items-center justify-between gap-2 border-b border-border bg-background/50 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {getFileIcon(kind ?? 'text', 'size-4 shrink-0')}
              <span className="truncate font-mono text-xs font-semibold text-foreground" title={filePath}>
                {fileName}
              </span>
              {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title={t('editor.unsaved')} /> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {editable && isMarkdownFile(fileName) ? (
                <div className="flex items-center rounded-[var(--radius-md)] border border-border bg-card/60 p-0.5">
                  <button
                    type="button"
                    onClick={() => setMdPreview(false)}
                    className={cn(
                      'rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium transition-colors',
                      !mdPreview ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('editor.source')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMdPreview(true)}
                    className={cn(
                      'rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium transition-colors',
                      mdPreview ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('editor.preview')}
                  </button>
                </div>
              ) : null}
              {editable ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 px-2 text-[11px]"
                  loading={saving}
                  disabled={!dirty}
                  onClick={() => void save()}
                >
                  {!saving ? <FloppyDisk className="size-3.5" /> : null}
                  <span className="hidden sm:inline">{t('editor.save')}</span>
                </Button>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={onClose}
                title={t('editor.close')}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          ) : null}

          {/* Divergence / conflict banners */}
          {conflict || diskChanged ? (
            <div className="flex items-center gap-2 border-b border-[color-mix(in_oklch,var(--warning)_45%,var(--border))] bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] px-3 py-2 text-[11px] text-foreground">
              <WarningCircle className="size-4 shrink-0 text-[var(--warning)]" />
              <span className="min-w-0 flex-1">{t('editor.changedOnDisk')}</span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void load()}>
                {t('editor.reload')}
              </Button>
              <Button size="sm" className="h-6 px-2 text-[11px]" loading={saving} onClick={() => void save(true)}>
                {t('editor.overwrite')}
              </Button>
            </div>
          ) : null}
          {saveError ? (
            <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              <WarningCircle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">{t('editor.saveFailed')}: {saveError}</span>
            </div>
          ) : null}

          {/* Editor / viewer */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {!file ? null : !editable ? (
              <FileViewerPanel file={file} baseDir={baseDir} onClose={onClose} />
            ) : loading ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-5 animate-spin text-primary" />
                <span>{t('editor.loading')}</span>
              </div>
            ) : loadError ? (
              <div className="m-4 flex items-center gap-2 rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                <WarningCircle className="size-4 shrink-0" />
                <span>{loadError}</span>
              </div>
            ) : mdPreview ? (
              <div className="prose prose-sm dark:prose-invert h-full max-w-none overflow-auto p-4">
                <Markdown content={content} />
              </div>
            ) : (
              <CodeEditor
                key={filePath}
                fileName={fileName}
                value={content}
                docVersion={docVersion}
                onChange={setContent}
                onSave={(value) => {
                  setContent(value)
                  void save(false, value)
                }}
              />
            )}
          </div>
        </div>

        {/* Terminal divider / collapsed bar (editor mode only) */}
        <div key="terminal-chrome" className={cn('shrink-0', !editorVisible && 'hidden')}>
          {termCollapsed ? (
            <button
              type="button"
              onClick={toggleTerminal}
              className="flex w-full shrink-0 items-center gap-2 border-t border-border bg-card/60 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <CaretUp className="size-3.5" />
              <span className="font-mono">{t('editor.terminal')}</span>
            </button>
          ) : (
            <div
              role="separator"
              aria-orientation="horizontal"
              onMouseDown={(e) => {
                e.preventDefault()
                setDraggingTerm(true)
              }}
              className={cn(
                'group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-t border-border bg-card/60',
                draggingTerm && 'bg-primary/20',
              )}
            >
              <button
                type="button"
                onClick={toggleTerminal}
                title={t('editor.terminalCollapse')}
                className="flex h-2 w-16 items-center justify-center rounded-full text-dim opacity-0 transition-opacity group-hover:opacity-100"
              >
                <CaretDown className="size-3" />
              </button>
            </div>
          )}
        </div>

        {/* One TerminalPanel for both modes: full-height alone, split with a file. */}
        <div
          key="terminal"
          style={editorVisible ? { height: `${termHeight}px` } : undefined}
          className={cn(
            'min-h-0 overflow-hidden',
            editorVisible ? 'shrink-0' : 'flex-1',
            editorVisible && termCollapsed && 'hidden',
          )}
        >
          <TerminalPanel dir={baseDir} active labels={terminalLabels} />
        </div>
      </div>
    )
  }),
)
