import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { LoaderCircle, Play, RotateCcw } from 'lucide-react';

import { attachmentVideoUrl } from '@/features/chat/attachmentMediaGallery';
import { displayAttachmentName } from '@/features/chat/composerAttachments';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { cloudAttachmentPlaybackUrl } from '@/features/cloud/cloudAttachmentPlayback';
import {
  cancelCloudAttachmentUpload,
  cloudAttachmentUploadSnapshot,
  subscribeCloudAttachmentUpload,
} from '@/features/cloud/cloudAttachmentUpload';
import { loadCachedCloudAttachmentLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import type { MessageAttachment } from '../types';
import { AttachmentActions } from './transcriptAttachmentActions';
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
  const posterUrl = directPosterUrl ?? remotePosterUrl;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const localSource = attachmentVideoUrl(localPath ? { ...attachment, localPath } : attachment);
  const rawSource = localSource ?? playbackUrl ?? undefined;
  const source = rawSource === failedSource ? undefined : rawSource;
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
    if (directPosterUrl || !attachmentId) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void loadSession().then(async (session) => {
      if (!session?.token || controller.signal.aborted) return;
      const blob = await defaultCloudAuthClient()
        .downloadAttachmentPreviewContent(session.token, attachmentId, controller.signal)
        .catch(() => null);
      if (!blob || controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setRemotePosterUrl(objectUrl);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId, directPosterUrl]);

  const loadVideo = useCallback(async () => {
    if (phase === 'loading') return;
    if (source) {
      setPlaybackRequested(true);
      return;
    }
    if (!attachmentId) return;
    setPhase('loading');
    setFailedSource(null);
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
  }, [attachmentId, phase, source]);

  return (
    <div
      data-attachment-video-card="true"
      className="w-full max-w-[520px] overflow-hidden rounded-[16px] bg-black/[0.92] text-white"
    >
      <div className="relative aspect-video max-h-[360px] w-full overflow-hidden bg-black">
        {source && playbackRequested && !transferPending ? (
          <video
            src={source}
            controls
            autoPlay
            playsInline
            preload="metadata"
            poster={posterUrl ?? undefined}
            className="block h-full w-full object-contain"
            aria-label={`Play ${displayAttachmentName(attachment.name, attachment.kind)}`}
            onError={() => {
              setPlaybackRequested(false);
              setFailedSource(source);
              setPhase('error');
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
              />
            ) : null}
            <div className="absolute inset-0 bg-black/30" aria-hidden="true" />
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
      <div className="flex h-10 min-w-0 items-center gap-2 border-t border-white/10 px-3">
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-white/75">
          {displayAttachmentName(attachment.name, attachment.kind)}
        </span>
        <AttachmentActions attachment={attachment} />
      </div>
    </div>
  );
}
