import type { DesktopCollaborationState } from '@/kordi-app/types';
import {
  isNativeAttachmentUploadAvailable,
  uploadNativeCloudAttachment,
} from '@/features/cloud/cloudAttachmentUpload';

import { isMp4VideoAttachment } from '../attachmentMediaGallery';
import type { AttachmentItem } from '../composerController.types';
import { markOptimisticCollaborationMessageFailed } from './optimistic';

export function prefetchNativeVideoRetry(attachments: AttachmentItem[]) {
  if (!isNativeAttachmentUploadAvailable()) return;
  for (const attachment of attachments.filter(isMp4VideoAttachment)) {
    void uploadNativeCloudAttachment({
      path: attachment.path,
      contentType: attachment.mimeType,
    }).catch(() => undefined);
  }
}

export function terminalCollaborationRetryFailure({
  error,
  conversationId,
  messageId,
}: {
  error: unknown;
  conversationId: string;
  messageId: string;
}) {
  const detail = error instanceof Error ? error.message : 'Unable to retry message';
  return {
    detail,
    update: (current: DesktopCollaborationState | null) => (
      markOptimisticCollaborationMessageFailed(
        current,
        conversationId,
        messageId,
        detail,
      )
    ),
  };
}
