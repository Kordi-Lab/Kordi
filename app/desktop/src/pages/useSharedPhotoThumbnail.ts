import { useEffect, useRef, useState } from 'react';

import { attachmentPreviewUrl, safeAttachmentPreviewUrl } from '@/features/chat/attachmentMediaGallery';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadVisibleCloudAttachmentPreview, type CloudAttachmentPreviewLease } from '@/features/cloud/cloudAttachments';
import { loadSession } from '@/features/cloud/session';
import type { MessageAttachment } from '@/kordi-app/types';

function directThumbnailUrl(attachment: MessageAttachment, isVideo: boolean) {
  if (!isVideo) return attachmentPreviewUrl(attachment) ?? null;
  const poster = safeAttachmentPreviewUrl(attachment.previewUrl);
  return poster?.startsWith('data:image/') ? poster : null;
}

/**
 * A tile's picture: the local or inline preview, else the cloud preview once the tile scrolls
 * into view. The cloud lease is released when the tile unmounts.
 */
export function useSharedPhotoThumbnail(attachment: MessageAttachment, isVideo: boolean) {
  const tileRef = useRef<HTMLButtonElement | null>(null);
  const direct = directThumbnailUrl(attachment, isVideo);
  const [visible, setVisible] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const attachmentId = attachment.attachmentId?.trim() ?? '';

  useEffect(() => {
    if (direct || !attachmentId) return undefined;
    const tile = tileRef.current;
    if (!tile || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '160px' });
    observer.observe(tile);
    return () => observer.disconnect();
  }, [attachmentId, direct]);

  useEffect(() => {
    if (direct || !attachmentId || !visible) return undefined;
    const controller = new AbortController();
    let lease: CloudAttachmentPreviewLease | null = null;
    void (async () => {
      const session = await loadSession();
      if (!session?.token || controller.signal.aborted) return;
      lease = await loadVisibleCloudAttachmentPreview({
        token: session.token,
        client: defaultCloudAuthClient(),
        attachment: {
          attachmentId,
          previewAttachmentId: attachment.previewAttachmentId ?? null,
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType ?? null,
          sizeBytes: attachment.sizeBytes,
          widthPixels: attachment.widthPixels,
          heightPixels: attachment.heightPixels,
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        lease?.release();
        lease = null;
        return;
      }
      if (lease) setRemoteUrl(lease.previewUrl);
    })().catch(() => undefined);
    return () => {
      controller.abort();
      lease?.release();
    };
  }, [attachment, attachmentId, direct, visible]);

  return { tileRef, url: direct ?? remoteUrl };
}
