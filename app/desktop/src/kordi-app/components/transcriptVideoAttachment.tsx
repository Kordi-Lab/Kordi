import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LoaderCircle, Play, RotateCcw } from 'lucide-react';

import {
  attachmentVideoDisplaySize,
  attachmentVideoUrl,
  playableVideoSource,
} from '@/features/chat/attachmentMediaGallery';
import {
  displayAttachmentName,
  videoPreviewFromSource,
} from '@/features/chat/composerAttachments';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { cloudAttachmentPlaybackUrl } from '@/features/cloud/cloudAttachmentPlayback';
import { loadVisibleCloudAttachmentPreview } from '@/features/cloud/cloudAttachments';
import {
  cancelCloudAttachmentUpload,
  cloudAttachmentUploadSnapshot,
  resolveCloudAttachmentUploadProgress,
  subscribeCloudAttachmentUpload,
} from '@/features/cloud/cloudAttachmentUpload';
import {
  cacheCloudAttachmentLocalPath,
  loadCachedCloudAttachmentLocalPath,
} from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import {
  imagePixelDimensionsFromUrl,
  normalizedImagePixelDimensions,
} from '@/lib/imageDimensions';
import { isNativeDesktopShell } from '@/lib/desktop';
import { downloadDesktopCloudAttachment } from '@/lib/desktopCloudAttachmentCache';
import type { MessageAttachment } from '../types';
import { AttachmentImageLoadingSurface } from './transcriptAttachmentImageSurfaces';
import { TranscriptImageDeliveryOverlay } from './transcriptImageDeliveryOverlay';
import { attachmentImageDeliveryVisual } from './transcriptImageDeliveryVisual';

type CachedVideoPresentation = {
  posterUrl: string;
  widthPixels: number;
  heightPixels: number;
};

const videoPresentationCache = new Map<string, CachedVideoPresentation>();

function cacheVideoPresentation(key: string, presentation: CachedVideoPresentation) {
  videoPresentationCache.delete(key);
  videoPresentationCache.set(key, presentation);
  while (videoPresentationCache.size > 128) {
    const oldest = videoPresentationCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    videoPresentationCache.delete(oldest);
  }
}

export function AttachmentVideoCard({
  attachment,
  deliveryStatus,
  time,
  onRetry,
}: {
  attachment: MessageAttachment;
  deliveryStatus?: string | null;
  time?: string | null;
  onRetry?: () => void;
}) {
  const attachmentId = attachment.attachmentId?.trim() ?? '';
  const presentationCacheKey = attachmentId
    || attachment.localPath?.trim()
    || `${attachment.name}:${attachment.sizeBytes ?? ''}`;
  const cachedPresentation = videoPresentationCache.get(presentationCacheKey) ?? null;
  const [localPath, setLocalPath] = useState<string | null>(attachment.localPath?.trim() || null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>(() => (
    attachmentVideoUrl(attachment) ? 'ready' : 'idle'
  ));
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const directPosterUrl = attachment.previewUrl?.startsWith('data:image/')
    ? attachment.previewUrl
    : null;
  const [remotePosterUrl, setRemotePosterUrl] = useState<string | null>(
    cachedPresentation?.posterUrl ?? null,
  );
  const [localPosterUrl, setLocalPosterUrl] = useState<string | null>(null);
  const [localVideoDimensions, setLocalVideoDimensions] = useState<{
    widthPixels: number;
    heightPixels: number;
  } | null>(cachedPresentation ? {
    widthPixels: cachedPresentation.widthPixels,
    heightPixels: cachedPresentation.heightPixels,
  } : null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimer = useRef<number | null>(null);
  const downloadedLocalPath = useRef<string | null>(null);
  const playbackEnded = useRef(false);
  const localSource = attachmentVideoUrl(localPath ? { ...attachment, localPath } : attachment);
  const posterUrl = directPosterUrl ?? remotePosterUrl ?? localPosterUrl;
  const declaredVideoDimensions = normalizedImagePixelDimensions(
    attachment.widthPixels,
    attachment.heightPixels,
  );
  const videoDimensions = localVideoDimensions ?? declaredVideoDimensions;
  const displaySize = attachmentVideoDisplaySize(videoDimensions ?? attachment);
  const source = playableVideoSource(localSource, playbackUrl, failedSource);
  const posterGenerationSource = localSource ?? (playbackRequested ? playbackUrl : null);
  const uploadPath = attachment.localPath?.trim() ?? '';
  const upload = useSyncExternalStore(
    (listener) => subscribeCloudAttachmentUpload(uploadPath, listener),
    () => cloudAttachmentUploadSnapshot(uploadPath),
    () => null,
  );
  const resolvedUpload = resolveCloudAttachmentUploadProgress(upload, attachment.sizeBytes);
  const uploadIsActive = upload
    && ['preparing', 'uploading', 'finishing'].includes(upload.phase);
  const uploadFailure = upload?.phase === 'failed'
    ? upload.error ?? 'Sending failed'
    : upload?.phase === 'cancelled' ? 'Sending cancelled' : null;
  const deliveryVisual = attachmentImageDeliveryVisual(deliveryStatus, uploadFailure);
  const videoDeliveryVisual = deliveryVisual ? {
    ...deliveryVisual,
    label: deliveryVisual.label.replace('image', 'video'),
  } : null;
  const transferPending = deliveryVisual?.kind === 'uploading'
    || deliveryVisual?.kind === 'delivering';

  const rememberPresentation = useCallback((
    nextPosterUrl: string,
    dimensions: { widthPixels: number; heightPixels: number },
    source: 'local' | 'remote',
  ) => {
    setLocalVideoDimensions(dimensions);
    if (source === 'remote') setRemotePosterUrl(nextPosterUrl);
    else setLocalPosterUrl(nextPosterUrl);
    cacheVideoPresentation(presentationCacheKey, {
      posterUrl: nextPosterUrl,
      ...dimensions,
    });
  }, [presentationCacheKey]);

  const clearControlsTimer = useCallback(() => {
    if (controlsTimer.current !== null) {
      window.clearTimeout(controlsTimer.current);
      controlsTimer.current = null;
    }
  }, []);

  const showControlsBriefly = useCallback(() => {
    clearControlsTimer();
    setControlsVisible(true);
    controlsTimer.current = window.setTimeout(() => {
      controlsTimer.current = null;
      setControlsVisible(false);
    }, 1_000);
  }, [clearControlsTimer]);

  const keepControlsVisible = useCallback(() => {
    clearControlsTimer();
    setControlsVisible(true);
  }, [clearControlsTimer]);

  useEffect(() => clearControlsTimer, [clearControlsTimer]);

  useEffect(() => {
    if (source || !attachmentId) return;
    let cancelled = false;
    void loadCachedCloudAttachmentLocalPath(attachmentId, attachment.name).then((cached) => {
      if (!cancelled && cached) {
        setLocalPath(cached);
        setPhase('ready');
      }
    });
    return () => { cancelled = true; };
  }, [attachment.name, attachmentId, source]);

  useEffect(() => {
    if (videoDimensions || !directPosterUrl) return;
    let cancelled = false;
    void imagePixelDimensionsFromUrl(directPosterUrl).then((dimensions) => {
      if (!cancelled && dimensions) {
        rememberPresentation(directPosterUrl, dimensions, 'local');
      }
    });
    return () => { cancelled = true; };
  }, [directPosterUrl, rememberPresentation, videoDimensions]);

  useEffect(() => {
    if (directPosterUrl || remotePosterUrl || !attachmentId) return;
    const controller = new AbortController();
    let previewLease: Awaited<ReturnType<typeof loadVisibleCloudAttachmentPreview>> = null;
    void loadSession().then(async (session) => {
      if (!session?.token || controller.signal.aborted) return;
      const loaded = await loadVisibleCloudAttachmentPreview({
        token: session.token,
        client: defaultCloudAuthClient(),
        attachment: {
          attachmentId,
          previewAttachmentId: attachment.previewAttachmentId ?? null,
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType ?? null,
        },
        signal: controller.signal,
      })
        .catch(() => null);
      if (!loaded || controller.signal.aborted) return;
      previewLease = loaded;
      const dimensions = await imagePixelDimensionsFromUrl(loaded.previewUrl);
      if (controller.signal.aborted || !dimensions) return;
      rememberPresentation(loaded.previewUrl, dimensions, 'remote');
    });
    return () => {
      controller.abort();
      previewLease?.release();
    };
  }, [
    attachment.kind,
    attachment.mimeType,
    attachment.name,
    attachment.previewAttachmentId,
    attachmentId,
    directPosterUrl,
    rememberPresentation,
    remotePosterUrl,
  ]);

  useEffect(() => {
    if (directPosterUrl || remotePosterUrl || localPosterUrl || !posterGenerationSource) return;
    let cancelled = false;
    void videoPreviewFromSource(posterGenerationSource).then((preview) => {
      if (!cancelled && preview) {
        rememberPresentation(preview.previewUrl, {
          widthPixels: preview.widthPixels,
          heightPixels: preview.heightPixels,
        }, 'local');
      }
    });
    return () => { cancelled = true; };
  }, [
    directPosterUrl,
    localPosterUrl,
    posterGenerationSource,
    rememberPresentation,
    remotePosterUrl,
  ]);

  const requestCloudPlayback = useCallback(async () => {
    if (!attachmentId) return;
    setPhase('loading');
    try {
      const session = await loadSession();
      if (!session?.token) throw new Error('Sign in to play this video.');
      const url = await cloudAttachmentPlaybackUrl(
        defaultCloudAuthClient(),
        session.token,
        attachmentId,
      );
      setPlaybackUrl(url);
      setPhase('ready');
      playbackEnded.current = false;
      setPlaybackRequested(true);
      if (isNativeDesktopShell()) {
        // ponytail: playback and durable caching use separate transfers until
        // the native downloader can expose a growing range-readable file.
        void downloadDesktopCloudAttachment(
          session.token,
          attachmentId,
          attachment.name,
        ).then((path) => {
          cacheCloudAttachmentLocalPath(attachmentId, path);
          downloadedLocalPath.current = path;
          if (playbackEnded.current) {
            setFailedSource(null);
            setLocalPath(path);
          }
        }).catch(() => undefined);
      }
    } catch {
      setPhase('error');
    }
  }, [attachment.name, attachmentId]);

  const loadVideo = useCallback(async () => {
    if (phase === 'loading') return;
    if (source) {
      setPlaybackRequested(true);
      return;
    }
    await requestCloudPlayback();
  }, [phase, requestCloudPlayback, source]);

  if (!videoDimensions) {
    return (
      <div
        data-attachment-video-card="true"
        data-attachment-video-sizing="resolving"
        className="relative max-w-full overflow-hidden rounded-[16px]"
        style={{ width: 244, maxWidth: '70vw', aspectRatio: '244 / 154' }}
      >
        <AttachmentImageLoadingSurface
          className="absolute inset-0 w-full"
          style={{ width: '100%', height: '100%' }}
        />
        <div className="absolute inset-0 grid place-items-center">
          {phase === 'loading' ? (
            <span className="grid h-12 w-12 place-items-center rounded-full bg-white/80 shadow-sm" role="status" aria-label="Preparing video preview">
              <LoaderCircle className="h-5 w-5 animate-spin text-[color:var(--utility-muted-text)] motion-reduce:animate-none" aria-hidden="true" />
            </span>
          ) : (
            <button
              type="button"
              onClick={() => { void loadVideo(); }}
              className="grid h-12 w-12 place-items-center rounded-full bg-black/55 text-white shadow-sm outline-none transition hover:bg-black/65 focus-visible:ring-2 focus-visible:ring-[color:var(--app-sidebar-accent)]"
              aria-label={phase === 'error' ? `Retry loading ${attachment.name}` : `Play ${attachment.name}`}
            >
              {phase === 'error'
                ? <RotateCcw className="h-5 w-5" aria-hidden="true" />
                : <Play className="h-5 w-5 translate-x-px fill-current" aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-attachment-video-card="true"
      className="max-w-full overflow-hidden rounded-[16px] bg-[color:var(--app-control-bg)] text-white"
      style={{ width: displaySize.width, maxWidth: 'min(100%, 70vw)' }}
    >
      <div
        className="relative w-full overflow-hidden bg-[color:var(--app-control-bg)]"
        style={{ aspectRatio: `${displaySize.width} / ${displaySize.height}` }}
      >
        {source && playbackRequested && !transferPending ? (
          <video
            src={source}
            controls={controlsVisible}
            autoPlay
            playsInline
            preload="metadata"
            poster={posterUrl ?? undefined}
            className="block h-full w-full object-contain"
            aria-label={`Play ${displayAttachmentName(attachment.name, attachment.kind)}`}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth > 0 && videoHeight > 0) {
                const dimensions = { widthPixels: videoWidth, heightPixels: videoHeight };
                if (posterUrl) rememberPresentation(posterUrl, dimensions, 'local');
                else setLocalVideoDimensions(dimensions);
              }
            }}
            onClick={showControlsBriefly}
            onPlay={showControlsBriefly}
            onPause={keepControlsVisible}
            onEnded={() => {
              keepControlsVisible();
              playbackEnded.current = true;
              setPlaybackRequested(false);
              if (downloadedLocalPath.current) {
                setFailedSource(null);
                setLocalPath(downloadedLocalPath.current);
              }
            }}
            onError={() => {
              setPlaybackRequested(false);
              setFailedSource(source);
              if (source === localSource && attachmentId) {
                void requestCloudPlayback();
              } else {
                setPhase('error');
              }
            }}
          />
        ) : (
          <div className="relative flex h-full flex-col items-center justify-center gap-3 overflow-hidden px-5 py-6 text-center">
            {posterUrl ? (
              <img
                src={posterUrl}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                aria-hidden="true"
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (naturalWidth > 0 && naturalHeight > 0) {
                    rememberPresentation(posterUrl, {
                      widthPixels: naturalWidth,
                      heightPixels: naturalHeight,
                    }, posterUrl === remotePosterUrl ? 'remote' : 'local');
                  }
                }}
              />
            ) : null}
            <div className={`absolute inset-0 ${posterUrl ? 'bg-black/30' : 'bg-transparent'}`} aria-hidden="true" />
            {!transferPending && phase === 'loading' ? (
              <span
                className="relative grid h-14 w-14 place-items-center rounded-full bg-white/20 text-white"
                role="status"
                aria-label={`Loading ${attachment.name}`}
              >
                <LoaderCircle className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              </span>
            ) : !transferPending && (source || attachmentId) ? (
              <button
                type="button"
                onClick={() => { void loadVideo(); }}
                className="relative grid h-14 w-14 place-items-center rounded-full bg-white/20 text-white outline-none transition hover:bg-white/30 active:scale-95 focus-visible:ring-2 focus-visible:ring-white/90 motion-reduce:active:scale-100"
                aria-label={phase === 'error' ? `Retry loading ${attachment.name}` : `Play ${attachment.name}`}
              >
                {phase === 'error'
                  ? <RotateCcw className="h-6 w-6" aria-hidden="true" />
                  : <Play className="h-6 w-6 translate-x-px fill-current" aria-hidden="true" />}
              </button>
            ) : null}
          </div>
        )}
        <TranscriptImageDeliveryOverlay
          visual={videoDeliveryVisual}
          time={time}
          foregroundTone="light"
          onRetry={onRetry}
          uploadProgress={resolvedUpload?.percent}
          uploadedBytes={resolvedUpload?.uploadedBytes}
          totalBytes={resolvedUpload?.totalBytes}
          onCancelUpload={uploadIsActive
            ? () => void cancelCloudAttachmentUpload(uploadPath)
            : undefined}
          mediaLabel="video"
        />
      </div>
    </div>
  );
}
