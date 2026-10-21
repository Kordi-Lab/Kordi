import { KORDI_SYSTEM_AVATAR_URL, KORDI_SYSTEM_NAME, KORDI_SYSTEM_NOTICE_KIND } from '@/features/pip/pipIdentity';
import type { CanonicalSessionMessage } from '@/kordi-app/types';

// Takes the kind itself: the read model counts property reads per row.
export function isSystemNoticeKind(messageKind: CanonicalSessionMessage['messageKind'] | null | undefined): boolean {
  return messageKind?.trim() === KORDI_SYSTEM_NOTICE_KIND;
}

/** Sender identity for a server notice; null keeps the poster's own identity. The seed keeps
 * notices from grouping with the posting account's own messages. */
export function systemNoticeSender(messageKind: CanonicalSessionMessage['messageKind'] | null | undefined) {
  return isSystemNoticeKind(messageKind)
    ? { sender: KORDI_SYSTEM_NAME, senderProfileImageUrl: KORDI_SYSTEM_AVATAR_URL, showSenderMeta: true, senderAvatarSeed: 'kordi-system', senderOwnerName: undefined }
    : null;
}
