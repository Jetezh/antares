/** Typed client for the Antares HTTP API. */

import { consumeSseStream } from './sse'

/** True when an error is the "set a dashboard password first" 428 gate. */
export function isDashboardPasswordRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 428
}

export class ApiError extends Error {
  status: number
  body?: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

const TOKEN_KEY = 'antares.token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    // Include the dashboard login cookie on every request.
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(init.headers as Record<string, string>),
    },
  })

  // A dashboard-login 401 means the session expired or was never established;
  // bounce to the login screen unless we are already on it or authenticating.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.assign('/login')
    }
  }

  const text = await res.text()
  let body: unknown = text
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      /* keep raw text */
    }
  }

  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : res.statusText || `HTTP ${res.status}`
    throw new ApiError(res.status, msg, body)
  }
  return body as T
}

export const get = <T,>(path: string) => api<T>(path)
export const post = <T,>(path: string, data?: unknown) =>
  api<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) })
export const put = <T,>(path: string, data?: unknown) =>
  api<T>(path, { method: 'PUT', body: data === undefined ? undefined : JSON.stringify(data) })
export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' })

/**
 * Build a same-origin URL to an API GET endpoint with the auth token in the
 * query string. Use for `<img src>`, `<video>`, and download links — places
 * that cannot set an Authorization header. The token middleware accepts
 * `?token=`. XHR/fetch call sites should use the Authorization header
 * (`authHeaders()`) instead.
 */
export function authedUrl(path: string): string {
  const token = getToken()
  if (!token) return `/api${path}`
  return `/api${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * Build a same-origin WebSocket URL for an /api endpoint. The browser
 * WebSocket API cannot set an Authorization header, so the token rides in the
 * query string (the terminal route is on the query-token allowlist).
 */
export function wsUrl(path: string): string {
  const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = typeof window !== 'undefined' ? window.location.host : '127.0.0.1:8787'
  const token = getToken()
  const query = `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
  return `${proto}//${host}/api${path}${token ? query : ''}`
}

/** Fetch a file endpoint (with auth) and trigger a browser download. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(`/api${path}`, { headers: { ...authHeaders() } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ApiError(res.status, text || res.statusText)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/* ---------- Streaming ---------- */

export interface StreamEvent {
  type: string
  [key: string]: unknown
}

interface StreamHandlers {
  onEvent: (event: StreamEvent) => void
  onError?: (err: Error) => void
  onDone?: () => void
}

/**
 * Shared lifecycle for both SSE transports: build one request, consume the
 * response through the shared parser, and guarantee that once aborted no
 * further consumer callbacks fire and that `onDone` fires at most once.
 *
 * Uses `fetch` (not `EventSource`) so the dashboard session cookie
 * (`credentials: 'include'`) and Authorization header travel with the
 * request. `EventSource` cannot set headers, and after a daemon restart used
 * to 401-loop when only a stale in-memory login map existed.
 */
function streamRequest(init: RequestInit & { url: string }, handlers: StreamHandlers): () => void {
  const controller = new AbortController()
  const { onEvent, onError, onDone } = handlers
  // `settled` guards `onDone`/`onError` so each fires at most once. `aborted`
  // is set the instant the caller invokes the returned disposer so any
  // callback the parser is *about* to make is suppressed before it runs.
  let settled = false
  let aborted = false

  const finish = () => {
    if (settled) return
    settled = true
    onDone?.()
  }
  const fail = (err: Error) => {
    if (settled) return
    settled = true
    onError?.(err)
  }
  const safeEvent = (event: StreamEvent) => {
    if (aborted || settled) return
    onEvent(event)
  }

  ;(async () => {
    let res: Response
    try {
      const { url, ...rest } = init
      res = await fetch(url, {
        ...rest,
        credentials: 'include',
        signal: controller.signal,
      })
    } catch (err) {
      const e = err as Error
      if (e.name === 'AbortError' || aborted) finish()
      else fail(e)
      return
    }

    if (!res.ok || !res.body) {
      // Drain the error body but distinguish a real HTTP failure from an
      // in-flight abort that races the text read (which would masquerade as
      // an empty error body).
      let text = ''
      try {
        text = await res.text()
      } catch (err) {
        if (aborted || (err as Error).name === 'AbortError') {
          finish()
          return
        }
        // Unexpected body-read failure — surface as-is.
        fail(err as Error)
        return
      }
      if (aborted) {
        finish()
        return
      }
      fail(new ApiError(res.status, text || res.statusText))
      return
    }

    try {
      await consumeSseStream<StreamEvent>(res.body, {
        onEvent: safeEvent,
        // Malformed SSE frames from the daemon are transport noise, not user-
        // visible errors; drop them silently as the previous code did.
        onParseError: () => {},
      })
      finish()
    } catch (err) {
      // consumeSseStream cancelled the reader itself before rethrowing, so
      // the body is already teardown-safe — just classify the error.
      const e = err as Error
      if (e.name === 'AbortError' || aborted) finish()
      else fail(e)
    }
  })()

  return () => {
    if (aborted) return
    aborted = true
    controller.abort()
  }
}

/**
 * POST a request and consume the server-sent event stream it returns.
 * Returns an abort function; late callbacks are suppressed after abort.
 */
export function streamPost(
  path: string,
  data: unknown,
  onEvent: (event: StreamEvent) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
): () => void {
  return streamRequest(
    {
      url: `/api${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
      body: JSON.stringify(data),
    },
    { onEvent, onError, onDone },
  )
}

/**
 * Subscribe to a GET SSE endpoint (attach, logs, swarm, …).
 *
 * The Authorization header is set from the stored token, so the legacy
 * `?token=` query parameter is no longer appended here. Use `authedUrl` for
 * media/download URLs that cannot carry headers.
 */
export function streamGet(
  path: string,
  onEvent: (event: StreamEvent) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
): () => void {
  return streamRequest(
    {
      url: `/api${path}`,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
    },
    { onEvent, onError, onDone },
  )
}
