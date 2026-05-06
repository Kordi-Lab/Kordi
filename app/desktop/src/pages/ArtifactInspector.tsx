import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Braces, ChevronLeft, FileText, FolderOpen, LoaderCircle } from 'lucide-react';

import { MarkdownCodeBlock } from '@/kordi-app/components';
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

function artifactIcon(kind: SessionArtifact['kind']) {
  if (kind === 'code') return Braces;
  if (kind === 'document') return FileText;
  return FolderOpen;
}

function languageFromPath(path: string) {
  const extension = path.split('.').pop()?.trim().toLowerCase();
  if (!extension) return 'text';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'javascript';
  if (['ts', 'tsx'].includes(extension)) return 'typescript';
  if (['sh', 'zsh', 'bash'].includes(extension)) return 'bash';
  if (extension === 'rs') return 'rust';
  if (['yaml', 'yml'].includes(extension)) return 'yaml';
  if (extension === 'md') return 'markdown';
  return extension;
}

function renderPreview(preview: DesktopArtifactPreview) {
  if (preview.lines.length === 0) {
    return <div className="px-4 py-4 text-[12px] text-slate-400">This artifact is empty.</div>;
  }

  const source = preview.lines.map((line) => line.text).join('\n');
  return (
    <div className="p-3">
      <MarkdownCodeBlock
        language={languageFromPath(preview.path)}
        code={source}
        maxHeightClass="max-h-[32rem]"
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
      <div className="app-detail-kicker">{title}</div>
      {description ? <div className="mb-2 text-[11px] leading-5 text-[color:var(--utility-muted-text)]">{description}</div> : null}
      <div className="app-inspector-list">
        {artifacts.map((artifact) => {
          const Icon = artifactIcon(artifact.kind);
          const isActive = activeArtifact?.id === artifact.id;

          return (
            <button
              key={artifact.id}
              type="button"
              onClick={() => onSelect(artifact.id)}
              className={cn(
                'app-inspector-source-row w-full text-left transition',
                isActive ? 'bg-white/[0.04] ring-1 ring-white/10' : 'hover:bg-white/[0.02]',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                    <div className="min-w-0 truncate app-inspector-heading">{artifact.name}</div>
                    {artifact.pinned ? (
                      <span className="shrink-0 rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-amber-100">
                        pinned
                      </span>
                    ) : null}
                    <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-slate-400">
                      {artifact.kind}
                    </span>
                  </div>
                  <div className="mt-1 break-all app-inspector-subtext">{artifact.path}</div>
                  <div className="mt-1 app-inspector-text-block">{artifact.summary}</div>
                </div>
                <div className="shrink-0 text-[10px] text-slate-500">
                  {artifact.live ? 'Live' : artifact.timeLabel ?? 'Ready'}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
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

  const folderBrowserRootPath = folderBrowserRoot?.trim() ?? '';
  const effectiveBrowserPath = useMemo(() => {
    if (!browserPath || !folderBrowserRootPath) return browserPath;
    return browserPath === folderBrowserRootPath || browserPath.startsWith(`${folderBrowserRootPath}/`)
      ? browserPath
      : null;
  }, [browserPath, folderBrowserRootPath]);

  const generatedArtifacts = useMemo(() => artifacts.filter((artifact) => artifactCategory(artifact) === 'artifact'), [artifacts]);
  const relatedArtifacts = useMemo(() => artifacts.filter((artifact) => artifactCategory(artifact) === 'related'), [artifacts]);
  const memoryArtifacts = useMemo(() => artifacts.filter((artifact) => artifactCategory(artifact) === 'memory'), [artifacts]);
  const activeArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.id === activeArtifactId)
      ?? generatedArtifacts[0]
      ?? relatedArtifacts[0]
      ?? memoryArtifacts[0]
      ?? null,
    [activeArtifactId, artifacts, generatedArtifacts, memoryArtifacts, relatedArtifacts],
  );
  const previewArtifact = browserSelectedArtifact ?? activeArtifact;
  const effectivePreviewBaseRoot = previewArtifact?.pinned ? null : previewBaseRoot;
  const activePreviewKey = previewArtifact
    ? `${effectivePreviewBaseRoot ?? ''}:${previewArtifact.id}:${previewArtifact.timeLabel ?? ''}:${previewArtifact.live ? 'live' : 'ready'}`
    : null;
  const cachedPreview = activePreviewKey ? previewCache[activePreviewKey] ?? null : null;
  const previewErrorDetails = previewError ? previewErrorCopy(previewError, previewArtifact) : null;

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
    <>
      {folderBrowserRootPath ? (
        <section className="app-detail-section">
          <div className="app-detail-kicker">Project folder</div>
          <div className="app-inspector-emphasis">
            <div className="break-all font-mono text-[11px] text-[color:var(--utility-foreground)]">
              {browserDirectory?.path ?? folderBrowserRootPath}
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
                const Icon = entry.isDirectory ? FolderOpen : artifactIcon(entry.kind === 'directory' ? 'file' : entry.kind);
                const isSelected = browserSelectedArtifact?.path === entry.path;
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
                        <div className="mt-1 break-all app-inspector-subtext">{entry.path}</div>
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

      {artifacts.length > 0 ? (
        <>
          <ArtifactListSection
            title="Artifacts"
            section="generated"
            description="Generated work products worth reopening, refining, or sharing."
            artifacts={generatedArtifacts}
            activeArtifact={activeArtifact}
            onSelect={(artifactId) => {
              setBrowserSelectedArtifact(null);
              onSelectArtifact(artifactId);
            }}
          />
          <ArtifactListSection
            title="Related files"
            section="related"
            description="Source, config, package, and referenced files touched while producing the work."
            artifacts={relatedArtifacts}
            activeArtifact={activeArtifact}
            onSelect={(artifactId) => {
              setBrowserSelectedArtifact(null);
              onSelectArtifact(artifactId);
            }}
          />
          <ArtifactListSection
            title="Memory"
            section="memory"
            description="Scoped Kordi memory related to this session."
            artifacts={memoryArtifacts}
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

      {previewArtifact ? (
        <section className="app-detail-section">
          <div className="app-detail-kicker">Preview</div>
          <div className="app-code-panel overflow-hidden rounded-[20px] shadow-[var(--app-shadow-soft)]">
            <div className="app-code-toolbar border-b border-white/10 px-4 py-2 text-[12px] text-slate-400">
              <div className="truncate">{previewArtifact.path}</div>
            </div>
            {isPreviewLoading ? (
              <div className="flex items-center gap-2 px-4 py-4 text-[12px] text-slate-400">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Loading artifact preview…
              </div>
            ) : previewErrorDetails ? (
              <div className="px-4 py-4">
                <div className="text-[13px] font-medium text-[color:var(--utility-foreground)]">{previewErrorDetails.title}</div>
                <div className="mt-1 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">{previewErrorDetails.description}</div>
              </div>
            ) : cachedPreview ? (
              <>
                {renderPreview(cachedPreview)}
                {cachedPreview.truncated ? (
                  <div className="border-t border-white/10 px-4 py-2 text-[11px] text-slate-500">
                    Preview truncated for large files.
                  </div>
                ) : null}
              </>
            ) : (
              <div className="px-4 py-4 text-[12px] text-slate-500">
                {isNativeShell ? 'Select an artifact to load its preview.' : 'Artifact previews are available in the desktop app.'}
              </div>
            )}
          </div>
        </section>
      ) : null}

      {footer}
    </>
  );
}
