import {
  attachmentImageDisplaySize,
  attachmentPreviewIdentity,
  attachmentPreviewUrl,
  isAnimatedGifAttachment,
  isLargeAttachment,
} from '@/features/chat/attachmentMediaGallery';
import { displayAttachmentName } from '@/features/chat/composerAttachments';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import {
  cachedCloudAttachmentLocalPath,
  cloudAttachmentPreviewCacheId,
  loadCachedCloudAttachmentLocalPath,
} from '@/features/cloud/cloudAttachmentLocalPathCache';
import { acquireCloudAttachmentPreviewLease, cachedCloudAttachmentPreviewResource } from '@/features/cloud/cloudAttachmentPreviewCache';
import { loadVisibleCloudAttachmentPreview, type CloudAttachmentPreviewLease } from '@/features/cloud/cloudAttachments';
import { loadSession } from '@/features/cloud/session';
import { cn } from '@/lib/utils';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { MessageAttachment } from '../types';
import { attachmentImageReadyDimensions, attachmentImageWasReady, markAttachmentImageReady, stillAttachmentFrame } from './attachmentImageReadiness';
import { LivePhotoIcon } from './livePhotoIcon';
import { AttachmentActions } from './transcriptAttachmentActions';
import { sampleAttachmentImageForegroundTone } from './transcriptAttachmentForegroundTone';
import { AttachmentImageLoadingSurface, AttachmentImageUnavailableSurface } from './transcriptAttachmentImageSurfaces';
import { imageTileClass } from './transcriptAttachmentPresentation';
import {
  recoverableAttachmentId,
  recoverAttachmentPreviewOnce,
  recoveredAttachmentPreviewUrl,
} from './transcriptAttachmentPreviewRecovery';
import type { AttachmentImageForegroundTone } from './transcriptAttachmentTypes';
import { useTranscriptMediaActive } from './transcriptMediaActivity';
import { usePointerClickWithoutDrag } from './usePointerClickWithoutDrag';
export function AttachmentImageCard({
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
  const mediaActive = useTranscriptMediaActive();
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const attachmentId = recoverableAttachmentId(attachment);
  const isAnimatedGif = isAnimatedGifAttachment(attachment);
  const previewCacheId = attachmentId
    ? cloudAttachmentPreviewCacheId(
        attachmentId,
        isAnimatedGif ? null : attachment.previewAttachmentId,
      )
    : null;
  const resourceId = isAnimatedGif ? attachmentId : attachment.previewAttachmentId?.trim() || attachmentId;
  const readinessKey = resourceId ? `attachment:${resourceId}` : null;
  const [cachedLocalPath, setCachedLocalPath] = useState<string | null>(() =>
    (previewCacheId ? cachedCloudAttachmentLocalPath(previewCacheId) : null)
      ?? (attachmentId && !attachment.previewAttachmentId ? cachedCloudAttachmentLocalPath(attachmentId) : null));
  const [recoveredPreviewUrl, setRecoveredPreviewUrl] = useState(() => recoveredAttachmentPreviewUrl(attachmentId));
  const [remotePreviewUrl, setRemotePreviewUrl] = useState<string | null>(() => resourceId ? cachedCloudAttachmentPreviewResource(resourceId)?.previewUrl ?? null : null);
  const [failedPreviewUrls, setFailedPreviewUrls] = useState<string[]>([]);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const previewLeaseRef = useRef<CloudAttachmentPreviewLease | null>(null);
  const directPreviewUrl = attachmentPreviewUrl(cachedLocalPath ? { ...attachment, localPath: cachedLocalPath } : attachment);
  const usableRecoveredPreviewUrl = recoveredPreviewUrl && !failedPreviewUrls.includes(recoveredPreviewUrl) ? recoveredPreviewUrl : null;
  const usableRemotePreviewUrl = remotePreviewUrl && !failedPreviewUrls.includes(remotePreviewUrl) ? remotePreviewUrl : null;
  const usableDirectPreviewUrl = directPreviewUrl && !failedPreviewUrls.includes(directPreviewUrl) ? directPreviewUrl : null;
  const previewUrl = usableRecoveredPreviewUrl ?? usableRemotePreviewUrl ?? usableDirectPreviewUrl;
  const [loadedPreviewUrl, setLoadedPreviewUrl] = useState<string | null>(() => (
    previewUrl && (previewUrl.startsWith('data:image/') || attachmentImageWasReady(previewUrl) || attachmentImageWasReady(readinessKey)) ? previewUrl : null
  ));
  const imageLoaded = Boolean(previewUrl && (loadedPreviewUrl === previewUrl || attachmentImageWasReady(previewUrl) || attachmentImageWasReady(readinessKey)));
  useLayoutEffect(() => {
    if (!resourceId || !remotePreviewUrl || previewLeaseRef.current) return;
    const resource = cachedCloudAttachmentPreviewResource(resourceId);
    if (resource?.previewUrl === remotePreviewUrl) previewLeaseRef.current = acquireCloudAttachmentPreviewLease(resource);
  }, [remotePreviewUrl, resourceId]);
  const displayName = displayAttachmentName(attachment.name, attachment.kind);
  const isSticker = stickerMessage || attachment.subtype === 'sticker';
  const isExpressiveMedia = isSticker || isAnimatedGif;
  const showImage = Boolean(previewUrl);
  const singleImage = totalCount <= 1;
  const readyDimensions = attachmentImageReadyDimensions(readinessKey ?? previewUrl);
  const reservedSize = singleImage ? attachmentImageDisplaySize(attachment)
    ?? (readyDimensions ? attachmentImageDisplaySize({ ...attachment, ...readyDimensions }) : null) : null;
  const reservedStyle: CSSProperties | undefined = reservedSize ? {
    width: reservedSize.width,
    aspectRatio: `${reservedSize.width} / ${reservedSize.height}`,
    maxWidth: '100%',
  } : undefined;
  const intrinsicSingleImage = singleImage && (Boolean(reservedSize) || (showImage && imageLoaded) || isExpressiveMedia);
  const loadingSurfaceClassName = reservedSize
    ? 'min-h-0 aspect-auto rounded-[16px]'
    : isExpressiveMedia && singleImage
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
    if (!mediaActive) return;
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
        const recoveredPreview = await recoverAttachmentPreviewOnce(attachment, { signal: controller.signal });
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
          mimeType: attachment.mimeType ?? null, sizeBytes: attachment.sizeBytes, widthPixels: attachment.widthPixels, heightPixels: attachment.heightPixels,
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
  }, [mediaActive, attachment, attachmentId, isAnimatedGif, previewCacheId, previewUnavailable, usableDirectPreviewUrl, usableRecoveredPreviewUrl, usableRemotePreviewUrl]);

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
      ? reservedSize
        ? 'inline-flex h-auto max-w-full rounded-[16px]'
        : isExpressiveMedia
        ? 'inline-flex h-[180px] w-[180px] max-w-full rounded-[16px]'
        : 'inline-flex h-auto w-auto max-w-full rounded-[16px]'
      : 'block h-full w-full',
  );
  const imageContent = previewUrl ? (
    <>
      {!imageLoaded ? (
        <AttachmentImageLoadingSurface
          className={cn('absolute inset-0', loadingSurfaceClassName)}
          transparent={isSticker}
        />
      ) : null}
      <img
        src={isAnimatedGif && !mediaActive && stillUrl ? stillUrl : previewUrl}
        alt={attachment.altText?.trim() || attachment.name || (isSticker ? 'Sticker' : 'Attached image')}
        draggable={false}
        data-attachment-image-loaded={String(imageLoaded)}
        className={cn(
          'relative block transition-opacity duration-200 ease-out motion-reduce:transition-none',
          imageLoaded ? 'opacity-100' : 'opacity-0',
          reservedSize
            ? 'h-full w-full max-w-full rounded-[16px] object-contain'
            : intrinsicSingleImage
              ? isExpressiveMedia
                ? 'h-[180px] w-[180px] max-w-full rounded-[16px] object-contain'
                : 'h-auto w-auto max-h-[320px] max-w-full rounded-[16px] object-contain'
              : 'h-full w-full object-cover',
        )}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          markAttachmentImageReady(previewUrl, naturalWidth, naturalHeight);
          if (readinessKey) markAttachmentImageReady(readinessKey, naturalWidth, naturalHeight);
          setLoadedPreviewUrl(previewUrl);
          if (isAnimatedGif && !stillUrl) setStillUrl(stillAttachmentFrame(event.currentTarget));
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
      data-attachment-image-dimensions={reservedSize ? 'true' : undefined}
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
            style={reservedStyle}
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
            style={reservedStyle}
            aria-label={`Preview ${attachment.name || 'attached image'}`}
          >
            {imageContent}
          </button>
        )
      ) : previewUnavailable ? (
        <AttachmentImageUnavailableSurface attachment={attachment} className={loadingSurfaceClassName} style={reservedStyle} />
      ) : (
        <AttachmentImageLoadingSurface
          className={loadingSurfaceClassName}
          style={reservedStyle}
          transparent={isSticker}
        />
      )}
      {attachment.livePhoto || attachment.livePhotoFiles ? <span role="img" aria-label="Live Photo" className="pointer-events-none absolute left-2 top-2 grid size-7 place-items-center rounded-full bg-black/65 text-[#fff] ring-1 ring-inset ring-white/20"><LivePhotoIcon className="size-5" strokeWidth={1.8} /></span> : null}
      {showOriginalAction ? (
        <div className="absolute bottom-2 right-2 z-10">
          <AttachmentActions attachment={attachment} variant="original" />
        </div>
      ) : null}
    </div>
  );
}
