import {
  attachmentImageDisplaySize,
  attachmentMediaGalleryIndex,
  attachmentPreviewIdentity,
  attachmentPreviewUrl,
  isAnimatedGifAttachment,
  isMp4VideoAttachment,
  shouldPreviewAttachmentInline,
} from '@/features/chat/attachmentMediaGallery';
import { openAttachmentMediaWindow } from '@/features/chat/attachmentMediaWindow';
import {
  cancelCloudAttachmentUpload,
  cloudAttachmentUploadSnapshot,
  resolveCloudAttachmentUploadProgress,
  subscribeCloudAttachmentUpload,
} from '@/features/cloud/cloudAttachmentUpload';
import { type CloudAttachmentPreviewLease } from '@/features/cloud/cloudAttachments';
import {
  expressiveMediaLibrarySnapshot,
  subscribeExpressiveMediaLibrary,
} from '@/features/emoji/expressiveMediaLibrary';
import { useCallback, useId, useState, useSyncExternalStore } from 'react';
import type { Message,MessageAttachment } from '../types';
import { AttachmentImageCard } from './AttachmentImageCard';
import { TranscriptMediaBoundary } from './TranscriptMediaBoundary';
import { messageStickerAttachment } from './messageStickerPresentation';
import { isAttachmentSending } from './transcriptAttachmentPresentation';
import type { AttachmentImageForegroundTone } from './transcriptAttachmentTypes';
import { TranscriptFileAttachmentLink } from './transcriptFileAttachmentLink';
import { TranscriptImageDeliveryOverlay } from './transcriptImageDeliveryOverlay';
import { attachmentImageDeliveryVisual } from './transcriptImageDeliveryVisual';
import { TranscriptImageGroup } from './transcriptImageGroup';
import { AttachmentVideoCard } from './transcriptVideoAttachment';
export { AttachmentContextMenu } from './transcriptAttachmentContextMenu';
export { shouldCloseAttachmentContextMenuForTarget } from './transcriptAttachmentContextMenuState';
export type { AttachmentContextMenuState } from './transcriptAttachmentContextMenuState';
export { attachmentImageForegroundToneFromRgba } from './transcriptAttachmentForegroundTone';
export { AttachmentImageLightbox } from './transcriptAttachmentLightbox';
export { clearAttachmentPreviewRecoveryStateForTests,recoverAttachmentPreviewOnce } from './transcriptAttachmentPreviewRecovery';
export type { AttachmentImageDeliveryVisual,AttachmentImageForegroundTone } from './transcriptAttachmentTypes';
export { attachmentImageDeliveryVisual };
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
  const videoAttachments = attachments.filter(isMp4VideoAttachment);
  const downloadableAttachments = attachments.filter((attachment) => (
    !shouldPreviewAttachmentInline(attachment) && !isMp4VideoAttachment(attachment)
  ));
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
      || attachmentImageDisplaySize(visibleImageAttachments[0]) !== null
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
  const resolvedDeliveryUpload = resolveCloudAttachmentUploadProgress(
    deliveryUpload,
    deliveryImageAttachment?.sizeBytes,
  );
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
    const releasePreview = () => previewLease?.release();
    void openAttachmentMediaWindow({
      attachments: [...mediaAttachments],
      selectedIndex,
      initialPreviewUrl: previewUrl,
    }, {
      onClosed: () => {
        releasePreview();
        if (trigger.isConnected) trigger.focus({ preventScroll: true });
      },
    })
      .catch(releasePreview);
  }

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {previewImageAttachments.length > 0 ? (
          <TranscriptMediaBoundary><TranscriptImageGroup
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
                uploadProgress={resolvedDeliveryUpload?.percent}
                uploadedBytes={resolvedDeliveryUpload?.uploadedBytes}
                totalBytes={resolvedDeliveryUpload?.totalBytes}
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
                  totalCount={hasImageGroup && !isImageGroupExpanded
                    ? visibleImageAttachments.length
                    : 1}
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
          </TranscriptImageGroup></TranscriptMediaBoundary>
        ) : null}
        {videoAttachments.map((attachment, index) => (
          <TranscriptMediaBoundary key={`${attachment.name}-${index}-${attachmentPreviewIdentity(attachment)}`}><AttachmentVideoCard
            attachment={attachment}
            deliveryStatus={resolvedImageDeliveryStatus}
            time={msg.time}
            onRetry={onRetryImage}
          /></TranscriptMediaBoundary>
        ))}
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
