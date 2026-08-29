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
import {
  cancelCloudAttachmentUpload,
  cloudAttachmentUploadSnapshot,
  subscribeCloudAttachmentUpload,
} from '@/features/cloud/cloudAttachmentUpload';
import { loadCachedCloudAttachmentLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import {
  imagePixelDimensionsFromBlob,
  imagePixelDimensionsFromUrl,
  normalizedImagePixelDimensions,
} from '@/lib/imageDimensions';
import type { MessageAttachment } from '../types';
import { TranscriptImageDeliveryOverlay } from './transcriptImageDeliveryOverlay';
import { attachmentImageDeliveryVisual } from './transcriptImageDeliveryVisual';

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
  const [localPath, setLocalPath] = useState<string | null>(attachment.localPath?.trim() || null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>(() => (
    attachmentVideoUrl(attachment) ? 'ready' : 'idle'
  ));
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const directPosterUrl = attachment.previewUrl?.startsWith('data:image/')
    ? attachment.previewUrl
    : null;
  const [remotePosterUrl, setRemotePosterUrl] = useState<string | null>(null);
  const [localPosterUrl, setLocalPosterUrl] = useState<string | null>(null);
  const [localVideoDimensions, setLocalVideoDimensions] = useState<{
    widthPixels: number;
    heightPixels: number;
  } | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimer = useRef<number | null>(null);
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
  const attachmentId = attachment.attachmentId?.trim() ?? '';
  const uploadPath = attachment.localPath?.trim() ?? '';
  const upload = useSyncExternalStore(
    (listener) => subscribeCloudAttachmentUpload(uploadPath, listener),
    () => cloudAttachmentUploadSnapshot(uploadPath),
    () => null,
  );
  const uploadProgress = upload && upload.totalBytes > 0
    ? (upload.uploadedBytes / upload.totalBytes) * 100
    : null;
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
      if (!cancelled && dimensions) setLocalVideoDimensions(dimensions);
    });
    return () => { cancelled = true; };
  }, [directPosterUrl, videoDimensions]);

  useEffect(() => {
    if (directPosterUrl || !attachmentId) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void loadSession().then(async (session) => {
      if (!session?.token || controller.signal.aborted) return;
      const blob = await defaultCloudAuthClient()
        .downloadAttachmentPreviewContent(session.token, attachmentId, controller.signal)
        .catch(() => null);
      if (!blob || controller.signal.aborted) return;
      const dimensions = await imagePixelDimensionsFromBlob(blob);
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      if (dimensions) setLocalVideoDimensions(dimensions);
      setRemotePosterUrl(objectUrl);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId, directPosterUrl]);

  useEffect(() => {
    if (directPosterUrl || remotePosterUrl || localPosterUrl || !posterGenerationSource) return;
    let cancelled = false;
    void videoPreviewFromSource(posterGenerationSource).then((preview) => {
      if (!cancelled && preview) {
        setLocalVideoDimensions({
          widthPixels: preview.widthPixels,
          heightPixels: preview.heightPixels,
        });
        setLocalPosterUrl(preview.previewUrl);
      }
    });
    return () => { cancelled = true; };
  }, [directPosterUrl, localPosterUrl, posterGenerationSource, remotePosterUrl]);

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
      setPlaybackRequested(true);
    } catch {
      setPhase('error');
    }
  }, [attachmentId]);

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
        className="grid h-14 w-14 place-items-center rounded-full bg-[color:var(--app-control-bg)]"
      >
        {phase === 'loading' ? (
          <LoaderCircle className="h-5 w-5 animate-spin text-[color:var(--utility-muted-text)] motion-reduce:animate-none" aria-label="Preparing video preview" />
        ) : (
          <button
            type="button"
            onClick={() => { void loadVideo(); }}
            className="grid h-11 w-11 place-items-center rounded-full bg-black/60 text-white outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-sidebar-accent)]"
            aria-label={phase === 'error' ? `Retry loading ${attachment.name}` : `Play ${attachment.name}`}
          >
            {phase === 'error'
              ? <RotateCcw className="h-5 w-5" aria-hidden="true" />
              : <Play className="h-5 w-5 translate-x-px fill-current" aria-hidden="true" />}
          </button>
        )}
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
                setLocalVideoDimensions({ widthPixels: videoWidth, heightPixels: videoHeight });
              }
            }}
            onClick={showControlsBriefly}
            onPlay={showControlsBriefly}
            onPause={keepControlsVisible}
            onEnded={keepControlsVisible}
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
                    setLocalVideoDimensions({ widthPixels: naturalWidth, heightPixels: naturalHeight });
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
          uploadProgress={uploadProgress}
          onCancelUpload={uploadIsActive
            ? () => void cancelCloudAttachmentUpload(uploadPath)
            : undefined}
          mediaLabel="video"
        />
      </div>
    </div>
  );
}
