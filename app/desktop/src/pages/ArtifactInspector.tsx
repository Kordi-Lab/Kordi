import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Braces, ChevronLeft, FileText, FolderOpen, Globe2, LoaderCircle, Maximize2, X } from 'lucide-react';

import { MarkdownCodeBlock, MarkdownContent, MermaidDiagram } from '@/kordi-app/components';
import type { DesktopArtifactDirectory, DesktopArtifactDirectoryEntry, DesktopArtifactPreview, SessionArtifact } from '@/kordi-app/types';
import { fetchDesktopChatArtifactDirectory, fetchDesktopChatArtifactPreview } from '@/lib/desktop';
import { cn } from '@/lib/utils';

type ArtifactInspectorProps = {
  isNativeShell: boolean;
  artifacts: SessionArtifact[];
  activeArtifactId: string | null;
  onSelectArtifact: (artifactId: string | null) => void;
  emptyMessage: string;
  previewBaseRoot?: string | null;
  folderBrowserRoot?: string | null;
  footer?: ReactNode;
};

function fileNameFromPath(path: string) {
  return path.split('/').filter(Boolean).pop()?.trim() || path;
}

function parentPathFromPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts;
}

function compactArtifactLocation(path: string, fileName = fileNameFromPath(path)) {
  const parts = parentPathFromPath(path);
  if (parts.length === 0) return '';
  const visibleCount = path.startsWith('/') ? 1 : 2;
  const visibleParts = parts.slice(-visibleCount).filter((part) => part !== fileName);
  if (visibleParts.length === 0) return '';
  return parts.length > visibleParts.length ? `…/${visibleParts.join('/')}` : visibleParts.join('/');
}

function extensionLabel(path: string, fallback: SessionArtifact['kind'] = 'file') {
  const extension = fileNameFromPath(path).split('.').pop()?.trim().toLowerCase();
  if (!extension || extension === fileNameFromPath(path).toLowerCase()) return fallback;
  if (extension === 'markdown') return 'md';
  return extension;
}

function artifactIcon(kind: SessionArtifact['kind'], path = '') {
  const extension = extensionLabel(path, kind);
  if (extension === 'html' || extension === 'htm') return Globe2;
  if (kind === 'code') return Braces;
  if (kind === 'document') return FileText;
  return FileText;
}

function languageFromPath(path: string) {
  const extension = path.split('.').pop()?.trim().toLowerCase();
  if (!extension) return 'text';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'javascript';
  if (['ts', 'tsx'].includes(extension)) return 'typescript';
  if (['py', 'py3'].includes(extension)) return 'python';
  if (['sh', 'zsh', 'bash'].includes(extension)) return 'bash';
  if (extension === 'rs') return 'rust';
  if (['css', 'scss'].includes(extension)) return 'css';
  if (['html', 'htm', 'svg'].includes(extension)) return 'html';
  if (['yaml', 'yml'].includes(extension)) return 'yaml';
  if (['md', 'mdx'].includes(extension)) return 'markdown';
  if (['mmd', 'mermaid'].includes(extension)) return 'mermaid';
  return extension;
}

function artifactPreviewKind(path: string) {
  const extension = extensionLabel(path).toLowerCase();
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'svg') return 'svg';
  if (extension === 'md' || extension === 'mdx') return 'markdown';
  if (extension === 'mmd' || extension === 'mermaid') return 'mermaid';
  if (extension === 'json') return 'json';
  if (extension === 'csv' || extension === 'tsv') return 'table';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(extension)) return 'image';
  return 'source';
}

function parseDelimitedRows(source: string, delimiter: ',' | '\t') {
  return source.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const cells: string[] = [];
    let current = '';
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        cells.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }

    cells.push(current.trim());
    return cells;
  });
}

type ArtifactPreviewMode = 'panel' | 'rail' | 'window';

function ArtifactDataTable({ source, delimiter, mode = 'panel' }: { source: string; delimiter: ',' | '\t'; mode?: ArtifactPreviewMode }) {
  const rows = parseDelimitedRows(source, delimiter);
  if (rows.length === 0) return <div className="px-4 py-4 text-[12px] text-slate-400">This table is empty.</div>;
  const [headers, ...bodyRows] = rows;

  return (
    <div data-artifact-preview-mode={mode} className={cn('overflow-auto p-3', mode === 'panel' ? 'max-h-[32rem]' : 'min-h-full')}>
      <div className="overflow-hidden rounded-[18px] border border-white/8 bg-[color:var(--app-control-bg)]/70">
        <table className="min-w-full border-collapse text-left text-[12px] text-slate-100">
          <thead className="bg-white/[0.05] text-[10px] uppercase tracking-[0.12em] text-slate-400">
            <tr>
              {headers.map((header, index) => <th key={`header-${index}`} className="border-b border-white/8 px-3 py-2 font-medium">{header || `Column ${index + 1}`}</th>)}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`} className="border-b border-white/6 last:border-b-0">
                {headers.map((_, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`} className="align-top px-3 py-2 text-slate-200">{row[cellIndex] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formattedJsonSource(source: string) {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

export function renderArtifactPreview(preview: DesktopArtifactPreview, mode: ArtifactPreviewMode = 'panel') {
  if (preview.lines.length === 0) {
    return <div className="px-4 py-4 text-[12px] text-slate-400">This artifact is empty.</div>;
  }

  const source = preview.lines.map((line) => line.text).join('\n');
  const previewKind = artifactPreviewKind(preview.path);

  if (previewKind === 'html' || previewKind === 'svg') {
    return (
      <div data-artifact-preview-mode={mode} className={cn('bg-[color:var(--app-transcript-bg)] p-3', mode !== 'panel' && 'min-h-full')}>
        <iframe
          title={`${fileNameFromPath(preview.path)} preview`}
          srcDoc={source}
          sandbox="allow-forms allow-popups allow-scripts"
          className={cn('w-full rounded-[16px] border border-white/10 bg-white text-slate-950', mode === 'window' ? 'h-[calc(100vh-10rem)] min-h-[36rem]' : mode === 'rail' ? 'h-full min-h-[28rem]' : 'h-[32rem]')}
        />
      </div>
    );
  }

  if (previewKind === 'image') {
    const imageSource = source.trim().startsWith('data:image/') ? source.trim() : preview.path;
    return (
      <div data-artifact-preview-mode={mode} className={cn('flex items-center justify-center overflow-auto bg-[color:var(--app-transcript-bg)] p-4', mode === 'panel' ? 'max-h-[32rem]' : 'min-h-full')}>
        <img src={imageSource} alt={`${fileNameFromPath(preview.path)} preview`} className="max-h-[30rem] max-w-full rounded-[16px] border border-white/10 bg-white object-contain" />
      </div>
    );
  }

  if (previewKind === 'mermaid') {
    return <div data-artifact-preview-mode={mode} className={cn('p-3', mode !== 'panel' && 'min-h-full')}><MermaidDiagram code={source} className={mode !== 'panel' ? 'min-h-full' : undefined} /></div>;
  }

  if (previewKind === 'json') {
    return (
      <div data-artifact-preview-mode={mode} className={cn('p-3', mode !== 'panel' && 'min-h-full')}>
        <MarkdownCodeBlock language="json" code={formattedJsonSource(source)} maxHeightClass={mode === 'panel' ? 'max-h-[32rem]' : 'max-h-none'} wrapLines />
      </div>
    );
  }

  if (previewKind === 'table') {
    return <ArtifactDataTable source={source} delimiter={extensionLabel(preview.path).toLowerCase() === 'tsv' ? '\t' : ','} mode={mode} />;
  }

  if (previewKind === 'markdown') {
    return (
      <div data-artifact-preview-mode={mode} className={cn('overflow-auto px-4 py-4', mode === 'panel' ? 'max-h-[32rem]' : 'min-h-full')}>
        <MarkdownContent text={source} className={mode !== 'panel' ? 'min-h-full' : undefined} />
      </div>
    );
  }

  return (
    <div data-artifact-preview-mode={mode} className={cn('p-3', mode !== 'panel' && 'min-h-full')}>
      <MarkdownCodeBlock
        language={languageFromPath(preview.path)}
        code={source}
        maxHeightClass={mode === 'panel' ? 'max-h-[32rem]' : 'max-h-none'}
        wrapLines
      />
    </div>
  );
}

function previewErrorCopy(error: string, artifact: SessionArtifact | null) {
  const missing = /not found|no such file|os error 2/i.test(error);
  if (!missing) {
    return {
      title: 'Unable to preview this file',
      description: error,
    };
  }

  return {
    title: 'File is not on disk yet',
    description: 'Kordi tracked this related path from the project/session, but the file does not currently exist. It may have been moved, deleted, or not created by the agent yet.',
  };
}

function formatFileSize(value?: number | null) {
  if (!value) return 'File';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactFromDirectoryEntry(entry: DesktopArtifactDirectoryEntry): SessionArtifact {
  return {
    id: `folder:${entry.path}`,
    path: entry.path,
    name: entry.name,
    kind: entry.kind === 'directory' ? 'file' : entry.kind,
    category: 'related',
    summary: `Project folder file • ${formatFileSize(entry.sizeBytes)}`,
    timeLabel: 'Folder',
  };
}

function artifactCategory(artifact: SessionArtifact): NonNullable<SessionArtifact['category']> {
  return artifact.category ?? 'artifact';
}

type ArtifactListSectionProps = {
  title: string;
  section: 'generated' | 'related' | 'memory';
  description?: string;
  artifacts: SessionArtifact[];
  activeArtifact: SessionArtifact | null;
  onSelect: (artifactId: string) => void;
};

function ArtifactListSection({ title, section, description, artifacts, activeArtifact, onSelect }: ArtifactListSectionProps) {
  if (artifacts.length === 0) return null;

  return (
    <section className="app-detail-section" data-artifact-section={section}>
      {title ? <div className="app-detail-kicker">{title}</div> : null}
      {description ? <div className="mb-2 text-[11px] leading-5 text-[color:var(--utility-muted-text)]">{description}</div> : null}
      <div className="overflow-hidden rounded-[18px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)]/60">
        <div className="divide-y divide-[color:var(--app-divider)]">
          {artifacts.map((artifact) => {
            const displayName = artifact.name || fileNameFromPath(artifact.path);
            const Icon = artifactIcon(artifact.kind, artifact.path);
            const isActive = activeArtifact?.id === artifact.id;
            const location = compactArtifactLocation(artifact.path, displayName);
            const typeLabel = extensionLabel(artifact.path, artifact.kind).toUpperCase();

            return (
              <button
                key={artifact.id}
                type="button"
                data-artifact-file-row="true"
                onClick={() => onSelect(artifact.id)}
                className={cn(
                  'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left transition',
                  isActive ? 'bg-white/[0.055]' : 'hover:bg-white/[0.025]',
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-slate-300">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0 truncate app-inspector-heading">{displayName}</div>
                      <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-slate-400">
                        {typeLabel}
                      </span>
                      {artifact.pinned ? (
                        <span className="shrink-0 rounded-md border border-amber-300/20 bg-amber-300/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-amber-100">
                          pinned
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-[color:var(--utility-muted-text)]">
                      {location ? <span className="truncate">{location}</span> : null}
                      {location && artifact.summary ? <span className="shrink-0 text-slate-600">•</span> : null}
                      {artifact.summary ? <span className="truncate">{artifact.summary}</span> : null}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-[10px] text-slate-500">
                  {artifact.live ? 'Live' : artifact.timeLabel ?? 'Ready'}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function ArtifactPreviewWindow({
  preview,
  title,
  kindLabel,
  onClose,
}: {
  preview: DesktopArtifactPreview;
  title: string;
  kindLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/55 p-3 backdrop-blur-sm sm:p-6" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Preview window"
        className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-[24px] border border-white/12 bg-[color:var(--app-panel-bg)] shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--app-divider)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-slate-200">
              <Maximize2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--utility-muted-text)]">Preview window</div>
              <div className="truncate text-[14px] font-semibold text-[color:var(--utility-foreground)]">{title}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-slate-400">
              {kindLabel}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="app-icon-button grid h-8 w-8 place-items-center rounded-xl text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
              aria-label="Close preview window"
              title="Close preview window"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-[color:var(--app-transcript-bg)]">
          {renderArtifactPreview(preview, 'window')}
        </div>
      </div>
    </div>
  );
}

export function ArtifactInspector({
  isNativeShell,
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  emptyMessage,
  previewBaseRoot,
  folderBrowserRoot,
  footer,
}: ArtifactInspectorProps) {
  const [previewCache, setPreviewCache] = useState<Record<string, DesktopArtifactPreview>>({});
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [browserPath, setBrowserPath] = useState<string | null>(null);
  const [browserDirectory, setBrowserDirectory] = useState<DesktopArtifactDirectory | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [isBrowserLoading, setIsBrowserLoading] = useState(false);
  const [browserSelectedArtifact, setBrowserSelectedArtifact] = useState<SessionArtifact | null>(null);
  const [previewWindowOpen, setPreviewWindowOpen] = useState(false);

  const folderBrowserRootPath = folderBrowserRoot?.trim() ?? '';
  const effectiveBrowserPath = useMemo(() => {
    if (!browserPath || !folderBrowserRootPath) return browserPath;
    return browserPath === folderBrowserRootPath || browserPath.startsWith(`${folderBrowserRootPath}/`)
      ? browserPath
      : null;
  }, [browserPath, folderBrowserRootPath]);

  const generatedArtifacts = useMemo(() => artifacts.filter((artifact) => artifactCategory(artifact) === 'artifact'), [artifacts]);
  const relatedArtifacts = useMemo(() => artifacts.filter((artifact) => artifactCategory(artifact) === 'related'), [artifacts]);
  const activeArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.id === activeArtifactId) ?? generatedArtifacts[0] ?? relatedArtifacts[0] ?? null,
    [activeArtifactId, artifacts, generatedArtifacts, relatedArtifacts],
  );
  const previewArtifact = browserSelectedArtifact ?? activeArtifact;
  const effectivePreviewBaseRoot = previewArtifact?.pinned ? null : previewBaseRoot;
  const activePreviewKey = previewArtifact
    ? `${effectivePreviewBaseRoot ?? ''}:${previewArtifact.id}:${previewArtifact.timeLabel ?? ''}:${previewArtifact.live ? 'live' : 'ready'}`
    : null;
  const cachedPreview = activePreviewKey ? previewCache[activePreviewKey] ?? null : null;
  const previewErrorDetails = previewError ? previewErrorCopy(previewError, previewArtifact) : null;
  const previewFileName = previewArtifact ? fileNameFromPath(previewArtifact.path) : '';
  const previewLocation = previewArtifact ? compactArtifactLocation(previewArtifact.path, previewFileName) : '';
  const previewKind = previewArtifact ? artifactPreviewKind(previewArtifact.path) : null;
  const previewKindLabel = previewKind === 'html' || previewKind === 'svg' || previewKind === 'image'
    ? 'Preview'
    : previewKind === 'markdown'
      ? 'Markdown'
      : previewKind === 'mermaid'
        ? 'Mermaid'
        : previewKind === 'table'
          ? 'Table'
          : previewKind === 'json'
            ? 'JSON'
            : 'Source';

  useEffect(() => {
    if (artifacts.length === 0) {
      if (activeArtifactId !== null) {
        onSelectArtifact(null);
      }
      return;
    }

    if (activeArtifactId && artifacts.some((artifact) => artifact.id === activeArtifactId)) {
      return;
    }

    onSelectArtifact(activeArtifact?.id ?? null);
  }, [activeArtifact?.id, activeArtifactId, artifacts, onSelectArtifact]);

  useEffect(() => {
    setBrowserPath(null);
    setBrowserSelectedArtifact(null);
    setBrowserDirectory(null);
    setBrowserError(null);
  }, [folderBrowserRootPath]);

  useEffect(() => {
    if (!folderBrowserRootPath || !isNativeShell) {
      setBrowserDirectory(null);
      setBrowserError(null);
      setIsBrowserLoading(false);
      return;
    }

    let cancelled = false;
    setBrowserError(null);
    setIsBrowserLoading(true);

    fetchDesktopChatArtifactDirectory(effectiveBrowserPath, folderBrowserRootPath)
      .then((directory) => {
        if (cancelled) return;
        setBrowserDirectory(directory);
      })
      .catch((error) => {
        if (cancelled) return;
        setBrowserError(error instanceof Error ? error.message : 'Unable to browse project folder');
      })
      .finally(() => {
        if (!cancelled) setIsBrowserLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveBrowserPath, folderBrowserRootPath, isNativeShell]);

  useEffect(() => {
    setPreviewWindowOpen(false);
  }, [previewArtifact?.id]);

  useEffect(() => {
    setPreviewError(null);

    if (!previewArtifact?.id || !activePreviewKey || !isNativeShell || cachedPreview) {
      setIsPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setIsPreviewLoading(true);

    fetchDesktopChatArtifactPreview(previewArtifact.path, effectivePreviewBaseRoot)
      .then((preview) => {
        if (cancelled) return;
        setPreviewCache((current) => ({
          ...current,
          [activePreviewKey]: preview,
        }));
      })
      .catch((error) => {
        if (cancelled) return;
        setPreviewError(error instanceof Error ? error.message : 'Unable to load artifact preview');
      })
      .finally(() => {
        if (!cancelled) {
          setIsPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activePreviewKey, cachedPreview, effectivePreviewBaseRoot, isNativeShell, previewArtifact?.id, previewArtifact?.path]);

  return (
    <div data-artifact-inspector="true" className="flex h-full min-h-0 flex-col">
      <div data-artifact-file-list="true" className="shrink-0 overflow-y-auto pr-1 max-h-[38%]">
        {folderBrowserRootPath ? (
          <section className="app-detail-section">
          <div className="app-detail-kicker">Project folder</div>
          <div className="app-inspector-emphasis">
            <div className="truncate text-[11px] text-[color:var(--utility-foreground)]">
              {fileNameFromPath(browserDirectory?.path ?? folderBrowserRootPath)}
            </div>
            <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">
              Browse the full project folder. Open folders to inspect their files; select a file to preview it here.
            </div>
          </div>
          {isBrowserLoading ? (
            <div className="mt-2 flex items-center gap-2 rounded-[14px] border border-[color:var(--app-divider)] px-3 py-2 text-[12px] text-[color:var(--utility-muted-text)]">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Loading folder…
            </div>
          ) : browserError ? (
            <div className="mt-2 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">{browserError}</div>
          ) : browserDirectory ? (
            <div className="app-inspector-list mt-2">
              {browserDirectory.parentPath ? (
                <button
                  type="button"
                  onClick={() => {
                    setBrowserSelectedArtifact(null);
                    setBrowserPath(browserDirectory.parentPath ?? null);
                  }}
                  className="app-inspector-source-row w-full text-left transition hover:bg-white/[0.02]"
                >
                  <div className="flex items-center gap-2 text-[12px] text-[color:var(--utility-foreground)]">
                    <ChevronLeft className="h-3.5 w-3.5" /> Parent folder
                  </div>
                </button>
              ) : null}
              {browserDirectory.entries.length > 0 ? browserDirectory.entries.map((entry) => {
                const entryKind = entry.kind === 'directory' ? 'file' : entry.kind;
                const Icon = entry.isDirectory ? FolderOpen : artifactIcon(entryKind, entry.path);
                const isSelected = browserSelectedArtifact?.path === entry.path;
                const entryLocation = compactArtifactLocation(entry.path, entry.name);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => {
                      if (entry.isDirectory) {
                        setBrowserSelectedArtifact(null);
                        setBrowserPath(entry.path);
                        return;
                      }
                      setBrowserSelectedArtifact(artifactFromDirectoryEntry(entry));
                    }}
                    className={cn(
                      'app-inspector-source-row w-full text-left transition',
                      isSelected ? 'bg-white/[0.04] ring-1 ring-white/10' : 'hover:bg-white/[0.02]',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <Icon className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                          <div className="min-w-0 truncate app-inspector-heading">{entry.name}</div>
                        </div>
                        {entryLocation ? <div className="mt-1 truncate app-inspector-subtext">{entryLocation}</div> : null}
                      </div>
                      <div className="shrink-0 text-[10px] text-slate-500">
                        {entry.isDirectory ? 'Folder' : formatFileSize(entry.sizeBytes)}
                      </div>
                    </div>
                  </button>
                );
              }) : (
                <div className="app-inspector-empty">This folder is empty.</div>
              )}
            </div>
          ) : null}
          </section>
        ) : null}

        {generatedArtifacts.length > 0 || relatedArtifacts.length > 0 ? (
          <>
          <ArtifactListSection
            title={generatedArtifacts.length > 0 ? 'Generated artifacts' : ''}
            section="generated"
            artifacts={generatedArtifacts}
            activeArtifact={activeArtifact}
            onSelect={(artifactId) => {
              setBrowserSelectedArtifact(null);
              onSelectArtifact(artifactId);
            }}
          />
          <ArtifactListSection
            title="Related changed files"
            section="related"
            artifacts={relatedArtifacts}
            activeArtifact={activeArtifact}
            onSelect={(artifactId) => {
              setBrowserSelectedArtifact(null);
              onSelectArtifact(artifactId);
            }}
          />
          </>
        ) : (
          <section className="app-detail-section">
            <div className="app-detail-kicker">Artifacts</div>
            <div className="app-inspector-empty">{emptyMessage}</div>
          </section>
        )}
      </div>

      {previewArtifact ? (
        <section data-artifact-preview-section="true" className="app-detail-section flex min-h-0 flex-1 flex-col border-t border-[color:var(--app-divider)] pt-[18px] pb-0">
          <div className="app-detail-kicker shrink-0">Preview</div>
          <div className="app-code-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] shadow-[var(--app-shadow-soft)]">
            <div className="app-code-toolbar flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2 text-[12px] text-slate-400">
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-200">{previewFileName}</div>
                {previewLocation ? (
                  <div className="truncate text-[10.5px] text-slate-500">{previewLocation}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {cachedPreview ? (
                  <button
                    type="button"
                    onClick={() => setPreviewWindowOpen(true)}
                    className="app-utility-button inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[10.5px] font-medium text-slate-300 transition hover:bg-white/[0.07] hover:text-white"
                    aria-label="Open preview window"
                    title="Open preview window"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    Open
                  </button>
                ) : null}
                <div className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-slate-400">
                  {previewKindLabel}
                </div>
              </div>
            </div>
            {isPreviewLoading ? (
              <div className="flex min-h-0 flex-1 items-center gap-2 px-4 py-4 text-[12px] text-slate-400">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Loading artifact preview…
              </div>
            ) : previewErrorDetails ? (
              <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
                <div className="text-[13px] font-medium text-[color:var(--utility-foreground)]">{previewErrorDetails.title}</div>
                <div className="mt-1 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">{previewErrorDetails.description}</div>
              </div>
            ) : cachedPreview ? (
              <>
                <div className="min-h-0 flex-1 overflow-auto">
                  {renderArtifactPreview(cachedPreview, 'rail')}
                </div>
                {cachedPreview.truncated ? (
                  <div className="border-t border-white/10 px-4 py-2 text-[11px] text-slate-500">
                    Preview truncated for large files.
                  </div>
                ) : null}
              </>
            ) : (
              <div className="min-h-0 flex-1 px-4 py-4 text-[12px] text-slate-500">
                {isNativeShell ? 'Select an artifact to load its preview.' : 'Artifact previews are available in the desktop app.'}
              </div>
            )}
          </div>
        </section>
      ) : null}

      {previewWindowOpen && cachedPreview ? (
        <ArtifactPreviewWindow
          preview={cachedPreview}
          title={previewFileName || cachedPreview.path}
          kindLabel={previewKindLabel}
          onClose={() => setPreviewWindowOpen(false)}
        />
      ) : null}

      {footer ? <div className="shrink-0">{footer}</div> : null}
    </div>
  );
}
