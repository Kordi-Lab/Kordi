import { useEffect, useRef, useState } from 'react';

import { isMp4VideoAttachment } from '@/features/chat/attachmentMediaGallery';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import {
  isNativeAttachmentUploadAvailable,
  uploadNativeCloudAttachment,
} from '@/features/cloud/cloudAttachmentUpload';
import { discardDesktopChatAttachment } from '@/lib/desktopAttachmentStream';

export function useAttachedVideoReviews({
  onSend,
  onRemoveAttachment,
}: {
  onSend: (draftOverride?: string, attachmentOverride?: AttachmentItem[]) => Promise<void> | void;
  onRemoveAttachment: (id: string) => void;
}) {
  const [queue, setQueue] = useState<AttachmentItem[]>([]);
  const queueRef = useRef(queue);
  const current = queue[0] ?? null;

  function replaceQueue(next: AttachmentItem[]) {
    queueRef.current = next;
    setQueue(next);
  }

  useEffect(() => () => {
    for (const attachment of queueRef.current) {
      if (attachment.playbackUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.playbackUrl);
      void discardDesktopChatAttachment(attachment.path).catch(() => undefined);
    }
  }, []);

  function stage(pendingAttachments: Promise<AttachmentItem[]>) {
    void pendingAttachments.then((saved) => {
      const videos = saved.filter(isMp4VideoAttachment);
      videos.forEach((attachment) => onRemoveAttachment(attachment.id));
      if (videos.length === 0) return;
      const paths = new Set(queueRef.current.map((attachment) => attachment.path));
      replaceQueue([
        ...queueRef.current,
        ...videos.filter((attachment) => !paths.has(attachment.path)),
      ]);
    });
    return pendingAttachments;
  }

  function cancel() {
    if (!current) return;
    replaceQueue(queueRef.current.slice(1));
    if (current.playbackUrl?.startsWith('blob:')) URL.revokeObjectURL(current.playbackUrl);
    void discardDesktopChatAttachment(current.path).catch(() => undefined);
  }

  function send(preparedAttachment: AttachmentItem) {
    if (!current) return;
    const queuedReviews = queueRef.current;
    replaceQueue(queueRef.current.filter((attachment) => attachment.path !== current.path));
    try {
      if (isNativeAttachmentUploadAvailable()) {
        void uploadNativeCloudAttachment({
          path: preparedAttachment.path,
          contentType: preparedAttachment.mimeType,
        }).catch(() => undefined);
      }
      const result = onSend('', [preparedAttachment]);
      if (preparedAttachment.playbackUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(preparedAttachment.playbackUrl);
      }
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      replaceQueue(queuedReviews);
    }
  }

  return { current, stage, cancel, send };
}
