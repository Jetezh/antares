import { memo, useEffect, useMemo, useState } from 'react'
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Folder,
  FolderOpen,
  House,
  MagnifyingGlass,
  Spinner,
  TreeStructure,
  X,
} from '@phosphor-icons/react'
import { get } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
}

export const ChatFolderTree = memo(function ChatFolderTree({
  projectDir,
  activeFilePath,
  onSelectFile,
  onClose,
  refreshKey,
}: ChatFolderTreeProps) {
  const [tree, setTree] = useState<Record<string, TreeNode[]>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({ '': true })
  const [loading, setLoading] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [refreshCount, setRefreshCount] = useState(0)

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
    setOpen((prev) => ({ ...prev, [node.path]: !isOpen }))
    if (!isOpen && !tree[node.path]) {
      loadSubdir(node.path)
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

  const renderTree = (sub: string, depth: number) => {
    const nodes = tree[sub] ?? []
    return nodes.map((node) => {
      const isExpanded = open[node.path]
      const isSelected = activeFilePath === node.path
      const kind = detectFileKind(node.name)

      // Skip non-matching files during search (always keep directories visible so search can penetrate)
      if (filterQuery && !node.is_dir && !matchesQuery(node.name)) {
        return null
      }

      return (
        <div key={node.path} className="select-none">
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
            className={cn(
              'group flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-1 pr-2 text-left font-mono text-xs transition-colors',
              isSelected
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-foreground/80 hover:bg-raised/80 hover:text-foreground',
            )}
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
            <span className="truncate flex-1">{node.name}</span>
          </button>

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
          {projectDir ? (
            <TreeStructure className="size-4 text-primary shrink-0" />
          ) : (
            <House className="size-4 text-primary shrink-0" />
          )}
          <span className="truncate text-xs font-semibold text-foreground" title={rootLabel}>
            {rootLabel}
          </span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6.5 w-6.5 text-muted-foreground hover:text-foreground"
            onClick={() => setRefreshCount((c) => c + 1)}
            title="Muat Ulang Folder"
            aria-label="Refresh Tree"
          >
            <ArrowsClockwise className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>

          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6.5 w-6.5 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            title="Tutup Folder Tree"
            aria-label="Tutup Folder Tree"
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
            placeholder="Cari file..."
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

      {/* Tree Content */}
      <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
        {loading && !tree[''] ? (
          <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-4 animate-spin text-primary" />
            <span>Memuat berkas...</span>
          </div>
        ) : tree[''] && tree[''].length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Folder kosong
          </div>
        ) : (
          renderTree('', 0)
        )}
      </div>

      {/* Footer Info */}
      <div className="border-t border-border/60 bg-background/40 px-3 py-1.5 flex items-center justify-between text-[11px] text-muted-foreground font-mono">
        <span className="truncate">{tree['']?.length ?? 0} item</span>
        <button
          type="button"
          onClick={collapseAll}
          className="text-[10px] text-dim hover:text-foreground transition-colors"
        >
          Tutup Semua
        </button>
      </div>
    </div>
  )
})
