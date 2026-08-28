import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Image } from 'lucide-react';
import {
  attachmentMediaGalleryIndex,
  attachmentPreviewIdentity,
  attachmentPreviewUrl,
  isAnimatedGifAttachment,
  isLargeAttachment,
  shouldPreviewAttachmentInline,
} from '@/features/chat/attachmentMediaGallery';
import { openAttachmentMediaWindow } from '@/features/chat/attachmentMediaWindow';
import { displayAttachmentName } from '@/features/chat/composerAttachments';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import {
  cancelCloudAttachmentUpload,
  cloudAttachmentUploadSnapshot,
  subscribeCloudAttachmentUpload,
} from '@/features/cloud/cloudAttachmentUpload';
import { loadVisibleCloudAttachmentPreview, type CloudAttachmentPreviewLease } from '@/features/cloud/cloudAttachments';
import {
  cloudAttachmentPreviewCacheId,
  loadCachedCloudAttachmentLocalPath,
} from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import {
  expressiveMediaLibrarySnapshot,
  subscribeExpressiveMediaLibrary,
} from '@/features/emoji/expressiveMediaLibrary';
import { cn } from '@/lib/utils';
import { AttachmentActions } from './transcriptAttachmentActions';
import { TranscriptFileAttachmentLink } from './transcriptFileAttachmentLink';
import { TranscriptImageDeliveryOverlay } from './transcriptImageDeliveryOverlay';
import { attachmentImageDeliveryVisual } from './transcriptImageDeliveryVisual';
import { TranscriptImageGroup } from './transcriptImageGroup';
import {
  recoverableAttachmentId,
  recoveredAttachmentPreviewUrl,
  recoverAttachmentPreviewOnce,
} from './transcriptAttachmentPreviewRecovery';
import type { AttachmentImageForegroundTone } from './transcriptAttachmentTypes';
import { usePointerClickWithoutDrag } from './usePointerClickWithoutDrag';
import { messageStickerAttachment } from './messageStickerPresentation';
import { sampleAttachmentImageForegroundTone } from './transcriptAttachmentForegroundTone';
import type { Message, MessageAttachment } from '../types';

export { AttachmentImageLightbox } from './transcriptAttachmentLightbox';
export {
  clearAttachmentPreviewRecoveryStateForTests,
  recoverAttachmentPreviewOnce,
} from './transcriptAttachmentPreviewRecovery';
export { attachmentImageDeliveryVisual };
export { AttachmentContextMenu } from './transcriptAttachmentContextMenu';
export { shouldCloseAttachmentContextMenuForTarget } from './transcriptAttachmentContextMenuState';
export type { AttachmentContextMenuState } from './transcriptAttachmentContextMenuState';
export { attachmentImageForegroundToneFromRgba } from './transcriptAttachmentForegroundTone';
export type { AttachmentImageDeliveryVisual, AttachmentImageForegroundTone } from './transcriptAttachmentTypes';

function isAttachmentSending(msg: Message) {
  return (msg.statusChips ?? []).some((chip) => {
    const normalized = chip.trim().toLowerCase();
    return normalized === 'sending' || normalized === 'pending';
  });
}


function AttachmentImageLoadingSurface({ className }: { className?: string }) {
  return (
    <div
      data-attachment-image-loading="true"
      aria-label="Loading attached image"
      className={cn('relative flex h-full min-h-28 aspect-[4/3] overflow-hidden bg-black/[0.035]', className)}
    >
      <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,0.10)_42%,transparent_74%)] opacity-70 motion-safe:animate-[app-attachment-shimmer_1.45s_ease-in-out_infinite]" aria-hidden="true" />
      <span className="sr-only">Loading attached image</span>
    </div>
  );
}

function AttachmentImageUnavailableSurface({ attachment, className }: {
  attachment: MessageAttachment;
  className?: string;
}) {
  return (
    <div
      data-attachment-image-unavailable="true"
      className={cn('app-attachment-image-fallback flex h-full min-h-28 aspect-[4/3] items-center gap-3 bg-black/[0.045] px-3 py-2.5', className)}
      role="status"
    >
      <div className="app-attachment-image-fallback-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-black/[0.06]">
        <Image className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="app-attachment-image-fallback-title truncate text-[12px] font-medium">{displayAttachmentName(attachment.name, attachment.kind)}</div>
        <div className="app-attachment-image-fallback-name mt-0.5 text-[10px] font-medium">Preview unavailable</div>
      </div>
      <AttachmentActions attachment={attachment} />
    </div>
  );
}

function imageTileClass(index: number, totalCount: number, intrinsicSingleImage = false) {
  if (totalCount <= 1) return intrinsicSingleImage ? 'col-span-6' : 'col-span-6 row-span-3';
  if (totalCount === 2) return 'col-span-3 row-span-3';
  if (totalCount === 3) return index === 0 ? 'col-span-6 row-span-2' : 'col-span-3 row-span-2';
  if (totalCount === 4) return 'col-span-3 row-span-2';
  if (totalCount === 5) return index < 2 ? 'col-span-3 row-span-2' : 'col-span-2 row-span-2';
  if (totalCount === 6) return 'col-span-2 row-span-2';
  return index < 2 ? 'col-span-3 row-span-2' : 'col-span-2 row-span-2';
}

function AttachmentImageCard({
  attachment,
  index,
  totalCount,
  decorative = false,
  onOpenPreview,
  onImageForegroundTone,
  stickerMessage = false,
}: {
  attachment: MessageAttachment;
  index: number;
  totalCount: number;
  decorative?: boolean;
  onOpenPreview: (
    attachment: MessageAttachment,
    previewUrl: string,
    previewLease: CloudAttachmentPreviewLease | null,
    index: number,
    trigger: HTMLButtonElement,
  ) => void;
  stickerMessage?: boolean;
  onImageForegroundTone?: (
    attachmentIdentity: string,
    tone: AttachmentImageForegroundTone | null,
  ) => void;
}) {
  const attachmentId = recoverableAttachmentId(attachment);
  const isAnimatedGif = isAnimatedGifAttachment(attachment);
  const previewCacheId = attachmentId
    ? cloudAttachmentPreviewCacheId(
        attachmentId,
        isAnimatedGif ? null : attachment.previewAttachmentId,
      )
    : null;
  const [cachedLocalPath, setCachedLocalPath] = useState<string | null>(null);
  const [recoveredPreviewUrl, setRecoveredPreviewUrl] = useState(() => recoveredAttachmentPreviewUrl(attachmentId));
  const [remotePreviewUrl, setRemotePreviewUrl] = useState<string | null>(null);
  const [failedPreviewUrls, setFailedPreviewUrls] = useState<string[]>([]);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const previewLeaseRef = useRef<CloudAttachmentPreviewLease | null>(null);
  const directPreviewUrl = attachmentPreviewUrl(cachedLocalPath ? { ...attachment, localPath: cachedLocalPath } : attachment);
  const usableRecoveredPreviewUrl = recoveredPreviewUrl && !failedPreviewUrls.includes(recoveredPreviewUrl) ? recoveredPreviewUrl : null;
  const usableRemotePreviewUrl = remotePreviewUrl && !failedPreviewUrls.includes(remotePreviewUrl) ? remotePreviewUrl : null;
  const usableDirectPreviewUrl = directPreviewUrl && !failedPreviewUrls.includes(directPreviewUrl) ? directPreviewUrl : null;
  const previewUrl = usableRecoveredPreviewUrl ?? usableRemotePreviewUrl ?? usableDirectPreviewUrl;
  const [loadedPreviewUrl, setLoadedPreviewUrl] = useState<string | null>(() => (
    previewUrl?.startsWith('data:image/') ? previewUrl : null
  ));
  const imageLoaded = Boolean(previewUrl && loadedPreviewUrl === previewUrl);
  const displayName = displayAttachmentName(attachment.name, attachment.kind);
  const isSticker = stickerMessage || attachment.subtype === 'sticker';
  const isExpressiveMedia = isSticker || isAnimatedGif;
  const showImage = Boolean(previewUrl);
  const singleImage = totalCount <= 1;
  const intrinsicSingleImage = singleImage && ((showImage && imageLoaded) || isExpressiveMedia);
  const expressiveSurfaceClassName = isExpressiveMedia && singleImage
    ? 'h-[180px] w-[180px] min-h-0 aspect-auto rounded-[16px]'
    : singleImage ? 'rounded-[16px]' : '';
  const showOriginalAction = !decorative && showImage && isLargeAttachment(attachment);
  const activationProps = usePointerClickWithoutDrag((event) => onOpenPreview(
    attachment,
    previewUrl ?? '',
    previewLeaseRef.current?.retain() ?? null,
    index,
    event.currentTarget,
  ));

  useEffect(() => {
    if (
      usableRecoveredPreviewUrl
      || usableRemotePreviewUrl
      || (!isAnimatedGif && usableDirectPreviewUrl)
      || previewUnavailable
      || attachment.kind !== 'image'
      || !attachmentId
    ) return;
    const controller = new AbortController();
    void (async () => {
      if (isAnimatedGif || !attachment.previewAttachmentId) {
        const original = await loadCachedCloudAttachmentLocalPath(attachmentId, attachment.name);
        if (controller.signal.aborted) return;
        if (original) {
          setCachedLocalPath(original);
          setPreviewUnavailable(false);
          return;
        }
      }
      if (!isAnimatedGif && previewCacheId) {
        const cached = await loadCachedCloudAttachmentLocalPath(previewCacheId, attachment.name);
        if (controller.signal.aborted) return;
        if (cached) {
          setCachedLocalPath(cached);
          setPreviewUnavailable(false);
          return;
        }
      }
      const session = await loadSession();
      if (!session?.token || controller.signal.aborted) {
        if (!controller.signal.aborted) setPreviewUnavailable(true);
        return;
      }
      if (!isAnimatedGif && !attachment.previewAttachmentId) {
        const recoveredPreview = await recoverAttachmentPreviewOnce(attachment);
        if (controller.signal.aborted) return;
        if (recoveredPreview) {
          setRecoveredPreviewUrl(recoveredPreview);
          setPreviewUnavailable(false);
          return;
        }
      }
      const nextPreviewLease = await loadVisibleCloudAttachmentPreview({
        token: session.token,
        client: defaultCloudAuthClient(),
        attachment: {
          attachmentId: attachment.attachmentId ?? '',
          previewAttachmentId: attachment.previewAttachmentId ?? null,
          name: attachment.name,
          kind: 'image',
          mimeType: attachment.mimeType ?? null,
        },
        signal: controller.signal,
      });
      if (!nextPreviewLease) {
        setPreviewUnavailable(true);
        return;
      }
      if (controller.signal.aborted) {
        nextPreviewLease.release();
        return;
      }
      previewLeaseRef.current?.release();
      previewLeaseRef.current = nextPreviewLease;
      setRemotePreviewUrl(nextPreviewLease.previewUrl);
      setPreviewUnavailable(false);
    })()
      .catch((error) => {
        if (!controller.signal.aborted && (!(error instanceof Error) || error.name !== 'AbortError')) {
          setPreviewUnavailable(true);
        }
      });
    return () => controller.abort();
  }, [attachment, attachmentId, isAnimatedGif, previewCacheId, previewUnavailable, usableDirectPreviewUrl, usableRecoveredPreviewUrl, usableRemotePreviewUrl]);

  useEffect(() => {
    return () => {
      previewLeaseRef.current?.release();
      previewLeaseRef.current = null;
    };
  }, []);

  const previewSurfaceClassName = cn(
    'group relative overflow-hidden text-left outline-none',
    !isSticker && 'transition focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-black/20',
    intrinsicSingleImage
      ? isExpressiveMedia
        ? 'inline-flex h-[180px] w-[180px] max-w-full rounded-[16px]'
        : 'inline-flex h-auto w-auto max-w-full rounded-[16px]'
      : 'block h-full w-full',
  );
  const imageContent = previewUrl ? (
    <>
      {!imageLoaded ? (
        <AttachmentImageLoadingSurface className={cn('absolute inset-0', expressiveSurfaceClassName)} />
      ) : null}
      <img
        src={previewUrl}
        alt={attachment.altText?.trim() || attachment.name || (isSticker ? 'Sticker' : 'Attached image')}
        draggable={false}
        data-attachment-image-loaded={String(imageLoaded)}
        className={cn(
          'relative block transition-opacity duration-200 ease-out motion-reduce:transition-none',
          imageLoaded ? 'opacity-100' : 'opacity-0',
          intrinsicSingleImage
            ? isExpressiveMedia
              ? 'h-[180px] w-[180px] max-w-full rounded-[16px] object-contain'
              : 'h-auto w-auto max-h-[320px] max-w-full rounded-[16px] object-contain'
            : 'h-full w-full object-cover',
        )}
        onLoad={(event) => {
          setLoadedPreviewUrl(previewUrl);
          onImageForegroundTone?.(
            attachmentPreviewIdentity(attachment),
            sampleAttachmentImageForegroundTone(event.currentTarget),
          );
        }}
        onError={() => {
          setFailedPreviewUrls((current) => current.includes(previewUrl) ? current : [...current, previewUrl]);
          setLoadedPreviewUrl(null);
          previewLeaseRef.current?.release();
          previewLeaseRef.current = null;
          setRemotePreviewUrl(null);
          if (!attachmentId || (previewUrl !== directPreviewUrl && previewUrl !== recoveredPreviewUrl)) {
            setPreviewUnavailable(true);
          }
        }}
      />
    </>
  ) : null;

  return (
    <div
      key={`${attachment.name}-${index}`}
      data-attachment-image-card="true"
      data-attachment-image-index={index}
      aria-hidden={decorative || undefined}
      className={cn(
        'app-attachment-image-card app-attachment-image-tile relative overflow-hidden bg-transparent',
        decorative && 'pointer-events-none',
        intrinsicSingleImage ? 'w-fit max-w-full justify-self-start rounded-[16px]' : singleImage ? 'rounded-[16px]' : '',
        imageTileClass(index, totalCount, intrinsicSingleImage),
      )}
    >
      {showImage && previewUrl ? (
        isSticker ? (
          <div
            data-attachment-sticker="true"
            data-attachment-image-index={index}
            className={previewSurfaceClassName}
            role="img"
            aria-label={`Sticker ${attachment.name}`}
            title={`${displayName} · Right-click for message actions`}
          >
            {imageContent}
          </div>
        ) : (
          <button
            type="button"
            data-attachment-image-preview-trigger="true"
            data-attachment-image-index={index}
            tabIndex={decorative ? -1 : undefined}
            title={displayName}
            {...activationProps}
            onDragStart={(event) => event.preventDefault()}
            className={previewSurfaceClassName}
            aria-label={`Preview ${attachment.name || 'attached image'}`}
          >
            {imageContent}
          </button>
        )
      ) : previewUnavailable ? (
        <AttachmentImageUnavailableSurface attachment={attachment} className={expressiveSurfaceClassName} />
      ) : (
        <AttachmentImageLoadingSurface className={expressiveSurfaceClassName} />
      )}
      {showOriginalAction ? (
        <div className="absolute bottom-2 right-2 z-10">
          <AttachmentActions attachment={attachment} variant="original" />
        </div>
      ) : null}
    </div>
  );
}

export function AttachmentPreview({
  msg,
  imageGallery,
  imageDeliveryStatus,
  onRetryImage,
}: {
  msg: Message;
  imageGallery?: readonly MessageAttachment[];
  imageDeliveryStatus?: string | null;
  onRetryImage?: () => void;
}) {
  useSyncExternalStore(
    subscribeExpressiveMediaLibrary,
    expressiveMediaLibrarySnapshot,
    expressiveMediaLibrarySnapshot,
  );
  const attachments = msg.attachments ?? [];
  const stickerAttachment = messageStickerAttachment(msg);
  const previewImageAttachments = attachments.filter((attachment) => shouldPreviewAttachmentInline(attachment));
  const downloadableAttachments = attachments.filter((attachment) => !shouldPreviewAttachmentInline(attachment));
  const mediaAttachments = imageGallery?.length ? imageGallery : previewImageAttachments;
  const imageGroupId = useId();
  const [isImageGroupExpanded, setIsImageGroupExpanded] = useState(false);
  const [sampledForegroundTone, setSampledForegroundTone] = useState<{
    attachmentIdentity: string;
    tone: AttachmentImageForegroundTone | null;
  } | null>(null);
  const isSending = isAttachmentSending(msg);
  const resolvedImageDeliveryStatus = imageDeliveryStatus === undefined
    ? msg.statusChips?.[0] ?? null
    : imageDeliveryStatus;
  const hasImageGroup = previewImageAttachments.length > 1;
  const visibleImageAttachments = hasImageGroup && !isImageGroupExpanded
    ? previewImageAttachments.slice(0, 3)
    : previewImageAttachments;
  const isOwnImageGroup = msg.isOwnMessage ?? msg.role === 'user';
  const loadingOnlyImageCollage = visibleImageAttachments.length > 0
    && visibleImageAttachments.every((attachment) => !attachmentPreviewUrl(attachment))
    && !(visibleImageAttachments.length === 1 && (
      visibleImageAttachments[0] === stickerAttachment
      || isAnimatedGifAttachment(visibleImageAttachments[0])
    ));
  const deliveryImageAttachment = hasImageGroup && !isImageGroupExpanded
    ? visibleImageAttachments[0]
    : visibleImageAttachments[visibleImageAttachments.length - 1];
  const deliveryImagePath = deliveryImageAttachment?.localPath?.trim() ?? '';
  const deliveryUpload = useSyncExternalStore(
    (listener) => subscribeCloudAttachmentUpload(deliveryImagePath, listener),
    () => cloudAttachmentUploadSnapshot(deliveryImagePath),
    () => null,
  );
  const deliveryUploadProgress = deliveryUpload && deliveryUpload.totalBytes > 0
    ? (deliveryUpload.uploadedBytes / deliveryUpload.totalBytes) * 100
    : null;
  const deliveryUploadIsActive = deliveryUpload
    && ['preparing', 'uploading'].includes(deliveryUpload.phase);
  const deliveryUploadFailure = deliveryUpload?.phase === 'failed'
    ? deliveryUpload.error ?? 'Sending failed'
    : deliveryUpload?.phase === 'cancelled' ? 'Sending cancelled' : null;
  const deliveryImageIdentity = deliveryImageAttachment
    ? attachmentPreviewIdentity(deliveryImageAttachment)
    : null;
  const deliveryForegroundTone = sampledForegroundTone?.attachmentIdentity === deliveryImageIdentity
    ? sampledForegroundTone.tone
    : null;

  const updateImageForegroundTone = useCallback((
    attachmentIdentity: string,
    tone: AttachmentImageForegroundTone | null,
  ) => {
    setSampledForegroundTone((current) => (
      current?.attachmentIdentity === attachmentIdentity && current.tone === tone
        ? current
        : { attachmentIdentity, tone }
    ));
  }, []);

  function openLightbox(
    attachment: MessageAttachment,
    previewUrl: string,
    previewLease: CloudAttachmentPreviewLease | null,
    _index: number,
    trigger: HTMLButtonElement,
  ) {
    const galleryIndex = attachmentMediaGalleryIndex(mediaAttachments, attachment);
    const selectedIndex = galleryIndex >= 0 ? galleryIndex : 0;
    void openAttachmentMediaWindow({
      attachments: [...mediaAttachments],
      selectedIndex,
      initialPreviewUrl: previewUrl,
    }, {
      onClosed: () => {
        if (trigger.isConnected) trigger.focus({ preventScroll: true });
      },
    })
      .catch(() => undefined)
      .finally(() => previewLease?.release());
  }

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {previewImageAttachments.length > 0 ? (
          <TranscriptImageGroup
            groupId={imageGroupId}
            imageCount={previewImageAttachments.length}
            isExpanded={isImageGroupExpanded}
            isOwnMessage={isOwnImageGroup}
            loadingOnly={loadingOnlyImageCollage}
            onToggle={() => setIsImageGroupExpanded((current) => !current)}
            deliveryOverlay={(
              <TranscriptImageDeliveryOverlay
                visual={attachmentImageDeliveryVisual(resolvedImageDeliveryStatus, deliveryUploadFailure)}
                time={msg.time}
                foregroundTone={deliveryForegroundTone}
                onRetry={onRetryImage}
                uploadProgress={deliveryUploadProgress}
                onCancelUpload={deliveryUploadIsActive
                  ? () => void cancelCloudAttachmentUpload(deliveryImagePath)
                  : undefined}
              />
            )}
          >
            {visibleImageAttachments.map((attachment) => {
              const index = previewImageAttachments.indexOf(attachment);
              return (
                <AttachmentImageCard
                  key={`${attachment.name}-${attachment.sizeBytes ?? ''}-${index}`}
                  attachment={attachment}
                  index={index}
                  totalCount={1}
                  decorative={hasImageGroup && !isImageGroupExpanded && index > 0}
                  onOpenPreview={hasImageGroup && !isImageGroupExpanded
                    ? (_attachment, _previewUrl, previewLease) => {
                      previewLease?.release();
                      setIsImageGroupExpanded(true);
                    }
                    : openLightbox}
                  stickerMessage={attachment === stickerAttachment}
                  onImageForegroundTone={attachmentPreviewIdentity(attachment) === deliveryImageIdentity
                    ? updateImageForegroundTone
                    : undefined}
                />
              );
            })}
          </TranscriptImageGroup>
        ) : null}
        {downloadableAttachments.length > 0 ? (
          <div className="flex flex-col items-start gap-1.5">
            {downloadableAttachments.map((attachment, index) => (
              <TranscriptFileAttachmentLink
                key={`${attachment.name}-${index}`}
                attachment={attachment}
                isSending={isSending}
              />
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
