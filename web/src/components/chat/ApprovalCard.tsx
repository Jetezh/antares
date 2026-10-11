import { useMemo, useState } from 'react'
import { Check, ShieldWarning, X } from '@phosphor-icons/react'
import { post } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'

export interface ApprovalView {
  id: string
  tool: string
  arguments: string
  message: string
  /** Set once answered, so the card shows the outcome instead of buttons. */
  decided?: 'allowed' | 'refused' | 'expired'
}

/**
 * A tool is waiting on a decision. The run is blocked until this is answered
 * or its deadline passes, so the card has to make both the action and its
 * consequence obvious rather than being a subtle inline hint.
 */
export function ApprovalCard({
  approval,
  onDecided,
}: {
  approval: ApprovalView
  onDecided: (id: string, decision: 'allowed' | 'refused' | 'expired') => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)

  const decide = async (allow: boolean) => {
    setBusy(allow ? 'allow' : 'deny')
    try {
      await post(`/approvals/${approval.id}`, { allow })
      onDecided(approval.id, allow ? 'allowed' : 'refused')
    } catch {
      // A request that is no longer waiting has already timed out; saying so
      // is more useful than an error banner.
      onDecided(approval.id, 'expired')
    } finally {
      setBusy(null)
    }
  }

  const gdocsUpdateDiff = useMemo(() => {
    if (approval.tool !== 'gdocs_update') return null
    try {
      const parsed = JSON.parse(approval.arguments) as Record<string, any>
      return {
        findText: parsed.find_text || '',
        position: parsed.position || 'after',
        endText: parsed.end_text || '',
        text: parsed.text || '',
        heading: parsed.heading || '',
      }
    } catch {
      return null
    }
  }, [approval.tool, approval.arguments])

  const pretty = formatArguments(approval.arguments)

  return (
    <div className="fade-up tp-panel rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--warning)_45%,var(--border))] bg-card p-4">
      <div className="flex items-start gap-3">
        <ShieldWarning className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" weight="fill" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{approval.message || t('approval.title')}</p>

          {gdocsUpdateDiff ? (
            <div className="mt-2 space-y-2 rounded-[var(--radius-md)] border border-border bg-background/50 p-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border pb-1.5 font-mono text-[11px]">
                <span className="font-semibold text-foreground">
                  Target Google Docs: {gdocsUpdateDiff.findText ? `[${gdocsUpdateDiff.position.toUpperCase()}] "${gdocsUpdateDiff.findText}"` : 'Akhir Dokumen'}
                </span>
                {gdocsUpdateDiff.heading ? (
                  <span className="rounded bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground">
                    Style: {gdocsUpdateDiff.heading}
                  </span>
                ) : null}
              </div>

              {gdocsUpdateDiff.position === 'replace' && (gdocsUpdateDiff.findText || gdocsUpdateDiff.endText) ? (
                <div className="rounded border border-destructive/30 bg-destructive/10 p-2 font-mono text-[11px] text-destructive">
                  <p className="font-semibold mb-0.5">- Yang Akan Digantikan:</p>
                  <p className="text-[10px] opacity-80">
                    {gdocsUpdateDiff.endText
                      ? `Seluruh isi antara "${gdocsUpdateDiff.findText}" s/d "${gdocsUpdateDiff.endText}"`
                      : `Teks penanda "${gdocsUpdateDiff.findText}"`}
                  </p>
                </div>
              ) : null}

              <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-2 font-mono text-[11px] text-emerald-500">
                <p className="font-semibold mb-0.5">+ Draf Teks Baru yang Akan Masuk:</p>
                <p className="max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-foreground">
                  {gdocsUpdateDiff.text}
                </p>
              </div>
            </div>
          ) : pretty ? (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] border border-border bg-background/40 p-2.5 font-mono text-[11px] leading-relaxed">
              {pretty}
            </pre>
          ) : null}

          {approval.decided ? (
            <p className="m-rise mt-2 text-xs text-muted-foreground">
              {approval.decided === 'allowed'
                ? t('approval.allowed')
                : approval.decided === 'refused'
                  ? t('approval.refused')
                  : t('approval.expired')}
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" loading={busy === 'allow'} onClick={() => decide(true)} className="gap-1.5">
                <Check className="size-4" />
                {t('approval.allow')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                loading={busy === 'deny'}
                onClick={() => decide(false)}
                className="gap-1.5"
              >
                <X className="size-4" />
                {t('approval.refuse')}
              </Button>
              <span className="self-center text-xs text-muted-foreground">
                {t('approval.hint')}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Show the command or path rather than the raw JSON envelope around it. */
function formatArguments(raw: string): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const key of ['command', 'path', 'url', 'query']) {
      const v = parsed[key]
      if (typeof v === 'string' && v) return v
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}
