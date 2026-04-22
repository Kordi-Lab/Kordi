import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Braces, FileText, FolderOpen, LoaderCircle } from 'lucide-react';

import type { DesktopArtifactPreview, SessionArtifact } from '@/kordi-app/types';
import { fetchDesktopChatArtifactPreview } from '@/lib/desktop';
import { cn } from '@/lib/utils';

type ArtifactInspectorProps = {
  isNativeShell: boolean;
  artifacts: SessionArtifact[];
  activeArtifactId: string | null;
  onSelectArtifact: (artifactId: string | null) => void;
  emptyMessage: string;
  footer?: ReactNode;
};

function artifactIcon(kind: SessionArtifact['kind']) {
  if (kind === 'code') return Braces;
  if (kind === 'document') return FileText;
  return FolderOpen;
}

function renderPreview(preview: DesktopArtifactPreview) {
  if (preview.lines.length === 0) {
    return <div className="px-4 py-4 text-[12px] text-slate-400">This artifact is empty.</div>;
  }

  return (
    <div className="font-mono text-[12px] leading-7">
      {preview.lines.map((line) => (
        <div key={`${preview.path}-${line.number}`} className="grid grid-cols-[56px_minmax(0,1fr)] px-4">
          <div className="select-none pr-3 text-right text-slate-500">{line.number}</div>
          <code className="block min-w-0 overflow-hidden text-ellipsis whitespace-pre-wrap break-words text-slate-200">
            {line.text}
          </code>
        </div>
      ))}
    </div>
  );
}

export function ArtifactInspector({
  isNativeShell,
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  emptyMessage,
  footer,
}: ArtifactInspectorProps) {
  const [previewCache, setPreviewCache] = useState<Record<string, DesktopArtifactPreview>>({});
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const activeArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.id === activeArtifactId) ?? artifacts[0] ?? null,
    [activeArtifactId, artifacts],
  );
  const activePreviewKey = activeArtifact
    ? `${activeArtifact.id}:${activeArtifact.timeLabel ?? ''}:${activeArtifact.live ? 'live' : 'ready'}`
    : null;
  const cachedPreview = activePreviewKey ? previewCache[activePreviewKey] ?? null : null;

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

    onSelectArtifact(artifacts[0].id);
  }, [activeArtifactId, artifacts, onSelectArtifact]);

  useEffect(() => {
    setPreviewError(null);

    if (!activeArtifact?.id || !isNativeShell || cachedPreview) {
      setIsPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setIsPreviewLoading(true);

    fetchDesktopChatArtifactPreview(activeArtifact.path)
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
  }, [activeArtifact?.id, activeArtifact?.path, activePreviewKey, cachedPreview, isNativeShell]);

  return (
    <>
      <section className="app-detail-section">
        <div className="app-detail-kicker">Generated artifacts</div>
        {artifacts.length > 0 ? (
          <div className="app-inspector-list">
            {artifacts.map((artifact) => {
              const Icon = artifactIcon(artifact.kind);
              const isActive = activeArtifact?.id === artifact.id;

              return (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => onSelectArtifact(artifact.id)}
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
        ) : (
          <div className="app-inspector-empty">{emptyMessage}</div>
        )}
      </section>

      {activeArtifact ? (
        <section className="app-detail-section">
          <div className="app-detail-kicker">Preview</div>
          <div className="app-code-panel overflow-hidden rounded-[20px] shadow-[var(--app-shadow-soft)]">
            <div className="app-code-toolbar border-b border-white/10 px-4 py-2 text-[12px] text-slate-400">
              <div className="truncate">{activeArtifact.path}</div>
            </div>
            {isPreviewLoading ? (
              <div className="flex items-center gap-2 px-4 py-4 text-[12px] text-slate-400">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Loading artifact preview…
              </div>
            ) : previewError ? (
              <div className="px-4 py-4 text-[12px] text-rose-200">{previewError}</div>
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
