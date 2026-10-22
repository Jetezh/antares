import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ArrowsClockwise, Eraser, Spinner, WarningCircle } from '@phosphor-icons/react'
import '@xterm/xterm/css/xterm.css'
import { wsUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type TerminalStatus = 'connecting' | 'running' | 'exited' | 'error'

interface TerminalPanelProps {
  /** Project directory the shell starts in. Empty falls back to the workspace. */
  dir?: string
  active: boolean
  labels: {
    connecting: string
    exited: string
    error: string
    clear: string
    restart: string
    hint: string
  }
}

function readTheme() {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    background: value('--background', '#f7f7f8'),
    foreground: value('--foreground', '#111214'),
    cursor: value('--foreground', '#111214'),
    cursorAccent: value('--background', '#f7f7f8'),
    selectionBackground: value('--raised', '#e6e8ec'),
    black: value('--foreground', '#111214'),
    brightBlack: value('--dim', '#6b717c'),
    white: value('--foreground', '#111214'),
    brightWhite: value('--foreground', '#111214'),
    red: value('--destructive', '#b4383d'),
    green: value('--success', '#2f7a45'),
    yellow: value('--warning', '#8a6414'),
    blue: value('--syntax-function', '#3b6fd4'),
    magenta: value('--syntax-keyword', '#a626a4'),
    cyan: value('--syntax-link', '#3b6fd4'),
  }
}

/**
 * An xterm.js view over a real PTY (the backend `/api/terminal/ws`). The
 * session lives as long as this component is mounted, so switching to the
 * Research tab and back must not unmount it — the parent hides it with CSS
 * instead.
 */
export const TerminalPanel = memo(function TerminalPanel({ dir, active, labels }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [generation, setGeneration] = useState(0)

  // Create the terminal once. Connecting is a separate effect so Restart only
  // re-runs the socket, not the emulator (which would lose the scrollback).
  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      theme: readTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    if (hostRef.current) term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit

    const observer = new MutationObserver(() => {
      term.options.theme = readTheme()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    const fitNow = () => {
      try {
        fit.fit()
      } catch {
        // Zero-sized while hidden; the next resize observer tick retries.
      }
    }
    fitNow()

    setStatus('connecting')
    setExitCode(null)
    const query = `?dir=${encodeURIComponent(dir ?? '')}&cols=${term.cols}&rows=${term.rows}`
    const socket = new WebSocket(wsUrl(`/terminal/ws${query}`))
    socket.binaryType = 'arraybuffer'
    wsRef.current = socket

    socket.onopen = () => {
      setStatus('running')
      fitNow()
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as { type?: string; code?: number }
          if (msg.type === 'exit') {
            setExitCode(typeof msg.code === 'number' ? msg.code : null)
            setStatus('exited')
          }
        } catch {
          /* ignore malformed control frames */
        }
        return
      }
      term.write(new Uint8Array(event.data as ArrayBuffer))
    }
    socket.onerror = () => setStatus('error')
    socket.onclose = () => {
      setStatus((prev) => (prev === 'running' || prev === 'connecting' ? 'exited' : prev))
    }

    const dataSub = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    const observer = new ResizeObserver(() => fitNow())
    if (hostRef.current) observer.observe(hostRef.current)

    return () => {
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      socket.close()
      wsRef.current = null
    }
  }, [dir, generation])

  useEffect(() => {
    if (!active) return
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
  }, [active])

  const restart = useCallback(() => setGeneration((g) => g + 1), [])
  const clear = useCallback(() => termRef.current?.clear(), [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background/60">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/40 px-2.5 py-1">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              status === 'running' && 'bg-emerald-500',
              status === 'connecting' && 'bg-amber-500',
              status === 'exited' && 'bg-muted-foreground',
              status === 'error' && 'bg-destructive',
            )}
          />
          <span className="truncate text-muted-foreground">
            {status === 'connecting' ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner className="size-3 animate-spin" />
                {labels.connecting}
              </span>
            ) : status === 'error' ? (
              <span className="inline-flex items-center gap-1.5 text-destructive">
                <WarningCircle className="size-3" />
                {labels.error}
              </span>
            ) : status === 'exited' ? (
              exitCode === null || exitCode < 0 ? labels.exited : `${labels.exited} (${exitCode})`
            ) : (
              dir || labels.hint
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="icon-sm" variant="ghost" className="h-6.5 w-6.5" onClick={clear} title={labels.clear}>
            <Eraser className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" className="h-6.5 w-6.5" onClick={restart} title={labels.restart}>
            <ArrowsClockwise className="size-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden p-1.5 [&_.xterm]:h-full [&_.xterm-screen]:h-full"
        onMouseDown={() => termRef.current?.focus()}
      />
    </div>
  )
})
