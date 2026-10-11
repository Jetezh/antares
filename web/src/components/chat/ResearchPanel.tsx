import { useEffect, useState } from 'react'
import {
  ArrowSquareOut,
  ArrowsClockwise,
  BookOpen,
  Check,
  CheckCircle,
  Copy,
  FileText,
  FloppyDisk,
  Folders,
  Gear,
  Info,
  Key,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/primitives'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { get, post } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { useI18n } from '@/lib/i18n'

interface ResearchPanelProps {
  refreshKey?: number
  onClose: () => void
  onInsertToChat?: (text: string) => void
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

export function ResearchPanel({ refreshKey, onClose, onInsertToChat }: ResearchPanelProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'zotero' | 'gdocs'>('gdocs')
  const [frameKey, setFrameKey] = useState(0)

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
  const [uriCopied, setUriCopied] = useState(false)
  const [googleConnected, setGoogleConnected] = useState(false)
  const [connectingGoogle, setConnectingGoogle] = useState(false)

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

  // Load settings on mount
  useEffect(() => {
    get<ResearchSettings>('/research/settings')
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
          if (data.gdocs.document_url && !docUrl) {
            setDocUrl(data.gdocs.document_url)
            setPreviewActive(true)
            try {
              localStorage.setItem('antares:gdocs-active-url', data.gdocs.document_url)
            } catch {
              /* ignore */
            }
          }
        }
      })
      .catch(() => {})
  }, [docUrl])

  const handleLoadDoc = (urlVal?: string) => {
    const val = (urlVal !== undefined ? urlVal : docUrl).trim()
    if (!val) return
    setPreviewActive(true)
    try {
      localStorage.setItem('antares:gdocs-active-url', val)
      post('/research/settings', {
        gdocs: {
          document_url: val,
        },
      }).catch(() => {})
    } catch {
      // ignore
    }
  }

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    setSaveSuccess(false)
    try {
      await post('/research/settings', {
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
      setTimeout(() => {
        setSaveSuccess(false)
        setSettingsOpen(false)
      }, 1000)
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

  // Convert standard edit Google Doc URL to /preview embed URL safely
  const getEmbedUrl = (url: string, key: number) => {
    if (!url) return ''
    const match = url.trim().match(/\/document\/d\/([a-zA-Z0-9_-]{20,})/)
    if (match && match[1]) {
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
            variant={tab === 'gdocs' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('gdocs')}
            className="gap-1.5 text-xs"
          >
            <FileText className="size-3.5" />
            <span>{t('research.gdocs')}</span>
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

      {/* Tab 1: Google Docs Preview */}
      {tab === 'gdocs' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border bg-background/50 p-3">
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
              className="h-8 flex-1 text-xs"
            />
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
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() => setFrameKey((k) => k + 1)}
                  className="h-8 w-8 shrink-0"
                  title="Reload Preview"
                >
                  <ArrowsClockwise className="size-4" />
                </Button>
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

          <div className="relative flex-1 bg-background/30">
            {docUrl && previewActive && getEmbedUrl(docUrl, frameKey) ? (
              <iframe
                key={frameKey}
                src={getEmbedUrl(docUrl, frameKey)}
                title="Google Docs Preview"
                className="size-full border-0 bg-white"
                allow="autoplay"
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

      {/* Tab 2: Zotero Collections & Library */}
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
                          <CheckCircle className="size-4" />
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
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        disabled={!gdocsClientId || !gdocsClientSecret || connectingGoogle}
                        loading={connectingGoogle}
                        className="w-full gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                        onClick={async () => {
                          setConnectingGoogle(true)
                          try {
                            await handleSaveSettings()
                            const res = await get<{ url: string }>('/auth/google/url')
                            if (res.url) {
                              window.open(res.url, 'google_oauth', 'width=600,height=700')
                            }
                          } catch {
                            // ignore
                          } finally {
                            setConnectingGoogle(false)
                          }
                        }}
                      >
                        <Key className="size-3.5" />
                        <span>{t('research.connectGoogle')}</span>
                      </Button>
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
                onClick={handleSaveSettings}
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
              <div className="flex items-center justify-between rounded-[var(--radius-sm)] border border-border bg-background p-2 font-mono text-[11px]">
                <span className="truncate">http://localhost:5174/api/auth/google/callback</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 text-[10px]"
                  onClick={async () => {
                    await copyText('http://localhost:5174/api/auth/google/callback')
                    setUriCopied(true)
                    setTimeout(() => setUriCopied(false), 2000)
                  }}
                >
                  {uriCopied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                  <span>{uriCopied ? t('research.redirectUriCopied') : t('research.copyRedirectUri')}</span>
                </Button>
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
    </div>
  )
}
