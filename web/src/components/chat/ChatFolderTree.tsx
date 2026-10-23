import { memo, useEffect, useMemo, useState } from 'react'
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  House,
  MagnifyingGlass,
  PencilSimple,
  Spinner,
  Trash,
  TreeStructure,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { del, get, post } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
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
import { Input } from '@/components/ui/primitives'
import { detectFileKind, getFileIcon, type SelectedFile } from './FileViewerPanel'

interface TreeNode {
  name: string
  path: string
  is_dir: boolean
  size?: number
}

interface ChatFolderTreeProps {
  projectDir?: string
  activeFilePath?: string
  onSelectFile: (file: SelectedFile) => void
  onClose: () => void
  refreshKey?: number
  /** The selected file (or an ancestor) was renamed or moved. */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** The selected file (or an ancestor) was deleted. */
  onPathDeleted?: (path: string) => void
}

type EditorDialog =
  | { kind: 'create'; parent: string; type: 'file' | 'dir'; name: string }
  | { kind: 'rename'; node: TreeNode; name: string }

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function childOf(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

const ROW_ACTION =
  'rounded-[var(--radius-sm)] p-1 text-muted-foreground transition-colors hover:bg-raised hover:text-foreground'

export const ChatFolderTree = memo(function ChatFolderTree({
  projectDir,
  activeFilePath,
  onSelectFile,
  onClose,
  refreshKey,
  onPathRenamed,
  onPathDeleted,
}: ChatFolderTreeProps) {
  const { t } = useI18n()
  const [tree, setTree] = useState<Record<string, TreeNode[]>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({ '': true })
  const [selectedDir, setSelectedDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [refreshCount, setRefreshCount] = useState(0)
  const [dialog, setDialog] = useState<EditorDialog | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)

  const dirParam = projectDir ? `&dir=${encodeURIComponent(projectDir)}` : ''
  const rootLabel = useMemo(() => {
    if (projectDir) {
      return projectDir.split('/').filter(Boolean).pop() || projectDir
    }
    return 'Workspace'
  }, [projectDir])

  const loadSubdir = async (sub: string) => {
    try {
      const res = await get<{ entries: TreeNode[] }>(
        `/files?path=${encodeURIComponent(sub)}${dirParam}`,
      )
      setTree((prev) => ({ ...prev, [sub]: res.entries ?? [] }))
    } catch {
      // ignore
    }
  }

  // Reload tree on mount, projectDir change, or refreshKey change
  useEffect(() => {
    let alive = true
    setLoading(true)
    get<{ entries: TreeNode[] }>(`/files?path=.${dirParam}`)
      .then((res) => {
        if (!alive) return
        setTree({ '': res.entries ?? [] })
        setOpen({ '': true })
        setSelectedDir('')
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [projectDir, dirParam, refreshKey, refreshCount])

  const toggleFolder = (node: TreeNode) => {
    if (!node.is_dir) return
    const isOpen = open[node.path]
    setSelectedDir(node.path)
    setOpen((prev) => ({ ...prev, [node.path]: !isOpen }))
    if (!isOpen && !tree[node.path]) {
      void loadSubdir(node.path)
    }
  }

  const collapseAll = () => {
    setOpen({ '': true })
  }

  // Filtered nodes for search
  const matchesQuery = (name: string) => {
    if (!filterQuery.trim()) return true
    return name.toLowerCase().includes(filterQuery.trim().toLowerCase())
  }

  const openCreate = (parent: string, type: 'file' | 'dir') => {
    setActionError(null)
    setDialog({ kind: 'create', parent, type, name: '' })
  }

  const openRename = (node: TreeNode) => {
    setActionError(null)
    setDialog({ kind: 'rename', node, name: node.name })
  }

  const submitDialog = async () => {
    if (!dialog || busy) return
    const name = dialog.name.trim()
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
      setActionError(t('tree.invalidName'))
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      if (dialog.kind === 'create') {
        const parent = dialog.parent
        const path = childOf(parent, name)
        await post('/files/create', { path, type: dialog.type })
        setDialog(null)
        setOpen((prev) => ({ ...prev, [parent]: true }))
        await loadSubdir(parent)
        if (dialog.type === 'file') {
          onSelectFile({ name, path, is_dir: false })
        }
      } else {
        const oldPath = dialog.node.path
        const res = await post<{ path: string }>('/files/rename', {
          path: oldPath,
          name,
        })
        setDialog(null)
        if (dialog.node.is_dir) {
          setRefreshCount((c) => c + 1)
        } else {
          await loadSubdir(parentOf(oldPath))
        }
        onPathRenamed?.(oldPath, res.path)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    const target = deleteTarget
    if (!target || busy) return
    setBusy(true)
    setTreeError(null)
    try {
      const recursive = target.is_dir ? '&recursive=1' : ''
      await del(`/files?path=${encodeURIComponent(target.path)}${dirParam}${recursive}`)
      setDeleteTarget(null)
      setRefreshCount((c) => c + 1)
      if (activeFilePath === target.path || activeFilePath?.startsWith(`${target.path}/`)) {
        onPathDeleted?.(target.path)
      }
    } catch (err) {
      setDeleteTarget(null)
      setTreeError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const renderTree = (sub: string, depth: number) => {
    const nodes = tree[sub] ?? []
    return nodes.map((node) => {
      const isExpanded = open[node.path]
      const isSelected = activeFilePath === node.path
      const isDirTarget = node.is_dir && selectedDir === node.path
      const kind = detectFileKind(node.name)

      // Skip non-matching files during search (always keep directories visible so search can penetrate)
      if (filterQuery && !node.is_dir && !matchesQuery(node.name)) {
        return null
      }

      return (
        <div key={node.path} className="select-none">
          <div
            className={cn(
              'group flex w-full items-center rounded-[var(--radius-sm)] text-left font-mono text-xs transition-colors',
              isSelected
                ? 'bg-primary/15 text-primary font-medium'
                : isDirTarget
                  ? 'bg-primary/10 text-foreground'
                  : 'text-foreground/80 hover:bg-raised/80 hover:text-foreground',
            )}
          >
            <button
              type="button"
              onClick={() => {
                if (node.is_dir) {
                  toggleFolder(node)
                } else {
                  onSelectFile(node)
                }
              }}
              style={{ paddingLeft: `${depth * 14 + 6}px` }}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left"
              title={node.path}
            >
              {node.is_dir ? (
                <span className="flex items-center gap-1 text-muted-foreground group-hover:text-foreground">
                  {isExpanded ? (
                    <CaretDown className="size-3 text-dim" />
                  ) : (
                    <CaretRight className="size-3 text-dim" />
                  )}
                  {isExpanded ? (
                    <FolderOpen className="size-3.5 text-amber-500/90" weight="fill" />
                  ) : (
                    <Folder className="size-3.5 text-amber-500/80" weight="fill" />
                  )}
                </span>
              ) : (
                <span className="flex items-center gap-1 pl-4">
                  {getFileIcon(kind, 'size-3.5 shrink-0')}
                </span>
              )}
              <span className="flex-1 truncate">{node.name}</span>
            </button>

            <div className="flex shrink-0 items-center pr-1 opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
              {node.is_dir ? (
                <>
                  <button
                    type="button"
                    className={ROW_ACTION}
                    title={t('tree.newFile')}
                    aria-label={t('tree.newFile')}
                    onClick={() => openCreate(node.path, 'file')}
                  >
                    <FilePlus className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className={ROW_ACTION}
                    title={t('tree.newFolder')}
                    aria-label={t('tree.newFolder')}
                    onClick={() => openCreate(node.path, 'dir')}
                  >
                    <FolderPlus className="size-3.5" />
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className={ROW_ACTION}
                title={t('tree.rename')}
                aria-label={t('tree.rename')}
                onClick={() => openRename(node)}
              >
                <PencilSimple className="size-3.5" />
              </button>
              <button
                type="button"
                className={cn(ROW_ACTION, 'hover:text-destructive')}
                title={t('common.delete')}
                aria-label={t('common.delete')}
                onClick={() => {
                  setTreeError(null)
                  setDeleteTarget(node)
                }}
              >
                <Trash className="size-3.5" />
              </button>
            </div>
          </div>

          {node.is_dir && isExpanded ? renderTree(node.path, depth + 1) : null}
        </div>
      )
    })
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-r border-border bg-card/60">
      {/* Header Bar */}
      <div className="flex items-center justify-between gap-1 border-b border-border bg-background/50 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSelectedDir('')}
            title={t('tree.root')}
            className="flex min-w-0 items-center gap-1.5"
          >
            {projectDir ? (
              <TreeStructure className="size-4 shrink-0 text-primary" />
            ) : (
              <House className="size-4 shrink-0 text-primary" />
            )}
            <span className="truncate text-xs font-semibold text-foreground" title={rootLabel}>
              {rootLabel}
            </span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6.5 w-6.5 text-muted-foreground hover:text-foreground"
            onClick={() => openCreate(selectedDir, 'file')}
            title={t('tree.newFile')}
            aria-label={t('tree.newFile')}
          >
            <FilePlus className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6.5 w-6.5 text-muted-foreground hover:text-foreground"
            onClick={() => openCreate(selectedDir, 'dir')}
            title={t('tree.newFolder')}
            aria-label={t('tree.newFolder')}
          >
            <FolderPlus className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6.5 w-6.5 text-muted-foreground hover:text-foreground"
            onClick={() => setRefreshCount((c) => c + 1)}
            title={t('tree.refresh')}
            aria-label={t('tree.refresh')}
          >
            <ArrowsClockwise className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>

          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6.5 w-6.5 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            title={t('tree.close')}
            aria-label={t('tree.close')}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Search Input Bar */}
      <div className="border-b border-border/80 p-2">
        <div className="relative">
          <MagnifyingGlass className="absolute left-2.5 top-2 size-3 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t('tree.search')}
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="h-7 pl-7.5 pr-6 font-mono text-[11px]"
          />
          {filterQuery ? (
            <button
              type="button"
              onClick={() => setFilterQuery('')}
              className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </div>

      {treeError ? (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          <WarningCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{treeError}</span>
          <button
            type="button"
            onClick={() => setTreeError(null)}
            className="shrink-0 text-destructive/70 hover:text-destructive"
            aria-label={t('common.close')}
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      {/* Tree Content */}
      <div className="flex-1 space-y-0.5 overflow-auto p-1.5">
        {loading && !tree[''] ? (
          <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-4 animate-spin text-primary" />
            <span>{t('tree.loading')}</span>
          </div>
        ) : tree[''] && tree[''].length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {t('tree.empty')}
          </div>
        ) : (
          renderTree('', 0)
        )}
      </div>

      {/* Footer Info */}
      <div className="flex items-center justify-between border-t border-border/60 bg-background/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">{t('tree.items', { n: tree['']?.length ?? 0 })}</span>
        <button
          type="button"
          onClick={collapseAll}
          className="text-[10px] text-dim transition-colors hover:text-foreground"
        >
          {t('tree.collapseAll')}
        </button>
      </div>

      {/* Create / rename dialog */}
      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !busy) {
            setDialog(null)
            setActionError(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            className="flex flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              void submitDialog()
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {dialog?.kind === 'rename'
                  ? t('tree.renameTitle', { name: dialog.node.name })
                  : dialog?.type === 'dir'
                    ? t('tree.createFolderTitle')
                    : t('tree.createFileTitle')}
              </DialogTitle>
              <DialogDescription>
                {dialog?.kind === 'create'
                  ? t('tree.inFolder', { path: dialog.parent || t('tree.root') })
                  : dialog?.node.path ?? ''}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-2">
              <label htmlFor="tree-entry-name" className="text-xs font-medium text-foreground">
                {t('tree.name')}
              </label>
              <Input
                id="tree-entry-name"
                autoFocus
                value={dialog?.name ?? ''}
                placeholder={t('tree.namePlaceholder')}
                onChange={(e) =>
                  setDialog((prev) => (prev ? { ...prev, name: e.target.value } : prev))
                }
                className="font-mono text-xs"
              />
              {actionError ? (
                <p className="text-[11px] text-destructive">{actionError}</p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setDialog(null)
                  setActionError(null)
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                loading={busy}
                disabled={!dialog?.name.trim()}
              >
                {dialog?.kind === 'rename' ? t('tree.rename') : t('tree.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null)
        }}
        title={
          deleteTarget
            ? t('tree.deleteTitle', { name: deleteTarget.name })
            : t('common.delete')
        }
        description={
          deleteTarget?.is_dir
            ? t('tree.deleteFolderDesc')
            : t('tree.deleteFileDesc')
        }
        confirmLabel={t('common.delete')}
        loading={busy}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
})
