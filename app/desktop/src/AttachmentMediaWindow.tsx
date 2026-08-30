import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

import { syncNativeWindowTheme } from '@/app/nativeWindowTheme';
import { readStoredThemeMode, resolveThemeMode } from '@/app/themePreference';
import {
  ATTACHMENT_MEDIA_WINDOW_LABEL,
  readAttachmentMediaPayload,
  subscribeToAttachmentMediaWindowPayload,
  type AttachmentMediaWindowPayload,
} from '@/features/chat/attachmentMediaWindow';
import { attachmentMediaZoomActionForKey, nextAttachmentMediaZoom } from '@/features/chat/attachmentMediaZoom';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadVisibleCloudAttachmentPreview, type CloudAttachmentPreviewLease } from '@/features/cloud/cloudAttachments';
import { loadSession } from '@/features/cloud/session';
import {
  attachmentPreviewIdentity,
  attachmentPreviewUrl,
  attachmentVideoUrl,
  isAnimatedGifAttachment,
  isMp4VideoAttachment,
} from '@/features/chat/attachmentMediaGallery';
import {
  AttachmentContextMenu,
  recoverAttachmentPreviewOnce,
  type AttachmentContextMenuState,
} from '@/kordi-app/components/transcriptAttachments';
import {
  AttachmentImageLightbox,
  AttachmentVideoLightbox,
} from '@/kordi-app/components/transcriptAttachmentLightbox';
import type { MessageAttachment } from '@/kordi-app/types';
import type { ResolvedThemeMode } from '@/kordi-app/types';

type PreviewState = {
  attachmentIdentity: string;
  status: 'loading' | 'ready' | 'unavailable';
  url: string | null;
};

function isNativeDesktopShell() {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

async function closeMediaWindow() {
  if (isNativeDesktopShell()) {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    await getCurrentWebviewWindow().close();
    return;
  }
  window.close();
}

async function revealMediaWindow(requestId: string) {
  if (!isNativeDesktopShell()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('desktop_reveal_media_preview_window', { requestId });
}

function requestIdFromLocation() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('mediaPreviewRequest')?.trim() ?? '';
}

function initialMediaWindowTheme(): ResolvedThemeMode {
  const systemTheme = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
  return resolveThemeMode(readStoredThemeMode(), systemTheme);
}

export default function AttachmentMediaWindow() {
  const [requestId] = useState(() => requestIdFromLocation());
  const [payload, setPayload] = useState<AttachmentMediaWindowPayload | null>(() => (
    requestId ? readAttachmentMediaPayload(requestId) : null
  ));
  const [selectedIndex, setSelectedIndex] = useState(() => payload?.selectedIndex ?? 0);
  const [zoom, setZoom] = useState(1);
  const [theme, setTheme] = useState<ResolvedThemeMode>(initialMediaWindowTheme);
  const [failedDirectIdentity, setFailedDirectIdentity] = useState<string | null>(null);
  const [failedVideoIdentity, setFailedVideoIdentity] = useState<string | null>(null);
  const [remotePreview, setRemotePreview] = useState<PreviewState>({
    attachmentIdentity: '',
    status: 'loading',
    url: null,
  });
  const [contextMenuState, setContextMenuState] = useState<AttachmentContextMenuState | null>(null);
  const previewLeaseRef = useRef<CloudAttachmentPreviewLease | null>(null);
  const windowRevealedRef = useRef(false);

  const revealWindow = useCallback(() => {
    if (windowRevealedRef.current) return;
    windowRevealedRef.current = true;
    void revealMediaWindow(requestId).catch(() => {
      windowRevealedRef.current = false;
    });
  }, [requestId]);

  useEffect(() => {
    document.documentElement.classList.add('app-attachment-media-window-root');
    document.body.classList.add('app-attachment-media-window-root');
    return () => {
      document.documentElement.classList.remove('app-attachment-media-window-root');
      document.body.classList.remove('app-attachment-media-window-root');
    };
  }, []);

  useEffect(() => {
    if (!requestId) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeToAttachmentMediaWindowPayload(requestId, (nextPayload) => {
      if (disposed) return;
      setPayload(nextPayload);
      setSelectedIndex(nextPayload.selectedIndex);
      setZoom(1);
      setFailedVideoIdentity(null);
      if (nextPayload.theme) setTheme(nextPayload.theme);
    }).then((nextUnsubscribe) => {
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [requestId]);

  useEffect(() => {
    document.documentElement.dataset.attachmentMediaTheme = theme;
    document.documentElement.style.colorScheme = theme;
    void syncNativeWindowTheme(theme).catch(() => undefined);
    return () => {
      delete document.documentElement.dataset.attachmentMediaTheme;
    };
  }, [theme]);

  const attachment = payload?.attachments[selectedIndex] ?? null;
  const attachmentIdentity = attachment ? attachmentPreviewIdentity(attachment) : null;
  const isVideo = attachment ? isMp4VideoAttachment(attachment) : false;
  const initialPreviewUrl = payload && selectedIndex === payload.selectedIndex
    ? payload.initialPreviewUrl?.trim() || null
    : null;
  const initialMediaUrl = payload && selectedIndex === payload.selectedIndex
    ? payload.initialMediaUrl?.trim() || null
    : null;
  const initialMediaTime = payload && selectedIndex === payload.selectedIndex
    ? payload.initialMediaTime ?? 0
    : 0;
  const directPreviewUrl = attachment ? initialPreviewUrl || attachmentPreviewUrl(attachment) || null : null;
  const directVideoUrl = attachment ? initialMediaUrl || attachmentVideoUrl(attachment) || null : null;
  const usableVideoUrl = directVideoUrl && failedVideoIdentity !== attachmentIdentity
    ? directVideoUrl
    : null;
  const usableDirectPreviewUrl = directPreviewUrl && failedDirectIdentity !== attachmentIdentity
    ? directPreviewUrl
    : null;
  const preview = usableDirectPreviewUrl
    ? { status: 'ready' as const, url: usableDirectPreviewUrl, source: 'direct' as const }
    : remotePreview.attachmentIdentity === attachmentIdentity
      ? { status: remotePreview.status, url: remotePreview.url, source: 'remote' as const }
      : { status: 'loading' as const, url: null, source: null };

  useEffect(() => {
    if ((isVideo && !usableVideoUrl) || (!isVideo && preview.status === 'unavailable')) revealWindow();
  }, [isVideo, preview.status, revealWindow, usableVideoUrl]);

  useEffect(() => {
    previewLeaseRef.current?.release();
    previewLeaseRef.current = null;
    if (!payload || !attachment || !attachmentIdentity || isVideo) return;

    if (usableDirectPreviewUrl) return;

    const controller = new AbortController();
    void (async () => {
      if (!isAnimatedGifAttachment(attachment) && !attachment.previewAttachmentId) {
        const recoveredUrl = await recoverAttachmentPreviewOnce(attachment);
        if (controller.signal.aborted) return;
        if (recoveredUrl && recoveredUrl !== directPreviewUrl) {
          setRemotePreview({ attachmentIdentity, status: 'ready', url: recoveredUrl });
          return;
        }
      }

      const attachmentId = attachment.attachmentId?.trim();
      if (!attachmentId) {
        setRemotePreview({ attachmentIdentity, status: 'unavailable', url: null });
        return;
      }
      const session = await loadSession();
      if (!session?.token || controller.signal.aborted) {
        if (!controller.signal.aborted) setRemotePreview({ attachmentIdentity, status: 'unavailable', url: null });
        return;
      }
      const lease = await loadVisibleCloudAttachmentPreview({
        token: session.token,
        client: defaultCloudAuthClient(),
        attachment: {
          attachmentId,
          previewAttachmentId: attachment.previewAttachmentId ?? null,
          name: attachment.name,
          kind: 'image',
          mimeType: attachment.mimeType ?? null,
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        lease?.release();
        return;
      }
      if (!lease) {
        setRemotePreview({ attachmentIdentity, status: 'unavailable', url: null });
        return;
      }
      previewLeaseRef.current = lease;
      setRemotePreview({ attachmentIdentity, status: 'ready', url: lease.previewUrl });
    })().catch((error) => {
      if (!controller.signal.aborted && (!(error instanceof Error) || error.name !== 'AbortError')) {
        setRemotePreview({ attachmentIdentity, status: 'unavailable', url: null });
      }
    });
    return () => controller.abort();
  }, [attachment, attachmentIdentity, directPreviewUrl, isVideo, payload, usableDirectPreviewUrl]);

  useEffect(() => () => {
    previewLeaseRef.current?.release();
    previewLeaseRef.current = null;
  }, []);

  const navigate = useCallback((direction: -1 | 1) => {
    setContextMenuState(null);
    setZoom(1);
    setSelectedIndex((current) => {
      if (!payload) return current;
      return Math.min(Math.max(0, current + direction), payload.attachments.length - 1);
    });
  }, [payload]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setContextMenuState(null);
        void closeMediaWindow();
        return;
      }
      if (contextMenuState) return;
      if (!isVideo) {
        const zoomAction = attachmentMediaZoomActionForKey(event);
        if (zoomAction) {
          event.preventDefault();
          setZoom((current) => nextAttachmentMediaZoom(current, zoomAction));
          return;
        }
        if (event.key === 'ArrowLeft' && selectedIndex > 0) {
          event.preventDefault();
          navigate(-1);
        }
        if (event.key === 'ArrowRight' && payload && selectedIndex < payload.attachments.length - 1) {
          event.preventDefault();
          navigate(1);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [contextMenuState, isVideo, navigate, payload, selectedIndex]);

  const openContextMenu = useCallback((event: MouseEvent) => {
    if (!attachment) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenuState({ attachment, x: event.clientX, y: event.clientY });
  }, [attachment]);

  if (!requestId) {
    return <div className="app-attachment-media-window-status" role="alert">This media preview is no longer available.</div>;
  }

  if (!payload || !attachment) {
    return <div className="app-attachment-media-window-status" role="status">Opening media…</div>;
  }

  return (
    <>
      {isVideo ? (
        <AttachmentVideoLightbox
          attachment={attachment}
          videoUrl={usableVideoUrl}
          posterUrl={initialPreviewUrl}
          initialTime={initialMediaTime}
          onVideoLoad={revealWindow}
          onVideoError={() => {
            if (attachmentIdentity) setFailedVideoIdentity(attachmentIdentity);
            revealWindow();
          }}
          onClose={() => void closeMediaWindow()}
          onContextMenu={openContextMenu}
        />
      ) : (
        <AttachmentImageLightbox
          attachment={attachment}
          previewUrl={preview.url}
          previewStatus={preview.status}
          onImageLoad={revealWindow}
          onImageError={() => {
            if (preview.source === 'direct' && attachmentIdentity) {
              setFailedDirectIdentity(attachmentIdentity);
            } else {
              previewLeaseRef.current?.release();
              previewLeaseRef.current = null;
              setRemotePreview({ attachmentIdentity: attachmentIdentity ?? '', status: 'unavailable', url: null });
            }
          }}
          onClose={() => void closeMediaWindow()}
          canGoPrevious={selectedIndex > 0}
          canGoNext={selectedIndex < payload.attachments.length - 1}
          onPrevious={() => navigate(-1)}
          onNext={() => navigate(1)}
          onContextMenu={openContextMenu}
          positionLabel={`${selectedIndex + 1} of ${payload.attachments.length}`}
          zoom={zoom}
          onZoomIn={() => setZoom((current) => nextAttachmentMediaZoom(current, 'in'))}
          onZoomOut={() => setZoom((current) => nextAttachmentMediaZoom(current, 'out'))}
          onZoomReset={() => setZoom(1)}
        />
      )}
      {contextMenuState ? (
        <AttachmentContextMenu state={contextMenuState} onClose={() => setContextMenuState(null)} />
      ) : null}
      <span className="sr-only">Native media window {ATTACHMENT_MEDIA_WINDOW_LABEL}</span>
    </>
  );
}
