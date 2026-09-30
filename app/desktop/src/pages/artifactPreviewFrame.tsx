import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  closeDesktopArtifactPreviewDocument,
  isNativeDesktopShell,
  openDesktopArtifactPreviewDocument,
} from '@/lib/desktop';
import { cn } from '@/lib/utils';

/** Must match `ARTIFACT_PREVIEW_SCHEME` in `src-tauri/src/chat/artifacts/preview_document.rs`. */
export const ARTIFACT_PREVIEW_SCHEME = 'kordi-artifact-preview';

/** Previews run scripts but always keep an opaque origin. */
export const ARTIFACT_PREVIEW_SANDBOX = 'allow-forms allow-popups allow-scripts';

type ArtifactPreviewFrameProps = {
  title: string;
  source: string;
  className?: string;
};

type LoadedPreview = {
  source: string;
  src: string | null;
  error: string | null;
};

/**
 * Shows an HTML or SVG artifact in a sandboxed frame. In the desktop app the
 * document is served from its own URI scheme so it gets the preview policy
 * instead of inheriting the app's Content-Security-Policy, which would block
 * the page's inline and CDN scripts, styles, and fonts.
 */
export function ArtifactPreviewFrame({ title, source, className }: ArtifactPreviewFrameProps) {
  const nativeShell = isNativeDesktopShell();
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);

  useEffect(() => {
    if (!nativeShell) return undefined;
    let active = true;
    let token: string | null = null;
    openDesktopArtifactPreviewDocument(source).then(
      (opened) => {
        if (!active) {
          void closeDesktopArtifactPreviewDocument(opened).catch(() => undefined);
          return;
        }
        token = opened;
        setLoaded({ source, src: convertFileSrc(opened, ARTIFACT_PREVIEW_SCHEME), error: null });
      },
      (error: unknown) => {
        if (!active) return;
        const message = error instanceof Error && error.message ? error.message : 'This preview could not be loaded.';
        setLoaded({ source, src: null, error: message });
      },
    );
    return () => {
      active = false;
      if (token) void closeDesktopArtifactPreviewDocument(token).catch(() => undefined);
    };
  }, [source, nativeShell]);

  if (!nativeShell) {
    return <iframe title={title} srcDoc={source} sandbox={ARTIFACT_PREVIEW_SANDBOX} className={className} />;
  }

  const current = loaded?.source === source ? loaded : null;
  if (current?.error) {
    return (
      <div
        role="status"
        data-artifact-preview-state="error"
        className={cn(className, 'grid place-items-center px-4 text-center text-[12px] text-slate-500')}
      >
        {current.error}
      </div>
    );
  }

  return (
    <iframe
      title={title}
      src={current?.src ?? undefined}
      sandbox={ARTIFACT_PREVIEW_SANDBOX}
      aria-busy={current?.src ? undefined : true}
      data-artifact-preview-state={current?.src ? 'ready' : 'loading'}
      className={className}
    />
  );
}
